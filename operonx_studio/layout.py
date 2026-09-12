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
   actually removes crossings.
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

NODE_W = 210
NODE_H = 64
H_GAP = 56      # between siblings in a row — things that happen together
V_GAP = 78      # between rows — one step of sequence
MARGIN = 48

_SWEEPS = 6


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


def _order_layers(
    layers: Dict[int, List[str]],
    forward: Dict[str, List[str]],
    backward: Dict[str, List[str]],
) -> None:
    """Barycentre sweeps — the step that actually removes edge crossings.

    Each node is pulled toward the mean position of its neighbours in the
    adjacent layer, alternating down and up so both ends settle. Ties keep
    their previous position, which keeps the result stable run to run.
    """
    for sweep in range(_SWEEPS):
        downward = sweep % 2 == 0
        indices = sorted(layers)
        if not downward:
            indices = list(reversed(indices))
        for depth in indices:
            neighbours = backward if downward else forward
            positions = {n: idx for d in layers for idx, n in enumerate(layers[d]) if d != depth}
            current = {n: i for i, n in enumerate(layers[depth])}

            def barycentre(node: str) -> Tuple[float, int]:
                linked = [positions[p] for p in neighbours.get(node, []) if p in positions]
                if not linked:
                    return (float(current[node]), current[node])
                return (sum(linked) / len(linked), current[node])

            layers[depth].sort(key=barycentre)


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
    _order_layers(layers, forward, backward)

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
    slot = float(NODE_W + H_GAP)
    row_span = widest * slot - H_GAP
    xs: Dict[str, float] = {}
    for depth in sorted_depths:
        row = layers[depth]
        left = MARGIN + (row_span - (len(row) * slot - H_GAP)) / 2
        for order, node_id in enumerate(row):
            xs[node_id] = left + order * slot

    def _spread(desired: List[float]) -> List[float]:
        clusters: List[List[float]] = []   # [sum_of_desires, count]
        for d in desired:
            clusters.append([d, 1.0])
            while len(clusters) > 1:
                a, b = clusters[-2], clusters[-1]
                if b[0] / b[1] - a[0] / a[1] >= (a[1] + b[1]) * slot / 2:
                    break
                a[0] += b[0]
                a[1] += b[1]
                clusters.pop()
        out: List[float] = []
        for s, n in clusters:
            centre = s / n
            out.extend(centre + (i - (n - 1) / 2) * slot for i in range(int(n)))
        return out

    def _align(pass_depths: Sequence[int], neigh: Dict[str, List[str]]) -> None:
        for depth in pass_depths:
            row = layers[depth]
            desired = []
            for node_id in row:
                links = [xs[p] for p in neigh.get(node_id, []) if p in xs]
                desired.append(sum(links) / len(links) if links else xs[node_id])
            for node_id, x in zip(row, _spread(desired)):
                xs[node_id] = x

    _align(sorted_depths, backward)
    _align(list(reversed(sorted_depths)), forward)
    _align(sorted_depths, backward)

    if xs:
        shift = MARGIN - min(xs.values())
        for node_id in xs:
            xs[node_id] += shift

    nodes: List[Node] = []
    ir_by_id = {n["id"]: n for n in ir_nodes}
    for depth in sorted_depths:
        for order, node_id in enumerate(layers[depth]):
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

    width = (max(xs.values()) + NODE_W if xs else row_span + MARGIN) + MARGIN
    height = (y_cursor - V_GAP if nodes else 0) + MARGIN
    return Layout(nodes=nodes, edges=edges, width=width, height=height)
