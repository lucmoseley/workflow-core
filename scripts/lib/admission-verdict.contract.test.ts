// @vitest-environment node
/*
 * Holds lib/admission-verdict-fake.ts, the verdict refill-loop-run.test.ts's
 * admission stub prints, to what the real admission.js prints under the
 * loop's own arguments (lib/refill-loop.js's FREE_SLOT_ARGS), run against a
 * fake `/proc`, meminfo, `ps` and `claude` (#3331). Breaking it costs the
 * concurrency record: a field admission renames still passes the run test,
 * and the loop records null for it live.
 */
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
import { FREE_SLOT_ARGS } from "./refill-loop.js";
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

/*
 * What admission.js prints on a machine with room to spare, where one
 * neighbour works in a repo beside this session: every limb it reads is a
 * fixture here, so no case reads this machine's own state.
 */
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
			// Each session's pair at 600 MB, so the working row reads a figure.
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
