// @vitest-environment node
/*
 * Pins dispatch-sessions.sh on an overflow seat (#2610, spec #2570): no
 * `/usage` probe, advisor check or allowance cap; the set sized by the key's
 * budget gate, which --force does not lift; each member launched through
 * lib/headless-sessions.js at the key's headroom, its job id in the ledger;
 * and a plan seat still on `claude --bg`.
 *
 * The calls go through lib/refill-loop.js's launchBatch, so a cut or refused
 * member's reason is the one the loop's refusal parser reads. Every `claude`
 * is the testkit's stub and every key a fixture `.env` value.
 *
 * Over the 10 s run-cost line (§X8 (5)): each case runs the real dispatcher,
 * whose gates each spawn a node process, since the subject is the script's
 * own sequence of gates.
 *
 * Loosen one and a manual or loop dispatch to an overflow seat spends past
 * its grant, is refused for having no plan bars, or launches a `--bg` session
 * the credits do not cover.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recentEntries } from "./lib/dispatch-ledger.js";
import { dispatchFixture, SCRIPT } from "./lib/dispatch-sessions-testkit";
import { writeHeadlessRun } from "./lib/headless-runs-testkit";
import { launchBatch } from "./lib/refill-loop.js";

const fx = dispatchFixture();
const { stubClaude, baseEnv, argvLines } = fx;

const KEY_VAR = "WFC_TEST_OVERFLOW_KEY";
const seat = () => path.join(fx.dir, ".claude2-api");
const refill = () => path.join(fx.dir, "refill");

/* A $10-mean cost table sets every figure the cases assert. */
function overflowEnv(
	grant: number,
	{ key = true }: { key?: boolean } = {},
): Record<string, string> {
	fs.mkdirSync(path.join(fx.dir, ".claude"), { recursive: true });
	fs.mkdirSync(seat(), { recursive: true });
	fs.writeFileSync(
		path.join(fx.dir, ".claude", "refill-seats"),
		`~/.claude2\n~/.claude2-api api key=${KEY_VAR} grant=${grant} cycle-day=20\n`,
	);
	const checkout = path.join(fx.dir, "checkout");
	fs.mkdirSync(checkout, { recursive: true });
	fs.writeFileSync(
		path.join(checkout, ".env"),
		key ? `${KEY_VAR}=sk-fake-overflow\n` : "OTHER=1\n",
	);
	const table = path.join(fx.dir, "cost-table.json");
	fs.writeFileSync(
		table,
		JSON.stringify({ n: 1, meanUsd: 10, quantilesUsd: [1, 10, 30] }),
	);
	return {
		CLAUDE_CONFIG_DIR: seat(),
		WFC_REFILL_DIR: refill(),
		WFC_OVERFLOW_ENV_ROOT: checkout,
		WFC_SESSION_COST_TABLE: table,
	};
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
		entriesOf: (root) => recentEntries(root, 1).entries,
	});
}

const headlessLaunches = () => argvLines().filter((l) => l.startsWith("-p "));
const budgetsOf = (lines: string[]) =>
	lines.map((l) => l.match(/--max-budget-usd (\S+)/)?.[1]);
const storedJobIds = () =>
	fs.readdirSync(path.join(refill(), ".headless-runs")).sort();

describe("an overflow seat (#2610)", () => {
	it("skips the probe and the cap, launching headless with the job id recorded", () => {
		// Plan bars at 100% would refuse a plan seat; an overflow seat never reads them.
		stubClaude({ session: "100", week: "100" });
		const r = dispatch(1, overflowEnv(200));
		expect(r.failed).toBeNull();
		expect(r.out).toContain(`Budget OK: ${seat()} fits 20; headroom $200.00.`);
		expect(r.out).not.toMatch(/Allowance OK|Advisor/);
		expect(argvLines().some((l) => l.includes("--debug-file"))).toBe(false);
		expect(argvLines().some((l) => l.includes("--bg"))).toBe(false);
		expect(budgetsOf(headlessLaunches())).toEqual(["200"]);
		expect(r.launched).toHaveLength(1);
		expect([r.launched[0]?.jobId]).toEqual(storedJobIds());
	});

	it("cuts the set to the budget's fit in the CAPPED shape, each launch capped at the headroom left", () => {
		stubClaude({});
		const r = dispatch(3, overflowEnv(25));
		const capped = `CAPPED: launching 2 of 3 on the overflow budget of ${seat()} (headroom $25.00, $10.00 a session).`;
		expect(r.out).toContain(capped);
		expect(r.launched.map((l) => l.prompt)).toEqual(prompts.slice(0, 2));
		expect(r.refused).toEqual([{ launch: expect.anything(), reason: capped }]);
		// The first launch's $10 reservation leaves the second $15.
		expect(budgetsOf(headlessLaunches())).toEqual(["25", "15"]);
	});

	it("refuses a set the budget fits none of, exit 3, in the REFUSED shape", () => {
		stubClaude({});
		const r = dispatch(2, overflowEnv(5));
		const refused = `REFUSED: overflow seat ${seat()} fits no session: headroom $5.00 against $10.00 a session ($0.00 held by 0 running).`;
		expect(r.failed).toBe("exit 3");
		expect(r.refused.map((x) => x.reason)).toEqual([refused, refused]);
		expect(headlessLaunches()).toEqual([]);
	});

	it("refuses at exit 3 past --force, saying the budget gate does not lift", () => {
		stubClaude({});
		const r = dispatch(1, overflowEnv(5), ["--force"]);
		expect(r.failed).toBe("exit 3");
		expect(r.out).toContain("--force does not lift the budget gate");
		expect(headlessLaunches()).toEqual([]);
	});

	it("cuts a set past --force all the same", () => {
		stubClaude({});
		const r = dispatch(3, overflowEnv(25), ["--force"]);
		expect(r.out).toContain("CAPPED: launching 2 of 3 on the overflow budget");
		expect(headlessLaunches()).toHaveLength(2);
	});

	it("admits a Sonnet member burn mode moves to Opus", () => {
		stubClaude({});
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
		stubClaude({});
		const env = overflowEnv(200);
		const run = writeHeadlessRun(refill(), "0badc0de", "spent-session", {
			live: false,
			seat: seat(),
			launchedAt: Date.now(),
		});
		const log = path.join(run, "out.jsonl");
		fs.writeFileSync(
			log,
			`${JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low", total_cost_usd: 0 })}\n`,
		);
		const record = JSON.parse(
			fs.readFileSync(path.join(run, "run.json"), "utf8"),
		);
		fs.writeFileSync(
			path.join(run, "run.json"),
			JSON.stringify({ ...record, log, stderr: path.join(run, "stderr.log") }),
		);
		const r = dispatch(1, env);
		expect(r.failed).toBe("exit 3");
		expect(r.refused[0]?.reason).toMatch(
			new RegExp(
				`^REFUSED: overflow seat ${seat()}: its key is exhausted until \\d{4}-\\d{2}-\\d{2}`,
			),
		);
		expect(headlessLaunches()).toEqual([]);
	});

	it("refuses a non-Opus member before any gate, exit 2", () => {
		stubClaude({});
		const r = spawnSync("bash", [SCRIPT, "sonnet", "/implement 341"], {
			encoding: "utf8",
			env: baseEnv(overflowEnv(200)),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`REFUSED: ${seat()} is an overflow seat, which launches Opus alone (#1920); sonnet is not.`,
		);
		expect(argvLines()).toEqual([]);
	});

	it("records nothing where the key is missing from the checkout's .env, naming the variable", () => {
		stubClaude({});
		const r = dispatch(1, overflowEnv(200, { key: false }));
		expect(r.out).toContain(`REFUSED: ${KEY_VAR} is not set in`);
		expect(r.out).toContain(
			"(the headless launcher exited 1; not recorded as launched.)",
		);
		expect(r.launched).toEqual([]);
		expect(headlessLaunches()).toEqual([]);
	});

	it("prints the headless launch on a dry run, at the key's headroom", () => {
		stubClaude({});
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
			/would launch: node \S+\/lib\/headless-sessions\.js launch --seat \S+ --cwd \S+ --budget 200 \/implement\\ 341/,
		);
		expect(headlessLaunches()).toEqual([]);
	});
});

describe("a plan seat beside an overflow seat (#2610)", () => {
	it("still launches claude --bg after the allowance gate", () => {
		stubClaude({});
		const env = {
			...overflowEnv(200),
			CLAUDE_CONFIG_DIR: path.join(fx.dir, ".claude2"),
		};
		const r = spawnSync("bash", [SCRIPT, "opus", "/implement 341"], {
			encoding: "utf8",
			env: baseEnv(env),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Allowance OK");
		expect(argvLines().filter((l) => l.startsWith("--bg"))).toHaveLength(1);
		expect(headlessLaunches()).toEqual([]);
	});
});
