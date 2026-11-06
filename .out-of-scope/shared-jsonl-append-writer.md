# One shared writer for JSONL logs

This repo does not route every JSONL append through one writer that picks the log's bound (#4022).

## Why this is out of scope

A log's bound comes from what the log is for, so no single writer can choose it. The appenders in `scripts/` each have a bound that suits them:

- **Kept by count:** `test-log.js` reaps by run count, because one run's size varies widely.
- **Rotated by size:** guard error logs go through `log-rotate.js`. mantahostels#181 ruled out trimming them in place or by age.
- **Capped per session:** `hook-record.js` writes one `capped` sentinel line and then stops writing.
- **Pruned to an archive:** `test-pass-marker.js` moves pruned lines into `<store>.archive.jsonl`.
- **Unbounded on purpose:** `check-self-throttling.js` keeps its oldest readings because they are the ones it exists for. `delegated-decision.js` dedupes against the whole ledger. The verdict logs (`escape-audit.js`, `jev-trial.js`) and the overflow `capped` set are records that are read in full.

`appendRetained` prunes by age, so it would delete the records in that last group.

Revisit only if an unbounded log is measured growing fast enough to matter: give that log its own bound in its own file.
