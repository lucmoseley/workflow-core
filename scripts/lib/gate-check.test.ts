// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "./sh-quote.js";

const { addedCheckVerdict, runCheckCommand } = require("./gate-check.js");

// guess, #3487
const TIMEOUT_MS = 5000;
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
		for (const check of [
			"`echo met: on main`",
			"echo unmet: nothing; false",
			'`echo "7 of 8 verdicts"`',
		])
			expect(verdictOf("", gate(check))).toEqual({
				refusals: [],
				warnings: [],
			});
	});

	it.each([
		["`echo 7`", "`7`"],
		["`echo round-log rows: 0`", "`round-log rows: 0`"],
	])(
		"refuses %s, whose reading %s carries no verdict, naming both fixes (#5756)",
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
		expect(verdictOf("", gate("true"), false).warnings[0]).toContain(
			"was not run here",
		);
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
