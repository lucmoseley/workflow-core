/*
 * reg-fake.ts — a stub Windows `reg.exe` for check-interop-latency.js's tests
 * (#3564), injected at CLAUDE_INTEROP_REG, the interop probe's own seam. Held
 * to the real reg.exe by reg.contract.test.ts (§G7).
 *
 * FOR TESTS ONLY.
 */
import fs from "node:fs";
import path from "node:path";

/** What the real reg.exe prints, exiting 1, for a key or value that is absent. */
export const REG_ABSENT =
	"ERROR: The system was unable to find the specified registry key or value.";

/**
 * A reg.exe in `dir` whose Nth call sleeps `delaysS[N - 1]` seconds, the last
 * delay serving every call after, then answers as the real one does for an
 * absent key. Bash, not node, so a zero delay answers in milliseconds. Each
 * call appends a byte to `dir/reg-calls`. Its path, for CLAUDE_INTEROP_REG.
 */
export function writeReg(dir: string, delaysS: number[]): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "reg.exe");
	const calls = path.join(dir, "reg-calls");
	const arms = delaysS.map((s, i) =>
		i === delaysS.length - 1
			? `  *) sleep ${s} ;;`
			: `  ${i + 1}) sleep ${s} ;;`,
	);
	fs.writeFileSync(
		bin,
		[
			"#!/bin/bash",
			`printf x >> '${calls}'`,
			`case $(wc -c < '${calls}') in`,
			...arms,
			"esac",
			`printf '%s\\r\\n' '${REG_ABSENT}' >&2`,
			"exit 1",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return bin;
}

/** The calls the reg.exe in `dir` has served. */
export const regCalls = (dir: string): number => {
	try {
		return fs.statSync(path.join(dir, "reg-calls")).size;
	} catch {
		// No call yet: the counter file is written by the first.
		return 0;
	}
};
