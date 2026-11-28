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
import { keptSpawn } from "./kept-spawn.js";
import { buildMeminfo } from "./meminfo-fake";
import { writeNetProbeFake } from "./net-probe-fake";
import { REAL_PROC } from "./proc-root.js";
import { probedCheckout } from "./repo-hold-fixture";
import { runInProcess, runInProcessAsync } from "./run-in-process.js";
import { shellQuote } from "./sh-quote.js";
import {
	buildShortlist,
	buildShortlistRow,
	buildShortlistStub,
} from "./shortlist-fake";
import { killCarrying, killPid } from "./suite-ceiling.js";
import { buildUsageCache } from "./usage-probe-fake";

export const LISTED = buildListedRow({
	id: "other",
	sessionId: "other",
	kind: "background",
	status: "idle",
	state: "blocked",
});

export let dir: string;

let outlived = false;

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
	WFC_NET_PROBE: at("net-probe"),
	GITHUB_ACTIONS: "",
	...over,
});

export const setOffline = (offline: boolean) =>
	offline
		? fs.writeFileSync(at("offline"), "")
		: fs.rmSync(at("offline"), { force: true });

export const markerPath = (session: string, root = repo) =>
	path.join(root, ".claude", "tmp", "markers", `.parked-${session}`);

export const readLines = (file: string) =>
	fs.existsSync(file)
		? fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];

export const readGhActs = () =>
	readLines(at("gh-calls")).filter(
		(l) =>
			!l.startsWith("issue list --repo o/r --state closed --label parked "),
	);

export const stub = (name: string, body: string) =>
	fs.writeFileSync(path.join(scripts, name), body);

export const stubDispatcher = (body: string) =>
	fs.writeFileSync(
		path.join(scripts, "dispatch-sessions.js"),
		`#!/usr/bin/env bash\n${body}`,
		{ mode: 0o755 },
	);

const SANDBOX_FILES = [
	...new Set([
		"../refill-loop.js",
		...readProgramLibs("refill-loop.js"),
		"headless-contract.md",
		"../pty_type.py",
		"fail_open.py",
		"../session-arbiter.js",
		...readProgramLibs("session-arbiter.js"),
	]),
];

export function refillSandbox() {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-run-"));
		fs.writeFileSync(at("meminfo"), MEMINFO_NO_HOLD);
		writeNetProbeFake(at("net-probe"), at("offline"));
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
		weekAt(10);
		fs.writeFileSync(
			at(".refill-loop-control.json"),
			JSON.stringify({
				runFrom: Date.now(),
				stopRequested: false,
				seats: [seat],
				scope: { mode: "normal", repos: [repo], goal: null },
			}),
		);
		fs.writeFileSync(
			at(".refill-gate-readings.json"),
			JSON.stringify({ lastSweepAt: Date.now() }),
		);

		stub(
			"admission.js",
			`require("node:fs").appendFileSync(${JSON.stringify(at("ticks"))}, "tick\\n");
require("node:fs").appendFileSync(${JSON.stringify(at("admitted-in"))}, process.cwd() + " " + process.env.CLAUDE_PROJECT_DIR + "\\n");
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
			buildShortlistStub(buildShortlist({ frontier: [buildShortlistRow()] })),
		);
		const control = JSON.stringify(at(".refill-loop-control.json"));
		stub(
			"request-stop.js",
			`const fs = require("node:fs");
fs.writeFileSync(${control}, JSON.stringify({ ...JSON.parse(fs.readFileSync(${control}, "utf8")), stopRequested: true }));
fs.appendFileSync(${JSON.stringify(at(".refill-loop-wake"))}, \`\${Date.now()}\\n\`);\n`,
		);
		stubDispatcher(
			`printf '%s\\n' "$*" >> ${shellQuote(at("dispatches"))}
node ${shellQuote(path.join(scripts, "request-stop.js"))}\n`,
		);
		writeClaudeStub(at("claude"), [buildAgentsBranch([LISTED])]);
	});

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

export const spawnIdleHolder = (env: NodeJS.ProcessEnv) =>
	keptSpawn("concurrent").spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
		{ env, stdio: "ignore" },
	);

// guess, #2435
export const SETTLE_MS = 20 * 1000;

export const requestStop = () =>
	keptSpawn("concurrent").spawnSync(process.execPath, [
		path.join(scripts, "request-stop.js"),
	]);

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

// guess, #3814
export const POLL_MS = 50;

export const polled = async (isDone: () => boolean, neverMessage: string) => {
	const deadline = Date.now() + SETTLE_MS;
	while (!isDone()) {
		if (Date.now() > deadline) throw new Error(neverMessage);
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
};

export const ticked = (n: number) =>
	polled(() => readLines(at("ticks")).length >= n, `tick ${n} never ran`);

export const writeSeatFile = (configDir: string, week: number) =>
	fs.writeFileSync(
		path.join(configDir, ".claude.json"),
		JSON.stringify({
			...buildUsageCache({ session: 10, week }, Date.now()),
			projects: { "/": { hasTrustDialogAccepted: true } },
		}),
	);

export const weekAt = (week: number) => writeSeatFile(seat, week);

export const loopControlFile = () => at(".refill-loop-control.json");

export const updateControl = (over: Record<string, unknown>) =>
	fs.writeFileSync(
		loopControlFile(),
		JSON.stringify({
			...JSON.parse(fs.readFileSync(loopControlFile(), "utf8")),
			...over,
		}),
	);

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

export const writesWokenRecord = (jobFile: string, sessionId: string) => {
	const record = JSON.stringify({ state: "running", sessionId, cwd: repo });
	return `echo ${shellQuote(record)} > ${shellQuote(jobFile)};`;
};

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

export const readHeadlessResumes = () =>
	readHeadlessCalls(at("headless.jsonl"));

export const readLoopState = () =>
	JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"));

export const launchState = () => readLoopState().launches[0];

export const readStopped = () => readLoopState().stopped;

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

export const writeKeyCostTable = () => writeCostTable(repo, { meanUsd: 4 });

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
