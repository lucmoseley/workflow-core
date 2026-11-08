/*
 * refill-loop-run-testkit.ts — the sandbox (#2435) the refill-loop `run`
 * suites stand on, split between them by #4389 and #4602:
 * scripts/refill-loop-run.test.ts, scripts/refill-loop-run-recovery.test.ts
 * and scripts/refill-loop-run-holds.test.ts.
 *
 * The program and its lib/ closure are copied into a sandbox `scripts/`, its
 * children stubbed beside it: admission, the allowance cap, the reap, the
 * shortlist, the gate check and the dispatcher are all found from the
 * program's own directory. The copy is no git checkout, so run() adopts no
 * newer code, and the morning review's root is the sandbox, with no config, so
 * no tick files a review on a real tracker.
 *
 * Break it and every suite fails at once, or a run outlives its case (#4140).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { readProgramLibs } from "../lib-closure-fixture";
import { ADMISSION_VERDICT } from "./admission-verdict-fake";
import {
	buildAgentsBranch,
	buildListedRow,
	buildStopBranch,
	type Row,
} from "./agents-stop-fake";
import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
} from "./bg-resume-fake";
import { buildAttachBranch } from "./claude-attach-fake";
import { buildBgBranch, writeClaudeStub } from "./claude-stub";
import { writeCostTable } from "./cost-table-testkit";
import {
	DEFAULT_WINDOW_HOURS,
	ledgerPath,
	readRecentEntries,
} from "./dispatch-ledger.js";
import {
	buildHeadlessBranch,
	type HeadlessMode,
	readHeadlessCalls,
	writeHeadlessFake,
} from "./headless-run-fake";
import { buildMeminfo } from "./meminfo-fake";
import { REAL_PROC } from "./proc-root.js";
import { probedCheckout } from "./repo-hold-fixture";
import { runInProcess, runInProcessAsync } from "./run-in-process.js";
import { shellQuote } from "./sh-quote.js";
import { killCarrying, killPid } from "./suite-ceiling.js";
import { buildUsageCache } from "./usage-probe-fake";

/* One session, never a waker: an empty listing reads as unread, and a
 * listed waker holds its wake for the 10 s re-check. */
export const LISTED = buildListedRow({
	id: "other",
	sessionId: "other",
	kind: "background",
	status: "idle",
	state: "blocked",
});

export let dir: string;

/* A run that outlived its stop is left its sandbox: deleting it under the
 * running loop exits the worker, hiding the failure. */
let outlived = false;

/* The in-process loop a case has not yet seen end. */
export let liveRun: Promise<unknown> | null = null;

export let scripts: string;

export let repo: string;

export let seat: string;

export const at = (name: string) => path.join(dir, name);

const MEMINFO_NO_HOLD = buildMeminfo({
	availableMb: 8192,
	swapTotalMb: 2048,
	swapFreeMb: 2048,
});

export const loopEnv = (over: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
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

export const markerPath = (session: string, root = repo) =>
	path.join(root, ".claude", "tmp", "markers", `.parked-${session}`);

export const readLines = (file: string) =>
	fs.existsSync(file)
		? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];

/* The stub gh's calls, each tick's own read for closed parks aside. */
export const readGhActs = () =>
	readLines(at("gh-calls")).filter(
		(l) =>
			!l.startsWith("issue list --repo o/r --state closed --label parked "),
	);

/** A node stub at `name` in the sandbox scripts/. */
export const stub = (name: string, body: string) =>
	fs.writeFileSync(path.join(scripts, name), body);

/* Once per file, not per case: the closure walk is the cost (#4282). Each is
 * named from this directory, so the test selector sees the read (§X10). */
const SANDBOX_FILES = [
	...new Set([
		"../refill-loop.js",
		...readProgramLibs("refill-loop.js"),
		/* Spawned by path, not required: lib/agent-liveness.js runs the listing
		 * through it, which reads unread without it. */
		"list-agents.js",
		/* Read by path: a headless resume's appended contract (#4580). */
		"headless-contract.md",
		/* Spawned by path: the resume typed into a live session (#2705). */
		"../pty_type.py",
		/* Spawned by path: a copy's issue claims moved (#2963). */
		"../session-arbiter.js",
		...readProgramLibs("session-arbiter.js"),
	]),
];

/** Registers each case's fresh sandbox and its teardown. */
export function refillSandbox() {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-run-"));
		/* The swap hold off, so no run reads the machine's own memory (#3093). */
		fs.writeFileSync(at("meminfo"), MEMINFO_NO_HOLD);
		scripts = at("code/scripts");
		fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
		for (const f of SANDBOX_FILES)
			fs.copyFileSync(path.join(__dirname, f), path.join(scripts, "lib", f));

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
			"session-checkout.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("reaped"))}, process.cwd() + " " + process.argv.slice(2).join(" ") + "\\n");\n`,
		);
		stub(
			"pick-next.js",
			`process.stdout.write(JSON.stringify({
	frontier: [{ number: 5, urgent: false, goal: false, stallDays: 0, asksQuestions: false, reach: 0, collision: "", takes: ["implement"], labels: [] }],
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
	conflictGraph: { candidates: [], inFlight: [] },
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
}

export const run = (slots: number, over: NodeJS.ProcessEnv = {}) => {
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
export const spawnIdleHolder = (env: NodeJS.ProcessEnv) =>
	spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
		{ env, stdio: "ignore" },
	);

/* A guess: some 30 times a case's 0.7 s run, and well inside the loop's
 * fallback sleep (lib/refill-wake.js's FALLBACK_MS), so a loop still running
 * past it is waiting on that sleep, not ending. */
export const SETTLE_MS = 20 * 1000;

export const requestStop = () =>
	/* spawn-kept: two processes at once — the stop lands while the loop is
	 * still running in-process, which holds runInProcess's claim. */
	spawnSync(process.execPath, [path.join(scripts, "request-stop.js")]);

/** Whether `promise` settles inside SETTLE_MS, with its value where it does. */
export const within = async <T>(promise: Promise<T>) => {
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
export const settled = async <T>(
	running: Promise<T>,
	what: string,
): Promise<T> => {
	const first = await within(running);
	if (first.done) return first.value;
	requestStop();
	outlived = !(await within(running)).done;
	throw new Error(`${what}: still running`);
};

/* A guess: short against a tick, cheap against SETTLE_MS. */
export const POLL_MS = 50;

/** Resolves once `isDone` holds, or throws `neverMessage` once SETTLE_MS passes. */
export const polled = async (isDone: () => boolean, neverMessage: string) => {
	const deadline = Date.now() + SETTLE_MS;
	while (!isDone()) {
		if (Date.now() > deadline) throw new Error(neverMessage);
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
};

/** Resolves once the stub admission has been asked `n` times. */
export const ticked = (n: number) =>
	polled(() => readLines(at("ticks")).length >= n, `tick ${n} never ran`);

/** The plan seat's fresh cache at `week`% of the week. */
export const weekAt = (week: number) =>
	fs.writeFileSync(
		path.join(seat, ".claude.json"),
		JSON.stringify(buildUsageCache({ session: 10, week }, Date.now())),
	);

export const loopControlFile = () => at(".refill-loop-control.json");

export const updateControl = (over: Record<string, unknown>) =>
	fs.writeFileSync(
		loopControlFile(),
		JSON.stringify({
			...JSON.parse(fs.readFileSync(loopControlFile(), "utf8")),
			...over,
		}),
	);

/** Ledgers job7's launch of #7 just now, the hold a hand-off releases. */
export const ledgerLaunch = (job: string) => {
	const file = ledgerPath(repo);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify({ ts: new Date().toISOString(), issues: [7], prompt: "/implement 7", jobId: job })}\n`,
	);
};

export const readHeldIssues = () =>
	readRecentEntries(repo, DEFAULT_WINDOW_HOURS).entries.map((e) => e.issues);

export const arbiterAs = (sessionId: string, ...args: string[]) =>
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

/* What a real wake leaves: the stopped job's own record, running again. */
export const writesWokenRecord = (jobFile: string, sessionId: string) => {
	const record = JSON.stringify({ state: "running", sessionId, cwd: repo });
	return `echo ${shellQuote(record)} > ${shellQuote(jobFile)};`;
};

/** `claude` for a resume of job `job`: `agents` lists `listing`, or fails
 * where it is null; `attach` records the line typed at it on a terminal
 * (lib/claude-attach-fake.ts); `--bg` prints the launcher's recorded
 * `resumeAs` response, a copy starting as FAKE_COPY (lib/bg-resume-fake.ts);
 * `-p`, a headless resume onto a key, is lib/headless-run-fake.ts's fake in
 * `headless` mode, logging to readHeadlessResumes. `onResume` runs on
 * either. */
export const fakeResumeClaude = (
	job: string,
	listing: Row[] | null,
	onResume = "",
	{
		resumeAs = "copy",
		headless = "hold",
	}: { resumeAs?: ResumeKind; headless?: HeadlessMode } = {},
) => {
	const response = buildRekeyedResponse(resumeAs, job, FAKE_COPY);
	fs.writeFileSync(at("bg-stdout"), response.stdout);
	fs.writeFileSync(at("bg-stderr"), response.stderr);
	writeClaudeStub(at("claude"), [
		`calls=${shellQuote(at("calls"))}`,
		buildAgentsBranch(listing),
		buildStopBranch(at("calls")),
		buildAttachBranch(at("calls")),
		buildHeadlessBranch(
			writeHeadlessFake(at("claude-p"), {
				log: at("headless.jsonl"),
				mode: headless,
			}),
			onResume,
		),
		buildBgBranch({
			out: at("bg-stdout"),
			err: at("bg-stderr"),
			onLaunch: `echo "$*" >> "$calls"; ${onResume}`,
		}),
	]);
};

/** Each headless resume fakeResumeClaude's `-p` fake ran, in order. */
export const readHeadlessResumes = () =>
	readHeadlessCalls(at("headless.jsonl"));

export const readLoopState = () =>
	JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"));

export const launchState = () => readLoopState().launches[0];

export const readStopped = () => readLoopState().stopped;

/** A blocked job's state.json for job7, its detail and link-scan path given. */
export const buildBlockedJobRecord = (detail: string, linkScanPath: string) =>
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

/* The served checkout's table, as the tick reads it (#3683): a grant of 2 fits
 * no session, a grant of 200 does. */
export const writeKeyCostTable = () => writeCostTable(repo, { meanUsd: 4 });

/* The shell a resume stub runs to write FAKE_COPY's job record as `record`. */
export const writesCopyRecord = (record: string) => {
	const jobDir = path.join(seat, "jobs", FAKE_COPY);
	return `mkdir -p ${shellQuote(jobDir)}; echo ${shellQuote(record)} > ${shellQuote(path.join(jobDir, "state.json"))};`;
};

export const oneTick = async (
	what: string,
	slots = 0,
	env: Record<string, string> = {},
) => {
	const running = run(slots, { WFC_GH: at("gh"), ...env });
	await ticked(1);
	requestStop();
	return settled(running, what);
};

/* The stub dispatcher requests a stop, so a started loop ticks, launches and
 * exits: its pidfile goes, after the dispatch that shows it ran. */
export const untilLoopEnded = () =>
	polled(
		() =>
			readLines(at("dispatches")).length > 0 &&
			!fs.existsSync(at(".refill-loop.pid")),
		"the started loop did not end",
	);

export const commandFromRepo = (...argv: string[]) =>
	runInProcessAsync(path.join(scripts, "refill-loop.js"), argv, {
		cwd: dir,
		env: loopEnv({ FAKE_SLOTS: "1", CLAUDE_PROJECT_DIR: repo }),
	});
