/*
 * ps-stub.ts — the fake `ps` every test injects at WFC_PS (#1311). The stub
 * ignores its arguments and prints `lines` verbatim, so each suite writes only
 * the process table its case needs, in the column shape its reader asks for.
 */

import fs from "node:fs";
import path from "node:path";

const PS_FAILING_SCRIPT =
	'#!/bin/sh\necho "ps: cannot read /proc" >&2\nexit 1\n';

const END = "PS_STUB_END";

/**
 * Write a stub `ps` at `dir/name` printing `lines`, one per process, and return
 * its path. `fails: true` substitutes the canonical unreadable-ps stub;
 * `marker` names a file the stub touches.
 */
export function writePsStub(
	dir: string,
	lines: string[],
	{
		name = "ps",
		fails = false,
		marker,
	}: { name?: string; fails?: boolean; marker?: string } = {},
): string {
	if (lines.includes(END))
		throw new Error(`ps-stub: a line may not be the heredoc's ${END}`);
	const file = path.join(dir, name);
	const body = fails
		? PS_FAILING_SCRIPT
		: [
				"#!/bin/sh",
				...(marker ? [`touch ${JSON.stringify(marker)}`] : []),
				`cat <<'${END}'`,
				...lines,
				END,
				"",
			].join("\n");
	fs.writeFileSync(file, body, { mode: 0o755 });
	return file;
}
