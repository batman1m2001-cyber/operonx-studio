"""Turns are named after their stream and item: `bot_prompts [1]`. A stream
that meets a sibling stream numbers its items with its name (operonx 1.21:
`[audio_in:357]`); the label still reads `audio_in [357]`."""

from operonx_studio.app import _turns_of


def _exec(op, ctx, start, is_yield=False, stream=False):
    return {"op": op, "ctx": ctx, "start_ms": start, "dur_ms": 1.0,
            "is_yield": is_yield, "_stream": stream}


def test_a_yield_names_its_turn():
    turns = _turns_of([_exec("bot_prompts", "main.[1]", 0.0, is_yield=True)])
    assert turns[0]["label"] == "bot_prompts [1]"


def test_a_named_item_reads_the_same():
    turns = _turns_of([_exec("bot_prompts", "main.[bot_prompts:1]", 0.0, is_yield=True)])
    assert turns[0]["label"] == "bot_prompts [1]"


def test_a_transient_stream_names_turns_it_did_not_record():
    turns = _turns_of([
        _exec("audio_in", "main", 0.0, stream=True),
        _exec("detect_speech", "main.[audio_in:357]", 1.0),
    ])
    assert [t["label"] for t in turns] == ["audio_in [357]"]
