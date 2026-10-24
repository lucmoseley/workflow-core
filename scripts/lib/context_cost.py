"""context_cost.py — the Opus-list pricing of a window's whole spend and of
bytes re-read from context, the two sides of each delivery-cost scanner's ratio,
priced from one table so the sides cannot drift apart (#1298).
"""

from collections import Counter

import transcript_corpus as tc

# Opus 5 API list ratios, per Mtok — the analytical weighting mantahostels#1081 uses.
_PRICE = {"fresh": 15.0, "output": 75.0, "cache_write": 18.75, "cache_read": 1.50}
# The common rule of thumb, a guess: bytes per token was never measured on this
# corpus.
_BYTES_PER_TOKEN = 4.0
# Subagent fan-out's share of all spend, per mantahostels#1121's method correction —
# https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/burn-measurement-method-correction.md.
_FANOUT_SHARE = 0.200


def window_cost(start, end, tally):
    """Opus-list cost-equivalent of every parent turn in the window, its skips
    counted into `tally`."""
    seen, tot = set(), Counter()
    for fp in tc.main_transcripts():
        for r in tc.records(fp, tally, needle='"usage"'):
            if not (start <= r.get("timestamp", "")[:10] <= end):
                continue
            m = r.get("message") or {}
            u = m.get("usage") or {}
            key = (
                m.get("id"),
                u.get("output_tokens"),
                u.get("cache_creation_input_tokens"),
            )
            if m.get("id") and key in seen:
                continue
            seen.add(key)
            tot["fresh"] += u.get("input_tokens", 0) or 0
            tot["output"] += u.get("output_tokens", 0) or 0
            tot["cache_write"] += u.get("cache_creation_input_tokens", 0) or 0
            tot["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
    return sum(tot[k] / 1e6 * _PRICE[k] for k in _PRICE)


def grossed_up(parent_cost):
    """`window_cost`'s parent-only figure scaled to all spend, fan-out
    included."""
    return parent_cost / (1 - _FANOUT_SHARE)


def price(byte_turns):
    """Cache-read cost of `byte_turns` bytes re-read, one per later turn."""
    return byte_turns / _BYTES_PER_TOKEN / 1e6 * _PRICE["cache_read"]
