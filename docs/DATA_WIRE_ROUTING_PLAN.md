# Data-wire routing in dense spots

Since PR #29 a clicked op draws **every** data wire. The data-flow audit
then found a few dense spots where two wires share a run. Each spot is an
opened GraphOp where several alternative branches feed stacked outputs
(sentiment `prefilter`: 4 outputs × 5 sources), or where many plates fan
into one op (`memory` → `merge`, 9 wires).

## Why local fixes kept moving the overlap

1. **The router is greedy.** Wires are laid one at a time. In a tight spot
   an early wire takes the row or column a later one needs, and that later
   wire falls back onto a shared track.
2. **No capacity check.** Nothing asks whether a region has enough rows and
   columns for the wires that must pass through it.

What was *not* a cause: zoom. The canvas then had three semantic zoom
levels (lo ≤ 0.45, mid, hi ≥ 0.85) where cards carried different content,
so the layout differed by level on purpose; the audit checks every
selection at 0.4, 0.7, 1.0 and 1.6 (`SELZ`). Since then (2026-10-08) there
is one card at every zoom, and its detail shows when it is clicked: the
layout no longer changes with zoom at all.

## Plan

1. **Rings placed before routing, with reserved lanes** (done on
   `fix/join-lanes`):
   - Each merge ring stands in a spot with room for its lanes.
   - An op's stacked outputs get their rings in one row, each with a trunk
     to its output.
   - Each lane's column is reserved for that lane alone.
   - Ring lanes keep clear of the columns beside cards, which those cards'
     own wires need.
2. **Fans into one op.** The one-jog route takes a column 3.5px from another
   (the router's existing "close but apart" tier) before it gives up and
   falls back to the long route.
3. **If a region is still short of tracks,** the layout makes room instead of
   the router squeezing (e.g. more space between a container's last op and
   its output plates).

## Result (2026-10-07)

All three steps are done, plus one geometry bug found along the way. A
sub-pixel step in a trace (two columns 0.2px apart) made the corner rounding
draw a long, slightly slanted line that lay along another wire. Points are
now snapped before rounding.

- **Step 2:** the one-jog route falls back to the 3.5px tier.
- **Step 3:** a container's plate padding now also has a column for each
  plate wire, and plate pills keep a 4px side margin (it was 10px).

## Gate

- Data-flow audit with `SELZ=0.4,0.7,1.0,1.6`: zero findings.
- `layout_audit`: zero errors.
- JS and Python tests pass.
- Draw time on the heaviest graph no worse than `main`.

**Met:**
- Data-flow audit: 1198/1198 states clean, with `SELZ=0.4,0.7,1.0,1.6`.
- `layout_audit`: 0 errors across 188 cases.
- JS tests 98/98. Pytest: 662 passed, 7 skipped.
- `drawDataLayer` on the heaviest graph (218 wires): 625 ms, against 1002 ms on `main`.
