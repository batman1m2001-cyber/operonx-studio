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

    def test_row_gaps_grow_with_edge_pressure(self):
        """A gap crossed by many long edges must deepen, so the
        renderer's sideways lane search never runs out of room."""
        names = [f"op{i:02d}" for i in range(30)]
        chain = list(zip(names, names[1:]))
        plain = layout_graph(ir(names, chain, entries=[names[0]]))
        skips = [(names[i], names[25 + i % 4]) for i in range(8)]
        busy = layout_graph(ir(names, chain + skips, entries=[names[0]]))
        assert busy.height > plain.height, (
            "row gaps must deepen when more edges pass over them")


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


class TestOrdering:
    def test_rows_are_ordered_to_uncross_edges(self):
        """r fans to a, b; a feeds y and b feeds x. Listed x before y, the
        wires cross until the sweep swaps the bottom row."""
        out = layout_graph(ir(["r", "a", "b", "x", "y"],
                              [("r", "a"), ("r", "b"), ("a", "y"), ("b", "x")], entries=["r"]))
        at = {n.name: n.x for n in out.nodes}
        assert (at["a"] < at["b"]) == (at["y"] < at["x"])

    def test_a_long_edge_holds_a_gap_but_draws_no_card(self):
        """a -> c skips b's row: a dummy keeps room for it there, and only
        the three real ops are placed."""
        out = layout_graph(ir(["a", "b", "c"], [("a", "b"), ("b", "c"), ("a", "c")], entries=["a"]))
        assert sorted(n.name for n in out.nodes) == ["a", "b", "c"]
        assert out.width > 2 * 48 + 260, "the row b sits in is wider by the long edge's slot"

    def test_a_long_edge_carries_its_lane(self):
        """The dummy's x in each row it passes rides on the edge, so the
        canvas can draw the wire down the gap held open for it."""
        out = layout_graph(ir(["a", "b", "c"], [("a", "b"), ("b", "c"), ("a", "c")], entries=["a"]))
        long = next(e for e in out.edges if (e.src, e.dst) == ("g.a", "g.c"))
        b = next(n for n in out.nodes if n.name == "b")
        assert len(long.via) == 1
        assert not (b.x <= long.via[0] <= b.x + 260), "the lane runs beside b, not through it"


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


class TestLanesWithRoutes:
    """The merge of long-edge lanes (feat/canvas-edges) with one edge per
    branch route (PR #4): both must hold at once."""

    def _graph(self):
        # r routes three conditions to t, which sits two rows down (m is in
        # between), so the three route edges are long and get a lane
        graph = ir(["r", "m", "t"], [("m", "t")], entries=["r"])
        graph["nodes"][0]["routes"] = [
            {"condition": "a", "target": "t"},
            {"condition": "b", "target": "t"},
            {"condition": "c", "target": "t"},
            {"condition": "else", "target": "m"},
        ]
        graph["edges"] = [
            {"from": "r", "to": "t", "type": "condition", "id": f"r->t#{i}",
             "kind": "branch", "route": i, "label": c}
            for i, c in enumerate("abc")
        ] + [{"from": "r", "to": "m", "type": "condition", "id": "r->m#3",
              "kind": "branch", "route": 3, "label": "else"}] + graph["edges"]
        return graph

    def test_three_routes_to_one_target_stay_three_edges_after_lanes(self):
        out = layout_graph(self._graph())
        to_t = [e for e in out.edges if (e.src, e.dst) == ("g.r", "g.t")]
        assert [e.id for e in to_t] == ["r->t#0", "r->t#1", "r->t#2"]
        assert [e.label for e in to_t] == ["a", "b", "c"]
        assert [e.kind for e in to_t] == ["branch"] * 3
        # the long routes share the ONE lane the layout held open for the
        # pair (the canvas keeps them apart by route rank)
        assert all(len(e.via) == 1 for e in to_t)
        assert len({tuple(e.via) for e in to_t}) == 1

    def test_long_edge_gets_one_lane_per_row_beside_the_cards(self):
        from operonx_studio.layout import DUMMY_W, NODE_W

        # a -> e skips three rows, each holding a card of the chain b, c, d
        out = layout_graph(ir(["a", "b", "c", "d", "e"],
                              [("a", "b"), ("b", "c"), ("c", "d"), ("d", "e"), ("a", "e")],
                              entries=["a"]))
        long = next(e for e in out.edges if (e.src, e.dst) == ("g.a", "g.e"))
        layer = {n.id: n.layer for n in out.nodes}
        rows = range(layer["g.a"] + 1, layer["g.e"])
        assert len(long.via) == len(rows) == 3
        for depth, x in zip(rows, long.via):
            for n in (n for n in out.nodes if n.layer == depth):
                # the lane (its dummy's whole slot) is clear of every card in its row
                assert x + DUMMY_W / 2 <= n.x or x - DUMMY_W / 2 >= n.x + NODE_W, (depth, x, n.name)

    def test_same_ir_same_coordinates(self):
        graph = self._graph()
        runs = [layout_graph(graph)] + [layout_graph(self._graph()) for _ in range(2)]
        sig = [([(n.id, n.x, n.y) for n in r.nodes], [(e.id, e.via) for e in r.edges], r.width, r.height)
               for r in runs]
        assert sig[0] == sig[1] == sig[2]
        assert graph == self._graph(), "layout must not mutate its input"
