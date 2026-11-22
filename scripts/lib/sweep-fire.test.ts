// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CoreRun, runCore, splitCheckout } from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

const req = createRequire(__filename);
const budget = req("./sweep-budget.js");
const { readRuleText } = req("./rule-text.js");
const { buildHostPorts } = req("./sweep-fire-host.js") as {
	buildHostPorts: (
		env: { root: string },
		load?: () => unknown,
	) => { spendSweep: (env: Record<string, string>) => Record<string, unknown> };
};

const FIRE = "gh workflow run scheduled-checks.yml";
const NOON = "2026-08-31T12:00:00Z";
const YESTERDAY = "2026-08-30T23:59:00Z";

let dir: string;
let shared: string;

const marker = () => path.join(shared, ".git", ".sweep-autofire");

const run = (command: string, env: Record<string, string> = {}): CoreRun =>
	runCore(
		"guard-sweep-fire",
		{ session_id: "test", tool_name: "Bash", tool_input: { command } },
		{ root: shared, env: { WFC_NOW: NOON, ...env } },
	);

const denial = (
	command: string,
	env: Record<string, string> = {},
): string | null => {
	const { output } = run(command, env);
	if (output === null) return null;
	expect(output.permissionDecision).toBe("deny");
	return output.permissionDecisionReason ?? "";
};

const spent = (at = NOON): number =>
	budget.spentToday(budget.readState(marker()).state, Date.parse(at));

const autofire = (at = NOON) => {
	const t = Date.parse(at);
	budget.recordFiring(
		marker(),
		t,
		budget.spentToday(budget.readState(marker()).state, t),
	);
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sweep-fire-")));
	shared = path.join(dir, "shared");
	fs.mkdirSync(shared, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: shared });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("what it does not judge", () => {
	it.each([
		"gh workflow run document-guards.yml",
		"gh workflow run landing-quiet.yml",
		"gh workflow run bisect.yml",
		"gh workflow run ci.yml --help",
		"gh run list --workflow scheduled-checks.yml",
		"gh workflow list",
		"gh workflow view scheduled-checks.yml",
		"gh issue view 2202",
		"npm run check:ci",
		"gh workflow run scheduled-checks.yml --help",
		"gh workflow run scheduled-checks.yml -h",
		"gh workflow run $WF",
		"gh workflow run $DIR/ci.yml",
		"gh workflow run other.yml scheduled-checks.yml",
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
		"/usr/bin/gh workflow run scheduled-checks.yml",
		"command gh workflow run scheduled-checks.yml",
		"gh -R owner/repo workflow run scheduled-checks.yml",
		"gh --repo owner/repo workflow run scheduled-checks.yml",
		'gh workflow run "scheduled-checks.yml"',
		"gh workflow run 'scheduled-checks.yml'",
		"timeout 60 gh workflow run scheduled-checks.yml",
		"timeout -k 5 60 gh workflow run scheduled-checks.yml",
		"nohup gh workflow run scheduled-checks.yml",
		"env GH_TOKEN=x gh workflow run scheduled-checks.yml",
		"gh workflow run ci.yml",
		"gh workflow run .github/workflows/ci.yml",
		'gh workflow run "ci.yml" --ref main',
		"timeout 60 gh workflow run ci.yml",
		"gh workflow run CI",
		"gh workflow run scheduled-checks",
	])("spends a unit on %s", (command) => {
		expect(denial(command)).toBeNull();
		expect(spent()).toBe(1);
	});

	it("spends once per segment of a compound command", () => {
		expect(denial(`${FIRE} && ${FIRE}`)).toBeNull();
		expect(spent()).toBe(2);
	});

	it.each([`flock /l -c "true\n${FIRE}"`, `flock /l -c "true; ${FIRE}"`])(
		"spends a unit on a fire a -c string runs later: %s (#4978)",
		(command) => {
			expect(denial(command)).toBeNull();
			expect(spent()).toBe(1);
		},
	);

	it.each([`flock /l -c "${FIRE}; ${FIRE}"`, `flock /l -c "${FIRE}\n${FIRE}"`])(
		"spends once per fire a -c string runs: %s (#4978)",
		(command) => {
			expect(denial(command)).toBeNull();
			expect(spent()).toBe(2);
		},
	);
});

describe("the day's budget", () => {
	it("allows the cap's worth and denies the one after", () => {
		for (let i = 1; i <= budget.AUTOFIRE_DAILY_CAP; i++) {
			expect(denial(FIRE)).toBeNull();
			expect(spent()).toBe(i);
		}
		expect(denial(FIRE)).toMatch(/Today's sweep budget is gone/);
	});

	it("spends nothing on the fire it refuses", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial(FIRE)).not.toBeNull();
		expect(spent()).toBe(budget.AUTOFIRE_DAILY_CAP);
	});

	it("refuses the second fire of a compound command the day runs out on, having spent the first", () => {
		for (let i = 1; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial(`${FIRE} && gh workflow run ci.yml`)).toMatch(
			/The command: gh workflow run ci\.yml$/,
		);
		expect(spent()).toBe(budget.AUTOFIRE_DAILY_CAP);
	});

	it("refuses a -c string's second fire the day runs out on, having spent the first (#4978)", () => {
		for (let i = 1; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial(`flock /l -c "${FIRE}; ${FIRE}"`)).toMatch(
			/Today's sweep budget is gone/,
		);
		expect(spent()).toBe(budget.AUTOFIRE_DAILY_CAP);
	});

	it("names the first refused fire of a compound command, not a later one", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial(`${FIRE} && gh workflow run ci.yml`)).toMatch(
			/The command: gh workflow run scheduled-checks\.yml\s*$/,
		);
	});

	it("resets at the UTC day boundary", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire(YESTERDAY);
		expect(denial(FIRE)).toBeNull();
		expect(spent()).toBe(1);
	});
});

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

	it("is the figures, the fragment and the command, in that order", () => {
		const rule = readRuleText("sweep-fire-budget").replace(/\n+$/, "");
		expect(refusal()).toBe(
			`Today's sweep budget is gone: 3 of 3 already fired on 2026-08-31 (UTC), so the next unit is available on the day after 2026-08-31.\n\n${rule}\n\nThe command: ${FIRE}`,
		);
	});

	it("names the command as typed, its quotes back", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		expect(denial('gh workflow run "ci.yml"')).toMatch(
			/The command: gh workflow run "…"$/,
		);
	});

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

	it("splices the fragment in, byte for byte", () => {
		expect(refusal()).toContain(readRuleText("sweep-fire-budget").trim());
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

describe("what the refusal says where its ports differ", () => {
	const { decide } = req("./sweep-fire.js") as {
		decide: (command: string, ctx: Record<string, unknown>) => unknown;
	};
	const ctx = (ruleText: () => string) =>
		kitContextFake({
			env: { WFC_NOW: NOON },
			ruleText,
			corePaths: (s: string) => `[install] ${s}`,
			spendSweep: () => ({ out: true, spent: 3, cap: 3, day: "2026-08-31" }),
			fallbackCwd: "/",
		});

	it("still refuses where the rule store cannot give the fragment, naming its file", () => {
		const out = decide(
			FIRE,
			ctx(() => {
				throw new Error("no fragment");
			}),
		) as { deny: string };
		expect(out.deny).toContain(
			"the rule could not be read from docs/agents/rules/sweep-fire-budget.txt",
		);
		expect(out.deny).toMatch(/The command: gh workflow run/);
	});

	it("spells its paths as an install reaches them", () => {
		const out = decide(
			FIRE,
			ctx(() => "the rule"),
		) as { deny: string };
		expect(out.deny.startsWith("[install] Today's sweep budget is gone")).toBe(
			true,
		);
	});
});

describe("a budget it cannot count refuses nothing", () => {
	it("allows, and records the fail-open, when the marker will not parse", () => {
		fs.mkdirSync(marker(), { recursive: true });
		const r = run(FIRE);
		expect(r.output).toBeNull();
		expect(r.logs.join("\n")).toMatch(
			/the sweep budget could not be counted \(could not read \.sweep-autofire: .*\) — a hand-fired sweep allowed uncounted/,
		);
	});

	it("allows, and records it, where git will name no common dir", () => {
		fs.rmSync(path.join(shared, ".git"), { recursive: true });
		const r = run(FIRE);
		expect(r.output).toBeNull();
		expect(r.logs.join("\n")).toMatch(/git would not name a common dir/);
	});

	it("allows, and records it, where the pinned clock is no date", () => {
		const r = run(FIRE, { WFC_NOW: "not-a-date" });
		expect(r.output).toBeNull();
		expect(r.logs.join("\n")).toMatch(/WFC_NOW is not a date: not-a-date/);
		expect(spent()).toBe(0);
	});

	it("still refuses on a day it can count", () => {
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++) autofire();
		const r = run(FIRE);
		expect(r.output?.permissionDecision).toBe("deny");
		expect(r.logs).toEqual([]);
	});

	it("allows when the budget module will not load, rather than refusing", () => {
		const port = buildHostPorts({ root: shared }, () => {
			throw new SyntaxError("Unexpected token '{'");
		});
		expect(port.spendSweep({ WFC_NOW: NOON })).toEqual({
			fault: "Unexpected token '{'",
		});
	});

	it("spends through the real module where it loads", () => {
		expect(
			buildHostPorts({ root: shared }).spendSweep({ WFC_NOW: NOON }),
		).toEqual({
			out: false,
			spent: 1,
			cap: budget.AUTOFIRE_DAILY_CAP,
			day: "2026-08-31",
		});
	});
});

describe("a hand-fire from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	beforeEach(() => {
		at = splitCheckout(path.join(dir, "split"));
	});

	it("spends the main checkout's budget, refusing the fire the main checkout's day has no unit left for", () => {
		const main = budget.markerPath(at.main);
		const t = Date.parse(NOON);
		for (let i = 0; i < budget.AUTOFIRE_DAILY_CAP; i++)
			budget.recordFiring(
				main,
				t,
				budget.spentToday(budget.readState(main).state, t),
			);
		const { output } = runCore(
			"guard-sweep-fire",
			{ session_id: "test", tool_name: "Bash", tool_input: { command: FIRE } },
			{ root: at.main, worktree: at.worktree, env: { WFC_NOW: NOON } },
		);
		expect(output?.permissionDecision).toBe("deny");
	});
});
