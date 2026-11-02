// @vitest-environment node
/*
 * Pins the write routes' verdict on a gate `check:` (#3487), over real shell
 * as check-gates.test.ts runs it. Loosen a case and a silent check is written again, to hold
 * a met gate unjudged until the sweep's repair judge reaches it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "./sh-quote.js";

const { addedCheckVerdict } = require("./gate-check.js");

/* Ample for the one-word `true`, `false`, `echo`, `cat` and `tee` these run. */
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
		expect(refusals[0]).toContain('&& echo "on main" || echo "not on main"');
	});

	it("passes a check that prints a reading, whatever its exit code", () => {
		for (const check of ["`echo on main`", "echo nothing; false"])
			expect(verdictOf("", gate(check))).toEqual({
				refusals: [],
				warnings: [],
			});
	});

	// A real kill: OVER-BUDGET comes only from run-budgeted.js's own timeout.
	it("warns a check that runs past its budget, and refuses nothing", () => {
		const { refusals, warnings } = addedCheckVerdict("", gate("sleep 5"), {
			run: true,
			timeoutMs: 200,
		});
		expect(refusals).toEqual([]);
		expect(warnings.join("\n")).toContain("OVER-BUDGET");
	});

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
		fs.writeFileSync(path.join(root, "their-file.txt"), "their reading\n");
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
				`\`echo "$WFC_REPO_ROOT" | tee ${shellQuote(printed)}\``,
			).refusals,
		).toEqual([]);
		expect(fs.readFileSync(printed, "utf8").trim()).toBe(root);
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
