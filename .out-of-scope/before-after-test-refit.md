# Re-fitting the before/after test to later machinery

This repo does not bring the before/after test's task set or its design note up to date with later machinery while no re-run is ruled (#4412).

## Why this is out of scope

#1936 Round 1 Q3 (B) ruled one test, and #2046 ran it; #1936's close says nothing owes a re-measure after #2285. #2047's adopter offers leave the test out.

`docs/research/startup-load-before-after-test.md` is rewritten in place only while the test it specifies runs (its `docs/doc-map.md` §A row). `scripts/arm-tasks.js` still builds at HEAD: since #4400 its neighbour probe accepts the old refusal and the newer warning alike.

Revisit when a re-run is ruled: its spec decides what the neighbour tasks exercise.
