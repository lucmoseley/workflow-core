/*
 * The `node` stub and hook environment shared by the issue-claim hooks' tests
 * (#2547). Both hooks reach the arbiter through WFC_NODE and both suites read
 * the stub's log line by line, so one stub keeps the two oracles from drifting
 * apart.
 */

import fs from "node:fs";
import path from "node:path";

/* A `node` stub under `dir` logging one line per call to `calls`:
 * <session>\t<argv…>. It sits off PATH, so a bare call that skips WFC_NODE
 * reaches the real node and fails the test. */
export const stubNode = (dir: string, calls: string, exitCode = 0) => {
	const stub = path.join(dir, "stubs", "node");
	fs.mkdirSync(path.dirname(stub), { recursive: true });
	fs.writeFileSync(
		stub,
		`#!/bin/sh\nprintf '%s\\t%s\\n' "$CLAUDE_CODE_SESSION_ID" "$*" >> "${calls}"\nexit ${exitCode}\n`,
		{ mode: 0o755 },
	);
	return stub;
};

/** A hook's environment, its node at `node` — or, at null, the real one. */
export const hookEnv = (config: string, node: string | null) => {
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: config };
	if (node === null) delete env.WFC_NODE;
	else env.WFC_NODE = node;
	return env;
};
