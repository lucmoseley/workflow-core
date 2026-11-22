// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildIsolatedEnv,
	SELF,
	writeHostRepo,
	writeProcRoot,
} from "./admission-testkit";
import { ADMISSION_VERDICT } from "./admission-verdict-fake";
import { buildAgentsBranch, buildJobRow } from "./agents-stop-fake";
import { writeClaudeStub } from "./claude-stub";
import { buildMeminfo } from "./meminfo-fake";
import { writePsStub } from "./ps-stub";
import { FREE_SLOT_ARGS } from "./refill-tick-core.js";
import { runInProcess } from "./run-in-process";

const SCRIPT = path.resolve(__dirname, "..", "admission.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-verdict-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = (name: string) => path.join(dir, name);

const write = (name: string, body: string, mode = 0o644) => {
	fs.mkdirSync(path.dirname(at(name)), { recursive: true });
	fs.writeFileSync(at(name), body, { mode });
	return at(name);
};

function realVerdict() {
	const host = writeHostRepo(dir, {});
	const claude = writeClaudeStub(at("claude"), [
		buildAgentsBranch([
			buildJobRow("self", "working", { sessionId: SELF, cwd: host, pid: 701 }),
			buildJobRow("neighbour", "working", { cwd: host, pid: 702 }),
		]),
	]);
	const r = runInProcess(SCRIPT, FREE_SLOT_ARGS, {
		env: {
			...process.env,
			...buildIsolatedEnv(dir),
			HOME: dir,
			CLAUDE_PROJECT_DIR: host,
			WFC_MEMINFO: write(
				"meminfo",
				buildMeminfo({
					availableMb: 8192,
					swapTotalMb: 2048,
					swapFreeMb: 2048,
				}),
			),
			WFC_PS: writePsStub(dir, ["claude /usr/bin/claude"]),
			WFC_CLAUDE_BIN: claude,
			WFC_PROC: writeProcRoot(dir, {
				pss: { "701": 600 * 1024, "702": 600 * 1024 },
			}),
		},
	});
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return JSON.parse(r.stdout);
}

function shape(value: unknown, prefix = ""): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return { [prefix]: value === null ? "null" : typeof value };
	return Object.assign(
		{},
		...Object.entries(value).map(([k, v]) =>
			shape(v, prefix ? `${prefix}.${k}` : k),
		),
	);
}

describe("the admission stub's verdict against the real admission.js (#3331)", () => {
	it("carries only fields the real verdict prints, each of the real type", () => {
		const real = shape(realVerdict());
		const fake = shape(ADMISSION_VERDICT);
		expect(Object.keys(fake).length).toBeGreaterThan(0);
		for (const [field, type] of Object.entries(fake))
			expect({ field, type: real[field] }).toEqual({ field, type });
	});
});
