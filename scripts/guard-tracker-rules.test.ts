// @vitest-environment node
/*
 * guard-tracker-rules.sh hands a session a tracker rule at the `gh` call that
 * engages it (mantahostels#2493, mantahostels#2497; spec mantahostels#2457 §T3).
 *
 * THE TABLE IS ASSERTED SHAPE BY SHAPE. Each mapped `gh` form gets the exact id
 * set its TRIGGERS row names and nothing else, so a row that widens silently —
 * a `--body` matched anywhere on a `--add-assignee` command, say — fails here
 * rather than costing a session a rule it did not engage. A row that narrows
 * lets a session file, label or close an issue without the tracker rule it
 * engaged ever reaching it.
 *
 * It never denies, so every case asserts `permissionDecision` is ABSENT as well
 * as asserting the text, which is why the shared deny fixtures are not used.
 *
 * No git repo is built: this guard walks no working tree, and gr_root takes
 * CLAUDE_PROJECT_DIR before it ever reaches git.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

/* The rule latch lives under gr_markers_dir (.claude/tmp/markers), not the
 * throwaway root itself — guard-parse.sh's _gp_rule_marker (mantahostels#3515 F8,
 * issue #2). */
const { markersDir } = createRequire(__filename)("./lib/marker-root.js");

const GUARD = path.resolve(__dirname, "guard-tracker-rules.sh");
/* The store's Node accessor, so a test asks for the rule by id rather than
 * holding a second copy of its text. CommonJS, hence the require. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

let dir: string;
let config: string;
let root: string;

beforeEach(() => {
	({ dir, config } = guardDirs("tracker-rules-"));
	root = path.join(dir, "root");
	fs.mkdirSync(root);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Payload = Record<string, unknown>;

const run = (payload: Payload, env: Record<string, string> = {}, cwd = root) =>
	spawnGuard(GUARD, payload, { project: root, config, cwd, env });

/** The whole hook output for one payload, parsed. Null where it said nothing. */
const emission = (payload: Payload) =>
	guardOutput(GUARD, payload, { project: root, config, cwd: root });

/** A Bash PreToolUse payload. */
const bash = (command: string, session = "test"): Payload =>
	buildBashPayload(command, session);

/* guard-parse.sh's own ceiling on one delivery. Restated rather than read out
 * of that file, so moving it is a visible edit on both sides. */
const GP_RULE_CAP = 4000;

const CREATE =
	'gh issue create --title "t" --body "b" --label takes:implement --label kind:ticket';

/*
 * THE TABLE, restated on this side rather than read out of the guard: a test
 * that parsed TRIGGERS out of the shell would move with a mutation to it and
 * catch nothing. The order is the guard's emission order, which is its priority
 * order, and `expect(ids)` below is order-sensitive.
 */
const MAPPED: [string, string[], string][] = [
	[
		CREATE,
		[
			"create-command-shape",
			"takes-value-vocabulary",
			"issue-parent-unplaced",
			"issue-created-assigned",
			"citation-inferred-number",
		],
		"a creation",
	],
	[
		"gh issue close 2497 --comment 'done'",
		["close-outstanding-line", "ticket-criteria-unticked"],
		"a close",
	],
	[
		'gh issue edit 2497 --body "new body"',
		["issue-body-raw-write"],
		"a body write",
	],
	[
		"gh issue edit 2497 --body-file /tmp/b.md",
		["issue-body-raw-write"],
		"the body-file spelling of the same write",
	],
	["gh issue edit 2497 --add-assignee @me", ["issue-claim-scope"], "a claim"],
	[
		"gh issue comment 2497 --body-file -",
		["citation-number-first"],
		"a comment, where a citation is written",
	],
	/* #2309: the session ending on a ticket it found not ready. */
	[
		'gh issue comment 2497 --body "**Blocked** — waiting on the pin bumps."',
		["blocked-ticket-gate", "citation-number-first"],
		"a comment opening **Blocked",
	],
	[
		"gh issue comment 2497 --body-file - <<'EOF'\n**Blocked:** no adopter has bumped.\nEOF",
		["blocked-ticket-gate", "citation-number-first"],
		"the same comment as a quoted heredoc",
	],
	[
		'gh issue comment 2497 --body "Done. No longer **Blocked**."',
		["citation-number-first"],
		"a comment naming Blocked after its opening",
	],
	[
		"gh api --method POST repos/o/r/issues/2497/sub_issues -F sub_issue_id=1",
		["dependency-edge-false-success"],
		"a sub-issue link",
	],
	[
		"gh api repos/o/r/issues/2497/dependencies/blocked_by",
		["dependency-edge-false-success"],
		"a blocker read",
	],
	[
		"gh api --method DELETE repos/o/r/issues/2497/sub_issue -F sub_issue_id=1",
		["dependency-edge-false-success"],
		"the singular DELETE spelling the re-root takes",
	],
	/* mantahostels#2592's three added routes. The issue-body.js one is the guard's only
	 * non-`gh` shape, and the reason the registration carries no `if`. */
	[
		'node scripts/issue-body.js tick 2592 --match "some criterion"',
		["issue-body-success-signal"],
		"an issue-body.js subcommand, which is not a `gh` call at all",
	],
	[
		"./scripts/issue-body.js tick 2592 --match x",
		["issue-body-success-signal"],
		"the same script run directly, with no `node` in front",
	],
	/* mantahostels#2652. The parser masks a quoted span, so the raw glob gating the limb
	 * never sees the text. */
	[
		'gh issue comment 2592 --body "run node scripts/issue-body.js tick 12 first"',
		["citation-number-first"],
		"a QUOTED body naming the script and a writing subcommand, which spends no latch",
	],
	[
		"gh issue comment 2592 --body-file $CLAUDE_JOB_DIR/tmp/body.md",
		["gh-job-dir-unreadable", "citation-number-first"],
		"a comment whose body file `gh` cannot read",
	],
	[
		"gh issue create --title t --body-file /home/x/.claude/jobs/abc/tmp/b.md",
		[
			"gh-job-dir-unreadable",
			"create-command-shape",
			"takes-value-vocabulary",
			"issue-parent-unplaced",
			"issue-created-assigned",
			"citation-inferred-number",
		],
		"the expanded job-dir spelling, for a hook environment with no CLAUDE_JOB_DIR",
	],
	[
		"gh api --method PATCH repos/o/r/issues/comments/1 -F body=@$CLAUDE_JOB_DIR/tmp/b.md",
		["gh-job-dir-unreadable"],
		"the `-F body=@<path>` spelling, which names no `--body-file` flag",
	],
	/* mantahostels#2652's three added job-dir shapes. The piped one is why the predicate
	 * went command-wide: its path sits in the `cat` segment, which is not a
	 * `gh` call at all. */
	[
		"cat $CLAUDE_JOB_DIR/tmp/body.md | gh issue comment 2592 --body-file -",
		["gh-job-dir-unreadable", "citation-number-first"],
		"the PIPED spelling, whose path is in a segment `gh` does not appear in",
	],
	[
		"gh issue edit 2592 --body-file $CLAUDE_JOB_DIR/tmp/b.md",
		["gh-job-dir-unreadable", "issue-body-raw-write"],
		"a body write whose file `gh` cannot read",
	],
	[
		'gh issue close 2592 --comment "$(cat $CLAUDE_JOB_DIR/tmp/b.md)"',
		[
			"gh-job-dir-unreadable",
			"close-outstanding-line",
			"ticket-criteria-unticked",
		],
		"the documented resolution route, whose comment substitutes an unreadable file",
	],
	/* THE `=`-JOINED AND SHORT SPELLINGS. Three of the predicates' six flag arms
	 * exist only for these, so without a case each a mutation deleting one
	 * passes the suite. */
	[
		"gh issue edit 2497 --body=new",
		["issue-body-raw-write"],
		"the `=`-joined body flag",
	],
	[
		"gh issue edit 2497 -b new",
		["issue-body-raw-write"],
		"gh's short body flag",
	],
	[
		"gh issue edit 2497 -F body.md",
		["issue-body-raw-write"],
		"gh's short body-file flag",
	],
	[
		"gh issue edit 2497 --add-assignee=@me",
		["issue-claim-scope"],
		"the `=`-joined assignee flag",
	],
	[
		"gh api repos/o/r/issues/2497/sub_issues?per_page=100",
		["dependency-edge-false-success"],
		"the PAGED read, whose query string an end-anchored arm would miss",
	],
	[
		"gh api repos/o/r/issues/2497/dependencies/blocking",
		["dependency-edge-false-success"],
		"the other side of the dependency edge",
	],
	/* Two rows share the `issue edit` subcommand, and this is the only shape
	 * where engaged()'s dedupe carries weight — both rows match, and neither id
	 * may arrive twice. */
	[
		"gh issue edit 2497 --add-assignee @me --body new",
		["issue-body-raw-write", "issue-claim-scope"],
		"a claim and a body write on one command",
	],
	["gh pr checks 5", ["gh-cli-limits"], "a checks read, which 403s"],
	[
		'gh pr view 5 --json "number,statusCheckRollup"',
		["gh-cli-limits"],
		"a QUOTED field list, which the parser masks",
	],
	[
		"gh api repos/o/r/commits/abc/check-runs",
		["gh-cli-limits"],
		"the REST check-runs endpoint",
	],
	[
		"gh run list --commit abc",
		["gh-cli-limits"],
		"a commit-filtered run list, which comes back empty",
	],
	[
		"gh issue view 2493 --comments",
		["gh-cli-limits"],
		"a comments read, empty on a zero-comment issue",
	],
	[
		"gh issue edit 2497 --add-label kind:ticket",
		["triage-role-labels"],
		"any label edit",
	],
	[
		"gh issue edit 2497 --add-label not-urgent",
		["triage-role-labels"],
		"a label merely containing `urgent`",
	],
	[
		'gh issue edit 2497 --add-label "kind:ticket,urgent"',
		["urgent-label", "triage-role-labels"],
		"`urgent` inside a quoted comma list",
	],
	[
		"gh pr edit 5 --remove-label urgent",
		["urgent-label", "triage-role-labels"],
		"a removal, on a pull request",
	],
];

/** The ids whose fragment text the emission carries, in the order they appear. */
const idsIn = (ctx: string) => {
	const store = path.resolve(__dirname, "..", "docs", "agents", "rules");
	return fs
		.readdirSync(store)
		.filter((f) => f.endsWith(".txt"))
		.map((f) => f.replace(/\.txt$/, ""))
		.map((id) => [id, ctx.indexOf(ruleText(id))] as const)
		.filter(([, at]) => at >= 0)
		.sort((a, b) => a[1] - b[1])
		.map(([id]) => id);
};

describe("each mapped shape is handed its row's rules, and refused nothing", () => {
	it.each(MAPPED)("%s — %s", (command, ids) => {
		const out = emission(bash(command));
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(idsIn(out.additionalContext as string)).toEqual(ids);
	});

	it.each([
		[
			"cd /repo && gh issue create --title t",
			"a creation behind a cd, which the anchored `if` does not reach",
		],
		[
			"/usr/bin/gh issue create --title t",
			"a path-spelled gh, which the basename test catches and the anchored `if` does not",
		],
		["gh issue create --title t | tee out.txt", "a creation piped somewhere"],
	])("%s is handed the creation rules — %s", (command) => {
		const out = emission(bash(command));
		expect(idsIn(out.additionalContext as string)).toContain(
			"create-command-shape",
		);
	});

	it("hands a gh call run from inside a job tree the job-dir rule only where a word is a path there (#1731)", () => {
		const job = path.join(dir, ".claude", "jobs", "abc");
		fs.mkdirSync(job, { recursive: true });
		const idsFrom = (command: string, session: string) => {
			const r = run(bash(command, session), { CLAUDE_JOB_DIR: job }, job);
			expect(r.status).toBe(0);
			expect(r.stderr ?? "").toBe("");
			return idsIn(JSON.parse(r.stdout).hookSpecificOutput.additionalContext);
		};
		expect(idsFrom("gh issue comment 2592 --body x", "bare")).toEqual([
			"citation-number-first",
		]);
		expect(
			idsFrom("gh issue comment 2592 --body-file tmp/b.md", "path"),
		).toContain("gh-job-dir-unreadable");
	});

	it("hands a `waiting:` edit its vocabulary and the role table in one envelope, and nothing on the next label edit (#2023)", () => {
		// One envelope only while the two fragments together fit GP_RULE_CAP;
		// grow either past it and the role table defers to the next edit.
		const edit = bash("gh issue edit 2497 --remove-label=waiting:external");
		const first = emission(edit);
		expect(first.permissionDecision).toBeUndefined();
		expect(idsIn(first.additionalContext as string)).toEqual([
			"waiting-external-vocabulary",
			"triage-role-labels",
		]);
		expect(emission(edit)).toBeNull();
	});

	it("fits `urgent` and the `waiting:` vocabulary in one envelope when one edit names both (#2023)", () => {
		const edit = bash("gh issue edit 2497 --add-label urgent,waiting:external");
		expect(idsIn(emission(edit).additionalContext as string)).toEqual([
			"urgent-label",
			"waiting-external-vocabulary",
		]);
	});

	it("frames the rules by naming where they are authored", () => {
		const ctx = emission(bash(CREATE)).additionalContext as string;
		expect(ctx).toContain("docs/agents/issue-tracker.md");
		expect(ctx).toContain("the vendored defaults are not this repo's");
	});

	it("emits in priority order, so a truncated delivery keeps the costliest rule", () => {
		// The create row is the only one carrying more than two ids, and
		// `create-command-shape` leads it because its breach hides the body from
		// the `takes:human` and blank-body checks.
		const ids = idsIn(emission(bash(CREATE)).additionalContext as string);
		expect(ids[0]).toBe("create-command-shape");
	});

	it("spends little of the cap on the widest row, so a later id still fits", () => {
		// GP_RULE_CAP is BYTES, and the fragments are multibyte — guard-parse.sh
		// forces LC_ALL=C on its own length for exactly this reason.
		const ctx = emission(bash(CREATE)).additionalContext as string;
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(GP_RULE_CAP);
	});
});

/*
 * MUTATION ANCHORS. `idsIn` above reads the same files the guard does, so it
 * moves with a mutation to a fragment instead of catching it: cut a row and
 * both sides lose it together.
 *
 * Whitespace is collapsed because a fragment is authored markdown — a table
 * row, a wrapped sentence — so pinning column widths and line breaks would
 * refuse a re-wrap that changed nothing a reader acts on.
 */
const carries = (id: string, clause: string) =>
	expect(ruleText(id).replace(/\s+/g, " ")).toContain(clause);

describe("each injected rule still carries the clause it exists for", () => {
	it("a clause no fragment carries fails", () => {
		expect(() => carries("takes-value-vocabulary", "takes:whatever")).toThrow();
	});

	it.each([
		["`takes:wayfinder`", "/wayfinder <n>"],
		["`takes:to-spec`", "/to-spec <n>"],
		["`takes:to-tickets`", "/to-tickets <n>"],
		["`takes:implement`", "/implement <n>"],
		["`takes:triage`", "/triage <n>"],
		["`takes:human`", "Done outside Claude Code entirely"],
		["`takes:children`", "A container"],
	])("keeps %s and what it routes to", (value, meaning) => {
		carries("takes-value-vocabulary", value);
		carries("takes-value-vocabulary", meaning);
	});

	it.each([
		["create-command-shape", "pass the body by `--body-file -`"],
		["issue-parent-unplaced", "is placed before anything else"],
		["issue-created-assigned", "is created unassigned"],
		["close-outstanding-line", "Every close says what is still outstanding"],
		["ticket-criteria-unticked", "never batch-ticked"],
		["issue-body-raw-write", "goes through `scripts/issue-body.js`"],
		["issue-claim-scope", "working right now, and only that one"],
		[
			"dependency-edge-false-success",
			"a false success is the ordinary failure",
		],
		/* Two cases for one id: the caps take DIFFERENT remedies, and a fragment
		 * giving one remedy for both passed a single-clause anchor. */
		[
			"dependency-edge-false-success",
			"At 7 layers, give the new issue the **same parent**",
		],
		[
			"dependency-edge-false-success",
			"At 100 children, closed ones counted, a peer does not help",
		],
		["citation-number-first", "Number before title, always"],
		["gh-cli-limits", "re-run an empty result once before believing it"],
		["gh-cli-limits", "is the working route"],
		["urgent-label", "never writes it"],
		["urgent-label", "a human removes it"],
		["triage-role-labels", "Create none of"],
		["waiting-external-vocabulary", "The value set is closed at one value"],
	])("%s keeps %s", (id, clause) => carries(id, clause));
});

/*
 * THE SUBCOMMAND LIST IS A SECOND COPY of scripts/issue-body.js's own less
 * `show`, and
 * nothing else pins them together: a subcommand added there and not here drops
 * silently out of the limb. Read out of the USAGE block rather than restated.
 */
describe("the issue-body.js limb knows every subcommand the script has", () => {
	it("carries exactly scripts/issue-body.js's own USAGE list", () => {
		const script = fs.readFileSync(
			path.resolve(__dirname, "issue-body.js"),
			"utf8",
		);
		const usage = script.match(/const USAGE = `([\s\S]*?)`;/);
		if (!usage) throw new Error("no USAGE block in scripts/issue-body.js");
		const declared = usage[1]
			.split("\n")
			.map((l) => l.match(/^ {2}([a-z][a-z-]*) +<issue>/))
			.filter((m): m is RegExpMatchArray => m !== null)
			.map((m) => m[1])
			/* `show` writes nothing, so the `written and verified` signal the rule
			 * is about never appears in its output and it engages no rule. */
			.filter((name) => name !== "show")
			.sort();
		expect(declared.length).toBeGreaterThan(4);

		const guard = fs.readFileSync(GUARD, "utf8");
		const list = guard.match(/^ISSUE_BODY_SUBCOMMANDS="(.*)"$/m);
		if (!list) throw new Error("no ISSUE_BODY_SUBCOMMANDS in the guard");
		expect(list[1].trim().split(/ +/).sort()).toEqual(declared);
	});
});

describe("it says it once", () => {
	it("is silent on a session's second creation, and speaks to a new session", () => {
		expect(emission(bash(CREATE, "sess-A"))).not.toBeNull();
		expect(emission(bash(CREATE, "sess-A"))).toBeNull();
		expect(emission(bash(CREATE, "sess-B"))).not.toBeNull();
	});

	/* The latch is per (rule, agent, session), so a shape whose ids a sibling
	 * shape does not carry has a silence of its own to prove. */
	it.each(MAPPED)("%s is silent the second time — %s", (command) => {
		const session = `sess-${command.length}-${command.slice(-6)}`;
		expect(emission(bash(command, session))).not.toBeNull();
		expect(emission(bash(command, session))).toBeNull();
	});

	it("a shape whose ids a session has not met still speaks to it", () => {
		// The prelude is latched once, the fragments per id: a session told the
		// create rules must still meet the close rules at its first close.
		expect(emission(bash(CREATE, "sess-mixed"))).not.toBeNull();
		const out = emission(bash("gh issue close 1 --comment x", "sess-mixed"));
		expect(idsIn(out.additionalContext as string)).toEqual([
			"close-outstanding-line",
			"ticket-criteria-unticked",
		]);
	});

	it("a subagent under a session already told is told too", () => {
		// A dispatched subagent's payload carries its PARENT's session_id and is
		// told apart only by agent_id (mantahostels#1804). Keyed on the session alone, the
		// subagent would inherit the parent's latch and never meet the rule.
		expect(emission(bash(CREATE, "sess-C"))).not.toBeNull();
		expect(
			emission({ ...bash(CREATE, "sess-C"), agent_id: "sub-1" }),
		).not.toBeNull();
	});
});

/*
 * The prelude carries its own latch (mantahostels#2275), and gp_rule writes it (mantahostels#2528).
 * Written HERE it would be written before the emission, so an arm that loses
 * the prelude would still mark the session told.
 */
describe("the prelude's latch is written after the emission", () => {
	const preludeMarker = () =>
		path.join(
			markersDir(root),
			".rule-injected-warn.tracker-rules-prelude-main-test",
		);

	it("marks it once the envelope has gone out", () => {
		expect(emission(bash(CREATE))).not.toBeNull();
		expect(fs.existsSync(preludeMarker())).toBe(true);
	});

	/* The stub fails gp_rule's own `jq -nc` envelope call and passes everything
	 * else through, so gp_begin still parses the payload. */
	it("leaves it unmarked where the envelope will not render, so the framing is still owed", () => {
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		const real = (
			spawnSync("which", ["jq"], { encoding: "utf8" }).stdout ?? ""
		).trim();
		if (!real) throw new Error("jq not on PATH — this case stubs it");
		fs.writeFileSync(
			path.join(bin, "jq"),
			`#!/bin/sh\nfor a in "$@"; do [ "$a" = "-nc" ] && exit 1; done\nexec "${real}" "$@"\n`,
			{ mode: 0o755 },
		);
		const r = run(bash(CREATE), { PATH: `${bin}:${process.env.PATH}` });
		expect(r.status).toBe(0);
		expect((r.stdout ?? "").trim()).toBe("");
		expect(fs.existsSync(preludeMarker())).toBe(false);
		// An arm that lost the envelope silently would pass the line above.
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/the rule envelope did not render/,
		);

		const out = emission(bash(CREATE));
		expect(out.additionalContext).toContain("docs/agents/issue-tracker.md");
	});
});

describe("a command the table does not map is handed nothing", () => {
	it.each([
		["gh issue view 2493", "a body read"],
		[
			"gh issue view 2493 --json comments",
			"the comments read gh-cli-limits prescribes",
		],
		["gh run list --branch main", "the working run-list route"],
		["gh pr view 5 --json number", "a field list without the rollup"],
		["gh issue list --label kind:ticket", "a list"],
		["gh issue reopen 2493", "a subcommand with no row"],
		["gh pr create --title t", "a creation on the wrong resource"],
		["gh pr edit 5 --body x", "a body write on the wrong resource"],
		[
			"gh issue edit 2497 --title t",
			"a field-only edit, which engages no `gh issue edit` row",
		],
		[
			"gh issue edit 2497 --remove-assignee @me",
			"a release, which is not a claim",
		],
		[
			"gh api repos/o/r/issues/2497",
			"a plain issue read, which is not a dependency endpoint",
		],
		[
			"gh api --method POST repos/o/r/issues -f title=x",
			"the API spelling of a creation, deliberately out of this guard's table",
		],
		[
			"git commit -m 'gh issue create'",
			"the words inside another command's argument",
		],
		[
			"grep -rn 'gh issue create' scripts",
			"a search for the shape, which must not fire on itself",
		],
		/* mantahostels#2652. The latch is `issue-body-success-signal`'s only delivery, so a
		 * READ of the script spending it means the session's first real write
		 * goes unsaid. */
		[
			"grep -n foo scripts/issue-body.js",
			"a read of the script, which must not spend the write rule's one latch",
		],
		[
			"cat scripts/issue-body.js",
			"the same, with the script as the last word of the command",
		],
		[
			"node scripts/issue-body.js frobnicate 2592",
			"a word after the script that is not one of its subcommands",
		],
		[
			"node scripts/issue-body.js show 2592",
			"the script's own READ, which writes nothing and so has no success signal",
		],
	])("%s emits nothing — %s", (command) => {
		expect(emission(bash(command))).toBeNull();
	});

	it("a payload with no tool input at all is handed nothing", () => {
		expect(emission({ session_id: "test", tool_name: "Bash" })).toBeNull();
	});
});

describe("what it cannot resolve, it records and allows", () => {
	it("keeps only the standalone framing, and logs, when the payload carries no session", () => {
		// gp_begin's own fail-open (mantahostels#103 §6): without a session id there is no
		// latch key, so the FRAGMENT is dropped rather than repeated on every
		// call. gp_rule still emits a held prelude there (mantahostels#2369).
		const r = run({ tool_name: "Bash", tool_input: { command: CREATE } });
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.additionalContext).toContain("docs/agents/triage-labels.md");
		expect(out.additionalContext).toContain("docs/agents/issue-tracker.md");
		expect(out.additionalContext).not.toContain("takes:children");
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/no session_id in payload/,
		);
	});

	it("writes nothing at all on a gh call it was never going to judge", () => {
		// A guard gated on `.session_id` would record a fail-open on every Bash call
		// in the repo, burying the records that mean something.
		const r = run({
			tool_name: "Bash",
			tool_input: { command: "gh issue view 1" },
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.existsSync(failOpenLogPath(config, root))).toBe(false);
	});

	it("disarms itself, silently and on the record, without the parser", () => {
		// The one fault that stands the guard down entirely (mantahostels#103 §6).
		const at = fs.mkdtempSync(path.join(dir, "nolib-"));
		fs.mkdirSync(path.join(at, "lib"));
		fs.copyFileSync(GUARD, path.join(at, "guard-tracker-rules.sh"));
		// guard-log.sh reads the repo root through gr_root, which lives in
		// guard-root.sh since mantahostels#1905 — without it the fail-open record lands under
		// the wrong slug and this case tests nothing.
		for (const lib of ["guard-log.sh", "guard-root.sh"]) {
			fs.copyFileSync(
				path.resolve(__dirname, "lib", lib),
				path.join(at, "lib", lib),
			);
		}
		const r = spawnGuard(
			path.join(at, "guard-tracker-rules.sh"),
			bash(CREATE),
			{
				project: root,
				config,
				cwd: root,
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/guard-parse\.sh did not load/,
		);
	});

	/* The narrower fail-open (mantahostels#2652): guard-job-dir.sh alone is missing, so the
	 * guard still speaks — it just cannot tell a job-dir path from any other,
	 * and drops the one rule that turns on that test rather than firing it on
	 * every `gh` call. WFC_RULES_DIR is handed over because the copied guard
	 * cannot find the store from its own location. */
	it("drops the job-dir rule alone, on the record, without its predicate", () => {
		const at = fs.mkdtempSync(path.join(dir, "nojobdir-"));
		copyLibs(path.join(at, "lib"), sourcedLibs(GUARD), ["guard-job-dir.sh"]);
		fs.copyFileSync(GUARD, path.join(at, "guard-tracker-rules.sh"));
		const r = spawnGuard(
			path.join(at, "guard-tracker-rules.sh"),
			bash("gh issue comment 2592 --body-file $CLAUDE_JOB_DIR/tmp/b.md"),
			{
				project: root,
				config,
				cwd: root,
				env: {
					WFC_RULES_DIR: path.resolve(
						__dirname,
						"..",
						"docs",
						"agents",
						"rules",
					),
				},
			},
		);
		expect(r.status).toBe(0);
		// The comment rule still lands, so this is a dropped rule and not a
		// stood-down guard — the shape the whole-parser case above tests.
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBeUndefined();
		expect(idsIn(out.additionalContext as string)).toEqual([
			"citation-number-first",
		]);
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/guard-job-dir\.sh did not load/,
		);
	});

	it("drops the Blocked-comment rule alone, on the record, without gh-body.sh (#2309)", () => {
		const at = fs.mkdtempSync(path.join(dir, "nobody-"));
		copyLibs(path.join(at, "lib"), sourcedLibs(GUARD), ["gh-body.sh"]);
		fs.copyFileSync(GUARD, path.join(at, "guard-tracker-rules.sh"));
		const r = spawnGuard(
			path.join(at, "guard-tracker-rules.sh"),
			bash('gh issue comment 2592 --body "**Blocked** — waiting on #7."'),
			{
				project: root,
				config,
				cwd: root,
				env: {
					WFC_RULES_DIR: path.resolve(
						__dirname,
						"..",
						"docs",
						"agents",
						"rules",
					),
				},
			},
		);
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(idsIn(out.additionalContext as string)).toEqual([
			"citation-number-first",
		]);
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/gh-body\.sh did not load/,
		);
	});

	it("refuses the call when the fragment cannot be read, exiting 2 and naming the leading rule id", () => {
		// The one place this guard exits non-zero (mantahostels#1762): a rule that cannot be
		// stated is worth a refused tool call.
		const empty = fs.mkdtempSync(path.join(dir, "store-"));
		const r = run(bash(CREATE), { WFC_RULES_DIR: empty });
		expect(r.status).toBe(2);
		/* The id named is the FIRST ARGUMENT of the gp_rule call, not the first
		 * one this command matched: gp_rule resolves every id it is handed
		 * before the skips are applied, so a creation refuses on the id that
		 * leads the priority order (mantahostels#2592). */
		expect(r.stderr).toContain("gh-job-dir-unreadable");
	});
});

/*
 * THE REGISTRATION CARRIES NO `if` CLAUSE (mantahostels#2592), and nothing else pins that.
 * scripts/hook-registrations.test.ts pins the event and the matcher; `if` is
 * outside its table. Re-adding `if: Bash(gh *)` — the anchored form mantahostels#2127
 * settled, and the cheaper one — would leave the guard exec'd on `gh` calls
 * alone, and `rule:issue-body-success-signal` would then reach nobody: its
 * trigger is `node scripts/issue-body.js`, which is not a `gh` call.
 */
describe("the wiring reaches the non-`gh` shape", () => {
	it("registers guard-tracker-rules.sh with no `if` clause", () => {
		const settings = JSON.parse(
			fs.readFileSync(
				path.resolve(__dirname, "..", "self-plugin", "hooks", "hooks.json"),
				"utf8",
			),
		);
		const found = (settings.hooks?.PreToolUse ?? []).flatMap(
			(entry: { hooks?: Array<{ command?: string; if?: string }> }) =>
				(entry.hooks ?? []).filter((h) =>
					(h.command ?? "").includes("scripts/guard-tracker-rules.sh"),
				),
		);
		expect(found).toHaveLength(1);
		expect(found[0].if).toBeUndefined();
	});
});

describe("in a plugin install (#1010)", () => {
	it("names both tracker docs at the plugin root", () => {
		const core = path.join(dir, "core");
		fs.mkdirSync(path.join(core, "docs", "agents"), { recursive: true });
		for (const f of ["issue-tracker.md", "triage-labels.md"])
			fs.writeFileSync(path.join(core, "docs", "agents", f), "");
		const r = run(bash("gh issue close 1 --comment x", "sess-install"), {
			WFC_SCRIPT_ROOT: core,
			WFC_RULES_DIR: path.resolve(__dirname, "..", "docs", "agents", "rules"),
		});
		expect(r.status).toBe(0);
		const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
		expect(ctx).toContain(
			`${core}/docs/agents/issue-tracker.md and ${core}/docs/agents/triage-labels.md are their home`,
		);
	});
});
