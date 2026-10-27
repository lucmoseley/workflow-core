// @vitest-environment node
/*
 * park-blocked.test.ts — parking a blocked ticket (#1200, #1222), end to end.
 * Driven by argv with a stubbed `gh` and the real `session-arbiter.js`
 * against a throwaway store — `scripts/lib/arbiter-testkit.ts`'s
 * `freshSandbox()` — so a claim released here exercises the real claim store.
 * A gap here lets a parked ticket keep the wrong `takes:` label, or its claim,
 * with no hook to catch it: a `PreToolUse` guard never sees the `gh` calls
 * this script makes. This test, red in CI, is the only thing that would.
 *
 * `gh` is stubbed at WFC_GH.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSandbox, gitRepo } from "./lib/arbiter-testkit";
import { asRecorded } from "./lib/gh-fake";

const { markersDir } = createRequire(__filename)("./lib/marker-root.js");

const SCRIPT = path.resolve(__dirname, "park-blocked.sh");
const ARBITER = path.resolve(__dirname, "session-arbiter.js");
const SID = "blocked-session";

const sb = freshSandbox();

function arbiterEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		CLAUDE_CONFIG_DIR: sb.home,
		CLAUDE_PROJECT_DIR: sb.repo,
		CLAUDE_CODE_SESSION_ID: SID,
		...extra,
	};
}

/** Claim the issue for SID through the real arbiter, so a release is seen. */
function claimIssue(issue: number) {
	execFileSync("node", [ARBITER, "claim-issue", String(issue)], {
		cwd: sb.repo,
		env: arbiterEnv(),
	});
}

function heldIssue(issue: number): boolean {
	const out = execFileSync("node", [ARBITER, "issue-claims"], {
		cwd: sb.repo,
		env: arbiterEnv(),
	}).toString();
	return new RegExp(`^#${issue}\\s+${SID}\\s`, "m").test(out);
}

let ghCallsFile: string;
let ghBin: string;

/** A `gh` stub dispatching on `issue view --json labels|body`, `issue
 * comment`, `issue edit`, and `api` reads of the blocked-by edges, of the
 * open list (#9 and every `states` entry that is open) and of an issue's
 * state. An issue missing from `states` answers empty at exit 0. */
function stubGh(
	opts: {
		labels?: string[];
		body?: string;
		labelsExit?: number;
		edges?: { state: string }[];
		apiExit?: number;
		failPath?: string;
		states?: Record<number, string>;
	} = {},
) {
	const {
		labels = [],
		body = "",
		labelsExit = 0,
		edges = [],
		apiExit = 0,
		failPath = "",
		states = {},
	} = opts;
	fs.writeFileSync(path.join(sb.dir, "body.md"), body);
	const script = [
		"#!/bin/bash",
		`printf '%s\\n' "$*" >> "${ghCallsFile}"`,
		'if [ "$1" = "api" ]; then',
		`  if [ ${apiExit} -ne 0 ]; then exit ${apiExit}; fi`,
		`  if [ -n "${failPath}" ] && [ "\${2%${failPath}}" != "$2" ]; then exit 1; fi`,
		'  case "$2" in',
		`    */dependencies/blocked_by) printf '%s' '${JSON.stringify([edges])}' ;;`,
		`    */issues) printf '%s' '${asRecorded("issuesPage", [
			[
				9,
				...Object.keys(states).filter((n) => states[Number(n)] === "open"),
			].map((n) => ({ number: Number(n) })),
		])}' ;;`,
		...Object.entries(states).map(
			([n, state]) =>
				`    */issues/${n}) printf '%s' '${JSON.stringify([[{ state }]])}' ;;`,
		),
		"  esac",
		"  exit 0",
		"fi",
		'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then',
		`  printf '%s' '{"nameWithOwner":"acme/app"}'`,
		"  exit 0",
		"fi",
		'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
		'  if printf "%s" "$*" | grep -q -- "--json labels"; then',
		`    if [ ${labelsExit} -ne 0 ]; then exit ${labelsExit}; fi`,
		...labels.map((l) => `    printf '%s\\n' '${l}'`),
		"    exit 0",
		"  fi",
		'  if printf "%s" "$*" | grep -q -- "--json body"; then',
		`    cat "${path.join(sb.dir, "body.md")}"`,
		"    exit 0",
		"  fi",
		"fi",
		"exit 0",
	].join("\n");
	fs.writeFileSync(ghBin, script);
	fs.chmodSync(ghBin, 0o755);
}

function ghCalls(): string[] {
	try {
		return fs.readFileSync(ghCallsFile, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function run(
	args: string[],
	extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; code: number } {
	const r = spawnSync("bash", [SCRIPT, ...args], {
		cwd: sb.repo,
		encoding: "utf8",
		env: { ...arbiterEnv(), WFC_GH: ghBin, ...extraEnv },
	});
	return {
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		code: r.status ?? -1,
	};
}

beforeEach(() => {
	gitRepo(sb);
	ghCallsFile = path.join(sb.dir, "gh-calls");
	ghBin = path.join(sb.dir, "gh-stub");
	stubGh();
});

describe("invocation", () => {
	it("is executable", () => {
		expect(fs.statSync(SCRIPT).mode & 0o111).toBeTruthy();
	});
});

describe("usage", () => {
	it("refuses with no arguments", () => {
		const r = run([]);
		expect(r.code).toBe(2);
	});

	it("refuses a non-numeric issue", () => {
		const r = run(["abc", "takes:wayfinder", "why"]);
		expect(r.code).toBe(2);
	});

	it("refuses an unrecognised label", () => {
		const r = run(["17", "takes:triage", "why"]);
		expect(r.code).toBe(2);
	});

	it("refuses with no reason", () => {
		const r = run(["17", "takes:wayfinder"]);
		expect(r.code).toBe(2);
	});
});

describe("parking", () => {
	it("relabels takes:wayfinder, replacing the existing takes: label, comments and releases the claim", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:implement"] });
		const r = run(["9", "takes:wayfinder", "waiting on the founder"]);
		expect(r.code).toBe(0);
		const edit = ghCalls().find((c) => c.startsWith("issue edit"));
		expect(edit).toContain("--add-label takes:wayfinder");
		expect(edit).toContain("--remove-label takes:implement");
		const comment = ghCalls().find((c) => c.startsWith("issue comment"));
		expect(comment).toContain("waiting on the founder");
		expect(heldIssue(9)).toBe(false);
	});

	/* guard-session-ceiling.js reads this record by name, so a rename on one
	   side alone would leave a parked session hearing the wind-up band. */
	it("leaves the .parked-blocked record the ceiling guard reads", () => {
		const r = run(["9", "takes:wayfinder", "why"]);
		expect(r.code).toBe(0);
		const record = path.join(markersDir(sb.repo), `.parked-blocked-${SID}`);
		expect(JSON.parse(fs.readFileSync(record, "utf8"))).toMatchObject({
			outcome: "blocked",
			issue: 9,
			label: "takes:wayfinder",
		});
	});

	it("prints the wait-for-your-own-work step after parking the ticket (#1179 Q1 (A))", () => {
		const r = run(["9", "takes:wayfinder", "why"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("wait for your own background work to report");
		expect(r.stdout).toContain("start no new work");
		expect(r.stdout).toContain("result: only when nothing is");
	});

	it("adds waiting:external alongside the existing takes: label, never removing it", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:implement"], edges: [{ state: "open" }] });
		const r = run(["9", "waiting:external", "blocked on a vendor"]);
		expect(r.code).toBe(0);
		const edit = ghCalls().find((c) => c.startsWith("issue edit"));
		expect(edit).toContain("--add-label waiting:external");
		expect(edit).not.toContain("--remove-label");
	});

	it("needs no issue claim precondition — a call with none still runs", () => {
		const r = run(["9", "takes:wayfinder", "why"]);
		expect(r.code).toBe(0);
	});

	/* #140: blocked on the founder is takes:wayfinder — the founder decides
	   inside Claude Code, in a /wayfinder session (mantahostels#3439). */
	it("refuses takes:human outright, before any gh call, offering takes:wayfinder or keep instead", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:implement"] });
		const r = run(["9", "takes:human", "waiting on the founder"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("takes:wayfinder");
		expect(r.stderr).toContain("pass keep");
		expect(ghCalls()).toEqual([]);
	});

	/* #1020: a founder errand already filed keeps its takes:human rather than
	   being relabelled takes:wayfinder. */
	const errand =
		"**Outside Claude Code:** pay the invoice\n**Close when:** it is paid";

	it("keep leaves a filed errand's labels alone, comments and releases the claim", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:human"], body: errand });
		const r = run(["9", "keep", "waiting on the founder"]);
		expect(r.code).toBe(0);
		expect(ghCalls().some((c) => c.startsWith("issue edit"))).toBe(false);
		const comment = ghCalls().find((c) => c.startsWith("issue comment"));
		expect(comment).toContain("waiting on the founder");
		expect(heldIssue(9)).toBe(false);
	});

	it("keep refuses a takes:human body with no Outside line, naming the fix", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:human"], body: "**Close when:** done" });
		const r = run(["9", "keep", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("**Outside Claude Code:**");
		expect(r.stderr).toContain("issue-body.js append 9");
		expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(false);
		expect(heldIssue(9)).toBe(true);
	});

	it("keep refuses an issue not labelled takes:human, naming the label it carries and editing nothing", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:implement"], body: errand });
		const r = run(["9", "keep", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("takes:implement");
		expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(false);
	});

	it("keep refuses an empty Outside line", () => {
		claimIssue(9);
		stubGh({
			labels: ["takes:human"],
			body: "**Outside Claude Code:**\n**Close when:** done",
		});
		const r = run(["9", "keep", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("names no act outside Claude Code");
	});

	it("keep refuses takes:human doubled with another takes: label, on one line", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:human", "takes:implement"], body: errand });
		const r = run(["9", "keep", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("carries takes:human, takes:implement.");
		expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(false);
	});

	it("keep refuses where the labels cannot be read, writing nothing", () => {
		claimIssue(9);
		stubGh({ labelsExit: 1, body: errand });
		const r = run(["9", "keep", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("could not read #9's labels");
		expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(false);
	});
});

describe("waiting:external needs a gate", () => {
	const gateOn =
		"**Gated on:** the vendor ships v2 — check: npm view vendor version — abandon if: the vendor folds\n**Gate basis:** the vendor names no date";

	it.each([
		["a Gated on line", { body: gateOn }],
		/* #3293: as the shortlist and check-issue-labels.js hold on it. */
		["a Gated on line with no basis", { body: gateOn.split("\n")[0] }],
		["an open native blocker", { edges: [{ state: "open" }] }],
		[
			"an open Blocked on issue",
			{ body: "**Blocked on** #40", states: { 40: "open" } },
		],
		[
			"an open Blocked on issue in another repo",
			{ body: "**Blocked on** acme/lib#40", states: { 40: "open" } },
		],
		[
			"an open Blocked on issue beside an unreadable one",
			{
				body: "**Blocked on** #41, acme/lib#40",
				states: { 41: "open" },
				failPath: "/issues/40",
			},
		],
	])("parks an issue held by %s", (_, opts) => {
		claimIssue(9);
		stubGh({ labels: ["takes:implement"], ...opts });
		const r = run(["9", "waiting:external", "blocked on a vendor"]);
		expect(r.code).toBe(0);
		expect(ghCalls().some((c) => c.startsWith("issue edit"))).toBe(true);
		expect(heldIssue(9)).toBe(false);
	});

	it.each([
		["nothing", {}],
		["a closed native blocker", { edges: [{ state: "closed" }] }],
		[
			"a closed Blocked on issue",
			{ body: "**Blocked on** #40", states: { 40: "closed" } },
		],
	])(
		"refuses an issue held by %s, printing the rule and writing nothing",
		(_, opts) => {
			claimIssue(9);
			stubGh({ labels: ["takes:implement"], ...opts });
			const r = run(["9", "waiting:external", "blocked on a vendor"]);
			expect(r.code).toBe(3);
			expect(r.stderr).toContain(
				"A ticket you find not ready gets its gate written",
			);
			expect(r.stderr).toContain(
				"no open blocked-by edge, no open **Blocked on** issue, no holding **Gated until:** or **Gated on:** line",
			);
			expect(r.stderr).toContain("dependencies/blocked_by -F issue_id=");
			expect(r.stderr).toContain("issue-body.js append 9");
			expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(
				false,
			);
			expect(heldIssue(9)).toBe(true);
		},
	);

	it("refuses where the blockers cannot be read, writing nothing", () => {
		claimIssue(9);
		stubGh({ labels: ["takes:implement"], apiExit: 1 });
		const r = run(["9", "waiting:external", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("blockers are unreadable");
		expect(r.stderr).toContain("re-run, or read them yourself: gh api");
		expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(false);
	});

	it("refuses where a Blocked on issue cannot be read, naming it", () => {
		claimIssue(9);
		stubGh({
			labels: ["takes:implement"],
			body: "**Blocked on** acme/lib#40",
			failPath: "/issues/40",
		});
		const r = run(["9", "waiting:external", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("**Blocked on** acme/lib#40 is unreadable");
		expect(r.stderr).toContain(
			"re-run, or read it yourself: gh issue view 40 --repo acme/lib",
		);
		expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(false);
	});

	it("judges a bare Blocked on issue off the open list, reading no issue", () => {
		claimIssue(9);
		stubGh({
			labels: ["takes:implement"],
			body: "**Blocked on** #40",
			states: { 40: "open" },
		});
		expect(run(["9", "waiting:external", "why"]).code).toBe(0);
		expect(ghCalls().some((c) => /^api \S*\/issues\/40\b/.test(c))).toBe(false);
	});

	it("judges an own-repo qualified Blocked on issue off the open list, as check-issue-labels.js does", () => {
		claimIssue(9);
		stubGh({
			labels: ["takes:implement"],
			body: "**Blocked on** acme/app#40",
			states: { 40: "open" },
			failPath: "/issues/40",
		});
		expect(run(["9", "waiting:external", "why"]).code).toBe(0);
	});

	it("refuses where the open list cannot be read for a bare Blocked on issue", () => {
		claimIssue(9);
		stubGh({
			labels: ["takes:implement"],
			body: "**Blocked on** #40",
			failPath: "/issues",
		});
		const r = run(["9", "waiting:external", "why"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("**Blocked on** issues are unreadable");
		expect(r.stderr).toContain(
			"re-run, or read them yourself: gh issue list --state open",
		);
		expect(ghCalls().some((c) => /^issue (edit|comment)/.test(c))).toBe(false);
	});

	it("parks takes:wayfinder without reading any blocker", () => {
		const r = run(["9", "takes:wayfinder", "why"]);
		expect(r.code).toBe(0);
		expect(ghCalls().some((c) => c.startsWith("api"))).toBe(false);
	});
});

describe("no session id", () => {
	it("refuses outright, before any gh or arbiter call, naming the empty CLAUDE_CODE_SESSION_ID and leaving the claim held", () => {
		claimIssue(17);
		const r = run(["17", "takes:wayfinder", "why"], {
			CLAUDE_CODE_SESSION_ID: "",
		});
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("CLAUDE_CODE_SESSION_ID is empty");
		expect(ghCalls()).toEqual([]);
		expect(heldIssue(17)).toBe(true);
	});
});
