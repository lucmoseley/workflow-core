import fs from "node:fs";
import path from "node:path";
import { commandPath } from "./command-path-testkit";

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

export function writeRuffStub(file: string, argsFile: string, exit = 0): void {
	fs.writeFileSync(
		file,
		`#!${process.execPath}\nconst ARGS = ${JSON.stringify(argsFile)};\n${STUB}process.exit(${exit});\n`,
	);
	fs.chmodSync(file, 0o700);
}

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
	fs.chmodSync(file, 0o700);
}

export function readStubCalls(argsFile: string): string[][] {
	if (!fs.existsSync(argsFile)) return [];
	return fs
		.readFileSync(argsFile, "utf8")
		.split("argc=")
		.filter(Boolean)
		.map((call) => call.split("\n").slice(1, -1));
}

export function writeHostConfig(root: string, body: object | string): void {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		typeof body === "string" ? body : JSON.stringify({ founder: "t", ...body }),
	);
}

export const REAL_RUFF = (() => {
	try {
		return commandPath("ruff");
	} catch {
		return "";
	}
})();

export const PLUGIN_SELECT = fs.readFileSync(
	path.join(__dirname, "..", "..", "ruff.toml"),
	"utf8",
);
