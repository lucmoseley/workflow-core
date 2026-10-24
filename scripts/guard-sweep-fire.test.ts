// @vitest-environment node
/*
 * guard-sweep-fire.sh puts a hand-fired sweep on the same daily budget the
 * session-start autofire already spends (mantahostels#2202, ruled at mantahostels#2188).
 *
 * THE LOAD-BEARING PROPERTY IS THAT THE TWO ROUTES SHARE ONE COUNTER, so the
 * cases below drive the autofire side through `lib/sweep-budget.js`'s own
 * `recordFiring` — the function `check-ci-status.js` calls — rather than by
 * writing the marker's JSON by hand. A hand-written marker would keep these
 * green through exactly the drift the module exists to prevent.
 *
 * WHAT ACTUALLY PINS THE THREE is the deny text, not the exhaustion cases. Those
 * loop to `budget.AUTOFIRE_DAILY_CAP` and so adapt to a mutated cap; measured
 * with the cap cut 3 → 2 (mantahostels#3495), exactly two cases fail, and both are literals —
 * the `3 of 3 already fired` assertion below and `check-ci-status.test.ts`'s
 * `3 sweeps already fired today`. The loops are written that way deliberately,
 * to express "any mix exhausts the day" rather than "three does".
 *
 * NOTHING HERE TOUCHES GITHUB. The guard never dispatches; it only counts, and
 * the command it judges is never run.
 *
 * The guard is a `PreToolUse` Bash hook in self-plugin/hooks/hooks.json and the
 * only thing that refuses a hand fire: loosen a case here and a hand-typed `gh
 * workflow run` spends past the day's sweep budget unrefused, the CI-minute
 * spend mantahostels#2188 capped.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { requiredLibs } from "./guard-parse-fixture";
import { buildBashPayload, spawnGuard } from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-sweep-fire.sh");
const budget = createRequire(__filename)("./lib/sweep-budget.js");
/* The deny is checked against the fragment it splices, never a second copy. */
const { ruleText } = createRequire(__filename)("./lib/rule-text.js");

const FIRE = "gh workflow run scheduled-checks.yml";
/* Pinned so the day boundary is a property of the case and not of the hour the
 * suite happens to run at. */
const NOON = "2026-08-31T12:00:00Z";
const YESTERDAY = "2026-08-30T23:59:00Z";

let dir: string;
let config: string;
let shared: string;

const payload = (command: string) => buildBashPayload(command, "test");

const marker = () => path.join(shared, ".git", ".sweep-autofire");

const run = (command: string, env: Record<string, string> = {}) =>
	spawnGuard(GUARD, payload(command), {
		project: shared,
		config,
		cwd: shared,
		env: { WFC_NOW: NOON, ...env },
		timeout: 20_000,
	});

/** The refusal's prose, or null where the guard allowed. */
const denial = (
	command: string,
	env: Record<string, string> = {},
): string | null => {
	const r = run(command, env);
	expect(r.status).toBe(0);
	if (!(r.stdout ?? "").trim()) return null;
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.hookEventName).toBe("PreToolUse");
	if (out.permissionDecision !== "deny") return null;
	return out.permissionDecisionReason as string;
};

/** What the shared marker records as spent on `at`'s day. */
const spent = (at = NOON): number =>
	budget.spentToday(budget.readState(marker()).state, Date.parse(at));

/** One firing by the AUTOFIRE route, through the function check-ci-status.js calls. */
const autofire = (at = NOON) => {
	const t = Date.parse(at);
	budget.recordFiring(
		marker(),
		t,
		budget.spentToday(budget.readState(marker()).state, t),
	);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-sweep-"));
	config = path.join(dir, "config");
	shared = path.join(dir, "shared");
	fs.mkdirSync(shared, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: shared });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("what it does not judge", () => {
	it.each([
		// Another workflow entirely: its dispatches are not sweeps and cost the
		// sweep budget nothing.
		"gh workflow run roadmap-digest.yml",
		"gh workflow run document-guards.yml",
		"gh workflow run bisect.yml",
		"gh workflow run ci.yml --help",
		// Reading, not firing.
		"gh run list --workflow scheduled-checks.yml",
		"gh workflow list",
		"gh workflow view scheduled-checks.yml",
		"gh issue view 2202",
		"npm run check:ci",
		// Prints usage and dispatches nothing, so it must cost no unit.
		"gh workflow run scheduled-checks.yml --help",
		"gh workflow run scheduled-checks.yml -h",
	])("allows %s", (command) => {
		expect(denial(command)).toBeNull();
		expect(spent()).toBe(0);
	});
});

describe("what counts as firing the sweep", () => {
	it.each([
		FIRE,
		"gh workflow run .github/workflows/scheduled-checks.yml",
		"gh workflow run scheduled-checks.yml --ref main",
		"gh workflow run --ref main scheduled-checks.yml",
		"gh workflow run scheduled-checks.yml -f reason=repair",
		// The same dispatch by another spelling of the same binary: an absolute
		// path, a `command` prefix, and gh's own global flags before the
		// command word.
		"/usr/bin/gh workflow run scheduled-checks.yml",
		"command gh workflow run scheduled-checks.yml",
		"gh -R owner/repo workflow run scheduled-checks.yml",
		"gh --repo owner/repo workflow run scheduled-checks.yml",
		// The segment splitter masks a quoted span, so the raw word compares
		// equal to nothing — an ordinary spelling that spent nothing until the
		// argument was read back through gp_literal.
		'gh workflow run "scheduled-checks.yml"',
		"gh workflow run 'scheduled-checks.yml'",
		// Wrapper words. `timeout` is the one habit produces: CLAUDE.md's
		// wait-loop rule sends sessions to it.
		"timeout 60 gh workflow run scheduled-checks.yml",
		"timeout -k 5 60 gh workflow run scheduled-checks.yml",
		"nohup gh workflow run scheduled-checks.yml",
		"env GH_TOKEN=x gh workflow run scheduled-checks.yml",
		// The suite by its own file (mantahostels#3514): mantahostels#3502's gate made this the only
		// route that re-tests an already-swept sha.
		"gh workflow run ci.yml",
		"gh workflow run .github/workflows/ci.yml",
		'gh workflow run "ci.yml" --ref main',
		"timeout 60 gh workflow run ci.yml",
		// The display name, which `gh workflow run` also accepts; ci.yml's is one
		// word a session could type unprompted.
		"gh workflow run CI",
		"gh workflow run scheduled-checks",
	])("spends a unit on %s", (command) => {
		expect(denial(command)).toBeNull();
		expect(spent()).toBe(1);
	});

	/* Two guard invocations of node in one case, so it takes the spawn timeout
	 * rather than vitest's 5 s default. */
	it("spends once per segment of a compound command", () => {
		expect(denial(`${FIRE} && ${FIRE}`)).toBeNull();
		expect(spent()).toBe(2);
	}, 20_000);
});

describe("the day's budget", () => {
	/* Seven guard invocations, each spawning bash and node, so it takes the spawn
	 * timeout rather than vitest's 5 s default — which it crossed on a loaded
	 * machine and failed on the clock rather than on the budget. */
	it("allows the cap's worth and denies the one after", () => {
		for (let i = 1; i <= budget.AUTOFIRE_DAILY_CAP; i++) {
			expect(denial(FIRE)).toBeNull();
			expect(spent()).toBe(i);
		}
		expect(denial(FIRE)).toMatch(/Today's sweep budget is gone/);
	}, 60_000);

	it("spends nothing on the fire it refuses", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial(FIRE)).not.toBeNull();
		expect(spent()).toBe(budget.AUTOFIRE_DAILY_CAP);
	});

	it("resets at the UTC day boundary", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire(YESTERDAY);
		expect(denial(FIRE)).toBeNull();
		expect(spent()).toBe(1);
	});
});

/*
 * Each case spends part of the day through the
 * autofire's own writer and the rest through the guard, and asserts the day is
 * out at three however it was split. Break the link — give the guard a marker or a
 * counter of its own — and every case here fails.
 */
describe("one budget, either route", () => {
	it("counts an autofire against a later hand-fire", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial(FIRE)).toMatch(/3 of 3 already fired/);
	});

	it("counts a hand-fire against a later autofire", () => {
		expect(denial(FIRE)).toBeNull();
		expect(spent()).toBe(1);
		autofire();
		expect(spent()).toBe(2);
	});

	it.each([0, 1, 2, 3])(
		"exhausts the day at three with %i of them automatic",
		(automatic) => {
			for (let i = 0; i < automatic; i++) autofire();
			for (let i = automatic; i < budget.AUTOFIRE_DAILY_CAP; i++)
				expect(denial(FIRE)).toBeNull();
			expect(denial(FIRE)).not.toBeNull();
		},
		60_000,
	);

	it("writes the marker the autofire reads, in the shared git common dir", () => {
		expect(denial(FIRE)).toBeNull();
		expect(marker()).toBe(budget.markerPath(shared));
		expect(fs.existsSync(marker())).toBe(true);
	});

	it("holds the autofire cooldown too, so a session start seconds later fires nothing on top", () => {
		expect(denial(FIRE)).toBeNull();
		expect(budget.readState(marker()).state.last).toBe(Date.parse(NOON));
	});
});

describe("what the refusal says", () => {
	const refusal = () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		return denial(FIRE) ?? "";
	};

	it("names the day the budget resets", () => {
		expect(refusal()).toMatch(/2026-08-31 \(UTC\)/);
		expect(refusal()).toMatch(/resets at 00:00 UTC/);
	});

	it.each([
		["the web UI", /GitHub web UI/],
		["the API dispatch", /API `POST` to the workflow's `dispatches`/],
		["a fire from a script", /from inside a script/],
		["the founder's terminal", /founder's own terminal/],
	])("names %s as an unseen route", (_what, pattern) => {
		expect(refusal()).toMatch(pattern);
	});

	/* #1732: the deny once told a session to "take one deliberately", handing it
	 * the uncounted route the budget forbids. */
	it("names the unseen routes as a limit, never as a route to take", () => {
		expect(refusal()).toMatch(/never take\s+one to get past this deny/);
		expect(refusal()).not.toMatch(/take one\s+deliberately/i);
		expect(refusal()).not.toMatch(/gh api --method POST/);
	});

	it("says every route shares the counter, ci.yml named (mantahostels#3514)", () => {
		expect(refusal()).toMatch(/share one counter/);
		expect(refusal()).toMatch(/`gh workflow run ci\.yml`/);
	});

	it("denies a ci.yml fire on the same exhausted day", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial("gh workflow run ci.yml")).toMatch(/sweep budget is gone/);
		expect(spent()).toBe(budget.AUTOFIRE_DAILY_CAP);
	});

	/* The two residuals below are the clauses G3 of
	 * docs/research/always-loaded-shed-candidates.md found the old inline deny
	 * never printed. */
	it("splices the fragment in, byte for byte", () => {
		expect(refusal()).toContain(ruleText("sweep-fire-budget"));
	});

	it.each([
		[
			"where the counter lives",
			/`\.sweep-autofire` marker in the git common dir/,
		],
		["the missed-slot clause", /no\s+exemption for repairing a missed slot/],
	])("carries %s, which the inline deny never did", (_what, pattern) => {
		expect(refusal()).toMatch(pattern);
	});
});

describe("a budget it cannot count refuses nothing", () => {
	/* An unreadable marker: firing on a budget you cannot read is bad, but
	 * REFUSING on one is worse — it strands a session with no escape it can see,
	 * for a fault that is the guard's. House rule mantahostels#103 §6. */
	it("allows, and records the fail-open, when the marker will not parse", () => {
		fs.mkdirSync(marker(), { recursive: true });
		expect(denial(FIRE)).toBeNull();
		const log = fs.readFileSync(failOpenLogPath(config, shared), "utf8");
		expect(log).toMatch(/sweep-budget\.js exited 2/);
	});

	/*
	 * Node exits 1 on a load-time
	 * fault — a syntax error, a half-written file mid-save — and 1 is also the
	 * CLI's "the day is out", so an exit code alone made a broken module read as
	 * an exhausted budget and refuse with blank figures in the deny.
	 */
	it("allows when the budget module will not load, rather than denying on node's exit 1", () => {
		const detached = path.join(dir, "corrupt");
		fs.mkdirSync(path.join(detached, "lib"), { recursive: true });
		const copy = path.join(detached, "guard-sweep-fire.sh");
		fs.copyFileSync(GUARD, copy);
		fs.chmodSync(copy, 0o755);
		for (const lib of ["guard-log.sh", "guard-parse.sh", "guard-root.sh"])
			fs.copyFileSync(
				path.join(__dirname, "lib", lib),
				path.join(detached, "lib", lib),
			);
		fs.writeFileSync(
			path.join(detached, "lib", "sweep-budget.js"),
			"this is not javascript {{{\n",
		);
		const r = spawnGuard(copy, payload(FIRE), {
			project: shared,
			config,
			cwd: shared,
			env: { WFC_NOW: NOON },
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/exited 1 with no budget figures/,
		);
	});

	it("allows when lib/sweep-budget.js is not there to run", () => {
		const detached = path.join(dir, "detached");
		fs.mkdirSync(path.join(detached, "lib"), { recursive: true });
		const copy = path.join(detached, "guard-sweep-fire.sh");
		fs.copyFileSync(GUARD, copy);
		fs.chmodSync(copy, 0o755);
		for (const lib of ["guard-log.sh", "guard-parse.sh", "guard-root.sh"])
			fs.copyFileSync(
				path.join(__dirname, "lib", lib),
				path.join(detached, "lib", lib),
			);
		const r = spawnGuard(copy, payload(FIRE), {
			project: shared,
			config,
			cwd: shared,
			env: { WFC_NOW: NOON },
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/sweep-budget\.js unreadable/,
		);
	});
});

/*
 * The shared fail-open cases need a payload the guard DENIES as their control
 * that it is still armed, and this guard denies on STATE rather than on the
 * command — nothing about `gh workflow run scheduled-checks.yml` is refusable
 * until the day is out. So ctx(), which the fixture calls at test time, spends
 * the day first. It writes an absolute count rather than incrementing, so the
 * several calls one case makes leave the same state as one.
 */
const exhaustToday = () => {
	budget.recordFiring(
		marker(),
		Date.parse(NOON),
		budget.AUTOFIRE_DAILY_CAP - 1,
	);
};

/*
 * The CLI spends as a SIDE EFFECT, so an argv it does not recognise must not
 * burn a unit on the way to doing nothing — a `status` subcommand added later
 * would otherwise cost the thing it reports.
 */
describe("the budget CLI takes `spend` and nothing else", () => {
	const cli = (args: string[]) =>
		spawnSync(
			"node",
			[path.join(__dirname, "lib", "sweep-budget.js"), ...args],
			{
				encoding: "utf8",
				env: { ...process.env, WFC_REPO_DIR: shared, WFC_NOW: NOON },
			},
		);

	it.each([[[]], [["status"]], [["--json"]]])(
		"spends nothing on argv %j",
		(args) => {
			expect(cli(args as string[]).status).toBe(2);
			expect(spent()).toBe(0);
		},
	);

	it("spends on `spend`", () => {
		expect(cli(["spend"]).status).toBe(0);
		expect(spent()).toBe(1);
	});
});

describeFailOpenLog({
	guard: GUARD,
	denied: payload(FIRE),
	fieldless: { session_id: "test", tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: payload("gh workflow list"),
	extraLibs: requiredLibs("sweep-budget.js"),
	ctx: () => {
		exhaustToday();
		return { dir, config, project: shared, env: { WFC_NOW: NOON } };
	},
});
