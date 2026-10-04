"""Experiments, compare and the dataset editor — the routes behind Evals.

An eval run is an **experiment** (``operonx.app.evals``): its job record
on the machine that ran it, and — when the project has a score store —
its rows there, which every machine reads. The studio opens the store
the project uses (``project_score_store``: ``[evals] scores``, else the
``[tracing]`` ClickHouse sink, else files under the runs root), read from
the project's own files and ``.env``, never by importing its code, and
lists an eval's experiments from the store and the records together. A
store that cannot be opened or does not answer is said on the page, and
the records are still read.

Every number here is operonx's: the summaries, intervals and the gate's
verdict are what the run wrote; a comparison is ``operonx.app.evals.
compare``; how a case moved is ``gate.flip_class``. Datasets are JSONL
files in git: a case is edited through ``Dataset.update`` (one line
rewritten, the rest byte for byte) and archived instead of deleted, so
its history across experiments stays readable.

Pages are one hop: the list carries each experiment's summary, the
detail its cases with every trial, the compare everything it shows.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from fastapi.responses import JSONResponse
from operonx.app.evals import Dataset, compare, load_experiment
from operonx.app.evals.experiments import ExperimentData, experiments_of
from operonx.app.evals.fingerprint import case_hash, dataset_version
from operonx.app.evals.gate import FLAKY, flip_class

__all__ = ["ProjectScores", "project_scores", "register", "summary_row"]

#: How many experiments a list reads, and how many a case's history spans.
LIST_LIMIT = 30
HISTORY_LIMIT = 10
#: Backends reached over the network: their failures are "unreachable".
_NETWORK = ("clickhouse",)
#: A case id the run route passes to ``operonx eval run --cases``.
_CASE_ID = re.compile(r"[^,\s]{1,200}")


# ── the project's score store ────────────────────────────────────────────


@dataclass
class ProjectScores:
    """The project's score store, opened once — or ``None`` with the
    reason. ``info`` is what the pages say: ``openable``, ``label``,
    ``source`` (the setting that chose it), ``reason``."""

    store: Any
    info: Dict[str, Any]
    fingerprint: Tuple[Any, ...] = ()
    error: str = ""

    def read(self, fn: Callable[[Any], Any], default: Any) -> Any:
        """``fn(store)``, or *default* with the failure kept in ``error``
        (a ClickHouse that stopped answering): the page says it and shows
        the records."""
        if self.store is None:
            return default
        try:
            return fn(self.store)
        except Exception as exc:  # noqa: BLE001 — every backend's own error type
            self.error = str(exc) or type(exc).__name__
            return default

    def said(self) -> Dict[str, Any]:
        return {**self.info, "error": self.error or None}


_OPEN: Dict[str, ProjectScores] = {}
_LOCK = threading.Lock()


def project_scores(root: Path) -> ProjectScores:
    """The project's score store — reopened when its configuration changes."""
    from operonx.telemetry.scores import project_score_store

    from operonx_studio.runs import _fingerprint, _Guarded

    root = Path(root)
    key = str(root.resolve())
    marks = _fingerprint(root)
    with _LOCK:
        got = _OPEN.get(key)
        if got is not None and got.fingerprint == marks:
            got.error = ""
            return got
        if got is not None and got.store is not None:
            got.store.close()
        try:
            src = project_score_store(root)
        except Exception as exc:  # noqa: BLE001 — a malformed [evals] / [tracing] is shown
            info = {"openable": False, "label": None, "source": "operonx.toml", "reason": str(exc)}
            got = ProjectScores(None, info, marks)
        else:
            info = {"openable": src.openable, "label": src.describe() if src.openable else None,
                    "source": src.source, "reason": src.reason or None}
            store = None
            if src.openable:
                try:
                    store = src.open()
                except Exception as exc:  # noqa: BLE001 — named on the page, records still read
                    info.update(openable=False, reason=f"{type(exc).__name__}: {exc}")
                if store is not None and src.spec.get("backend") in _NETWORK:
                    store = _Guarded(store, info, what="score store")
            got = ProjectScores(store, info, marks)
        _OPEN[key] = got
    return got


# ── reading experiments ──────────────────────────────────────────────────


def summary_row(d: ExperimentData) -> Dict[str, Any]:
    """One experiment as a list row: what produced it, how it went, what
    it cost — every number as the run (or its store row) wrote it."""
    s, gate, fp = d.summary, d.gate, d.fingerprint
    rel = s.get("reliability") or {}
    return {
        "id": d.experiment_id,
        "eval": d.eval,
        "status": d.status,
        "started": d.started,
        "ended": d.ended,
        "source": "store" if d.source == "store" else "record",
        "variant": s.get("variant"),
        "split": s.get("split"),
        "repeats": int(s.get("repeats") or 1),
        "cases": s.get("cases"),
        "trials": s.get("trials"),
        "errored": s.get("errored"),
        "verdict": gate.get("verdict"),
        "exit_code": gate.get("exit_code"),
        "reasons": list(gate.get("reasons") or []),
        "warnings": list(gate.get("warnings") or []),
        "baseline": (gate.get("comparison") or {}).get("baseline"),
        "pass": (s.get("metrics") or {}).get("pass"),
        "metrics": dict(s.get("metrics") or {}),
        "fingerprint": {k: fp.get(k) for k in ("code_version", "version_dirty", "dataset_version",
                                               "graph_hash", "config_hash", "evaluators_hash",
                                               "operonx_version")},
        "cost_usd": s.get("cost_usd"),
        "judge_cost_usd": s.get("judge_cost_usd"),
        "p50_ms": s.get("p50_ms"),
        "p95_ms": s.get("p95_ms"),
        "flaky": rel.get("flaky"),
        "pass_hat_k": rel.get("pass_hat_k"),
    }


def experiment_rows(name: str, scores: ProjectScores, record_dirs: Iterable[Path],
                    limit: int = LIST_LIMIT) -> List[Dict[str, Any]]:
    """*name*'s experiments, newest first: summaries only (operonx reads
    each record's run.json and the store's rows in one query)."""
    dirs = [Path(d) for d in record_dirs]
    got = scores.read(lambda st: experiments_of(name, store=st, record_dirs=dirs, limit=limit, items=False),
                      None)
    if got is None:  # no store, or it failed: the records, as before
        got = experiments_of(name, record_dirs=dirs, limit=limit, items=False)
    return [summary_row(d) for d in got]


def find_experiment(eid: str, scores: ProjectScores, record_dirs: Iterable[Path]) -> Optional[ExperimentData]:
    """One experiment with its items: its record when this machine has
    it (expected values and every verdict field), else the store's rows."""
    dirs = [Path(d) for d in record_dirs]
    try:
        return load_experiment(eid, record_dirs=dirs)
    except ValueError:
        pass
    return scores.read(lambda st: ExperimentData.from_store(st, eid), None)


def history(name: str, scores: ProjectScores, record_dirs: Iterable[Path],
            limit: int = HISTORY_LIMIT) -> Tuple[List[ExperimentData], Dict[str, List[Dict[str, Any]]]]:
    """*name*'s last *limit* experiments, oldest first, and each case's
    outcome in them: ``{case: [{experiment, passes, trials, stability}]}``."""
    dirs = [Path(d) for d in record_dirs]
    got = scores.read(lambda st: experiments_of(name, store=st, record_dirs=dirs, limit=limit), None)
    if got is None:
        got = experiments_of(name, record_dirs=dirs, limit=limit)
    exps = list(reversed(got))
    out: Dict[str, List[Dict[str, Any]]] = {}
    for d in exps:
        for case, o in d.outcomes().items():
            out.setdefault(case, []).append({"experiment": d.experiment_id, "passes": sum(o.passed),
                                             "trials": len(o.passed), "stability": o.stability})
    return exps, out


def _rows_by_id(path: Optional[Path]) -> Dict[str, Dict[str, Any]]:
    if path is None or not path.is_file():
        return {}
    try:
        return {r["id"]: r for r in Dataset(path).all_rows()}
    except ValueError:
        return {}


def case_rows(d: ExperimentData, dataset: Optional[Path]) -> List[Dict[str, Any]]:
    """Every case of *d* with its trials, in the order they first ran.
    ``input`` and — when the record did not keep it — ``expected`` come
    from the dataset file, if the case is unchanged since (``case_hash``)."""
    rows = _rows_by_id(dataset)
    flips: Dict[str, str] = {}
    for cls, ids in (((d.gate.get("comparison") or {}).get("flips") or {}).get("cases") or {}).items():
        for c in ids:
            flips[c] = cls
    outcomes = d.outcomes()
    trials: Dict[str, List[Dict[str, Any]]] = {}
    for it in d.items:
        trials.setdefault(it["case"], []).append(it)
    out = []
    for case, items in trials.items():
        items = sorted(items, key=lambda i: i.get("repeat") or 0)
        o = outcomes[case]
        failed: List[str] = []
        blame = None
        for it in items:
            for name, c in (it.get("checks") or {}).items():
                if c.get("passed"):
                    continue
                if name not in failed:
                    failed.append(name)
                if blame is None and c.get("op"):
                    blame = {"check": name, "op": c["op"], "trace_id": it.get("trace_id"),
                             "repeat": it.get("repeat") or 0}
        row = rows.get(case)
        recorded = next((it.get("case_hash") for it in items if it.get("case_hash")), None)
        changed = bool(row is not None and recorded and case_hash(row) != recorded)
        expected = next((it["expected"] for it in items if "expected" in it), None)
        if expected is None and row is not None and not changed:
            expected = row.get("expected")
        out.append({
            "case": case,
            "tags": list(items[0].get("tags") or []),
            "cluster": items[0].get("cluster"),
            "stability": o.stability,
            "flip": flips.get(case),
            "passes": sum(o.passed),
            "trials": len(o.passed),
            "errored": o.errored,
            "failed_checks": failed,
            "blame": blame,
            "input": row.get("input") if row is not None else None,
            "expected": expected,
            "in_dataset": row is not None,
            "case_changed": changed,
            "runs": [{k: it.get(k) for k in ("repeat", "status", "passed", "checks", "error", "output",
                                             "trace_id", "ms", "cost_usd")} for it in items],
        })
    return out


def experiment_payload(d: ExperimentData, dataset: Optional[Path]) -> Dict[str, Any]:
    gate = d.gate
    metrics = [{"name": k, **v} for k, v in d.metrics.items()]
    metrics.sort(key=lambda m: (m["name"] != "pass", m["name"]))
    return {
        "experiment": summary_row(d),
        "gate": {k: gate.get(k) for k in ("verdict", "exit_code", "reasons", "warnings", "must_pass",
                                          "comparison", "error_rate", "gate", "strict")},
        "metrics": metrics,
        "reliability": d.summary.get("reliability") or {},
        "checks": d.summary.get("checks") or {},
        "dataset": str(dataset) if dataset else None,
        "cases": case_rows(d, dataset),
    }


def compare_payload(a: ExperimentData, b: ExperimentData, tolerance: Optional[str]) -> Dict[str, Any]:
    """*b* against *a* with operonx's ``compare``; per case, how it moved.
    *tolerance* ``None`` takes the one *b*'s gate ran with; ``""`` none
    (compared, not judged). Raises ``ValueError`` on a bad number."""
    gate_opts = (b.gate.get("gate") or {})
    used: Optional[Dict[str, Any]] = None
    if tolerance is None:
        tol = gate_opts.get("tolerance")
        if tol is not None:
            used = {"value": tol, "from": f"the gate {b.experiment_id} ran with"}
    elif tolerance.strip() == "":
        tol = None
    else:
        try:
            tol = float(tolerance)
        except ValueError:
            raise ValueError(f"tolerance is a drop in [0, 1] (0.05 = 5 points), not {tolerance!r}") from None
        used = {"value": tol, "from": "asked"}
    got = compare(a, b, tolerance=tol, metrics=gate_opts.get("metrics") if tol is not None else None)
    oa, ob = a.outcomes(), b.outcomes()
    cases = []
    for case in sorted(set(oa) | set(ob)):
        x, y = oa.get(case), ob.get(case)
        if x is None or y is None:
            cls = "only_b" if x is None else "only_a"
        elif x.case_hash and y.case_hash and x.case_hash != y.case_hash:
            cls = "changed"
        else:
            cls = flip_class(x, y) or ("noise" if x.stability == y.stability == FLAKY else "same")
        cases.append({"case": case, "class": cls,
                      "a": {"passes": sum(x.passed), "trials": len(x.passed)} if x else None,
                      "b": {"passes": sum(y.passed), "trials": len(y.passed)} if y else None})
    return {**got, "tolerance": used, "a": summary_row(a), "b": summary_row(b), "cases": cases}


def dataset_info(path: Path) -> Dict[str, Any]:
    """A dataset file's version (of its active cases), splits and problems."""
    ds = Dataset(path)
    rows = ds.all_rows()
    active = [r for r in rows if r.get("status") != "archived"]
    splits: Dict[str, int] = {}
    for r in active:
        if r.get("split"):
            splits[str(r["split"])] = splits.get(str(r["split"]), 0) + 1
    return {"version": dataset_version(active), "total": len(rows), "active": len(active),
            "splits": splits, "problems": [{"line": n, "why": why} for n, why in ds.problems()]}


# ── routes ───────────────────────────────────────────────────────────────


def register(app: Any, *, watcher_of: Callable[[str], Any], evals_of: Callable[[Any], List[Dict[str, Any]]],
             datasets_of: Callable[[Any], List[Dict[str, Any]]], dataset_file: Callable[[Path, str], Path]) -> None:
    """The experiment and dataset routes. ``evals_of(watcher)`` is the
    project's ``kind=eval`` jobs (from its IR), ``datasets_of(watcher)``
    the Datasets list, ``dataset_file(root, ref)`` a ``dataset:`` ref's path."""

    def _project(pid: str):
        watcher = watcher_of(pid)
        if watcher is None:
            return None, None, None
        return watcher, evals_of(watcher), project_scores(watcher.root)

    def _dirs(evals: List[Dict[str, Any]]) -> List[Path]:
        return list(dict.fromkeys(Path(e["record_dir"]) for e in evals if e.get("record_dir")))

    def _dataset_of(watcher: Any, evals: List[Dict[str, Any]], name: str) -> Optional[Path]:
        ev = next((e for e in evals if e["name"] == name), None)
        return dataset_file(watcher.root, ev["dataset"]) if ev and ev.get("dataset") else None

    @app.get("/api/p/{pid}/experiments")
    def experiments_list(pid: str, eval: str = "", limit: int = LIST_LIMIT) -> JSONResponse:
        """Experiments per eval, newest first — the store's and the records'."""
        watcher, evals, scores = _project(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        names = [e["name"] for e in evals if not eval or e["name"] == eval]
        if eval and not names:
            return JSONResponse({"error": f"unknown eval {eval!r}"}, status_code=404)
        rows: List[Dict[str, Any]] = []
        for name in names:
            rows += experiment_rows(name, scores, _dirs(evals), max(1, min(limit, 200)))
        rows.sort(key=lambda r: (r["started"] or "", r["id"]), reverse=True)
        return JSONResponse({"experiments": rows, "scores": scores.said()})

    @app.get("/api/p/{pid}/experiments/compare")
    def experiments_compare(pid: str, a: str, b: str, tolerance: Optional[str] = None) -> JSONResponse:
        """B against A (the baseline), paired, by operonx's ``compare``."""
        watcher, evals, scores = _project(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        found = [find_experiment(x, scores, _dirs(evals)) for x in (a, b)]
        missing = [x for x, d in zip((a, b), found) if d is None]
        if missing:
            return JSONResponse({"error": f"no experiment {missing[0]!r}", "scores": scores.said()},
                                status_code=404)
        try:
            got = compare_payload(found[0], found[1], tolerance)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({**got, "scores": scores.said()})

    @app.get("/api/p/{pid}/experiments/{eid}")
    def experiment_one(pid: str, eid: str) -> JSONResponse:
        """One experiment: summary, gate, metrics and every case with its trials."""
        watcher, evals, scores = _project(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        d = find_experiment(eid, scores, _dirs(evals))
        if d is None:
            return JSONResponse({"error": f"no experiment {eid!r}", "scores": scores.said()}, status_code=404)
        return JSONResponse({**experiment_payload(d, _dataset_of(watcher, evals, d.eval)),
                             "scores": scores.said()})

    @app.get("/api/p/{pid}/experiments/{eid}/cases/{case}")
    def experiment_case(pid: str, eid: str, case: str) -> JSONResponse:
        """One case of an experiment: its trials, and the case across the
        eval's last experiments."""
        watcher, evals, scores = _project(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        d = find_experiment(eid, scores, _dirs(evals))
        if d is None:
            return JSONResponse({"error": f"no experiment {eid!r}"}, status_code=404)
        row = next((c for c in case_rows(d, _dataset_of(watcher, evals, d.eval)) if c["case"] == case), None)
        if row is None:
            return JSONResponse({"error": f"no case {case!r} in experiment {eid}"}, status_code=404)
        exps, hist = history(d.eval, scores, _dirs(evals))
        return JSONResponse({**row, "experiment": eid, "eval": d.eval, "history": hist.get(case, []),
                             "experiments": [_column(x) for x in exps]})

    @app.post("/api/p/{pid}/evals/{name}/run")
    def eval_start(pid: str, name: str, body: Dict[str, Any]) -> JSONResponse:
        """Run an eval as an experiment: ``operonx eval run``, detached,
        under the project's interpreter — it writes the record and the
        project's score store, which every page reads."""
        watcher, evals, scores = _project(pid)
        ev = next((e for e in evals or [] if e["name"] == name), None)
        if ev is None:
            return JSONResponse({"error": f"unknown eval {name!r}"}, status_code=404)
        body = body or {}
        cmd = [watcher.interpreter(), "-m", "operonx.cli.eval", "run", name]
        if body.get("repeats") is not None:
            n = body["repeats"]
            if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 50:
                return JSONResponse({"error": "repeats is a number of runs per case, 1 to 50"}, status_code=400)
            cmd += ["--repeats", str(n)]
        cases = [str(c) for c in body.get("cases") or []]
        if cases:
            path = _dataset_of(watcher, evals, name)
            have = set(_rows_by_id(path))
            bad = [c for c in cases if c not in have or not _CASE_ID.fullmatch(c)]
            if bad:
                return JSONResponse({"error": f"not cases of {name}'s dataset: {bad}"}, status_code=400)
            cmd += ["--cases", ",".join(cases)]
        for key in ("split", "baseline", "variant"):
            if body.get(key):
                cmd += [f"--{key}", str(body[key])]
        if body.get("tolerance") is not None:
            cmd += ["--tolerance", str(float(body["tolerance"]))]
        if body.get("no_store"):
            cmd.append("--no-store")
        elif not scores.info.get("openable"):
            return JSONResponse({"error": f"the project's score store cannot be opened ({scores.info.get('source')}): "
                                          f"{scores.info.get('reason')}. Fix it, or run without the store "
                                          "(no_store) — the experiment then lives in this machine's record only"},
                                status_code=400)
        logs = Path(ev["record_dir"]) / name / ".studio"
        logs.mkdir(parents=True, exist_ok=True)
        log = logs / f"{time.strftime('%Y%m%dT%H%M%S')}.log"
        env = dict(os.environ)
        env.setdefault("PYTHONUNBUFFERED", "1")
        with log.open("ab") as fh:
            proc = subprocess.Popen(cmd, cwd=str(watcher.root), stdout=fh, stderr=subprocess.STDOUT,
                                    env=env, start_new_session=True)
        return JSONResponse({"started": name, "pid": proc.pid, "log": str(log), "argv": cmd[2:]})

    @app.get("/api/p/{pid}/datasets")
    def datasets_list(pid: str) -> JSONResponse:
        watcher = watcher_of(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        out = []
        for d in datasets_of(watcher):
            info = dataset_info(Path(d["path"])) if d.get("exists") and not d.get("error") else {}
            out.append({**d, **{k: info.get(k) for k in ("version", "active", "splits")}})
        return JSONResponse({"datasets": out})

    @app.get("/api/p/{pid}/datasets/{name}/cases/{case}/history")
    def dataset_case_history(pid: str, name: str, case: str) -> JSONResponse:
        watcher, evals, scores = _project(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        found = next((d for d in datasets_of(watcher) if d["name"] == name), None)
        if found is None:
            return JSONResponse({"error": f"unknown dataset {name!r}"}, status_code=404)
        exps, hist = dataset_history(found, evals, scores, _dirs(evals))
        return JSONResponse({"case": case, "history": hist.get(case, []), "experiments": exps})

    @app.patch("/api/p/{pid}/datasets/{name}/rows/{case}")
    def dataset_edit(pid: str, name: str, case: str, body: Dict[str, Any]) -> JSONResponse:
        """Edit one case: operonx's ``Dataset.update`` rewrites its line."""
        watcher = watcher_of(pid)
        if watcher is None:
            return JSONResponse({"error": "unknown project"}, status_code=404)
        found = next((d for d in datasets_of(watcher) if d["name"] == name), None)
        if found is None or not found.get("exists"):
            return JSONResponse({"error": f"unknown dataset {name!r}"}, status_code=404)
        path = Path(found["path"])
        if case not in _rows_by_id(path):
            return JSONResponse({"error": f"no case {case!r} in {name}"}, status_code=404)
        try:
            row = Dataset(path).update(case, dict(body or {}))
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse({"row": row, **dataset_info(path)})


def _column(d: ExperimentData) -> Dict[str, Any]:
    """An experiment as a history strip's column."""
    return {"id": d.experiment_id, "eval": d.eval, "started": d.started,
            "variant": d.summary.get("variant"), "verdict": d.gate.get("verdict"),
            "code_version": d.fingerprint.get("code_version")}


def dataset_history(dataset: Dict[str, Any], evals: List[Dict[str, Any]], scores: ProjectScores,
                    record_dirs: List[Path]) -> Tuple[List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    """Each case of *dataset* across the last experiments of the evals that
    use it, oldest first: ``(columns, {case: [{experiment, passes, …}]})``."""
    columns: List[Tuple[str, Dict[str, Any]]] = []
    merged: Dict[str, List[Dict[str, Any]]] = {}
    for name in dataset.get("used_by") or []:
        exps, hist = history(name, scores, record_dirs)
        columns += [((d.started or ""), _column(d)) for d in exps]
        for case, cells in hist.items():
            merged.setdefault(case, []).extend(cells)
    columns.sort(key=lambda c: c[0])
    order = {c["id"]: i for i, (_, c) in enumerate(columns)}
    for cells in merged.values():
        cells.sort(key=lambda h: order.get(h["experiment"], 0))
    return [c for _, c in columns], merged
