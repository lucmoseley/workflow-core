/*
 * The bash `claude` stub every port fake's lines run in (#3030). Two port
 * fakes share it, so it is no `<port>-fake`: a test writing it imports no
 * fake, and so reads no port's fixture it does not use.
 */

import fs from "node:fs";

/** Write a bash `claude` stub at `bin` running `lines` in turn, then
 * exiting `fallThroughExit`. */
export function writeClaudeStub(
	bin: string,
	lines: string[],
	fallThroughExit = 1,
) {
	fs.writeFileSync(
		bin,
		["#!/bin/bash", ...lines, `exit ${fallThroughExit}`, ""].join("\n"),
		{ mode: 0o755 },
	);
	return bin;
}
