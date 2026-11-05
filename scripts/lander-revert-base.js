#!/usr/bin/env node
/*
 * lander-revert-base.js — prints the second baseline .husky/pre-commit hands
 * every direction gate (#4451): the culprit's parent a verified lander revert
 * restores, where WFC_LANDER_REVERT names a culprit and the index is its clean
 * revert onto HEAD (lib/clean-revert.js). Prints nothing otherwise.
 *
 * The hook runs it once per commit, so every gate judges against one answer.
 *
 * IN NO `scripts/` FAMILY (code-standards §N3), as landing-registry-gate.js.
 */

const { readLanderRevert, readRevertBase } = require("./lib/clean-revert.js");

const culprit = readLanderRevert();
const base =
	culprit && readRevertBase(process.cwd(), { culprit, onto: "HEAD" });
if (base) process.stdout.write(`${base}\n`);
