// @vitest-environment node
/*
 * The refill loop's `run` driven end to end (#2435): tick()'s wiring into
 * lib/refill-loop.js's settleTick, which #2286 tests only from fixtures, and
 * run()'s exit on a returned stop or a stop's wake.
 *
 * The program and its lib/ closure are copied into a sandbox `scripts/`, its
 * children stubbed beside it: admission, the allowance cap, the reap, the
 * shortlist, the gate check and the dispatcher are all found from the
 * program's own directory. The cwd-outside-every-checkout cases run the real
 * allowance.js, as only it reads the host's cost table (#2937). The copy is
 * no git checkout, so run() adopts no newer code, and the morning review's
 * root is the sandbox, with no config, so no tick files a review on a real
 * tracker.
 *
 * Loosen it and a fault in the program's own wiring, of its libs, children
 * and exits, passes unseen (#2851).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./lib/admission-verdict-fake";
import {
	buildAgentsBranch,
	buildJobRow,
	buildListedRow,
	buildPermissionRow,
	buildStopBranch,
	type Row,
} from "./lib/agents-stop-fake";
import { writeSeatHelper } from "./lib/auth-status-fake";
import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
} from "./lib/bg-resume-fake";
import { buildAttachBranch } from "./lib/claude-attach-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import {
	DEFAULT_WINDOW_HOURS,
	ledgerPath,
	readRecentEntries,
} from "./lib/dispatch-ledger.js";
import { API_PROMPT, IDLE_PROMPT } from "./lib/loop-prompts.js";
import { buildMeminfo } from "./lib/meminfo-fake";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { buildUsageCache } from "./lib/usage-probe-fake";
import { readProgramLibs } from "./lib-closure-fixture";

/* One session, never a waker: an empty listing reads as unread, and a
 * listed waker holds its wake for the 10 s re-check. */
const LISTED = buildListedRow({
	id: "other",
	sessionId: "other",
	kind: "background",
	status: "idle",
	state: "blocked",
});

let dir: string;
/* A run that outlived its stop is left its sandbox: deleting it under the
 * running loop exits the worker, hiding the failure. */
let outlived = false;
let scripts: string;
let repo: string;
let seat: string;

const at = (name: string) => path.join(dir, name);
/* Swap under a quarter free and MemAvailable under the hold's line (#2690),
 * or neither. */
const MEMINFO_HOLD = buildMeminfo({
	availableMb: 1024,
	swapTotalMb: 2048,
	swapFreeMb: 256,
});
const MEMINFO_NO_HOLD = buildMeminfo({
	availableMb: 8192,
	swapTotalMb: 2048,
	swapFreeMb: 2048,
});

const loopEnv = (over: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
	...process.env,
	WFC_REFILL_DIR: dir,
	WFC_MEMINFO: at("meminfo"),
	CLAUDE_PROJECT_DIR: dir,
	HOME: dir,
	CLAUDE_CONFIG_DIR: seat,
	WFC_CLAUDE_BIN: at("claude"),
	WFC_PRESENCE_MARKER: at("no-presence"),
	GITHUB_ACTIONS: "",
	...over,
});

const readLines = (file: string) =>
	fs.existsSync(file)
		? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];

/** A node stub at `name` in the sandbox scripts/. */
const stub = (name: string, body: string) =>
	fs.writeFileSync(path.join(scripts, name), body);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-run-"));
	/* The swap hold off, so no run reads the machine's own memory (#3093). */
	fs.writeFileSync(at("meminfo"), MEMINFO_NO_HOLD);
	scripts = at("code/scripts");
	fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
	for (const f of [
		"refill-loop.js",
		...readProgramLibs("refill-loop.js").map((l) => `lib/${l}`),
		/* Spawned by path, not required: lib/agent-liveness.js runs the listing
		 * through it, which reads unread without it. */
		"lib/run-grouped.js",
		/* Spawned by path: the resume typed into a live session (#2705). */
		"pty_type.py",
		/* Spawned by path: a copy's issue claims moved (#2963). */
		"session-arbiter.js",
		...readProgramLibs("session-arbiter.js").map((l) => `lib/${l}`),
	])
		fs.copyFileSync(path.join(__dirname, f), path.join(scripts, f));

	repo = at("repo");
	fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".claude", "workflow-core.json"), "{}\n");
	seat = at("seat");
	fs.mkdirSync(seat);
	// Fresh and low, so no tick probes /usage or waits on a full seat.
	weekAt(10);
	fs.writeFileSync(
		at(".refill-loop-control.json"),
		JSON.stringify({
			startedAt: Date.now(),
			stopRequested: false,
			seats: [seat],
			scope: { mode: "normal", repos: [repo], exclude: [], goals: {} },
		}),
	);
	// Swept just now, so no tick starts a gate sweep.
	fs.writeFileSync(
		at(".refill-gate-readings.json"),
		JSON.stringify({ lastSweepAt: Date.now() }),
	);

	stub(
		"admission.js",
		`require("node:fs").appendFileSync(${JSON.stringify(at("ticks"))}, "tick\\n");
process.stdout.write(JSON.stringify({ ...${JSON.stringify(ADMISSION_VERDICT)}, slots: Number(process.env.FAKE_SLOTS) }));\n`,
	);
	stub(
		"allowance.js",
		"process.stdout.write(JSON.stringify({ cap: { launch: 1 } }));\n",
	);
	stub("reap-finished-sessions.js", "");
	stub("check-gates.js", "");
	stub(
		"supervise-landing.js",
		`require("node:fs").appendFileSync(${JSON.stringify(at("supervised"))}, process.cwd() + "\\n");
process.stdout.write("started the lander");\n`,
	);
	stub(
		"pick-next.js",
		`process.stdout.write(JSON.stringify({
	frontier: [{ number: 5, urgent: false, goal: false, stallDays: 0, asksQuestions: false, reach: 0, collision: "", takes: ["implement"], labels: [] }],
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
}));\n`,
	);
	/* What `stop` writes: the control's flag, then a wake line. Not `stop`
	 * itself, which wakes only a loop whose pid's command line names the
	 * program, and this one runs inside the test worker. */
	const control = JSON.stringify(at(".refill-loop-control.json"));
	stub(
		"request-stop.js",
		`const fs = require("node:fs");
fs.writeFileSync(${control}, JSON.stringify({ ...JSON.parse(fs.readFileSync(${control}, "utf8")), stopRequested: true }));
fs.appendFileSync(${JSON.stringify(at(".refill-loop-wake"))}, \`\${Date.now()}\\n\`);\n`,
	);
	stub(
		"dispatch-sessions.sh",
		`printf '%s\\n' "$*" >> ${JSON.stringify(at("dispatches"))}
node ${JSON.stringify(path.join(scripts, "request-stop.js"))}\n`,
	);
	writeClaudeStub(at("claude"), [buildAgentsBranch([LISTED])]);
});

afterEach(() => {
	if (!outlived) fs.rmSync(dir, { recursive: true, force: true });
	outlived = false;
});

const run = (slots: number) =>
	runInProcessAsync(path.join(scripts, "refill-loop.js"), ["run"], {
		cwd: dir,
		env: loopEnv({ FAKE_SLOTS: String(slots) }),
	});

/* A guess: some 30 times a case's 0.7 s run, and well inside the loop's
 * fallback sleep (lib/refill-wake.js's FALLBACK_MS), so a loop still running
 * past it is waiting on that sleep, not ending. */
const SETTLE_MS = 20 * 1000;

const requestStop = () =>
	spawnSync(process.execPath, [path.join(scripts, "request-stop.js")]);

/** Whether `promise` settles inside SETTLE_MS, with its value where it does. */
const within = async <T>(promise: Promise<T>) => {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<{ done: false }>((resolve) => {
		timer = setTimeout(() => resolve({ done: false }), SETTLE_MS);
	});
	try {
		return await Promise.race([
			promise.then((value) => ({ done: true as const, value })),
			late,
		]);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * `running`'s result, or a throw naming `what` once SETTLE_MS passes first. A
 * run still going is asked to stop once more and given SETTLE_MS again.
 */
const settled = async <T>(running: Promise<T>, what: string): Promise<T> => {
	const first = await within(running);
	if (first.done) return first.value;
	requestStop();
	outlived = !(await within(running)).done;
	throw new Error(`${what}: still running`);
};

/** Resolves once the stub admission has been asked `n` times. */
const ticked = async (n: number) => {
	const deadline = Date.now() + SETTLE_MS;
	while (readLines(at("ticks")).length < n) {
		if (Date.now() > deadline) throw new Error(`tick ${n} never ran`);
		// A guess: short against a tick, cheap against the ceiling.
		await new Promise((r) => setTimeout(r, 50));
	}
};

const readStopped = () =>
	JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8")).stopped;

describe("run (#2435)", () => {
	it("ends at the tick whose dispatch a stop landed in, recorded explicit", async () => {
		const r = await settled(run(1), "run after a mid-dispatch stop");
		expect(r.status).toBe(0);
		// The tick supervised the served repo's landing queue, in it (#2692).
		expect(readLines(at("supervised"))).toEqual([fs.realpathSync(repo)]);
		expect(r.stdout).toContain(
			`landing in ${repo}: exit 0\n  started the lander`,
		);
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
		expect(readLines(at("ticks"))).toHaveLength(1);
		expect(readStopped()).toMatchObject({ reason: "explicit" });
		// The sandbox has no file-morning-review.js: a run of it logs an exit.
		expect(r.stdout).not.toMatch(/morning review( reversals)?: exit/);
	});

	it("appends each tick's line to the concurrency record and refreshes the 24-hour figure (#3317)", async () => {
		await settled(run(1), "run after a mid-dispatch stop");
		const lines = readLines(at("concurrency.jsonl")).map((l) => JSON.parse(l));
		expect(lines).toHaveLength(1);
		const { drawNeedMb, memory } = ADMISSION_VERDICT;
		expect(lines[0]).toMatchObject({
			working: memory.working.count,
			// The working sessions plus run(1)'s one free slot.
			ceiling: memory.working.count + 1,
			binding: {
				limit: "loop not running",
				why: "stopping: stop was requested",
			},
			also: [],
			memory: {
				drawNeedMb,
				rows: { working: memory.working.mb },
				largest: { name: "the live sessions' p95 draw", mb: drawNeedMb },
			},
		});
		expect(Number.isFinite(Date.parse(lines[0].at))).toBe(true);
		// No memwatch minute record in the sandbox's HOME: no figure yet.
		expect(fs.readFileSync(at("concurrency-24h"), "utf8")).toBe("-\n");
	});

	it("supervises a foreign checkout's launches to landing, finished or not, skipping a gone one (#3284)", async () => {
		const running = at("foreign");
		const finished = at("foreign-finished");
		for (const root of [running, finished]) {
			fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".claude", "workflow-core.json"),
				"{}\n",
			);
		}
		const launch = (root: string, n: number, finishedAt: number | null) => ({
			root,
			issues: [n],
			prompt: `/implement ${n}`,
			seat,
			jobId: `job${n}`,
			launchedAt: Date.now(),
			finishedAt,
		});
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					launch(running, 8, null),
					launch(finished, 9, Date.now()),
					launch(at("gone"), 10, Date.now()),
				],
			}),
		);
		const r = await settled(run(1), "run with foreign launches");
		expect(r.status).toBe(0);
		expect(readLines(at("supervised"))).toEqual(
			[repo, running, finished].map((d) => fs.realpathSync(d)),
		);
		expect(r.stdout).toContain(
			`landing in ${running}: exit 0\n  started the lander`,
		);
		expect(r.stdout).not.toContain(`landing in ${at("gone")}`);
	});

	it("tickets earlyoom's kill incidents in its own checkout each tick (#3094)", async () => {
		const code = path.dirname(scripts);
		fs.mkdirSync(path.join(code, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(code, ".claude", "workflow-core.json"), "{}\n");
		stub(
			"file-memory-kill-tickets.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("kill-filer"))}, process.cwd() + "\\n");
process.stdout.write("Memory kill incident from 2026-10-26 03:56: filed #9.");\n`,
		);
		stub("file-morning-review.js", "");
		const r = await settled(run(1), "run filing kill tickets");
		expect(r.status).toBe(0);
		expect(readLines(at("kill-filer"))).toEqual([fs.realpathSync(code)]);
		expect(r.stdout).toContain(
			"memory kills: exit 0\n  Memory kill incident from 2026-10-26 03:56: filed #9.",
		);
	});

	it("ticks on a wake line, logging its waker, and ends on a stop's wake", async () => {
		const running = run(0);
		await ticked(1);
		fs.appendFileSync(at(".refill-loop-wake"), `${Date.now()} waker-1\n`);
		await ticked(2);
		requestStop();
		const r = await settled(running, "run after a stop's wake");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("woken by waker-1");
		expect(r.stdout).not.toContain("the agents listing was unread");
		expect(readLines(at("ticks"))).toHaveLength(3);
		expect(readLines(at("dispatches"))).toEqual([]);
		expect(readStopped()).toMatchObject({ reason: "explicit" });
	});
});

/** The plan seat's fresh cache at `week`% of the week. */
const weekAt = (week: number) =>
	fs.writeFileSync(
		path.join(seat, ".claude.json"),
		JSON.stringify(buildUsageCache({ session: 10, week }, Date.now())),
	);

describe("a dry run with overflow seats (#2611)", () => {
	const api = () => at("seat-api");

	/** The seat file: the plan seat, then an overflow seat at `grant` unless null. */
	const seats = (grant: number | null) => {
		fs.mkdirSync(at(".claude"), { recursive: true });
		fs.writeFileSync(
			at(".claude/refill-seats"),
			`${seat}\n${grant === null ? "" : `${api()} api key=WFC_TEST_KEY grant=${grant} cycle-day=20\n`}`,
		);
	};

	const dryRun = () => {
		fs.writeFileSync(
			at("cost-table.json"),
			JSON.stringify({
				n: 2,
				meanUsd: 4,
				quantilesUsd: [1, 10],
				tailRemainderUsd: 9,
				landedByHours: [[1, 1]],
			}),
		);
		return runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["dry-run"],
			{
				cwd: dir,
				env: loopEnv({
					WFC_SESSION_COST_TABLE: at("cost-table.json"),
					FAKE_SLOTS: "1",
				}),
			},
		);
	};
	const dispatch = () =>
		`bash ${path.join(scripts, "dispatch-sessions.sh")} opus /implement 5`;

	it("prints the headless dispatch on the overflow seat once the plan seat is weekly-full", async () => {
		weekAt(100);
		seats(200);
		const r = await dryRun();
		expect(r.stdout).toContain(
			`would run in ${repo} on overflow seat ${api()}, each member a headless \`claude -p\` (lib/headless-sessions.js): ${dispatch()}`,
		);
		expect(readLines(at("dispatches"))).toEqual([]);
	});

	it("stops naming the spent key once every key is spent", async () => {
		weekAt(100);
		seats(2);
		expect((await dryRun()).stdout).toMatch(
			new RegExp(
				`dry run: stop: allowance — every plan seat reads 100% of the week and every overflow key is spent: ${api()} exhausted until \\d{4}-\\d{2}-20`,
			),
		);
	});

	it("launches on the plan seat while it has room, as with no overflow line", async () => {
		weekAt(10);
		for (const grant of [200, null]) {
			seats(grant);
			expect((await dryRun()).stdout).toContain(
				`would run in ${repo} on ${seat}: ${dispatch()}`,
			);
		}
	});

	it("stops on the plan seat's full week as before with no overflow line", async () => {
		weekAt(100);
		seats(null);
		expect((await dryRun()).stdout).toContain(
			"dry run: stop: allowance — every seat reads 100% of the week",
		);
	});
});

describe("a parked launch (#2699)", () => {
	const Job = "job7";
	const blockedRow = buildJobRow(Job, "blocked");
	const permissionRow = buildPermissionRow(Job);
	const SeededJob = {
		state: "blocked",
		detail: "needs your decision",
		tempo: "blocked",
		inFlight: { tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 },
		needs: "Which key should it use?",
		cliVersion: "2.1.309",
		sessionId: "s-job7",
	};
	const jobFile = () => path.join(seat, "jobs", Job, "state.json");

	/** An away-mode loop holding one launch its listing shows blocked on a
	 * question in the model's words, with the job record and transcript the
	 * classifier reads; `claude agents` answers as `agents` says. */
	beforeEach(() => {
		const control = JSON.parse(
			fs.readFileSync(at(".refill-loop-control.json"), "utf8"),
		);
		fs.writeFileSync(
			at(".refill-loop-control.json"),
			JSON.stringify({
				...control,
				scope: { mode: "away", repos: [], exclude: [], goals: {} },
			}),
		);
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/r" }),
		);
		const transcript = at("transcript.jsonl");
		fs.writeFileSync(
			transcript,
			`${[
				{
					type: "assistant",
					message: { content: [{ type: "text", text: "Which key?" }] },
				},
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		fs.mkdirSync(path.dirname(jobFile()), { recursive: true });
		fs.writeFileSync(
			jobFile(),
			JSON.stringify({ ...SeededJob, linkScanPath: transcript }),
		);
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					{
						root: repo,
						issues: [7],
						prompt: "/implement 7",
						seat,
						jobId: Job,
						launchedAt: Date.now() - 10 * 60 * 1000,
						finishedAt: null,
					},
				],
			}),
		);
		fs.writeFileSync(
			at("gh"),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(at("gh-calls"))}\n`,
			{ mode: 0o755 },
		);
	});

	const fakeClaude = (listing: Row[] | null) =>
		writeClaudeStub(at("claude"), [
			buildAgentsBranch(listing),
			buildStopBranch(at("stops")),
		]);

	/** Two ticks of the loop, ended by a stop after the first. */
	const twoTicks = async () => {
		const running = runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["run"],
			{
				cwd: dir,
				env: loopEnv({ WFC_GH: at("gh"), FAKE_SLOTS: "0" }),
			},
		);
		await ticked(1);
		requestStop();
		return settled(running, "run with a parked launch");
	};

	const launchState = () =>
		JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"))
			.launches[0];

	const parkComment = (cause: string, mode = "away") =>
		expect.stringMatching(
			new RegExp(
				`^issue comment 7 --repo o/r --body Refill loop: stopped ${cause} park repo /implement 7 \\(${mode} mode, blocked since [^)]+\\); labelled parked: #7\\. The conversation is kept: \`claude attach\` reopens it\\.$`,
			),
		);

	const expectNothingActed = () => {
		expect(readLines(at("stops"))).toEqual([]);
		expect(readLines(at("gh-calls"))).toEqual([]);
		expect(launchState()).not.toHaveProperty("parkStopped");
	};

	const inMode = (mode: "away" | "normal") => {
		const control = JSON.parse(
			fs.readFileSync(at(".refill-loop-control.json"), "utf8"),
		);
		control.scope.mode = mode;
		fs.writeFileSync(at(".refill-loop-control.json"), JSON.stringify(control));
	};

	it("stops an away question park once, labels its ticket parked and logs it", async () => {
		fakeClaude([LISTED, blockedRow]);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		expect(readLines(at("ticks")).length).toBeGreaterThanOrEqual(2);
		expect(readLines(at("stops"))).toEqual([`stop ${Job}`]);
		expect(readLines(at("gh-calls"))).toContain(
			"issue edit 7 --repo o/r --add-label parked",
		);
		expect(readLines(at("gh-calls"))).toContainEqual(parkComment("QUESTION"));
		expect(r.stdout).toMatch(
			/stopped QUESTION park repo \/implement 7 \(away mode, blocked since [^)]+\); labelled parked: #7/,
		);
		expect(launchState()).toMatchObject({
			parked: true,
			block: { cause: "QUESTION" },
		});
		expect(launchState().parkStopped).toEqual(expect.any(Number));
	});

	it("stops a 2.1.310 question park, whose row carries state and no status (#3200)", async () => {
		const { status: _, ...parkedRow } = blockedRow;
		jobAs({ cliVersion: "2.1.310" });
		fakeClaude([LISTED, parkedRow]);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		expect(readLines(at("stops"))).toEqual([`stop ${Job}`]);
		expect(readLines(at("gh-calls"))).toContainEqual(parkComment("QUESTION"));
		expect(r.stdout).not.toContain("block unread");
	});

	it("logs a row with neither status nor state once, not each tick (#3200)", async () => {
		const { status: _, state: __, ...bareRow } = blockedRow;
		fakeClaude([LISTED, bareRow]);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		expect(readLines(at("ticks")).length).toBeGreaterThanOrEqual(2);
		expect(
			r.stdout.match(/block unread .*: row carries neither status nor state/g),
		).toHaveLength(1);
		expectNothingActed();
	});

	it("comments a stopped permission park's cause on its ticket (#2846)", async () => {
		fakeClaude([LISTED, permissionRow]);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		expect(readLines(at("stops"))).toEqual([`stop ${Job}`]);
		expect(readLines(at("gh-calls"))).toContainEqual(parkComment("PERMISSION"));
	});

	it.each([
		[59, false],
		[61, true],
	])(
		"in normal mode, a permission park blocked %i min is stopped: %s (#2851)",
		async (minutes, stopped) => {
			inMode("normal");
			const state = JSON.parse(
				fs.readFileSync(at(".refill-loop-state.json"), "utf8"),
			);
			state.launches[0].block = {
				cause: "PERMISSION",
				since: Date.now() - minutes * 60 * 1000,
			};
			fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
			fakeClaude([LISTED, permissionRow]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			if (!stopped) return expectNothingActed();
			expect(readLines(at("stops"))).toEqual([`stop ${Job}`]);
			expect(readLines(at("gh-calls"))).toContainEqual(
				parkComment("PERMISSION", "normal"),
			);
		},
	);

	/** Rewrites job7's record with `over` merged in. */
	const jobAs = (over: object) =>
		fs.writeFileSync(
			jobFile(),
			JSON.stringify({
				...JSON.parse(fs.readFileSync(jobFile(), "utf8")),
				...over,
			}),
		);

	it.each([
		["auth", { detail: "Login expired — run /login", needs: null }],
		[
			"invalid_request",
			{
				detail: "API Error: 400 prompt is too long",
				needs: "request too large — /compact or trim",
			},
		],
	])(
		"stops an %s API-error park at once and comments its cause (#2851)",
		async (sub, job) => {
			jobAs(job);
			fakeClaude([LISTED, blockedRow]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			expect(readLines(at("stops"))).toEqual([`stop ${Job}`]);
			expect(readLines(at("gh-calls"))).toContainEqual(
				parkComment("API_ERROR"),
			);
			expect(launchState()).toMatchObject({
				block: { cause: "API_ERROR", sub },
				parkStopped: expect.any(Number),
			});
		},
	);

	it.each(["away", "normal"] as const)(
		"logs an UNKNOWN park's row and job shape, and stops nothing, in %s mode (#2851)",
		async (mode) => {
			inMode(mode);
			jobAs({ tempo: 7 });
			fakeClaude([LISTED, blockedRow]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			const { state, detail, needs, inFlight, cliVersion } = SeededJob;
			const job = { state, tempo: 7, detail, needs, inFlight, cliVersion };
			expect(r.stdout).toContain(
				`block unread repo /implement 7: job tempo is not a string; row ${JSON.stringify(blockedRow)}; job ${JSON.stringify(job)}`,
			);
			expectNothingActed();
			expect(launchState()).toMatchObject({ block: { cause: "UNKNOWN" } });
		},
	);

	it.each(["away", "normal"] as const)(
		"leaves a LIMIT park be in %s mode (#2851)",
		async (mode) => {
			inMode(mode);
			jobAs({ needs: "usage limit reached — check plan" });
			fakeClaude([LISTED, blockedRow]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			expectNothingActed();
			expect(launchState()).toMatchObject({ block: { cause: "LIMIT" } });
		},
	);

	it("stops nothing off an unread listing", async () => {
		fakeClaude(null);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		expectNothingActed();
	});
});

/** Ledgers job7's launch of #7 just now, the hold a hand-off releases. */
const ledgerLaunch = (job: string) => {
	const file = ledgerPath(repo);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify({ ts: new Date().toISOString(), issues: [7], prompt: "/implement 7", jobId: job })}\n`,
	);
};
const readHeldIssues = () =>
	readRecentEntries(repo, DEFAULT_WINDOW_HOURS).entries.map((e) => e.issues);
const arbiterAs = (sessionId: string, ...args: string[]) =>
	spawnSync(
		process.execPath,
		[path.join(scripts, "session-arbiter.js"), ...args],
		{
			cwd: repo,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: dir,
				CLAUDE_CONFIG_DIR: seat,
				CLAUDE_PROJECT_DIR: repo,
				WFC_REPO_ROOT: repo,
				CLAUDE_CODE_SESSION_ID: sessionId,
			},
		},
	).stdout;

const writesCopyRecord = (record: string) => {
	const jobDir = path.join(seat, "jobs", FAKE_COPY);
	return `mkdir -p ${JSON.stringify(jobDir)}; echo '${record}' > ${JSON.stringify(path.join(jobDir, "state.json"))};`;
};

/** `claude` for a resume of job `job`: `agents` lists `listing`, or fails
 * where it is null; `attach` records the line typed at it on a terminal
 * (lib/claude-attach-fake.ts); `--bg` prints the launcher's recorded
 * `resumeAs` response, a copy starting as FAKE_COPY (lib/bg-resume-fake.ts). */
const fakeResumeClaude = (
	job: string,
	listing: Row[] | null,
	onResume = "",
	resumeAs: ResumeKind = "copy",
) => {
	const response = buildRekeyedResponse(resumeAs, job, FAKE_COPY);
	fs.writeFileSync(at("bg-stdout"), response.stdout);
	fs.writeFileSync(at("bg-stderr"), response.stderr);
	writeClaudeStub(at("claude"), [
		`calls=${JSON.stringify(at("calls"))}`,
		buildAgentsBranch(listing),
		buildStopBranch(at("calls")),
		buildAttachBranch(at("calls")),
		`if [ "$1" = "--bg" ]; then echo "$*" >> "$calls"; ${onResume} cat ${JSON.stringify(at("bg-stdout"))}; cat ${JSON.stringify(at("bg-stderr"))} >&2; exit 0; fi`,
	]);
};

const oneTick = async (what: string) => {
	const running = runInProcessAsync(
		path.join(scripts, "refill-loop.js"),
		["run"],
		{
			cwd: dir,
			env: loopEnv({ WFC_GH: at("gh"), FAKE_SLOTS: "0" }),
		},
	);
	await ticked(1);
	requestStop();
	return settled(running, what);
};

describe("a launch stopped by a transient API error (#2705)", () => {
	const Job = "job7";
	const Prompt = API_PROMPT;
	const blockedRow = buildJobRow(Job, "blocked");
	const jobDir = () => path.join(seat, "jobs", Job);
	const ApiRun = "run with an API-error launch";

	/** A normal-mode loop holding one launch blocked on an API error for
	 * 2 min, its job record and transcript reading API_ERROR transient, with
	 * `resumes` as given. */
	const seed = (resumes?: object) => {
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/r" }),
		);
		const transcript = at("transcript.jsonl");
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({
				type: "assistant",
				isApiErrorMessage: true,
				message: { content: [{ type: "text", text: "API Error: 529" }] },
			})}\n`,
		);
		fs.mkdirSync(jobDir(), { recursive: true });
		fs.writeFileSync(
			path.join(jobDir(), "state.json"),
			JSON.stringify({
				state: "blocked",
				detail: "API Error: 529 overloaded",
				tempo: "blocked",
				inFlight: { tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 },
				needs: null,
				cliVersion: "2.1.309",
				sessionId: "s-job7",
				cwd: repo,
				linkScanPath: transcript,
			}),
		);
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					{
						root: repo,
						issues: [7],
						prompt: "/implement 7",
						seat,
						jobId: Job,
						launchedAt: Date.now() - 10 * 60 * 1000,
						finishedAt: null,
						parked: true,
						block: {
							cause: "API_ERROR",
							sub: "transient",
							since: Date.now() - 2 * 60 * 1000,
						},
						...(resumes ? { resumes } : {}),
					},
				],
			}),
		);
		fs.writeFileSync(
			at("gh"),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(at("gh-calls"))}\n`,
			{ mode: 0o755 },
		);
	};

	const launchState = () =>
		JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"))
			.launches[0];

	const tried = (over = {}) => ({
		tries: 1,
		triedAt: Date.now() - 60 * 1000,
		nextAt: Date.now() + 3 * 60 * 1000,
		...over,
	});

	/* A held session whose next resume is due, by stop and `--bg --resume`. */
	const heldDue = tried({
		nextAt: Date.now() - 1000,
		heldAt: Date.now() - 60 * 1000,
	});

	it("types the resume into the live session first, and comments on the issue", async () => {
		seed();
		fakeResumeClaude(Job, [LISTED, blockedRow]);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`attach ${Job}`,
			`typed ${Prompt}`,
		]);
		expect(launchState().resumes).toMatchObject({
			tries: 1,
			attachAt: expect.any(Number),
		});
		expect(readLines(at("gh-calls")).join("\n")).toMatch(
			/^issue comment 7 --repo o\/r --body Refill loop: resume 1 of 16 after an API error, repo \/implement 7, by typing into the live session; next due /,
		);
	});

	it("falls back to stop and --bg --resume where the typed resume never reached the timeline", async () => {
		seed(tried({ attachAt: Date.now() - 2 * 60 * 1000 }));
		fakeResumeClaude(Job, [LISTED, blockedRow]);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`stop ${Job}`,
			`--bg --resume s-job7 ${Prompt}`,
		]);
		expect(launchState().resumes).toEqual({
			tries: 1,
			triedAt: expect.any(Number),
			nextAt: expect.any(Number),
		});
		expect(r.stdout).toMatch(
			/resume 1 of 16 after an API error, repo \/implement 7, by stop and --bg --resume, the typed one unseen/,
		);
	});

	it("refuses the --bg --resume where its auth would not bill the subscription (#2236)", async () => {
		seed(tried({ attachAt: Date.now() - 2 * 60 * 1000 }));
		fakeResumeClaude(Job, [LISTED, blockedRow]);
		writeSeatHelper(seat);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([`stop ${Job}`]);
		expect(r.stdout).toMatch(
			/could not resume .*an apiKeyHelper setting is in force.*#2236/,
		);
	});

	it("leaves a typed resume that reached the timeline", async () => {
		const attachAt = Date.now() - 2 * 60 * 1000;
		seed(tried({ attachAt }));
		fs.writeFileSync(
			path.join(jobDir(), "timeline.jsonl"),
			`${JSON.stringify({
				at: new Date(attachAt + 1000).toISOString(),
				state: "blocked",
				detail: Prompt,
				text: "",
			})}\n`,
		);
		fakeResumeClaude(Job, [LISTED, blockedRow]);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([]);
		expect(launchState().resumes).not.toHaveProperty("attachAt");
	});

	it("checks no typed resume off an unread listing", async () => {
		seed(tried({ attachAt: Date.now() - 2 * 60 * 1000 }));
		fakeResumeClaude(Job, null);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([]);
		expect(launchState().resumes).toHaveProperty("attachAt");
	});

	it("stops a session blocked again until its next resume", async () => {
		seed(tried({ tries: 2, triedAt: Date.now() - 5 * 60 * 1000 }));
		fakeResumeClaude(Job, [LISTED, blockedRow]);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([`stop ${Job}`]);
		expect(launchState().resumes).toMatchObject({
			tries: 2,
			heldAt: expect.any(Number),
		});
		expect(r.stdout).toMatch(
			/stopped repo \/implement 7 until its next resume/,
		);
	});

	it("relaunches a held session, judging it by state.json, not the launcher's exit", async () => {
		seed(heldDue);
		const failed = JSON.stringify({
			state: "failed",
			detail: "source session s-job7 not found",
		});
		fakeResumeClaude(Job, [LISTED], writesCopyRecord(failed));
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`stop ${Job}`,
			`--bg --resume s-job7 ${Prompt}`,
		]);
		expect(r.stdout).toMatch(
			/could not resume 2 of 16 after an API error, repo \/implement 7, by stop and --bg --resume: state failed: source session s-job7 not found/,
		);
		expect(launchState()).toMatchObject({
			finishedAt: null,
			resumes: { tries: 2, heldAt: expect.any(Number) },
		});
	});

	it("tracks the copy a held session's resume starts as the launch's job, its claim and ledger hold kept (#2963)", async () => {
		seed(heldDue);
		ledgerLaunch(Job);
		arbiterAs("s-job7", "claim-issue", "7");
		fakeResumeClaude(
			Job,
			[LISTED],
			writesCopyRecord(
				JSON.stringify({ state: "working", sessionId: "s-copy" }),
			),
		);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`stop ${Job}`,
			`--bg --resume s-job7 ${Prompt}`,
		]);
		expect(readHeldIssues()).toEqual([[7]]);
		expect(launchState()).toMatchObject({
			jobId: FAKE_COPY,
			copiedFrom: Job,
			relaunchedAt: expect.any(Number),
			sessionId: "s-copy",
			pastSessionIds: ["s-job7"],
			finishedAt: null,
			resumes: { tries: 2 },
		});
		expect(r.stdout).toMatch(
			/resume 2 of 16 after an API error, repo \/implement 7, by stop and --bg --resume, as its copy c0de7a11/,
		);
		const claims = arbiterAs("s-copy", "issue-claims");
		expect(claims).toContain("s-copy");
		expect(claims).not.toContain("s-job7");
	});

	it("tracks a held job its resume wakes in place under its own job and claim, never as a copy (#2968, #2987)", async () => {
		seed(heldDue);
		arbiterAs("s-job7", "claim-issue", "7");
		fakeResumeClaude(Job, [LISTED], "", "woke");
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`stop ${Job}`,
			`--bg --resume s-job7 ${Prompt}`,
		]);
		const state = launchState();
		expect(state).toMatchObject({
			jobId: Job,
			sessionId: "s-job7",
			finishedAt: null,
			relaunchedAt: expect.any(Number),
			resumes: { tries: 2 },
		});
		expect(state).not.toHaveProperty("copiedFrom");
		expect(state).not.toHaveProperty("pastSessionIds");
		expect(r.stdout).toMatch(/by stop and --bg --resume, woken in place/);
		expect(r.stdout).not.toMatch(/as its copy/);
		const comments = readLines(at("gh-calls")).join("\n");
		expect(comments).toMatch(/by stop and --bg --resume, woken in place/);
		expect(comments).not.toMatch(/as its copy/);
		expect(arbiterAs("s-job7", "issue-claims")).toContain("s-job7");
	});

	it("reads a launcher line naming no copy as a failed resume, the session held for its next (#2963)", async () => {
		seed(heldDue);
		fakeResumeClaude(Job, [LISTED], `echo "backgrounded · ${Job}"; exit 0;`);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/could not resume .*: the launcher never said what it started: backgrounded · job7/,
		);
		expect(launchState()).toMatchObject({
			jobId: Job,
			finishedAt: null,
			resumes: { heldAt: expect.any(Number) },
		});
	});
});

describe("a session its host restarted that never takes a turn (#2707, #2978)", () => {
	const Job = "job7";
	const Prompt = IDLE_PROMPT;
	const IdleRun = "run with a resumed-idle launch";
	const Min = 60 * 1000;
	const workingRow = buildJobRow(Job, "working");
	const jobDir = () => path.join(seat, "jobs", Job);
	const transcript = () => at("transcript.jsonl");

	/** A launch whose job reads `working` and whose transcript holds the
	 * harness's stopped-shell restart row `minutes` old after its last turn,
	 * an attachment row after it; the file itself written just now, so only
	 * the row's own time can age it. `idleResumes` as given; the hand-off stubbed to record its call and
	 * exit `handOffExit`. */
	const seed = (minutes: number, idleResumes?: object, handOffExit = 0) => {
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/r" }),
		);
		const entry = Date.now() - minutes * Min;
		fs.writeFileSync(
			transcript(),
			`${[
				{
					type: "assistant",
					isSidechain: false,
					timestamp: new Date(entry - Min).toISOString(),
					message: { content: [{ type: "text", text: "Waiting on it." }] },
				},
				{
					type: "user",
					isSidechain: false,
					timestamp: new Date(entry).toISOString(),
					origin: { kind: "task-notification" },
					message: {
						role: "user",
						content:
							"<task-notification>\n<status>stopped</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>",
					},
				},
				{
					type: "attachment",
					isSidechain: false,
					timestamp: new Date().toISOString(),
				},
				{ type: "cost-state", totalCostUSD: 1 },
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		fs.mkdirSync(jobDir(), { recursive: true });
		fs.writeFileSync(
			path.join(jobDir(), "state.json"),
			JSON.stringify({
				state: "working",
				tempo: "idle",
				detail: "",
				cliVersion: "2.1.309",
				sessionId: "s-job7",
				cwd: repo,
				linkScanPath: transcript(),
			}),
		);
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					{
						root: repo,
						issues: [7],
						prompt: "/implement 7",
						seat,
						jobId: Job,
						launchedAt: Date.now() - 30 * Min,
						finishedAt: null,
						...(idleResumes ? { idleResumes } : {}),
					},
				],
			}),
		);
		fs.writeFileSync(
			at("gh"),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(at("gh-calls"))}\n`,
			{ mode: 0o755 },
		);
		stub(
			"rescue-sessions.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("hand-offs"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.stdout.write("commented: #7\\n");
process.exit(${handOffExit});\n`,
		);
	};

	const launchState = () =>
		JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"))
			.launches[0];
	const readHandOffs = () =>
		readLines(at("hand-offs")).map((l) => JSON.parse(l));
	it("types the resume once the restart row has waited 5 min, aged by the row, not the file", async () => {
		seed(6);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`attach ${Job}`,
			`typed ${Prompt}`,
		]);
		expect(launchState().idleResumes).toEqual({
			tries: 1,
			triedAt: expect.any(Number),
		});
		expect(r.stdout).toMatch(
			/resumed repo \/implement 7, idle since its host's restart, by typing into the live session, try 1 of 2/,
		);
		expect(readLines(at("gh-calls"))).toEqual([
			expect.stringMatching(
				/^issue comment 7 --repo o\/r --body Refill loop: resumed repo \/implement 7/,
			),
		]);
	});

	it("stops and holds the restarted session under the swap hold instead of typing into it (#3093)", async () => {
		seed(1);
		fs.writeFileSync(at("meminfo"), MEMINFO_HOLD);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		/* Every call a stop, never a typed resume: the stub's listing still
		 * shows the job working after it, so a second tick may stop it again. */
		const calls = readLines(at("calls"));
		expect(calls.length).toBeGreaterThan(0);
		expect(new Set(calls)).toEqual(new Set([`stop ${Job}`]));
		expect(launchState().swapHeld).toEqual({
			at: expect.any(Number),
			sessionId: "s-job7",
			cwd: repo,
			tries: 0,
		});
		expect(r.stdout).toMatch(
			/stopped repo \/implement 7, restarted by its host, under the swap hold \(swap is 256 of 2048 MB free and 1024 MB available\), until the hold clears/,
		);
	});

	it("resumes a session held under the swap hold on the first tick after it clears (#3093)", async () => {
		/* The program's own round trip: `swapHeld` read back from its state
		 * file, and its stored target through the real resume call. */
		seed(30);
		const state = JSON.parse(
			fs.readFileSync(at(".refill-loop-state.json"), "utf8"),
		);
		state.launches[0].swapHeld = {
			at: Date.now() - 10 * Min,
			sessionId: "s-job7",
			cwd: repo,
			tries: 0,
		};
		fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
		fakeResumeClaude(Job, [LISTED]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([`--bg --resume s-job7 ${Prompt}`]);
		expect(launchState()).not.toHaveProperty("swapHeld");
		expect(launchState()).toMatchObject({ finishedAt: null, jobId: FAKE_COPY });
	});

	it("ages the row by the main chain, a subagent's later entry aside", async () => {
		seed(6);
		fs.appendFileSync(
			transcript(),
			`${JSON.stringify({ type: "user", isSidechain: true, timestamp: new Date().toISOString() })}\n`,
		);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`attach ${Job}`,
			`typed ${Prompt}`,
		]);
	});

	it("waits while the row is under 5 min old, however old the file", async () => {
		seed(4);
		const old = new Date(Date.now() - 60 * Min);
		fs.utimesSync(transcript(), old, old);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([]);
		expect(launchState()).not.toHaveProperty("idleResumes");
	});

	it("types into it off an unread listing, and stops nothing", async () => {
		seed(6);
		fakeResumeClaude(Job, null);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`attach ${Job}`,
			`typed ${Prompt}`,
		]);
	});

	it("reads a trailing delivery row with no restart row as no idle (#2976 class A)", async () => {
		seed(6);
		const rows = fs
			.readFileSync(transcript(), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		rows[1] = {
			type: "user",
			isSidechain: false,
			isMeta: true,
			timestamp: rows[1].timestamp,
			origin: { kind: "plugin", name: "wfc-delivery" },
			message: {
				role: "user",
				content: [{ type: "text", text: "Delivered by the wfc-delivery mod" }],
			},
		};
		fs.writeFileSync(
			transcript(),
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([]);
		expect(launchState()).not.toHaveProperty("idleSince");
	});

	it("types once more into a session still idle 5 min after its typed resume, never stopping it", async () => {
		seed(6, { tries: 1, triedAt: Date.now() - 5 * Min });
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`attach ${Job}`,
			`typed ${Prompt}`,
		]);
		expect(launchState().idleResumes).toEqual({
			tries: 2,
			triedAt: expect.any(Number),
		});
		expect(readHandOffs()).toEqual([]);
	});

	it("stops nothing once the session took a turn after the loop's resume, ending its episode (#2979)", async () => {
		seed(6, { tries: 2, triedAt: Date.now() - 2 * Min });
		fs.appendFileSync(
			transcript(),
			`${JSON.stringify({ type: "api-request", timestamp: new Date(Date.now() - Min).toISOString() })}\n`,
		);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).not.toContain(`stop ${Job}`);
		expect(readHandOffs()).toEqual([]);
		expect(launchState()).not.toHaveProperty("idleResumes");
	});

	it("hands off a copy still idle under its own job, releasing the hold its first job took (#2963)", async () => {
		seed(6, { tries: 2, triedAt: Date.now() - 6 * Min });
		const copyDir = path.join(seat, "jobs", FAKE_COPY);
		fs.mkdirSync(copyDir, { recursive: true });
		fs.copyFileSync(
			path.join(jobDir(), "state.json"),
			path.join(copyDir, "state.json"),
		);
		const state = JSON.parse(
			fs.readFileSync(at(".refill-loop-state.json"), "utf8"),
		);
		Object.assign(state.launches[0], {
			jobId: FAKE_COPY,
			copiedFrom: Job,
			relaunchedAt: Date.now() - 8 * Min,
		});
		fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
		ledgerLaunch(Job);
		fakeResumeClaude(FAKE_COPY, [LISTED, { ...workingRow, id: FAKE_COPY }]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([`stop ${FAKE_COPY}`]);
		expect(readHandOffs()[0]?.args).toEqual([
			"hand-off",
			"--from",
			seat,
			"--job",
			FAKE_COPY,
			"--issue",
			"7",
		]);
		expect(readHeldIssues()).toEqual([]);
	});

	it("hands off a session still idle after its two typed resumes: stop, snapshot comment, claim released, launch finished", async () => {
		seed(6, { tries: 2, triedAt: Date.now() - 6 * Min });
		ledgerLaunch(Job);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([`stop ${Job}`]);
		expect(readHeldIssues()).toEqual([]);
		expect(readHandOffs()).toEqual([
			{
				args: ["hand-off", "--from", seat, "--job", Job, "--issue", "7"],
				cwd: fs.realpathSync(repo),
			},
		]);
		expect(launchState()).toMatchObject({
			finishedAt: expect.any(Number),
			handedOff: expect.any(Number),
		});
		expect(r.stdout).toMatch(
			/stopped repo \/implement 7, idle after its resume, and handed it off: exit 0\n {2}commented: #7/,
		);
	});

	it("never stops or hands off off an unread listing", async () => {
		seed(6, { tries: 2, triedAt: Date.now() - 6 * Min });
		fakeResumeClaude(Job, null);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([]);
		expect(readHandOffs()).toEqual([]);
		expect(launchState().finishedAt).toBeNull();
	});

	it("retries a failed hand-off on later ticks without stopping again", async () => {
		seed(6, { tries: 2, triedAt: Date.now() - 6 * Min }, 1);
		ledgerLaunch(Job);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([`stop ${Job}`]);
		expect(readHeldIssues()).toEqual([[7]]);
		expect(readHandOffs().length).toBeGreaterThanOrEqual(1);
		expect(launchState().handOffTries).toBeGreaterThanOrEqual(1);
	});

	it("gives up on a hand-off failed three times and finishes the launch, its ledger hold kept", async () => {
		seed(6, undefined, 1);
		const state = JSON.parse(
			fs.readFileSync(at(".refill-loop-state.json"), "utf8"),
		);
		state.launches[0].handOffTries = 2;
		fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
		ledgerLaunch(Job);
		fakeResumeClaude(Job, [LISTED, workingRow]);
		const r = await oneTick(IdleRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([]);
		expect(readHandOffs()).toHaveLength(1);
		expect(readHeldIssues()).toEqual([[7]]);
		expect(launchState()).toMatchObject({
			finishedAt: expect.any(Number),
			handedOff: expect.any(Number),
		});
		expect(launchState()).not.toHaveProperty("handOffTries");
		expect(r.stdout).toMatch(
			/gave up handing off repo \/implement 7 after 3 tries/,
		);
	});
});

describe("a daemon whose cwd is outside every checkout (#2937)", () => {
	beforeEach(() => {
		for (const f of [
			"allowance.js",
			...readProgramLibs("allowance.js").map((l) => `lib/${l}`),
		])
			fs.copyFileSync(path.join(__dirname, f), path.join(scripts, f));
		// Past the week ceiling, so the cap reads the cost table.
		weekAt(98);
	});

	const writeTable = (root: string) => {
		fs.mkdirSync(path.join(root, "docs", "data"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "docs", "data", "session-cost-table.json"),
			JSON.stringify({
				n: 2,
				meanUsd: 0.01,
				quantilesUsd: [0.01, 0.01],
				tailRemainderUsd: 0.01,
				landedByHours: [[1, 1]],
			}),
		);
	};

	const dryRun = () => {
		const env = loopEnv({ FAKE_SLOTS: "1" });
		delete env.CLAUDE_PROJECT_DIR;
		delete env.WFC_REPO_ROOT;
		delete env.WFC_SESSION_COST_TABLE;
		return runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["dry-run"],
			{ cwd: dir, env },
		);
	};

	it("sizes the warned seat from the served checkout's cost table", async () => {
		writeTable(repo);
		const r = await dryRun();
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("unsized");
		expect(r.stdout).toContain(`would run in ${repo} on ${seat}`);
	});

	it("logs a checkout with no cost table as a fault, not a full seat", async () => {
		const r = await dryRun();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`fault: cap on ${seat} unsized: the session cost table is unreadable`,
		);
		expect(r.stdout).toContain("no seat with room has a sized allowance cap");
	});

	it("logs a loop serving no checkout as a fault", async () => {
		const control = at(".refill-loop-control.json");
		fs.writeFileSync(
			control,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(control, "utf8")),
				scope: { mode: "normal", repos: [], exclude: [], goals: {} },
			}),
		);
		const r = await dryRun();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`fault: cap on ${seat} unsized: the loop serves no checkout to size it in`,
		);
	});
});
