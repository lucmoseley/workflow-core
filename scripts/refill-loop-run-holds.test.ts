// @vitest-environment node
/*
 * The refill loop's `run` driven end to end through a hold: the repo, probe
 * and cleared holds with their phone notices, and the resume of a session its
 * seat's limit held. Split from scripts/refill-loop-run-recovery.test.ts
 * toward the 60 s per-file limit (#4602); its sandbox is
 * lib/refill-loop-run-testkit.ts's.
 *
 * The testkit's `claude` stub types through lib/claude-attach-fake.ts, which
 * answers from "scripts/fixtures/claude-attach.json": a re-recording selects
 * this file.
 *
 * Over §X8 (5)'s 10 s budget: each case drives real ticks, some ten of the
 * loop's own children apiece, none a fixture or a wait to cut (#4602).
 *
 * Loosen it and a fault in the program's own wiring, of its libs, children
 * and exits, passes unseen (#2851).
 *
 * Why each case stays a full tick: refill-loop-run.test.ts's header keys the
 * codes (A, E, S, F, R).
 * - repo hold (#3857): its command run for real A. Probe hold (#3860): a
 *   broken .git A, the other checkout A, the state's probe A, its parked
 *   resumed A, a stored hold left out of a dry run's preview A (the hold
 *   store read), the panel's waiting row naming it (#4736) A. Guard entry (#4226): raises and files A, attaches and
 *   resumes A. Locked out (#4228): raises, attaches, holds and resumes A.
 * - cleared repo hold (#3863): its raiser and attached resumed off a hand
 *   lift A (repo-hold.js lift).
 * - phone notice (#3871): one on raise, one on clear A (gh workflow).
 * - limit hold (#3735): resumes under its seat A; the ledger hold A and its
 *   swap A; moved to another plan seat A; onto a key A, its first overflow
 *   start A.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMISSION_VERDICT } from "./lib/admission-verdict-fake";
import {
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
} from "./lib/agents-stop-fake";
import { buildRekeyedResponse, FAKE_COPY } from "./lib/bg-resume-fake";
import { buildBgBranch, writeClaudeStub } from "./lib/claude-stub";
import { ledgerPath, readOverflowLookup } from "./lib/dispatch-ledger.js";
import { buildFiledLine } from "./lib/filed-line.js";
import { readGhAnswer } from "./lib/gh-fake";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import { HOLD_PROMPT, LIMIT_PROMPT, MOVED_PROMPT } from "./lib/loop-prompts.js";
import { projectSlug } from "./lib/project-slug.js";
import {
	arbiterAs,
	at,
	buildBlockedJobRecord,
	dir,
	fakeResumeClaude,
	LISTED,
	launchState,
	loopEnv,
	markerPath,
	oneTick,
	polled,
	readGhActs,
	readHeadlessResumes,
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
	stub,
	updateControl,
	weekAt,
	writeKeyCostTable,
	writesWokenRecord,
} from "./lib/refill-loop-run-testkit";
import { createPanel } from "./lib/refill-panel.js";
import {
	GUARD_HOOKS_JSON,
	LOGGED_OUT,
	parseHoldId,
	probedCheckout,
} from "./lib/repo-hold-fixture";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";
import { buildUsageCache } from "./lib/usage-probe-fake";

refillSandbox();

/** `job`'s park marker, written `age` minutes ago, listing its issue. */
const writeParkMarker = (job: string, issue: number, age: number) => {
	const file = markerPath(`s-${job}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `seat ${seat}\njob ${job}\ncwd ${repo}\n${issue}\n`);
	const parkedAt = new Date(Date.now() - age * 60_000);
	fs.utimesSync(file, parkedAt, parkedAt);
};

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
		return stubGhRoutes(
			at("gh-routes"),
			{
				"issue list *": printed("[]"),
				[`issue close ${Issue} *`]: printed(""),
				"issue edit *": printed(""),
				"*": readGhAnswer(LOGGED_OUT),
			},
			{ log: at("gh-calls") },
		);
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
	const tickRun = async (
		gh = "",
		over: NodeJS.ProcessEnv = {},
		onTicked: () => Promise<void> = async () => undefined,
	) => {
		fs.rmSync(stateFile(), { force: true });
		return tickOnState(gh, over, onTicked);
	};

	/* The state file must read no lastTick, or the wait below ends at once.
	 * `onTicked` runs between the first tick and the stop tick that replaces it. */
	const tickOnState = async (
		gh = "",
		over: NodeJS.ProcessEnv = {},
		onTicked: () => Promise<void> = async () => undefined,
	) => {
		updateControl({ stopRequested: false });
		const running = run(1, { ...over, ...(gh ? { WFC_GH: gh } : {}) });
		await polled(
			() =>
				fs.existsSync(stateFile()) &&
				Boolean(JSON.parse(fs.readFileSync(stateFile(), "utf8")).lastTick),
			"no tick wrote its state",
		);
		await onTicked();
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

	/* The waiting row the loop's panel draws off `status --json`, read while the
	 * run is live. Live too to the panel: the run is in this process, which
	 * status reads as no loop's (#3861). */
	const readWaitingRow = async () => {
		// spawn-kept: two processes at once — the run beside it holds the in-process runner.
		const shown = execFileSync(
			process.execPath,
			[path.join(scripts, "refill-loop.js"), "status", "--json"],
			{ cwd: dir, env: loopEnv({}), encoding: "utf8" },
		);
		const status = { ...JSON.parse(shown), running: true, crashed: false };
		const answer = async () => ({
			code: 0,
			stdout: JSON.stringify(status),
			stderr: "",
		});
		const panel = createPanel({
			run: answer,
			runBurn: answer,
			now: Date.now,
			resolveTopic: async () => ({ why: "unused" }),
			returnFocus: answer,
			height: () => 200,
			columns: () => 200,
			onChange: () => undefined,
		});
		await panel.refreshStatus();
		return panel.buildViewRows()[3]?.text;
	};

	it("names the probe hold on the panel's waiting row, never no ticket ready (#4736)", async () => {
		breakHead();
		let waiting: string | undefined;

		await tickRun(serveClose().gh, {}, async () => {
			waiting = await readWaitingRow();
		});

		expect(waiting).toMatch(
			new RegExp(`^Probe hold: repo #${Issue}, held \\d+m$`),
		);
		expect(waiting).not.toContain("No ticket ready");
	});

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

		/* The probe runs the guard hook line the checkout registers, here one
		 * that runs the shared tree's own entry. */
		beforeEach(() => {
			fs.mkdirSync(path.dirname(hooksFile()), { recursive: true });
			fs.writeFileSync(hooksFile(), GUARD_HOOKS_JSON);
		});

		it("stops launches, raises the hold and files its issue on its first tick, off the checkout's own hook line", async () => {
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

		describe("sessions its guards lock out (#4228)", () => {
			const Refusal =
				"guard-x could not judge this call, and it fails closed: Lexer is not defined";
			const healed = () => at("guard-healed");
			/* The entry lets the benign Read through and refuses every Bash call
			 * as a core it could not run would, until healed. */
			const writeLockingEntry = () => {
				fs.mkdirSync(path.dirname(guardEntry()), { recursive: true });
				fs.writeFileSync(
					guardEntry(),
					`const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(at("guard-runs"))}, JSON.stringify({ cwd: process.cwd(), dir: process.env.CLAUDE_PROJECT_DIR, payload }) + "\\n");
if (payload.tool_name === "Bash" && !fs.existsSync(${JSON.stringify(healed())}))
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ${JSON.stringify(Refusal)} } }));
`,
				);
			};
			/* A locked-out session's transcript and job record, as the 3 Nov
			 * sessions wrote them: every call refused, then needs input:. */
			const seedLockedOut = (job: string) => {
				const transcript = at(`${job}.jsonl`);
				const call = {
					type: "assistant",
					message: {
						content: [
							{
								type: "tool_use",
								id: `t-${job}`,
								name: "Bash",
								input: { command: `node scripts/claim-issue.js ${job}` },
							},
						],
					},
				};
				const refused = {
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: `t-${job}`,
								is_error: true,
								content: `PreToolUse:Bash hook error: ${Refusal}`,
							},
						],
					},
				};
				const asked = {
					type: "assistant",
					message: {
						content: [{ type: "text", text: "needs input: guards refuse" }],
					},
				};
				fs.writeFileSync(
					transcript,
					`${[call, refused, asked].map((r) => JSON.stringify(r)).join("\n")}\n`,
				);
				const file = path.join(seat, "jobs", job, "state.json");
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(
					file,
					JSON.stringify({
						state: "blocked",
						detail: "guards refuse every call",
						tempo: "blocked",
						inFlight: { tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 },
						needs: "guards refuse every call",
						cliVersion: "2.1.309",
						sessionId: `s-${job}`,
						cwd: repo,
						linkScanPath: transcript,
					}),
				);
			};
			const isResume = (line: string) => line.startsWith("--bg");
			const launch = (job: string, issue: number) => ({
				root: repo,
				issues: [issue],
				prompt: `/implement ${issue}`,
				seat,
				jobId: job,
				sessionId: `s-${job}`,
				launchedAt: Date.now() - 10 * 60_000,
				finishedAt: null,
			});

			it("parks them on one raised probe hold, keeps it while a kept call is refused, and resumes them through admission on the lift", async () => {
				const close = serveClose();
				writeLockingEntry();
				seedLockedOut("job7");
				seedLockedOut("job8");
				fs.writeFileSync(
					stateFile(),
					JSON.stringify({ launches: [launch("job7", 7), launch("job8", 8)] }),
				);
				writeClaudeStub(at("claude"), [
					buildAgentsBranch([
						buildJobRow("job7", "blocked"),
						buildJobRow("job8", "blocked"),
					]),
					buildStopBranch(at("stops")),
				]);

				const locked = await tickOnState(close.gh);

				expect(locked.stdout).toContain(
					`repo hold raised: probe in ${repo}: repair the guard code the hook line runs, as its refusal says: guard lockout: ${Refusal}`,
				);
				expect(locked.stdout).toMatch(/session job7; 1 attached/);
				expect(locked.stdout).toMatch(/session job8; 2 attached/);
				expect(locked.stdout).toMatch(
					/stopped LOCKED_OUT park .* attached to repo hold probe \(#77\)\); labelled parked: #7/,
				);
				expect(locked.stdout).not.toContain("QUESTION park");
				expect(fs.existsSync(at("dispatches"))).toBe(false);
				expect(await readStatus()).toContain("stops launches: yes");
				const filed = readFiled();
				expect(filed).toHaveLength(1);
				expect(filed[0]?.body).toContain(`guard lockout: ${Refusal}`);

				const still = await tickOnState(close.gh);

				expect(still.stdout).toContain(
					`repo hold probe: a kept call still fails: refused a replayed Bash: ${Refusal}`,
				);
				expect(still.stdout).not.toContain("repo hold cleared");
				const replays = guardRuns().filter(
					(r) => r.payload.tool_name === "Bash",
				);
				expect(replays[0]?.payload).toMatchObject({
					session_id: "refill-loop-guard-probe",
					tool_input: { command: "node scripts/claim-issue.js job7" },
				});

				fs.writeFileSync(healed(), "");
				fakeResumeClaude("job7", [LISTED]);
				stub(
					"allowance.js",
					"process.stdout.write(JSON.stringify({ cap: { launch: 9 } }));\n",
				);
				updateControl({ stopRequested: false });
				const running = run(2, { WFC_GH: close.gh });
				await polled(
					() => readLines(at("calls")).filter(isResume).length === 2,
					"the resumes never came",
				);
				requestStop();
				const lifted = await settled(running, "run with healed guards");

				expect(lifted.stdout).toContain("repo hold cleared: probe in");
				expect(readLines(at("calls"))).toEqual(
					expect.arrayContaining([
						`--bg --resume s-job7 ${HOLD_PROMPT}`,
						`--bg --resume s-job8 ${HOLD_PROMPT}`,
					]),
				);
				expect(fs.existsSync(markerPath("s-job7"))).toBe(false);
				expect(fs.existsSync(markerPath("s-job8"))).toBe(false);
				expect(readLines(at("gh-calls"))).toEqual(
					expect.arrayContaining([
						"issue edit 7 --repo o/r --remove-label parked",
						"issue edit 8 --repo o/r --remove-label parked",
					]),
				);
			});
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
