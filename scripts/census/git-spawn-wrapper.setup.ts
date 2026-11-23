import cp from "node:child_process";
import fs from "node:fs";
import { afterAll, expect } from "vitest";

const ACTIVE = Symbol.for("wfc.run-in-process.active");
const LOG = process.env.RIP_CENSUS_LOG;

let buf: string[] = [];

function isGit(cmd: unknown, argsIsArray: boolean): boolean {
	if (typeof cmd !== "string") return false;
	if (cmd === "git" || cmd.endsWith("/git")) return true;
	if (argsIsArray) return false;
	const trimmed = cmd.trim();
	return trimmed === "git" || trimmed.startsWith("git ");
}

function record(file: string | undefined) {
	if (!LOG || !file) return;
	const active = Boolean((globalThis as Record<symbol, unknown>)[ACTIVE]);
	buf.push(`${file}\t${active ? "ACTIVE" : "idle"}\t${Date.now()}`);
}

function testFile(): string | undefined {
	let file: string | undefined;
	try {
		file = expect.getState().testPath;
	} catch (e) {
		process.stderr.write(
			`git-spawn-wrapper: expect.getState() failed, spawn unattributed: ${e}\n`,
		);
	}
	return file;
}

const SYNC = ["execFileSync", "spawnSync", "execSync"] as const;
const PROMISIFIED = ["execFile", "spawn", "exec"] as const;
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
const patchable = cp as unknown as Record<string, unknown>;

for (const name of SYNC) {
	const orig = cp[name] as (...a: unknown[]) => unknown;
	patchable[name] = function patched(cmd: unknown, ...rest: unknown[]) {
		if (isGit(cmd, Array.isArray(rest[0]))) record(testFile());
		return orig.call(cp, cmd, ...rest);
	};
}

for (const name of PROMISIFIED) {
	const orig = cp[name] as ((...a: unknown[]) => unknown) & {
		[promisifyCustom]?: unknown;
	};
	const patched = function patched(cmd: unknown, ...rest: unknown[]) {
		if (isGit(cmd, Array.isArray(rest[0]))) record(testFile());
		return orig.call(cp, cmd, ...rest);
	};
	if (orig[promisifyCustom]) {
		(patched as typeof orig)[promisifyCustom] = orig[promisifyCustom];
	}
	patchable[name] = patched;
}

afterAll(() => {
	if (!LOG || buf.length === 0) return;
	try {
		fs.appendFileSync(LOG, `${buf.join("\n")}\n`);
	} catch (e) {
		process.stderr.write(`git-spawn-wrapper: flush to ${LOG} failed: ${e}\n`);
	}
	buf = [];
});
