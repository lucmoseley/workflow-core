// @vitest-environment node
/*
 * The refill loop's `run` driven end to end through a restart: the host's
 * restart, boot-resume, the restart's kills, and the resume of a session an
 * API error held. Split from scripts/refill-loop-run.test.ts toward the 60 s
 * per-file limit (#4389); the holds' cases are
 * scripts/refill-loop-run-holds.test.ts's (#4602). Its sandbox is
 * lib/refill-loop-run-testkit.ts's.
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
 * - restart's kills (#3880): resumed by id A, a copy a kill beat S R, set
 *   off by boot-resume R; the manager's restart (#3971) A ×3; a resumed
 *   session typed A, handed off A; a job no transcript backs A.
 * - API error (#2705): types into the live session A (attach, pty_type.py);
 *   judged by state.json A; the copy tracked as the job A; pass markers
 *   moved A.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./lib/admission-verdict-fake";
import { buildJobRow, type Row } from "./lib/agents-stop-fake";
import { readCurrentBootId, readProcStartOf } from "./lib/arbiter-proc.js";
import { FAKE_COPY } from "./lib/bg-resume-fake";
import { API_PROMPT, BOOT_PROMPT, IDLE_PROMPT } from "./lib/loop-prompts.js";
import { buildMeminfo } from "./lib/meminfo-fake";
import { MODEL } from "./lib/refill-decide.js";
import {
	arbiterAs,
	at,
	buildBlockedJobRecord,
	commandFromRepo,
	dir,
	fakeResumeClaude,
	LISTED,
	launchState,
	ledgerLaunch,
	loopControlFile,
	loopEnv,
	oneTick,
	polled,
	readGhActs,
	readHeldIssues,
	readLines,
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
	writesCopyRecord,
	writesWokenRecord,
} from "./lib/refill-loop-run-testkit";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import {
	type SystemctlAnswers,
	systemctlCalls,
	writeSystemctl,
} from "./lib/systemctl-fake";

refillSandbox();

/* Swap under a quarter free and MemAvailable under the hold's line (#2690),
 * or neither. */
const MEMINFO_HOLD = buildMeminfo({
	availableMb: 1024,
	swapTotalMb: 2048,
	swapFreeMb: 256,
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
		expect(launchState().stepResume).toEqual({
			cause: "swapHeld",
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
			readState().launches.filter(
				(l: { stepResume?: { cause: string } }) =>
					l.stepResume?.cause === "swapHeld",
			);

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
				stepResume: {
					cause: "swapHeld",
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
			expect(launchState()).not.toHaveProperty("stepResume.cause", "swapHeld");
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
					stepResume: expect.objectContaining({ cause: "swapHeld", tries: 0 }),
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

describe("the launches a restart killed (#3880)", () => {
	const Min = 60 * 1000;
	const stateFile = () => at(".refill-loop-state.json");
	const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
	const readCalls = () => readLines(at("calls"));
	/* The loop runs from the sandbox's copy of scripts/, which spells the
	 * prompt's claim-issue.js absolute; no job record saved launch flags, so
	 * the resume carries the loop's model (#4098). */
	const buildResumeArgs = (job: string) =>
		`--bg --resume s-${job} --model ${MODEL} ${BOOT_PROMPT.replace("scripts/claim-issue.js", `${scripts}/claim-issue.js`)}`;
	const readKilled = () =>
		readState()
			.launches.filter(
				(l: { stepResume?: { cause: string } }) =>
					l.stepResume?.cause === "bootKilled",
			)
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
			stepResume: { cause: "bootKilled", resumeStartedAt: expect.any(Number) },
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
		expect(readState().launches[0]).not.toHaveProperty(
			"stepResume.cause",
			"bootKilled",
		);
		expect(next.stdout).toMatch(
			/as its copy c0de7a11 \(found after a kill, the harness's reason lost with it\), which a kill left out of the state: tracking it, not resuming again/,
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
			expect(state.launches[0]).not.toHaveProperty(
				"stepResume.cause",
				"bootKilled",
			);
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
			const stepResume = {
				cause: "bootKilled",
				at: Date.now() - 60 * Min,
				sessionId: "s-job7",
				cwd: repo,
				tries: 0,
			};
			writeState([{ ...buildLaunch("job7", 7, 60), stepResume }], false);
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
