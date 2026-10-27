// @vitest-environment node
/*
 * lib/tracker-rules.js, a PreToolUse dispatcher core (#2792), hands a session
 * a tracker rule at the `gh` call that engages it (mantahostels#2493,
 * mantahostels#2497; spec mantahostels#2457 §T3).
 *
 * THE TABLE IS ASSERTED SHAPE BY SHAPE. Each mapped `gh` form gets the exact id
 * set its TRIGGERS row names and nothing else, so a row that widens silently —
 * a `--body` matched anywhere on a `--add-assignee` command, say — fails here
 * rather than costing a session a rule it did not engage. A row that narrows
 * lets a session file, label or close an issue without the tracker rule it
 * engaged ever reaching it.
 *
 * It never denies, so every case asserts `permissionDecision` is ABSENT as
 * well as asserting the text.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * production ports (lib/tracker-rules-host.js), the real rule store and the
 * latch directory under the case's root. The hook line and stdin are
 * scripts/guard-dispatch.test.ts's boundary set.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCore } from "./guard-core-testkit";
/* The rule latch lives under the markers directory, not the throwaway root
 * itself. */
import { markersDir } from "./marker-root.js";
/* The store's Node accessor, so a test asks for the rule by id rather than
 * holding a second copy of its text. */
import { readRuleText } from "./rule-text.js";

const CORE = "guard-tracker-rules";
const STORE = path.resolve(__dirname, "..", "..", "docs", "agents", "rules");

let dir: string;
let root: string;
let logs: string[];

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "tracker-rules-")),
	);
	root = path.join(dir, "root");
	fs.mkdirSync(root);
	logs = [];
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

type Payload = Record<string, unknown>;

/** A Bash PreToolUse payload. */
const bash = (command: string, session = "test"): Payload => ({
	session_id: session,
	tool_name: "Bash",
	tool_input: { command },
});

/** The core's merged output for one payload; null where it said nothing. */
function emission(
	payload: Payload,
	{ cwd = root, env = {} }: { cwd?: string; env?: Record<string, string> } = {},
) {
	const r = runCore(CORE, payload, { root, cwd, env });
	logs.push(...r.logs);
	return r.output as Record<string, string>;
}

/* The kit's ceiling on one delivery. Restated rather than read out of the
 * kit, so moving it is a visible edit on both sides. */
const RULE_CAP = 4000;

const CREATE =
	'gh issue create --title "t" --body "b" --label takes:implement --label kind:ticket';

/*
 * THE TABLE, restated on this side rather than read out of the core: a test
 * that parsed TRIGGERS out of the shell would move with a mutation to it and
 * catch nothing. The order is the core's emission order, which is its priority
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
		'gh issue comment 2862 --body "**Refused attempt 12:** not quiet."',
		["blocked-ticket-gate", "citation-number-first"],
		"a comment opening **Refused attempt (#3111)",
	],
	[
		'gh issue comment 2862 --body "**Refused:** the relabel."',
		["citation-number-first"],
		"a **Refused comment that records no attempt",
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
	/* mantahostels#2592's three added routes. The issue-body.js one is the core's only
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
const idsIn = (ctx: string) =>
	fs
		.readdirSync(STORE)
		.filter((f) => f.endsWith(".txt"))
		.map((f) => f.replace(/\.txt$/, ""))
		.map((id) => [id, ctx.indexOf(readRuleText(id))] as const)
		.filter(([, at]) => at >= 0)
		.sort((a, b) => a[1] - b[1])
		.map(([id]) => id);

describe("each mapped shape is handed its row's rules, and refused nothing", () => {
	it.each(MAPPED)("%s — %s", (command, ids) => {
		const out = emission(bash(command));
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(idsIn(out.additionalContext)).toEqual(ids);
	});

	it.each([
		[
			"cd /repo && gh issue create --title t",
			"a creation behind a cd, which an anchored `if` would not reach",
		],
		[
			"/usr/bin/gh issue create --title t",
			"a path-spelled gh, which the basename test catches and an anchored `if` would not",
		],
		["gh issue create --title t | tee out.txt", "a creation piped somewhere"],
	])("%s is handed the creation rules — %s", (command) => {
		const out = emission(bash(command));
		expect(idsIn(out.additionalContext)).toContain("create-command-shape");
	});

	it("hands a gh call run from inside a job tree the job-dir rule only where a word is a path there (#1731)", () => {
		const job = path.join(dir, ".claude", "jobs", "abc");
		fs.mkdirSync(job, { recursive: true });
		const idsFrom = (command: string, session: string) =>
			idsIn(
				emission(bash(command, session), {
					cwd: job,
					env: { CLAUDE_JOB_DIR: job },
				}).additionalContext,
			);
		expect(idsFrom("gh issue comment 2592 --body x", "bare")).toEqual([
			"citation-number-first",
		]);
		expect(
			idsFrom("gh issue comment 2592 --body-file tmp/b.md", "path"),
		).toContain("gh-job-dir-unreadable");
		expect(logs).toEqual([]);
	});

	it("hands a `waiting:` edit its vocabulary and the role table in one envelope, and nothing on the next label edit (#2023)", () => {
		// One envelope only while the two fragments together fit RULE_CAP;
		// grow either past it and the role table defers to the next edit.
		const edit = bash("gh issue edit 2497 --remove-label=waiting:external");
		const first = emission(edit);
		expect(first.permissionDecision).toBeUndefined();
		expect(idsIn(first.additionalContext)).toEqual([
			"waiting-external-vocabulary",
			"triage-role-labels",
		]);
		expect(emission(edit)).toBeNull();
	});

	it("fits `urgent` and the `waiting:` vocabulary in one envelope when one edit names both (#2023)", () => {
		const edit = bash("gh issue edit 2497 --add-label urgent,waiting:external");
		expect(idsIn(emission(edit).additionalContext)).toEqual([
			"urgent-label",
			"waiting-external-vocabulary",
		]);
	});

	it("frames the rules by naming where they are authored", () => {
		const ctx = emission(bash(CREATE)).additionalContext;
		expect(ctx).toContain("docs/agents/issue-tracker.md");
		expect(ctx).toContain("the vendored defaults are not this repo's");
	});

	it("emits in priority order, so a truncated delivery keeps the costliest rule", () => {
		// The create row is the only one carrying more than two ids, and
		// `create-command-shape` leads it because its breach hides the body from
		// the `takes:human` and blank-body checks.
		const ids = idsIn(emission(bash(CREATE)).additionalContext);
		expect(ids[0]).toBe("create-command-shape");
	});

	it("spends little of the cap on the widest row, so a later id still fits", () => {
		// RULE_CAP is BYTES, and the fragments are multibyte.
		const ctx = emission(bash(CREATE)).additionalContext;
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(RULE_CAP);
	});
});

/*
 * MUTATION ANCHORS. `idsIn` above reads the same files the core does, so it
 * moves with a mutation to a fragment instead of catching it: cut a row and
 * both sides lose it together.
 *
 * Whitespace is collapsed because a fragment is authored markdown — a table
 * row, a wrapped sentence — so pinning column widths and line breaks would
 * refuse a re-wrap that changed nothing a reader acts on.
 */
const carries = (id: string, clause: string) =>
	expect(readRuleText(id).replace(/\s+/g, " ")).toContain(clause);

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
		["urgent-label", "holds until the issue closes"],
		["triage-role-labels", "Create none of"],
		["waiting-external-vocabulary", "The value set is closed at one value"],
	])("%s keeps %s", (id, clause) => carries(id, clause));
});

/*
 * THE SUBCOMMAND LIST IS A SECOND COPY of scripts/issue-body.js's own less
 * `show`, and nothing else pins them together: a subcommand added there and
 * not here drops silently out of the limb. Read out of the USAGE block rather
 * than restated, and asserted on what the core DOES with each.
 */
describe("the issue-body.js limb knows every subcommand the script has", () => {
	const script = fs.readFileSync(
		path.resolve(__dirname, "..", "issue-body.js"),
		"utf8",
	);
	const usage = script.match(/const USAGE = `([\s\S]*?)`;/);
	if (!usage) throw new Error("no USAGE block in scripts/issue-body.js");
	const declared = usage[1]
		.split("\n")
		.map((l) => l.match(/^ {2}([a-z][a-z-]*) +<issue>/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => m[1]);

	it("tells a run of each writing subcommand, and not `show`", () => {
		expect(declared.length).toBeGreaterThan(4);
		/* `show` writes nothing, so the `written and verified` signal the rule
		 * is about never appears in its output and it engages no rule. */
		const told = declared.filter((sub) => {
			const out = emission(
				bash(`node scripts/issue-body.js ${sub} 1`, `sess-${sub}`),
			);
			return (
				out !== null &&
				idsIn(out.additionalContext).includes("issue-body-success-signal")
			);
		});
		expect(told.sort()).toEqual(declared.filter((s) => s !== "show").sort());
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
		expect(idsIn(out.additionalContext)).toEqual([
			"close-outstanding-line",
			"ticket-criteria-unticked",
		]);
	});

	it("a subagent under a session already told is told too", () => {
		// A dispatched subagent's payload carries its PARENT's session_id and is
		// told apart only by agent_id (mantahostels#1804). Keyed on the session
		// alone, the subagent would inherit the parent's latch and never meet
		// the rule.
		expect(emission(bash(CREATE, "sess-C"))).not.toBeNull();
		expect(
			emission({ ...bash(CREATE, "sess-C"), agent_id: "sub-1" }),
		).not.toBeNull();
	});
});

/*
 * The prelude carries its own latch (mantahostels#2275), marked by the kit
 * once the envelope is out (mantahostels#2528). Marked by the core, it would
 * be marked before the emission, so an arm that loses the prelude would still
 * mark the session told.
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

	it("leaves it unmarked where the envelope will not render, so the framing is still owed", () => {
		vi.stubEnv("WFC_RULES_DIR", fs.mkdtempSync(path.join(dir, "store-")));
		expect(emission(bash(CREATE)).permissionDecision).toBe("deny");
		expect(fs.existsSync(preludeMarker())).toBe(false);
		vi.unstubAllEnvs();
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
			"the API spelling of a creation, deliberately out of this core's table",
		],
		[
			"git commit -m 'gh issue create'",
			"the words inside another command's argument",
		],
		[
			"grep -rn 'gh issue create' scripts",
			"a search for the shape, which must not fire on itself",
		],
		/* mantahostels#2652. The latch is `issue-body-success-signal`'s only
		 * delivery, so a READ of the script spending it means the session's
		 * first real write goes unsaid. */
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
		// Without a session id there is no latch key, so the FRAGMENT is dropped
		// rather than repeated on every call (mantahostels#103 §6). The held
		// prelude is still emitted (mantahostels#2369).
		const out = emission({
			tool_name: "Bash",
			tool_input: { command: CREATE },
		});
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain("docs/agents/triage-labels.md");
		expect(out.additionalContext).toContain("docs/agents/issue-tracker.md");
		expect(out.additionalContext).not.toContain("takes:children");
		expect(logs.join("\n")).toMatch(/no session_id in payload/);
	});

	it("writes nothing at all on a gh call it was never going to judge", () => {
		// A core gated on `.session_id` would record a fail-open on every Bash
		// call in the repo, burying the records that mean something.
		const out = emission({
			tool_name: "Bash",
			tool_input: { command: "gh issue view 1" },
		});
		expect(out).toBeNull();
		expect(logs).toEqual([]);
	});

	it("refuses the call when the fragment cannot be read, naming the leading rule id", () => {
		// The one place this core refuses (mantahostels#1762): a rule that
		// cannot be stated is worth a refused tool call, whatever the row's
		// failure policy.
		vi.stubEnv("WFC_RULES_DIR", fs.mkdtempSync(path.join(dir, "store-")));
		const out = emission(bash(CREATE));
		expect(out.permissionDecision).toBe("deny");
		/* The id named is the FIRST of the injectRules array, not the first one
		 * this command matched: every id is resolved before the skips are
		 * applied, so a creation refuses on the id that leads the priority
		 * order (mantahostels#2592). */
		expect(out.permissionDecisionReason).toContain("gh-job-dir-unreadable");
		expect(out.permissionDecisionReason).toMatch(/^guard-tracker-rules: /);
	});
});

/*
 * THE ROW JUDGES EVERY BASH CALL (mantahostels#2592), and nothing else pins
 * that. A row narrowed to `gh` calls would leave
 * `rule:issue-body-success-signal` reaching nobody: its trigger is `node
 * scripts/issue-body.js`, which is not a `gh` call.
 */
describe("the wiring reaches the non-`gh` shape", () => {
	it("registers guard-tracker-rules on every Bash call", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(__dirname, "guard-cores.json"), "utf8"),
		);
		const rows = Object.values(manifest)
			.flat()
			.filter((r) => (r as { name?: string }).name === CORE);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ core: "tracker-rules.js", tools: "Bash" });
		expect(rows[0]).not.toHaveProperty("if");
		expect(
			idsIn(
				emission(bash("node scripts/issue-body.js tick 1")).additionalContext,
			),
		).toEqual(["issue-body-success-signal"]);
	});
});

describe("in a plugin install (#1010)", () => {
	it("names both tracker docs at the plugin root", () => {
		const core = path.join(dir, "core");
		fs.mkdirSync(path.join(core, "docs", "agents"), { recursive: true });
		for (const f of ["issue-tracker.md", "triage-labels.md"])
			fs.writeFileSync(path.join(core, "docs", "agents", f), "");
		vi.stubEnv("WFC_SCRIPT_ROOT", core);
		vi.stubEnv("WFC_RULES_DIR", STORE);
		const ctx = emission(
			bash("gh issue close 1 --comment x", "sess-install"),
		).additionalContext;
		expect(ctx).toContain(
			`${core}/docs/agents/issue-tracker.md and ${core}/docs/agents/triage-labels.md are their home`,
		);
	});
});

/*
 * THE CASES A MUTANT MUST NOT SURVIVE (#2792, §X8 (4)). Each pins one arm of a
 * predicate that the bash suite's shapes left free to drift; the commit
 * message names the mutants they kill.
 */
describe("the cases a mutant must not survive (#2792)", () => {
	const ids = (command: string, opts?: Parameters<typeof emission>[1]) => {
		const out = emission(bash(command), opts);
		return out === null ? [] : idsIn(out.additionalContext);
	};

	it.each([
		["gh run list -c abc", "gh's short spelling of --commit"],
		["gh issue view 2493 -c", "gh's short spelling of --comments"],
	])("%s is told the CLI limits — %s", (command) => {
		expect(ids(command)).toEqual(["gh-cli-limits"]);
	});

	it.each([
		[
			"gh run list -c=abc",
			"a short flag's `=`-joined form, which only a long flag has",
		],
		["gh issue edit 2497 --bodyx y", "a flag that merely starts like --body"],
		[
			"gh api repos/o/r/issues/2497/sub_issue_priority",
			"an endpoint that merely starts like /sub_issue",
		],
		[
			'gh pr view 5 --json status"Check"Rollup',
			"a field list whose raw text never spells the rollup",
		],
		[
			"gh pr create --title issue",
			"the row's words present but not in place after gh",
		],
		[
			"node scripts/issue-body.js.bak tick 1",
			"a script whose name only contains issue-body.js",
		],
		[
			'node "scripts/issue-body.js" tick 1',
			"a quoted script word, which the masked gate never sees (mantahostels#2652)",
		],
	])("%s emits nothing — %s", (command) => {
		expect(emission(bash(command))).toBeNull();
	});

	it("reads the singular sub-issue endpoint with a query string", () => {
		expect(ids("gh api repos/o/r/issues/2497/sub_issue?x=1")).toEqual([
			"dependency-edge-false-success",
		]);
	});

	it("reads a `waiting:` value only as a prefix, never inside a label", () => {
		expect(ids("gh issue edit 2497 --add-label awaiting-review")).toEqual([
			"triage-role-labels",
		]);
	});

	it("hands a pull request's `waiting:` edit its vocabulary", () => {
		expect(ids("gh pr edit 5 --add-label waiting:external")).toEqual([
			"waiting-external-vocabulary",
			"triage-role-labels",
		]);
	});

	it.each([
		['gh issue comment 1 --body "  **Blocked** on #7"', "after leading space"],
		['gh issue comment 1 -b "**Blocked** on #7"', "under gh's short -b"],
	])("reads a comment opening **Blocked %s", (command) => {
		expect(ids(command)).toEqual([
			"blocked-ticket-gate",
			"citation-number-first",
		]);
	});

	it("does not call a body Blocked where part of it cannot be read", () => {
		expect(
			ids('gh issue comment 1 --body "**Blocked** on #7" --body "$(date)"'),
		).toEqual(["citation-number-first"]);
	});

	it("reads a body file under `~` through the command's HOME", () => {
		fs.writeFileSync(path.join(dir, "b.md"), "**Blocked** on #7\n");
		expect(
			ids("gh issue comment 1 --body-file ~/b.md", { env: { HOME: dir } }),
		).toEqual(["blocked-ticket-gate", "citation-number-first"]);
	});

	it("logs a body file it cannot read, and judges the rest of the call", () => {
		fs.mkdirSync(path.join(dir, "b.md"));
		expect(
			ids(`gh issue comment 1 --body-file ${path.join(dir, "b.md")}`),
		).toEqual(["citation-number-first"]);
		expect(logs).toContain(
			"could not read the body file of a gh issue comment — rule:blocked-ticket-gate not judged",
		);
	});

	it("reads a job directory named only by CLAUDE_JOB_DIR, not by its shape", () => {
		const job = path.join(dir, "plain", "job");
		expect(
			ids(`gh issue comment 1 --body-file ${job}/b.md`, {
				env: { CLAUDE_JOB_DIR: job },
			}),
		).toEqual(["gh-job-dir-unreadable", "citation-number-first"]);
	});
});
