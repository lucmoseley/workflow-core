#!/usr/bin/env node
/*
 * No guard around its top-level call at all — `wayfinder-frontier.js`'s
 * shape — for run-in-process.test.ts's "refuses a script with no such guard"
 * case (mantahostels#1944). Deliberately never run for real: `runInProcessAsync` must
 * refuse this before `entry.load` reaches the line below.
 *
 * Its own source must not spell out the guarded form's identifier in a
 * comment, unlike every other prose comment in this repo that names it in
 * full — `runInProcessAsync`'s pre-load check is a plain substring search, so
 * writing that identifier here, even in prose, would satisfy it and defeat
 * the very case this file exists for.
 */

require("node:fs").writeSync(1, "ran for real, unguarded\n");
