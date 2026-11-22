import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

export const REG_ABSENT =
	"ERROR: The system was unable to find the specified registry key or value.";

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
			`printf x >> ${shellQuote(calls)}`,
			`case $(wc -c < ${shellQuote(calls)}) in`,
			...arms,
			"esac",
			`printf '%s\\r\\n' ${shellQuote(REG_ABSENT)} >&2`,
			"exit 1",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return bin;
}

export const regCalls = (dir: string): number => {
	try {
		return fs.statSync(path.join(dir, "reg-calls")).size;
	} catch {
		return 0;
	}
};
