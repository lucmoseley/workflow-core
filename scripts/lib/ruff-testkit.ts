/*
 * ruff-testkit.ts — a stubbed ruff for the two suites that drive the Python
 * gate: scripts/precommit-ruff-gate.test.ts, which runs the hook's shell, and
 * scripts/check-ruff-introduced.test.ts, which runs the checker it calls (#122).
 *
 * The stub reports one finding per `# FINDING <code> <message>` line of what it
 * reads on stdin, as ruff's JSON. Each suite's `with the real ruff` cases pin
 * the stub's reading of ruff's CLI.
 */

import fs from "node:fs";
import path from "node:path";
import { commandPath } from "./command-path-testkit";

/**
 * The stub's body, after its `ARGS` path. `argc=` goes first, so an invocation
 * with NO arguments still leaves a line behind.
 */
const STUB = String.raw`const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(ARGS, ["argc=" + argv.length, ...argv, ""].join("\n"));
const input = argv.includes("-") ? fs.readFileSync(0, "utf8") : "";
const found = [];
input.split("\n").forEach((line, i) => {
	const m = /^# FINDING (\S+) (.*)$/.exec(line);
	if (m) found.push({ code: m[1], message: m[2], location: { row: i + 1, column: 1 } });
});
process.stdout.write(JSON.stringify(found));
`;

/** Writes an executable ruff stub at `file`, recording its argv to `argsFile`. */
export function writeRuffStub(file: string, argsFile: string, exit = 0): void {
	fs.writeFileSync(
		file,
		`#!${process.execPath}\nconst ARGS = ${JSON.stringify(argsFile)};\n${STUB}process.exit(${exit});\n`,
	);
	fs.chmodSync(file, 0o755);
}

/**
 * How a failing stub fails: `config` as a ruff with an unloadable config, on any
 * blob; `syntax` on any blob but an empty one (both held to ruff by
 * ruff.contract.test.ts); `killed` by a signal; `vanishes`, deleted once it has
 * failed, so a rerun cannot start. The last two have no free real ruff to
 * compare against.
 */
export type RuffFailure = "config" | "syntax" | "killed" | "vanishes";

const FAILURE_BODY: Record<RuffFailure, string> = {
	config: `console.error("stub config fault"); process.exit(2);`,
	syntax: `if (require("node:fs").readFileSync(0, "utf8") === "") process.exit(0);
console.error("stub syntax fault"); process.exit(2);`,
	killed: `process.kill(process.pid, "SIGKILL");`,
	vanishes: `require("node:fs").unlinkSync(process.argv[1]); process.exit(2);`,
};

export function writeFailingRuffStub(file: string, failure: RuffFailure): void {
	fs.writeFileSync(file, `#!${process.execPath}\n${FAILURE_BODY[failure]}\n`);
	fs.chmodSync(file, 0o755);
}

/** Each stub invocation's argv, in call order. */
export function readStubCalls(argsFile: string): string[][] {
	if (!fs.existsSync(argsFile)) return [];
	return fs
		.readFileSync(argsFile, "utf8")
		.split("argc=")
		.filter(Boolean)
		.map((call) => call.split("\n").slice(1, -1));
}

/** Writes `root`'s .claude/workflow-core.json, `body` merged over a founder. */
export function writeHostConfig(root: string, body: object | string): void {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		typeof body === "string" ? body : JSON.stringify({ founder: "t", ...body }),
	);
}

/** The machine's ruff, or "" — CI's node job has none. */
export const REAL_RUFF = (() => {
	try {
		return commandPath("ruff");
	} catch {
		return "";
	}
})();

/** The plugin's shipped config, read live, so the host's own ruff layout decides nothing. */
export const PLUGIN_SELECT = fs.readFileSync(
	path.join(__dirname, "..", "..", "ruff.toml"),
	"utf8",
);
