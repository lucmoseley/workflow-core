// @vitest-environment node
/*
 * How many `claude agents --json` unions one admission run and one refill
 * tick make (#3320, measured on #2509). Each union starts one CLI process per
 * seat, about 65 MB PSS apiece, so a reader that lists again for what an
 * earlier listing already holds is paid for on every run.
 *
 * Real admission.js, real reap-finished-sessions.js and a real refill-loop.js
 * `dry-run` run against a fake `claude` that logs each call. The reaper reads
 * the session registry, not the CLI (#2665), so it adds none. Every bar reads
 * full, so the tick sizes no cap, reads no shortlist and makes no GitHub call.
 *
 * Break it and a second listing — a reader re-asking the oracle, or the reaper
 * moved back onto the CLI — shows here as one more line.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentsBranch, buildListedRow } from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { GH_FAILING_SCRIPT } from "./lib/gh-stub";
import { buildMeminfo } from "./lib/meminfo-fake";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process";
import { buildUsageCache } from "./lib/usage-probe-fake";

const SELF = "agents-listing-count";

let dir: string;
let listingLog: string;
let ghLog: string;

const at = (name: string) => path.join(dir, name);

const writeListingClaude = (sessionId: string) =>
	writeClaudeStub(at("claude"), [
		`if [ "$1" = "agents" ]; then printf '%s\\n' "$*" >> '${listingLog}'; fi`,
		buildAgentsBranch([buildListedRow({ sessionId, pid: 1 })]),
	]);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-listing-count-"));
	listingLog = at("listings");
	ghLog = at("gh-calls");
	fs.mkdirSync(at("proc"));
	fs.mkdirSync(at("seat"));
	// Room for a slot, so the verdict is read and not refused.
	fs.writeFileSync(
		at("meminfo"),
		buildMeminfo({ availableMb: 8192, swapTotalMb: 2048, swapFreeMb: 2048 }),
	);
	// Any reading: WFC_LOAD_CEILING is blanked, so load holds nothing.
	fs.writeFileSync(at("loadavg"), "0.50 1.00 1.00 2/300 1\n");
	writeListingClaude(SELF);
	fs.writeFileSync(
		at("gh"),
		GH_FAILING_SCRIPT.replace(
			/^#!.*\n/,
			(shebang) => `${shebang}printf '%s\\n' "$*" >> '${ghLog}'\n`,
		),
		{ mode: 0o755 },
	);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/* Off this machine's own memory, load, `/proc`, suite queue and seats, with
 * the reclaim plan left to the real reaper. */
const buildMachineEnv = (): NodeJS.ProcessEnv => ({
	...process.env,
	HOME: dir,
	TMPDIR: dir,
	CLAUDE_CONFIG_DIR: at("seat"),
	CLAUDE_PROJECT_DIR: dir,
	CLAUDE_CODE_SESSION_ID: SELF,
	WFC_CLAUDE_BIN: at("claude"),
	WFC_GH: at("gh"),
	WFC_MEMINFO: at("meminfo"),
	WFC_LOADAVG: at("loadavg"),
	WFC_PROC: at("proc"),
	WFC_PS: writePsStub(dir, []),
	WFC_REAP_SCRIPT: undefined,
	WFC_LOAD_CEILING: "",
	WFC_SESSION_CEILING: "0",
	WFC_SESSION_FLOOR: "",
	GITHUB_ACTIONS: "",
});

const readLines = (file: string) =>
	fs.existsSync(file)
		? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];

describe("claude agents --json unions (#3320)", () => {
	it.each([
		["a plain run", ["--json"]],
		["a launch's re-read", ["--json", "--launch"]],
	])("one admission run lists once: %s", (_, args) => {
		const r = runInProcess(path.resolve(__dirname, "admission.js"), args, {
			env: buildMachineEnv(),
		});
		expect(r.status).toBe(0);
		const verdict = JSON.parse(r.stdout);
		expect(verdict.ok).toBe(true);
		/* The reaper's plan was read, so its listing is in the count. */
		expect(verdict.reclaimableError).toBeNull();
		expect(readLines(listingLog)).toEqual(["agents --json"]);
	});

	/* Where the strict listing refuses, no reader lists again with
	 * `requireSelf: false` to get past it (#3330). */
	it("one admission run lists once where the session is unlisted", () => {
		writeListingClaude("other");
		const r = runInProcess(
			path.resolve(__dirname, "admission.js"),
			["--json"],
			{ env: buildMachineEnv() },
		);
		expect(r.status).toBe(2);
		expect(JSON.parse(r.stdout).error).toContain(
			`does not list this very session (${SELF})`,
		);
		expect(readLines(listingLog)).toEqual(["agents --json"]);
	});

	it("a refill tick lists twice: admission's and its own", async () => {
		fs.writeFileSync(
			path.join(at("seat"), ".claude.json"),
			JSON.stringify(buildUsageCache({ session: 100, week: 100 }, Date.now())),
		);
		fs.writeFileSync(
			at(".refill-loop-control.json"),
			JSON.stringify({
				startedAt: Date.now(),
				stopRequested: false,
				seats: [at("seat")],
			}),
		);
		const r = await runInProcessAsync(
			path.resolve(__dirname, "refill-loop.js"),
			["dry-run"],
			{ cwd: dir, env: { ...buildMachineEnv(), WFC_REFILL_DIR: dir } },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("dry run: ");
		expect(readLines(listingLog)).toEqual(["agents --json", "agents --json"]);
		expect(readLines(ghLog)).toEqual([]);
	});
});
