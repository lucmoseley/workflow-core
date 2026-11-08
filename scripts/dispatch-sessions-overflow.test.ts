// @vitest-environment node
/*
 * Pins dispatch-sessions.sh on an overflow seat (#2610, spec #2570): no
 * `/usage` probe, advisor check or allowance cap; the set sized by the key's
 * budget gate, which --force does not lift; each member launched headless,
 * `claude -p` through lib/headless-sessions.js under its plan seat's dir,
 * with the key's helper in `--settings`, the `Overflow · ` name, the key's
 * headroom as its budget and no key in its environment (#3701, #4580); its
 * job id, session id, key and allowance in the ledger (#3694); and a plan
 * launch unchanged, `--bg`.
 *
 * The calls go through lib/refill-batch.js's launchBatch, so a cut or refused
 * member's reason is the one the loop's refusal parser reads. Every `claude`
 * is the testkit's stub and every key a fixture secrets-file value.
 *
 * Over the 10 s run-cost line (§X8 (5)): each case runs the real dispatcher,
 * whose gates each spawn a node process, since the subject is the script's
 * own sequence of gates; the #4392 and #4425 cases also copy the scripts into a
 * loop code worktree or a session worktree, since the subject is a launch
 * from one.
 *
 * Loosen one and a manual or loop dispatch to an overflow seat spends past
 * its grant, is refused for having no plan bars, or bills the plan.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeCostTable } from "./lib/cost-table-testkit";
import {
	readOverflowLookup,
	readRecentEntries,
	record,
} from "./lib/dispatch-ledger.js";
import {
	dispatchFixture,
	LANDING_MODULES,
	SCRIPT,
	seedLandingCheckout,
} from "./lib/dispatch-sessions-testkit";
import type { HeadlessCall } from "./lib/headless-run-fake";
import { readRun } from "./lib/headless-runs.js";
import { launchBatch } from "./lib/refill-batch.js";
import { sleepSync } from "./lib/sleep-sync.js";
import { isTestKind } from "./lib/test-kind.js";

const fx = dispatchFixture();
const { stubClaude, baseEnv, readArgvLines, readFakeCalls } = fx;

const KEY_VAR = "WFC_TEST_OVERFLOW_KEY";
const JOB = "0a0b0c0d";
const seat = () => path.join(fx.dir, ".claude2");
const secrets = () =>
	path.join(fx.dir, "config", "workflow-core", "secrets.env");

/* A $10-mean cost table sets every figure the cases assert: written where
 * the budget gate reads it, in the fixture checkout the dispatcher runs in,
 * and named to the allowance gate. */
function overflowEnv(
	grant: number,
	{ key = true }: { key?: boolean } = {},
): Record<string, string> {
	fs.mkdirSync(path.join(fx.dir, ".claude"), { recursive: true });
	fs.mkdirSync(seat(), { recursive: true });
	fs.writeFileSync(
		path.join(fx.dir, ".claude", "refill-seats"),
		`~/.claude2\n~/.claude2 api key=${KEY_VAR} grant=${grant} cycle-day=20\n`,
	);
	fs.mkdirSync(path.dirname(secrets()), { recursive: true });
	fs.writeFileSync(
		secrets(),
		key ? `${KEY_VAR}=sk-fake-overflow\n` : "OTHER=1\n",
	);
	const table = writeCostTable(fx.dir, {
		n: 1,
		meanUsd: 10,
		quantilesUsd: [1, 10, 30],
		tailRemainderUsd: 20,
	});
	return {
		CLAUDE_CONFIG_DIR: seat(),
		WFC_SEAT_KEY: KEY_VAR,
		WFC_REFILL_DIR: path.join(fx.dir, "refill"),
		WFC_SECRETS_FILE: secrets(),
		WFC_SESSION_COST_TABLE: table,
		CLAUDE_PROJECT_DIR: fx.dir,
	};
}

/* The stub prints the recorded named launch to a `--bg` call, and runs a
 * `-p` one as lib/headless-run-fake.ts's fake, which logs each run. */
function stub(opts: Parameters<typeof stubClaude>[0] = {}) {
	stubClaude({ launch: "named", jobId: JOB, ...opts });
}

const prompts = ["/implement 341", "/implement 353", "/wayfinder 1114"];

function dispatch(
	n: number,
	env: Record<string, string>,
	flags: string[] = [],
	dispatcher = SCRIPT,
) {
	const batch = prompts.slice(0, n).map((prompt) => ({
		root: fx.dir,
		issues: [],
		prompt,
		model: "opus" as const,
		seat: seat(),
		keyVar: KEY_VAR,
		reason: "overflow" as const,
	}));
	return launchBatch(batch, {
		dispatcher,
		env: baseEnv(env),
		run: (call) => {
			const r = spawnSync(
				call.file,
				[call.args[0], ...flags, ...call.args.slice(1)],
				{
					cwd: call.cwd,
					env: call.env,
					encoding: "utf8",
				},
			);
			return {
				failed: r.status === 0 ? null : `exit ${r.status}`,
				out: `${r.stdout}${r.stderr}`.trim(),
			};
		},
		entriesOf: (root) => readRecentEntries(root, 1).entries,
		sessionOf: (jobId) => storedRun(jobId)?.sessionId,
		now: Date.now,
	});
}

const refill = () => path.join(fx.dir, "refill");

/** The run the headless launcher stored for `jobId`, read under the fixture's
 * refill dir. */
function storedRun(jobId: string) {
	vi.stubEnv("WFC_REFILL_DIR", refill());
	return readRun(jobId);
}

const readStoredJobIds = () => {
	const store = path.join(refill(), ".headless-runs");
	return fs.existsSync(store) ? fs.readdirSync(store).sort() : [];
};

/* A wait on the detached child the launcher spawned, which logs its run
 * after the launcher has returned. The ceiling is a guess, generous against
 * a loaded machine. */
function readHeadlessLaunches(expected = readStoredJobIds().length) {
	for (const end = Date.now() + 10_000; Date.now() < end; ) {
		if (readFakeCalls().length >= expected) break;
		sleepSync(50);
	}
	return readFakeCalls();
}
const budgetsOf = (calls: HeadlessCall[]) =>
	calls.map((c) => c.flags["--max-budget-usd"]);
const readBgLaunches = () =>
	readArgvLines().filter((l) => l.startsWith("--bg"));
const readAnyLaunches = () => [...readBgLaunches(), ...readStoredJobIds()];

const readAllowances = () =>
	readRecentEntries(fx.dir, 1).entries.map(
		(e) => (e as { allowanceUsd?: number }).allowanceUsd,
	);
/* One of the refill loop's code worktrees under `env`'s refill dir: a copy
 * of these scripts, as a symlink would resolve out of it. */
function loopCodeTip(env: Record<string, string>) {
	const codeDir = path.join(String(env.WFC_REFILL_DIR), ".refill-loop-code");
	const tip = path.join(codeDir, "0123456789ab");
	copyScripts(tip);
	return {
		codeDir,
		tip,
		dispatcher: path.join(tip, "scripts", "dispatch-sessions.sh"),
	};
}

const helperOf = (launch: HeadlessCall | undefined) =>
	JSON.parse(String(launch?.flags["--settings"])).apiKeyHelper;

function expectHelperPrintsKey(helper: string) {
	// spawn-kept: the subject is the literal apiKeyHelper line, run by a shell as `claude` runs it.
	const h = spawnSync("sh", ["-c", helper], { encoding: "utf8" });
	expect(h.stderr).toBe("");
	expect(h.stdout).toBe("sk-fake-overflow\n");
}

const copyScripts = (root: string) =>
	fs.cpSync(__dirname, path.join(root, "scripts"), {
		recursive: true,
		filter: (src) => !isTestKind(path.relative(__dirname, src)),
	});

/* A main checkout and a session worktree linked to it, laid out as git lays
 * them: the worktree's `.git` a file naming its registration under the main
 * checkout's `.git/worktrees/`. The main checkout's scripts are these, linked
 * as it only reads them; `mainCopy` false leaves it without them. */
function sessionWorktree({ mainCopy = true }: { mainCopy?: boolean } = {}) {
	const main = path.join(fx.dir, "main");
	const worktree = path.join(main, ".claude", "worktrees", "implement-1");
	const registration = path.join(main, ".git", "worktrees", "implement-1");
	fs.mkdirSync(registration, { recursive: true });
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${registration}\n`);
	if (mainCopy) fs.symlinkSync(__dirname, path.join(main, "scripts"));
	copyScripts(worktree);
	return {
		main,
		worktree,
		dispatcher: path.join(worktree, "scripts", "dispatch-sessions.sh"),
	};
}

describe("an overflow seat (#2610)", () => {
	it("skips the probe and the cap, launching claude -p under the plan dir with the key's helper, its name, its budget, and no key in its environment (#4580)", () => {
		// Plan bars at 100% would refuse a plan seat; an overflow seat never reads them.
		stub({ session: "100", week: "100" });
		const r = dispatch(1, {
			...overflowEnv(200),
			[KEY_VAR]: "sk-in-the-caller",
			ANTHROPIC_API_KEY: "sk-in-the-shell",
		});
		expect(r.failed).toBeNull();
		expect(r.out).toContain(`Budget OK: ${seat()} fits 20; headroom $200.00.`);
		expect(r.out).not.toMatch(/Allowance OK|Advisor/);
		expect(readArgvLines().some((l) => l.includes("--debug-file"))).toBe(false);
		const [launch, ...more] = readHeadlessLaunches(1);
		expect(more).toEqual([]);
		expect(readBgLaunches()).toEqual([]);
		const helper = helperOf(launch);
		expect(launch?.flags["--name"]).toBe("Overflow · /implement 341");
		expect(launch?.flags["--max-budget-usd"]).toBe("200");
		expect(helper).toMatch(
			/\/lib\/overflow-key\.js'? '?WFC_TEST_OVERFLOW_KEY'? /,
		);
		expect(helper).toContain(secrets());
		const env = launch?.env ?? {};
		expect(env.CLAUDE_CONFIG_DIR).toBe(seat());
		expect(env).not.toHaveProperty(KEY_VAR);
		expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(env).not.toHaveProperty("CLAUDE_CODE_SESSION_ID");
		expect(r.launched.map((l) => l.jobId)).toEqual(readStoredJobIds());
	});

	it("names a helper that still prints the key once the loop removes the code worktree it launched from (#4392)", () => {
		stub();
		const env = overflowEnv(200);
		const { codeDir, tip, dispatcher } = loopCodeTip(env);
		fs.symlinkSync(path.resolve(__dirname, ".."), `${codeDir}.current`);
		const r = dispatch(1, env, [], dispatcher);
		expect(r.failed).toBeNull();
		const [launch] = readHeadlessLaunches(1);
		const helper = helperOf(launch);
		expect(helper).not.toContain(".refill-loop-code/");
		fs.rmSync(tip, { recursive: true });
		expectHelperPrintsKey(helper);
	});

	it("refuses an overflow launch from a loop code worktree whose boot link names no helper, naming the path (#4392)", () => {
		stub();
		const env = overflowEnv(200);
		const { codeDir, dispatcher } = loopCodeTip(env);
		const r = dispatch(1, env, [], dispatcher);
		expect(r.failed).toBe("exit 2");
		expect(r.out).toContain(
			`no key helper at ${codeDir}.current/scripts/lib/overflow-key.js`,
		);
		expect(r.out).toContain("the next tick launches");
		expect(readAnyLaunches()).toEqual([]);
	});

	it("names the main checkout's helper when run by hand from a session worktree, so it outlives that worktree (#4425)", () => {
		stub();
		const { main, worktree, dispatcher } = sessionWorktree();
		const r = dispatch(1, overflowEnv(200), [], dispatcher);
		expect(r.failed).toBeNull();
		const [launch] = readHeadlessLaunches(1);
		const helper = helperOf(launch);
		expect(helper).toContain(path.join(main, "scripts/lib/overflow-key.js"));
		fs.rmSync(worktree, { recursive: true });
		expectHelperPrintsKey(helper);
	});

	it("refuses a hand-run overflow launch from a session worktree whose main checkout holds no helper, naming the path (#4425)", () => {
		stub();
		const { main, dispatcher } = sessionWorktree({ mainCopy: false });
		const r = dispatch(1, overflowEnv(200), [], dispatcher);
		expect(r.failed).toBe("exit 2");
		expect(r.out).toContain(
			`no key helper at ${path.join(main, "scripts/lib/overflow-key.js")}`,
		);
		expect(r.out).toContain("whose removal would strand the helper");
		expect(r.out).toContain("let the refill loop launch overflow sessions");
		expect(readAnyLaunches()).toEqual([]);
	});

	it("starts the session in a fresh worktree detached at origin/main, as a plan launch does (#4245)", () => {
		const main = seedLandingCheckout(fx.dir);
		stub();
		const r = dispatch(1, {
			...overflowEnv(200),
			WFC_MODULES: LANDING_MODULES,
		});
		expect(r.failed).toBeNull();
		const [cwd = ""] = fx.launchCwds();
		expect(path.dirname(cwd)).toBe(
			fs.realpathSync(path.join(fx.dir, ".claude", "worktrees")),
		);
		expect(
			spawnSync("git", ["rev-parse", "HEAD"], {
				cwd,
				encoding: "utf8",
			}).stdout.trim(),
		).toBe(main);
	});

	it("sizes the set from the batch's checkout's table, whichever checkout the loop's env names (#3700)", () => {
		stub();
		const elsewhere = path.join(fx.dir, "elsewhere");
		/* $100 a session fits 2 of the $200 grant, so a gate reading this table prints "fits 2". */
		writeCostTable(elsewhere, { meanUsd: 100, quantilesUsd: [1, 100] });
		const r = dispatch(1, {
			...overflowEnv(200),
			CLAUDE_PROJECT_DIR: elsewhere,
		});
		expect(r.failed).toBeNull();
		expect(r.out).toContain(`Budget OK: ${seat()} fits 20; headroom $200.00.`);
	});

	it("cuts the set to the budget's fit in the CAPPED shape, each launch's allowance and budget the headroom left", () => {
		stub({ headless: "hold" });
		const r = dispatch(3, { ...overflowEnv(25), WFC_PROC: "/proc" });
		const capped = `CAPPED: launching 2 of 3 on the overflow budget of ${seat()} (headroom $25.00, $10.00 a session).`;
		expect(r.out).toContain(capped);
		expect(r.launched.map((l) => l.prompt)).toEqual(prompts.slice(0, 2));
		expect(r.refused).toEqual([{ launch: expect.anything(), reason: capped }]);
		// The first launch, listed running, holds $10, leaving the second $15.
		expect(readAllowances()).toEqual([25, 15]);
		expect(budgetsOf(readHeadlessLaunches(2))).toEqual(["25", "15"]);
	});

	it("refuses a set the budget fits none of, exit 3, in the REFUSED shape", () => {
		stub();
		const r = dispatch(2, overflowEnv(5));
		const refused = `REFUSED: overflow seat ${seat()} fits no session: headroom $5.00 against $10.00 a session ($0.00 held by 0 running).`;
		expect(r.failed).toBe("exit 3");
		expect(r.refused.map((x) => x.reason)).toEqual([refused, refused]);
		expect(readAnyLaunches()).toEqual([]);
	});

	it("refuses at exit 3 past --force, saying the budget gate does not lift", () => {
		stub();
		const r = dispatch(1, overflowEnv(5), ["--force"]);
		expect(r.failed).toBe("exit 3");
		expect(r.out).toContain("--force does not lift the budget gate");
		expect(readAnyLaunches()).toEqual([]);
	});

	it("cuts a set past --force all the same", () => {
		stub();
		const r = dispatch(3, overflowEnv(25), ["--force"]);
		expect(r.out).toContain("CAPPED: launching 2 of 3 on the overflow budget");
		expect(readHeadlessLaunches(2)).toHaveLength(2);
	});

	it("admits a Sonnet member burn mode moves to Opus", () => {
		stub();
		fs.writeFileSync(path.join(fx.dir, "burn-mode"), "");
		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{ encoding: "utf8", env: baseEnv(overflowEnv(200)) },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("headless-sessions.js launch");
	});

	it("refuses a key Anthropic refused for credit, naming the cycle it is exhausted until", () => {
		stub();
		const env = overflowEnv(200);
		const sessionId = "0badc0de-0000-4000-8000-000000000000";
		record({
			issues: [],
			model: "opus",
			prompt: "/implement 1",
			root: fx.dir,
			jobId: "0badc0de",
			overflow: { keyVar: KEY_VAR, allowanceUsd: 200, sessionId },
		});
		const projects = path.join(seat(), "projects", "-fixture");
		fs.mkdirSync(projects, { recursive: true });
		fs.writeFileSync(
			path.join(projects, `${sessionId}.jsonl`),
			`${JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "billing_error", message: { model: "<synthetic>", content: [{ type: "text", text: "Credit balance is too low" }] } })}\n`,
		);
		const r = dispatch(1, env);
		expect(r.failed).toBe("exit 3");
		expect(r.refused[0]?.reason).toMatch(
			new RegExp(
				`^REFUSED: overflow seat ${seat()}: its key is exhausted until \\d{4}-\\d{2}-\\d{2}`,
			),
		);
		expect(readAnyLaunches()).toEqual([]);
	});

	it("refuses a key Anthropic refused for credit, naming a newer Console reading where the key has one, not a cycle", () => {
		stub();
		const env = overflowEnv(200);
		const sessionId = "0badc0de-0000-4000-8000-000000000000";
		record({
			issues: [],
			model: "opus",
			prompt: "/implement 1",
			root: fx.dir,
			jobId: "0badc0de",
			overflow: { keyVar: KEY_VAR, allowanceUsd: 200, sessionId },
		});
		const projects = path.join(seat(), "projects", "-fixture");
		fs.mkdirSync(projects, { recursive: true });
		fs.writeFileSync(
			path.join(projects, `${sessionId}.jsonl`),
			`${JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "billing_error", message: { model: "<synthetic>", content: [{ type: "text", text: "Credit balance is too low" }] } })}\n`,
		);
		const ledgerDir = path.join(fx.dir, "refill", ".overflow-ledger");
		fs.mkdirSync(ledgerDir, { recursive: true });
		fs.writeFileSync(
			path.join(ledgerDir, `${KEY_VAR}.console.jsonl`),
			`${JSON.stringify({ at: Date.now() - 3_600_000, credits: [{ remainingUsd: 150, grantUsd: 200, grantedOn: "2026-10-28", expiresOn: "2099-12-01" }] })}\n`,
		);
		const r = dispatch(1, env);
		expect(r.failed).toBe("exit 3");
		expect(r.refused[0]?.reason).toMatch(
			new RegExp(
				`^REFUSED: overflow seat ${seat()}: its key is exhausted until a newer Console reading,`,
			),
		);
		expect(r.out).toContain("the budget resets at a newer Console reading.");
		expect(readAnyLaunches()).toEqual([]);
	});

	it("refuses a non-Opus member before the duplicate and budget gates, exit 2", () => {
		stub();
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			cwd: fx.dir,
			encoding: "utf8",
			env: baseEnv(overflowEnv(200)),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`REFUSED: ${seat()} is an overflow seat, which launches Opus alone (#1920); sonnet is not.`,
		);
		expect(readArgvLines()).toEqual([]);
	});

	it("refuses the set where the key is missing from the secrets file, naming the variable", () => {
		stub();
		const r = dispatch(1, overflowEnv(200, { key: false }));
		expect(r.failed).toBe("exit 2");
		expect(r.out).toContain(
			`REFUSED: overflow seat ${seat()}: ${KEY_VAR} is not set in ${secrets()}`,
		);
		expect(r.launched).toEqual([]);
		expect(readAnyLaunches()).toEqual([]);
	});

	it("refuses a launch the guard finds would bill elsewhere", () => {
		stub();
		const r = dispatch(1, {
			...overflowEnv(200),
			ANTHROPIC_BASE_URL: "https://elsewhere.example",
		});
		expect(r.failed).toBe("exit 2");
		expect(r.out).toContain("ANTHROPIC_BASE_URL is set");
		expect(readAnyLaunches()).toEqual([]);
	});

	it("prints the overflow launch on a dry run", () => {
		stub();
		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "opus", "/implement 341"],
			{
				encoding: "utf8",
				env: baseEnv(overflowEnv(200)),
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/^would launch: env -u WFC_REPO_ROOT -u CLAUDE_PROJECT_DIR -u WFC_DISPATCH_ROOT -u ANTHROPIC_API_KEY -u WFC_TEST_OVERFLOW_KEY -u CLAUDE_CODE_SESSION_ID node \S+\/lib\/headless-sessions\.js launch --key WFC_TEST_OVERFLOW_KEY --cwd \. --budget 200 --name \$'Overflow \\302\\267 \/implement 341' \/implement\\ 341$/m,
		);
		expect(readAnyLaunches()).toEqual([]);
	});
});

describe("an overflow line naming a dir with no plan line (#3701)", () => {
	it("refuses the dispatch, naming the line", () => {
		stub();
		const env = overflowEnv(200);
		const file = path.join(fx.dir, ".claude", "refill-seats");
		fs.writeFileSync(
			file,
			`~/.claude3\n~/.claude2 api key=${KEY_VAR} grant=200 cycle-day=20\n`,
		);
		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "opus", "/implement 341"],
			{
				encoding: "utf8",
				env: baseEnv(env),
			},
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`${file}:2: ~/.claude2 has no plan seat line`);
		expect(readArgvLines()).toEqual([]);
	});
});

describe("a plan seat on an overflow seat's dir (#3693)", () => {
	it("launches as a plan member where no key is named: no helper, no prefix", () => {
		stub();
		const r = spawnSync("bash", [SCRIPT, "opus", "/implement 341"], {
			cwd: fx.dir,
			encoding: "utf8",
			env: baseEnv({ ...overflowEnv(200), WFC_SEAT_KEY: "" }),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Allowance OK");
		expect(readBgLaunches()).toEqual(["--bg /implement 341"]);
	});
});

describe("the launch record that marks a session overflow (#3694)", () => {
	const readLookup = () => readOverflowLookup([fx.dir]);

	it("records each member's key, its own allowance and its launch-time session id, and the reader answers by job id", () => {
		stub({ headless: "hold" });
		dispatch(2, { ...overflowEnv(25), WFC_PROC: "/proc" });
		const rows = readRecentEntries(fx.dir, 1).entries;
		const [first, second] = rows.map((e) => String(e.jobId));
		const row = (jobId: string, allowanceUsd: number) => ({
			kind: "overflow",
			keyVar: KEY_VAR,
			jobId,
			sessionId: storedRun(jobId)?.sessionId,
			allowanceUsd,
		});
		expect(readStoredJobIds()).toEqual([first, second].sort());
		expect(rows).toMatchObject([row(first, 25), row(second, 15)]);
		expect((rows[0] as { sessionId?: string })?.sessionId).toMatch(
			/^[0-9a-f-]{36}$/,
		);
		expect(readLookup()({ jobId: first })).toMatchObject({ keyVar: KEY_VAR });
	});

	it("leaves a plan launch's row as it was, and reads it as no overflow session", () => {
		stub();
		const r = spawnSync("bash", [SCRIPT, "opus", "/implement 341"], {
			cwd: fx.dir,
			encoding: "utf8",
			env: baseEnv({ ...overflowEnv(200), WFC_SEAT_KEY: "" }),
		});
		expect(r.status).toBe(0);
		const [entry] = readRecentEntries(fx.dir, 1).entries;
		expect(Object.keys(entry ?? {}).sort()).toEqual(
			[
				"ts",
				"issues",
				"model",
				"prompt",
				"session",
				"jobId",
				"seatReason",
			].sort(),
		);
		expect(readLookup()({ jobId: entry?.jobId, sessionId: "any" })).toBeNull();
	});
});
