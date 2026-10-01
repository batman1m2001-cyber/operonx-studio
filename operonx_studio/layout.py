"""Layered DAG layout for a Project IR graph — top-down.

Layout lives in Python rather than the browser for three reasons: it is
deterministic (the same IR always draws the same picture, so a screenshot
diff means something), it is testable without a headless browser, and it
keeps the rendered page a thin view rather than a second implementation.

The algorithm is Sugiyama's, minus the parts that do not pay for themselves
at operonx's graph sizes:

1. **Layer** by longest path from the entry set, so every edge points
   forward and an edge never spans backwards.
2. **Order** within each layer by repeated barycentre sweeps, which is what
   actually removes crossings. An edge spanning several layers becomes a
   chain of narrow *dummy* nodes, one per layer it passes, so it takes part
   in the ordering like any edge and holds a gap open in every row it
   crosses; the sweep keeps the order with the fewest crossings it saw.
3. **Place** on a fixed grid: a layer is a ROW, and time flows down.

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
from typing import Dict, List, Sequence, Set, Tuple

__all__ = ["Node", "Edge", "Layout", "layout_graph", "NODE_W", "NODE_H"]

NODE_W = 260
NODE_H = 64
H_GAP = 56      # between siblings in a row — things that happen together
V_GAP = 78      # between rows — one step of sequence
MARGIN = 48

_SWEEPS = 8
DUMMY_W = 24    # a long edge's slot in a row it passes through
DUMMY_GAP = 18  # between a dummy and its neighbour


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


@dataclass
class Layout:
    nodes: List[Node]
    edges: List[Edge]
    width: float
    height: float

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


def _crossings(layers: Dict[int, List[str]], down: Dict[str, List[str]]) -> int:
    """Pairs of edges that cross between each pair of adjacent rows."""
    total = 0
    for depth in sorted(layers):
        below = layers.get(depth + 1)
        if not below:
            continue
        pos = {n: i for i, n in enumerate(below)}
        es = [(i, pos[v]) for i, u in enumerate(layers[depth]) for v in down.get(u, []) if v in pos]
        for a in range(len(es)):
            for b in range(a + 1, len(es)):
                if (es[a][0] - es[b][0]) * (es[a][1] - es[b][1]) < 0:
                    total += 1
    return total


def _order_layers(
    layers: Dict[int, List[str]],
    down: Dict[str, List[str]],
    up: Dict[str, List[str]],
) -> None:
    """Barycentre sweeps — the step that actually removes edge crossings.

    Every edge joins adjacent layers (long ones run through dummies), so
    each node is pulled toward the mean position of its neighbours in the
    row above (downward sweep) or below (upward). Ties keep their previous
    position, which keeps the result stable run to run. A sweep can make
    things worse; the order with the fewest crossings is the one kept.
    """
    best = {d: list(r) for d, r in layers.items()}
    best_count = _crossings(layers, down)
    stale = 0
    for sweep in range(_SWEEPS):
        if best_count == 0:
            break
        downward = sweep % 2 == 0
        depths = sorted(layers) if downward else sorted(layers, reverse=True)
        for depth in depths:
            ref = layers.get(depth - 1 if downward else depth + 1)
            if not ref:
                continue
            pos = {n: i for i, n in enumerate(ref)}
            neighbours = up if downward else down
            current = {n: i for i, n in enumerate(layers[depth])}

            def barycentre(node: str) -> Tuple[float, int]:
                linked = [pos[p] for p in neighbours.get(node, []) if p in pos]
                if not linked:
                    return (float(current[node]), current[node])
                return (sum(linked) / len(linked), current[node])

            layers[depth].sort(key=barycentre)
        count = _crossings(layers, down)
        if count < best_count:
            best_count, stale = count, 0
            best = {d: list(r) for d, r in layers.items()}
        else:
            stale += 1
            if stale >= 2:
                break
    for d in layers:
        layers[d] = best[d]


def layout_graph(graph: Dict) -> Layout:
    """Place one IR graph's nodes and edges on a grid."""
    ir_nodes = graph.get("nodes") or []
    ids = [n["id"] for n in ir_nodes]
    short = {n["id"]: n["name"] for n in ir_nodes}
    by_name = {n["name"]: n["id"] for n in ir_nodes}

    def resolve(ref: str) -> str:
        """IR edges use short names; nodes carry full names."""
        return by_name.get(ref, ref)

    edges: List[Edge] = []
    for e in graph.get("edges") or []:
        src, dst = resolve(e["from"]), resolve(e["to"])
        if src not in short or dst not in short:
            continue
        edges.append(
            Edge(
                src=src,
                dst=dst,
                type=e.get("type", "normal"),
                soft=bool(e.get("soft")),
                origin=e.get("origin", "authored"),
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
        forward[e.src].append(e.dst)
        backward[e.dst].append(e.src)

    # Any cycle still present was not authored as one — a lookback edge the
    # rewrite deliberately left alone. It cannot drive layering either.
    cyclic = _find_back_edges(ids, forward)
    acyclic: Dict[str, List[str]] = {
        src: [d for d in dsts if (src, d) not in cyclic] for src, dsts in forward.items()
    }

    entries = [resolve(n) for n in (graph.get("entries") or [])]
    depth_of = _layer_nodes(ids, acyclic, entries)

    layers: Dict[int, List[str]] = {}
    for node_id in ids:
        layers.setdefault(depth_of[node_id], []).append(node_id)

    # Long edges become chains of dummies, so every edge joins adjacent
    # rows: `down`/`up` are that adjacent-only structure, used to order the
    # rows and to hang each node under its neighbours.
    down: Dict[str, List[str]] = {i: [] for i in ids}
    up: Dict[str, List[str]] = {i: [] for i in ids}
    dummy_of: Dict[Tuple[str, str], List[str]] = {}
    for src, dsts in acyclic.items():
        for dst in dict.fromkeys(dsts):
            lo, hi = depth_of[src], depth_of[dst]
            if hi <= lo:
                continue
            prev = src
            chain: List[str] = []
            for d in range(lo + 1, hi):
                did = f"\0{src}\0{dst}\0{d}"
                chain.append(did)
                layers[d].append(did)
                down[did], up[did] = [], []
                down[prev].append(did)
                up[did].append(prev)
                prev = did
            down[prev].append(dst)
            up[dst].append(prev)
            if chain:
                dummy_of[(src, dst)] = chain
    is_dummy = lambda n: n.startswith("\0")  # noqa: E731
    _order_layers(layers, down, up)

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
        row = layers[depth_of[targets[0]]]
        group = set(targets)
        slots = [i for i, nid in enumerate(row) if nid in group]
        if len(slots) != len(targets):
            continue
        mid = (len(targets) + 1) // 2
        arranged = targets[:mid] + targets[mid:][::-1]
        for slot, nid in zip(slots, arranged):
            row[slot] = nid

    sorted_depths = sorted(layers)
    widest = max((len(layers[d]) for d in sorted_depths), default=1)

    # A row gap must hold every long edge routed across it, and their
    # number grows with the graph. Count the edges passing OVER each row
    # boundary (span > 1 layer) and deepen that gap so the renderer's
    # lane search always has room to jog sideways.
    depth_of_id = {i: depth_of[i] for i in ids}
    cuts: Dict[int, int] = {d: 0 for d in sorted_depths}
    for e in edges:
        if e.origin == "back_edge":
            continue
        lo_hi = (depth_of_id.get(e.src), depth_of_id.get(e.dst))
        if None in lo_hi:
            continue
        lo, hi = sorted(lo_hi)
        if hi - lo <= 1:
            continue
        for d in range(lo, hi):
            cuts[d] = cuts.get(d, 0) + 1

    depth_y: Dict[int, float] = {}
    y_cursor = float(MARGIN)
    for depth in sorted_depths:
        depth_y[depth] = y_cursor
        y_cursor += NODE_H + V_GAP + max(0, cuts.get(depth, 0) - 2) * 12

    # ── coordinate assignment: children hang under their parents ────
    # Centred slots are only the seed. Rows then align every node to
    # the mean x of its neighbours — a top-down pass under parents, a
    # bottom-up pass toward children, and a settling pass — with
    # overlaps resolved by order-preserving cluster merging that keeps
    # each cluster centred on its members' desires. A chain hangs plumb
    # under its feeder instead of snapping to the global centre; only
    # true siblings spread sideways.
    width_of = lambda n: DUMMY_W if is_dummy(n) else NODE_W  # noqa: E731

    def sep(a: str, b: str) -> float:
        gap = H_GAP if not (is_dummy(a) or is_dummy(b)) else DUMMY_GAP
        return (width_of(a) + width_of(b)) / 2 + gap

    def row_width(row: Sequence[str]) -> float:
        return sum(sep(a, b) for a, b in zip(row, row[1:])) + (
            (width_of(row[0]) + width_of(row[-1])) / 2 if row else 0)

    row_span = max((row_width(layers[d]) for d in sorted_depths), default=NODE_W)
    cx: Dict[str, float] = {}       # centres
    for depth in sorted_depths:
        row = layers[depth]
        c = MARGIN + (row_span - row_width(row)) / 2 + width_of(row[0]) / 2
        for k, node_id in enumerate(row):
            if k:
                c += sep(row[k - 1], node_id)
            cx[node_id] = c

    def _spread(row: Sequence[str], desired: List[float]) -> List[float]:
        # order-preserving cluster merging: each cluster sits where its
        # members' desires average out, packed at their minimum spacing
        clusters: List[List] = []   # [members, offsets, first centre]
        for k in range(len(row)):
            clusters.append([[k], [0.0], desired[k]])
            while len(clusters) > 1:
                a, b = clusters[-2], clusters[-1]
                need = sep(row[a[0][-1]], row[b[0][0]])
                if b[2] - (a[2] + a[1][-1]) >= need:
                    break
                base = a[1][-1] + need
                a[0] += b[0]
                a[1] += [base + o for o in b[1]]
                a[2] = sum(desired[m] - o for m, o in zip(a[0], a[1])) / len(a[0])
                clusters.pop()
        out = [0.0] * len(row)
        for members, offsets, first in clusters:
            for m, o in zip(members, offsets):
                out[m] = first + o
        return out

    def _align(pass_depths: Sequence[int], neigh: Dict[str, List[str]]) -> None:
        for depth in pass_depths:
            row = layers[depth]
            desired = []
            for node_id in row:
                links = [cx[p] for p in neigh.get(node_id, []) if p in cx]
                desired.append(sum(links) / len(links) if links else cx[node_id])
            for node_id, x in zip(row, _spread(row, desired)):
                cx[node_id] = x

    _align(sorted_depths, up)
    _align(list(reversed(sorted_depths)), down)
    _align(sorted_depths, up)

    if cx:
        shift = MARGIN - min(c - width_of(n) / 2 for n, c in cx.items())
        for node_id in cx:
            cx[node_id] += shift
    xs: Dict[str, float] = {n: cx[n] - NODE_W / 2 for n in ids}
    right = max((c + width_of(n) / 2 for n, c in cx.items()), default=row_span + MARGIN)

    nodes: List[Node] = []
    ir_by_id = {n["id"]: n for n in ir_nodes}
    for depth in sorted_depths:
        for order, node_id in enumerate(n for n in layers[depth] if not is_dummy(n)):
            raw = ir_by_id[node_id]
            nodes.append(
                Node(
                    id=node_id,
                    name=raw["name"],
                    kind=raw.get("kind", "Op"),
                    layer=depth,
                    order=order,
                    x=xs[node_id],
                    y=depth_y[depth],
                    meta=raw,
                )
            )

    # An edge that does not advance a layer is drawn as a return path rather
    # than a straight line, so it reads as a loop instead of a stray arrow.
    depth_by_id = {n.id: n.layer for n in nodes}
    for e in edges:
        e.back = (e.origin == "back_edge"
                  or depth_by_id.get(e.dst, 0) <= depth_by_id.get(e.src, 0))

    width = right + MARGIN
    height = (y_cursor - V_GAP if nodes else 0) + MARGIN
    return Layout(nodes=nodes, edges=edges, width=width, height=height)
