// @vitest-environment node
/*
 * Pins that check-gates.js prints each open gated issue's `check:` reading,
 * gives a dead, silent, over-budget or malformed command its own WARN state,
 * and decides nothing about the condition (mantahostels#2656, mantahostels#1332).
 *
 * Black-box over `node check-gates.js`, with a stub `gh` injected via WFC_GH:
 * no network, no auth, and no dependence on this repo's own gate markers, which
 * are what the script reports on and so cannot also be its fixture.
 *
 * The stub also LOGS every argv it is called with, so the "decides nothing"
 * case can assert the absence of a write: the only place one could happen is
 * a gh call.
 *
 * The `check:` commands here are real shell — `sleep`, `false`, `echo` — rather
 * than a mocked runner, per §X2: the states this script exists to tell apart
 * (dead, silent, over budget) are properties of a real process.
 *
 * Both gate judges, `/pick-next` and the refill loop's gate sweep, read this
 * script's output (#2279): loosen a case and a held ticket stays excluded from
 * `/pick-next` unseen, or the sweep starts writing verdicts mantahostels#1332
 * forbade.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StubGh, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-gates.js");

let dir: string;
let ghLog: string;

interface Issue {
	number: number;
	body: string;
	title?: string;
	pull_request?: object;
}

/** A body carrying a well-formed condition gate over `command`. */
const gatedOn = (
	command: string | null,
	condition = "the thing has happened",
) =>
	`Prose above.\n\n**Gated on:** ${condition}${
		command === null ? "" : ` — check: ${command}`
	} — abandon if: the ticket stops mattering\n`;

const stubGh = (issues: Issue[], { failing = false } = {}) => {
	const fixture = path.join(dir, "issues.json");
	fs.writeFileSync(
		fixture,
		JSON.stringify([
			issues.map((i) => ({
				title: `t${i.number}`,
				html_url: `http://example/${i.number}`,
				...i,
			})),
		]),
	);
	return stubGhScript(
		dir,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${ghLog}\ncat ${fixture}\n`,
		{ failing },
	);
};

const run = (args: string[] = [], stub?: StubGh) => {
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...stub?.env },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-test-"));
	ghLog = path.join(dir, "gh.log");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the reading", () => {
	it("prints what a live check command printed, and calls it neither met nor unmet", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 2332,
					body: gatedOn("echo 41 samples", "at least 20 per-sha samples"),
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("#2332  [READING]");
		expect(r.out).toContain("41 samples");
		expect(r.out).toContain("at least 20 per-sha samples");
		expect(r.out).toContain("NOTHING BELOW SAYS MET OR\nUNMET");
		/* The two judges a met gate has (#2279). */
		expect(r.out).toContain("/pick-next\n  on its GATED rows");
		expect(r.out).toContain("the /triage the refill loop launches");
	});

	it("runs a command wrapped in the backticks the tracker's examples put round it", () => {
		const r = run([], stubGh([{ number: 7, body: gatedOn("`echo 41`") }]));
		expect(r.out).toContain("[READING]");
		expect(r.out).toContain("41");
	});

	it("keeps a reading whose command exited non-zero, exit code never being a verdict", () => {
		const r = run(
			[],
			stubGh([{ number: 7, body: gatedOn("echo 3 open; exit 1") }]),
		);
		expect(r.out).toContain("[READING]");
		expect(r.out).toContain("3 open");
		expect(r.out).toContain("exit 1");
	});

	it("warns on a condition with no check: command, so a bare npm run status names it (#1246)", () => {
		const r = run([], stubGh([{ number: 1551, body: gatedOn(null) }]));
		expect(r.status).toBe(0);
		expect(r.out).toContain("[NOT-STATED]");
		expect(r.out).toContain("judge the condition by hand");
		expect(r.out).toMatch(/^WARN: 1 /m);
		expect(r.out).not.toMatch(/^OK:/m);
	});

	it("--notify carries a condition with no check: command beside the repairs", () => {
		const r = run(
			["--notify"],
			stubGh([
				{ number: 7, body: gatedOn("echo 41") },
				{ number: 8, body: gatedOn(null) },
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("#8");
		expect(r.out).not.toContain("#7");
	});
});

describe("a segment that owes a repair", () => {
	it("gives a dead command a state of its own, at WARN", () => {
		const r = run([], stubGh([{ number: 7, body: gatedOn("false") }]));
		expect(r.status).toBe(0); // WARN, deliberately not gating
		expect(r.out).toContain("WARN");
		expect(r.out).toContain("[DEAD]");
		expect(r.out).toContain("nothing on stdout");
	});

	it("reports a command that no longer exists", () => {
		const r = run(
			[],
			stubGh([{ number: 7, body: gatedOn("wfc-no-such-command-xyz") }]),
		);
		expect(r.out).toContain("#7  [DEAD]");
		// The shell's own words on the row: what to repair, not just that it broke.
		expect(r.out).toContain("not found");
	});

	it("tells a silent command apart from a dead one", () => {
		const r = run([], stubGh([{ number: 7, body: gatedOn("true") }]));
		expect(r.out).toContain("[NO-OUTPUT]");
		expect(r.out).toContain("exit 0, nothing on stdout");
	});

	it("names an over-budget check rather than waiting on it", () => {
		const r = run(
			["--timeout", "1"],
			stubGh([{ number: 2491, body: gatedOn("sleep 30") }]),
		);
		expect(r.out).toContain("[OVER-BUDGET]");
		expect(r.out).toContain("killed at 1s");
		expect(r.out).toContain("run it by hand");
	});

	/* Both limbs of what review of mantahostels#2656 found: the classifier keyed on the kill
	 * signal, so a check that traps TERM outran the budget and was then called
	 * DEAD, and a check killed from outside was called over budget. */
	it("holds the budget against a command that traps SIGTERM", () => {
		const started = Date.now();
		const r = run(
			["--timeout", "1"],
			stubGh([{ number: 2491, body: gatedOn("trap '' TERM; sleep 20") }]),
		);
		expect(r.out).toContain("[OVER-BUDGET]");
		// §X9: a kill: the budget's escalation past a TERM-trapping child is real signals on a real process, so only the clock shows it held.
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("calls a check killed from outside dead, not over budget", () => {
		const r = run([], stubGh([{ number: 7, body: gatedOn("kill -TERM $$") }]));
		expect(r.out).toContain("#7  [DEAD]");
		expect(r.out).toContain("nothing on stdout");
		expect(r.out).not.toContain("[OVER-BUDGET]");
	});

	it("refuses to guess which part of a prose-wrapped segment is the command, tagging it NOT-A-COMMAND and saying its backtick never closes", () => {
		const r = run(
			[],
			stubGh([
				{ number: 2065, body: gatedOn("`node scripts/x.js` (see its header)") },
			]),
		);
		expect(r.out).toContain("[NOT-A-COMMAND]");
		expect(r.out).toContain("never closes");
	});

	it("refuses a segment whose inner backticks would run as substitution, tagging it NOT-A-COMMAND and running nothing", () => {
		const substituted = path.join(dir, "substituted");
		const r = run(
			[],
			stubGh([
				{ number: 7, body: gatedOn(`\`echo one \`touch ${substituted}\`\``) },
			]),
		);
		expect(r.out).toContain("[NOT-A-COMMAND]");
		expect(r.out).toContain("command substitution");
		expect(fs.existsSync(substituted)).toBe(false);
	});

	it("refuses an empty pair of backticks, tagging it NOT-A-COMMAND", () => {
		const r = run([], stubGh([{ number: 7, body: gatedOn("``") }]));
		expect(r.out).toContain("[NOT-A-COMMAND]");
		expect(r.out).toContain("empty pair");
	});

	/* The budget is spent through lib/run-budgeted.js because spawnSync's own
	 * kills the shell alone: mantahostels#2491's check is meant to hit the budget on every
	 * sweep, and would otherwise orphan a ~22-minute node process each time. */
	it("kills what the command spawned, not just the shell", () => {
		const marker = path.join(dir, "outlived");
		const r = run(
			["--timeout", "1"],
			stubGh([
				{
					number: 2491,
					body: gatedOn(`sh -c 'sleep 6; touch ${marker}' & wait`),
				},
			]),
		);
		expect(r.out).toContain("[OVER-BUDGET]");
		// Past the grandchild's own 6s, so a survivor would have written by now.
		spawnSync("sleep", ["8"]);
		expect(fs.existsSync(marker)).toBe(false);
	}, 30_000);
});

describe("a marker that gates nothing", () => {
	it("reports a malformed marker with the cause, matching pick-next's fail-open", () => {
		const r = run(
			[],
			stubGh([{ number: 7, body: "**Gated on:** something, and no abort\n" }]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("[GATES-NOTHING]");
		expect(r.out).toContain("abandon if");
	});

	it("reports an issue carrying both gate markers", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 7,
					body: `**Gated until:** 2099-01-01 — a distant date\n${gatedOn("echo 41")}`,
				},
			]),
		);
		expect(r.out).toContain("[GATES-NOTHING]");
		expect(r.out).toContain("one gate line per issue");
		// The reading is not taken: the pair is a repair, and running the command
		// would print a row that reads like a live gate.
		expect(r.out).not.toContain("[READING]");
	});
});

describe("what it never does", () => {
	it("makes no gh call beyond reading the issues list", () => {
		run(
			[],
			stubGh([
				{ number: 7, body: gatedOn("echo 41") },
				{ number: 8, body: gatedOn("false") },
			]),
		);
		const calls = fs.readFileSync(ghLog, "utf8").trim().split("\n");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("repos/{owner}/{repo}/issues");
		for (const forbidden of ["issue edit", "issue close", "issue comment"])
			expect(calls[0]).not.toContain(forbidden);
	});

	it("ignores pull requests, which share the number space", () => {
		const r = run(
			[],
			stubGh([{ number: 99, body: gatedOn("echo 41"), pull_request: {} }]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("no open issue carries");
	});

	it("stays silent on an issue carrying no gate at all", () => {
		const r = run([], stubGh([{ number: 7, body: "No marker here." }]));
		expect(r.status).toBe(0);
		expect(r.out).toContain("no open issue carries");
	});
});

describe("modes", () => {
	it("--json carries the whole reading, not the truncated row", () => {
		const long = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\\n");
		const r = run(
			["--json"],
			stubGh([{ number: 7, body: gatedOn(`printf '${long}\\n'`) }]),
		);
		const env = JSON.parse(r.out);
		expect(env).toMatchObject({
			conditioned: 1,
			repairs: 0,
			unstated: 0,
			timeoutSeconds: 60,
		});
		expect(env.rows[0].reading.split("\n")).toHaveLength(9);
	});

	it("--notify prints the repairs alone, never the whole table", () => {
		const r = run(
			["--notify"],
			stubGh([
				{ number: 7, body: gatedOn("echo 41") },
				{ number: 8, body: gatedOn("false") },
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("#8");
		expect(r.out).not.toContain("#7");
	});

	it("--notify says nothing at all when every segment runs", () => {
		const r = run(
			["--notify"],
			stubGh([{ number: 7, body: gatedOn("echo 41") }]),
		);
		expect(r.out.trim()).toBe("");
	});

	/** A stub answering `issues/<n>` with `answer`, an issue or an HTTP error. */
	const stubOne = (answer: (Issue & { state: string }) | string) => {
		const fixture = path.join(dir, "issue.json");
		const isError = typeof answer === "string";
		fs.writeFileSync(
			fixture,
			isError
				? answer
				: JSON.stringify({
						title: "t",
						html_url: "http://example/",
						...answer,
					}),
		);
		return stubGhScript(
			dir,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${ghLog}\n${
				isError ? `cat ${fixture} >&2\nexit 1` : `cat ${fixture}`
			}\n`,
		);
	};

	it("--issue reads that one issue directly, never the open list (#2565)", () => {
		const r = run(
			["--issue", "8"],
			stubOne({ number: 8, state: "open", body: gatedOn("echo eight") }),
		);
		expect(r.out).toContain("eight");
		expect(fs.readFileSync(ghLog, "utf8").trim()).toBe(
			"api repos/{owner}/{repo}/issues/8",
		);
	});

	it("--issue on a closed issue prints the not-gated line", () => {
		const r = run(
			["--issue", "8"],
			stubOne({ number: 8, state: "closed", body: gatedOn("echo eight") }),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("#8 is not an open issue");
		expect(r.out).not.toContain("eight");
	});

	it("--issue on a number GitHub has no issue for prints the not-gated line", () => {
		const r = run(["--issue", "8"], stubOne("gh: Not Found (HTTP 404)"));
		expect(r.status).toBe(0);
		expect(r.out).toContain("#8 is not an open issue");
	});

	it("--issue whose read fails otherwise is BROKEN, never the not-gated line", () => {
		const r = run(["--issue", "8"], stubOne("gh: HTTP 502 Bad Gateway"));
		expect(r.status).toBe(2);
		expect(r.out).toContain("HTTP 502");
		expect(r.out).not.toContain("not an open issue");
	});

	it.each(["0", "-5", "abc"])(
		"a --timeout of %j is BROKEN, nothing having been checked, asking for a positive number of seconds",
		(bad) => {
			const r = run(["--timeout", bad], stubGh([]));
			expect(r.status).toBe(2);
			expect(r.out).toContain("positive number of seconds");
		},
	);

	it("--issue that is not a number is BROKEN", () => {
		const r = run(["--issue", "abc"], stubGh([]));
		expect(r.status).toBe(2);
		expect(r.out).toContain("takes an issue number");
	});

	it("truncates a long reading in the table, and says how much it cut", () => {
		const long = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\\n");
		const r = run(
			[],
			stubGh([{ number: 7, body: gatedOn(`printf '${long}\\n'`) }]),
		);
		expect(r.out).toContain("line 2");
		expect(r.out).not.toContain("line 3");
		expect(r.out).toContain("+6 more line(s)");
	});

	it("SKIPs rather than passing when gh is unavailable", () => {
		const r = run([], stubGh([], { failing: true }));
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("OK:");
	});
});
