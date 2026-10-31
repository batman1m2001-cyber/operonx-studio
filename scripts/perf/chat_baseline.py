"""What the assistant's turns cost and how fast they showed something
(docs/VISUAL_CHAT_PLAN.md V0, V7). Reads a store; never writes it.

usage: chat_baseline.py <assistant.sqlite> [--since <epoch>] [--json]

Per turn: tokens in / out / cached, LLM calls (the CLI's num_turns), time
to the first meaningful item (a tool, steps or text item after the user's
message), total time, reply characters, stored item bytes, and the fences
and callouts the replies used. Then the medians and totals.

The page's render time is measured by render_chat.py against a running
studio: it needs a browser.
"""
import argparse
import json
import re
import sqlite3
import statistics
import sys


def turns(db, since):
    rows = db.execute("select id, session, started, ended, state, usage from turns where started >= ? "
                      "and kind = 'message' order by started", (since,)).fetchall()
    for tid, sid, started, ended, state, usage in rows:
        items = db.execute("select kind, payload, text, created from items where turn = ? order by seq", (tid,)).fetchall()
        if not items:
            continue
        usage = json.loads(usage or "{}") or {}
        user_at = next((c for k, _, _, c in items if k == "user"), started)
        first = next((c for k, _, _, c in items if k in ("tool", "text")), None)
        replies = [t for k, _, t, _ in items if k == "text"]
        text = "\n".join(replies)
        end = next((json.loads(p) for k, p, _, _ in items if k == "turn_end"), {})
        tokens = end.get("tokens") or usage.get("tokens") or {}
        yield {
            "turn": tid, "session": sid, "state": state,
            "in": tokens.get("in"), "out": tokens.get("out"), "cached": tokens.get("cached"),
            "calls": usage.get("turns"),
            "first_ms": round((first - user_at) * 1000) if first else None,
            "total_ms": end.get("ms") or (round((ended - started) * 1000) if ended else None),
            "reply_chars": len(text),
            "item_bytes": sum(len(p) + len(t) for _, p, t, _ in items),
            "tools": sum(1 for k, *_ in items if k == "tool"),
            "fences": len(re.findall(r"^\s*```ox-(?:graph|chart)", text, re.M)),
            "callouts": len(re.findall(r"^\s*>\s*\[!(?:NOTE|WARNING|ERROR|SUCCESS|FINDING)\]", text, re.M)),
        }


def summary(rows):
    def med(key):
        vals = [r[key] for r in rows if r[key] is not None]
        return statistics.median(vals) if vals else None

    def total(key):
        return sum(r[key] or 0 for r in rows)

    return {"turns": len(rows), **{f"median_{k}": med(k) for k in
            ("in", "out", "calls", "first_ms", "total_ms", "reply_chars", "item_bytes", "tools")},
            **{f"total_{k}": total(k) for k in ("in", "out", "cached", "reply_chars", "item_bytes", "fences", "callouts")}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store")
    ap.add_argument("--since", type=float, default=0)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    db = sqlite3.connect(f"file:{a.store}?mode=ro", uri=True)
    rows = list(turns(db, a.since))
    if a.json:
        json.dump({"turns": rows, "summary": summary(rows)}, sys.stdout, indent=1)
        return
    cols = ("in", "out", "calls", "first_ms", "total_ms", "reply_chars", "item_bytes", "tools")
    print("turn              " + " ".join(f"{c:>11}" for c in cols))
    for r in rows:
        print(f"{r['turn']:<17} " + " ".join(f"{'' if r[c] is None else r[c]:>11}" for c in cols))
    print(json.dumps(summary(rows), indent=1))


if __name__ == "__main__":
    main()
