// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "./sh-quote.js";

const { addedCheckVerdict, runCheckCommand } = require("./gate-check.js");

// guess, #3487
const TIMEOUT_MS = 5000;
const DAY_MS = 864e5;
const NOW = Date.parse("2026-11-28T00:00:00Z");
const COMMAND = 'echo "1 of 15 commits"';
const gate = (check: string) =>
	`**Gated on:** it lands — check: ${check} — abandon if: it is dropped\n`;
const verdictOf = (before: string, after: string, run = true) =>
	addedCheckVerdict(before, after, { run, timeoutMs: TIMEOUT_MS });

describe("a check the write adds", () => {
	it.each([
		["true", "NO-OUTPUT"],
		["false", "DEAD"],
		["`echo `x``", "NOT-A-COMMAND"],
	])("refuses `%s` as %s, naming the printing fix", (check, state) => {
		const { refusals } = verdictOf("", gate(check));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain(`reads as ${state}`);
		expect(refusals[0]).toContain(
			'&& echo "met: on main" || echo "unmet: not on main"',
		);
	});

	it("passes a check that prints a verdict, whatever its exit code", () => {
		for (const check of ["`echo met: on main`", "echo unmet: nothing; false"])
			expect(verdictOf("", gate(check))).toEqual({
				refusals: [],
				warnings: [],
			});
		expect(verdictOf("", gate('`echo "8 of 8 verdicts"`'))).toEqual({
			refusals: [],
			warnings: [],
		});
	});

	it.each([
		["`echo 7`", "`7`"],
		["`echo round-log rows: 0`", "`round-log rows: 0`"],
	])(
		"refuses %s, whose reading %s carries no verdict, naming both fixes, where a check printing a verdict passes (#5756)",
		(check, shown) => {
			const { refusals } = verdictOf("", gate(check));
			expect(refusals).toHaveLength(1);
			expect(refusals[0]).toContain(
				`prints ${shown}, which carries no verdict`,
			);
			expect(refusals[0]).toContain('echo "met: on main"');
			expect(refusals[0]).toContain("of 25 rows");
		},
	);

	it("warns a check that runs past its budget, and refuses nothing", () => {
		const { refusals, warnings } = addedCheckVerdict("", gate("sleep 5"), {
			run: true,
			timeoutMs: 200,
		});
		expect(refusals).toEqual([]);
		expect(warnings.join("\n")).toContain("OVER-BUDGET");
	});

	it.each([124, 137])(
		"reads exit %i inside the budget as the command's own, not as the budget's kill (#5568)",
		(status) => {
			expect(
				runCheckCommand(`exit ${status}`, TIMEOUT_MS, os.tmpdir()).state,
			).toBe("DEAD");
		},
	);

	it("judges only the parse where the route cannot run it", () => {
		expect(verdictOf("", gate("true"), false).refusals).toEqual([]);
		const [warning] = verdictOf("", gate("true"), false).warnings;
		expect(warning).toContain("was not run here");
		expect(warning).toContain("of 25 rows");
		expect(verdictOf("", gate("`echo `x``"), false).refusals).toHaveLength(1);
	});
});

describe("a check on another repo's issue", () => {
	const readsTheirTree = "`cat their-file.txt`";
	const theirs = "owner/theirs";
	let home: string;

	const homeHolding = (tracker: string) => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "gate-check-home-"));
		const root = path.join(home, "theirs");
		fs.mkdirSync(path.join(root, ".git"), { recursive: true });
		fs.mkdirSync(path.join(root, ".claude"));
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker }),
		);
		fs.writeFileSync(
			path.join(root, "their-file.txt"),
			"unmet: their reading\n",
		);
		vi.stubEnv("HOME", home);
		return root;
	};
	const verdictOn = (repo: string, check: string) =>
		addedCheckVerdict("", gate(check), {
			run: true,
			repo,
			timeoutMs: TIMEOUT_MS,
		});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("runs in that repo's checkout, so a check its tree answers passes", () => {
		homeHolding(theirs);
		expect(verdictOn(theirs, readsTheirTree)).toEqual({
			refusals: [],
			warnings: [],
		});
	});

	it("hands the check that checkout's environment, not this session's", () => {
		const root = homeHolding(theirs);
		vi.stubEnv("WFC_REPO_ROOT", os.tmpdir());
		const printed = path.join(root, "seen");
		expect(
			verdictOn(
				theirs,
				`\`echo "unmet: $WFC_REPO_ROOT" | tee ${shellQuote(printed)}\``,
			).refusals,
		).toEqual([]);
		expect(fs.readFileSync(printed, "utf8").trim()).toBe(`unmet: ${root}`);
	});

	it("refuses, naming the missing checkout, and never runs it in this tree", () => {
		homeHolding("owner/someone-else");
		const canary = path.join(home, "ran");
		const { refusals } = verdictOn(
			"owner/nobody",
			`\`echo ran > ${shellQuote(canary)}; echo reading\``,
		);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain(
			`no checkout under ${home} tracks owner/nobody`,
		);
		expect(fs.existsSync(canary)).toBe(false);
	});

	it("still judges the parse with no checkout, and adds no refusal for a line with no check", () => {
		homeHolding("owner/someone-else");
		expect(verdictOn("owner/nobody", "`echo `x``").refusals[0]).toContain(
			"reads as NOT-A-COMMAND",
		);
		expect(
			addedCheckVerdict(
				"",
				"**Gated on:** it lands — abandon if: it is dropped\n",
				{ run: true, repo: "owner/nobody" },
			),
		).toEqual({ refusals: [], warnings: [] });
	});
});

describe("a check reading an unfetched origin ref (#5697)", () => {
	const pinRead =
		"git -C ~/x show origin/main:.claude/settings.json | grep v3.2.0";

	it.each([true, false])(
		"refuses it, naming the live reads, whether or not the route runs it (run: %s)",
		(run) => {
			const { refusals } = verdictOf("", gate(`\`${pinRead}\``), run);
			expect(refusals).toHaveLength(1);
			expect(refusals[0]).toContain("reads an `origin/` ref in ~/x");
			expect(refusals[0]).toContain(
				"release-contains.js <sha> --pinned-by <owner/repo>",
			);
			expect(refusals[0]).toContain("gh api");
		},
	);

	it("names only the gh api read in an adopter, which ships no release-contains.js, where the case above names both (#5757)", () => {
		const adopter = fs.mkdtempSync(path.join(os.tmpdir(), "gate-adopter-"));
		try {
			execFileSync("git", ["init", "-q", adopter]);
			vi.stubEnv("GIT_DIR", path.join(adopter, ".git"));
			const { refusals } = verdictOf("", gate(`\`${pinRead}\``), false);
			expect(refusals).toHaveLength(1);
			expect(refusals[0]).toContain("gh api");
			expect(refusals[0]).not.toContain("release-contains");
		} finally {
			fs.rmSync(adopter, { recursive: true, force: true });
		}
	});

	it("passes one that fetches that checkout first, and a read of the host's own origin", () => {
		for (const check of [
			`git -C ~/x fetch -q origin && ${pinRead}`,
			`git -C "$HOME/x" fetch -q && ${pinRead}`,
			"git merge-base --is-ancestor HEAD origin/main && echo on || echo off",
		])
			expect(verdictOf("", gate(check), false).refusals).toEqual([]);
	});

	it("refuses one whose fetch comes after the read, or fetches another checkout", () => {
		for (const check of [
			`${pinRead}; git -C ~/x fetch`,
			`git -C ~/y fetch && ${pinRead}`,
		])
			expect(verdictOf("", gate(check), false).refusals).toHaveLength(1);
	});

	const cdRead = "cd ~/x && git show origin/main:.claude/settings.json";
	const gitDirRead =
		"git --git-dir ~/x/.git show origin/main:.claude/settings.json";

	it.each([
		cdRead,
		gitDirRead,
		"git --git-dir=~/x/.git show origin/main:a",
		"git --work-tree ~/x show origin/main:a",
		"(cd ~/x; git log -1 origin/main)",
		"cd -- ~/x && git show origin/main:a",
		"if cd ~/x; then git show origin/main:a; fi",
		"GIT_DIR=~/x/.git git show origin/main:a",
		"git --namespace foo -C ~/x show origin/main:a",
		"git -c k=v -C ~/x show origin/main:a",
		"/usr/bin/git -C ~/x show origin/main:a",
		"echo `git -C ~/x show origin/main:a`",
		'[ "$(git -C ~/x rev-parse origin/main)" = abc ] && echo met',
		"git -C ~/y fetch & git -C ~/x show origin/main:a",
		"git -C ~/x log --format='%h;%s' origin/main",
		'echo "a\\"b"; git -C ~/x show origin/main:a',
		"git -C ~ fetch && git -C ~/x show origin/main:a",
		"bash -c 'git -C ~/x show origin/main:a'",
		'eval "git -C ~/x show origin/main:a"',
		"sudo -u git git -C ~/x show origin/main:a",
	])(
		"refuses one reading another checkout's origin through %s (#5755)",
		(check) => {
			const { refusals } = verdictOf("", gate(check), false);
			expect(refusals).toHaveLength(1);
			expect(refusals[0]).toContain("reads an `origin/` ref in ~/x");
			expect(refusals[0]).toContain("gh api");
		},
	);

	it("passes each spelling with a fetch of that checkout before it (#5755)", () => {
		for (const check of [
			"cd ~/x && git fetch -q && git show origin/main:a",
			"git -C ~/x fetch && cd ~/x && git show origin/main:a",
			"git --git-dir ~/x/.git fetch && git --git-dir ~/x/.git show origin/main:a",
			`git -C ~/x fetch && ${gitDirRead}`,
			"cd ~/x && git -C . fetch && git show origin/main:a",
			"git -C ~/x remote update && cd ~/x && cd scripts && git show origin/main:a",
			'git -C "$REPO" fetch && git -C "$REPO" show origin/main:a',
			"cd ~/x && git pull -q && git show origin/main:a 2>&1",
		])
			expect(verdictOf("", gate(check), false).refusals).toEqual([]);
	});

	it("passes a read of the host's own origin (#5755)", () => {
		for (const check of [
			"cd scripts && git log -1 origin/main",
			'cd "$(git rev-parse --show-toplevel)" && git show origin/main:a',
			"(cd ~/x && make) && git merge-base --is-ancestor X origin/main && echo met",
			"cd ~/x && ls; cd - && git show origin/main:a",
			"git --git-dir .git show origin/main:a",
			"git -C . show origin/main:a",
			"cd ~/x | true; git show origin/main:a",
			"cd .. && git show origin/main:a",
		])
			expect(verdictOf("", gate(check), false).refusals).toEqual([]);
	});

	it("refuses a git -C or --git-dir it cannot place, naming what it read (#5755)", () => {
		for (const [check, dir] of [
			['git -C "$REPO" show origin/main:a', "$REPO"],
			["for d in ~/x; do git -C $d show origin/main:a; done", "$d"],
			["git --git-dir $(echo ~/x)/.git show origin/main:a", "$(…)"],
		]) {
			const { refusals } = verdictOf("", gate(check), false);
			expect(refusals).toHaveLength(1);
			expect(refusals[0]).toContain(`reads an \`origin/\` ref in ${dir}`);
		}
	});

	it("refuses a cd read whose fetch was of another checkout (#5755)", () => {
		expect(
			verdictOf("", gate(`git -C ~/y fetch && ${cdRead}`), false).refusals,
		).toHaveLength(1);
	});
});

describe("a check the write does not add", () => {
	it("leaves an unchanged gate line and a gate with no check alone", () => {
		const held = gate("true");
		expect(verdictOf(held, `${held}more prose\n`)).toEqual({
			refusals: [],
			warnings: [],
		});
		expect(
			verdictOf("", "**Gated on:** it lands — abandon if: it is dropped\n"),
		).toEqual({ refusals: [], warnings: [] });
	});
});

describe("a count gate projected from its reading history (#5861)", () => {
	const { recordReading, readHistory } = require("./gate-projection.js");
	const { readHostTracker } = require("./refill-repos.js");
	const { hostRoot } = require("./host-root.js");
	const repo = readHostTracker(hostRoot()) ?? "";
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-projection-"));
		vi.stubEnv("WFC_GATE_HISTORY", path.join(dir, "h.jsonl"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const seed = (days: number, reading: string, issue: number | null = 1) =>
		expect(
			recordReading({
				repo,
				issue,
				command: COMMAND,
				reading,
				at: NOW - days * DAY_MS,
			}),
		).toBeNull();
	const body = (basis: string) =>
		`**Gated on:** 15 commits — check: \`${COMMAND}\` — abandon if: it is dropped\n**Gate basis:** ${basis}\n`;
	const judge = (basis: string, run = true, issue: number | undefined = 1) =>
		addedCheckVerdict("", body(basis), {
			run,
			issue,
			now: NOW,
			timeoutMs: TIMEOUT_MS,
		});

	it("refuses a 7-day history the rate cannot carry to the floor, naming the date and the reachable floor", () => {
		seed(8, "0 of 15 commits");
		const { refusals } = judge("15 commits, #5687");
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("1 of 15 commits");
		expect(refusals[0]).toContain("14 remaining are met on 2027-03-20");
		expect(refusals[0]).toContain("#5687 Q1");
		expect(refusals[0]).toContain("it reaches 1 within 7 days");
		expect(refusals[0]).toContain("§Gating an issue");
	});

	it("passes the same history where the basis cites a founder question round", () => {
		seed(8, "0 of 15 commits");
		expect(judge("15 commits, set by #4925 Q2").refusals).toEqual([]);
	});

	it("refuses a basis citing the round its own refusal names as the bound", () => {
		seed(8, "0 of 15 commits");
		const printed = judge("15 commits, #5687", false).refusals[0]?.match(
			/#\d+ Q\d+/,
		)?.[0];
		expect(printed).toBeDefined();
		expect(judge(`15 commits, past ${printed}`, false).refusals).toHaveLength(
			1,
		);
	});

	it("refuses the bound's cite as an adopter's copy prints it, there too", () => {
		const { qualifyProse } = require("./qualify-citations.js");
		const { judgeBound } = require("./gate-projection.js");
		seed(8, "0 of 15 commits");
		const shipped = qualifyProse(judge("15 commits, #5687", false).refusals[0]);
		const cite = shipped.match(/[\w-]+#\d+ Q\d+/)?.[0];
		expect(cite).toBe("workflow-core#5687 Q1");
		const rows = readHistory({ repo, issue: 1, command: COMMAND });
		const adopter = { basis: `past ${cite}`, repo: "o/adopter", now: NOW };
		expect(judgeBound(rows, [{ a: 1, b: 15 }], adopter).verdict).toBe(
			"unreachable",
		);
	});

	it("refuses a stated expected time past the bound under 7 days of history", () => {
		const { refusals } = judge(
			"baseline 1/1; pass = 15 commits in n = 15 commits (about 33 days at 0.5 commits a day); fail never",
		);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("expects 33 days");
	});

	it("warns where there is no history and no stated time", () => {
		const { refusals, warnings } = judge("15 commits, #5687");
		expect(refusals).toEqual([]);
		expect(warnings.join(" ")).toContain(
			"the daily stale-ticket run projects it once it has a day of readings",
		);
	});

	it("passes a met count", () => {
		const met = 'echo "15 of 15 commits"';
		seed(8, "0 of 15 commits");
		expect(
			addedCheckVerdict(
				"",
				`**Gated on:** 15 commits — check: \`${met}\` — abandon if: it is dropped\n**Gate basis:** 15 commits, #5687\n`,
				{ run: true, issue: 1, now: NOW, timeoutMs: TIMEOUT_MS },
			).refusals,
		).toEqual([]);
	});

	it("refuses from the command's history alone on the run: false path, adding no row", () => {
		seed(9, "0 of 15 commits", null);
		seed(1, "1 of 15 commits", 4);
		const { refusals } = judge("15 commits, #5687", false, undefined);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("1 of 15");
		expect(readHistory({ repo, command: COMMAND })).toHaveLength(2);
	});

	it("judges an issue with no rows of its own on its command's history, before adding its own reading", () => {
		seed(9, "0 of 15 commits", 5);
		const { refusals } = judge("15 commits, #5687", true, 2);
		expect(refusals).toHaveLength(1);
		expect(readHistory({ repo, issue: 2 })).toHaveLength(1);
	});

	it("warns, never throws, where the history cannot be read", () => {
		fs.mkdirSync(path.join(dir, "h.jsonl"));
		const { refusals, warnings } = judge("15 commits, #5687");
		expect(refusals).toEqual([]);
		expect(warnings.join(" ")).toContain("The gate history could not be read");
	});

	it("warns where its own reading cannot be added to the history, still judging the gate", () => {
		seed(8, "0 of 15 commits");
		fs.chmodSync(path.join(dir, "h.jsonl"), 0o444);
		const { refusals, warnings } = judge("15 commits, #5687");
		expect(refusals).toHaveLength(1);
		expect(warnings.join(" ")).toContain(
			"was not added to the gate history (EACCES",
		);
	});

	it("adds its own run's reading to the issue's history", () => {
		judge("15 commits, #5687");
		expect(readHistory({ repo, issue: 1 })).toHaveLength(1);
	});
});
