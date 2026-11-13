/*
 * commit-msg-testkit.ts — what the suites driving the real `.husky/commit-msg`
 * share.
 */

import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

const ROOT = path.join(__dirname, "..", "..");

/** Points `hooks/commit-msg` at the real hook. Husky runs its hook files
 * through sh; git's own copy is not executable. */
export function installCommitMsgHook(hooks: string): void {
	fs.writeFileSync(
		path.join(hooks, "commit-msg"),
		`#!/bin/sh\nexec sh ${shellQuote(path.join(ROOT, ".husky", "commit-msg"))} "$1"\n`,
		{ mode: 0o755 },
	);
}
