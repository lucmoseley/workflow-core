// @vitest-environment node
// full-sweep-only: lucmoseley/mantahostels#2574

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScratchCore } from "./scratch-core-testkit";

const require_ = createRequire(__filename);
type Lenient<T> = {
	[K in keyof T]: T[K] extends (...a: never[]) => infer R
		? (...a: unknown[]) => R
		: T[K];
};
const replay = require_("./persist-replay.js") as Lenient<
	typeof import("./persist-replay.js")
>;

const SCRIPTS = path.resolve(__dirname, "..");
const REPO = path.resolve(SCRIPTS, "..");
const PRODUCERS = replay.readPersistingProducers(REPO);
const WINDOW = {
	from: Date.parse("2026-08-31T12:00:00Z"),
	to: Date.parse("2026-08-31T12:00:30Z"),
};
const IN_WINDOW = "2026-08-31T12:00:10.000Z";

const report = (over: Record<string, unknown> = {}) => ({
	checker: "ghost-jobs",
	outcome: "WARN",
	text: "two ghosts",
	at: IN_WINDOW,
	durationMs: 1200,
	stamp: null,
	...over,
});

const runResult = (over: Record<string, unknown> = {}) => ({
	stdout: "",
	stderr: "",
	code: 0,
	killed: false,
	ms: 1200,
	...over,
});

const ghost = { key: "ghost-jobs" };

const faultsOf = (
	producer: Record<string, unknown>,
	rep: Record<string, unknown> | null,
) =>
	replay.judge(producer, {
		persistRun: runResult(),
		controlRun: null,
		report: rep,
		runOpen: false,
		window: WINDOW,
		stampSeen: false,
	}).faults;

const compare = (persisted: string, live: string) =>
	replay.judge(ghost, {
		persistRun: runResult(),
		controlRun: runResult({ stdout: live }),
		report: report({ text: persisted }),
		runOpen: false,
		window: WINDOW,
		stampSeen: false,
	});

function persistingKey(
	hook: { command?: string; args?: string[] } | undefined,
): string | undefined {
	const line = [hook?.command ?? "", ...(hook?.args ?? [])].join(" ");
	if (!line.includes("WFC_NOTIFY_PERSIST=1") || !line.includes("--notify"))
		return;
	const m = line.match(/scripts\/([A-Za-z0-9_-]+)\.js/);
	if (!m) return;
	return m[1] === "check-cleared-trackers" ? m[1] : m[1].replace(/^check-/, "");
}

describe("the producer table", () => {
	it("holds exactly the three producers the settings block currently wires as persisting", () => {
		expect(PRODUCERS.map((p: { key: string }) => p.key).sort()).toEqual([
			"ci-status",
			"idle-efforts",
			"reap-finished-sessions",
		]);
	});

	it("agrees with self-plugin/hooks/hooks.json's own wiring, independent of the table's construction (mantahostels#2574)", () => {
		const settings = JSON.parse(
			fs.readFileSync(
				path.join(REPO, "self-plugin", "hooks", "hooks.json"),
				"utf8",
			),
		);
		const wired = new Set<string>();
		for (const matcher of settings?.hooks?.SessionStart ?? [])
			for (const hook of matcher?.hooks ?? []) {
				const key = persistingKey(hook);
				if (key !== undefined) wired.add(key);
			}
		expect(PRODUCERS.map((p: { key: string }) => p.key).sort()).toEqual(
			[...wired].sort(),
		);
	});

	it("files each producer under the name its own script uses", () => {
		for (const p of PRODUCERS) {
			const src = fs.readFileSync(path.join(SCRIPTS, p.script), "utf8");
			const literal = src.match(/^\s*name: "([^"]+)",/m)?.[1];
			const viaConst = src.match(/^const CHECKER = "([^"]+)";/m)?.[1];
			expect(literal ?? viaConst, `${p.script} names itself`).toBe(p.key);
		}
	});

	it("names a script that exists for every producer", () => {
		for (const p of PRODUCERS)
			expect(fs.existsSync(path.join(SCRIPTS, p.script)), p.script).toBe(true);
	});
});

describe("the producer table against another wiring", () => {
	let root = "";
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "persist-replay-"));
		fs.mkdirSync(path.join(root, ".claude"));
		useScratchCore(root);
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const wire = (...scripts: string[]) =>
		fs.writeFileSync(
			path.join(root, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: scripts.map((s) => ({
								type: "command",
								command: `WFC_NOTIFY_PERSIST=1 node "$CLAUDE_PROJECT_DIR"/scripts/${s} --notify`,
							})),
						},
					],
				},
			}),
		);

	it("refuses a meta key that names no wired producer", () => {
		wire("check-ci-status.js", "check-idle-efforts.js");
		expect(() => replay.readPersistingProducers(root)).toThrow(
			/PRODUCER_META names reap-finished-sessions,/,
		);
	});

	it("overlays each producer's meta where every key is wired", () => {
		wire(
			"check-ci-status.js",
			"check-idle-efforts.js",
			"reap-finished-sessions.js",
			"check-x.js",
		);
		expect(replay.readPersistingProducers(root)).toEqual([
			{ key: "ci-status", script: "check-ci-status.js", volatile: true },
			{ key: "idle-efforts", script: "check-idle-efforts.js", volatile: true },
			{
				key: "reap-finished-sessions",
				script: "reap-finished-sessions.js",
				outcomes: ["OK", "WARN", "BROKEN"],
				volatile: true,
			},
			{ key: "x", script: "check-x.js" },
		]);
	});
});

describe("a persisted report's own faults", () => {
	it("passes a well-formed report", () => {
		expect(faultsOf(ghost, report())).toEqual([]);
	});

	it("catches a missing report", () => {
		expect(faultsOf(ghost, null)).toHaveLength(1);
	});

	it("catches a report filed under another checker's name", () => {
		expect(faultsOf(ghost, report({ checker: "ci-status" })).join()).toMatch(
			/names checker/,
		);
	});

	it("catches an outcome outside the checker alphabet", () => {
		expect(faultsOf(ghost, report({ outcome: "MAYBE" })).join()).toMatch(
			/outside its alphabet/,
		);
	});

	it("holds the reaper to its own narrower alphabet", () => {
		const reaper = PRODUCERS.find(
			(p: { key: string }) => p.key === "reap-finished-sessions",
		);
		if (reaper === undefined) throw new Error("no reap-finished-sessions row");
		const asReaper = (outcome: string) =>
			faultsOf(reaper, report({ checker: reaper.key, outcome })).join();
		expect(asReaper("WARN")).toBe("");
		expect(asReaper("SKIP")).toMatch(/outside its alphabet/);
		expect(asReaper("FAIL")).toMatch(/outside its alphabet/);
	});

	it("catches a report left over from an earlier run", () => {
		expect(
			faultsOf(ghost, report({ at: "2026-08-31T09:00:00.000Z" })).join(),
		).toMatch(/outside this run/);
	});

	it("catches an unparseable timestamp", () => {
		expect(faultsOf(ghost, report({ at: "yesterday" })).join()).toMatch(
			/unparseable/,
		);
	});
});

describe("judge", () => {
	it("faults a producer that printed to stdout under persist mode", () => {
		const r = replay.judge(ghost, {
			persistRun: runResult({ stdout: "two ghosts\n" }),
			controlRun: null,
			report: report(),
			runOpen: false,
			window: WINDOW,
		});
		expect(r.faults.join()).toMatch(/stdout under persist mode/);
	});

	it("faults a control run that was killed rather than reading its silence as a finding", () => {
		const r = replay.judge(ghost, {
			persistRun: runResult(),
			controlRun: runResult({ stdout: "", killed: true, ms: 180_000 }),
			report: report(),
			runOpen: false,
			window: WINDOW,
			stampSeen: false,
		});
		expect(r.match).toBe("control run killed");
		expect(r.faults.join()).toMatch(/killed after 180000 ms/);
	});

	it("faults an open run record left behind", () => {
		const r = replay.judge(ghost, {
			persistRun: runResult(),
			controlRun: null,
			report: report(),
			runOpen: true,
			window: WINDOW,
		});
		expect(r.faults.join()).toMatch(/open run record/);
	});

	it("reads a report whose only differences are clock as the same finding", () => {
		const r = compare(
			"held 3d by 89413878, opened 2026-08-31T11:59:02.000Z\n",
			"held 3d by 89413878, opened 2026-08-31T12:00:11.000Z\n",
		);
		expect(r.match).toBe("same finding");
		expect(r.faults).toEqual([]);
	});

	it("reads an empty live report as its stamp holding it back, not as a mismatch", () => {
		const r = replay.judge(ghost, {
			persistRun: runResult(),
			controlRun: runResult({ stdout: "" }),
			report: report({ text: "two ghosts" }),
			runOpen: false,
			window: WINDOW,
			stampSeen: true,
		});
		expect(r.match).toBe("stamp-held live");
		expect(r.faults).toEqual([]);
	});

	it("faults that same silence where no stamp explains it", () => {
		const r = compare("two ghosts", "");
		expect(r.match).toBe("differs");
		expect(r.faults.join()).toMatch(/does not match/);
	});

	it("faults a persisted report that does not say what the live run said", () => {
		const r = compare("", "two ghost jobs standing\n");
		expect(r.match).toBe("differs");
		expect(r.faults.join()).toMatch(/does not match/);
	});

	it("names the ticket instead of faulting where the gap is already known", () => {
		const r = replay.judge(
			{ key: "hook-liveness", knownGap: 2277 },
			{
				persistRun: runResult(),
				controlRun: runResult({ stdout: "" }),
				report: report({
					checker: "hook-liveness",
					text: "nine wired hooks are failing",
				}),
				runOpen: false,
				window: WINDOW,
				stampSeen: false,
			},
		);
		expect(r.match).toBe("differs (known: #2277)");
		expect(r.faults).toEqual([]);
	});

	it("forgives that difference where the producer's subject moves under it", () => {
		const r = replay.judge(
			{ key: "ci-status", volatile: true },
			{
				persistRun: runResult(),
				controlRun: runResult({ stdout: "run 4 is red\n" }),
				report: report({ checker: "ci-status", text: "run 3 is red\n" }),
				runOpen: false,
				window: WINDOW,
			},
		);
		expect(r.match).toBe("differs");
		expect(r.faults).toEqual([]);
	});
});

describe("what the comparison masks", () => {
	it("masks a clock and a sha, and leaves a run id readable", () => {
		const r = compare(
			"run 33395110981 at 2026-08-31T12:00:10Z, 4e79c195",
			"run 33395110982 at 2026-08-31T12:00:20Z, 5f8a2d06",
		);
		expect(r.diff).toEqual({
			persisted: "run 33395110981 at <ts>, <sha>",
			control: "run 33395110982 at <ts>, <sha>",
		});
	});

	it("tells two different run ids apart", () => {
		expect(compare("run 1234567 is red", "run 7654321 is red").match).toBe(
			"differs",
		);
	});

	it("masks how big the corpus was, and keeps how much of it the fault reached", () => {
		expect(
			compare("in 726 of 3939 session(s)", "in 726 of 3945 session(s)").match,
		).toBe("same finding");
		expect(
			compare("in 726 of 3939 session(s)", "in 12 of 3939 session(s)").match,
		).toBe("differs");
		expect(compare("stopped 3 session(s)", "stopped 4 session(s)").match).toBe(
			"differs",
		);
	});
});

describe("parkStamps", () => {
	const stamps = require_(
		"./delivery-stamp.js",
	) as typeof import("./delivery-stamp.js");
	let sandbox = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "park-stamps-"));
		for (const v of [
			"CLAUDE_CONFIG_DIR",
			"CLAUDE_PROJECT_DIR",
			"WFC_CLAUDE_CONFIG_A",
			"WFC_CLAUDE_CONFIG_B",
			"WFC_CLAUDE_CONFIG_C",
		])
			vi.stubEnv(v, sandbox);
	});
	afterEach(() => {
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	it("takes a stamp out of the control run's way and puts it back byte for byte", () => {
		stamps.recordDelivery("ghost-jobs", "max:1234");
		const restore = replay.parkStamps([{ key: "ghost-jobs" }]);
		expect(stamps.readStamp("ghost-jobs")).toBe(null);
		restore();
		expect(stamps.readStamp("ghost-jobs")).toBe("max:1234");
	});

	it.skipIf(process.getuid?.() === 0)(
		"leaves a stamp that will not read where it is, through park and restore",
		() => {
			stamps.recordDelivery("ghost-jobs", "max:1234");
			const file = stamps.stampFile("ghost-jobs");
			fs.chmodSync(file, 0o000);
			try {
				const restore = replay.parkStamps([{ key: "ghost-jobs" }]);
				expect(fs.existsSync(file)).toBe(true);
				restore();
				expect(fs.existsSync(file)).toBe(true);
			} finally {
				fs.chmodSync(file, 0o600);
			}
			expect(stamps.readStamp("ghost-jobs")).toBe("max:1234");
		},
	);

	it("leaves a producer that has never been delivered undelivered", () => {
		const restore = replay.parkStamps([{ key: "ghost-jobs" }]);
		restore();
		expect(stamps.readStamp("ghost-jobs")).toBe(null);
	});

	it("also parks every name a producer's own report says it wrote under `stamps`, with no stampKeys entry", () => {
		stamps.recordDelivery("hook-liveness-corpus", "sig-a");
		stamps.recordDelivery("hook-liveness-census", "sig-b");
		const restore = replay.parkStamps([{ key: "hook-liveness" }], {
			"hook-liveness": {
				stamps: {
					"hook-liveness-corpus": "sig-a",
					"hook-liveness-census": "sig-b",
				},
			},
		});
		expect(stamps.readStamp("hook-liveness-corpus")).toBe(null);
		expect(stamps.readStamp("hook-liveness-census")).toBe(null);
		restore();
		expect(stamps.readStamp("hook-liveness-corpus")).toBe("sig-a");
		expect(stamps.readStamp("hook-liveness-census")).toBe("sig-b");
	});

	it("parks nothing extra where the report carries no stamps map", () => {
		stamps.recordDelivery("hook-liveness-corpus", "sig-a");
		const restore = replay.parkStamps([{ key: "hook-liveness" }], {
			"hook-liveness": { stamps: {} },
		});
		expect(stamps.readStamp("hook-liveness-corpus")).toBe("sig-a");
		restore();
		expect(stamps.readStamp("hook-liveness-corpus")).toBe("sig-a");
	});
});
