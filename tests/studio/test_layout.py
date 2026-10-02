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


class TestTopDown:
    def test_time_flows_down_one_row_per_layer(self):
        """Vertical is sequence: each layer is a row, deeper = lower."""
        names = [f"op{i:02d}" for i in range(30)]
        out = layout_graph(ir(names, list(zip(names, names[1:])), entries=[names[0]]))
        by_layer = sorted(out.nodes, key=lambda n: n.layer)
        for prev, cur in zip(by_layer, by_layer[1:]):
            assert cur.y > prev.y, "a later step must sit lower"
        # a pure chain is a spine: one x for everyone, no wrapping ever
        assert len({n.x for n in out.nodes}) == 1

    def test_siblings_share_a_row_and_spread_sideways(self):
        """Horizontal is simultaneity: branch targets / parallel ops sit
        side by side on one row instead of stacking like a sequence."""
        from operonx_studio.layout import NODE_W

        out = layout_graph(
            ir(["a", "b", "c", "d"], [("a", "b"), ("a", "c"), ("a", "d")], entries=["a"])
        )
        row1 = [n for n in out.nodes if n.layer == 1]
        assert len({n.y for n in row1}) == 1, "same stage must share a row"
        xs = sorted(n.x for n in row1)
        assert all(b - a >= NODE_W for a, b in zip(xs, xs[1:]))

    def test_rows_are_centred_on_the_spine(self):
        """A lone op in a row sits centred over a wide row below it."""
        out = layout_graph(
            ir(["a", "b", "c", "d"], [("a", "b"), ("a", "c"), ("a", "d")], entries=["a"])
        )
        a = next(n for n in out.nodes if n.name == "a")
        row1 = [n for n in out.nodes if n.layer == 1]
        row_mid = (min(n.x for n in row1) + max(n.x + 210 for n in row1)) / 2
        assert abs((a.x + 105) - row_mid) < 1, "the spine must run down the middle"

    def test_long_edges_get_a_lane_in_every_row_they_pass(self):
        """An edge spanning k rows carries k-1 lanes, each clear of the
        cards in its row — the canvas draws it through them, no dodging."""
        from operonx_studio.layout import NODE_W

        names = [f"op{i:02d}" for i in range(12)]
        chain = list(zip(names, names[1:]))
        skips = [(names[i], names[8 + i % 3]) for i in range(4)]
        out = layout_graph(ir(names, chain + skips, entries=[names[0]]))
        layer = {n.id: n.layer for n in out.nodes}
        for e in out.edges:
            assert len(e.via) == max(0, layer[e.dst] - layer[e.src] - 1)
            for v in e.via:
                for n in out.nodes:
                    if n.layer == v["layer"]:
                        assert not (n.x - 20 < v["x"] < n.x + NODE_W + 20), (e.id, v, n.id)


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
        xs = sorted(n.x for n in out.nodes if n.layer == 1)
        from operonx_studio.layout import NODE_W

        assert all(b - a >= NODE_W for a, b in zip(xs, xs[1:]))


class TestParallelEdges:
    """A branch with several conditions into one target: one edge per route."""

    def _graph(self):
        graph = ir(["r", "t", "u"], [], entries=["r"])
        graph["nodes"][0]["routes"] = [
            {"condition": "a", "target": "t"},
            {"condition": "b", "target": "t"},
            {"condition": "c", "target": "t"},
            {"condition": "else", "target": "u"},
        ]
        graph["edges"] = [
            {"from": "r", "to": "t", "type": "condition", "id": f"r->t#{i}",
             "kind": "branch", "route": i, "label": c}
            for i, c in enumerate("abc")
        ] + [{"from": "r", "to": "u", "type": "condition", "id": "r->u#3",
              "kind": "branch", "route": 3, "label": "else"}]
        return graph

    def test_duplicates_survive_layout(self):
        out = layout_graph(self._graph())
        to_t = [e for e in out.edges if e.dst == "g.t"]
        assert len(to_t) == 3
        assert [e.id for e in to_t] == ["r->t#0", "r->t#1", "r->t#2"]
        assert [e.label for e in to_t] == ["a", "b", "c"]
        assert [e.route for e in to_t] == [0, 1, 2]

    def test_parallel_edges_do_not_change_the_layout(self):
        """Three routes into one op lay out exactly like one edge would."""
        many = layout_graph(self._graph())
        single = self._graph()
        single["edges"] = [single["edges"][0], single["edges"][3]]
        one = layout_graph(single)
        assert [(n.id, n.x, n.y) for n in many.nodes] == [(n.id, n.x, n.y) for n in one.nodes]
        assert many.height == one.height

    def test_edges_without_ids_get_unique_ones(self):
        out = layout_graph(ir(["a", "b"], [("a", "b"), ("a", "b")], entries=["a"]))
        assert len(out.edges) == 2 and len({e.id for e in out.edges}) == 2
