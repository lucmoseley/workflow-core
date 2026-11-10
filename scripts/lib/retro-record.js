/*
 * retro-record.js — where retro-sweep keeps its run record, one JSON line per
 * run, at a repo's root (.claude/skills/retro-sweep/SKILL.md §7). One home
 * so report-retro-due.js and the two measure-* reviews name one path (#4796).
 */

const RUN_RECORD = "docs/data/retro-runs.jsonl";

module.exports = { RUN_RECORD };
