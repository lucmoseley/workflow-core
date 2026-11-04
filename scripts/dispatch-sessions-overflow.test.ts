// @vitest-environment node
/*
 * Pins dispatch-sessions.sh on an overflow seat (#2610, spec #2570): no
 * `/usage` probe, advisor check or allowance cap; the set sized by the key's
 * budget gate, which --force does not lift; each member launched as a plan
 * member is, `claude --bg` under its plan seat's dir, but with the key's
 * helper in `--settings`, the `Overflow · ` name and no key in its
 * environment (#3701); its job id, key and allowance in the ledger (#3694);
 * and a plan launch unchanged.
 *
 * The calls go through lib/refill-batch.js's launchBatch, so a cut or refused
 * member's reason is the one the loop's refusal parser reads. Every `claude`
 * is the testkit's stub and every key a fixture secrets-file value.
 *
 * Over the 10 s run-cost line (§X8 (5)): each case runs the real dispatcher,
 * whose gates each spawn a node process, since the subject is the script's
 * own sequence of gates.
 *
 * Loosen one and a manual or loop dispatch to an overflow seat spends past
 * its grant, is refused for having no plan bars, or bills the plan.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCostTable } from "./lib/cost-table-testkit";
import {
	readOverflowLookup,
	readRecentEntries,
	record,
} from "./lib/dispatch-ledger.js";
import {
	agentsListing,
	dispatchFixture,
	LANDING_MODULES,
	SCRIPT,
	seedLandingCheckout,
} from "./lib/dispatch-sessions-testkit";
import { launchBatch } from "./lib/refill-batch.js";

const fx = dispatchFixture();
const { stubClaude, baseEnv, readArgvLines } = fx;

const KEY_VAR = "WFC_TEST_OVERFLOW_KEY";
const JOB = "0a0b0c0d";
const seat = () => path.join(fx.dir, ".claude2");
const secrets = () =>
	path.join(fx.dir, "config", "workflow-core", "secrets.env");
const envLog = () => path.join(fx.dir, "env");

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

/* The stub prints `--bg`'s job line, and its listing shows that job running,
 * so a member launched earlier in the set holds its reservation. */
function stubBg(opts: Parameters<typeof stubClaude>[0] = {}) {
	const listed = JSON.parse(agentsListing()) as object[];
	stubClaude({
		launchOutput: `backgrounded·\u001b[36m${JOB}\u001b[39m`,
		agentsJson: JSON.stringify([
			...listed,
			{
				id: JOB,
				sessionId: `${JOB}-0000-4000-8000-000000000000`,
				pid: 1,
				kind: "background",
				state: "working",
			},
		]),
		envLog: envLog(),
		...opts,
	});
}

const prompts = ["/implement 341", "/implement 353", "/wayfinder 1114"];

function dispatch(
	n: number,
	env: Record<string, string>,
	flags: string[] = [],
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
		dispatcher: SCRIPT,
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
		now: Date.now,
	});
}

const readBgLaunches = () =>
	readArgvLines().filter((l) => l.startsWith("--bg"));
const readAllowances = () =>
	readRecentEntries(fx.dir, 1).entries.map(
		(e) => (e as { allowanceUsd?: number }).allowanceUsd,
	);
/** The environment of a set's one launch, as the stub dumped it. */
const readLaunchEnv = () =>
	new Map(
		fs
			.readFileSync(envLog(), "utf8")
			.split("\n")
			.filter((l) => l.includes("="))
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);

describe("an overflow seat (#2610)", () => {
	it("skips the probe and the cap, launching --bg under the plan dir with the key's helper, its name, and no key in its environment (#3701)", () => {
		// Plan bars at 100% would refuse a plan seat; an overflow seat never reads them.
		stubBg({ session: "100", week: "100" });
		const r = dispatch(1, {
			...overflowEnv(200),
			[KEY_VAR]: "sk-in-the-caller",
			ANTHROPIC_API_KEY: "sk-in-the-shell",
		});
		expect(r.failed).toBeNull();
		expect(r.out).toContain(`Budget OK: ${seat()} fits 20; headroom $200.00.`);
		expect(r.out).not.toMatch(/Allowance OK|Advisor/);
		expect(readArgvLines().some((l) => l.includes("--debug-file"))).toBe(false);
		const [launch, ...more] = readBgLaunches();
		expect(more).toEqual([]);
		const helper = JSON.parse(
			String(launch?.match(/--settings (\{.*\}) \/implement 341$/)?.[1]),
		).apiKeyHelper;
		expect(
			launch?.startsWith("--bg -n Overflow · /implement 341 --settings "),
		).toBe(true);
		expect(helper).toMatch(
			/\/lib\/overflow-key\.js'? '?WFC_TEST_OVERFLOW_KEY'? /,
		);
		expect(helper).toContain(secrets());
		const env = readLaunchEnv();
		expect(env.get("CLAUDE_CONFIG_DIR")).toBe(seat());
		expect(env.has(KEY_VAR)).toBe(false);
		expect(env.has("ANTHROPIC_API_KEY")).toBe(false);
		expect(env.has("CLAUDE_CODE_SESSION_ID")).toBe(false);
		expect(r.launched.map((l) => l.jobId)).toEqual([JOB]);
	});

	it("starts the session in a fresh worktree detached at origin/landing, as a plan launch does (#4245)", () => {
		const landing = seedLandingCheckout(fx.dir);
		stubBg();
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
		).toBe(landing);
	});

	it("sizes the set from the batch's checkout's table, whichever checkout the loop's env names (#3700)", () => {
		stubBg();
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

	it("cuts the set to the budget's fit in the CAPPED shape, each launch's allowance the headroom left", () => {
		stubBg();
		const r = dispatch(3, overflowEnv(25));
		const capped = `CAPPED: launching 2 of 3 on the overflow budget of ${seat()} (headroom $25.00, $10.00 a session).`;
		expect(r.out).toContain(capped);
		expect(r.launched.map((l) => l.prompt)).toEqual(prompts.slice(0, 2));
		expect(r.refused).toEqual([{ launch: expect.anything(), reason: capped }]);
		// The first launch, listed running, holds $10, leaving the second $15.
		expect(readAllowances()).toEqual([25, 15]);
	});

	it("refuses a set the budget fits none of, exit 3, in the REFUSED shape", () => {
		stubBg();
		const r = dispatch(2, overflowEnv(5));
		const refused = `REFUSED: overflow seat ${seat()} fits no session: headroom $5.00 against $10.00 a session ($0.00 held by 0 running).`;
		expect(r.failed).toBe("exit 3");
		expect(r.refused.map((x) => x.reason)).toEqual([refused, refused]);
		expect(readBgLaunches()).toEqual([]);
	});

	it("refuses at exit 3 past --force, saying the budget gate does not lift", () => {
		stubBg();
		const r = dispatch(1, overflowEnv(5), ["--force"]);
		expect(r.failed).toBe("exit 3");
		expect(r.out).toContain("--force does not lift the budget gate");
		expect(readBgLaunches()).toEqual([]);
	});

	it("cuts a set past --force all the same", () => {
		stubBg();
		const r = dispatch(3, overflowEnv(25), ["--force"]);
		expect(r.out).toContain("CAPPED: launching 2 of 3 on the overflow budget");
		expect(readBgLaunches()).toHaveLength(2);
	});

	it("admits a Sonnet member burn mode moves to Opus", () => {
		stubBg();
		fs.writeFileSync(path.join(fx.dir, "burn-mode"), "");
		const r = spawnSync(
			"bash",
			[SCRIPT, "--dry-run", "sonnet", "/implement 341"],
			{ encoding: "utf8", env: baseEnv(overflowEnv(200)) },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("--settings");
	});

	it("refuses a key Anthropic refused for credit, naming the cycle it is exhausted until", () => {
		stubBg();
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
		expect(readBgLaunches()).toEqual([]);
	});

	it("refuses a non-Opus member before any gate, exit 2", () => {
		stubBg();
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
		stubBg();
		const r = dispatch(1, overflowEnv(200, { key: false }));
		expect(r.failed).toBe("exit 2");
		expect(r.out).toContain(
			`REFUSED: overflow seat ${seat()}: ${KEY_VAR} is not set in ${secrets()}`,
		);
		expect(r.launched).toEqual([]);
		expect(readBgLaunches()).toEqual([]);
	});

	it("refuses a launch the guard finds would bill elsewhere", () => {
		stubBg();
		const r = dispatch(1, {
			...overflowEnv(200),
			ANTHROPIC_BASE_URL: "https://elsewhere.example",
		});
		expect(r.failed).toBe("exit 2");
		expect(r.out).toContain("ANTHROPIC_BASE_URL is set");
		expect(readBgLaunches()).toEqual([]);
	});

	it("prints the overflow launch on a dry run", () => {
		stubBg();
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
			/^would launch: env -u ANTHROPIC_API_KEY -u WFC_TEST_OVERFLOW_KEY -u CLAUDE_CODE_SESSION_ID \S*claude --bg -n \$'Overflow \\302\\267 \/implement 341' --settings \\\{\\"apiKeyHelper\\":.* \/implement\\ 341$/m,
		);
		expect(readBgLaunches()).toEqual([]);
	});
});

describe("an overflow line naming a dir with no plan line (#3701)", () => {
	it("refuses the dispatch, naming the line", () => {
		stubBg();
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
		stubBg();
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

	it("records each member's key and its own allowance, and the reader answers by job id", () => {
		stubBg();
		dispatch(2, overflowEnv(25));
		const rows = readRecentEntries(fx.dir, 1).entries;
		const row = {
			kind: "overflow",
			keyVar: KEY_VAR,
			jobId: JOB,
			sessionId: null,
		};
		expect(rows).toMatchObject([
			{ ...row, allowanceUsd: 25 },
			{ ...row, allowanceUsd: 15 },
		]);
		expect(readLookup()({ jobId: JOB })).toMatchObject({ keyVar: KEY_VAR });
	});

	it("leaves a plan launch's row as it was, and reads it as no overflow session", () => {
		stubBg();
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
