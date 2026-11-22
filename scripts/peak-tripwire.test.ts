// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "peak-tripwire.js");
const KILL_AT = "2026-11-17T03:00:00.000Z";

let host: string;
let file: string;
beforeEach(() => {
	host = fs.mkdtempSync(path.join(os.tmpdir(), "peak-tripwire-cli-"));
	file = path.join(host, ".claude", "tmp", "markers", "peak-tripwire.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			state: "tripped",
			trip: {
				at: KILL_AT,
				pid: 4242,
				name: "MainThread",
				rssMiB: 900,
				testRun: {
					role: "worker",
					session: "s-killed",
					kind: "named",
					argv: ["a.test.ts"],
					files: ["a.test.ts"],
					fileCount: 1,
					repo: "workflow-core",
				},
			},
			liveRuns: [
				{
					at: "2026-11-17T02:59:00.000Z",
					session: "s-peak",
					kind: "touched",
					fileCount: 3,
					repo: "workflow-core",
				},
			],
			trippedAt: "2026-11-17T03:00:10.000Z",
			checkedThrough: "2026-11-17T03:00:10.000Z",
			checkedAt: "2026-11-17T03:00:10.000Z",
			unread: null,
			armedBy: null,
			armedAt: null,
		}),
	);
});
afterEach(() => fs.rmSync(host, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
	runInProcess(SCRIPT, args, {
		cwd: host,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: host,
			CLAUDE_CODE_SESSION_ID: "",
			...env,
		},
	});
const state = () => JSON.parse(fs.readFileSync(file, "utf8"));

describe("peak-tripwire.js", () => {
	it("`status` prints the state, the tripping kill, the runs live at it, the last check and the re-arm", () => {
		const r = run(["status"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("peak tripwire: tripped");
		expect(r.stdout).toContain("pid 4242 (MainThread, VmRSS 900 MiB)");
		expect(r.stdout).toContain(
			"live: touched run by s-peak in workflow-core, 3 files",
		);
		expect(r.stdout).toContain("last check: 2026-11-17T03:00:10.000Z");
		expect(r.stdout).toContain("peak-tripwire.js arm");
	});

	it("`arm` resets the state, records the session and advances the cursor to now", () => {
		const at = "2026-11-17T04:00:00.000Z";
		const r = run(["arm"], {
			CLAUDE_CODE_SESSION_ID: "s-reader",
			WFC_NOW: at,
		});
		expect(r.status).toBe(0);
		const t = state();
		expect(t).toMatchObject({
			state: "armed",
			trip: null,
			liveRuns: [],
			trippedAt: null,
			armedBy: "s-reader",
		});
		expect(t.checkedThrough).toBe(at);
		expect(t.armedAt).toBe(at);
		expect(run(["status"]).stdout).toContain("peak tripwire: armed");
	});

	it("`arm --session` names the session where the environment has none, and refuses with neither", () => {
		expect(run(["arm"]).status).toBe(2);
		expect(state().state).toBe("tripped");
		expect(run(["arm", "--session", "s-flag"]).status).toBe(0);
		expect(state().armedBy).toBe("s-flag");
	});

	it("`arm` exits 1, the wire left tripped, where the state file will not write", () => {
		const markers = path.dirname(file);
		fs.chmodSync(markers, 0o500);
		try {
			const r = run(["arm", "--session", "s-flag"]);
			expect(r.status).toBe(1);
			expect(r.stderr).not.toBe("");
		} finally {
			fs.chmodSync(markers, 0o700);
		}
		expect(state().state).toBe("tripped");
	});
});
