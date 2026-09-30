"""audit.py's JSON lines as a table (stdin to stdout)."""
import json
import sys

for l in sys.stdin:
    try: d=json.loads(l)
    except: print(l.rstrip()[:300]); continue
    print(f"{d['step']:34s} {d['ms']:6d}ms req={d['requests']:3d} api={d['api']:2d} kb={d['kb']:4d}  {d['slowest'][:3]}")
