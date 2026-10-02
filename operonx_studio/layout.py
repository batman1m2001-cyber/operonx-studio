"""Layered DAG layout for a Project IR graph — top-down.

Layout lives in Python rather than the browser for three reasons: it is
deterministic (the same IR always draws the same picture, so a screenshot
diff means something), it is testable without a headless browser, and it
keeps the rendered page a thin view rather than a second implementation.

The algorithm is Sugiyama's, minus the parts that do not pay for themselves
at operonx's graph sizes:

1. **Layer** by longest path from the entry set, so every edge points
   forward, then *tighten*: an op feeding more than it reads sinks toward
   its consumers, so an edge never spans more rows than it has to.
2. **Dummies**: every edge spanning more than one row gets a lane-holder
   in each row it passes, so it owns a lane between the cards instead of
   threading through them. The tie from an exit into END gets one too.
3. **Order** each row (cards and lanes) by barycentre sweeps plus
   adjacent swaps (transpose), keeping the order with fewest crossings.
4. **Place**: a layer is a ROW and time flows down; x is solved per row
   by weighted isotonic regression (each node pulled toward its
   neighbours, lanes pulled hardest, minimum spacing kept), so chains
   and lanes run plumb and siblings spread symmetrically.

Each edge carries its lanes (``via``) out of here: the canvas draws it as
one smooth curve through them. Placement made the path easy, so the
drawing never has to dodge anything.

Vertical is sequence, horizontal is simultaneity: branch targets and
parallel fan-outs share a row, which is what they mean. Rows are centred,
so a mostly-sequential flow reads as a spine down the middle with
branches fanning symmetrically — a flowchart. This orientation is also
why there is no band-wrapping machinery here any more: a long sequential
chain stacks into a tall, naturally-scrollable column instead of a strip
the width of a football pitch.

Back-edges are excluded from layering — a cycle has already been rewritten
into a hidden loop by the time we see it, and the surviving record lives in
``rewritten_from``. Drawing one as a forward edge would put a node in a
layer that contradicts the loop boundary it belongs to.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

__all__ = ["Node", "Edge", "Layout", "layout_graph", "NODE_W", "NODE_H"]

NODE_W = 260
NODE_H = 64
H_GAP = 56      # between siblings in a row — things that happen together
V_GAP = 78      # between rows — one step of sequence
MARGIN = 48
# A lane (an edge passing a row) keeps clear of the cards beside it: the
# canvas may widen a card up to 25 px each side about its centre, and a
# wire has a glow. Lanes side by side sit closer — they are only wires.
LANE_GAP = 46   # card edge -> lane centre
LANE_SEP = 26   # lane centre -> lane centre

_SWEEPS = 8
_END = "__end__"


@dataclass
class Node:
    """One placed node."""

    id: str
    name: str
    kind: str
    layer: int = 0
    order: int = 0
    x: float = 0.0
    y: float = 0.0
    meta: Dict = field(default_factory=dict)


@dataclass
class Edge:
    """One placed edge, carrying why it looks the way it does."""

    src: str
    dst: str
    type: str = "normal"
    soft: bool = False
    origin: str = "authored"
    back: bool = False
    # Edges are keyed by ``id``, never by (src, dst): a branch whose
    # conditions share a target carries one edge PER ROUTE between the
    # same pair, each with its own id, route index and condition label.
    id: str = ""
    kind: str = ""
    route: Optional[int] = None
    label: Optional[str] = None
    # the lanes this edge passes through, one per row between its ends:
    # [{"x": lane centre, "layer": row}] — empty for a one-row hop
    via: List[Dict] = field(default_factory=list)


@dataclass
class Layout:
    nodes: List[Node]
    edges: List[Edge]
    width: float
    height: float
    # exit op id -> the lanes its tie into END passes (rows below it)
    ties: Dict[str, List[Dict]] = field(default_factory=dict)

    @property
    def by_id(self) -> Dict[str, Node]:
        return {n.id: n for n in self.nodes}


def _find_back_edges(ids: Sequence[str], forward: Dict[str, List[str]]) -> Set[Tuple[str, str]]:
    """DFS-colour back-edge detection, mirroring the compiler's own.

    A cycle reaching the renderer is either a graph built with
    ``strict_dag`` or a lookback edge the rewrite deliberately left alone.
    Either way it must not drive layering: longest-path over a cycle does
    not terminate, and a cyclic edge has no forward layer to advance to.
    """
    WHITE, GREY, BLACK = 0, 1, 2
    colour = {i: WHITE for i in ids}
    back: Set[Tuple[str, str]] = set()

    for root in ids:
        if colour[root] != WHITE:
            continue
        stack: List[Tuple[str, int]] = [(root, 0)]
        while stack:
            node, index = stack.pop()
            if index == 0:
                colour[node] = GREY
            neighbours = forward.get(node, [])
            if index < len(neighbours):
                stack.append((node, index + 1))
                nxt = neighbours[index]
                if colour.get(nxt) == GREY:
                    back.add((node, nxt))
                elif colour.get(nxt) == WHITE:
                    stack.append((nxt, 0))
            else:
                colour[node] = BLACK
    return back


def _layer_nodes(
    ids: Sequence[str], forward: Dict[str, List[str]], entries: Sequence[str]
) -> Dict[str, int]:
    """Longest-path layering, so no edge ever points backwards.

    Nodes unreachable from an entry (a disconnected fragment, or an
    ``EmitOp`` wired only to an exit) still get placed — they land in layer
    0 rather than vanishing, since a node the reader cannot see is exactly
    the failure mode that makes a diagram lie.
    """
    layer = {i: 0 for i in ids}
    indegree = {i: 0 for i in ids}
    for src, dsts in forward.items():
        for dst in dsts:
            if dst in indegree:
                indegree[dst] += 1

    roots = [i for i in ids if indegree.get(i, 0) == 0] or list(entries) or list(ids[:1])
    # Relax layers until they settle. Bounded by len(ids) because each pass
    # can only push a node at least one layer deeper along an acyclic graph,
    # so this terminates even if the caller hands us something odd.
    frontier = list(roots)
    for _ in range(len(ids) + 1):
        if not frontier:
            break
        nxt_frontier: List[str] = []
        for node in frontier:
            for nxt in forward.get(node, []):
                if nxt in layer and layer[nxt] < layer[node] + 1:
                    layer[nxt] = layer[node] + 1
                    nxt_frontier.append(nxt)
        frontier = nxt_frontier
    return layer


def _tighten(
    ids: Sequence[str],
    forward: Dict[str, List[str]],
    backward: Dict[str, List[str]],
    layer: Dict[str, int],
    pinned: Set[str],
) -> None:
    """Shorten long edges: longest-path puts every op as HIGH as it can go,
    so an op that only feeds something far below (a lookup whose single
    consumer sits rows down) leaves a long wire under it. Sinking such an
    op toward its consumers shortens its out-edges by more than it
    lengthens its in-edges whenever it feeds more edges than it reads —
    the network-simplex move, done greedily until nothing improves.
    Entries stay on the top row, where START reaches them."""
    for _ in range(4 * len(ids) + 4):
        moved = False
        for n in ids:
            if n in pinned:
                continue
            succ = [layer[s] for s in forward.get(n, []) if s in layer]
            if not succ or len(succ) <= len(backward.get(n, [])):
                continue
            lim = min(succ) - 1
            if lim > layer[n]:
                layer[n] = lim
                moved = True
        if not moved:
            break
    # renumber densely: a sunk op may have emptied a row
    used = sorted(set(layer.values()))
    remap = {d: i for i, d in enumerate(used)}
    for n in layer:
        layer[n] = remap[layer[n]]


def _crossings(
    upper: List[str], lower: List[str], down: Dict[str, List[str]]
) -> int:
    """Edge crossings between two adjacent rows (each pair counted once)."""
    pos = {v: i for i, v in enumerate(lower)}
    ends: List[Tuple[int, int]] = []
    for i, u in enumerate(upper):
        for v in down.get(u, []):
            if v in pos:
                ends.append((i, pos[v]))
    ends.sort()
    count = 0
    for k, (a1, b1) in enumerate(ends):
        for a2, b2 in ends[k + 1:]:
            if a2 > a1 and b2 < b1:
                count += 1
    return count


def _total_crossings(rows: List[List[str]], down: Dict[str, List[str]]) -> int:
    return sum(_crossings(rows[i], rows[i + 1], down) for i in range(len(rows) - 1))


def _pair_cost(u: str, v: str, neigh: Dict[str, List[str]], pos: Dict[str, int]) -> int:
    """Crossings among u's and v's edges into one adjacent row, u left of v."""
    pu = [pos[x] for x in neigh.get(u, []) if x in pos]
    pv = [pos[x] for x in neigh.get(v, []) if x in pos]
    return sum(1 for a in pu for b in pv if a > b)


def _order(
    rows: List[List[str]], up: Dict[str, List[str]], down: Dict[str, List[str]]
) -> List[List[str]]:
    """Barycentre sweeps + transpose, keeping the best order seen.

    Ties keep their previous position (a stable sort), and the start
    order is IR order, so the result is the same run to run."""

    def sweep(downward: bool) -> None:
        idx = range(1, len(rows)) if downward else range(len(rows) - 2, -1, -1)
        for d in idx:
            ref = rows[d - 1] if downward else rows[d + 1]
            neigh = up if downward else down
            pos = {v: i for i, v in enumerate(ref)}
            cur = {v: i for i, v in enumerate(rows[d])}

            def key(v: str) -> float:
                linked = [pos[p] for p in neigh.get(v, []) if p in pos]
                if not linked:
                    return float(cur[v])
                return sum(linked) / len(linked)

            rows[d] = sorted(rows[d], key=lambda v: (key(v), cur[v]))

    def transpose() -> None:
        for _ in range(8):
            improved = False
            for d, row in enumerate(rows):
                above = {v: i for i, v in enumerate(rows[d - 1])} if d > 0 else {}
                below = {v: i for i, v in enumerate(rows[d + 1])} if d + 1 < len(rows) else {}
                for i in range(len(row) - 1):
                    u, v = row[i], row[i + 1]
                    now = _pair_cost(u, v, up, above) + _pair_cost(u, v, down, below)
                    swapped = _pair_cost(v, u, up, above) + _pair_cost(v, u, down, below)
                    if swapped < now:
                        row[i], row[i + 1] = v, u
                        improved = True
            if not improved:
                break

    best = [list(r) for r in rows]
    best_c = _total_crossings(rows, down)
    for it in range(_SWEEPS):
        sweep(it % 2 == 0)
        transpose()
        c = _total_crossings(rows, down)
        if c < best_c:
            best, best_c = [list(r) for r in rows], c
        if best_c == 0:
            break
    return best


def _isotonic(desired: List[float], weight: List[float], seps: List[float]) -> List[float]:
    """Positions nearest (weighted least squares) to ``desired`` with every
    neighbour at least its ``seps`` apart, order kept — pool-adjacent-
    violators on the offset-free problem. A cluster of crowding nodes
    settles centred on its members' weighted wishes."""
    offs = [0.0]
    for s in seps:
        offs.append(offs[-1] + s)
    blocks: List[List[float]] = []   # [weighted sum, weight, count]
    for d, w, o in zip(desired, weight, offs):
        blocks.append([(d - o) * w, w, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            b = blocks.pop()
            blocks[-1][0] += b[0]
            blocks[-1][1] += b[1]
            blocks[-1][2] += b[2]
    out: List[float] = []
    for s, w, n in blocks:
        out.extend([s / w] * int(n))
    return [y + o for y, o in zip(out, offs)]


def layout_graph(graph: Dict) -> Layout:
    """Place one IR graph's nodes and edges in rows, with lanes for long edges."""
    ir_nodes = graph.get("nodes") or []
    ids = [n["id"] for n in ir_nodes]
    short = {n["id"]: n["name"] for n in ir_nodes}
    by_name = {n["name"]: n["id"] for n in ir_nodes}

    def resolve(ref: str) -> str:
        """IR edges use short names; nodes carry full names."""
        return by_name.get(ref, ref)

    edges: List[Edge] = []
    seen_ids: Set[str] = set()
    for e in graph.get("edges") or []:
        src, dst = resolve(e["from"]), resolve(e["to"])
        if src not in short or dst not in short:
            continue
        # An IR without ids (older extractions) keys by the pair; a clash
        # (two records claiming one id) gets a suffix rather than merging,
        # so an edge never silently disappears here.
        eid = str(e.get("id") or f"{e['from']}->{e['to']}")
        base, n = eid, 1
        while eid in seen_ids:
            n += 1
            eid = f"{base}~{n}"
        seen_ids.add(eid)
        route = e.get("route")
        edges.append(
            Edge(
                src=src,
                dst=dst,
                type=e.get("type", "normal"),
                soft=bool(e.get("soft")),
                origin=e.get("origin", "authored"),
                id=eid,
                kind=e.get("kind") or "",
                route=route if isinstance(route, int) else None,
                label=e.get("label"),
            )
        )

    forward: Dict[str, List[str]] = {i: [] for i in ids}
    backward: Dict[str, List[str]] = {i: [] for i in ids}
    for e in edges:
        # An edge the author wrote as a loop return (origin "back_edge",
        # reconstructed from the compiler's cycle rewrite) never joins the
        # forward structure at all. DFS below would otherwise rediscover
        # the cycle and pick whichever edge ITS traversal closed on — for
        # `s >> g` then `g >> s` it blamed `s >> g`, laying the loop out
        # backwards with the author's forward edge drawn as the return.
        # The author already said which edge goes back; believe them.
        if e.origin == "back_edge":
            continue
        # Parallel edges (one per branch route) are ONE adjacency for
        # layering and ordering: three routes into the same op must not
        # pull it three times as hard in the barycentre sweeps.
        if e.dst in forward[e.src]:
            continue
        forward[e.src].append(e.dst)
        backward[e.dst].append(e.src)

    # Any cycle still present was not authored as one — a lookback edge the
    # rewrite deliberately left alone. It cannot drive layering either.
    cyclic = _find_back_edges(ids, forward)
    acyclic: Dict[str, List[str]] = {
        src: [d for d in dsts if (src, d) not in cyclic] for src, dsts in forward.items()
    }
    acyclic_back: Dict[str, List[str]] = {i: [] for i in ids}
    for src, dsts in acyclic.items():
        for d in dsts:
            acyclic_back[d].append(src)

    entries = [resolve(n) for n in (graph.get("entries") or [])]
    depth_of = _layer_nodes(ids, acyclic, entries)
    _tighten(ids, acyclic, acyclic_back, depth_of, set(entries))

    # ── the virtual graph: real nodes, lane-holders, and END ─────────
    # Every forward edge spanning k > 1 rows becomes a chain through k-1
    # lane-holders (one chain per PAIR: the routes of one branch into one
    # target share it, and the canvas spreads them a few px apart). The
    # exits' ties into END get chains too, so a router high up the flow
    # whose route ends the graph has a lane down past everything below.
    exits = {resolve(x) for x in (graph.get("exits") or [])}
    tie_srcs = [n["id"] for n in ir_nodes if n.get("end") or n["id"] in exits]
    last = max(depth_of.values(), default=0)
    vlayer: Dict[str, int] = dict(depth_of)
    up: Dict[str, List[str]] = {i: [] for i in ids}
    down: Dict[str, List[str]] = {i: [] for i in ids}
    chains: Dict[Tuple[str, str], List[str]] = {}

    def link(a: str, b: str) -> None:
        down[a].append(b)
        up[b].append(a)

    def chain(src: str, dst: str, key: str) -> List[str]:
        lo, hi = vlayer[src], vlayer[dst]
        prev, made = src, []
        for d in range(lo + 1, hi):
            v = f"~{key}|{d}"
            vlayer[v] = d
            up[v], down[v] = [], []
            link(prev, v)
            prev = v
            made.append(v)
        link(prev, dst)
        return made

    for src in ids:
        for dst in acyclic[src]:
            chains[(src, dst)] = chain(src, dst, f"{src}>{dst}")
    if tie_srcs and ids:
        vlayer[_END] = last + 1
        up[_END], down[_END] = [], []
        for src in tie_srcs:
            chains[(src, _END)] = chain(src, _END, f"{src}>END")

    rows: List[List[str]] = [[] for _ in range(max(vlayer.values(), default=-1) + 1)]
    for v in ids:                       # IR order first: deterministic seed
        rows[vlayer[v]].append(v)
    for (src, dst), vs in chains.items():
        for v in vs:
            rows[vlayer[v]].append(v)
    if _END in vlayer:
        rows[vlayer[_END]].append(_END)
    rows = _order(rows, up, down)

    # A decision card's wires leave their condition rows top-to-bottom
    # and fan to both sides. They can only NEST (never cross) when each
    # side puts its earlier conditions farther out: on the left that is
    # plain route order, but on the right it is the mirror — the first
    # right-going condition must sit farthest right. So keep the left
    # half of a fan in route order and reverse the right half.
    for raw in ir_nodes:
        routes = raw.get("routes") or []
        targets: List[str] = []
        for r in routes:
            t = resolve(r.get("target", ""))
            if t in depth_of and t not in targets:
                targets.append(t)
        if len(targets) < 3 or len({depth_of[t] for t in targets}) != 1:
            continue
        row = rows[depth_of[targets[0]]]
        group = set(targets)
        slots = [i for i, nid in enumerate(row) if nid in group]
        if len(slots) != len(targets):
            continue
        mid = (len(targets) + 1) // 2
        arranged = targets[:mid] + targets[mid:][::-1]
        for slot, nid in zip(slots, arranged):
            row[slot] = nid

    # ── x: every row pulled toward its neighbours, spacing kept ──────
    real = set(ids)

    def sep(a: str, b: str) -> float:
        ra, rb = a in real, b in real
        if ra and rb:
            return NODE_W + H_GAP
        if ra or rb:
            return NODE_W / 2 + LANE_GAP
        return LANE_SEP

    def weight(v: str) -> float:
        # a lane wants to run plumb far more than a card wants to sit
        # exactly under its parents; a card on a plain chain wants it too
        if v not in real:
            return 6.0
        if len(up.get(v, [])) == 1 and len(down.get(v, [])) <= 1:
            return 2.0
        return 1.0

    xs: Dict[str, float] = {}
    for row in rows:
        acc = 0.0
        for i, v in enumerate(row):
            if i:
                acc += sep(row[i - 1], v)
            xs[v] = acc
        mid = acc / 2
        for v in row:
            xs[v] -= mid

    def place(order: Sequence[int], neigh_of) -> None:
        for d in order:
            row = rows[d]
            desired = []
            for v in row:
                links = [xs[p] for p in neigh_of(v)]
                desired.append(sum(links) / len(links) if links else xs[v])
            seps = [sep(row[i], row[i + 1]) for i in range(len(row) - 1)]
            for v, x in zip(row, _isotonic(desired, [weight(v) for v in row], seps)):
                xs[v] = x

    downs = list(range(len(rows)))
    ups = list(reversed(downs))
    both = lambda v: up.get(v, []) + down.get(v, [])  # noqa: E731
    for _ in range(3):
        place(downs, lambda v: up.get(v, []))
        place(ups, lambda v: down.get(v, []))
    for _ in range(3):
        place(downs, both)
        place(ups, both)

    # ── straighten: a 1-to-1 run (an op whose only consumer reads only
    # it, and every lane of a long edge) is one plumb column whenever its
    # rows have room. Each run tries its members' own x's, median first,
    # and takes the first that fits between its neighbours in every row
    # — sliding inside a free gap never reorders or crowds anything.
    pos_in_row = {v: (d, i) for d, row in enumerate(rows) for i, v in enumerate(row)}

    def one_to_one(u: str, v: str) -> bool:
        return down.get(u) == [v] and up.get(v) == [u]

    runs: List[List[str]] = []
    for row in rows:
        for v in row:
            ups_ = up.get(v, [])
            if len(ups_) == 1 and one_to_one(ups_[0], v):
                continue                  # not the head of its run
            run = [v]
            while len(down.get(run[-1], [])) == 1 and one_to_one(run[-1], down[run[-1]][0]):
                run.append(down[run[-1]][0])
            if len(run) > 1:
                runs.append(run)
    runs.sort(key=lambda r: -len(r))

    def room(v: str, x: float) -> bool:
        d, i = pos_in_row[v]
        row = rows[d]
        if i > 0 and x - xs[row[i - 1]] < sep(row[i - 1], v) - 0.01:
            return False
        if i + 1 < len(row) and xs[row[i + 1]] - x < sep(v, row[i + 1]) - 0.01:
            return False
        return True

    for _ in range(2):
        for run in runs:
            # a card's own x first (where its fan put it), then the lanes'
            own = sorted({xs[v] for v in run if v in real}) or sorted({xs[v] for v in run})
            med = own[len(own) // 2]
            cands = sorted({xs[v] for v in run}, key=lambda c: (c not in own, abs(c - med), c))
            for c in cands:
                if all(room(v, c) for v in run):
                    for v in run:
                        xs[v] = c
                    break

    # a run that cannot stand plumb end to end still loses its jogs
    # where it can: each lane steps onto its neighbour's x when its own
    # row has room (down the run, then up)
    for run in runs:
        for seq in (run, run[::-1]):
            for a, b in zip(seq, seq[1:]):
                if b not in real and xs[b] != xs[a] and room(b, xs[a]):
                    xs[b] = xs[a]

    # left edge of everything (cards and lanes) at the margin; END is not
    # drawn from here (the canvas puts it under the exits), so it does
    # not count
    lefts = [xs[v] - (NODE_W / 2 if v in real else 0) for v in xs if v != _END]
    shift = MARGIN - min(lefts) if lefts else 0.0
    for v in xs:
        xs[v] = round(xs[v] + shift, 1)

    pitch = NODE_H + V_GAP
    nodes: List[Node] = []
    ir_by_id = {n["id"]: n for n in ir_nodes}
    for depth, row in enumerate(rows):
        order = 0
        for node_id in row:
            if node_id not in real:
                continue
            raw = ir_by_id[node_id]
            nodes.append(
                Node(
                    id=node_id,
                    name=raw["name"],
                    kind=raw.get("kind", "Op"),
                    layer=depth,
                    order=order,
                    x=xs[node_id] - NODE_W / 2,
                    y=float(MARGIN + depth * pitch),
                    meta=raw,
                )
            )
            order += 1

    def lanes(vs: List[str]) -> List[Dict]:
        return [{"x": xs[v], "layer": vlayer[v]} for v in vs]

    # An edge that does not advance a layer is drawn as a return path rather
    # than a straight line, so it reads as a loop instead of a stray arrow.
    for e in edges:
        e.back = (e.origin == "back_edge"
                  or depth_of.get(e.dst, 0) <= depth_of.get(e.src, 0))
        if not e.back:
            e.via = lanes(chains.get((e.src, e.dst), []))
    ties = {src: lanes(chains.get((src, _END), [])) for src in tie_srcs}

    rights = [xs[v] + (NODE_W / 2 if v in real else 0) for v in xs if v != _END]
    width = (max(rights) if rights else MARGIN) + MARGIN
    height = (MARGIN + (last + 1) * pitch - V_GAP if nodes else 0) + MARGIN
    return Layout(nodes=nodes, edges=edges, width=width, height=height, ties=ties)
