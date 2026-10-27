// @vitest-environment node
/*
 * guard-issue-close.js denies a close that says nothing about what is still
 * outstanding (mantahostels#185), a hand close of a roadmap card's own issue
 * (mantahostels#220), a completed close over unticked acceptance criteria
 * (#1640), and one over census rows the ticket's commits expired (#1913).
 * These are its boundary cases: the line hooks/hooks.json registers, run by
 * bash as the harness runs it, on a harness-shaped payload — the wiring, each
 * exit and its stream, the fail-open record on disk, and gh at WFC_GH, the
 * roadmap, the tracker config, the rule store and git crossed for real.
 * Which close is refused, and why, is lib/issue-close.test.ts's (#2798).
 *
 * CLAUDE_PLUGIN_ROOT is this checkout, so the line finds the real entry;
 * CLAUDE_PROJECT_DIR is a temp project, so the fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Break the line and every issue closes unjudged; make it deny on a fault
 * and every close is wedged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog, readFailOpenRecords } from "./guard-log-fixture";
import { GRAPHQL_FAKE } from "./lib/gh-fake";
import { stubGhScript } from "./lib/gh-stub";
import {
	buildBashPayload,
	entryBesideThrowingCore,
	expectShellHooks,
	guardDirs,
	guardOutput,
	hookLineOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";

const SCRIPT = "scripts/guard-issue-close.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};
// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
const { digestOf } = require("./lib/census-digest") as any;

const CARD_TITLE = "id-match — Build the hostel ID-matching layer";

let dir: string;
let config: string;

/** The issue every `gh issue view` answers, and the open-check's closed
 *  carriers. */
interface Issue {
	title?: string;
	newest?: string;
	body?: string;
	closed?: string[];
}

/**
 * A gh at WFC_GH: `gh issue view` prints the issue's payload, `gh api
 * graphql` answers the Outstanding open-check with every carrier open but
 * `closed`.
 */
function ghServing({
	title = "An issue carrying no card-id prefix at all",
	newest = "a resolution comment with no disposition line",
	body = "",
	closed = [],
}: Issue = {}) {
	const payload = path.join(dir, "issue.json");
	fs.writeFileSync(
		payload,
		JSON.stringify({
			comments: [{ body: newest }],
			title,
			body,
			labels: [],
			parent: null,
		}),
	);
	const gql = path.join(dir, "gql.js");
	fs.writeFileSync(
		gql,
		`${GRAPHQL_FAKE}\nserveAnswer(answerGraphql(process.argv, ${JSON.stringify(closed)}, []));\n`,
	);
	return stubGhScript(
		dir,
		`#!/bin/sh\nif [ "$1" = api ]; then exec node ${gql} "$@"; fi\ncat ${payload}\n`,
	).env;
}

const writeRoadmap = (root: string, state: string) => {
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "docs", "reference-roadmap.html"),
		`<script>const CARDS=[\n{id:"id-match",p:0,a:["tech"],kind:"decision",state:"${state}",t:"A card",m:"—",mn:"note"}\n];</script>\n`,
	);
};

const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd: dir,
		stdio: "ignore",
	});

beforeEach(() => {
	({ dir, config } = guardDirs("issue-close-entry-"));
	fs.mkdirSync(path.join(dir, ".claude"));
	// The tracker a bare `#N` on an Outstanding line resolves to.
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker: "acme/tracker" }),
	);
	// A host is a checkout with a pushed ref: the landing read faults without one (#3101).
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "seed");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command`, run in the temp project. */
const emission = (
	command: string,
	run: { stdin?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) =>
	hookLineOutput(LINES[0] ?? "", command, {
		project: dir,
		config,
		cwd: dir,
		...run,
	});

describe("the registered hook line", () => {
	it("is one line, narrowed by `if: Bash(gh *)`, in the plugin and the self-plugin alike (mantahostels#2127)", () => {
		expectShellHooks(SCRIPT, () => ({
			if: "Bash(gh *)",
			onFailure: "block",
		}));
	});
});

describe("each exit", () => {
	it("refuses a hand close of an active card's issue as permissionDecision JSON on exit 0, reading the roadmap off disk and splicing the stored rule", () => {
		writeRoadmap(dir, "active");
		const out = emission("gh issue close 12", {
			env: ghServing({ title: CARD_TITLE, newest: "**Outstanding:** none" }),
		});
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"This closes the issue for roadmap card `id-match`, and that card is still `active`, not `done`: gh issue close 12",
		);
		expect(out.permissionDecisionReason).toContain(
			readRuleText("card-close-by-hand"),
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("refuses a closed carrier through the open-check at WFC_GH, resolved against the tracker config on disk", () => {
		const out = emission("gh issue close 12", {
			env: ghServing({
				newest: "**Outstanding:** #181 (log rotation)",
				closed: ["181"],
			}),
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"acme/tracker#181 is closed",
		);
		expect(out.permissionDecisionReason).toContain(
			readRuleText("close-outstanding"),
		);
		expect(out.permissionDecisionReason).toContain(
			"node scripts/resolve-ticket.js <n> --comment-file <file>",
		);
	});

	it("still refuses, naming the fragment, where the rule store cannot give it", () => {
		const out = emission("gh issue close 12", {
			env: {
				...ghServing(),
				WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")),
			},
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/close-outstanding.txt",
		);
	});

	it("says nothing about a close that carries its line, or a gh call that closes nothing", () => {
		const env = ghServing({
			newest: "**Outstanding:** #181 (log rotation)",
		});
		expect(emission("gh issue close 12", { env })).toBeNull();
		expect(emission("gh issue list", { env })).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("refuses, logged, where its core throws", () => {
		const out = guardOutput(
			entryBesideThrowingCore(dir, SCRIPT, "issue-close.js"),
			buildBashPayload("gh issue close 12", "s1"),
			{ project: dir, config, cwd: dir },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-issue-close.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, dir)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});
});

describe("the adapters, crossed for real", () => {
	it("reads the census rows a ticket's commits expired out of real git (#1913)", () => {
		const guard = "scripts/guard-one.sh";
		const commit = (body: string, message: string) => {
			fs.writeFileSync(path.join(dir, guard), body);
			git("add", "-A");
			git("commit", "-qm", message);
		};
		fs.mkdirSync(path.join(dir, "scripts"));
		commit("#!/bin/sh\necho rule one\n", "seed");
		fs.writeFileSync(
			path.join(dir, "scripts/instruction-surface-anchors.json"),
			JSON.stringify({ guards: { [guard]: { digest: digestOf(dir, guard) } } }),
		);
		commit("#!/bin/sh\necho rule one, reworded\n", "Reword the guard (#12)");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		const out = emission("gh issue close 12", {
			env: ghServing({ newest: "Done.\n**Outstanding:** none." }),
		});
		expect(out.permissionDecisionReason).toContain(
			`This close leaves census rows its commits expired: gh issue close 12\n\n#12's commits changed`,
		);
		expect(out.permissionDecisionReason).toContain(`  ${guard}\n`);
	});

	it("finds the roadmap at the host root from a subdirectory with CLAUDE_PROJECT_DIR unset (mantahostels#1905)", () => {
		// Read relative to the cwd, a subdirectory named a roadmap that does not
		// exist and the guard silently stopped judging card closes.
		writeRoadmap(dir, "active");
		const sub = path.join(dir, "sub");
		fs.mkdirSync(sub);
		const out = emission("gh issue close 12", {
			cwd: sub,
			env: {
				...ghServing({ title: CARD_TITLE, newest: "**Outstanding:** none" }),
				CLAUDE_PROJECT_DIR: undefined,
			},
		});
		expect(out.permissionDecisionReason).toContain(
			"and that card is still `active`",
		);
	});
});

describe("what it fails open on", () => {
	it("allows a payload that is not JSON, and records that it did", () => {
		expect(emission("", { stdin: "not json" })).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				"guard-issue-close.js",
				expect.stringContaining("payload did not parse as JSON"),
			],
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

	it("allows a close whose gh cannot be started, and records that it did", () => {
		expect(
			emission("gh issue close 12", { env: { WFC_GH: "/dev/null/gh" } }),
		).toBeNull();
		expect(readFailOpenRecords(config, dir).map((f) => f[2])).toEqual([
			"could not read comments on #12 — close allowed unchecked",
		]);
	});

	it("fails open, exit 0 and silent, where node is not on PATH", () => {
		expect(
			emission("gh issue close 12", { env: { PATH: "/nonexistent" } }),
		).toBeNull();
	});
});
