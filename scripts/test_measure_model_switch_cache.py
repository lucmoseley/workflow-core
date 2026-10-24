"""Tests for scripts/measure_model_switch_cache.py — the parsing seam.

The script's claims (mantahostels#1092) rest entirely on three judgements about a transcript
line: which turns count, which turns are the same turn repeated, and which
model change is a real switch rather than two spellings of one model. Those are
what is tested here. The dollar arithmetic in
https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/opusplan-model-switch-cache.md is done by hand and is not this
script's output.

The corpus these run against is fixtures, never the machine's real transcripts:
a test asserting a figure from a live, still-growing corpus would go red on its
own.

The script is a measurement a session runs by hand: loosen a case and it reports
a cache discard that never happened, or hides one, and the model-switch choice
mantahostels#1092 rests on is priced off a wrong count.
"""

import json
from collections import Counter

import measure_model_switch_cache as m


def write_transcript(tmp_path, entries, name="session.jsonl"):
    path = tmp_path / name
    path.write_text("\n".join(entries if isinstance(entries, list) else [entries]))
    return str(path)


def turn(model, *, ident="m1", read=0, write=0, out=1):
    return json.dumps(
        {
            "timestamp": "2026-08-22T00:00:00Z",
            "message": {
                "role": "assistant",
                "id": ident,
                "model": model,
                "usage": {
                    "cache_read_input_tokens": read,
                    "cache_creation_input_tokens": write,
                    "output_tokens": out,
                },
            },
        }
    )


def test_reads_assistant_turns_with_their_cache_counters(tmp_path):
    path = write_transcript(tmp_path, [turn("claude-opus-5", read=80_000, write=1_000)])
    assert m.turns(path, Counter()) == [
        {
            "ts": "2026-08-22T00:00:00Z",
            "model": "claude-opus-5",
            "read": 80_000,
            "write": 1_000,
        }
    ]


def test_drops_synthetic_modelless_and_non_assistant_turns(tmp_path):
    path = write_transcript(
        tmp_path,
        [
            turn("<synthetic>"),
            json.dumps({"message": {"role": "assistant", "id": "x", "usage": {}}}),
            json.dumps({"message": {"role": "user", "content": "hi"}}),
            turn("claude-opus-5"),
        ],
    )
    assert [t["model"] for t in m.turns(path, Counter())] == ["claude-opus-5"]


def test_survives_a_half_written_or_non_object_line(tmp_path):
    """A transcript is being appended to while this runs, so the last line may be
    partial — and a line may legally be a bare JSON value rather than an object."""
    path = write_transcript(
        tmp_path,
        [
            turn("claude-opus-5", ident="a"),
            '{"message": {"role": "assis',
            '"a bare string"',
            "123",
            "[]",
            turn("claude-sonnet-5", ident="b"),
        ],
    )
    assert [t["model"] for t in m.turns(path, Counter())] == [
        "claude-opus-5",
        "claude-sonnet-5",
    ]


def test_returns_empty_rather_than_raising_on_an_unreadable_file(tmp_path):
    tally = Counter()
    assert m.turns(str(tmp_path / "rotated-away.jsonl"), tally) == []
    assert tally["unreadable files"] == 1


def test_one_message_repeated_across_content_blocks_counts_once(tmp_path):
    path = write_transcript(
        tmp_path,
        [
            turn("claude-opus-5", ident="a", read=80_000, write=5, out=7),
            turn("claude-opus-5", ident="a", read=80_000, write=5, out=7),
            turn("claude-opus-5", ident="a", read=80_000, write=9, out=7),
        ],
    )
    assert len(m.turns(path, Counter())) == 2


def test_a_model_change_is_a_switch_carrying_the_turns_either_side():
    seq = [
        {"model": "claude-opus-5", "read": 80_000, "write": 1_000},
        {"model": "claude-sonnet-5", "read": 0, "write": 82_000},
        {"model": "claude-sonnet-5", "read": 82_000, "write": 400},
    ]
    events = m.switches(seq)
    assert len(events) == 1
    assert events[0]["index"] == 1
    assert events[0]["prev"]["model"] == "claude-opus-5"
    assert events[0]["switch"]["write"] == 82_000
    assert events[0]["next"]["read"] == 82_000
    assert events[0]["alias_boundary"] is False


def test_an_alias_and_a_full_id_for_one_model_are_not_a_switch():
    assert m.is_alias_boundary("opus", "claude-opus-5") is True
    assert m.is_alias_boundary("claude-opus-5", "claude-sonnet-5") is False
    assert m.is_alias_boundary("claude-opus-4-7", "claude-opus-5") is False
    assert (
        m.switches([{"model": "sonnet"}, {"model": "claude-sonnet-5"}])[0][
            "alias_boundary"
        ]
        is True
    )


def test_reconciles_when_the_next_turn_reads_the_write_plus_the_switch_own_read():
    event = {
        "switch": {"read": 5_142, "write": 16_696},
        "next": {"read": 21_838},
    }
    assert m.reconciles(event) is True
    event["next"] = {"read": 16_696}
    assert m.reconciles(event) is False
    assert m.reconciles({"switch": {"read": 0, "write": 1}, "next": None}) is None


def test_the_default_corpus_spans_every_seat_root(seat_roots):
    roots = seat_roots(2)
    (roots[0] / "a.jsonl").write_text("")
    (roots[1] / "b" / "subagents").mkdir(parents=True)
    (roots[1] / "b" / "subagents" / "agent-x.jsonl").write_text("")
    assert m.corpus() == [
        (str(roots[0] / "a.jsonl"), "session"),
        (str(roots[1] / "b" / "subagents" / "agent-x.jsonl"), "subagent"),
    ]
