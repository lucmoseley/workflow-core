// @vitest-environment node
/*
 * The refill loop's `run` driven end to end (#2435): tick()'s wiring into
 * lib/refill-tick-core.js's runTick, which #2286 tests only from fixtures, and
 * run()'s exit on a returned stop or a stop's wake. Its sandbox is
 * lib/refill-loop-run-testkit.ts's. The cwd-outside-every-checkout case runs
 * the real allowance.js, as only it reads the host's cost table (#2937).
 * Restarts and holds are scripts/refill-loop-run-recovery.test.ts's, split
 * off toward the 60 s per-file limit (#4389).
 *
 * The testkit's `claude` stub types through lib/claude-attach-fake.ts, which
 * answers from "scripts/fixtures/claude-attach.json": a re-recording selects
 * this file.
 *
 * Loosen it and a fault in the program's own wiring, of its libs, children
 * and exits, passes unseen (#2851).
 *
 * Why each case stays a full tick (§X8 (5), §X11): every branch a module can
 * own runs in-process in its module's test. A case below is a production
 * adapter crossed for real (A), an exit path or input channel (E), a spawn
 * shape — a signal, or a second live process holding the pid or control lock
 * (S), a §N5 fail-open (F), or a boundary regression (R).
 * - run (#2435): ends at a mid-dispatch stop E; appends the concurrency
 *   record A; supervises a foreign checkout's launches A (supervise-landing.js);
 *   tracks a launch a kill cut off S R; tickets earlyoom's and memwatch's
 *   incidents A (two children); the review child launches detached S, a
 *   second runner exits S; ticks on a wake line E.
 * - panel (#4060): keeps a failed probe's figure A (usage-probe.js).
 * - dry run (#2611): prints the overflow dispatch E (the dry-run argv), A.
 * - overflow allowance (#3698): stops one past it A (`claude stop`).
 * - Console read (#4071): starts the read A; none where its row will not
 *   write F.
 * - goal (#3864): reads the frontier bare once cleared A (pick-next argv).
 * - parked launch (#2699, #3940): unlabels where it ended unblocked A; an
 *   unreadable transcript F; closed issues A, an unreadable closed list F;
 *   stops an away park once A; a session attached through the
 *   real hold store still parked R (#3858: attaching exempts nothing).
 * - API error (#2705): types into the live session A (attach, pty_type.py);
 *   judged by state.json A; the copy tracked as the job A; pass markers
 *   moved A.
 * - limit hold (#3735): resumes under its seat A; the ledger hold A and its
 *   swap A; moved to another plan seat A; onto a key A, its first overflow
 *   start A.
 * - daemon cwd (#2937): sizes the seat from the served checkout's cost
 *   table A R (the real allowance.js).
 * - normal-mode park (#3621): resumes in place A, on its cause's prompt A,
 *   the marker handed on A or kept F; launches afresh with no job A.
 * - `set --resume` (#3861): restarts E, refuses a damaged control E, exits
 *   1 on no launch E. `start` (#3868): --unless-stopped E.
 * - a case's end (#4140): the testkit's own teardown, owned by no module.
 * - paused (#3856): an older stop cleared, crossing the reap A (its one
 *   crossing); resumes with no restart S. Opted out (#4188): unticks A. Away
 *   (#3870): the lock held by another writer S. Waits (#3859): pauses on no
 *   progress, resumed by `set --resume` A S.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ADMISSION_VERDICT } from "./lib/admission-verdict-fake";
import {
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
	type Row,
} from "./lib/agents-stop-fake";
import { buildRekeyedResponse, FAKE_COPY } from "./lib/bg-resume-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { writeCostTable } from "./lib/cost-table-testkit";
import {
	ledgerPath,
	readOverflowLookup,
	record as recordDispatch,
} from "./lib/dispatch-ledger.js";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import {
	API_PROMPT,
	LIMIT_PROMPT,
	MOVED_PROMPT,
	parkedPromptOf,
} from "./lib/loop-prompts.js";
import { REAL_PROC } from "./lib/proc-root.js";
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
	liveRun,
	loopControlFile,
	loopEnv,
	markerPath,
	oneTick,
	POLL_MS,
	polled,
	readGhActs,
	readHeldIssues,
	readLines,
	readLoopState,
	refillSandbox,
	repo,
	requestStop,
	run,
	SETTLE_MS,
	scripts,
	seat,
	settled,
	spawnIdleHolder,
	stub,
	ticked,
	untilLoopEnded,
	updateControl,
	weekAt,
	within,
	writesWokenRecord,
} from "./lib/refill-loop-run-testkit";
import { parseHoldId } from "./lib/repo-hold-fixture";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import { OUTCOME_PREFIX } from "./lib/usage-probe.js";
import { buildUsageCache } from "./lib/usage-probe-fake";
import { readProgramLibs } from "./lib-closure-fixture";

refillSandbox();

const PARKED_PROMPT = parkedPromptOf(undefined);

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
		// And a reap pass over its worktrees folder, in it (#4247).
		await polled(
			() => readLines(at("reaped")).length > 0,
			"no reap pass started",
		);
		expect(readLines(at("reaped"))).toEqual([`${fs.realpathSync(repo)} reap`]);
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
	const nextTick = async () => {
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
		const failed = await nextTick();
		expect(fs.readFileSync(behindCache(), "utf8")).toBe(figure);
		expect(failed.stdout).toContain(`/usage on ${at("behind")}:`);
		// Probed past its reset with no free slot, the seat ahead left alone.
		expect(readLines(at("probes"))).toEqual([at("behind")]);
		const state = readLoopState();
		expect(state.seatTriedAt[at("behind")]).toEqual(expect.any(Number));
		writeSeats();
		fs.writeFileSync(behindCache(), figure);
		fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(state));
		await nextTick();
		expect(readLines(at("probes"))).toEqual([at("behind")]);
	});
});

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
	const stoppedTick = () => {
		updateControl({ stopRequested: true });
		return settled(run(0, { WFC_DISPATCH_ROOT: repo }), "run asked to stop");
	};

	it("stops one past it under its seat's dir, naming spend and allowance", async () => {
		writeTranscript(15_000_000);
		const r = await stoppedTick();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`stopped overflow session Overflow · job (${job}) on ${overflowSeat()}: spent $60.00 of its $50.00 allowance`,
		);
		expect(readLines(at("stops"))).toEqual([`stop ${job}`]);
	});
});

describe("a due Console read on the real tick (#4071)", () => {
	const consoleLogFile = () =>
		at(".overflow-ledger/WFC_TEST_KEY.console.jsonl");
	const runnerCallsFile = () => at("console-runs");
	const dueReadTick = async () => {
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
		expect((await dueReadTick()).status).toBe(0);
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
		const r = await dueReadTick();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`console read of ${overflowSeat()}: not started (`,
		);
		expect(readLines(runnerCallsFile())).toEqual([]);
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
process.stdout.write(JSON.stringify({ frontier: [], retroBundles: [], pulledIn: [], pulledInUnread: [], conflictGraph: { candidates: [], inFlight: [] } }));\n`,
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
});

const writesCopyRecord = (record: string) => {
	const jobDir = path.join(seat, "jobs", FAKE_COPY);
	return `mkdir -p ${shellQuote(jobDir)}; echo ${shellQuote(record)} > ${shellQuote(path.join(jobDir, "state.json"))};`;
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
	conflictGraph: { candidates: [], inFlight: [] },
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
		/* The pause lands in the control before its tick's state write. */
		await polled(
			() => control().paused !== undefined && state().lastTick != null,
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
