// @vitest-environment node
/*
 * The refill loop's `run` driven end to end through a restart or a hold: the
 * host's restart, boot-resume, the restart's kills, the repo, probe and
 * cleared holds with their phone notices, and the resume of a session an API
 * error or its seat's limit held. Split from
 * scripts/refill-loop-run.test.ts toward the 60 s per-file limit (#4389); its
 * sandbox is lib/refill-loop-run-testkit.ts's.
 *
 * The testkit's `claude` stub types through lib/claude-attach-fake.ts, which
 * answers from "scripts/fixtures/claude-attach.json": a re-recording selects
 * this file.
 *
 * Loosen it and a fault in the program's own wiring, of its libs, children
 * and exits, passes unseen (#2851).
 *
 * Why each case stays a full tick: refill-loop-run.test.ts's header keys the
 * codes (A, E, S, F, R).
 * - host restart (#2707): types after 5 min A; stops under the swap hold A;
 *   a cleared swap hold resumes A, a refused re-read A (admission --launch),
 *   a session handed off A (rescue-sessions.js).
 * - boot-resume (#3878): restarts E, no second loop E, exits 1 E; watch
 *   (#4139): restarts the unit A (systemctl), a launch in flight S, exits 1
 *   E; no lock (#4083): exits 1 E S, names the holder S, `start` exits 1 E.
 * - repo hold (#3857): its command run for real A. Probe hold (#3860): a
 *   broken .git A, the other checkout A, the state's probe A, its parked
 *   resumed A, a stored hold left out of a dry run's preview A (the hold
 *   store read). Guard entry (#4226): raises and files A, attaches and
 *   resumes A.
 * - cleared repo hold (#3863): its raiser and attached resumed off a hand
 *   lift A (repo-hold.js lift).
 * - restart's kills (#3880): resumed by id A, a copy a kill beat S R, set
 *   off by boot-resume R; the manager's restart (#3971) A ×3; a resumed
 *   session typed A, handed off A; a job no transcript backs A.
 * - phone notice (#3871): one on raise, one on clear A (gh workflow).
 * - API error (#2705): types into the live session A (attach, pty_type.py);
 *   judged by state.json A; the copy tracked as the job A; pass markers
 *   moved A.
 * - limit hold (#3735): resumes under its seat A; the ledger hold A and its
 *   swap A; moved to another plan seat A; onto a key A, its first overflow
 *   start A.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./lib/admission-verdict-fake";
import {
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
	type Row,
} from "./lib/agents-stop-fake";
import { readCurrentBootId, readProcStartOf } from "./lib/arbiter-proc.js";
import { buildRekeyedResponse, FAKE_COPY } from "./lib/bg-resume-fake";
import { buildBgBranch, writeClaudeStub } from "./lib/claude-stub";
import { ledgerPath, readOverflowLookup } from "./lib/dispatch-ledger.js";
import { buildFiledLine } from "./lib/filed-line.js";
import { readGhAnswer } from "./lib/gh-fake";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import {
	API_PROMPT,
	BOOT_PROMPT,
	HOLD_PROMPT,
	IDLE_PROMPT,
	LIMIT_PROMPT,
	MOVED_PROMPT,
} from "./lib/loop-prompts.js";
import { buildMeminfo } from "./lib/meminfo-fake";
import { projectSlug } from "./lib/project-slug.js";
import {
	arbiterAs,
	at,
	commandFromRepo,
	dir,
	fakeResumeClaude,
	LISTED,
	launchState,
	ledgerLaunch,
	loopControlFile,
	loopEnv,
	markerPath,
	oneTick,
	polled,
	readGhActs,
	readHeadlessResumes,
	readHeldIssues,
	readLines,
	readLoopState,
	readStopped,
	refillSandbox,
	repo,
	requestStop,
	run,
	scripts,
	seat,
	settled,
	spawnIdleHolder,
	stub,
	untilLoopEnded,
	updateControl,
	weekAt,
	writeKeyCostTable,
	writesCopyRecord,
	writesWokenRecord,
} from "./lib/refill-loop-run-testkit";
import { parseHoldId, probedCheckout } from "./lib/repo-hold-fixture";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import {
	type SystemctlAnswers,
	systemctlCalls,
	writeSystemctl,
} from "./lib/systemctl-fake";
import { buildUsageCache } from "./lib/usage-probe-fake";

refillSandbox();

const LOGGED_OUT = path.join(__dirname, "lib/fixtures/gh/logged-out.json");

/* Swap under a quarter free and MemAvailable under the hold's line (#2690),
 * or neither. */
const MEMINFO_HOLD = buildMeminfo({
	availableMb: 1024,
	swapTotalMb: 2048,
	swapFreeMb: 256,
});

/** `job`'s park marker, written `age` minutes ago, listing its issue. */
const writeParkMarker = (job: string, issue: number, age: number) => {
	const file = markerPath(`s-${job}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `seat ${seat}\njob ${job}\ncwd ${repo}\n${issue}\n`);
	const parkedAt = new Date(Date.now() - age * 60_000);
	fs.utimesSync(file, parkedAt, parkedAt);
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
		const watch = (answers: SystemctlAnswers = {}) =>
			runInProcessAsync(path.join(scripts, "refill-loop.js"), ["watch"], {
				cwd: dir,
				env: loopEnv({
					WFC_SYSTEMCTL: writeSystemctl(at("watch-bin"), answers),
				}),
			});
		const readCalls = () => systemctlCalls(at("watch-bin"));

		it("restarts the boot unit past a dead loop's pidfile, so boot-resume decides", async () => {
			writeControl();
			const holder = spawnHolder();
			await exited(holder);
			expect((await watch()).status).toBe(0);
			expect(readCalls()).toEqual([
				"systemctl --user restart refill-loop-boot.service",
			]);
			expect(fs.existsSync(at("ticks"))).toBe(false);
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

		it("exits 1, naming the restart, where it fails, for the unit's ExecStopPost", async () => {
			writeControl();
			const r = await watch({
				fails: { restart: { exit: 1, says: "denied" } },
			});
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
process.stdout.write(${JSON.stringify(`${buildFiledLine(Issue, `https://github.com/o/r/issues/${Issue}`)}\n`)});
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

	it("leaves a stored hold's launches out of a dry run's preview", async () => {
		breakHead();
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
			fakeResumeClaude("job7", [LISTED], writesWokenRecord(record, "s-job7"), {
				resumeAs: "woke",
			});

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
			`process.stdout.write(${JSON.stringify(`${buildFiledLine(Issue, `https://github.com/o/r/issues/${Issue}`)}\n`)});
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
			{ resumeAs: "woke" },
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
				buildBgBranch({
					out: at("bg-stdout"),
					err: at("bg-stderr"),
					onLaunch: `echo "$1 $2 $3 in $CLAUDE_CONFIG_DIR from $PWD" >> "$calls"; ${onResume}`,
				}),
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
			fakeResumeClaude(Job, [LISTED], envSeen);
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
			const [resume, ...more] = readHeadlessResumes();
			expect(more).toEqual([]);
			expect(resume?.sessionId).toBe("s-job7");
			expect(resume?.flags["--resume"]).toBe("s-job7");
			expect(resume?.flags["--name"]).toBe("Overflow · /implement 7");
			const budget = resume?.flags["--max-budget-usd"];
			expect(Number(budget)).toBeGreaterThan(0);
			expect(
				JSON.parse(String(resume?.flags["--settings"])).apiKeyHelper,
			).toMatch(/overflow-key\.js'? '?K2/);
			const { jobId } = launchState();
			expect(jobId).toMatch(/^[0-9a-f]{8}$/);
			expect(launchState()).toMatchObject({
				seat,
				keyVar: "K2",
				reason: expect.stringMatching(/^moved from /),
				finishedAt: null,
				issues: [7],
			});
			const row = readOverflowLookup([repo])({ jobId });
			expect(row).toMatchObject({
				keyVar: "K2",
				sessionId: "s-job7",
				allowanceUsd: Number(budget),
			});
			expect(
				JSON.parse(readLines(ledgerPath(repo)).at(-1) ?? ""),
			).toMatchObject({ issues: [], jobId, kind: "overflow" });
			const comments = readLines(at("gh-calls")).join("\n");
			expect(comments).toContain(`to ${seat} on overflow key K2`);
			expect(comments).toContain("its allowance there $");
		});

		it("settles a move whose headless run ended before the next tick, never moving it back (#4580)", async () => {
			seedOverflow();
			fakeResumeClaude(Job, [LISTED], "", { headless: "end" });
			const r = await oneTick(Run, 1);
			expect(r.status).toBe(0);
			expect(r.stdout).not.toContain("could not move");
			expect(launchState()).toMatchObject({
				keyVar: "K2",
				jobId: expect.stringMatching(/^[0-9a-f]{8}$/),
			});
			expect(launchState().limitHeld).toBeUndefined();
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
	});

	it("writes a dispatch-ledger hold past the run, and its stop names the session and seat (#3785)", async () => {
		seed();
		weekAt(100);
		fakeResumeClaude(Job, [LISTED], "", { resumeAs: "woke" });
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
		fakeResumeClaude(Job, [LISTED], writesWokenRecord(jobFile(), "s-job7"), {
			resumeAs: "woke",
		});
		await oneTick(Run, 1);
		const rows = readLines(ledgerPath(repo)).map((l) => JSON.parse(l));
		expect(rows).toEqual([
			expect.objectContaining({ released: Job }),
			expect.objectContaining({ issues: [7], jobId: Job }),
		]);
		expect(rows[1]).not.toHaveProperty("heldUntil");
	});
});
