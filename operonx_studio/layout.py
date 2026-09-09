"""Layered DAG layout for a Project IR graph.

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
3. **Place** on a fixed grid.

Back-edges are excluded from layering — a cycle has already been rewritten
into a hidden loop by the time we see it, and the surviving record lives in
``rewritten_from``. Drawing one as a forward edge would put a node in a
layer that contradicts the loop boundary it belongs to.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Sequence, Set, Tuple

__all__ = ["Node", "Edge", "Layout", "layout_graph", "NODE_W", "NODE_H"]

NODE_W = 210
NODE_H = 64
H_GAP = 96
V_GAP = 34
MARGIN = 48
BAND_GAP = 110

_SWEEPS = 6

# A pipeline of thirty ops laid out strictly left-to-right is a strip the
# height of one node and the width of a football pitch: fit-to-view zooms
# until every label is illegible. Past this width-to-height ratio the
# layer sequence wraps into bands, like text wraps into lines.
_WRAP_ASPECT = 3.2
_TARGET_ASPECT = 2.0
_MIN_WRAP_LAYERS = 8


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


def _band_split(depths: Sequence[int], rows_at: Dict[int, int]) -> List[List[int]]:
    """Group consecutive layers into bands so a long chain wraps.

    Reading direction never reverses — every band runs left-to-right and
    the seam edge routes down to the next band, the way a line of text
    breaks. A graph that is not strip-shaped comes back as a single band
    and lays out exactly as before.
    """
    depths = list(depths)
    count = len(depths)
    if count < _MIN_WRAP_LAYERS or not rows_at:
        return [depths]
    unit_w, unit_h = NODE_W + H_GAP, NODE_H + V_GAP
    full_w = count * unit_w
    full_h = max(rows_at.values()) * unit_h
    if full_w <= _WRAP_ASPECT * full_h:
        return [depths]

    best, best_score = [depths], None
    for per in range(4, count):
        bands = [depths[i:i + per] for i in range(0, count, per)]
        width = per * unit_w
        height = (sum(max(rows_at[d] for d in band) * unit_h for band in bands)
                  + (len(bands) - 1) * BAND_GAP)
        score = abs(math.log((width / height) / _TARGET_ASPECT))
        if best_score is None or score < best_score:
            best, best_score = bands, score
    return best


def _band_split(depths: Sequence[int], rows_at: Dict[int, int]) -> List[List[int]]:
    """Group consecutive layers into bands so a long chain wraps.

    Reading direction never reverses — every band runs left-to-right and
    the seam edge routes down to the next band, the way a line of text
    breaks. A graph that is not strip-shaped comes back as a single band
    and lays out exactly as before.
    """
    depths = list(depths)
    count = len(depths)
    if count < _MIN_WRAP_LAYERS or not rows_at:
        return [depths]
    unit_w, unit_h = NODE_W + H_GAP, NODE_H + V_GAP
    full_w = count * unit_w
    full_h = max(rows_at.values()) * unit_h
    if full_w <= _WRAP_ASPECT * full_h:
        return [depths]

    best, best_score = [depths], None
    for per in range(4, count):
        bands = [depths[i:i + per] for i in range(0, count, per)]
        width = per * unit_w
        height = (sum(max(rows_at[d] for d in band) * unit_h for band in bands)
                  + (len(bands) - 1) * BAND_GAP)
        score = abs(math.log((width / height) / _TARGET_ASPECT))
        if best_score is None or score < best_score:
            best, best_score = bands, score
    return best


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

    sorted_depths = sorted(layers)
    bands = _band_split(sorted_depths, {d: len(layers[d]) for d in sorted_depths})

    # A band gap must hold every edge routed through it, and the number
    # of those grows with the graph. Count the edges crossing each band
    # boundary and widen that gap so the renderer's lane search always
    # has room — a fixed gap re-stacks the returns the moment the flow
    # outgrows it.
    band_of_depth = {d: bi for bi, band in enumerate(bands) for d in band}
    depth_of_id = {i: depth_of[i] for i in ids}
    cuts = [0] * max(1, len(bands))
    for e in edges:
        if e.origin == "back_edge":
            continue
        src_band = band_of_depth.get(depth_of_id.get(e.src))
        dst_band = band_of_depth.get(depth_of_id.get(e.dst))
        if src_band is None or dst_band is None or src_band == dst_band:
            continue
        lo, hi = sorted((src_band, dst_band))
        for k in range(lo, hi):
            cuts[k] += 1

    depth_x: Dict[int, float] = {}
    depth_y: Dict[int, float] = {}
    y_cursor = float(MARGIN)
    last_gap = BAND_GAP
    for bi, band in enumerate(bands):
        if not band:
            continue
        for column, depth in enumerate(band):
            depth_x[depth] = MARGIN + column * (NODE_W + H_GAP)
            depth_y[depth] = y_cursor
        band_rows = max(len(layers[d]) for d in band)
        last_gap = BAND_GAP + (max(0, cuts[bi] - 3) * 14 if bi < len(cuts) else 0)
        y_cursor += band_rows * (NODE_H + V_GAP) + last_gap

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
                    x=depth_x[depth],
                    y=depth_y[depth] + order * (NODE_H + V_GAP),
                    meta=raw,
                )
            )

    # An edge that does not advance a layer is drawn as a return path rather
    # than a straight line, so it reads as a loop instead of a stray arrow.
    depth_by_id = {n.id: n.layer for n in nodes}
    for e in edges:
        e.back = (e.origin == "back_edge"
                  or depth_by_id.get(e.dst, 0) <= depth_by_id.get(e.src, 0))

    columns = max((len(band) for band in bands), default=1) if nodes else 1
    width = MARGIN * 2 + columns * (NODE_W + H_GAP)
    height = (y_cursor - last_gap if nodes else 0) + MARGIN
    return Layout(nodes=nodes, edges=edges, width=width, height=height)
