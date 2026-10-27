/*
 * ruff-testkit.ts — a stubbed ruff for the two suites that drive the Python
 * gate: scripts/precommit-ruff-gate.test.ts, which runs the hook's shell, and
 * scripts/check-ruff-introduced.test.ts, which runs the checker it calls (#122).
 *
 * The stub reports one finding per `# FINDING <code> <message>` line of what it
 * reads on stdin, as ruff's JSON. Each suite's `with the real ruff` cases pin
 * the stub's reading of ruff's CLI.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
		return execFileSync("sh", ["-c", "command -v ruff"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "";
	}
})();

/** The plugin's shipped config, read live, so the host's own ruff layout decides nothing. */
export const PLUGIN_SELECT = fs.readFileSync(
	path.join(__dirname, "..", "..", "ruff.toml"),
	"utf8",
);
