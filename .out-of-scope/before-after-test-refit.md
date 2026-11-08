# Re-fitting the before/after test to later machinery

This repo does not bring the before/after test's task set or its design note up to date with later machinery while no re-run is ruled (#4412).

## Why this is out of scope

#1936 Round 1 Q3 (B) ruled one test, and #2046 ran it. Nothing owes another run: #1936's close says the load after #2285 has not been re-measured and that nothing owes that. #2047's adopter offers leave the test out. So a re-fit has no caller.

`docs/research/startup-load-before-after-test.md` is rewritten in place only while the test it specifies runs (its `docs/doc-map.md` §A row). Its D1 rule 5 describes the concurrency rules at the revision the test ran on. `scripts/arm-tasks.js` still builds at HEAD: since #4400 its neighbour probe accepts the old refusal and the newer warning alike.

Revisit when a re-run is ruled. That ruling's spec decides what the tasks exercise at the revision it runs on. For example, since #4249 a file claim only warns, so a neighbour task now tests only that warning.
