"""The studio reads what the project writes: its ``[tracing]`` sinks.

Gates: the store choice for a project with no ``[tracing]`` (unchanged),
``[tracing]`` local, local + Langfuse, ClickHouse + Langfuse; an explicit
``[studio] runs`` still wins; the store reopens when ``.env`` changes; a
ClickHouse nobody answers at is a clear state, not a crash; a ``$media``
blob is served from the store's media directory, and nothing else is;
an operonx without ``project_stores`` keeps today's behaviour.
"""

from __future__ import annotations

import hashlib
import os
import socket
import struct
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient
from operonx.telemetry.media import LocalMediaStore, detect_media

from operonx_studio import runs as runs_mod
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents
from operonx_studio.runs import StoreUnreachable, project_runs

pytestmark = pytest.mark.unit

needs_api = pytest.mark.skipif(runs_mod._project_stores is None,
                               reason="this operonx has no project_stores")

BASE = '[project]\nname = "ts"\n\n[[graph]]\nname = "flow"\nentry = "main:flow"\n\n'
MAIN = ("from operonx.core import graph, op, START, END\n\n@op\ndef a(x: int = 1):\n"
        "    return {'y': x}\n\n@graph\ndef flow():\n    s = a()\n    START >> s >> END\n")
LANGFUSE = ("trace_langfuse:\n  edupia:\n    client_resource: langfuse:edupia\n"
            "langfuse:\n  edupia:\n    host: https://lf.example\n    public_key: ${LF_PK}\n"
            "    secret_key: ${LF_SK}\n")


def _closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _project(tmp_path: Path, toml: str = "", resources: str = "", env: str = "") -> Path:
    root = tmp_path / "proj"
    root.mkdir(exist_ok=True)
    (root / "operonx.toml").write_text(BASE + toml, encoding="utf-8")
    (root / "main.py").write_text(MAIN, encoding="utf-8")
    if resources:
        (root / "resources.yaml").write_text(resources, encoding="utf-8")
    if env:
        (root / ".env").write_text(env, encoding="utf-8")
    return root


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json")))


def _open(client, root) -> str:
    return client.post("/api/open", json={"path": str(root)}).json()["id"]


# ── the choice ──────────────────────────────────────────────────────────


def test_no_tracing_is_todays_choice(tmp_path):
    root = _project(tmp_path)
    pr = project_runs(root, sweep=False)
    assert pr.spec == {"backend": "files", "root": str(root / ".operonx" / "runs")}
    assert pr.source == str(root / ".operonx" / "runs")
    assert pr.remote is None
    assert pr.info["why"] == "the default: no [tracing] or [studio] runs in operonx.toml"


@needs_api
def test_tracing_local_reads_the_runs_dir_and_says_why(tmp_path):
    root = _project(tmp_path, '[tracing]\nsinks = ["local"]\n')
    pr = project_runs(root, sweep=False)
    assert pr.spec == {"backend": "files", "root": str(root / ".operonx" / "runs")}
    assert pr.remote is None
    assert pr.info["label"] == f"files at {root / '.operonx' / 'runs'}"
    assert pr.info["why"] == "from [tracing] → local in operonx.toml"
    assert pr.source == f"files at {root / '.operonx' / 'runs'} — from [tracing] → local in operonx.toml"


@needs_api
def test_tracing_local_and_langfuse_reads_local_with_langfuse_as_remote(tmp_path):
    root = _project(tmp_path, '[tracing]\nsinks = ["local", "trace_langfuse:edupia"]\n',
                    LANGFUSE, env="LF_PK=pk-1\nLF_SK=sk-1\n")
    pr = project_runs(root, sweep=False)
    assert pr.spec["backend"] == "files"
    assert pr.remote is not None and pr.remote.config["host"] == "https://lf.example"
    assert pr.info["remote"] == "Langfuse at https://lf.example — from [tracing] → trace_langfuse:edupia"


@needs_api
def test_tracing_clickhouse_wins_over_local_and_langfuse_is_remote(tmp_path):
    root = _project(
        tmp_path, '[tracing]\nsinks = ["local", "trace_langfuse:edupia", "trace_clickhouse:default"]\n',
        LANGFUSE + "trace_clickhouse:\n  default:\n    host: ${CH_HOST}\n    port: 8123\n"
                   "    database: callbot_traces\n",
        env="LF_PK=pk\nLF_SK=sk\nCH_HOST=ch.example\n")
    pr = project_runs(root, sweep=False)
    assert pr.spec["backend"] == "clickhouse"
    assert pr.spec["host"] == "ch.example" and pr.spec["database"] == "callbot_traces"
    assert pr.spec["timeout"] <= 3.0          # a studio page waits seconds, not ten
    assert pr.info["label"] == "ClickHouse callbot_traces at ch.example:8123"
    assert pr.source == ("ClickHouse callbot_traces at ch.example:8123 — from [tracing] → "
                         "trace_clickhouse:default in operonx.toml")
    assert pr.remote is not None and pr.remote.config["host"] == "https://lf.example"


@needs_api
def test_sqlite_ranks_above_files(tmp_path):
    root = _project(tmp_path, '[tracing]\nsinks = ["local", "run_store:db"]\n',
                    "run_store:\n  db:\n    backend: sqlite\n")
    assert project_runs(root, sweep=False).spec["backend"] == "sqlite"


@needs_api
def test_unreadable_sinks_are_listed_and_the_readable_one_is_read(tmp_path):
    root = _project(tmp_path, '[tracing]\nsinks = ["trace_callbot:default", "local"]\n',
                    "trace_callbot:\n  default:\n    root: x\n")
    pr = project_runs(root, sweep=False)
    assert pr.spec["backend"] == "files"
    assert [s["sink"] for s in pr.info["skipped"]] == ["trace_callbot:default"]


@needs_api
def test_tracing_with_nothing_readable_falls_back_to_today_and_says_so(tmp_path):
    root = _project(tmp_path, '[tracing]\nsinks = ["trace_callbot:default"]\n',
                    "trace_callbot:\n  default: {root: x}\n")
    pr = project_runs(root, sweep=False)
    assert pr.spec == {"backend": "files", "root": str(root / ".operonx" / "runs")}
    assert "no readable store" in pr.info["why"]


@needs_api
def test_studio_runs_still_wins_over_tracing(tmp_path):
    root = _project(tmp_path, '[studio]\nruns = "run_store:mine"\n\n[tracing]\nsinks = ["trace_clickhouse:a"]\n',
                    "run_store:\n  mine:\n    backend: sqlite\n    path: mine.sqlite\n"
                    "trace_clickhouse:\n  a:\n    host: h\n")
    pr = project_runs(root, sweep=False)
    assert pr.spec["backend"] == "sqlite"
    assert pr.source == "run_store:mine (sqlite)"


def test_the_flat_run_store_key_is_read(tmp_path):
    root = _project(tmp_path, resources="run_store:default:\n  backend: files\n  root: flat\n")
    pr = project_runs(root, sweep=False)
    assert pr.spec["root"] == str(root / "flat")


@needs_api
def test_the_store_reopens_when_dotenv_changes(tmp_path):
    root = _project(tmp_path, '[tracing]\nsinks = ["trace_clickhouse:a"]\n',
                    "trace_clickhouse:\n  a:\n    host: ${CH_HOST}\n", env="CH_HOST=one\n")
    assert project_runs(root, sweep=False).spec["host"] == "one"
    (root / ".env").write_text("CH_HOST=two\n", encoding="utf-8")
    os.utime(root / ".env", ns=(time.time_ns() + 10**9, time.time_ns() + 10**9))
    assert project_runs(root, sweep=False).spec["host"] == "two"


def test_an_operonx_without_project_stores_keeps_todays_choice(tmp_path, monkeypatch):
    monkeypatch.setattr(runs_mod, "_project_stores", None)
    root = _project(tmp_path, '[tracing]\nsinks = ["trace_clickhouse:a"]\n',
                    "trace_clickhouse:\n  a:\n    host: h\n")
    pr = project_runs(root, sweep=False)
    assert pr.spec == {"backend": "files", "root": str(root / ".operonx" / "runs")}


# ── a store nobody answers at ─────────────────────────────────────────────


def _dead_clickhouse(tmp_path) -> Path:
    return _project(tmp_path, '[tracing]\nsinks = ["trace_clickhouse:a"]\n',
                    f"trace_clickhouse:\n  a:\n    host: 127.0.0.1\n    port: {_closed_port()}\n"
                    "    database: dead\n    media_dir: media\n")


@needs_api
def test_an_unreachable_clickhouse_is_a_clear_error_and_fails_fast_after(tmp_path):
    pytest.importorskip("clickhouse_connect")
    pr = project_runs(_dead_clickhouse(tmp_path), sweep=False)
    with pytest.raises(StoreUnreachable, match="can't reach the trace store .*ClickHouse dead at 127.0.0.1"):
        pr.store.list_runs(limit=1)
    t = time.time()
    with pytest.raises(StoreUnreachable):
        pr.store.count()
    assert time.time() - t < 0.5     # remembered, not retried on every call


@needs_api
def test_the_runs_screen_says_it_cannot_reach_the_store(client, tmp_path):
    pytest.importorskip("clickhouse_connect")
    pid = _open(client, _dead_clickhouse(tmp_path))
    r = client.get(f"/api/p/{pid}/runs?with_origins=1")
    assert r.status_code == 503
    body = r.json()
    assert body["store_unreachable"] is True
    assert body["error"].startswith("can't reach the trace store (ClickHouse dead at 127.0.0.1")
    assert body["store"]["why"] == "from [tracing] → trace_clickhouse:a in operonx.toml"
    s = client.get(f"/api/p/{pid}/settings")
    assert s.status_code == 200
    assert s.json()["runs"] is None and "can't reach" in s.json()["store_error"]
    assert s.json()["store_info"]["label"].startswith("ClickHouse dead")


@needs_api
def test_the_runs_list_carries_the_store_it_read(client, tmp_path):
    pid = _open(client, _project(tmp_path, '[tracing]\nsinks = ["local"]\n'))
    body = client.get(f"/api/p/{pid}/runs").json()
    assert body["store"]["why"] == "from [tracing] → local in operonx.toml"
    assert body["store"]["backend"] == "files"


# ── media ───────────────────────────────────────────────────────────────


def _wav(seconds: float = 0.1, rate: int = 8000) -> bytes:
    pcm = b"\x00\x01" * int(seconds * rate)
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
            + b"data" + struct.pack("<I", len(pcm)) + pcm)


@needs_api
def test_a_media_blob_is_served_from_the_stores_media_dir(client, tmp_path):
    root = _dead_clickhouse(tmp_path)
    data = _wav()
    sha = LocalMediaStore(root / "media").put(data, detect_media(data))
    pid = _open(client, root)
    r = client.get(f"/api/p/{pid}/media/{sha}")
    assert r.status_code == 200
    assert r.content == data
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["x-content-type-options"] == "nosniff"


@needs_api
def test_media_takes_only_a_sha_and_only_from_inside_media_dir(client, tmp_path):
    root = _dead_clickhouse(tmp_path)
    media = root / "media"
    media.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_text("no")
    pid = _open(client, root)
    assert client.get(f"/api/p/{pid}/media/not-a-sha").status_code == 400
    assert client.get(f"/api/p/{pid}/media/{'A' * 64}").status_code == 400
    assert client.get(f"/api/p/{pid}/media/..%2F..%2Fsecret.txt").status_code in (400, 404)
    # a blob slot that is a symlink out of the media dir is refused
    sha = hashlib.sha256(b"x").hexdigest()
    (media / sha[:2]).mkdir()
    (media / sha[:2] / f"{sha}.txt").symlink_to(secret)
    assert client.get(f"/api/p/{pid}/media/{sha}").status_code == 404
    assert client.get(f"/api/p/{pid}/media/{'0' * 64}").status_code == 404
    assert client.post(f"/api/p/{pid}/media/{sha}", json={}).status_code == 405


def test_a_store_with_no_media_dir_says_so(client, tmp_path):
    pid = _open(client, _project(tmp_path))
    r = client.get(f"/api/p/{pid}/media/{'0' * 64}")
    assert r.status_code == 404
    assert "keeps no media" in r.json()["error"]


# ── live: a run an engine-side store wrote, read back by the studio ──────


def test_live_clickhouse_run_is_listed_opened_and_its_audio_served(client, tmp_path):
    """Opt-in, against a throwaway server only (operonx's convention)::

        docker run -d --rm --name ox-ch-test -p 127.0.0.1:18123:8123 \\
            -e CLICKHOUSE_USER=oxtest -e CLICKHOUSE_PASSWORD=oxtest-pw clickhouse/clickhouse-server
        OPERONX_TEST_CLICKHOUSE=http://oxtest:oxtest-pw@127.0.0.1:18123
    """
    from urllib.parse import urlparse

    url = os.environ.get("OPERONX_TEST_CLICKHOUSE", "")
    if not url or runs_mod._project_stores is None:
        pytest.skip("set OPERONX_TEST_CLICKHOUSE (a throwaway ClickHouse) to run")
    pytest.importorskip("clickhouse_connect")
    import uuid

    from operonx.core.media import Media
    from operonx.core.workflow_trace import OpExecution, WorkflowTrace
    from operonx.telemetry.runs.clickhouse import ClickHouseRunStore

    u = urlparse(url)
    db = f"t_studio_{uuid.uuid4().hex[:8]}"
    root = _project(
        tmp_path, '[tracing]\nsinks = ["local", "trace_clickhouse:default"]\n',
        "trace_clickhouse:\n  default:\n    host: ${CH_HOST}\n    port: ${CH_PORT}\n"
        f"    user: ${{CH_USER}}\n    password: ${{CH_PASSWORD}}\n    database: {db}\n"
        "    media_dir: media\n",
        env=f"CH_HOST={u.hostname}\nCH_PORT={u.port or 8123}\nCH_USER={u.username or 'default'}\n"
            f"CH_PASSWORD={u.password or ''}\n")
    writer = ClickHouseRunStore(host=u.hostname, port=u.port or 8123, user=u.username or "default",
                                password=u.password or "", database=db, media_dir=root / "media",
                                flush_interval=0.05, ttl_days=0)
    try:
        wav = _wav(0.25)
        node = OpExecution(op_id="g.s#1", op_name="s", op_full_name="g.s", ctx=("main",),
                           start_time=1.0, end_time=1.02, inputs={"text": "xin chao"},
                           outputs={"audio": Media(wav, "audio/wav")}, upstreams=[], status="ok")
        tid = f"live-{uuid.uuid4().hex[:8]}"
        writer.consume(WorkflowTrace(trace_id=tid, workflow_name="tts", started_at=1.0, ended_at=1.02,
                                     nodes=[node], metadata={"origin": "adhoc"},
                                     wall_started_at=time.time()))
        writer.flush()

        pid = _open(client, root)
        listed = client.get(f"/api/p/{pid}/runs").json()
        assert listed["store"]["backend"] == "clickhouse"
        assert [r["run"] for r in listed["runs"]] == [tid]
        assert client.get(f"/api/p/{pid}/trace/{tid}/tree").status_code == 200
        op = client.get(f"/api/p/{pid}/trace/{tid}/op/s").json()   # what the inspector shows
        ref = op["executions"][0]["outputs"]["audio"]
        assert ref["mime"] == "audio/wav" and len(ref["$media"]) == 64
        got = client.get(f"/api/p/{pid}/media/{ref['$media']}")
        assert got.status_code == 200 and got.content == wav
        assert got.headers["content-type"] == "audio/wav"
    finally:
        try:
            writer.writer.close(timeout=2)
            writer._client().command(f"DROP DATABASE IF EXISTS {db}")
        except Exception:  # noqa: BLE001
            pass
