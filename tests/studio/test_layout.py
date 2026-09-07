"""Layered layout.

These assert the properties a reader depends on — edges point forward, no
node is silently dropped, and the same IR always draws the same picture —
rather than exact pixel values, which would break on any spacing tweak.
"""

from __future__ import annotations

import pytest

from operonx_studio.layout import layout_graph

pytestmark = pytest.mark.unit


def ir(nodes, edges, entries=(), exits=()):
    return {
        "nodes": [{"id": f"g.{n}", "name": n, "kind": "FuncOp"} for n in nodes],
        "edges": [
            {"from": a, "to": b, **kw} for a, b, *rest in edges for kw in (rest[0] if rest else {},)
        ],
        "entries": list(entries),
        "exits": list(exits),
    }


class TestLayering:
    def test_chain_advances_one_layer_per_hop(self):
        out = layout_graph(ir(["a", "b", "c"], [("a", "b"), ("b", "c")], entries=["a"]))
        layers = {n.name: n.layer for n in out.nodes}
        assert layers == {"a": 0, "b": 1, "c": 2}

    def test_fan_out_shares_a_layer(self):
        out = layout_graph(ir(["a", "b", "c"], [("a", "b"), ("a", "c")], entries=["a"]))
        layers = {n.name: n.layer for n in out.nodes}
        assert layers["b"] == layers["c"] == 1

    def test_diamond_uses_longest_path(self):
        """`d` must sit after `c`, not beside it — else the edge points backwards."""
        out = layout_graph(
            ir(
                ["a", "b", "c", "d"],
                [("a", "b"), ("a", "c"), ("b", "c"), ("c", "d")],
                entries=["a"],
            )
        )
        layers = {n.name: n.layer for n in out.nodes}
        assert layers["a"] < layers["b"] < layers["c"] < layers["d"]

    def test_every_edge_points_forward(self):
        out = layout_graph(
            ir(
                ["a", "b", "c", "d"],
                [("a", "b"), ("b", "d"), ("a", "c"), ("c", "d")],
                entries=["a"],
            )
        )
        depth = {n.id: n.layer for n in out.nodes}
        assert all(depth[e.src] < depth[e.dst] for e in out.edges)


class TestNothingIsDropped:
    def test_disconnected_node_is_still_placed(self):
        """A node the reader cannot see is how a diagram starts lying."""
        out = layout_graph(ir(["a", "b", "orphan"], [("a", "b")], entries=["a"]))
        assert {n.name for n in out.nodes} == {"a", "b", "orphan"}

    def test_edge_to_an_unknown_node_is_dropped_not_faked(self):
        """START/END are boundaries, not nodes — they must not become ghosts."""
        graph = ir(["a"], [("a", "b")], entries=["a"])
        out = layout_graph(graph)
        assert [n.name for n in out.nodes] == ["a"]
        assert out.edges == []

    def test_empty_graph(self):
        out = layout_graph(ir([], []))
        assert out.nodes == [] and out.edges == []


class TestEdgeSemantics:
    def test_edge_carries_origin_and_softness(self):
        out = layout_graph(
            ir(
                ["a", "b"],
                [("a", "b", {"soft": True, "origin": "auto_soft", "type": "condition"})],
                entries=["a"],
            )
        )
        edge = out.edges[0]
        assert edge.soft and edge.origin == "auto_soft" and edge.type == "condition"

    def test_non_advancing_edge_is_marked_as_a_return_path(self):
        """Drawn as a loop rather than a stray line across the canvas."""
        out = layout_graph(ir(["a", "b"], [("a", "b"), ("b", "a")], entries=["a"]))
        assert any(e.back for e in out.edges)


class TestWrapping:
    def test_a_long_chain_wraps_into_bands(self):
        """Thirty ops in a row is a strip nobody can read at fit-zoom.

        Past the aspect threshold the layer sequence breaks into bands,
        like text into lines: total width shrinks, height grows, and the
        graph gains more than one distinct row of y positions."""
        from operonx_studio.layout import NODE_H, NODE_W

        names = [f"op{i:02d}" for i in range(30)]
        chain = list(zip(names, names[1:]))
        out = layout_graph(ir(names, chain, entries=[names[0]]))

        unwrapped_width = 48 * 2 + 30 * (NODE_W + 96)
        assert out.width < unwrapped_width / 2, (
            f"chain did not wrap: width {out.width} vs unwrapped {unwrapped_width}")
        rows = sorted({n.y for n in out.nodes})
        assert len(rows) >= 3, f"expected several bands, got y rows {rows}"
        # every node stays on the canvas
        assert all(n.x + NODE_W <= out.width and n.y + NODE_H <= out.height
                   for n in out.nodes)

    def test_wrapped_bands_read_left_to_right(self):
        """Reading direction never reverses at a fold — each consecutive
        layer is either one step right in the same band, or at the left
        margin of a lower band (the carriage return)."""
        names = [f"op{i:02d}" for i in range(30)]
        out = layout_graph(ir(names, list(zip(names, names[1:])), entries=[names[0]]))
        by_layer = sorted(out.nodes, key=lambda n: n.layer)
        for prev, cur in zip(by_layer, by_layer[1:]):
            if cur.y == prev.y:
                assert cur.x > prev.x, "same band must advance rightwards"
            else:
                assert cur.y > prev.y, "a fold must move down, never up"
                assert cur.x == min(n.x for n in out.nodes), "a fold restarts at the left margin"

    def test_a_short_chain_does_not_wrap(self):
        names = ["a", "b", "c", "d", "e"]
        out = layout_graph(ir(names, list(zip(names, names[1:])), entries=["a"]))
        assert len({n.y for n in out.nodes}) == 1

    def test_a_tall_graph_does_not_wrap(self):
        """Wide fan-out is not strip-shaped; wrapping it would only hurt."""
        names = [f"L{i}" for i in range(10)]
        fans = [f"f{i}" for i in range(8)]
        edges = list(zip(names, names[1:])) + [(names[0], f) for f in fans]
        out = layout_graph(ir(names + fans, edges, entries=[names[0]]))
        # a single band: one distinct column per layer, all rows anchored
        # at the same top
        assert len({n.x for n in out.nodes}) == 10
        assert len({n.y for n in out.nodes if n.order == 0}) == 1


class TestDeterminism:
    def test_same_ir_gives_the_same_picture(self):
        graph = ir(
            ["a", "b", "c", "d", "e"],
            [("a", "b"), ("a", "c"), ("b", "d"), ("c", "d"), ("d", "e")],
            entries=["a"],
        )
        first = layout_graph(graph)
        second = layout_graph(graph)
        assert [(n.id, n.x, n.y) for n in first.nodes] == [(n.id, n.x, n.y) for n in second.nodes]


class TestCanvas:
    def test_canvas_covers_every_node(self):
        out = layout_graph(
            ir(["a", "b", "c", "d"], [("a", "b"), ("a", "c"), ("a", "d")], entries=["a"])
        )
        from operonx_studio.layout import NODE_H, NODE_W

        assert all(n.x + NODE_W <= out.width and n.y + NODE_H <= out.height for n in out.nodes)

    def test_nodes_in_a_layer_do_not_overlap(self):
        out = layout_graph(
            ir(["a", "b", "c", "d"], [("a", "b"), ("a", "c"), ("a", "d")], entries=["a"])
        )
        ys = sorted(n.y for n in out.nodes if n.layer == 1)
        from operonx_studio.layout import NODE_H

        assert all(b - a >= NODE_H for a, b in zip(ys, ys[1:]))
