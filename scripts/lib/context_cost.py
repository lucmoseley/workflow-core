from collections import Counter

import transcript_corpus as tc

_PRICE = {"fresh": 15.0, "output": 75.0, "cache_write": 18.75, "cache_read": 1.50}
# guess, #5529
_BYTES_PER_TOKEN = 4.0
# Subagent fan-out's share of all spend, per mantahostels#1121's method correction —
# https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/burn-measurement-method-correction.md.
_FANOUT_SHARE = 0.200


def window_cost(start, end, tally):
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
    return parent_cost / (1 - _FANOUT_SHARE)


def price(byte_turns):
    return byte_turns / _BYTES_PER_TOKEN / 1e6 * _PRICE["cache_read"]
