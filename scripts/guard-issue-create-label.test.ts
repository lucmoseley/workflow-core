// @vitest-environment node
/*
 * The guard-issue-create-label core of guard-dispatch.js refuses an issue
 * create carrying no valid `takes:` label (mantahostels#470, the build;
 * mantahostels#453, the ruling). These are its boundary cases, the dispatcher
 * entry run on it alone on a harness-shaped payload: each exit, the
 * fail-open record on disk, and the fs, the rule store and gh at WFC_GH
 * crossed for real. Which command is refused, and why, is
 * lib/issue-create-label.test.ts's; the entry's payload faults and the throw
 * policy are guard-dispatch's own tests' (#2796, #3225).
 *
 * CLAUDE_PROJECT_DIR is a temp project, so the fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Make it allow an unlabelled create and every issue is filed unrouted; make
 * it deny on a fault and every `gh` call is wedged.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenRecords } from "./guard-log-fixture";
import { ghFakeScript } from "./lib/gh-fake";
import { stubGhScript } from "./lib/gh-stub";
import { UNFILLED_DESTINATION } from "./lib/issue-gate";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
	guardOutput,
} from "./lib/pretool-guard-testkit";
import { HANG_TIMEOUT_MS } from "./lib/stop-guard-testkit";

const CORE = "guard-issue-create-label";
const ISSUE_BODY = path.join(__dirname, "lib/fixtures/gh/issue-body.json");
const MAP_LIST = path.join(__dirname, "lib/fixtures/gh/map-list.json");
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};
const DELIVERABLE_POINTER_LEAD =
	"This applies takes:human. The issue body is the hand-over's source: the act, why, the deliverable verbatim or each step, then **Close when:**. The full rule:";

const ERRAND =
	"**Outside Claude Code:** email the hostel.\n**Close when:** the founder confirms it is done";

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("issue-create-label-entry-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The core's hookSpecificOutput for `command`, run in the temp project. */
const emission = (
	command: string,
	{ env = {} }: { env?: NodeJS.ProcessEnv } = {},
) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "s1"), {
		project: dir,
		config,
		cwd: dir,
		env,
	});

/** A gh at WFC_GH answering `fixture` with `stdout` swapped in. */
function ghAnswering(fixture: string, stdout: string) {
	const at = path.join(dir, path.basename(fixture));
	const answer = JSON.parse(fs.readFileSync(fixture, "utf8"));
	fs.writeFileSync(at, JSON.stringify({ ...answer, stdout }));
	return stubGhScript(path.join(dir, "gh"), ghFakeScript(at)).env;
}

describe("each exit", () => {
	it("refuses a create with no takes: label as permissionDecision JSON on exit 0, splicing the stored rule", () => {
		const out = emission('gh issue create --title "t" --body "b"');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			'This creates an issue with no `takes:` label: gh issue create --title "…" --body "…"',
		);
		expect(out.permissionDecisionReason).toContain(
			readRuleText("issue-takes-label"),
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("refuses a takes:human create with no Close-when line, splicing the founder-deliverable rule", () => {
		const out = emission(
			"gh issue create --title t --label takes:human --body '**Outside Claude Code:** email the hostel.'",
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			readRuleText("founder-deliverable"),
		);
	});

	it("still refuses, naming the fragment, where the rule store cannot give it", () => {
		const out = emission('gh issue create --title "t" --body "b"', {
			env: { WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")) },
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"could not be read from docs/agents/rules/issue-takes-label.txt",
		);
	});

	it("still refuses a takes:human create with no Close-when line, naming the deliverable fragment, where the store cannot give it", () => {
		const out = emission(
			"gh issue create --title t --label takes:human --body '**Outside Claude Code:** email the hostel.'",
			{ env: { WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")) } },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"could not be read from docs/agents/rules/founder-deliverable.txt",
		);
	});

	it("warns, as additionalContext on exit 0, on a GraphQL create whose labelIds it cannot name (mantahostels#519)", () => {
		const out = emission(
			`gh api graphql -f query='mutation{createIssue(input:{repositoryId:"R",title:"t",labelIds:["LA_x"]}){issue{id}}}'`,
		);
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain("labelIds");
	});

	it("says nothing about a labelled create, or a gh call that files nothing", () => {
		expect(
			emission('gh issue create --title "t" --body "b" --label takes:triage'),
		).toBeNull();
		expect(emission("gh issue list")).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("names the template at the plugin root in an install, WFC_SCRIPT_ROOT standing in for one (#1248)", () => {
		const plugin = fs.mkdtempSync(path.join(dir, "plugin-"));
		const out = emission(
			`cat <<'BODY' | gh issue create --title t --label takes:human --body-file -\n${ERRAND}\nBODY`,
			{ env: { WFC_SCRIPT_ROOT: plugin } },
		);
		expect(out.additionalContext).toBe(
			`${DELIVERABLE_POINTER_LEAD} ${plugin}/scripts/lib/rule-text.sh founder-deliverable`,
		);
	});

	// Were a gate line's tail a lazy group before its trailing blanks, each of
	// 100,000 blanks inside it would retry the run to the line's end, a minute
	// or more; read to the end and back once, milliseconds (#3383). All three
	// marker lines are read past their blanks: the refusal names the window the
	// gate line writes and the basis line does not.
	it("judges a body whose gate lines hold long blank stretches, promptly", () => {
		const blanks = " ".repeat(100_000);
		const body =
			`**Gated until:** 2026-01-01 — a${blanks}b\n` +
			`**Gated on:** 3 days pass after the launch${blanks}b — abandon if: c\n` +
			`**Gate basis:** the launch${blanks}date`;
		const out = guardOutput(
			path.join(__dirname, "guard-dispatch.js"),
			{
				hook_event_name: "PreToolUse",
				...buildBashPayload(
					`gh issue create --title t --label takes:implement --body '${body}'`,
					"s1",
				),
			},
			{
				project: dir,
				config,
				cwd: dir,
				args: ["--only", CORE],
				timeout: HANG_TIMEOUT_MS,
			},
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			'It carries "3 days", a window the `**Gate basis:**` line does not name.',
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});
});

describe("the adapters, crossed for real", () => {
	it("reads a --body-file off disk, relative to the command's directory (mantahostels#3443)", () => {
		fs.writeFileSync(path.join(dir, "empty.md"), "\n");
		expect(
			emission(
				"gh issue create --title t --label takes:triage --body-file empty.md",
			).permissionDecisionReason,
		).toContain("This files an issue whose body is empty");
		expect(
			emission(
				"gh issue create --title t --label takes:triage --body-file gone.md",
			).permissionDecisionReason,
		).toContain("read from a file that does not exist: `gone.md`");
	});

	it("runs gh in the directory the edit runs in (#2796)", () => {
		const sub = fs.mkdtempSync(path.join(dir, "sub-"));
		const env = stubGhScript(
			path.join(dir, "gh"),
			`#!/bin/sh\n[ "$PWD" = "${sub}" ] || exit 1\nprintf 'Fill the gaps.\\n'\n`,
		).env;
		expect(
			emission(`cd ${sub} && gh issue edit 12 --add-label takes:human`, { env })
				.permissionDecisionReason,
		).toContain("applies `takes:human` to #12 whose body names no act");
	});

	it("fetches a relabelled issue's body from the gh at WFC_GH (mantahostels#3555)", () => {
		const env = ghAnswering(ISSUE_BODY, "Fill the gaps.\n");
		expect(
			emission("gh issue edit 12 --add-label takes:human", { env })
				.permissionDecisionReason,
		).toContain("applies `takes:human` to #12 whose body names no act");
		expect(
			emission("gh issue edit 12 --add-label takes:human", {
				env: ghAnswering(ISSUE_BODY, `${ERRAND}\n`),
			}).additionalContext,
		).toContain(DELIVERABLE_POINTER_LEAD);
	});

	it("lists the open maps from the gh at WFC_GH (#717)", () => {
		const unfilled = JSON.stringify([
			{ number: 3, body: `## Destination\n\n${UNFILLED_DESTINATION}\n` },
		]);
		const create =
			"gh issue create --title x --label takes:wayfinder --label wayfinder:map --body y";
		expect(
			emission(create, { env: ghAnswering(MAP_LIST, unfilled) })
				.permissionDecisionReason,
		).toContain("Fill #3 instead");
	});
});

describe("what it fails open on", () => {
	it("allows a relabel whose gh cannot be started, and records that it did", () => {
		expect(
			emission("gh issue edit 12 --add-label takes:human", {
				env: { WFC_GH: "/dev/null/gh" },
			}),
		).toBeNull();
		expect(readFailOpenRecords(config, dir).map((f) => f[2])).toEqual([
			"could not fetch #12's body for a takes:human relabel — relabel allowed unchecked",
		]);
	});
});
