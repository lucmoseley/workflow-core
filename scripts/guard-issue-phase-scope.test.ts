// @vitest-environment node
/*
 * guard-issue-phase-scope.js denies a `gh issue create` whose title names a
 * roadmap card outside Phase 0 that the founder has not called
 * (mantahostels#1613). These are its boundary cases: the line hooks/hooks.json
 * registers, run by bash as the harness runs it, on a harness-shaped payload
 * — the wiring, each exit and its stream, the fail-open record on disk, and
 * the roadmap and register read off the real fs under the host root. Which
 * command is refused, and why, is lib/issue-phase-scope.test.ts's (#2798).
 *
 * CLAUDE_PLUGIN_ROOT is this checkout, so the line finds the real entry;
 * CLAUDE_PROJECT_DIR is a temp project holding FIXTURE docs, so a card moving
 * phase never changes a verdict here, and the fail-open log lands in the temp
 * CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Break the line and a session files work on a later phase's card the founder
 * never called; make it deny on a fault and filing Phase-0 work is wedged.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog, readFailOpenRecords } from "./guard-log-fixture";
import {
	buildBashPayload,
	entryBesideThrowingCore,
	expectShellHooks,
	guardDirs,
	guardOutput,
	hookLineOutput,
} from "./lib/pretool-guard-testkit";

const SCRIPT = "scripts/guard-issue-phase-scope.js";
/* The line the harness runs: node absent, it exits 0 unrecorded. */
const LINE = `command -v node >/dev/null 2>&1 || exit 0; node "\${CLAUDE_PLUGIN_ROOT}"/${SCRIPT}`;
/* The self-plugin's, rooted at the project. */
const SELF_LINE = `command -v node >/dev/null 2>&1 || exit 0; node "$CLAUDE_PROJECT_DIR"/${SCRIPT}`;

const ROADMAP = [
	"const ITEMS = [",
	'  {id:"guide-pages",p:0,a:["mkt"],kind:"action",state:"active",t:"Destination guides",',
	'  {id:"search-core",p:1,a:["prod"],kind:"action",state:"active",t:"Search core",',
	"];",
].join("\n");

const register = (...cards: string[]) =>
	[
		"<!-- called-cards:begin -->",
		...cards.map((c) => `- \`${c}\` — called 1 January 2026`),
		"<!-- called-cards:end -->",
		"",
	].join("\n");

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("issue-phase-scope-entry-"));
	fs.mkdirSync(path.join(dir, "docs"));
	fs.writeFileSync(path.join(dir, "docs/reference-roadmap.html"), ROADMAP);
	fs.writeFileSync(path.join(dir, "docs/called-cards.md"), register());
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command`, run in the temp project. */
const emission = (
	command: string,
	run: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
) => hookLineOutput(LINE, command, { project: dir, config, cwd: dir, ...run });

describe("the registered hook line", () => {
	it("is this one line, narrowed by the unanchored `if: Bash(*gh *)`, in the plugin and the self-plugin alike (mantahostels#2127)", () => {
		// Unanchored, so `timeout 60 gh …` and `nohup gh …` reach the judge.
		expectShellHooks(SCRIPT, (file) => ({
			command: file === "hooks/hooks.json" ? LINE : SELF_LINE,
			if: "Bash(*gh *)",
			onFailure: "block",
		}));
	});
});

describe("each exit", () => {
	it("refuses an uncalled Phase-1 card as permissionDecision JSON on exit 0, read off the roadmap on disk", () => {
		const out = emission('gh issue create --title "search-core — a thing"');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"This opens an issue for `search-core`, a **Phase 1** roadmap card the founder has not called",
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("says nothing, exit 0, once the register on disk calls the card, or for a Phase-0 card", () => {
		fs.writeFileSync(
			path.join(dir, "docs/called-cards.md"),
			register("search-core"),
		);
		expect(
			emission('gh issue create --title "search-core — a thing"'),
		).toBeNull();
		expect(
			emission('gh issue create --title "guide-pages — a thing"'),
		).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("refuses, logged, where its core throws", () => {
		const out = guardOutput(
			entryBesideThrowingCore(dir, SCRIPT, "issue-phase-scope.js"),
			buildBashPayload('gh issue create --title "x" --body "y"', "s1"),
			{ project: dir, config, cwd: dir },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-issue-phase-scope.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, dir)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});
});

describe("what it fails open on", () => {
	it("allows a create whose roadmap is missing, and records it on disk", () => {
		fs.rmSync(path.join(dir, "docs/reference-roadmap.html"));
		expect(
			emission('gh issue create --title "search-core — a thing"'),
		).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				"guard-issue-phase-scope.js",
				"docs/reference-roadmap.html is unreadable — issue creation allowed unchecked",
			],
		]);
	});

	it("allows a payload that is not JSON, and records that it did", () => {
		expect(emission("", { stdin: "not json" })).toBeNull();
		expect(readFailOpenRecords(config, dir).map((f) => f[2])).toEqual([
			expect.stringContaining("payload did not parse as JSON"),
		]);
	});

	it("allows a payload carrying no command, and records that it did", () => {
		expect(
			emission("", {
				stdin: JSON.stringify({ session_id: "s1", tool_name: "Bash" }),
			}),
		).toBeNull();
		expect(readFailOpenRecords(config, dir).map((f) => f[2])).toEqual([
			expect.stringContaining("no command in payload"),
		]);
	});

	it("fails open, exit 0 and silent, where node is not on PATH", () => {
		expect(
			emission('gh issue create --title "search-core — a thing"', {
				env: { PATH: "/nonexistent" },
			}),
		).toBeNull();
	});
});
