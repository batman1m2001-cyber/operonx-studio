"""The canvas gets `finals` (`END >> op`, operonx 1.20): `_placed` rebuilds
each graph for the canvas and dropped the field, so the op after END was
drawn unwired at the top instead of below END."""

from operonx_studio.app import _placed


def test_the_op_after_end_reaches_the_canvas():
    graph = {
        "name": "g",
        "entries": ["a"],
        "exits": ["a"],
        "finals": ["c"],
        "nodes": [
            {"id": "g.a", "name": "a", "kind": "FuncOp"},
            {"id": "g.c", "name": "c", "kind": "FuncOp"},
        ],
        "edges": [],
    }
    assert _placed(graph)["finals"] == ["c"]
