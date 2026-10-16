"""Starter projects: working graphs with a service, a dataset, an eval and a job.

Each template is a small, real product that runs offline — no model keys,
no network — so a new project shows a green run, a trace and an eval in
its first minutes. Where a model belongs, the code says so and names the
op to swap for an ``LLMOp``. Services, jobs and evals are declared in
``app.py`` (``operonx.toml`` points at it);
the studio's playground drives the service, its Evals tab runs the eval.

``create(root, template, name)`` writes one; ``TEMPLATES`` lists them.
"""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path
from typing import Any, Callable, Dict, List

__all__ = ["TEMPLATES", "TemplateError", "create", "describe"]

OPERONX_PIN = "1.17.1"


class TemplateError(Exception):
    """The template or the target directory is unusable."""


_RESOURCES = """\
# What this project reaches out to. Runs are recorded locally under
# .operonx/runs (the studio reads them there).
trace_local:
  default: {}
"""

_PYPROJECT = """\
[project]
name = "{dist}"
version = "0.1.0"
description = "{description}"
requires-python = ">=3.10"
dependencies = [
    "operonx[serve]>={pin}",
]
"""

_GITIGNORE = ".operonx/\n__pycache__/\nout/\nevals/\njobs/\n.venv/\n"


def _jsonl(rows: List[Dict[str, Any]]) -> str:
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


# ── an HTTP API ─────────────────────────────────────────────────────────────

_API_MAIN = '''\
"""An HTTP API: POST {"text": "..."} and get a one-line summary and its keywords.

The summary is extractive — the first sentence — so the project runs with
no model. To use one, replace `summarize` with an LLMOp:

    s = LLMOp.of(resource="my_llm", prompt={"system": "Summarise in one line.", "user": "{text}"},
                 text=c["text"])
"""

import re
from collections import Counter

from operonx.app.serve import egress, ingress
from operonx.core import END, START, graph, op

STOP = set("the a an and or of to in on for with is are was were be been it this that as at by from "
           "we you they he she i our your their its not but so if than then into over about".split())


@op(bound="sync")
def clean(payload: dict = None) -> dict:
    """The request's text, whitespace tidied; a request without text is refused."""
    text = str((payload or {}).get("text", "")).strip()
    if not text:
        raise ValueError('send {"text": "..."}')
    return {"text": re.sub(r"\\s+", " ", text)}


@op(bound="sync")
def summarize(text: str = "") -> dict:
    """The first sentence, and the three words that matter most."""
    first = re.split(r"(?<=[.!?])\\s+", text)[0]
    words = [w for w in re.findall(r"[a-z']+", text.lower()) if w not in STOP and len(w) > 2]
    keywords = [w for w, _ in Counter(words).most_common(3)]
    return {"reply": {"summary": first[:240], "keywords": keywords, "words": len(text.split())}}


@graph
def summarize_flow():
    src = ingress()
    cleaned = clean(payload=src["item"])
    summary = summarize(text=cleaned["text"])
    out = egress(item=summary["reply"])
    START >> src >> cleaned >> summary >> out >> END


def keywords_found(output=None, expected=None):
    """The eval's check: every expected keyword is among the summary's."""
    missing = [k for k in (expected or {}).get("keywords", []) if k not in (output or {}).get("keywords", [])]
    return {"passed": not missing, "reason": f"missing {missing}" if missing else None}
'''

_API_TOML = '''\
[project]
name = "{name}"
description = "An HTTP API: text in, a one-line summary and its keywords out."
app = "app:APP"

[resources]
overlay = "resources.yaml"
'''

_API_APP = '''\
"""The application: the summarizer behind HTTP, a batch job over a file, and an eval."""

from pathlib import Path

from operonx.app import Application, Eval, Service, http
from operonx.app.jobs import Job

from main import keywords_found, summarize_flow

HERE = Path(__file__).resolve().parent

APP = Application(
    "{name}",
    services=[
        Service("summarize", http("POST", "/summarize", port=8080), graph=summarize_flow,
                description='POST {{"text": "..."}} — a one-line summary and three keywords.'),
    ],
    jobs=[
        Job("summarize_all", graph=summarize_flow, items=HERE / "data/articles.jsonl",
            output=HERE / "out/summaries.jsonl", key="id",
            description="Summarise every article in data/articles.jsonl."),
        Eval("quality", graph=summarize_flow, dataset="dataset:examples", evaluators=[keywords_found],
             threshold=0.75, description="Do the summaries keep the words that matter?"),
    ],
    trace=["trace_local:default"],
)
'''

_API_DATA = [
    {"id": "a1", "text": "Rain is expected across the north this weekend. Farmers welcome the rain after a dry month."},
    {"id": "a2", "text": "The library opens a new reading room on Monday. The reading room has quiet desks and late hours."},
    {"id": "a3", "text": "Ticket prices for the city train rise next year. The train company says prices fund new trains."},
]
_API_CASES = [
    {"id": "rain", "input": {"text": _API_DATA[0]["text"]}, "expected": {"keywords": ["rain"]}, "tags": ["news"]},
    {"id": "library", "input": {"text": _API_DATA[1]["text"]}, "expected": {"keywords": ["reading", "room"]}, "tags": ["news"]},
    {"id": "trains", "input": {"text": _API_DATA[2]["text"]}, "expected": {"keywords": ["train", "prices"]}, "tags": ["news"]},
    {"id": "tiny", "input": {"text": "Hello world."}, "expected": {"keywords": ["hello", "world"]}, "tags": ["edge"]},
]


# ── a batch scorer ──────────────────────────────────────────────────────────

_SCORER_MAIN = '''\
"""A batch scorer: every review in a file, scored positive, negative or neutral.

A word list does the scoring so the project runs with no model; a trained
classifier or an LLMOp slots into `score` without touching the job.
"""

import re

from operonx.app.serve import egress, ingress
from operonx.core import END, START, graph, op

POSITIVE = set("good great love loved excellent friendly fast helpful clean perfect amazing happy recommend".split())
NEGATIVE = set("bad slow rude dirty broken terrible awful late cold never disappointed refund".split())


@op(bound="sync")
def score(review: dict = None) -> dict:
    """Positive words minus negative ones, and the label that follows."""
    words = re.findall(r"[a-z']+", str((review or {}).get("text", "")).lower())
    s = sum(w in POSITIVE for w in words) - sum(w in NEGATIVE for w in words)
    label = "positive" if s > 0 else "negative" if s < 0 else "neutral"
    return {"result": {"id": (review or {}).get("id"), "score": s, "label": label}}


@graph
def score_flow():
    src = ingress()
    scored = score(review=src["item"])
    out = egress(item=scored["result"])
    START >> src >> scored >> out >> END


def label_matches(output=None, expected=None):
    ok = (output or {}).get("label") == (expected or {}).get("label")
    return {"passed": ok, "reason": None if ok else f"said {(output or {}).get('label')}"}
'''

_SCORER_TOML = '''\
[project]
name = "{name}"
description = "A batch scorer: reviews in, a sentiment label per review out, with a record per run."
app = "app:APP"

[resources]
overlay = "resources.yaml"
'''

_SCORER_APP = '''\
"""The application: a nightly scoring job, an eval against labels, and the scorer behind HTTP.

Run the job on a clock with cron: `0 6 * * *  operonx run score_reviews`.
"""

from pathlib import Path

from operonx.app import Application, Eval, Service, http
from operonx.app.jobs import Job

from main import label_matches, score_flow

HERE = Path(__file__).resolve().parent

APP = Application(
    "{name}",
    services=[
        Service("score", http("POST", "/score", port=8081), graph=score_flow,
                description='POST {{"id": "r1", "text": "..."}} — one review scored.'),
    ],
    jobs=[
        Job("score_reviews", graph=score_flow, items=HERE / "data/reviews.jsonl",
            output=HERE / "out/scores.jsonl", key="id", concurrency=4,
            description="Score every review in data/reviews.jsonl; one run per review."),
        Eval("labels", graph=score_flow, dataset="dataset:labelled", evaluators=[label_matches],
             threshold=0.8, description="Does the scorer agree with the labels a person gave?"),
    ],
    trace=["trace_local:default"],
)
'''

_REVIEWS = [
    {"id": "r1", "text": "Great food and friendly staff, we loved it."},
    {"id": "r2", "text": "Slow service and the soup was cold."},
    {"id": "r3", "text": "It was fine, nothing special."},
    {"id": "r4", "text": "Terrible, rude waiter. Never again."},
    {"id": "r5", "text": "Clean rooms, helpful desk, would recommend."},
]
_LABELLED = [
    {"id": "praise", "input": _REVIEWS[0], "expected": {"label": "positive"}},
    {"id": "complaint", "input": _REVIEWS[1], "expected": {"label": "negative"}},
    {"id": "meh", "input": _REVIEWS[2], "expected": {"label": "neutral"}},
    {"id": "angry", "input": _REVIEWS[3], "expected": {"label": "negative"}},
    {"id": "hotel", "input": _REVIEWS[4], "expected": {"label": "positive"}},
]


# ── a RAG question-answerer ─────────────────────────────────────────────────

_RAG_MAIN = '''\
"""A question-answerer over the documents in docs/: retrieve, then answer.

Retrieval scores each passage by the words it shares with the question;
the answer is the best passage's best sentence, with its source. Both run
with no model or index. To grow it: put an EmbeddingOp and a vector store
in `retrieve`, and replace `answer` with an LLMOp that reads the passages:

    a = LLMOp.of(resource="my_llm", prompt={"system": "Answer from the passages only.",
                 "user": "{question}\\n\\n{passages}"}, question=..., passages=...)
"""

import re
from pathlib import Path

from operonx.app.serve import egress, ingress
from operonx.core import END, START, graph, op

DOCS = Path(__file__).parent / "docs"
STOP = set("the a an and or of to in on for with is are was be it this that as at by from what when how "
           "do does can i my you your we our who which where".split())


def _words(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9']+", text.lower()) if w not in STOP}


def _passages():
    for path in sorted(DOCS.glob("*.md")):
        for block in path.read_text(encoding="utf-8").split("\\n\\n"):
            if block.strip() and not block.startswith("#"):
                yield path.name, block.strip()


@op(bound="sync")
def retrieve(item=None) -> dict:
    """The three passages that share the most words with the question."""
    question = item.get("question", "") if isinstance(item, dict) else str(item or "")
    q = _words(question)
    ranked = sorted(((len(q & _words(p)), src, p) for src, p in _passages()), reverse=True)
    return {"question": question, "passages": [{"source": s, "text": p} for n, s, p in ranked[:3] if n]}


@op(bound="sync")
def answer(question: str = "", passages: list = None) -> dict:
    """The sentence of the top passage that matches the question best."""
    if not passages:
        return {"reply": {"answer": "I could not find that in the documents.", "sources": []}}
    q = _words(question)
    sentences = re.split(r"(?<=[.!?])\\s+", passages[0]["text"])
    best = max(sentences, key=lambda s: len(q & _words(s)))
    return {"reply": {"answer": best, "sources": [p["source"] for p in passages]}}


@graph
def ask_flow():
    src = ingress()
    found = retrieve(item=src["item"])
    answered = answer(question=found["question"], passages=found["passages"])
    out = egress(item=answered["reply"])
    START >> src >> found >> answered >> out >> END


def mentions(output=None, expected=None):
    """The answer contains what a person said it must."""
    text = str((output or {}).get("answer", "")).lower()
    missing = [x for x in (expected or {}).get("mentions", []) if x.lower() not in text]
    return {"passed": not missing, "reason": f"missing {missing}" if missing else None}
'''

_RAG_TOML = '''\
[project]
name = "{name}"
description = "Questions answered from the documents in docs/ — retrieve, then answer, with sources."
app = "app:APP"

[resources]
overlay = "resources.yaml"
'''

_RAG_APP = '''\
"""The application: the question-answerer behind HTTP, a batch job, and an eval."""

from pathlib import Path

from operonx.app import Application, Eval, Service, http
from operonx.app.jobs import Job

from main import ask_flow, mentions

HERE = Path(__file__).resolve().parent

APP = Application(
    "{name}",
    services=[
        Service("ask", http("POST", "/ask", port=8082), graph=ask_flow,
                description='POST {{"question": "..."}} — an answer and its sources.'),
    ],
    jobs=[
        Job("answer_faq", graph=ask_flow, items=HERE / "data/questions.jsonl",
            output=HERE / "out/answers.jsonl", key="id",
            description="Answer the questions in data/questions.jsonl."),
        Eval("grounded", graph=ask_flow, dataset="dataset:qa", evaluators=[mentions],
             threshold=0.75, description="Are the answers the documents' answers?"),
    ],
    trace=["trace_local:default"],
)
'''

_RAG_DOCS = {
    "docs/classes.md": "# Classes\n\nClasses run on weekday evenings from 6pm to 8pm. Each class lasts 45 minutes and "
                       "is held online.\n\nA class can be moved to another weekday evening up to 24 hours before it "
                       "starts. Moves are confirmed by SMS.\n",
    "docs/billing.md": "# Billing\n\nThe monthly fee is charged on the first day of each month. A refund is possible "
                       "within 14 days of a charge.\n\nParents can pause a subscription for up to two months a year "
                       "without paying.\n",
}
_QUESTIONS = [
    {"id": "q1", "question": "How long does a class last?"},
    {"id": "q2", "question": "When is the monthly fee charged?"},
    {"id": "q3", "question": "Can I move a class to another day?"},
]
_QA = [
    {"id": "length", "input": {"question": "How long does a class last?"}, "expected": {"mentions": ["45 minutes"]}},
    {"id": "charge", "input": {"question": "When is the monthly fee charged?"}, "expected": {"mentions": ["first day"]}},
    {"id": "move", "input": {"question": "Can a class be moved to another evening?"}, "expected": {"mentions": ["24 hours"]}},
    {"id": "pause", "input": {"question": "Can we pause the subscription?"}, "expected": {"mentions": ["two months"]}},
]


# ── a voice agent ───────────────────────────────────────────────────────────

_VOICE_MAIN = '''\
"""A voice agent to grow from: audio in, audio out, and a speech detector.

The call door takes 16 kHz 16-bit PCM in 20 ms frames (the studio's Voice
toy speaks it) and plays each frame back, so you hear what the service
hears. `hear` measures each frame and says whether it is speech. The same
detector labels recorded .wav files in a job, and an eval checks it.

To make it an agent, add resources and ops between `hear` and the reply:
speech-to-text on the utterance, an LLMOp for the answer, text-to-speech
for the audio back.
"""

import math
import struct
import wave
from pathlib import Path

from operonx.app.play import PcmCodec
from operonx.app.serve import egress, ingress
from operonx.core import END, START, graph, op

RATE = 16000
SPEECH_DB = -40.0  # a frame louder than this is speech
VOICE = PcmCodec(rate=RATE, frame_ms=20)


def level_db(pcm: bytes) -> float:
    """A frame's loudness in dBFS."""
    n = len(pcm) // 2
    if not n:
        return -120.0
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    rms = math.sqrt(sum(x * x for x in samples) / n) / 32768
    return 20 * math.log10(rms) if rms > 0 else -120.0


@op(bound="sync")
def hear(frame=None) -> dict:
    """The frame, its level, and whether it is speech."""
    db = level_db(frame or b"")
    return {"frame": frame, "db": round(db, 1), "speech": db > SPEECH_DB}


@graph
def call_flow():
    src = ingress()
    heard = hear(frame=src["item"])
    out = egress(item=heard["frame"])
    START >> src >> heard >> out >> END


@op(bound="sync")
def label_file(file: str = "") -> dict:
    """A recording's loudest 20 ms, and speech or silence."""
    file = file.get("file", "") if isinstance(file, dict) else file  # a job's item, or a case's path
    path = Path(file) if Path(file).is_absolute() else Path(__file__).parent / file
    with wave.open(str(path), "rb") as w:
        pcm = w.readframes(w.getnframes())
    step = RATE // 50 * 2
    loudest = max((level_db(pcm[i:i + step]) for i in range(0, len(pcm), step)), default=-120.0)
    return {"result": {"file": path.name, "db": round(loudest, 1), "label": "speech" if loudest > SPEECH_DB else "silence"}}


@graph
def recording_flow(file: str = ""):
    labelled = label_file(file=file)
    START >> labelled >> END


def label_matches(output=None, expected=None):
    got = (output or {}).get("result", {}).get("label")
    return {"passed": got == (expected or {}).get("label"), "reason": f"said {got}"}
'''

_VOICE_TOML = '''\
[project]
name = "{name}"
description = "A voice agent to grow from: 16 kHz audio in and back out, a speech detector, a recordings job."
app = "app:APP"

[resources]
overlay = "resources.yaml"
'''

_VOICE_APP = '''\
"""The application: the call behind a websocket, a recordings job, and an eval."""

from pathlib import Path

from operonx.app import Application, Eval, Service, websocket
from operonx.app.jobs import Job

from main import VOICE, call_flow, label_matches, recording_flow

HERE = Path(__file__).resolve().parent

APP = Application(
    "{name}",
    services=[
        Service("call", websocket("/call", port=8083), graph=call_flow, max_inflight=512,
                playground=VOICE, description="16 kHz PCM in 20 ms frames; each frame played back."),
    ],
    jobs=[
        Job("label_recordings", graph=recording_flow, items=HERE / "data/recordings.jsonl",
            output=HERE / "out/labels.jsonl", key="file", input="file",
            description="Label every recording: speech or silence."),
        Eval("detector", graph=recording_flow, dataset="dataset:recordings", evaluators=[label_matches],
             input="file", threshold=1.0, description="Does the detector hear speech where there is some?"),
    ],
    trace=["trace_local:default"],
)
'''


def _wav(path: Path, tone_hz: float, db: float, seconds: float = 0.6, rate: int = 16000) -> None:
    """A test recording: a tone at *db* dBFS (or silence below -100)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    amp = 0 if db < -100 else 32767 * 10 ** (db / 20)
    n = int(rate * seconds)
    frames = struct.pack(f"<{n}h", *(int(amp * math.sin(2 * math.pi * tone_hz * i / rate)) for i in range(n)))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)


def _voice_extra(root: Path) -> None:
    _wav(root / "data" / "hello.wav", 220, -12)
    _wav(root / "data" / "quiet_room.wav", 0, -120)
    _wav(root / "data" / "whisper.wav", 300, -30)


_RECORDINGS = [{"file": "data/hello.wav"}, {"file": "data/quiet_room.wav"}, {"file": "data/whisper.wav"}]
_RECORDING_CASES = [
    {"id": "hello", "input": "data/hello.wav", "expected": {"label": "speech"}},
    {"id": "quiet", "input": "data/quiet_room.wav", "expected": {"label": "silence"}},
    {"id": "whisper", "input": "data/whisper.wav", "expected": {"label": "speech"}},
]


# ── the catalogue ─────────────────────────────────────────────────────────

TEMPLATES: Dict[str, Dict[str, Any]] = {
    "http-api": {
        "title": "An HTTP API",
        "description": "Text in, a one-line summary and keywords out — a service, a batch job and an eval.",
        "files": {"main.py": _API_MAIN, "operonx.toml": _API_TOML, "app.py": _API_APP, "data/articles.jsonl": _jsonl(_API_DATA),
                  "datasets/examples.jsonl": _jsonl(_API_CASES)},
        "first_runs": ["quality"],
        "try": {"service": "summarize", "message": {"kind": "json", "value": {"text": _API_DATA[0]["text"]}}},
    },
    "batch-scorer": {
        "title": "A batch scorer",
        "description": "A file of reviews scored overnight, with a record per run and an eval against labels.",
        "files": {"main.py": _SCORER_MAIN, "operonx.toml": _SCORER_TOML, "app.py": _SCORER_APP, "data/reviews.jsonl": _jsonl(_REVIEWS),
                  "datasets/labelled.jsonl": _jsonl(_LABELLED)},
        "first_runs": ["score_reviews", "labels"],
        "try": {"service": "score", "message": {"kind": "json", "value": _REVIEWS[0]}},
    },
    "rag-qa": {
        "title": "A RAG question-answerer",
        "description": "Questions answered from your documents, with sources — retrieval and an answer, and an eval.",
        "files": {"main.py": _RAG_MAIN, "operonx.toml": _RAG_TOML, "app.py": _RAG_APP, **_RAG_DOCS,
                  "data/questions.jsonl": _jsonl(_QUESTIONS), "datasets/qa.jsonl": _jsonl(_QA)},
        "first_runs": ["grounded"],
        "try": {"service": "ask", "message": {"kind": "json", "value": {"question": "How long does a class last?"}}},
    },
    "voice-agent": {
        "title": "A voice agent",
        "description": "Audio in and back out over a websocket, a speech detector, and a recordings job to test it.",
        "files": {"main.py": _VOICE_MAIN, "operonx.toml": _VOICE_TOML, "app.py": _VOICE_APP,
                  "data/recordings.jsonl": _jsonl(_RECORDINGS), "datasets/recordings.jsonl": _jsonl(_RECORDING_CASES)},
        "extra": _voice_extra,
        "first_runs": ["detector"],
        "try": None,
    },
}


def describe() -> List[Dict[str, Any]]:
    return [{"id": k, "title": t["title"], "description": t["description"]} for k, t in TEMPLATES.items()]


def create(root: Path | str, template: str, name: str | None = None) -> List[Path]:
    """Write *template* into the new directory *root*; the files written."""
    if template not in TEMPLATES:
        raise TemplateError(f"no template {template!r}; one of {', '.join(TEMPLATES)}")
    root = Path(root)
    if root.exists() and any(root.iterdir()):
        raise TemplateError(f"{root} is not empty")
    name = name or root.name
    t = TEMPLATES[template]
    files = {
        **t["files"],
        "operonx.toml": t["files"]["operonx.toml"].format(name=name),
        "app.py": t["files"]["app.py"].format(name=name),
        "resources.yaml": _RESOURCES,
        "pyproject.toml": _PYPROJECT.format(dist=name.replace("_", "-"), description=t["description"], pin=OPERONX_PIN),
        ".gitignore": _GITIGNORE,
    }
    written = []
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        written.append(path)
    extra: Callable[[Path], None] | None = t.get("extra")
    if extra:
        extra(root)
    return written
