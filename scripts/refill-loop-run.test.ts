// @vitest-environment node
/*
 * The refill loop's `run` driven end to end (#2435): tick()'s wiring into
 * lib/refill-tick-core.js's runTick, which #2286 tests only from fixtures, and
 * run()'s exit on a returned stop or a stop's wake.
 *
 * The program and its lib/ closure are copied into a sandbox `scripts/`, its
 * children stubbed beside it: admission, the allowance cap, the reap, the
 * shortlist, the gate check and the dispatcher are all found from the
 * program's own directory. The cwd-outside-every-checkout case runs the real
 * allowance.js, as only it reads the host's cost table (#2937). The copy is
 * no git checkout, so run() adopts no newer code, and the morning review's
 * root is the sandbox, with no config, so no tick files a review on a real
 * tracker.
 *
 * Loosen it and a fault in the program's own wiring, of its libs, children
 * and exits, passes unseen (#2851).
 *
 * Why each case stays a full tick (§X8 (5), §X11): every branch a module can
 * own runs in-process in its module's test (#4282, #4314–#4316). A case below
 * is a production adapter crossed for real (A), an exit path or input channel
 * (E), a spawn shape — a signal, or a second live process holding the pid
 * or control lock (S), a §N5 fail-open (F), a boundary regression (R), or a
 * branch still in lib/refill-tick.js's or refill-loop.js's shell, with no
 * core entry to test it from (B, #4356).
 * - run (#2435): ends at a mid-dispatch stop E; appends the concurrency
 *   record A; supervises a foreign checkout's launches B; tracks a launch a
 *   kill cut off S R; tickets earlyoom's and memwatch's incidents A (two
 *   children); the review child launches detached S, a second runner exits S;
 *   ticks on a wake line E.
 * - panel (#4060): keeps a failed probe's figure A (usage-probe.js).
 * - dry run (#2611): prints the overflow dispatch E (the dry-run argv), A.
 * - overflow allowance (#3698): stops one past it A (`claude stop`);
 *   records the listed id B.
 * - Console read (#4071): starts the read A; none where its row will not
 *   write F; none on a dry run B.
 * - goal (#3864): reads the frontier bare once cleared A (pick-next argv).
 * - parked launch (#2699, #3940): unlabels where it ended unblocked A; out of
 *   scope (#3950) B, opted out B; an unreadable transcript F;
 *   closed issues A, an unreadable closed list F; stops an away park once A;
 *   the #4147 key in its marker B; a hold-attached park B; the permission
 *   cause B; the UNKNOWN line across ticks B.
 * - API error (#2705): types into the live session A (attach, pty_type.py);
 *   the auth refusal B; judged by state.json A; the overflow copy's key B;
 *   the copy tracked as the job A; a launcher line naming no job B; pass
 *   markers moved A, kept with the open past id B.
 * - limit hold (#3735): resumes under its seat A; held where state.json reads
 *   stopped B or another session B; the ledger hold A and its swap A; moved
 *   to another plan seat A, unconfirmed B, an uncopied transcript B; onto a
 *   key A, its first overflow start A, an unwritable ledger row B.
 * - host restart (#2707): types after 5 min A; stops under the swap hold A;
 *   a cleared swap hold resumes A, a refused re-read A (admission --launch),
 *   a copy handed off B, a session handed off A (rescue-sessions.js).
 * - daemon cwd (#2937): sizes the seat from the served checkout's cost
 *   table A R (the real allowance.js).
 * - normal-mode park (#3621): resumes in place A, on its cause's prompt A,
 *   noting the ledger's acts B, the marker handed on A or kept F; resumes
 *   from its marker (#3773) B ×3; launches afresh with no job A; an away
 *   park's ledger row released before the shortlist B (#3872).
 * - `set --resume` (#3861): restarts E, refuses a damaged control E, exits
 *   1 on no launch E. `start` (#3868): --unless-stopped E.
 * - a case's end (#4140): this file's own teardown, owned by no module.
 * - boot-resume (#3878): restarts E, no second loop E, exits 1 E; watch
 *   (#4139): restarts the unit A (systemctl), a live holder B, a launch in
 *   flight S, a damaged control B, exits 1 E; no lock (#4083): exits 1 E S,
 *   keeps the crash B, names the holder S, `start` exits 1 E.
 * - paused (#3856): clears an older stop B, crossing the reap A;
 *   resumes with no restart S. Opted out (#4188): unticks A. Away (#3870):
 *   the lock held by another writer S; a dry run writes nothing B. Waits
 *   (#3859): pauses on no progress, resumed by `set --resume` A S.
 * - repo hold (#3857): its command run for real A; none on a dry run B.
 *   Probe hold (#3860): a broken .git A, the other checkout A, the state's
 *   probe A, its parked resumed A, none on a dry run B. Guard entry (#4226):
 *   raises and files A, attaches and resumes A.
 * - cleared repo hold (#3863): its resume step is the shell's B ×7.
 * - restart's kills (#3880): resumed by id A, a copy a kill beat S R, set
 *   off by boot-resume R; the manager's restart (#3971) A ×3; a resumed
 *   session typed A, handed off A; a job no transcript backs A.
 * - phone notice (#3871): one on raise, one on clear A (gh workflow).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import { ADMISSION_VERDICT } from "./lib/admission-verdict-fake";
import {
	buildAgentsBranch,
	buildJobRow,
	buildListedRow,
	buildPermissionRow,
	buildStopBranch,
	type Row,
} from "./lib/agents-stop-fake";
import { readCurrentBootId, readProcStartOf } from "./lib/arbiter-proc.js";
import { writeSeatHelper } from "./lib/auth-status-fake";
import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
} from "./lib/bg-resume-fake";
import { buildAttachBranch } from "./lib/claude-attach-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { writeCostTable } from "./lib/cost-table-testkit";
import {
	DEFAULT_WINDOW_HOURS,
	ledgerPath,
	readOverflowLookup,
	readRecentEntries,
	record as recordDispatch,
} from "./lib/dispatch-ledger.js";
import { readGhAnswer } from "./lib/gh-fake";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import {
	API_PROMPT,
	BOOT_PROMPT,
	HOLD_PROMPT,
	IDLE_PROMPT,
	LIMIT_PROMPT,
	MOVED_PROMPT,
	parkedPromptOf,
} from "./lib/loop-prompts.js";
import { buildMeminfo } from "./lib/meminfo-fake";
import { REAL_PROC } from "./lib/proc-root.js";
import { projectSlug } from "./lib/project-slug.js";
import { parseHoldId, probedCheckout } from "./lib/repo-hold-fixture";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import { killCarrying, killPid } from "./lib/suite-ceiling.js";
import { OUTCOME_PREFIX } from "./lib/usage-probe.js";
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

const LOGGED_OUT = path.join(__dirname, "lib/fixtures/gh/logged-out.json");

let dir: string;
/* A run that outlived its stop is left its sandbox: deleting it under the
 * running loop exits the worker, hiding the failure. */
let outlived = false;
/* The in-process loop a case has not yet seen end. */
let liveRun: Promise<unknown> | null = null;
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
	WFC_DISPATCH_STAGGER_SECONDS: "0",
	WFC_GUARD_PROBE_RETRY_MS: "0",
	GITHUB_ACTIONS: "",
	...over,
});

const PARKED_PROMPT = parkedPromptOf(undefined);

const markerPath = (session: string, root = repo) =>
	path.join(root, ".claude", "tmp", "markers", `.parked-${session}`);

const readLines = (file: string) =>
	fs.existsSync(file)
		? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];

/* The stub gh's calls, each tick's own read for closed parks aside. */
const readGhActs = () =>
	readLines(at("gh-calls")).filter(
		(l) =>
			!l.startsWith("issue list --repo o/r --state closed --label parked "),
	);

/** A node stub at `name` in the sandbox scripts/. */
const stub = (name: string, body: string) =>
	fs.writeFileSync(path.join(scripts, name), body);

/* Once per file, not per case: the closure walk is the cost (#4282). */
const SANDBOX_FILES = [
	...new Set([
		"refill-loop.js",
		...readProgramLibs("refill-loop.js").map((l) => `lib/${l}`),
		/* Spawned by path, not required: lib/agent-liveness.js runs the listing
		 * through it, which reads unread without it. */
		"lib/list-agents.js",
		/* Spawned by path: the resume typed into a live session (#2705). */
		"pty_type.py",
		/* Spawned by path: a copy's issue claims moved (#2963). */
		"session-arbiter.js",
		...readProgramLibs("session-arbiter.js").map((l) => `lib/${l}`),
	]),
];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-run-"));
	/* The swap hold off, so no run reads the machine's own memory (#3093). */
	fs.writeFileSync(at("meminfo"), MEMINFO_NO_HOLD);
	scripts = at("code/scripts");
	fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
	for (const f of SANDBOX_FILES)
		fs.copyFileSync(path.join(__dirname, f), path.join(scripts, f));

	repo = at("repo");
	probedCheckout.instantiate(repo);
	fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".claude", "workflow-core.json"), "{}\n");
	seat = at("seat");
	fs.mkdirSync(seat);
	// Fresh and low, so no tick probes /usage or waits on a full seat.
	weekAt(10);
	fs.writeFileSync(
		at(".refill-loop-control.json"),
		JSON.stringify({
			noProgressFrom: Date.now(),
			stopRequested: false,
			seats: [seat],
			scope: { mode: "normal", repos: [repo], goal: null },
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
		"level-main.js",
		`require("node:fs").appendFileSync(${JSON.stringify(at("levelled"))}, process.cwd() + " " + process.argv.slice(2).join(" ") + "\\n");\n`,
	);
	stub(
		"pick-next.js",
		`process.stdout.write(JSON.stringify({
	frontier: [{ number: 5, urgent: false, goal: false, stallDays: 0, asksQuestions: false, reach: 0, collision: "", takes: ["implement"], labels: [] }],
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
	running: [],
}));\n`,
	);
	/* What `stop` writes: the control's flag, then a wake line. Not `stop`
	 * itself, which wakes only a loop whose pid's command line names the
	 * program, and `run`'s loop runs inside the test worker. */
	const control = JSON.stringify(at(".refill-loop-control.json"));
	stub(
		"request-stop.js",
		`const fs = require("node:fs");
fs.writeFileSync(${control}, JSON.stringify({ ...JSON.parse(fs.readFileSync(${control}, "utf8")), stopRequested: true }));
fs.appendFileSync(${JSON.stringify(at(".refill-loop-wake"))}, \`\${Date.now()}\\n\`);\n`,
	);
	stub(
		"dispatch-sessions.sh",
		`printf '%s\\n' "$*" >> ${shellQuote(at("dispatches"))}
node ${shellQuote(path.join(scripts, "request-stop.js"))}\n`,
	);
	writeClaudeStub(at("claude"), [buildAgentsBranch([LISTED])]);
});

/*
 * Whichever way a case ended, nothing it started outlives it (#4140). An
 * in-process loop can only be asked to stop. Any other process's environment
 * names the sandbox, a tie no stale pidfile can point at a neighbour; it is read
 * again until none is left, as a zombie's environ reads empty. Only then does the
 * sandbox go, taking the control file a stop would need.
 */
afterEach(async () => {
	const running = liveRun;
	liveRun = null;
	if (running && !outlived) {
		requestStop();
		outlived = !(await within(running)).done;
	}
	const keep = outlived;
	outlived = false;
	await polled(() => {
		let killed = 0;
		const unkilled = killCarrying("WFC_REFILL_DIR", dir, {
			proc: REAL_PROC,
			kill: (pid: number, signal: NodeJS.Signals) => {
				killed += 1;
				killPid(pid, signal);
			},
		});
		if (unkilled) throw new Error(`${dir}: ${unkilled}`);
		return killed === 0;
	}, `a process of ${dir} outlived its SIGKILL`);
	if (!keep) fs.rmSync(dir, { recursive: true, force: true });
});

const run = (slots: number, over: NodeJS.ProcessEnv = {}) => {
	const running = runInProcessAsync(
		path.join(scripts, "refill-loop.js"),
		["run"],
		{
			cwd: dir,
			env: loopEnv({ FAKE_SLOTS: String(slots), ...over }),
		},
	);
	const forget = () => {
		if (liveRun === running) liveRun = null;
	};
	liveRun = running;
	running.then(forget, forget);
	return running;
};

/* spawn-kept: another live process, its command line naming the program, or
 * pid-lock reads it as stale. */
const spawnIdleHolder = (env: NodeJS.ProcessEnv) =>
	spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
		{ env, stdio: "ignore" },
	);

/* For a case that runs `set --resume` against the loop: pid-lock reads the
 * holder's own command line, so an in-process run reads as no process and the
 * resume starts a second, detached loop (#3943). */
const runAsProcess = (slots: number) => {
	// spawn-kept: two processes at once, and pid-lock reads the holder's command line.
	const child = spawn(
		process.execPath,
		[path.join(scripts, "refill-loop.js"), "run"],
		{
			cwd: dir,
			env: loopEnv({ FAKE_SLOTS: String(slots) }),
			stdio: "ignore",
		},
	);
	return new Promise<{ status: number | null }>((resolve) => {
		child.on("exit", (status) => resolve({ status }));
	});
};

/* A guess: some 30 times a case's 0.7 s run, and well inside the loop's
 * fallback sleep (lib/refill-wake.js's FALLBACK_MS), so a loop still running
 * past it is waiting on that sleep, not ending. */
const SETTLE_MS = 20 * 1000;

const requestStop = () =>
	/* spawn-kept: two processes at once — the stop lands while the loop is
	 * still running in-process, which holds runInProcess's claim. */
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

/* A guess: short against a tick, cheap against SETTLE_MS. */
const POLL_MS = 50;

/** Resolves once `isDone` holds, or throws `neverMessage` once SETTLE_MS passes. */
const polled = async (isDone: () => boolean, neverMessage: string) => {
	const deadline = Date.now() + SETTLE_MS;
	while (!isDone()) {
		if (Date.now() > deadline) throw new Error(neverMessage);
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
};

/** Resolves once the stub admission has been asked `n` times. */
const ticked = (n: number) =>
	polled(() => readLines(at("ticks")).length >= n, `tick ${n} never ran`);

const readStopped = () =>
	JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8")).stopped;

describe("run (#2435)", () => {
	it("ends at the tick whose dispatch a stop landed in, recorded explicit", async () => {
		const r = await settled(run(1), "run after a mid-dispatch stop");
		expect(r.status).toBe(0);
		// The tick supervised the served repo's landing queue, in it (#2692).
		expect(readLines(at("supervised"))).toEqual([fs.realpathSync(repo)]);
		// And started a levelling pass over its main checkout, in it (#4248).
		await polled(
			() => readLines(at("levelled")).length > 0,
			"no levelling pass started",
		);
		expect(readLines(at("levelled"))).toEqual([
			`${fs.realpathSync(repo)} --quiet`,
		]);
		expect(r.stdout).toContain(
			`landing in ${repo}: exit 0\n  started the lander`,
		);
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
		expect(readLines(at("ticks"))).toHaveLength(1);
		expect(readStopped()).toMatchObject({ reason: "explicit" });
		// The sandbox has neither review script: a run of one logs an exit.
		expect(r.stdout).not.toMatch(/morning review( reversals)?: exit/);
	});

	it("appends each tick's line to the concurrency record (#3317)", async () => {
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

	it("tracks a launch a kill cut off between the dispatcher's start and the state write (#4180)", async () => {
		const file = ledgerPath(repo);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		/* The dispatcher launches, then the loop dies before it reads the
		 * ledger back: a real SIGKILL on the loop, the dispatcher's parent. */
		stub(
			"dispatch-sessions.sh",
			`printf '{"ts":"%s","issues":[5],"prompt":"/implement 5","jobId":"job5"}\\n' "$(date -u +%FT%TZ)" >> ${shellQuote(file)}
printf '%s\\n' "$*" >> ${shellQuote(at("dispatches"))}
kill -9 $PPID\n`,
		);
		/* spawn-kept: the kill needs a loop of its own process to land on. */
		const killed = spawn(
			process.execPath,
			[path.join(scripts, "refill-loop.js"), "run"],
			{ cwd: dir, env: loopEnv({ FAKE_SLOTS: "1" }), stdio: "ignore" },
		);
		const signal = await new Promise((done) =>
			killed.on("exit", (_, sig) => done(sig)),
		);
		const stateFile = at(".refill-loop-state.json");
		const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
		expect(signal).toBe("SIGKILL");
		expect(readState().launches).toEqual([]);
		expect(readState().launching.batch).toMatchObject([
			{ prompt: "/implement 5" },
		]);

		stub(
			"dispatch-sessions.sh",
			`printf '%s\\n' "$*" >> ${shellQuote(at("dispatches"))}\n`,
		);
		/* job5 fills the one slot, so nothing launches to ask for the stop. */
		requestStop();
		const r = await settled(run(1), "run after a killed launch");

		expect(r.status).toBe(0);
		expect(readState().launches).toEqual([
			expect.objectContaining({
				prompt: "/implement 5",
				jobId: "job5",
				finishedAt: null,
			}),
		]);
		expect(readState()).not.toHaveProperty("launching");
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
		expect(readState().launchCount.count).toBe(1);
		expect(r.stdout).toMatch(
			/repo \/implement 5's launch at .* started job job5, which a kill left out of the state: tracking it/,
		);
	});

	/** Gives the sandbox's code root, the review root, a workflow-core config. */
	const configureCodeRoot = () => {
		const code = path.dirname(scripts);
		fs.mkdirSync(path.join(code, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(code, ".claude", "workflow-core.json"), "{}\n");
		return code;
	};

	it("tickets earlyoom's kill incidents in its own checkout each tick (#3094)", async () => {
		const code = configureCodeRoot();
		stub(
			"file-memory-kill-tickets.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("kill-filer"))}, process.cwd() + "\\n");
process.stdout.write("Memory kill incident from 2026-10-26 03:56: filed #9.");\n`,
		);
		stub("file-morning-review.js", "");
		stub("answer-review-reversals.js", "");
		const r = await settled(run(1), "run filing kill tickets");
		expect(r.status).toBe(0);
		expect(readLines(at("kill-filer"))).toEqual([fs.realpathSync(code)]);
		expect(r.stdout).toContain(
			"memory kills: exit 0\n  Memory kill incident from 2026-10-26 03:56: filed #9.",
		);
	});

	it("tickets memwatch's process runaways in its own checkout each tick (#3807)", async () => {
		const code = configureCodeRoot();
		stub("file-memory-kill-tickets.js", "");
		stub(
			"file-process-runaway-tickets.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("runaway-filer"))}, process.cwd() + "\\n");
process.stdout.write("Process runaway from 2026-10-29 19:07 UTC: filed #9.");\n`,
		);
		stub("file-morning-review.js", "");
		stub("answer-review-reversals.js", "");
		const r = await settled(run(1), "run filing runaway tickets");
		expect(r.status).toBe(0);
		expect(readLines(at("runaway-filer"))).toEqual([fs.realpathSync(code)]);
		expect(r.stdout).toContain(
			"process runaways: exit 0\n  Process runaway from 2026-10-29 19:07 UTC: filed #9.",
		);
	});

	describe("the morning review child a tick runs (#3405)", () => {
		/* An Etc/GMT zone where the local hour is now `hour`, and its local
		 * date. The offset spans -12..11, all valid zones; Etc/GMT's sign is
		 * inverted. */
		const zoneAt = (hour: number) => {
			const offset = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
			return {
				zone: `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`,
				today: new Date(Date.now() + offset * 3600 * 1000)
					.toISOString()
					.slice(0, 10),
			};
		};

		/* The control `start` writes, so a run after a stopped one ticks. */
		const restart = () => {
			const file = at(".refill-loop-control.json");
			fs.writeFileSync(
				file,
				JSON.stringify({
					...JSON.parse(fs.readFileSync(file, "utf8")),
					stopRequested: false,
				}),
			);
		};

		const resultFile = () => at(".refill-review-result.json");

		const appeared = (file: string) =>
			polled(() => fs.existsSync(file), `${file} never appeared`);

		const buildReviewRecorder = (name: string) =>
			`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(at("reviews"))}, ${JSON.stringify(`${name}\n`)});`;

		/** The runner and a filing stub holding until `release` exists. */
		const stubHeldFiling = () => {
			configureCodeRoot();
			fs.copyFileSync(
				path.join(__dirname, "refill-review-run.js"),
				path.join(scripts, "refill-review-run.js"),
			);
			const release = JSON.stringify(at("release"));
			stub(
				"file-morning-review.js",
				`${buildReviewRecorder("file-morning-review.js")}
while (!fs.existsSync(${release})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${POLL_MS});
process.stdout.write("filed #900");\n`,
			);
		};

		/* TZ steers the due rule's clock: runInProcess writes process.env in
		 * place, and node re-reads its zone on each TZ assignment. */
		it("launches and writes its concurrency row on every tick while the filing runs detached, then logs it and records today (#3765)", async () => {
			const { zone, today } = zoneAt(12);
			stubHeldFiling();
			stub("file-memory-kill-tickets.js", "");
			stub(
				"answer-review-reversals.js",
				buildReviewRecorder("answer-review-reversals.js"),
			);
			fs.writeFileSync(
				at(".refill-loop-state.json"),
				JSON.stringify({ launches: [], reviewRunOn: null }),
			);
			const tick = async () => {
				restart();
				const r = await settled(run(1, { TZ: zone }), "run reviewing");
				expect(r.status).toBe(0);
				return r;
			};
			const readReviewRunOn = () =>
				JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"))
					.reviewRunOn;

			await tick();
			await appeared(at("reviews"));
			const second = await tick();
			expect(readLines(at("dispatches"))).toHaveLength(2);
			expect(readLines(at("reviews"))).toEqual(["file-morning-review.js"]);
			expect(second.stdout).not.toContain("morning review:");
			expect(readReviewRunOn()).toBeNull();
			expect(readLines(at("concurrency.jsonl"))).toHaveLength(2);

			fs.writeFileSync(at("release"), "");
			await appeared(resultFile());
			const third = await tick();
			expect(third.stdout).toContain("morning review: exit 0\n  filed #900");
			expect(readReviewRunOn()).toBe(today);
			expect(readLines(at("dispatches"))).toHaveLength(3);
			await appeared(resultFile());
			expect(readLines(at("reviews"))).toEqual([
				"file-morning-review.js",
				"answer-review-reversals.js",
			]);
		});

		it("a second runner exits at once while the first holds the pidfile, writing no result (#3814)", async () => {
			stubHeldFiling();
			const runner = path.join(scripts, "refill-review-run.js");
			const start = JSON.stringify({
				due: true,
				script: "file-morning-review.js",
				label: "morning review",
				today: "2026-11-02",
			});
			/* spawn-kept: two processes at once, and pid-lock reads the holder's
			 * command line for the runner's name. */
			const first = spawn(process.execPath, [runner, start], {
				env: loopEnv({}),
				detached: true,
				stdio: "ignore",
			});
			first.unref();
			await appeared(at("reviews"));

			/* spawn-kept: the holder above must be another live process. Without
			 * the limb it joins the held filing, and SETTLE_MS ends it as a failure. */
			const second = spawnSync(process.execPath, [runner, start], {
				encoding: "utf8",
				env: loopEnv({}),
				timeout: SETTLE_MS,
			});
			expect(second.status).toBe(0);
			expect(second.stdout + second.stderr).toBe("");
			expect(readLines(at("reviews"))).toEqual(["file-morning-review.js"]);
			expect(fs.existsSync(resultFile())).toBe(false);

			fs.writeFileSync(at("release"), "");
			await appeared(resultFile());
		});
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

describe("the panel's read on the real tick (#4060)", () => {
	const dayMs = 24 * 3_600_000;
	const behindCache = () => path.join(at("behind"), ".claude.json");
	/** The usage probe's stub: records its seat, then exits `status`, naming `outcome`. */
	const stubProbe = (outcome: string, status: number) =>
		stub(
			"usage-probe.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("probes"))}, process.argv[3] + "\\n");
process.stderr.write("${OUTCOME_PREFIX}${outcome}\\n");
process.exitCode = ${status};\n`,
		);
	/** A control with a fresh seat with room ahead of `behind`, read at 100% before a reset now passed. */
	const writeSeats = () => {
		fs.mkdirSync(at("behind"), { recursive: true });
		const now = Date.now();
		fs.writeFileSync(
			behindCache(),
			JSON.stringify(
				buildUsageCache({ week: 100 }, now - 6 * dayMs, {
					resetsAt: { week: new Date(now - dayMs).toISOString() },
				}),
			),
		);
		fs.writeFileSync(
			at(".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: now,
				stopRequested: false,
				seats: [seat, at("behind")],
				scope: { mode: "normal", repos: [repo], goal: null },
			}),
		);
	};
	const oneTick = async () => {
		const before = readLines(at("ticks")).length;
		const running = run(0);
		await ticked(before + 1);
		requestStop();
		const r = await settled(running, "run");
		expect(r.status).toBe(0);
		return r;
	};

	it("keeps a failed probe's last figure and does not retry it on the next tick", async () => {
		stubProbe("failed (the seat is not logged in)", 1);
		writeSeats();
		const figure = fs.readFileSync(behindCache(), "utf8");
		const failed = await oneTick();
		expect(fs.readFileSync(behindCache(), "utf8")).toBe(figure);
		expect(failed.stdout).toContain(`/usage on ${at("behind")}:`);
		// Probed past its reset with no free slot, the seat ahead left alone.
		expect(readLines(at("probes"))).toEqual([at("behind")]);
		const state = readLoopState();
		expect(state.seatTriedAt[at("behind")]).toEqual(expect.any(Number));
		writeSeats();
		fs.writeFileSync(behindCache(), figure);
		fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
		await oneTick();
		expect(readLines(at("probes"))).toEqual([at("behind")]);
	});
});

const loopControlFile = () => at(".refill-loop-control.json");
const updateControl = (over: Record<string, unknown>) =>
	fs.writeFileSync(
		loopControlFile(),
		JSON.stringify({
			...JSON.parse(fs.readFileSync(loopControlFile(), "utf8")),
			...over,
		}),
	);

/** The plan seat's overflow key, on the plan seat's own dir (#3701). */
const overflowSeat = () => seat;

/** The seat file: the plan seat, then an overflow seat at `grant` unless null. */
const writeSeatFile = (grant: number | null) => {
	fs.mkdirSync(at(".claude"), { recursive: true });
	fs.writeFileSync(
		at(".claude/refill-seats"),
		`${seat}\n${grant === null ? "" : `${overflowSeat()} api key=WFC_TEST_KEY grant=${grant} cycle-day=20\n`}`,
	);
};

/* The served checkout's table, as the tick reads it (#3683): a grant of 2 fits
 * no session, a grant of 200 does. */
const writeKeyCostTable = () => writeCostTable(repo, { meanUsd: 4 });

const runDry = () => {
	writeKeyCostTable();
	return runInProcessAsync(path.join(scripts, "refill-loop.js"), ["dry-run"], {
		cwd: dir,
		env: loopEnv({ FAKE_SLOTS: "1" }),
	});
};

describe("a dry run with overflow seats (#2611)", () => {
	const dispatch = () =>
		`bash ${path.join(scripts, "dispatch-sessions.sh")} opus /implement 5`;

	it("prints the overflow dispatch on the overflow seat once the plan seat is weekly-full", async () => {
		weekAt(100);
		writeSeatFile(200);
		const r = await runDry();
		expect(r.stdout).toContain(
			`would run in ${repo} on overflow seat ${overflowSeat()}, each member billed to key=WFC_TEST_KEY: ${dispatch()}`,
		);
		// The decision's summary line, which the dry run prints ahead of it.
		expect(r.stdout).toMatch(/^dry run: /m);
		expect(readLines(at("dispatches"))).toEqual([]);
	});
});

describe("an overflow session's allowance on the real tick (#3698)", () => {
	const job = "0000c001";
	const sessionId = `s-${job}`;

	/* A launch on the key at a US$50 allowance, listed working. */
	beforeEach(() => {
		writeSeatFile(200);
		writeKeyCostTable();
		writeClaudeStub(at("claude"), [
			buildAgentsBranch([
				buildJobRow(job, "working", { sessionId, name: "Overflow · job" }),
			]),
			buildStopBranch(at("stops")),
		]);
		recordDispatch({
			issues: [5],
			model: "opus",
			prompt: "/implement 5",
			root: repo,
			jobId: job,
			overflow: { keyVar: "WFC_TEST_KEY", allowanceUsd: 50, sessionId },
		});
	});

	/* Its transcript: `inputTokens` of fresh Opus input, US$4 a million. */
	const writeTranscript = (inputTokens: number) => {
		const file = path.join(
			overflowSeat(),
			"projects",
			"-fixture",
			`${sessionId}.jsonl`,
		);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			`${JSON.stringify({
				type: "assistant",
				requestId: "r1",
				message: {
					model: "claude-opus-5-5",
					usage: { input_tokens: inputTokens },
				},
			})}\n`,
		);
	};

	/* A stopping tick: it runs once and exits, and caps as any tick does. */
	const oneTick = () => {
		updateControl({ stopRequested: true });
		return settled(run(0, { WFC_DISPATCH_ROOT: repo }), "run asked to stop");
	};

	it("stops one past it under its seat's dir, naming spend and allowance", async () => {
		writeTranscript(15_000_000);
		const r = await oneTick();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`stopped overflow session Overflow · job (${job}) on ${overflowSeat()}: spent $60.00 of its $50.00 allowance`,
		);
		expect(readLines(at("stops"))).toEqual([`stop ${job}`]);
	});

	it("records the session id the listing shows for a launch `--bg` gave none (#3701)", async () => {
		recordDispatch({
			issues: [6],
			model: "opus",
			prompt: "/implement 6",
			root: repo,
			jobId: job,
			overflow: { keyVar: "WFC_TEST_KEY", allowanceUsd: 50, sessionId: null },
		});
		expect(readOverflowLookup([repo])({ jobId: job })?.sessionId).toBeNull();
		const r = await oneTick();
		expect(r.status).toBe(0);
		expect(readOverflowLookup([repo])({ jobId: job })).toMatchObject({
			sessionId,
			allowanceUsd: 50,
		});
	});
});

describe("a due Console read on the real tick (#4071)", () => {
	const consoleLogFile = () =>
		at(".overflow-ledger/WFC_TEST_KEY.console.jsonl");
	const runnerCallsFile = () => at("console-runs");
	const expectNoReadStarted = () => {
		expect(fs.existsSync(consoleLogFile())).toBe(false);
		expect(readLines(runnerCallsFile())).toEqual([]);
	};
	const oneTick = async () => {
		const running = run(0);
		await ticked(1);
		requestStop();
		return settled(running, "run with a due read");
	};

	/* A spent key on a plan seat with room and no read yet: due. */
	beforeEach(() => {
		writeSeatFile(2);
		writeKeyCostTable();
		stub(
			"read-console-credit.js",
			`require("node:fs").appendFileSync(${JSON.stringify(runnerCallsFile())}, process.argv[2] + "\\n");\n`,
		);
	});

	it("starts the read, its started row written", async () => {
		expect((await oneTick()).status).toBe(0);
		await polled(
			() => readLines(runnerCallsFile()).length > 0,
			"the runner never started",
		);
		expect(readLines(runnerCallsFile())).toEqual(["WFC_TEST_KEY"]);
		expect(readLines(consoleLogFile()).map((l) => JSON.parse(l))).toEqual([
			{ at: expect.any(Number), started: true },
		]);
	});

	it("starts none where its started row will not write", async () => {
		fs.mkdirSync(path.dirname(consoleLogFile()), { recursive: true });
		/* Reads as no log and refuses the append, as a chmod would not under root. */
		fs.symlinkSync(at("no-such-dir/log"), consoleLogFile());
		const r = await oneTick();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`console read of ${overflowSeat()}: not started (`,
		);
		expect(readLines(runnerCallsFile())).toEqual([]);
	});

	it("starts none on a dry run", async () => {
		const r = await runDry();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`would run in ${repo} on ${seat}:`);
		expectNoReadStarted();
	});
});

describe("the loop's goal across ticks (#3864)", () => {
	const startRun = () => run(1);
	const writeScope = (scope: object) =>
		fs.writeFileSync(
			at(".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: Date.now(),
				stopRequested: false,
				seats: [seat],
				scope,
			}),
		);
	/* A pick-next naming its argv, so each frontier read's goal can be read. */
	const stubRecordingShortlist = () =>
		stub(
			"pick-next.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("picks"))}, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(JSON.stringify({ frontier: [], retroBundles: [], pulledIn: [], pulledInUnread: [] }));\n`,
		);
	it("reads the frontier bare once the goal is cleared, the loop running on", async () => {
		stubRecordingShortlist();
		writeScope({
			mode: "normal",
			repos: [repo],
			goal: {
				form: "issues",
				text: "7",
				refs: [{ repo: path.basename(repo), number: 7 }],
				setAt: 3,
			},
		});
		const running = startRun();
		await polled(
			() => readLines(at("picks")).length > 0,
			"no tick read the frontier",
		);
		writeScope({ mode: "normal", repos: [repo], goal: null });
		fs.appendFileSync(at(".refill-loop-wake"), `${Date.now()}\n`);
		await polled(
			() => readLines(at("picks")).at(-1) === "--json",
			"no tick read the frontier bare",
		);
		requestStop();
		expect((await settled(running, "run reading the goal")).status).toBe(0);
		expect(readLines(at("picks"))[0]).toBe("--json --goal 7");
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
	const job7Dir = () => path.join(seat, "jobs", Job);
	const jobFile = () => path.join(job7Dir(), "state.json");

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
				scope: { mode: "away", repos: [repo], goal: null },
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
			JSON.stringify({ ...SeededJob, cwd: repo, linkScanPath: transcript }),
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
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(at("gh-calls"))}\n`,
			{ mode: 0o755 },
		);
	});

	const fakeClaude = (listing: Row[] | null) =>
		writeClaudeStub(at("claude"), [
			buildAgentsBranch(listing),
			buildStopBranch(at("stops")),
		]);

	const startRun = (gh = at("gh")) => run(0, { WFC_GH: gh });

	/** Two ticks of the loop, ended by a stop after the first. */
	const twoTicks = async (gh?: string) => {
		const running = startRun(gh);
		await ticked(1);
		requestStop();
		return settled(running, "run with a parked launch");
	};

	const parkComment = (cause: string) =>
		expect.stringMatching(
			new RegExp(
				`^issue comment 7 --repo o/r --body Refill loop: stopped ${cause} park repo /implement 7 \\(away mode, blocked since [^)]+\\); labelled parked: #7\\. The conversation is kept: \`claude attach\` reopens it\\.$`,
			),
		);

	const expectNothingActed = () => {
		expect(readLines(at("stops"))).toEqual([]);
		expect(readGhActs()).toEqual([]);
		expect(launchState()).not.toHaveProperty("parkStopped");
	};

	describe("whose session has left the listing (#3940)", () => {
		const Unlabel = "issue edit 7 --repo o/r --remove-label parked";
		const reply = (text: string) => ({
			type: "assistant",
			timestamp: new Date().toISOString(),
			message: { content: [{ type: "text", text }] },
		});

		const transcript = () => path.join(seat, "projects", "p", "s-job7.jsonl");

		/** `text` at marker `file`, a minute old, so a reply stamped now follows the park. */
		const writeMarkerAMinuteOld = (file: string, text: string) => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
			const parkedAt = new Date(Date.now() - 60_000);
			fs.utimesSync(file, parkedAt, parkedAt);
		};

		/** A marker listing #7, written a minute ago, and its transcript's directory. */
		const parkedAMinuteAgo = () => {
			writeMarkerAMinuteOld(
				markerPath("s-job7"),
				`seat ${seat}\njob ${Job}\n7\n`,
			);
			fs.mkdirSync(path.dirname(transcript()), { recursive: true });
		};

		it("takes the label and the marker off where it ended unblocked, as after a `!` answer", async () => {
			parkedAMinuteAgo();
			fs.writeFileSync(
				transcript(),
				`${JSON.stringify(reply("Merged.\n\nresult: closed #7"))}\n`,
			);
			fakeClaude([LISTED]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			expect(readLines(at("gh-calls"))).toContain(Unlabel);
			expect(fs.existsSync(markerPath("s-job7"))).toBe(false);
			expect(r.stdout).toContain("ended unblocked: parked off #7");
		});

		/** A checkout under HOME the loop's scope leaves out, a marker listing #9 in it. */
		const parkedOutOfScope = (name: string, config: object) => {
			const other = at(name);
			probedCheckout.instantiate(other);
			fs.mkdirSync(path.join(other, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(other, ".claude", "workflow-core.json"),
				JSON.stringify({ tracker: "o/other", ...config }),
			);
			const marker = markerPath("s-other", other);
			writeMarkerAMinuteOld(marker, `seat ${seat}\n9\n`);
			const file = path.join(seat, "projects", "p", "s-other.jsonl");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				`${JSON.stringify(reply("Merged.\n\nresult: closed #9"))}\n`,
			);
			return marker;
		};

		const UnlabelOther = "issue edit 9 --repo o/other --remove-label parked";

		it("takes the label off in a checkout the loop's scope leaves out (#3950)", async () => {
			const marker = parkedOutOfScope("other", {});
			fakeClaude([LISTED]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			expect(readLines(at("gh-calls"))).toContain(UnlabelOther);
			expect(fs.existsSync(marker)).toBe(false);
			expect(r.stdout).toContain("ended unblocked: parked off #9");
		});

		it("leaves the label on in a checkout opted out of the loop (#3950)", async () => {
			const marker = parkedOutOfScope("opted-out", { refillLoop: false });
			fakeClaude([LISTED]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			expect(readLines(at("gh-calls"))).not.toContain(UnlabelOther);
			expect(fs.existsSync(marker)).toBe(true);
		});

		it("keeps the label, logged, where its transcript will not read", async () => {
			parkedAMinuteAgo();
			fs.mkdirSync(transcript());
			fakeClaude([LISTED]);
			const r = await twoTicks();
			expect(r.status).toBe(0);
			expect(readLines(at("gh-calls"))).not.toContain(Unlabel);
			expect(r.stdout).toContain("transcript unread for s-job7");
		});
	});

	it("takes the label off a closed issue however it closed, each tick (#3940)", async () => {
		fs.mkdirSync(at("gh-routes"), { recursive: true });
		const { gh } = stubGhRoutes(
			at("gh-routes"),
			{
				"issue list --repo o/r --state closed --label parked *":
					printed('[{"number":12}]'),
				"*": printed(),
			},
			{ log: at("gh-calls") },
		);
		fakeClaude([LISTED, blockedRow]);
		const r = await twoTicks(gh);
		expect(r.status).toBe(0);
		expect(readLines(at("gh-calls"))).toContain(
			"issue edit 12 --repo o/r --remove-label parked",
		);
		expect(r.stdout).toContain("closed o/r#12: parked off");
	});

	it("logs a closed-parks list that will not read, and ticks on (#3940)", async () => {
		fs.mkdirSync(at("gh-routes"), { recursive: true });
		const { gh } = stubGhRoutes(
			at("gh-routes"),
			{
				"issue list --repo o/r --state closed --label parked *": {
					status: 1,
					stdout: "",
					stderr: "HTTP 502\n",
				},
				"*": printed(),
			},
			{ log: at("gh-calls") },
		);
		fakeClaude([LISTED, blockedRow]);
		const r = await twoTicks(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("closed parks unread in o/r");
	});

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
		expect(readLines(markerPath("s-job7"))).toEqual([
			`seat ${seat}`,
			`job ${Job}`,
			`cwd ${repo}`,
			"cause QUESTION",
			"7",
		]);
	});

	it("records an overflow launch's key in the marker of a park it stops (#4147)", async () => {
		const state = JSON.parse(
			fs.readFileSync(at(".refill-loop-state.json"), "utf8"),
		);
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				...state,
				launches: [{ ...state.launches[0], keyVar: "K2" }],
			}),
		);
		fakeClaude([LISTED, blockedRow]);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		expect(readLines(markerPath("s-job7"))).toEqual(
			expect.arrayContaining([`seat ${seat}`, "key K2", `job ${Job}`, "7"]),
		);
	});

	it("gives a session attached to a repo hold the ordinary park act, its ticket labelled parked (#3858)", async () => {
		const holdCli = (args: string[], jobDir: string) =>
			runInProcess(path.join(__dirname, "repo-hold.js"), args, {
				cwd: repo,
				env: loopEnv({
					CLAUDE_PROJECT_DIR: repo,
					CLAUDE_JOB_DIR: jobDir,
					CLAUDE_CODE_SESSION_ID: "",
				}),
			});
		const raised = holdCli(
			["raise", "--act", "repair main", "--issue", "12", "--clear-issue", "12"],
			path.join(seat, "jobs", "raiser"),
		);
		const id = parseHoldId(raised.stdout);
		const attached = holdCli(["attach", id], job7Dir());
		expect(attached.status, attached.stderr).toBe(0);
		fakeClaude([LISTED, blockedRow]);

		const r = await twoTicks();

		expect(r.status).toBe(0);
		expect(readLines(at("stops"))).toEqual([`stop ${Job}`]);
		expect(readLines(at("gh-calls"))).toContain(
			"issue edit 7 --repo o/r --add-label parked",
		);
		expect(readLines(at("gh-calls"))).toContainEqual(parkComment("QUESTION"));
		expect(readLines(markerPath("s-job7"))).toContain("7");
		expect(
			readLines(at(".refill-loop.log")).filter((l) =>
				l.includes(`repo hold attached: ${id}`),
			),
		).toHaveLength(1);
		const listed = holdCli(["list"], "").stdout;
		expect(listed).toContain(`sessions: raiser, ${Job}`);
	});

	/** Rewrites job7's record with `over` merged in. */
	const jobAs = (over: object) =>
		fs.writeFileSync(
			jobFile(),
			JSON.stringify({
				...JSON.parse(fs.readFileSync(jobFile(), "utf8")),
				...over,
			}),
		);

	it("comments a stopped permission park's cause on its ticket (#2846)", async () => {
		fakeClaude([LISTED, permissionRow]);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		expect(readLines(at("stops"))).toEqual([`stop ${Job}`]);
		expect(readLines(at("gh-calls"))).toContainEqual(parkComment("PERMISSION"));
		expect(readLines(markerPath("s-job7"))).toContain("cause PERMISSION");
	});

	it("logs an UNKNOWN park's row and job shape once across ticks, and stops nothing (#2851, #3200)", async () => {
		jobAs({ tempo: 7 });
		fakeClaude([LISTED, blockedRow]);
		const r = await twoTicks();
		expect(r.status).toBe(0);
		const { state, detail, needs, inFlight, cliVersion } = SeededJob;
		const job = { state, tempo: 7, detail, needs, inFlight, cliVersion };
		expect(readLines(at("ticks")).length).toBeGreaterThanOrEqual(2);
		const line = `block unread repo /implement 7: job tempo is not a string; row ${JSON.stringify(blockedRow)}; job ${JSON.stringify(job)}`;
		expect(r.stdout.split(line)).toHaveLength(2);
		expectNothingActed();
		expect(launchState()).toMatchObject({ block: { cause: "UNKNOWN" } });
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
	runInProcess(path.join(scripts, "session-arbiter.js"), args, {
		cwd: repo,
		env: {
			...process.env,
			HOME: dir,
			CLAUDE_CONFIG_DIR: seat,
			CLAUDE_PROJECT_DIR: repo,
			WFC_REPO_ROOT: repo,
			CLAUDE_CODE_SESSION_ID: sessionId,
		},
	}).stdout;

const writesCopyRecord = (record: string) => {
	const jobDir = path.join(seat, "jobs", FAKE_COPY);
	return `mkdir -p ${shellQuote(jobDir)}; echo ${shellQuote(record)} > ${shellQuote(path.join(jobDir, "state.json"))};`;
};

/* What a real wake leaves: the stopped job's own record, running again. */
const writesWokenRecord = (jobFile: string, sessionId: string) => {
	const record = JSON.stringify({ state: "running", sessionId, cwd: repo });
	return `echo ${shellQuote(record)} > ${shellQuote(jobFile)};`;
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
		`calls=${shellQuote(at("calls"))}`,
		buildAgentsBranch(listing),
		buildStopBranch(at("calls")),
		buildAttachBranch(at("calls")),
		`if [ "$1" = "--bg" ]; then echo "$*" >> "$calls"; ${onResume} cat ${shellQuote(at("bg-stdout"))}; cat ${shellQuote(at("bg-stderr"))} >&2; exit 0; fi`,
	]);
};

const buildBlockedJobRecord = (detail: string, linkScanPath: string) =>
	JSON.stringify({
		state: "blocked",
		detail,
		tempo: "blocked",
		inFlight: { tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 },
		needs: null,
		cliVersion: "2.1.309",
		sessionId: "s-job7",
		cwd: repo,
		linkScanPath,
	});

/** `job`'s park marker, written `age` minutes ago, listing its issue. */
const writeParkMarker = (job: string, issue: number, age: number) => {
	const file = markerPath(`s-${job}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `seat ${seat}\njob ${job}\ncwd ${repo}\n${issue}\n`);
	const parkedAt = new Date(Date.now() - age * 60_000);
	fs.utimesSync(file, parkedAt, parkedAt);
};

const readLoopState = () =>
	JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"));

const launchState = () => readLoopState().launches[0];

/** The secrets file vitest.setup.ts points every test at. */
const keySecrets = () => String(process.env.WFC_SECRETS_FILE);

/** Overflow seat `keyVar` on the plan seat's dir, its key in the secrets file. */
const declareKey = (keyVar: string) => {
	fs.mkdirSync(at(".claude"), { recursive: true });
	fs.writeFileSync(
		at(".claude/refill-seats"),
		`${seat}\n${seat} api key=${keyVar} grant=200 cycle-day=20\n`,
	);
	fs.mkdirSync(path.dirname(keySecrets()), { recursive: true });
	fs.writeFileSync(keySecrets(), `${keyVar}=sk-fake-overflow\n`);
};

const oneTick = async (
	what: string,
	slots = 0,
	env: Record<string, string> = {},
) => {
	const running = runInProcessAsync(
		path.join(scripts, "refill-loop.js"),
		["run"],
		{
			cwd: dir,
			env: loopEnv({ WFC_GH: at("gh"), FAKE_SLOTS: String(slots), ...env }),
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
	const seed = (resumes?: object, launchFields: object = {}) => {
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
			buildBlockedJobRecord("API Error: 529 overloaded", transcript),
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
						...launchFields,
					},
				],
			}),
		);
		fs.writeFileSync(
			at("gh"),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(at("gh-calls"))}\n`,
			{ mode: 0o755 },
		);
	};

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
		expect(readGhActs().join("\n")).toMatch(
			/^issue comment 7 --repo o\/r --body Refill loop: resume 1 of 16 after an API error, repo \/implement 7, by typing into the live session; next due /,
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

	it("carries an overflow session's key to its copy: the launch, the ledger's mark, and no second hold (#4147)", async () => {
		seed(heldDue, { keyVar: "K2" });
		declareKey("K2");
		fs.mkdirSync(path.dirname(markerPath("s-job7")), { recursive: true });
		fs.writeFileSync(markerPath("s-job7"), "7\n");
		fs.mkdirSync(path.dirname(ledgerPath(repo)), { recursive: true });
		fs.writeFileSync(
			ledgerPath(repo),
			`${JSON.stringify({ ts: new Date().toISOString(), issues: [7], prompt: "/implement 7", jobId: Job, kind: "overflow", keyVar: "K2", allowanceUsd: 50, sessionId: "s-job7" })}\n`,
		);
		fakeResumeClaude(
			Job,
			[LISTED],
			writesCopyRecord(
				JSON.stringify({ state: "working", sessionId: "s-copy" }),
			),
		);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		// Resumed on its key, never the plan login (#3701).
		const resume = readLines(at("calls")).find((l) => l.startsWith("--bg"));
		const settings = resume?.match(
			/^--bg --resume s-job7 --settings (\{.*\}) /,
		)?.[1];
		expect(JSON.parse(String(settings)).apiKeyHelper).toMatch(
			new RegExp(`/lib/overflow-key\\.js'? '?K2'? '?${keySecrets()}`),
		);
		expect(resume?.endsWith(` ${Prompt}`)).toBe(true);
		expect(launchState()).toMatchObject({ jobId: FAKE_COPY, keyVar: "K2" });
		expect(readHeldIssues()).toEqual([[7], []]);
		expect(readLines(markerPath("s-copy"))).toContain("key K2");
		expect(JSON.parse(readLines(ledgerPath(repo)).at(-1) ?? "")).toMatchObject({
			issues: [],
			jobId: FAKE_COPY,
			kind: "overflow",
			keyVar: "K2",
			allowanceUsd: 50,
			sessionId: "s-copy",
			copyOf: "s-job7",
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

	describe("a copy's resume and the pass markers its past id wrote (#4105)", () => {
		const buildPassPath = (session: string) =>
			path.join(
				repo,
				".claude",
				"tmp",
				"markers",
				`.concision-pass-${session}`,
			);
		const resumeListing = async (listing: Row[]) => {
			seed(heldDue);
			ledgerLaunch(Job);
			fs.mkdirSync(path.dirname(buildPassPath("s-job7")), { recursive: true });
			fs.writeFileSync(buildPassPath("s-job7"), "base=x\nfindings=1\n");
			fakeResumeClaude(
				Job,
				[
					...listing,
					buildJobRow(FAKE_COPY, "working", { sessionId: "s-copy" }),
				],
				writesCopyRecord(
					JSON.stringify({ state: "working", sessionId: "s-copy" }),
				),
			);
			const r = await oneTick(ApiRun);
			expect(r.status).toBe(0);
			return r;
		};

		it("moves them to the copy once the past id has ended", async () => {
			await resumeListing([LISTED]);
			expect(fs.readFileSync(buildPassPath("s-copy"), "utf8")).toBe(
				"base=x\nfindings=1\n",
			);
			expect(fs.existsSync(buildPassPath("s-job7"))).toBe(false);
		});

		it("leaves them where the past id is open elsewhere, logging it", async () => {
			const r = await resumeListing([
				LISTED,
				buildJobRow("elsewhere", "working", { sessionId: "s-job7" }),
			]);
			expect(fs.existsSync(buildPassPath("s-copy"))).toBe(false);
			expect(fs.existsSync(buildPassPath("s-job7"))).toBe(true);
			expect(r.stdout).toContain(
				"pass markers of s-job7 not moved: s-job7 is still live",
			);
		});
	});

	it("reads a launcher line naming no job as a failed resume, the session held for its next (#2963)", async () => {
		seed(heldDue);
		fakeResumeClaude(Job, [LISTED], `echo "no job named"; exit 0;`);
		const r = await oneTick(ApiRun);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/could not resume .*: the launcher never said what it started: no job named/,
		);
		expect(launchState()).toMatchObject({
			jobId: Job,
			finishedAt: null,
			resumes: { heldAt: expect.any(Number) },
		});
	});
});

describe("a session held on its seat's limit (#3735)", () => {
	const Job = "job7";
	const Run = "run with a limit-held launch";
	const jobFile = () => path.join(seat, "jobs", Job, "state.json");
	const Admitted = ADMISSION_VERDICT.memory.working.count;
	const concurrencyRow = () =>
		JSON.parse(readLines(at("concurrency.jsonl"))[0]);

	/** A normal-mode loop with one limit-blocked launch, held where `held` says
	 * so, its job record reading session `recorded`. */
	const seed = (recorded = "s-job7", held = true) => {
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/r" }),
		);
		fs.mkdirSync(path.dirname(jobFile()), { recursive: true });
		fs.writeFileSync(
			jobFile(),
			JSON.stringify({ state: "stopped", sessionId: recorded, cwd: repo }),
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
						launchedAt: Date.now() - 60 * 60 * 1000,
						finishedAt: null,
						parked: true,
						block: { cause: "LIMIT", since: Date.now() - 60 * 60 * 1000 },
						...(held && {
							limitHeld: {
								at: Date.now() - 60 * 60 * 1000,
								sessionId: "s-job7",
								cwd: repo,
								limit: { bar: "weekly", resets: "2026-11-01T00:00:00.000Z" },
							},
						}),
					},
				],
			}),
		);
		fs.writeFileSync(
			at("gh"),
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(at("gh-calls"))}\n`,
			{ mode: 0o755 },
		);
	};

	it("resumes under its own seat once a fresh reading reads open, takes its slot, comments, counts it working, its claim kept (#3778, #2968)", async () => {
		seed();
		weekAt(10);
		arbiterAs("s-job7", "claim-issue", "7");
		fakeResumeClaude(
			Job,
			[LISTED],
			`echo "dir $CLAUDE_CONFIG_DIR" >> "$calls"; ${writesWokenRecord(jobFile(), "s-job7")}`,
			"woke",
		);
		const r = await oneTick(Run, 1);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`--bg --resume s-job7 ${LIMIT_PROMPT}`,
			`dir ${seat}`,
		]);
		expect(launchState()).toMatchObject({
			jobId: Job,
			finishedAt: null,
			relaunchedAt: expect.any(Number),
		});
		expect(readGhActs().join("\n")).toMatch(
			/^issue comment 7 --repo o\/r --body Refill loop: resumed this session after its weekly limit \(reset 2026-11-01T00:00:00.000Z\): same seat, .*Lost: /,
		);
		/* Its slot went to the resume, so the frontier's #5 launched nothing. */
		expect(r.stdout).toContain("no free slot");
		expect(concurrencyRow()).toMatchObject({
			working: Admitted + 1,
			ceiling: Admitted + 1,
		});
		expect(arbiterAs("s-job7", "issue-claims")).toContain("s-job7");
	});

	describe("moved to another plan seat (#3734)", () => {
		const Session = "s-job7000-full";
		const Short = "s-job700";
		const slug = () => projectSlug(repo);
		const target = () => at("seat2");
		const targetRecord = () => path.join(target(), "jobs", Short, "state.json");
		const oldTranscript = () =>
			path.join(seat, "projects", slug(), `${Session}.jsonl`);
		const newTranscript = () =>
			path.join(target(), "projects", slug(), `${Session}.jsonl`);

		/** Two plan seats: this one spent on `week`, the other low; the launch's
		 * job blocked on its limit there, its transcript on disk and no slug
		 * directory on the other seat. */
		const seedMove = () => {
			seed(Session, false);
			fs.mkdirSync(target());
			fs.writeFileSync(
				path.join(target(), ".claude.json"),
				JSON.stringify(buildUsageCache({ session: 10, week: 10 }, Date.now())),
			);
			weekAt(100);
			fs.mkdirSync(path.dirname(oldTranscript()), { recursive: true });
			fs.writeFileSync(
				oldTranscript(),
				`${JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "Working." }] },
				})}\n`,
			);
			fs.writeFileSync(
				jobFile(),
				JSON.stringify({
					...JSON.parse(
						buildBlockedJobRecord(
							"You've hit your weekly limit",
							oldTranscript(),
						),
					),
					sessionId: Session,
					cwd: repo,
				}),
			);
			fs.writeFileSync(
				at(".refill-loop-control.json"),
				JSON.stringify({
					noProgressFrom: Date.now(),
					stopRequested: false,
					seats: [seat, target()],
					scope: { mode: "normal", repos: [repo], goal: null },
				}),
			);
		};
		const claudeFor = (onResume: string) => {
			const response = buildRekeyedResponse("continued", Short, FAKE_COPY);
			fs.writeFileSync(at("bg-stdout"), response.stdout);
			fs.writeFileSync(at("bg-stderr"), response.stderr);
			writeClaudeStub(at("claude"), [
				`calls=${shellQuote(at("calls"))}`,
				buildAgentsBranch([
					LISTED,
					buildJobRow(Job, "blocked", { sessionId: Session }),
				]),
				`if [ "$1" = "stop" ] || [ "$1" = "rm" ]; then echo "$* in $CLAUDE_CONFIG_DIR" >> "$calls"; [ "$1" = "rm" ] && rm -rf "$CLAUDE_CONFIG_DIR/jobs/$2"; echo stopped; exit 0; fi`,
				`if [ "$1" = "--bg" ]; then echo "$1 $2 $3 in $CLAUDE_CONFIG_DIR from $PWD" >> "$calls"; ${onResume} cat ${shellQuote(at("bg-stdout"))}; cat ${shellQuote(at("bg-stderr"))} >&2; exit 0; fi`,
			]);
		};
		const startsOnTarget = () => {
			const record = JSON.stringify({
				state: "running",
				sessionId: Session,
				cwd: repo,
				linkScanPath: newTranscript(),
			});
			return `mkdir -p ${shellQuote(path.dirname(targetRecord()))}; echo ${shellQuote(record)} > ${shellQuote(targetRecord())};`;
		};

		it("stops, copies into a missing slug directory, removes a stale record, resumes by id, confirms, rewrites, comments: all in one tick", async () => {
			seedMove();
			fs.mkdirSync(path.dirname(targetRecord()), { recursive: true });
			fs.writeFileSync(targetRecord(), JSON.stringify({ state: "stopped" }));
			claudeFor(
				`printf '%s' "$4" > ${shellQuote(at("prompt-seen"))}; ${startsOnTarget()}`,
			);
			const r = await oneTick(Run, 1);
			expect(r.status).toBe(0);
			expect(fs.readFileSync(at("prompt-seen"), "utf8")).toBe(MOVED_PROMPT);
			expect(readLines(at("calls"))).toEqual([
				`stop ${Job} in ${seat}`,
				`rm ${Short} in ${target()}`,
				`--bg --resume ${Session} in ${target()} from ${repo}`,
			]);
			expect(fs.readFileSync(newTranscript(), "utf8")).toBe(
				fs.readFileSync(oldTranscript(), "utf8"),
			);
			expect(launchState()).toMatchObject({
				seat: target(),
				reason: expect.stringMatching(/^moved from /),
				finishedAt: null,
				issues: [7],
				relaunchedAt: expect.any(Number),
			});
			const comments = readLines(at("gh-calls")).join("\n");
			expect(comments).toContain("issue comment 7 --repo o/r");
			expect(comments).toContain(`from ${seat} to ${target()}`);
			expect(comments).toMatch(/weekly limit \(reset /);
			expect(comments).toContain("Lost: ");
			expect(r.stdout).toContain(`moved ${Job}`);
		});

		it("leaves it held on its old seat, its transcript intact, where the resume is not confirmed, and stops what may be starting", async () => {
			seedMove();
			const before = fs.readFileSync(oldTranscript(), "utf8");
			claudeFor("");
			const r = await oneTick(Run, 1);
			expect(r.status).toBe(0);
			expect(launchState()).toMatchObject({
				seat,
				limitHeld: { sessionId: Session, failedTries: 1 },
			});
			expect(launchState().limitHeld).not.toHaveProperty("resumedAt");
			expect(fs.readFileSync(oldTranscript(), "utf8")).toBe(before);
			expect(readLines(at("calls"))).toContain(`stop ${Short} in ${target()}`);
			expect(r.stdout).toContain("could not move");
			expect(readLines(at("gh-calls")).join("\n")).toContain("could not move");
		});

		it("names a transcript it could not copy, resuming nothing", async () => {
			seedMove();
			fs.mkdirSync(newTranscript(), { recursive: true });
			claudeFor("");
			const r = await oneTick(Run, 1);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("copying its transcript");
			expect(
				readLines(at("calls")).filter((c) => c.startsWith("--bg")),
			).toEqual([]);
			expect(launchState()).toMatchObject({ seat });
		});
	});

	describe("moved onto an overflow seat (#3736)", () => {
		const transcript = () =>
			path.join(seat, "projects", projectSlug(repo), "s-job7.jsonl");

		const seedOverflow = () => {
			seed();
			weekAt(100);
			declareKey("K2");
			writeKeyCostTable();
			fs.mkdirSync(path.dirname(transcript()), { recursive: true });
			fs.writeFileSync(transcript(), `${JSON.stringify({ type: "user" })}\n`);
			/* The resume's environment: its key and session id, set or unset. */
			const envSeen = `echo "env key=\${K2-unset} api=\${ANTHROPIC_API_KEY-unset} session=\${CLAUDE_CODE_SESSION_ID-unset} dir=$CLAUDE_CONFIG_DIR" >> "$calls";`;
			fakeResumeClaude(
				Job,
				[LISTED],
				`${envSeen} ${writesCopyRecord(
					JSON.stringify({ state: "working", sessionId: "s-copy" }),
				)}`,
			);
		};

		it("resumes it on the key in one tick, recorded as that key's launch with its allowance", async () => {
			seedOverflow();
			const r = await oneTick(Run, 1, {
				K2: "sk-must-not-pass",
				ANTHROPIC_API_KEY: "sk-must-not-pass",
			});
			expect(r.status).toBe(0);
			expect(readLines(at("calls"))).toContain(
				`env key=unset api=unset session=unset dir=${seat}`,
			);
			const resume = readLines(at("calls")).find((l) => l.startsWith("--bg"));
			const settings = resume?.match(
				/^--bg --resume s-job7 --settings (\{.*\}) /,
			)?.[1];
			expect(JSON.parse(String(settings)).apiKeyHelper).toMatch(
				/overflow-key\.js'? '?K2/,
			);
			expect(launchState()).toMatchObject({
				seat,
				keyVar: "K2",
				jobId: FAKE_COPY,
				reason: expect.stringMatching(/^moved from /),
				finishedAt: null,
				issues: [7],
			});
			const row = readOverflowLookup([repo])({ jobId: FAKE_COPY });
			expect(row).toMatchObject({
				keyVar: "K2",
				sessionId: "s-copy",
				allowanceUsd: expect.any(Number),
			});
			expect(row?.allowanceUsd).toBeGreaterThan(0);
			expect(
				JSON.parse(readLines(ledgerPath(repo)).at(-1) ?? ""),
			).toMatchObject({ issues: [], jobId: FAKE_COPY, kind: "overflow" });
			const comments = readLines(at("gh-calls")).join("\n");
			expect(comments).toContain(`to ${seat} on overflow key K2`);
			expect(comments).toContain("its allowance there $");
		});

		it("records the overflow start on its first move onto a key, as a first overflow launch would (#4257)", async () => {
			seedOverflow();
			const outside = at(".claude9");
			fs.mkdirSync(outside, { recursive: true });
			fs.writeFileSync(path.join(outside, ".credentials.json"), "{}");
			const before = Date.now();
			const r = await oneTick(Run, 1);
			expect(r.status).toBe(0);
			expect(launchState()).toMatchObject({ keyVar: "K2" });
			const start = readLoopState().overflowStart;
			expect(start).toMatchObject({
				seat,
				planSeats: [{ seat, percent: 100, weekFull: true }],
				omitted: [outside],
			});
			expect(start.at).toBeGreaterThanOrEqual(before);
			expect(launchState().movedAt).toBe(start.at);
			expect(r.stdout).toContain("first overflow launch on");
		});

		it("stops the copy and puts it back held on its plan seat, its claims kept, where its ledger row will not write (#3730)", async () => {
			seedOverflow();
			arbiterAs("s-job7", "claim-issue", "7");
			fs.mkdirSync(path.dirname(ledgerPath(repo)), { recursive: true });
			fs.appendFileSync(ledgerPath(repo), "");
			fs.chmodSync(ledgerPath(repo), 0o444);
			const r = await oneTick(Run, 1);
			expect(r.status).toBe(0);
			expect(readLines(at("calls"))).toContain(`stop ${FAKE_COPY}`);
			expect(launchState()).toMatchObject({
				seat,
				jobId: Job,
				limitHeld: { failedTries: 1 },
			});
			expect(launchState()).not.toHaveProperty("keyVar");
			expect(launchState()).not.toHaveProperty("movedAt");
			expect(`${r.stdout}${r.stderr}`).toContain(
				"not recorded in the dispatch ledger",
			);
			const claims = arbiterAs("s-job7", "issue-claims");
			expect(claims).toContain("s-job7");
			expect(claims).not.toContain("s-copy");
		});
	});

	it("stays held where the launcher named a job its state.json reads stopped", async () => {
		seed();
		weekAt(10);
		fakeResumeClaude(Job, [LISTED], "", "woke");
		const r = await oneTick(Run, 1);
		expect(r.status).toBe(0);
		expect(launchState().limitHeld).not.toHaveProperty("resumedAt");
		expect(r.stdout).toContain("state.json reads stopped");
	});

	it("writes a dispatch-ledger hold past the run, and its stop names the session and seat (#3785)", async () => {
		seed();
		weekAt(100);
		fakeResumeClaude(Job, [LISTED], "", "woke");
		await oneTick(Run, 1);
		const { ledgerHeldUntil } = launchState().limitHeld;
		const heldUntil = new Date(ledgerHeldUntil).toISOString();
		const rows = readLines(ledgerPath(repo)).map((l) => JSON.parse(l));
		expect(rows).toEqual([
			expect.objectContaining({ issues: [7], jobId: Job, heldUntil }),
		]);
		expect(readStopped()).toMatchObject({ reason: "explicit" });
		for (const named of [
			Job,
			`on ~/${path.basename(seat)},`,
			`held from dispatch until ${heldUntil}`,
		])
			expect(readStopped().detail).toContain(named);
	});

	it("swaps its dispatch-ledger hold for an ordinary row once it resumes (#3785)", async () => {
		seed();
		const state = JSON.parse(
			fs.readFileSync(at(".refill-loop-state.json"), "utf8"),
		);
		state.launches[0].limitHeld.ledgerHeldUntil = Date.now() + 60 * 60 * 1000;
		fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
		weekAt(10);
		fakeResumeClaude(
			Job,
			[LISTED],
			writesWokenRecord(jobFile(), "s-job7"),
			"woke",
		);
		await oneTick(Run, 1);
		const rows = readLines(ledgerPath(repo)).map((l) => JSON.parse(l));
		expect(rows).toEqual([
			expect.objectContaining({ released: Job }),
			expect.objectContaining({ issues: [7], jobId: Job }),
		]);
		expect(rows[1]).not.toHaveProperty("heldUntil");
	});

	it("stays held and names the failure where state.json reads another session", async () => {
		seed("s-other");
		weekAt(10);
		fakeResumeClaude(Job, [LISTED], "", "woke");
		const r = await oneTick(Run, 1);
		expect(r.status).toBe(0);
		expect(launchState()).toMatchObject({
			finishedAt: null,
			limitHeld: { sessionId: "s-job7" },
			limitResumes: { tries: 1 },
		});
		expect(r.stdout).toContain("session s-other, not s-job7");
		expect(readLines(at("gh-calls")).join("\n")).toContain(
			"session s-other, not s-job7",
		);
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
			`#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(at("gh-calls"))}\n`,
			{ mode: 0o755 },
		);
		stub(
			"rescue-sessions.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("hand-offs"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.stdout.write("commented: #7\\n");
process.exit(${handOffExit});\n`,
		);
	};

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
		expect(readGhActs()).toEqual([
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

	describe("a swap hold that has cleared (#3093, #3855)", () => {
		const resumeOf = (session: string) => `--bg --resume ${session} ${Prompt}`;
		const readState = () =>
			JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"));
		const readStillHeld = () =>
			readState().launches.filter((l: { swapHeld?: unknown }) => l.swapHeld);

		/** The seeded launch, plus one per id in `more`, stopped under the hold,
		 * each `ages` entry minutes ago, in the same order. */
		const seedHeld = (ages: number[], more: string[] = []) => {
			seed(30);
			const state = readState();
			const [first] = state.launches;
			state.launches = ["job7", ...more].map((jobId, i) => ({
				...first,
				jobId,
				issues: [7 + i],
				prompt: `/implement ${7 + i}`,
				swapHeld: {
					at: Date.now() - ages[i] * Min,
					sessionId: `s-${jobId}`,
					cwd: repo,
					tries: 0,
				},
			}));
			fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
			fakeResumeClaude(Job, [LISTED]);
		};

		/** One loop run with `slots` free, asked to stop once `isDone` holds,
		 * the control's stop of the run before it cleared. */
		const tickUntil = async (slots: number, isDone: () => boolean) => {
			const control = at(".refill-loop-control.json");
			fs.writeFileSync(
				control,
				JSON.stringify({
					...JSON.parse(fs.readFileSync(control, "utf8")),
					stopRequested: false,
				}),
			);
			const running = run(slots, {
				WFC_GH: at("gh"),
				WFC_DISPATCH_STAGGER_SECONDS: "0",
			});
			await polled(isDone, "the tick never got there");
			requestStop();
			return settled(running, IdleRun);
		};
		const readResumedCount = () => readLines(at("calls")).length;

		it("resumes one through the real call, its target read back from the state file", async () => {
			seedHeld([10]);
			const r = await tickUntil(1, () => readResumedCount() === 1);
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(
				/resumed repo \/implement 7, stopped under the swap hold at .*, as its copy/,
			);
			expect(readLines(at("calls"))).toEqual([resumeOf("s-job7")]);
			expect(launchState()).not.toHaveProperty("swapHeld");
			expect(launchState()).toMatchObject({
				finishedAt: null,
				jobId: FAKE_COPY,
			});
		});

		it("waits on a resume the per-member re-read refuses, its tries untouched", async () => {
			seedHeld([10]);
			/* The tick's own read finds a slot for the resume and one for a launch;
			 * the re-read before the resume, with --launch as the dispatcher's, finds
			 * none. */
			stub(
				"admission.js",
				`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(at("ticks"))}, "tick\\n");
fs.appendFileSync(${JSON.stringify(at("admission-args"))}, process.argv.slice(2).join(" ") + "\\n");
const reads = fs.readFileSync(${JSON.stringify(at("ticks"))}, "utf8").split("\\n").length - 1;
process.stdout.write(JSON.stringify({ ...${JSON.stringify(ADMISSION_VERDICT)}, slots: reads === 1 ? 2 : 0 }));\n`,
			);
			const r = await tickUntil(1, () => readLines(at("ticks")).length >= 2);
			expect(r.status).toBe(0);
			expect(readLines(at("calls"))).toEqual([]);
			expect(fs.existsSync(at("dispatches"))).toBe(false);
			expect(readStillHeld()).toEqual([
				expect.objectContaining({
					swapHeld: expect.objectContaining({ tries: 0 }),
				}),
			]);
			expect(readLines(at("admission-args"))[1]).toMatch(/--launch/);
			expect(r.stdout).toMatch(
				/not resuming job7 .*for a later tick: admission's re-read/,
			);
		});
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
			"--session",
			"s-job7",
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
				args: [
					"hand-off",
					"--from",
					seat,
					"--job",
					Job,
					"--session",
					"s-job7",
					"--issue",
					"7",
				],
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

	const writeTable = (root: string) =>
		writeCostTable(root, {
			meanUsd: 0.01,
			quantilesUsd: [0.01, 0.01],
			tailRemainderUsd: 0.01,
		});

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
});

describe("a parked ticket in a normal-mode loop (#3621)", () => {
	const Job = "job5";
	const ParkedRun = "run with a parked ticket";

	/** The shortlist's one row #5 parked, and, unless `parker` is false, the
	 * park marker of a session the loop never launched, naming `parkSeat`, its
	 * job and its cwd (#3709). */
	const seed = (parker = true, parkSeat = seat) => {
		stub(
			"pick-next.js",
			`process.stdout.write(JSON.stringify({
	frontier: [{ number: 5, urgent: false, goal: false, stallDays: 0, asksQuestions: false, reach: 0, collision: "", takes: ["implement"], labels: ["takes:implement", "parked"], parkedAt: "2026-10-28T07:41:00Z" }],
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
}));\n`,
		);
		if (!parker) return;
		writeMarker(`seat ${parkSeat}\njob ${Job}\ncwd ${repo}\n5\n`);
		const jobDir = path.join(parkSeat, "jobs", Job);
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(
			path.join(jobDir, "state.json"),
			JSON.stringify({ state: "stopped", sessionId: "s-job5", cwd: repo }),
		);
	};

	const writeMarker = (text: string) => {
		const file = markerPath("s-job5");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};

	/* The resume's stop: one requested before the tick's launches holds them
	 * back. */
	const stopOnResume = () =>
		`node ${shellQuote(path.join(scripts, "request-stop.js"))};`;

	const logsResumeDir = ' echo "dir $PWD" >> "$calls";';

	const launches = () =>
		JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8")).launches;

	const wakesInPlace = () =>
		fakeResumeClaude(
			Job,
			[LISTED],
			`${stopOnResume()} ${writesWokenRecord(path.join(seat, "jobs", Job, "state.json"), "s-job5")}`,
			"woke",
		);

	it("resumes the session that parked it, in place, from its marker though the loop never launched it, and dispatches nothing", async () => {
		seed();
		wakesInPlace();
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`--bg --resume s-job5 ${PARKED_PROMPT}`,
		]);
		expect(readLines(at("dispatches"))).toEqual([]);
		expect(r.stdout).toContain(
			`resumed parked ${path.basename(repo)} /implement 5 as job ${Job}`,
		);
		expect(launches().at(-1)).toMatchObject({
			root: repo,
			issues: [5],
			seat,
			jobId: Job,
			finishedAt: null,
			sessionId: "s-job5",
		});
	});

	it("resumes a park on the prompt its marker's cause picks, noting one with nothing to repeat (#3949)", async () => {
		seed();
		writeMarker(`seat ${seat}\njob ${Job}\ncwd ${repo}\ncause LIMIT\n5\n`);
		wakesInPlace();
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`--bg --resume s-job5 ${parkedPromptOf("LIMIT")}`,
		]);
		expect(launches().at(-1).nothingToRepeat).toBe(true);
	});

	it("notes the acts its session had already made on the new launch, read from the ledger before the wake (#3942)", async () => {
		seed();
		/* A child, as the store is the sandbox's seat through the loop's env. */
		execFileSync(
			process.execPath,
			[
				"-e",
				`require(${JSON.stringify(path.join(scripts, "lib", "arbiter-ledger.js"))}).recordAct("file owner/repo#5", "s-job5", ${JSON.stringify(repo)})`,
			],
			{ env: loopEnv({}) },
		);
		wakesInPlace();
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(launches().at(-1).actsBefore).toEqual({ file: 1 });
	});

	it("hands the old session's marker to the copy, whose typing or ending then takes the label off (#3940)", async () => {
		seed();
		fakeResumeClaude(
			Job,
			[LISTED],
			`${stopOnResume()} ${writesCopyRecord(JSON.stringify({ state: "working", sessionId: "s-copy" }))}`,
		);
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(fs.existsSync(markerPath("s-job5"))).toBe(false);
		expect(readLines(markerPath("s-copy"))).toEqual(
			expect.arrayContaining([`seat ${seat}`, `cwd ${repo}`, "5"]),
		);
	});

	it("keeps the old session's marker, logged, where the copy's will not write (#3940)", async () => {
		seed();
		fs.mkdirSync(markerPath("s-copy"));
		fakeResumeClaude(
			Job,
			[LISTED],
			`${stopOnResume()} ${writesCopyRecord(JSON.stringify({ state: "working", sessionId: "s-copy" }))}`,
		);
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(fs.existsSync(markerPath("s-job5"))).toBe(true);
		expect(r.stdout).toContain("marker of s-job5 not moved");
	});

	/* What the launcher leaves on a gone job: a new directory under its id. */
	const restoresJobRecord = () => {
		const jobDir = path.join(seat, "jobs", Job);
		const record = JSON.stringify({
			state: "working",
			sessionId: "s-job5",
			cwd: repo,
		});
		return ` mkdir -p ${shellQuote(jobDir)}; echo ${shellQuote(record)} > ${shellQuote(path.join(jobDir, "state.json"))};`;
	};

	it.each([
		{
			record: "gone",
			damage: () =>
				fs.rmSync(path.join(seat, "jobs", Job), { recursive: true }),
			resumeAs: "continued",
			onResume: restoresJobRecord,
		},
		{
			record: "torn",
			damage: () =>
				fs.writeFileSync(path.join(seat, "jobs", Job, "state.json"), "{"),
			resumeAs: "copy",
			onResume: () => "",
		},
	] as const)(
		"resumes from its marker alone, launching nothing fresh, where its job's record is $record (#3773)",
		async ({ damage, resumeAs, onResume }) => {
			seed();
			damage();
			const parkedIn = at("parked-in");
			fs.mkdirSync(parkedIn);
			writeMarker(`seat ${seat}\njob ${Job}\ncwd ${parkedIn}\n5\n`);
			fakeResumeClaude(
				Job,
				[LISTED],
				stopOnResume() + logsResumeDir + onResume(),
				resumeAs,
			);
			const r = await settled(run(1), ParkedRun);
			expect(r.status).toBe(0);
			expect(readLines(at("calls"))).toEqual([
				`--bg --resume s-job5 ${PARKED_PROMPT}`,
				`dir ${parkedIn}`,
			]);
			expect(readLines(at("dispatches"))).toEqual([]);
		},
	);

	it("resumes from its checkout where its marker names a job and no cwd (#3773)", async () => {
		seed();
		writeMarker(`seat ${seat}\njob ${Job}\n5\n`);
		fakeResumeClaude(Job, [LISTED], stopOnResume() + logsResumeDir);
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`--bg --resume s-job5 ${PARKED_PROMPT}`,
			`dir ${repo}`,
		]);
		expect(readLines(at("dispatches"))).toEqual([]);
	});

	it("launches afresh on its takes: command where the resume names no job", async () => {
		seed();
		fakeResumeClaude(Job, [LISTED]);
		fs.writeFileSync(at("bg-stdout"), "");
		fs.writeFileSync(at("bg-stderr"), "");
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(readLines(at("calls"))).toEqual([
			`--bg --resume s-job5 ${PARKED_PROMPT}`,
		]);
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
		expect(r.stdout).toMatch(
			/parked .* \/implement 5 not resumed: the launcher never said what it started/,
		);
	});

	it("releases an away park's ledger row before the tick reads its shortlist, so the ticket resumes (#3872)", async () => {
		seed();
		const pickNext = path.join(scripts, "pick-next.js");
		const ledger = ledgerPath(repo);
		fs.writeFileSync(
			pickNext,
			`require("node:fs").copyFileSync(${JSON.stringify(ledger)}, ${JSON.stringify(at("ledger-at-read"))});\n${fs.readFileSync(pickNext, "utf8")}`,
		);
		fs.mkdirSync(path.dirname(ledger), { recursive: true });
		fs.writeFileSync(ledger, "");
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					{
						root: repo,
						issues: [5],
						prompt: "/implement 5",
						seat,
						jobId: Job,
						launchedAt: Date.now() - 2000,
						finishedAt: Date.now() - 1000,
						parkStopped: Date.now() - 1500,
						parkedAway: true,
					},
				],
			}),
		);
		fakeResumeClaude(Job, [LISTED], stopOnResume());
		const r = await settled(run(1), ParkedRun);
		expect(r.status).toBe(0);
		expect(
			readLines(at("ledger-at-read")).map((l) => JSON.parse(l).released),
		).toContain(Job);
		expect(readLines(at("calls"))).toEqual([
			`--bg --resume s-job5 ${PARKED_PROMPT}`,
		]);
		expect(launches()[0]).not.toHaveProperty("parkedAway");
	});
});

/* The stub dispatcher requests a stop, so a started loop ticks, launches and
 * exits: its pidfile goes, after the dispatch that shows it ran. */
const untilLoopEnded = () =>
	polled(
		() =>
			readLines(at("dispatches")).length > 0 &&
			!fs.existsSync(at(".refill-loop.pid")),
		"the started loop did not end",
	);

const commandFromRepo = (...argv: string[]) =>
	runInProcessAsync(path.join(scripts, "refill-loop.js"), argv, {
		cwd: dir,
		env: loopEnv({ FAKE_SLOTS: "1", CLAUDE_PROJECT_DIR: repo }),
	});

const storedScope = () => ({
	mode: "away",
	repos: [repo],
	goal: {
		form: "issues",
		text: "5",
		refs: [{ repo: path.basename(repo), number: 5 }],
		setAt: 3,
	},
});
const writeStored = (extra: object = {}) =>
	fs.writeFileSync(
		loopControlFile(),
		JSON.stringify({
			noProgressFrom: 5,
			stopRequested: false,
			seats: [seat],
			scope: storedScope(),
			...extra,
		}),
	);

describe("`set --resume` with no process (#3861)", () => {
	it("restarts a stopped loop from its stored repos, goal and mode", async () => {
		writeStored();
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				stopped: { at: 6, reason: "no-progress", detail: "three launches" },
			}),
		);
		const before = Date.now();
		const r = await commandFromRepo("set", "--resume");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("not paused");
		expect(r.stdout).toMatch(/^refill loop started: pid \d+$/m);
		await untilLoopEnded();
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
		const after = JSON.parse(fs.readFileSync(loopControlFile(), "utf8"));
		expect(after.scope).toMatchObject(storedScope());
		expect(after.paused).toBeUndefined();
		expect(after.noProgressFrom).toBeGreaterThanOrEqual(before);
	});

	it("refuses a damaged control, starting nothing", async () => {
		fs.writeFileSync(loopControlFile(), "{ not json");
		const r = await commandFromRepo("set", "--resume");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("is damaged");
		expect(r.stderr).toContain("`start` rewrites it");
		expect(fs.existsSync(at(".refill-loop.pid"))).toBe(false);
	});

	it("exits 1, saying why, where the loop's code will not launch, and reads no crash", async () => {
		writeStored();
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({ stopped: null, heldAt: 8 }),
		);
		/* A checkout, so launchProgram wants a verified ref this one lacks. */
		spawnSync("git", ["init", "-q", at("code")]);
		const r = await commandFromRepo("set", "--resume");
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/refill loop not started: no \S+ in /);
		const json = JSON.parse((await commandFromRepo("status", "--json")).stdout);
		expect(json).toMatchObject({ running: false, crashed: false });
	});
});

describe("`start` with no process (#3868)", () => {
	const paused = { by: "founder", at: 4 };
	const readStored = () =>
		JSON.parse(fs.readFileSync(loopControlFile(), "utf8"));
	/* A paused loop launches nothing, so nothing ends it but a stop. */
	const stopOnceHolding = async () => {
		await polled(
			() => fs.existsSync(at(".refill-loop.pid")),
			"the started loop never held the pidfile",
		);
		await commandFromRepo("stop");
		await polled(
			() => !fs.existsSync(at(".refill-loop.pid")),
			"the stopped loop did not end",
		);
	};

	it("starts a crashed loop from its stored settings as they were, with --unless-stopped", async () => {
		writeStored({ paused });
		const before = readStored();
		const r = await commandFromRepo("start", "--unless-stopped");
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^refill loop started: pid \d+$/m);
		expect(r.stdout).toContain("paused by founder at");
		await stopOnceHolding();
		const after = readStored();
		expect(after.scope).toMatchObject(before.scope);
		expect(after.paused).toEqual(paused);
		expect(after.noProgressFrom).toBe(5);
		expect(after.seats).toEqual([seat]);
	});
});

describe("a case's end (#4140)", () => {
	const readCmdline = (pid: string) =>
		fs.readFileSync(path.join(REAL_PROC, pid, "cmdline"), "utf8");

	const readPidsNaming = (sandbox: string) =>
		fs.readdirSync(REAL_PROC).filter((name) => {
			if (!/^\d+$/.test(name)) return false;
			try {
				return readCmdline(name).includes(sandbox);
			} catch (err) {
				const { code } = err as NodeJS.ErrnoException;
				if (code === "ENOENT" || code === "ESRCH") return false;
				throw err;
			}
		});

	const failedCases: {
		sandbox: string;
		running: Promise<unknown>;
		upAtThrow: boolean;
		atDeletion?: string[];
	}[] = [];

	/* Throws, as a failing case does. The last case reads what teardown left: a
	 * failure raised around an it.fails case, its hooks' included, counts as that
	 * case's expected one. */
	const failWithLoopUp = (running: Promise<unknown>, upAtThrow: boolean) => {
		const failed: (typeof failedCases)[number] = {
			sandbox: dir,
			running,
			upAtThrow,
		};
		failedCases.push(failed);
		const { rmSync } = fs;
		const spy = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
			failed.atDeletion = readPidsNaming(failed.sandbox);
			rmSync(...args);
		});
		onTestFinished(() => spy.mockRestore());
		throw new Error("the case fails with its loop up");
	};

	it.fails("ends a loop started as a child", async () => {
		const running = runAsProcess(0);
		await ticked(1);
		failWithLoopUp(running, readPidsNaming(dir).length > 0);
	});

	it.fails("ends a detached loop", async () => {
		writeStored({ paused: { by: "founder", at: 4 } });
		const running = commandFromRepo("start");
		await running;
		/* A paused loop asks no admission, so its tick reads in its state. */
		await polled(
			() =>
				Boolean(
					JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"))
						.lastTick,
				),
			"the started loop never ticked",
		);
		failWithLoopUp(running, readPidsNaming(dir).length > 0);
	});

	it.fails("ends a loop running in process", async () => {
		const running = run(0);
		await ticked(1);
		failWithLoopUp(running, liveRun === running);
	});

	it("left none of them, each gone before its sandbox", async () => {
		expect(failedCases).toHaveLength(3);
		for (const failed of failedCases) {
			expect(failed.upAtThrow).toBe(true);
			expect((await within(failed.running)).done).toBe(true);
			expect(failed.atDeletion).toEqual([]);
			expect(readPidsNaming(failed.sandbox)).toEqual([]);
			expect(fs.existsSync(failed.sandbox)).toBe(false);
		}
	});

	it("leaves a neighbour a stale pidfile names", () => {
		/* Its environment names no sandbox, as another run's would not. */
		const neighbour = spawnIdleHolder(process.env);
		onTestFinished(() => {
			try {
				/* A killed process's command line reads empty. */
				expect(readCmdline(String(neighbour.pid))).not.toBe("");
			} finally {
				neighbour.kill("SIGKILL");
			}
		});
		fs.writeFileSync(at(".refill-loop.pid"), String(neighbour.pid));
	});
});

describe("boot-resume after a restart (#3878)", () => {
	const countFrom = Date.now() - 3 * 24 * 60 * 60 * 1000;
	const writeControl = () =>
		fs.writeFileSync(
			loopControlFile(),
			JSON.stringify({
				noProgressFrom: countFrom,
				stopRequested: false,
				seats: [seat],
				scope: { mode: "normal", repos: [repo], goal: null },
			}),
		);
	const command = commandFromRepo;
	const readLog = () => readLines(at(".refill-loop.log")).join("\n");
	const spawnHolder = () => {
		const holder = spawnIdleHolder(loopEnv({}));
		fs.writeFileSync(at(".refill-loop.pid"), String(holder.pid));
		return holder;
	};
	const exited = (holder: ReturnType<typeof spawn>) =>
		new Promise((resolve) => {
			holder.once("exit", resolve);
			holder.kill();
		});

	it("restarts a loop no stop ended, however old its start, which it keeps", async () => {
		writeControl();
		expect((await command("boot-resume")).status).toBe(0);
		await untilLoopEnded();
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
		expect(
			JSON.parse(fs.readFileSync(loopControlFile(), "utf8")).noProgressFrom,
		).toBe(countFrom);
		expect(readLog()).toContain(
			`boot resume: resumed the loop counting from ${new Date(countFrom).toISOString()}, pid `,
		);
	});

	it("starts no second loop beside a running one", async () => {
		writeControl();
		const holder = spawnHolder();
		try {
			expect((await command("boot-resume")).status).toBe(0);
			expect(readLog()).toContain(
				`boot resume: not resumed: already running, pid ${holder.pid}`,
			);
			expect(
				JSON.parse(
					fs.readFileSync(at(".refill-loop-manager-restart.json"), "utf8"),
				),
			).toEqual({ bootId: readCurrentBootId(), at: expect.any(Number) });
			expect(fs.readFileSync(at(".refill-loop.pid"), "utf8")).toBe(
				String(holder.pid),
			);
			expect(fs.existsSync(at("ticks"))).toBe(false);
		} finally {
			await exited(holder);
		}
	});

	it("exits 1, logging why, where the loop's code will not launch", async () => {
		writeControl();
		/* A checkout, so launchProgram wants a verified ref this one lacks. */
		spawnSync("git", ["init", "-q", at("code")]);
		expect((await command("boot-resume")).status).toBe(1);
		expect(readLog()).toMatch(/boot resume: not resumed: no \S+ in /);
		expect(fs.existsSync(at("ticks"))).toBe(false);
	});

	describe("watch, the timer's look for a dead loop (#4139)", () => {
		const watch = (systemctlBody = "") => {
			fs.mkdirSync(at("watch-bin"), { recursive: true });
			fs.writeFileSync(
				at("watch-bin/systemctl"),
				`#!/bin/sh\necho "$*" >> ${shellQuote(at("systemctl-calls"))}\n${systemctlBody}\n`,
				{ mode: 0o755 },
			);
			return runInProcessAsync(
				path.join(scripts, "refill-loop.js"),
				["watch"],
				{
					cwd: dir,
					env: loopEnv({
						PATH: `${at("watch-bin")}:${process.env.PATH}`,
					}),
				},
			);
		};
		const readCalls = () => readLines(at("systemctl-calls"));
		const logFile = at.bind(null, ".refill-loop.log");

		it("restarts the boot unit past a dead loop's pidfile, so boot-resume decides", async () => {
			writeControl();
			const holder = spawnHolder();
			await exited(holder);
			expect((await watch()).status).toBe(0);
			expect(readCalls()).toEqual(["--user restart refill-loop-boot.service"]);
			expect(fs.existsSync(at("ticks"))).toBe(false);
		});

		it("does nothing and writes no log line for a live holder, even a paused one", async () => {
			fs.writeFileSync(
				loopControlFile(),
				JSON.stringify({
					noProgressFrom: countFrom,
					stopRequested: false,
					paused: { by: "command", at: countFrom },
					seats: [seat],
					scope: { mode: "normal", repos: [repo], goal: null },
				}),
			);
			const holder = spawnHolder();
			try {
				expect((await watch()).status).toBe(0);
				expect(readCalls()).toEqual([]);
				expect(fs.existsSync(logFile())).toBe(false);
				expect(fs.existsSync(at(".refill-loop-manager-restart.json"))).toBe(
					false,
				);
			} finally {
				await exited(holder);
			}
		});

		it("stands down while a launch is in flight, its lock live", async () => {
			writeControl();
			const launcher = spawnIdleHolder(loopEnv({}));
			fs.writeFileSync(at(".refill-loop-launch.pid"), String(launcher.pid));
			try {
				expect((await watch()).status).toBe(0);
				expect(readCalls()).toEqual([]);
			} finally {
				await exited(launcher);
			}
		});

		it("leaves a damaged control alone, writing no log line", async () => {
			fs.writeFileSync(loopControlFile(), "{");
			expect((await watch()).status).toBe(0);
			expect(readCalls()).toEqual([]);
			expect(fs.existsSync(logFile())).toBe(false);
		});

		it("exits 1, naming the restart, where it fails, for the unit's ExecStopPost", async () => {
			writeControl();
			const r = await watch("echo denied >&2; exit 1");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("--user restart refill-loop-boot.service");
			expect(r.stderr).toContain("denied");
		});
	});

	describe("where the spawned loop holds no lock (#4083)", () => {
		/* Node loads this into the spawned `run` alone: the command under test runs
		 * in process, and a holder's own argv has no `run`. */
		const commandWithPreload = (source: string, ...argv: string[]) => {
			const preload = at("preload.js");
			fs.writeFileSync(
				preload,
				`if (process.argv[2] === "run") { ${source} }\n`,
			);
			return runInProcessAsync(path.join(scripts, "refill-loop.js"), argv, {
				cwd: dir,
				env: loopEnv({
					FAKE_SLOTS: "1",
					CLAUDE_PROJECT_DIR: repo,
					NODE_OPTIONS: `--require ${preload}`,
				}),
			});
		};
		const Dies = "process.exit(0);";
		/* Plants a live holder, so the loop then loses the lock to it. */
		const buildLosingPreload = () => `
			const holder = require("node:child_process").spawn(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
				{ detached: true, stdio: "ignore" },
			);
			holder.unref();
			require("node:fs").writeFileSync(${JSON.stringify(at(".refill-loop.pid"))}, String(holder.pid));
		`;

		it("boot-resume exits 1, logging a failure, where the loop dies", async () => {
			writeControl();
			const r = await commandWithPreload(Dies, "boot-resume");
			expect(r.status).toBe(1);
			expect(readLog()).toContain(
				"boot resume: not resumed: the loop exited without holding",
			);
			expect(readLog()).not.toContain("resumed the loop");
		});

		it("boot-resume keeps the last loop's crash on record where the loop dies", async () => {
			writeControl();
			fs.writeFileSync(
				at(".refill-loop-state.json"),
				JSON.stringify({ heldAt: 5 }),
			);
			await commandWithPreload(Dies, "boot-resume");
			expect(
				JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"))
					.heldAt,
			).toBe(5);
		});

		it("boot-resume names the holder where the loop loses the lock", async () => {
			writeControl();
			const r = await commandWithPreload(buildLosingPreload(), "boot-resume");
			const holder = Number(fs.readFileSync(at(".refill-loop.pid"), "utf8"));
			try {
				expect(r.status).toBe(1);
				expect(readLog()).toContain(
					`boot resume: not resumed: pid ${holder} holds`,
				);
				expect(readLog()).toContain("another refill loop holds");
				expect(readLog()).not.toContain("resumed the loop");
			} finally {
				process.kill(holder, "SIGKILL");
			}
		});

		it("`start` reports no started loop where the loop dies", async () => {
			writeControl();
			const r = await commandWithPreload(Dies, "start");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"refill loop not started: the loop exited without holding",
			);
			expect(r.stderr).toContain(`log: ${at(".refill-loop.log")}`);
			expect(readLog()).toContain(
				"refill loop not started: the loop exited without holding",
			);
			expect(r.stdout).not.toContain("refill loop started");
		});
	});
});

describe("a paused loop on the real tick (#3856)", () => {
	const control = () => at(".refill-loop-control.json");
	const stateFile = () => at(".refill-loop-state.json");
	const pauseControl = () =>
		fs.writeFileSync(
			control(),
			JSON.stringify({
				...JSON.parse(fs.readFileSync(control(), "utf8")),
				paused: { by: "founder", at: 7 },
			}),
		);
	const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
	const ticksDone = () =>
		polled(() => fs.existsSync(stateFile()), "no paused tick wrote its state");
	const setCommand = (flag: string) =>
		/* spawn-kept: two processes at once, as requestStop's. */
		spawnSync(
			process.execPath,
			[path.join(scripts, "refill-loop.js"), "set", flag],
			{ cwd: dir, env: loopEnv({}), encoding: "utf8" },
		);

	it("clears a stop recorded before this run once it holds the pidfile (#3861)", async () => {
		/* The reap child's one crossing; refill-tick-core.test.ts's "a paused
		 * tick" holds what a paused tick does and does not call. */
		stub(
			"reap-finished-sessions.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("reaped"))}, "called\\n");\n`,
		);
		pauseControl();
		fs.writeFileSync(
			stateFile(),
			JSON.stringify({ stopped: { at: 6, reason: "explicit", detail: "x" } }),
		);
		const running = run(1);
		await ticksDone();
		expect(readState().stopped).toBeNull();
		requestStop();
		await settled(running, "paused run");
		expect(readState().stopped.reason).toBe("explicit");
		expect(readState().stopped.at).toBeGreaterThan(6);
		expect(readLines(at("reaped")).length).toBeGreaterThan(0);
	});

	it("launches again on a resume, with no restart (#3943)", async () => {
		pauseControl();
		const running = runAsProcess(1);
		await ticksDone();
		expect(fs.existsSync(at("dispatches"))).toBe(false);

		const resumed = setCommand("--resume");
		expect(resumed.status).toBe(0);
		expect(resumed.stdout).not.toContain("refill loop started");
		/* The stub dispatcher asks for the stop that ends this run. */
		const r = await settled(running, "run after a resume");

		expect(r.status).toBe(0);
		expect(readLines(at("dispatches")).join("\n")).toContain("/implement 5");
	});
});

describe("a ticked repo its owner opts out, on the real tick (#4188)", () => {
	const controlFile = () => at(".refill-loop-control.json");
	const readControl = () => JSON.parse(fs.readFileSync(controlFile(), "utf8"));
	const writeConfig = (config: object) =>
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify(config),
		);

	it("unticks it, logged, so opting back in serves it only once ticked again", async () => {
		/* Paused, so the tick dispatches nothing and the run outlasts it. */
		fs.writeFileSync(
			controlFile(),
			JSON.stringify({ ...readControl(), paused: { by: "founder", at: 7 } }),
		);
		writeConfig({ refillLoop: false });
		const running = run(1);
		await polled(
			() => readControl().scope.repos.length === 0,
			"no tick unticked the opted-out repo",
		);
		writeConfig({});
		requestStop();
		const r = await settled(running, "run past an opt-out");

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`unticked: ${repo} (opted out)`);
		expect(readControl().scope.repos).toEqual([]);
	});
});

describe("away mode's return on the real tick (#3870)", () => {
	const controlFile = () => at(".refill-loop-control.json");
	const readControl = () => JSON.parse(fs.readFileSync(controlFile(), "utf8"));
	/* Paused, so each tick dispatches nothing and the run outlasts it. */
	const seedAway = (absentSeen: boolean) => {
		const control = readControl();
		fs.writeFileSync(
			controlFile(),
			JSON.stringify({
				...control,
				paused: { by: "founder", at: 7 },
				away: { since: 7, absentSeen },
				scope: { ...control.scope, mode: "away" },
			}),
		);
	};
	const typedAt = (ms: number) =>
		fs.writeFileSync(at("no-presence"), `${new Date(ms).toISOString()}\n`);
	const wake = () =>
		fs.appendFileSync(at(".refill-loop-wake"), `${Date.now()}\n`);
	const modeIs = (mode: string) =>
		polled(() => readControl().scope.mode === mode, `no tick read ${mode}`);

	it("leaves the return to the next tick while another writer holds the lock", async () => {
		seedAway(true);
		typedAt(Date.now());
		const holder = spawnIdleHolder(loopEnv({}));
		try {
			fs.writeFileSync(`${controlFile()}.lock`, String(holder.pid));
			const running = run(1);
			await polled(
				() => fs.existsSync(at(".refill-loop-state.json")),
				"no tick wrote its state",
			);
			expect(readControl().scope.mode).toBe("away");

			holder.kill();
			wake();
			await modeIs("normal");
			requestStop();
			const r = await settled(running, "run past a held lock");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("away mode's change waits for the next tick");
		} finally {
			holder.kill();
		}
	});

	it("writes nothing on a dry run", async () => {
		seedAway(true);
		typedAt(Date.now());
		const r = await runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["dry-run"],
			{ cwd: dir, env: loopEnv({ FAKE_SLOTS: "1" }) },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("the founder is back");
		expect(readControl().scope.mode).toBe("away");
	});
});

describe("the loop's own waits on the real tick (#3859)", () => {
	const control = () =>
		JSON.parse(fs.readFileSync(at(".refill-loop-control.json"), "utf8"));
	const state = () => {
		const file = at(".refill-loop-state.json");
		return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	};
	const seedStalled = () => {
		const now = Date.now();
		fs.writeFileSync(
			at(".refill-loop-state.json"),
			JSON.stringify({
				launches: [7, 8, 9].map((n) => ({
					root: repo,
					issues: [n],
					prompt: `/implement ${n}`,
					seat,
					jobId: `j${n}`,
					launchedAt: now,
					finishedAt: now + n,
					acts: {},
				})),
			}),
		);
	};
	const wake = () => fs.writeFileSync(at(".refill-loop-wake"), "");
	const statusJson = () =>
		JSON.parse(
			/* spawn-kept: the loop holds runInProcess's claim. */
			spawnSync(
				process.execPath,
				[path.join(scripts, "refill-loop.js"), "status", "--json"],
				{ cwd: dir, env: loopEnv({}), encoding: "utf8" },
			).stdout,
		);

	it("pauses on no progress, stays up launching nothing, and launches only after `set --resume`", async () => {
		seedStalled();
		const running = runAsProcess(1);
		await polled(
			() => control().paused !== undefined,
			"no tick wrote the no-progress pause",
		);
		expect(control().paused).toMatchObject({
			by: "no-progress",
			issues: [7, 8, 9].reverse().map((number) => ({ root: repo, number })),
		});
		const pausedAt = control().paused.at;

		const lastTickAt = state().lastTick.at;
		wake();
		await polled(
			() => state().lastTick.at > lastTickAt,
			"no tick ran after the pause",
		);
		expect(state().stopped ?? null).toBeNull();
		expect(fs.existsSync(at("dispatches"))).toBe(false);
		expect(control().paused.at).toBe(pausedAt);
		expect(statusJson().paused.by).toBe("no-progress");

		// spawn-kept: the loop holds the pidfile the command reads.
		const resumed = spawnSync(
			process.execPath,
			[path.join(scripts, "refill-loop.js"), "set", "--resume"],
			{ cwd: dir, env: loopEnv({}), encoding: "utf8" },
		);
		expect(resumed.status).toBe(0);
		/* The stub dispatcher asks for the stop that ends this run. */
		const r = await settled(running, "run after a resume");
		expect(r.status).toBe(0);
		expect(readLines(at("dispatches")).join("\n")).toContain("/implement 5");
	});
});

describe("a repo hold on the real tick (#3857)", () => {
	const hold = (...args: string[]) =>
		runInProcess(path.join(__dirname, "repo-hold.js"), args, {
			cwd: repo,
			env: loopEnv({
				CLAUDE_PROJECT_DIR: repo,
				CLAUDE_JOB_DIR: "",
				CLAUDE_CODE_SESSION_ID: "",
			}),
		});
	const raise = (...clear: string[]) =>
		hold("raise", "--act", "repair main", "--issue", "12", ...clear);
	const listed = () => hold("list").stdout;
	const holdTick = (gh = "") =>
		settled(run(1, gh ? { WFC_GH: gh } : {}), "run with a hold");

	it("stays while its command fails, launching on, and lifts the tick it passes", async () => {
		raise("--clear-command", "test -f fixed");

		const failing = await holdTick();

		expect(failing.status).toBe(0);
		expect(failing.stdout).not.toContain("repo hold cleared");
		expect(listed()).toContain("repair main");
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);

		fs.writeFileSync(path.join(repo, "fixed"), "");
		const passing = await holdTick();

		expect(passing.status).toBe(0);
		expect(passing.stdout).toContain("repo hold cleared");
		expect(passing.stdout).toContain("repair main");
		expect(passing.stdout).toContain("passed command: test -f fixed");
		expect(listed()).toContain("none open");
	});

	it("lifts nothing on a dry run", async () => {
		raise("--clear-command", "true");

		const dryRun = await runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["dry-run"],
			{ cwd: dir, env: loopEnv({ FAKE_SLOTS: "1" }) },
		);

		expect(dryRun.status).toBe(0);
		expect(dryRun.stdout).toContain("dry run:");
		expect(listed()).toContain("repair main");
	});
});

describe("a probe hold on the real tick (#3860)", () => {
	const Issue = 77;
	const stateFile = () => at(".refill-loop-state.json");
	const dotGit = (name: string) => path.join(repo, ".git", name);
	const breakHead = () => fs.writeFileSync(dotGit("HEAD"), "junk\n");
	const repairHead = () =>
		fs.writeFileSync(dotGit("HEAD"), "ref: refs/heads/main\n");

	const writeConfig = (root: string) =>
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/r" }),
		);

	const serveClose = () => {
		fs.mkdirSync(at("gh-routes"), { recursive: true });
		return stubGhRoutes(at("gh-routes"), {
			"issue list *": printed("[]"),
			[`issue close ${Issue} *`]: printed(""),
			"issue edit *": printed(""),
			"*": readGhAnswer(LOGGED_OUT),
		});
	};

	/* The filer's seam: lib/file-through.js spawns it by path. */
	const stubFiler = () =>
		stub(
			"file-issue.js",
			`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(at("filed"))}, JSON.stringify({ args: process.argv.slice(2), body: fs.readFileSync(0, "utf8"), cwd: process.cwd() }) + "\\n");
process.stdout.write("Filed #${Issue}\\n");
`,
		);
	const readFiled = () =>
		readLines(at("filed")).map(
			(l) =>
				JSON.parse(l) as {
					args: string[];
					body: string;
					cwd: string;
				},
		);

	beforeEach(() => {
		writeConfig(repo);
		stubFiler();
	});

	/** One run whose stop follows its first tick's state: two real ticks. */
	const tickRun = async (gh = "", over: NodeJS.ProcessEnv = {}) => {
		fs.rmSync(stateFile(), { force: true });
		return tickOnState(gh, over);
	};

	/* The state file must read no lastTick, or the wait below ends at once. */
	const tickOnState = async (gh = "", over: NodeJS.ProcessEnv = {}) => {
		updateControl({ stopRequested: false });
		const running = run(1, { ...over, ...(gh ? { WFC_GH: gh } : {}) });
		await polled(
			() =>
				fs.existsSync(stateFile()) &&
				Boolean(JSON.parse(fs.readFileSync(stateFile(), "utf8")).lastTick),
			"no tick wrote its state",
		);
		requestStop();
		return settled(running, "run with a probe hold");
	};

	const readStatus = async () =>
		(
			await runInProcessAsync(
				path.join(scripts, "refill-loop.js"),
				["status"],
				{
					cwd: dir,
					env: loopEnv({}),
				},
			)
		).stdout;

	it("stops launches within a tick of a broken .git, and the tick after its repair clears it, closes its issue and launches", async () => {
		const close = serveClose();
		breakHead();

		const broken = await tickRun(close.gh);

		expect(broken.status).toBe(0);
		expect(broken.stdout).toContain(`probe failed in ${repo}: fetch origin:`);
		expect(broken.stdout).toContain("repo hold raised: probe in");
		expect(fs.existsSync(at("dispatches"))).toBe(false);
		expect(await readStatus()).toMatch(
			new RegExp(`probe repo: .*issue #${Issue}, .*stops launches: yes`),
		);
		const filed = readFiled();
		expect(filed).toHaveLength(1);
		expect(filed[0]?.args).toContain("takes:triage");
		expect(filed[0]?.body).toContain(repo);
		expect(filed[0]?.body).toContain("resolve main:");
		expect(filed[0]?.body).not.toContain("resolve main: names no commit");

		repairHead();
		const repaired = await tickRun(close.gh);

		expect(repaired.status).toBe(0);
		expect(repaired.stdout).toContain("repo hold cleared: probe in");
		expect(repaired.stdout).not.toContain("could not close");
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
		expect(await readStatus()).toContain("holds:     none open");
		expect(readFiled()).toHaveLength(1);
	});

	it("keeps launching into the other served checkout", async () => {
		const other = at("other");
		probedCheckout.instantiate(other);
		fs.mkdirSync(path.join(other, ".claude"));
		writeConfig(other);
		updateControl({
			scope: { mode: "normal", repos: [repo, other], goal: null },
		});
		stub(
			"dispatch-sessions.sh",
			`printf '%s\\n' "$PWD" >> ${shellQuote(at("dispatches"))}
node ${shellQuote(path.join(scripts, "request-stop.js"))}\n`,
		);
		breakHead();

		const { status, stdout } = await tickRun(serveClose().gh);

		expect(status).toBe(0);
		expect(stdout).toContain(`probe failed in ${repo}`);
		expect(stdout).not.toContain(`probe failed in ${other}`);
		expect(readLines(at("dispatches"))).toEqual([other]);
	});

	it("records a failed probe in the loop's state, and drops it the tick the probe passes (#3903)", async () => {
		const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
		fs.writeFileSync(at("repo-holds"), "a file, not a directory\n");
		breakHead();

		const failed = await tickRun(serveClose().gh);

		expect(failed.status).toBe(0);
		expect(failed.stdout).toContain(`repo hold probe in ${repo}: not kept:`);
		expect(readState().probeBrokenRoots).toEqual([repo]);

		repairHead();
		fs.writeFileSync(
			stateFile(),
			JSON.stringify({ ...readState(), lastTick: null }),
		);
		expect((await tickOnState(serveClose().gh)).status).toBe(0);
		expect(readState().probeBrokenRoots).toEqual([]);
	});

	it("resumes the sessions parked on it through admission, oldest first, once its .git is repaired (#3863)", async () => {
		const close = serveClose();
		breakHead();
		await tickRun(close.gh);
		const attachJob = (job: string, issue: number, age: number) => {
			const attached = runInProcess(
				path.join(__dirname, "repo-hold.js"),
				["attach", "probe"],
				{
					cwd: repo,
					env: loopEnv({
						CLAUDE_PROJECT_DIR: repo,
						CLAUDE_JOB_DIR: path.join(seat, "jobs", job),
						CLAUDE_CODE_SESSION_ID: "",
					}),
				},
			);
			expect(attached.status, attached.stderr).toBe(0);
			writeParkMarker(job, issue, age);
		};
		attachJob("job8", 8, 5);
		attachJob("job9", 9, 30);
		fakeResumeClaude("job8", [LISTED]);
		stub(
			"allowance.js",
			"process.stdout.write(JSON.stringify({ cap: { launch: 9 } }));\n",
		);
		repairHead();
		updateControl({ stopRequested: false });

		const running = run(2, { WFC_GH: close.gh });
		await polled(
			() => readLines(at("calls")).length === 2,
			"the resumes never came",
		);
		requestStop();
		const repaired = await settled(running, "run with a repaired .git");

		expect(repaired.status).toBe(0);
		expect(repaired.stdout).toContain("repo hold cleared: probe in");
		expect(readLines(at("calls"))).toEqual([
			`--bg --resume s-job9 ${HOLD_PROMPT}`,
			`--bg --resume s-job8 ${HOLD_PROMPT}`,
		]);
		expect(fs.existsSync(at("dispatches"))).toBe(false);
		expect(repaired.stdout).toMatch(/resumed 2 of 2 due/);
		expect(fs.existsSync(markerPath("s-job9"))).toBe(false);
	});

	it("probes nothing on a dry run, and leaves a stored hold's launches out of its preview", async () => {
		breakHead();

		const clean = await runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["dry-run"],
			{ cwd: dir, env: loopEnv({ FAKE_SLOTS: "1" }) },
		);

		expect(clean.stdout).toContain("dry run:");
		expect(clean.stdout).not.toContain("probe failed");
		expect(await readStatus()).toContain("none open");
		expect(readFiled()).toHaveLength(0);

		await tickRun(serveClose().gh);
		const held = await runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["dry-run"],
			{ cwd: dir, env: loopEnv({ FAKE_SLOTS: "1" }) },
		);

		expect(held.stdout).not.toContain("/implement 5");
	});

	describe("a guard entry that will not load (#4226)", () => {
		const guardEntry = () => path.join(repo, "scripts", "guard-dispatch.js");
		/* The shared tree's own entry, under the served checkout: the loop runs
		 * from its code copy, whose entry stays healthy. */
		const writeGuardEntry = (body: string) => {
			fs.mkdirSync(path.dirname(guardEntry()), { recursive: true });
			fs.writeFileSync(
				guardEntry(),
				`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(at("guard-runs"))}, JSON.stringify({ cwd: process.cwd(), dir: process.env.CLAUDE_PROJECT_DIR, payload: JSON.parse(fs.readFileSync(0, "utf8")) }) + "\\n");
${body}`,
			);
		};
		const Failing =
			'process.stderr.write("\\nLexer is not defined\\n");\nprocess.exit(1);\n';
		const Healthy = "process.exit(0);\n";
		const hooksFile = () =>
			path.join(repo, "self-plugin", "hooks", "hooks.json");
		const guardRuns = () =>
			readLines(at("guard-runs")).map(
				(l) =>
					JSON.parse(l) as {
						cwd: string;
						dir: string;
						payload: {
							session_id: string;
							tool_name: string;
							tool_input: { file_path: string };
						};
					},
			);

		beforeEach(() => {
			fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
			fs.writeFileSync(hooksFile(), "{}\n");
		});

		it("stops launches, raises the hold and files its issue on its first tick, off the shared tree's own entry", async () => {
			writeGuardEntry(Failing);

			const broken = await tickRun(serveClose().gh);

			expect(broken.status).toBe(0);
			expect(broken.stdout).toContain(
				`probe failed in ${repo}: guard entry: Lexer is not defined`,
			);
			expect(broken.stdout).not.toContain("a hold rises at");
			expect(broken.stdout).toContain("repo hold raised: probe in");
			expect(fs.existsSync(at("dispatches"))).toBe(false);
			const filed = readFiled();
			expect(filed).toHaveLength(1);
			expect(filed[0]?.body).toContain("guard entry: Lexer is not defined");
			/* Two ticks, each probe a run and its re-run. */
			const runs = guardRuns();
			expect(runs).toHaveLength(4);
			expect(runs[0]).toEqual({
				cwd: fs.realpathSync(repo),
				dir: repo,
				payload: expect.objectContaining({
					session_id: "refill-loop-guard-probe",
					tool_name: "Read",
					tool_input: expect.objectContaining({ file_path: hooksFile() }),
				}),
			});
		});

		it("attaches a session that parks while it stands, and resumes it through admission once the entry loads", async () => {
			const close = serveClose();
			writeGuardEntry(Failing);
			fs.writeFileSync(
				stateFile(),
				JSON.stringify({
					launches: [
						{
							root: repo,
							issues: [7],
							prompt: "/implement 7",
							seat,
							jobId: "job7",
							sessionId: "s-job7",
							launchedAt: Date.now() - 10 * 60_000,
							finishedAt: null,
						},
					],
				}),
			);
			writeClaudeStub(at("claude"), [
				buildAgentsBranch([buildJobRow("job7", "blocked")]),
				buildStopBranch(at("stops")),
			]);

			const broken = await tickOnState(close.gh);

			expect(broken.stdout).toContain("repo hold raised: probe in");
			expect(broken.stdout).toMatch(
				/repo hold attached: probe in .*; session job7; 1 attached/,
			);

			writeParkMarker("job7", 7, 5);
			fakeResumeClaude("job7", [LISTED]);
			stub(
				"allowance.js",
				"process.stdout.write(JSON.stringify({ cap: { launch: 9 } }));\n",
			);
			writeGuardEntry(Healthy);
			updateControl({ stopRequested: false });
			const running = run(2, { WFC_GH: close.gh });
			await polled(
				() => readLines(at("calls")).some((l) => l.startsWith("--bg")),
				"the resume never came",
			);
			requestStop();
			const repaired = await settled(running, "run with a loading entry");

			expect(repaired.stdout).toContain("repo hold cleared: probe in");
			expect(readLines(at("calls"))).toContain(
				`--bg --resume s-job7 ${HOLD_PROMPT}`,
			);
		});
	});
});

describe("the sessions parked on a cleared repo hold (#3863)", () => {
	const Hold = "repair main";
	let gh: string;
	const stateFile = () => at(".refill-loop-state.json");
	const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
	const resumeOf = (job: string) => `--bg --resume s-${job} ${HOLD_PROMPT}`;
	const readCalls = () => readLines(at("calls"));

	const holdAs = (job: string | null, ...args: string[]) =>
		runInProcess(path.join(__dirname, "repo-hold.js"), args, {
			cwd: repo,
			env: loopEnv({
				CLAUDE_PROJECT_DIR: repo,
				CLAUDE_JOB_DIR: job ? path.join(seat, "jobs", job) : "",
				CLAUDE_CODE_SESSION_ID: "",
				WFC_GH: gh,
			}),
		});

	/** A hold `job` raised and `attached` parked on, read off the line it prints. */
	const raiseWith = (job: string, ...attached: string[]) => {
		const id = parseHoldId(
			holdAs(
				job,
				"raise",
				"--act",
				Hold,
				"--issue",
				"12",
				"--clear-issue",
				"12",
			).stdout,
		);
		for (const other of attached)
			expect(holdAs(other, "attach", id).status).toBe(0);
		return id;
	};

	const editCalls = () =>
		readLines(at("gh-calls")).filter((l) => l.startsWith("issue edit"));

	beforeEach(() => {
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/r" }),
		);
		fs.mkdirSync(at("gh-routes"), { recursive: true });
		gh = stubGhRoutes(
			at("gh-routes"),
			{ "*": printed("") },
			{ log: at("gh-calls") },
		).gh;
		/* Over every tick's slots, so admission alone paces them. */
		stub(
			"allowance.js",
			"process.stdout.write(JSON.stringify({ cap: { launch: 9 } }));\n",
		);
	});

	/** One loop run with `slots` free, asked to stop once `isDone` holds; the
	 * default is the tick's state written. */
	const tickUntil = async (slots: number, isDone?: () => boolean) => {
		const control = at(".refill-loop-control.json");
		fs.writeFileSync(
			control,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(control, "utf8")),
				stopRequested: false,
			}),
		);
		if (fs.existsSync(stateFile()))
			fs.writeFileSync(
				stateFile(),
				JSON.stringify({ ...readState(), lastTick: null }),
			);
		const running = run(slots, { WFC_GH: gh });
		await polled(
			isDone ??
				(() => fs.existsSync(stateFile()) && Boolean(readState().lastTick)),
			"the tick never got there",
		);
		requestStop();
		return settled(running, "run with a cleared hold");
	};

	it("resumes a hold's raiser and those attached the same way off a hand lift, its labels and markers gone", async () => {
		const id = raiseWith("job8", "job9");
		writeParkMarker("job8", 8, 5);
		writeParkMarker("job9", 9, 30);
		expect(holdAs(null, "lift", id).status).toBe(0);
		fakeResumeClaude("job8", [LISTED]);

		const r = await tickUntil(2, () => readCalls().length === 2);

		expect(r.status).toBe(0);
		expect(readCalls()).toEqual([resumeOf("job9"), resumeOf("job8")]);
		expect(fs.existsSync(at("dispatches"))).toBe(false);
		expect(editCalls()).toEqual([
			"issue edit 9 --repo o/r --remove-label parked",
			"issue edit 8 --repo o/r --remove-label parked",
		]);
		expect(fs.existsSync(markerPath("s-job8"))).toBe(false);
		expect(fs.existsSync(markerPath("s-job9"))).toBe(false);
		expect(holdAs(null, "list").stdout).toContain("none open");
		const store = fs.readdirSync(at("repo-holds"))[0] ?? "";
		expect(fs.readdirSync(at(`repo-holds/${store}/lifted`))).toEqual([]);
	});

	it("takes up the launch the loop already holds for a session it parked, finished and stopped", async () => {
		const id = raiseWith("job8");
		writeParkMarker("job8", 8, 5);
		holdAs(null, "lift", id);
		const at0 = Date.now() - 3_600_000;
		fs.writeFileSync(
			stateFile(),
			JSON.stringify({
				launches: [
					{
						root: repo,
						issues: [8],
						prompt: "/implement 8",
						seat,
						reason: "first with room",
						jobId: "job8",
						sessionId: "s-job8",
						launchedAt: at0,
						finishedAt: at0,
						parkStopped: at0,
					},
				],
			}),
		);
		fakeResumeClaude("job8", [LISTED]);

		const r = await tickUntil(1, () => readCalls().length === 1);

		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/resumed repo \/implement 8, parked at .* on repo hold/,
		);
		const [launch] = readState().launches;
		expect(launch).toMatchObject({
			issues: [8],
			prompt: "/implement 8",
			finishedAt: null,
			jobId: FAKE_COPY,
			copiedFrom: "job8",
		});
		expect(launch).not.toHaveProperty("parkStopped");
		expect(launch).not.toHaveProperty("holdCleared");
	});

	it("resumes those that do not fit on later ticks, new launches behind them", async () => {
		const id = raiseWith("job7", "job8", "job9");
		writeParkMarker("job7", 7, 30);
		writeParkMarker("job8", 8, 20);
		writeParkMarker("job9", 9, 10);
		holdAs(null, "lift", id);
		fakeResumeClaude("job7", [LISTED]);

		const first = await tickUntil(2, () => readCalls().length === 2);

		expect(first.status).toBe(0);
		expect(readCalls()).toEqual([resumeOf("job7"), resumeOf("job8")]);
		expect(fs.existsSync(at("dispatches"))).toBe(false);
		expect(first.stdout).toMatch(/resumed 2 of 3 due/);

		const last = await tickUntil(2, () => fs.existsSync(at("dispatches")));

		expect(last.status).toBe(0);
		expect(readCalls().at(-1)).toBe(resumeOf("job9"));
		expect(readCalls()).toHaveLength(3);
		expect(readLines(at("dispatches"))).toEqual(["opus /implement 5"]);
	});

	it("takes the swap hold's try count on a failed resume, then its hand-off", async () => {
		const id = raiseWith("job8");
		writeParkMarker("job8", 8, 5);
		holdAs(null, "lift", id);
		fakeResumeClaude("job8", [LISTED]);
		fs.writeFileSync(at("bg-stdout"), "");
		fs.writeFileSync(at("bg-stderr"), "");
		stub(
			"rescue-sessions.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("hand-offs"))}, process.argv.slice(2).join(" ") + "\\n");\nprocess.stdout.write("commented: #8\\n");\n`,
		);

		const failed = await tickUntil(1);

		expect(failed.status).toBe(0);
		expect(failed.stdout).toMatch(/could not resume .*try 1 of 3/);
		expect(readState().launches[0].holdCleared.tries).toBe(1);
		expect(editCalls()).toEqual([]);
		expect(fs.existsSync(markerPath("s-job8"))).toBe(true);

		const state = readState();
		state.launches[0].holdCleared.tries = 2;
		fs.writeFileSync(stateFile(), JSON.stringify(state));

		const last = await tickUntil(1);

		expect(last.status).toBe(0);
		expect(last.stdout).toMatch(/could not resume .*try 3 of 3/);
		expect(readLines(at("hand-offs"))).toEqual([
			`hand-off --from ${seat} --job job8 --session s-job8 --issue 8`,
		]);
		expect(readState().launches[0]).toMatchObject({
			finishedAt: expect.any(Number),
			handedOff: expect.any(Number),
		});
		expect(readState().launches[0]).not.toHaveProperty("holdCleared");
		expect(editCalls()).toEqual([
			"issue edit 8 --repo o/r --remove-label parked",
		]);
		expect(fs.existsSync(markerPath("s-job8"))).toBe(false);
	});

	it("stops one its normal-mode round still holds, then resumes it", async () => {
		const id = raiseWith("job8");
		writeParkMarker("job8", 8, 5);
		holdAs(null, "lift", id);
		fakeResumeClaude("job8", [LISTED, buildJobRow("job8", "blocked")]);

		const r = await tickUntil(1, () => readCalls().length === 2);

		expect(r.status).toBe(0);
		expect(readCalls()).toEqual(["stop job8", resumeOf("job8")]);
	});

	it("keeps a lifted hold's sessions through a tick that stops", async () => {
		const id = raiseWith("job8");
		writeParkMarker("job8", 8, 5);
		holdAs(null, "lift", id);
		fakeResumeClaude("job8", [LISTED, buildJobRow("job8", "blocked")]);
		const control = at(".refill-loop-control.json");
		fs.writeFileSync(
			control,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(control, "utf8")),
				stopRequested: true,
			}),
		);

		const r = await settled(run(1, { WFC_GH: gh }), "run told to stop");

		expect(r.status).toBe(0);
		expect(readCalls()).toEqual([]);
		const store = fs.readdirSync(at("repo-holds"))[0] ?? "";
		expect(fs.readdirSync(at(`repo-holds/${store}/lifted`))).toHaveLength(1);
	});

	it("keeps a lifted hold's sessions through a paused tick", async () => {
		const id = raiseWith("job8");
		writeParkMarker("job8", 8, 5);
		holdAs(null, "lift", id);
		fakeResumeClaude("job8", [LISTED]);
		const control = at(".refill-loop-control.json");
		fs.writeFileSync(
			control,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(control, "utf8")),
				paused: { by: "test", at: Date.now() },
			}),
		);

		const r = await tickUntil(1);

		expect(r.status).toBe(0);
		expect(readCalls()).toEqual([]);
		const store = fs.readdirSync(at("repo-holds"))[0] ?? "";
		expect(fs.readdirSync(at(`repo-holds/${store}/lifted`))).toHaveLength(1);
	});
});

describe("the launches a restart killed (#3880)", () => {
	const Min = 60 * 1000;
	const stateFile = () => at(".refill-loop-state.json");
	const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
	const readCalls = () => readLines(at("calls"));
	const buildResumeArgs = (job: string) =>
		`--bg --resume s-${job} ${BOOT_PROMPT}`;
	const readKilled = () =>
		readState()
			.launches.filter((l: { bootKilled?: unknown }) => l.bootKilled)
			.map((l: { jobId: string }) => l.jobId);

	const buildLaunch = (jobId: string, issue: number, age: number) => ({
		root: repo,
		issues: [issue],
		prompt: `/implement ${issue}`,
		seat,
		jobId,
		sessionId: `s-${jobId}`,
		launchedAt: Date.now() - age * Min,
		finishedAt: null,
	});

	const writeState = (launches: object[], booted = true) =>
		fs.writeFileSync(
			stateFile(),
			JSON.stringify({ launches, ...(booted ? { bootedAt: Date.now() } : {}) }),
		);

	/* The hand-off, recorded. */
	const stubHandOff = () => {
		stub(
			"rescue-sessions.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("hand-offs"))}, process.argv.slice(2).join(" ") + "\\n");\nprocess.stdout.write("commented\\n");\n`,
		);
	};

	/** One loop run with `slots` free, asked to stop once it has written a tick
	 * and `isDone` holds, the last run's stop cleared first. */
	const tickWith = async (
		slots: number,
		isDone: () => boolean = () => true,
		over: NodeJS.ProcessEnv = {},
	) => {
		const control = at(".refill-loop-control.json");
		fs.writeFileSync(
			control,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(control, "utf8")),
				stopRequested: false,
			}),
		);
		const before = readState().lastTick?.at ?? 0;
		const running = run(slots, over);
		await polled(
			() => (readState().lastTick?.at ?? 0) > before && isDone(),
			"the tick never got there",
		);
		requestStop();
		return settled(running, "a run with launches a restart killed");
	};

	it("resumes them by session id as far as admission allows, oldest first, the rest on later ticks", async () => {
		writeState([
			buildLaunch("job7", 7, 10),
			buildLaunch("job8", 8, 30),
			buildLaunch("job9", 9, 20),
		]);
		fakeResumeClaude("job8", [LISTED]);
		/* Over every tick's slots, so admission alone paces them. */
		stub(
			"allowance.js",
			"process.stdout.write(JSON.stringify({ cap: { launch: 9 } }));\n",
		);

		const first = await tickWith(2, () => readCalls().length === 2);

		expect(first.status).toBe(0);
		expect(readCalls()).toEqual([
			buildResumeArgs("job8"),
			buildResumeArgs("job9"),
		]);
		expect(readKilled()).toEqual(["job7"]);
		expect(readState()).not.toHaveProperty("bootedAt");
		expect(fs.existsSync(at("dispatches"))).toBe(false);
		expect(first.stdout).toMatch(/resumed 2 of 3 due/);
		expect(first.stdout).toContain(
			"repo /implement 8, killed by a restart: due back through the resume step",
		);
		expect(first.stdout).toMatch(
			/resumed repo \/implement 8, launched at .*, killed by a restart, by --bg --resume/,
		);

		const last = await tickWith(1, () => readCalls().length === 3);

		expect(last.status).toBe(0);
		expect(readCalls().at(-1)).toBe(buildResumeArgs("job7"));
		expect(readKilled()).toEqual([]);
	});

	it("tracks the copy a resume started where a kill beat the state write, its claim handed on, and starts no second (#4157)", async () => {
		writeState([buildLaunch("job8", 8, 30)]);
		arbiterAs("s-job8", "claim-issue", "8");
		const transcript = (session: string) =>
			path.join(seat, "projects", "repo", `${session}.jsonl`);
		const opening = `${JSON.stringify({ type: "user", uuid: "u-first", sessionId: "s-job8" })}\n`;
		fs.mkdirSync(path.dirname(transcript("s-job8")), { recursive: true });
		fs.writeFileSync(transcript("s-job8"), opening);
		const copyDir = path.join(seat, "jobs", FAKE_COPY);
		const copyRecord = JSON.stringify({
			state: "working",
			sessionId: `s-${FAKE_COPY}`,
			cwd: repo,
			createdAt: "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)",
		});
		/* The copy started, then the loop killed before it reads the launcher's
		 * answer: a real SIGKILL, as the gap is a process's death. */
		fakeResumeClaude(
			"job8",
			[LISTED],
			[
				`mkdir -p ${shellQuote(copyDir)};`,
				`echo "${copyRecord.replaceAll('"', '\\"')}" > ${shellQuote(path.join(copyDir, "state.json"))};`,
				`cp ${shellQuote(transcript("s-job8"))} ${shellQuote(transcript(`s-${FAKE_COPY}`))};`,
				"kill -9 $PPID;",
			].join(" "),
		);
		/* spawn-kept: the kill needs a loop of its own process to land on. */
		const killed = spawn(
			process.execPath,
			[path.join(scripts, "refill-loop.js"), "run"],
			{ cwd: dir, env: loopEnv({ FAKE_SLOTS: "1" }), stdio: "ignore" },
		);
		const signal = await new Promise((done) =>
			killed.on("exit", (_, s) => done(s)),
		);

		expect(signal).toBe("SIGKILL");
		expect(readCalls()).toEqual([buildResumeArgs("job8")]);
		expect(readState().launches[0]).toMatchObject({
			jobId: "job8",
			bootKilled: { resumeStartedAt: expect.any(Number) },
		});
		expect(arbiterAs("s-job8", "issue-claims")).toContain("s-job8");

		fakeResumeClaude("job8", [LISTED]);
		const next = await tickWith(1);

		expect(next.status).toBe(0);
		expect(readCalls()).toEqual([buildResumeArgs("job8")]);
		expect(readKilled()).toEqual([]);
		expect(readState().launches[0]).toMatchObject({
			jobId: FAKE_COPY,
			sessionId: `s-${FAKE_COPY}`,
			copiedFrom: "job8",
			bootResumedAt: expect.any(Number),
		});
		expect(readState().launches[0]).not.toHaveProperty("bootKilled");
		expect(next.stdout).toMatch(
			/as its copy c0de7a11, which a kill left out of the state: tracking it, not resuming again/,
		);
		const claims = arbiterAs(`s-${FAKE_COPY}`, "issue-claims");
		expect(claims).toContain(`s-${FAKE_COPY}`);
		expect(claims).not.toContain("s-job8");
	});

	describe("the user manager's restart within a boot (#3971)", () => {
		const outsideSession = { CLAUDE_CODE_SESSION_ID: "" };
		const markerFile = () => at(".refill-loop-manager-restart.json");
		const writeMarker = (bootId: string | null) =>
			fs.writeFileSync(
				markerFile(),
				JSON.stringify({ bootId, at: Date.now() }),
			);
		const bootResume = () =>
			runInProcessAsync(path.join(scripts, "refill-loop.js"), ["boot-resume"], {
				cwd: dir,
				env: loopEnv({
					FAKE_SLOTS: "1",
					CLAUDE_PROJECT_DIR: repo,
					...outsideSession,
				}),
			});
		const writeStateOnBoot = (bootId: string) =>
			fs.writeFileSync(
				stateFile(),
				JSON.stringify({ launches: [buildLaunch("job7", 7, 10)], bootId }),
			);

		/* job7's process is this test's own: the registry proves it alive. */
		const writeLiveRegistry = () => {
			fs.mkdirSync(path.join(seat, "sessions"), { recursive: true });
			fs.writeFileSync(
				path.join(seat, "sessions", `${process.pid}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId: "s-job7",
					procStart: readProcStartOf(process.pid),
					jobId: "job7",
				}),
			);
		};

		it("queues no live session where the restarted loop's listing is empty", async () => {
			writeStateOnBoot(String(readCurrentBootId()));
			writeLiveRegistry();
			fakeResumeClaude("job7", []);

			expect((await bootResume()).status).toBe(0);
			await polled(() => Boolean(readState().lastTick), "no tick ran");
			requestStop();
			await polled(
				() => !fs.existsSync(at(".refill-loop.pid")),
				"the started loop did not end",
			);

			expect(readCalls()).toEqual([]);
			expect(readKilled()).toEqual([]);
			const state = readState();
			expect(state.launches[0].finishedAt).toBeNull();
			expect(state.launches[0]).not.toHaveProperty("bootKilled");
			expect(state).toMatchObject({
				bootedAt: expect.any(Number),
				sameBootRestart: true,
				bootId: readCurrentBootId(),
			});
			expect(fs.readFileSync(at(".refill-loop.log"), "utf8")).toContain(
				"a restart's killed launches wait on the listing:",
			);
		});

		it("brings back what a total kill left, the listing and the registry both empty", async () => {
			writeStateOnBoot(String(readCurrentBootId()));
			fs.mkdirSync(path.join(seat, "sessions"), { recursive: true });
			const stop = `node ${shellQuote(path.join(scripts, "request-stop.js"))};`;
			fakeResumeClaude("job7", [], stop);

			expect((await bootResume()).status).toBe(0);
			await polled(
				() =>
					!fs.existsSync(at(".refill-loop.pid")) && readCalls().length === 1,
				"the started loop did not resume it",
			);

			expect(readCalls()).toEqual([buildResumeArgs("job7")]);
			expect(readState()).not.toHaveProperty("sameBootRestart");
		});

		it("queues the sessions a surviving loop's marker says the restart killed", async () => {
			writeState([buildLaunch("job7", 7, 10)], false);
			writeMarker(readCurrentBootId());
			fakeResumeClaude("job7", [LISTED]);

			const r = await tickWith(1, () => readCalls().length === 1);

			expect(r.status).toBe(0);
			expect(readCalls()).toEqual([buildResumeArgs("job7")]);
			expect(r.stdout).toContain("killed by a restart: due back");
			expect(readState()).not.toHaveProperty("bootedAt");
			expect(readState()).not.toHaveProperty("sameBootRestart");
			expect(fs.existsSync(markerFile())).toBe(false);
		});
	});

	describe("a resumed session", () => {
		const jobDir = () => path.join(seat, "jobs", "job7");
		/* Minutes: past block-act.js's 5 of idle wait. */
		const PastWait = 6;

		/** Job7 listed working, resumed `minutes` ago, its last turn before that. */
		const seedResumed = (
			minutes: number,
			listing: Row[] = [LISTED, buildJobRow("job7", "working")],
		) => {
			stubHandOff();
			fs.writeFileSync(
				path.join(repo, ".claude", "workflow-core.json"),
				JSON.stringify({ tracker: "o/r" }),
			);
			const resumedAt = Date.now() - minutes * Min;
			const transcript = at("transcript.jsonl");
			fs.writeFileSync(
				transcript,
				`${JSON.stringify({
					type: "assistant",
					isSidechain: false,
					timestamp: new Date(resumedAt - Min).toISOString(),
					message: { content: [{ type: "text", text: "Working." }] },
				})}\n`,
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
					linkScanPath: transcript,
				}),
			);
			writeState(
				[
					{
						...buildLaunch("job7", 7, 30),
						relaunchedAt: resumedAt,
						bootResumedAt: resumedAt,
					},
				],
				false,
			);
			fakeResumeClaude("job7", listing);
		};

		it("is typed at once it stays idle past the wait, as a host's restart is", async () => {
			seedResumed(PastWait);
			const r = await tickWith(0);
			expect(r.status).toBe(0);
			expect(readCalls()).toEqual(["attach job7", `typed ${IDLE_PROMPT}`]);
			expect(readState().launches[0].idleResumes.tries).toBe(1);
		});

		it("is handed off gone from the listing with no turn, the resume having taken and then died", async () => {
			seedResumed(PastWait, [LISTED]);
			const r = await tickWith(0);
			expect(r.status).toBe(0);
			expect(readLines(at("hand-offs"))).toEqual([
				`hand-off --from ${seat} --job job7 --session s-job7 --issue 7`,
			]);
			expect(readState().launches[0].handedOff).toEqual(expect.any(Number));
		});
	});

	describe("a job no transcript backs (#3983)", () => {
		/* Working, past the grace, with no process and no transcript. */
		const writeNeverStarted = (job: string) => {
			const store = path.join(seat, "jobs", job);
			fs.mkdirSync(store, { recursive: true });
			fs.writeFileSync(
				path.join(store, "state.json"),
				JSON.stringify({
					state: "working",
					sessionId: `s-${job}`,
					cwd: repo,
					createdAt: new Date(Date.now() - 60 * Min).toISOString(),
				}),
			);
			fs.mkdirSync(path.join(seat, "sessions"), { recursive: true });
		};
		const readStops = (job: string) =>
			readCalls().filter((c) => c === `stop ${job}`);

		it("is stopped once queued, and still resumed", async () => {
			writeNeverStarted("job7");
			const bootKilled = {
				at: Date.now() - 60 * Min,
				sessionId: "s-job7",
				cwd: repo,
				tries: 0,
			};
			writeState([{ ...buildLaunch("job7", 7, 60), bootKilled }], false);
			fakeResumeClaude("job7", [LISTED]);

			const stopped = await tickWith(0, () => readStops("job7").length > 0);

			expect(stopped.status).toBe(0);
			expect(stopped.stdout).toMatch(/stopped never-started job job7 on /);
			expect(readKilled()).toEqual(["job7"]);

			/* What a real stop leaves on the record, which the stop stub does not write. */
			const record = path.join(seat, "jobs", "job7", "state.json");
			fs.writeFileSync(
				record,
				JSON.stringify({ state: "stopped", sessionId: "s-job7", cwd: repo }),
			);
			fakeResumeClaude(
				"job7",
				[LISTED],
				writesWokenRecord(record, "s-job7"),
				"woke",
			);

			const later = await tickWith(1, () =>
				readCalls().includes(buildResumeArgs("job7")),
			);

			expect(later.status).toBe(0);
			expect(later.stdout).toMatch(
				/killed by a restart, by --bg --resume, woken in place/,
			);
			expect(readKilled()).toEqual([]);
			expect(readState().launches[0]).toMatchObject({
				jobId: "job7",
				finishedAt: null,
			});
		});
	});

	it("is set off by boot-resume itself, on the tick of the loop it starts", async () => {
		writeState([buildLaunch("job7", 7, 10)], false);
		const stop = `node ${shellQuote(path.join(scripts, "request-stop.js"))};`;
		fakeResumeClaude("job7", [LISTED], stop);

		const r = await runInProcessAsync(
			path.join(scripts, "refill-loop.js"),
			["boot-resume"],
			{
				cwd: dir,
				env: loopEnv({ FAKE_SLOTS: "1", CLAUDE_PROJECT_DIR: repo }),
			},
		);

		expect(r.status).toBe(0);
		await polled(
			() => !fs.existsSync(at(".refill-loop.pid")) && readCalls().length === 1,
			"the started loop did not resume it",
		);
		expect(readCalls()).toEqual([buildResumeArgs("job7")]);
	});
});

describe("a repo hold's phone notice on the real tick (#3871)", () => {
	const Issue = 77;
	const stateFile = () => at(".refill-loop-state.json");
	const breakHead = () =>
		fs.writeFileSync(path.join(repo, ".git", "HEAD"), "junk\n");
	const repairHead = () =>
		fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");

	const writeConfig = (isNoticeOn = true) =>
		fs.writeFileSync(
			path.join(repo, ".claude", "workflow-core.json"),
			JSON.stringify({
				tracker: "o/r",
				...(isNoticeOn
					? {
							founderNotice: {
								workflow: "notice.yml",
								repo: "o/r",
								mention: "someone-to-page",
							},
						}
					: {}),
			}),
		);

	const readGhLog = () =>
		fs.existsSync(at("gh-log")) ? fs.readFileSync(at("gh-log"), "utf8") : "";
	/** The markers of every dispatch so far, in order. */
	const readDispatched = () =>
		[...readGhLog().matchAll(/<!-- (repo-hold-notice [^>]*) -->/g)].map(
			(m) => m[1] ?? "",
		);
	const readPhases = () => readDispatched().map((m) => m.split(" ").at(-1));

	/** gh for the next run: each dispatch so far has its comment on the issue, as
	 * the workflow would. */
	const serve = () => {
		fs.mkdirSync(at("gh-routes"), { recursive: true });
		const comments = readDispatched().map((m) => ({
			body: `@x hello\n\n<!-- ${m} -->`,
		}));
		return stubGhRoutes(
			at("gh-routes"),
			{
				"issue list *": printed("[]"),
				[`issue close ${Issue} *`]: printed(""),
				"issue edit *": printed(""),
				[`issue view ${Issue} *`]: printed(JSON.stringify({ comments })),
				"run list *": printed("[]"),
				"workflow run *": printed(""),
				"*": readGhAnswer(LOGGED_OUT),
			},
			{ log: at("gh-log") },
		).gh;
	};

	/** One run whose stop follows its first tick's state: two real ticks. */
	const tickRun = async (gh: string) => {
		fs.rmSync(stateFile(), { force: true });
		updateControl({ stopRequested: false });
		const running = run(1, { WFC_GH: gh });
		await polled(
			() =>
				fs.existsSync(stateFile()) &&
				Boolean(JSON.parse(fs.readFileSync(stateFile(), "utf8")).lastTick),
			"no tick wrote its state",
		);
		requestStop();
		const done = await settled(running, "run with a hold's notice");
		expect(done.status).toBe(0);
		expect(done.stdout).not.toContain("notice not tended");
		return done;
	};

	const readStatus = async () =>
		(
			await runInProcessAsync(
				path.join(scripts, "refill-loop.js"),
				["status"],
				{ cwd: dir, env: loopEnv({}) },
			)
		).stdout;

	beforeEach(() => {
		writeConfig();
		stub(
			"file-issue.js",
			`process.stdout.write("Filed #${Issue}\\n");
`,
		);
	});

	it("sends a probe hold one notice on raise and one on clear, with none on the ticks between", async () => {
		breakHead();
		const raised = await tickRun(serve());
		expect(raised.stdout).toContain("raise notice dispatched");
		expect(readGhLog()).toContain("mention=someone-to-page");
		expect(readGhLog()).toContain(`issue=${Issue}`);
		expect(readPhases()).toEqual(["raise"]);
		expect(await readStatus()).toContain("notice: raise dispatched");

		const between = await tickRun(serve());
		expect(between.stdout).toContain("raise notice seen");
		await tickRun(serve());
		expect(readPhases()).toEqual(["raise"]);
		expect(await readStatus()).toContain("notice: raise sent, clear not sent");

		repairHead();
		const cleared = await tickRun(serve());
		expect(cleared.stdout).toContain("repo hold cleared: probe in");
		expect(cleared.stdout).toContain("clear notice dispatched");
		expect(readPhases()).toEqual(["raise", "clear"]);

		const after = await tickRun(serve());
		expect(after.stdout).toContain("clear notice seen");
		await tickRun(serve());
		expect(readPhases()).toEqual(["raise", "clear"]);
	});
});
