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


# ── media from a store with no files: ClickHouse's ``media: clickhouse`` ──


class _BlobStore:
    """What ``ClickHouseMediaStore`` offers a reader: ``get``/``exists``,
    no ``root``, no ``path``."""

    name = "clickhouse"

    def __init__(self, *blobs: bytes):
        self.blobs = {hashlib.sha256(b).hexdigest(): b for b in blobs}
        self.asked: list = []

    def get(self, sha):
        self.asked.append(sha)
        return self.blobs.get(sha)

    def exists(self, sha):
        return sha in self.blobs


def _with_store(client, tmp_path, media) -> str:
    """A project whose store's media is *media*."""
    from types import SimpleNamespace

    tmp_path.mkdir(parents=True, exist_ok=True)
    root = _project(tmp_path)
    pid = _open(client, root)
    pr = project_runs(root, sweep=False)
    pr.store = SimpleNamespace(media=media)
    return pid


def _pcm(seconds: float, rate: int) -> bytes:
    import math

    n = int(seconds * rate)
    return b"".join(struct.pack("<h", int(8000 * math.sin(i / 7))) for i in range(n))


def test_a_blob_with_no_file_is_read_from_the_stores_get(client, tmp_path):
    wav = _wav(0.2)
    store = _BlobStore(wav)
    pid = _with_store(client, tmp_path, store)
    sha = hashlib.sha256(wav).hexdigest()
    r = client.get(f"/api/p/{pid}/media/{sha}")
    assert r.status_code == 200 and r.content == wav
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert "immutable" in r.headers["cache-control"]
    assert "content-disposition" not in r.headers
    assert store.asked == [sha]
    # a player seeks with a range
    part = client.get(f"/api/p/{pid}/media/{sha}", headers={"Range": "bytes=4-11"})
    assert part.status_code == 206 and part.content == wav[4:12]
    assert part.headers["content-range"] == f"bytes 4-11/{len(wav)}"
    assert client.get(f"/api/p/{pid}/media/{sha}", headers={"Range": "bytes=-4"}).content == wav[-4:]
    assert client.get(f"/api/p/{pid}/media/{sha}",
                      headers={"Range": f"bytes={len(wav)}-"}).status_code == 416


def test_raw_l16_is_served_as_wav_with_its_declared_rate(client, tmp_path):
    from urllib.parse import quote

    pcm = _pcm(1.25, 8000)
    pid = _with_store(client, tmp_path, _BlobStore(pcm))
    sha = hashlib.sha256(pcm).hexdigest()
    r = client.get(f"/api/p/{pid}/media/{sha}?mime={quote('audio/L16;rate=8000;channels=1')}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert "content-disposition" not in r.headers
    body = r.content
    assert body[:4] == b"RIFF" and body[8:16] == b"WAVEfmt "
    assert struct.unpack("<I", body[4:8])[0] == len(body) - 8
    fmt, ch, rate, byte_rate, align, bits = struct.unpack("<HHIIHH", body[20:36])
    assert (fmt, ch, rate, byte_rate, align, bits) == (1, 1, 8000, 16000, 2, 16)
    assert body[36:40] == b"data" and struct.unpack("<I", body[40:44])[0] == len(pcm)
    assert body[44:] == pcm                     # the samples as kept, not swapped
    info = detect_media(body)
    assert info.mime == "audio/wav" and info.duration_s == pytest.approx(1.25)
    # the standard library reads it back
    import io
    import wave

    with wave.open(io.BytesIO(body)) as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (8000, 1, 2)
        assert w.getnframes() / w.getframerate() == pytest.approx(1.25)
    # stereo at 16 kHz; a torn last frame is dropped
    stereo = _pcm(0.5, 16000) + b"\x01"
    pid2 = _with_store(client, tmp_path / "two", _BlobStore(stereo))
    s2 = hashlib.sha256(stereo).hexdigest()
    body = client.get(f"/api/p/{pid2}/media/{s2}?mime={quote('audio/L16;rate=16000;channels=2')}").content
    assert detect_media(body).duration_s == pytest.approx(0.25)
    assert detect_media(body).channels == 2


def test_raw_pcm_with_no_declared_rate_downloads(client, tmp_path):
    from urllib.parse import quote

    pcm = _pcm(0.1, 8000)
    pid = _with_store(client, tmp_path, _BlobStore(pcm))
    sha = hashlib.sha256(pcm).hexdigest()
    for q in ("", "?mime=audio%2FL16", f"?mime={quote('audio/L16;rate=abc')}"):
        r = client.get(f"/api/p/{pid}/media/{sha}{q}")
        assert r.status_code == 200 and r.content == pcm
        assert r.headers["content-type"] == "application/octet-stream"
        assert r.headers["content-disposition"] == f'attachment; filename="{sha}.bin"'


def test_a_declared_type_never_makes_a_blob_render_inline(client, tmp_path):
    from urllib.parse import quote

    html = b"<html><script>alert(1)</script></html>" * 40
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' * 20
    pid = _with_store(client, tmp_path, _BlobStore(html, svg))
    for blob in (html, svg):
        sha = hashlib.sha256(blob).hexdigest()
        for mime in ("", "text/html", "image/svg+xml", "audio/wav", "image/png", "video/mp4"):
            r = client.get(f"/api/p/{pid}/media/{sha}?mime={quote(mime)}")
            assert r.status_code == 200, mime
            assert r.headers["content-type"] == "application/octet-stream", mime
            assert r.headers["content-disposition"].startswith("attachment;"), mime
            assert r.headers["x-content-type-options"] == "nosniff"
            assert r.content == blob
    # bytes that *are* a WAV play whatever is declared: the bytes win
    wav = _wav()
    pid2 = _with_store(client, tmp_path / "two", _BlobStore(wav))
    sha = hashlib.sha256(wav).hexdigest()
    r = client.get(f"/api/p/{pid2}/media/{sha}?mime={quote('audio/L16;rate=16000')}")
    assert r.headers["content-type"] == "audio/wav" and r.content == wav


def test_a_store_get_keeps_the_sha_rules(client, tmp_path):
    store = _BlobStore(b"x" * 2000)
    pid = _with_store(client, tmp_path, store)
    assert client.get(f"/api/p/{pid}/media/not-a-sha").status_code == 400
    assert client.get(f"/api/p/{pid}/media/{'A' * 64}").status_code == 400
    assert client.get(f"/api/p/{pid}/media/..%2F..%2Fsecret.txt").status_code in (400, 404)
    assert store.asked == []                    # nothing malformed reaches the store
    r = client.get(f"/api/p/{pid}/media/{'0' * 64}")
    assert r.status_code == 404 and r.json()["error"] == "no such media"
    # a store handing back other bytes than the id names is not believed
    store.blobs["1" * 64] = b"not what that id hashes"
    assert client.get(f"/api/p/{pid}/media/{'1' * 64}").status_code == 502


def test_a_store_that_is_away_is_a_503(client, tmp_path):
    class Away(_BlobStore):
        def get(self, sha):
            raise ConnectionError("refused")

    pid = _with_store(client, tmp_path, Away())
    r = client.get(f"/api/p/{pid}/media/{'0' * 64}")
    assert r.status_code == 503
    assert r.json()["store_unreachable"] is True and "refused" in r.json()["error"]


@needs_api
def test_a_local_raw_pcm_file_plays_as_wav_too(client, tmp_path):
    from urllib.parse import quote

    root = _dead_clickhouse(tmp_path)
    pcm = _pcm(0.5, 16000)
    sha = LocalMediaStore(root / "media").put(pcm, detect_media(pcm, "audio/L16;rate=16000"))
    pid = _open(client, root)
    plain = client.get(f"/api/p/{pid}/media/{sha}")
    assert plain.headers["content-type"] == "application/octet-stream"
    assert plain.headers["content-disposition"] == f'attachment; filename="{sha}.pcm"'
    r = client.get(f"/api/p/{pid}/media/{sha}?mime={quote('audio/L16;rate=16000;channels=1')}")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert r.content[44:] == pcm and detect_media(r.content).duration_s == pytest.approx(0.5)


@needs_api
def test_a_local_svg_never_renders_inline(client, tmp_path):
    root = _dead_clickhouse(tmp_path)
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' * 20
    sha = LocalMediaStore(root / "media").put(svg, detect_media(svg, "image/svg+xml"))
    pid = _open(client, root)
    r = client.get(f"/api/p/{pid}/media/{sha}?mime=image%2Fsvg%2Bxml")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment;")


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
