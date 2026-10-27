/*
 * tracker-rules.js — the dispatcher core that hands a session a tracker rule
 * at the call that engages it, rather than pointing the session at a document
 * (mantahostels#2493, spec mantahostels#2457 §T3). Its one production port of
 * its own, a body file's text, is lib/tracker-rules-host.js.
 *
 * EIGHTEEN RULES, OVER TWENTY-TWO `gh` TABLE ROWS AND ONE NON-`gh` LIMB
 * (mantahostels#2497, mantahostels#2592, mantahostels#2652, #2023). The
 * vendored skills carry a tracker vocabulary this repo does not use, and
 * scripts/inject-tracker-docs.sh can only say so and point at the document —
 * which the session reads, or does not, long before it types the call.
 *
 * THE NON-`gh` LIMB IS WHY THE ROW JUDGES EVERY BASH CALL (mantahostels#2592).
 * The `written and verified` success signal binds at `node
 * scripts/issue-body.js`, the command this repo prescribes IN PLACE OF the raw
 * `gh` write, so the rule about reading its output can only be routed on a
 * shape that is not a `gh` call at all. The core therefore runs on every Bash
 * call and returns on each command it does not know.
 *
 * WHAT IS NOT ROUTED HERE, deliberately: the background-every-`gh`-call rule,
 * which binds BEFORE the first tool call and so cannot be delivered by a hook
 * on that call. It stays pasted, in scripts/inject-tracker-docs.sh.
 *
 * INJECTION ONLY — it never denies. The tracker guards that DO deny are
 * guard-issue-create-label.js, guard-issue-close.js, guard-issue-body.js and
 * guard-issue-phase-scope.js.
 *
 * IMPLICIT: on an allowed call it injects the rules as additionalContext and
 *   writes a `.rule-injected-*` latch under .claude/tmp/markers.
 * JUSTIFIED: fail-safe — it adds no refusal.
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rule is said
 *   again; `disabled` naming guard-tracker-rules in .claude/workflow-core.json
 *   silences it.
 *
 * LIMITS
 *  - THE MAPPING IS A TABLE, never inferred — TRIGGERS below. A `gh` shape
 *    with no row emits nothing, silently.
 *  - It matches the PARSED command form — a command whose command word is
 *    `gh`, followed by the row's own subcommand words — so a grep, an echo or
 *    a heredoc mentioning those words emits nothing.
 *  - THE issue-body.js LIMB IS THE ONE EXCEPTION TO THAT COMMAND-WORD TEST,
 *    and it reads a WORD instead: any word whose basename is `issue-body.js`,
 *    wherever it sits, PROVIDED THE NEXT WORD IS ONE OF THE SCRIPT'S WRITING
 *    SUBCOMMANDS (mantahostels#2652). That reaches `node
 *    scripts/issue-body.js`, `./scripts/issue-body.js` and a wrapper alike,
 *    while leaving both kinds of read to spend nothing: a read of the FILE —
 *    `grep -n foo scripts/issue-body.js` — and the script's own `show`, which
 *    writes nothing. The latch is that rule's only delivery, so a read
 *    spending it means the session's first real write goes unsaid. What still
 *    costs a latched injection and nothing else: an UNQUOTED mention where the
 *    script is its own word and a writing subcommand is the next one — `echo
 *    node scripts/issue-body.js tick 12`. A QUOTED body does NOT: the parser
 *    MASKS a quoted span, and the limb is gated on the masked word
 *    (mantahostels#2652).
 *  - THE JOB-DIR LIMB reads every word of the WHOLE COMMAND, not just the `gh`
 *    command's, and not just a `--body-file` value — so `-F body=@<path>`,
 *    `--input <path>` and the PIPED spelling the rule fragment itself names
 *    (`cat <job-dir file> | gh issue comment <n> --body-file -`, whose path
 *    sits in the `cat` command) are all covered without enumerating flags or
 *    commands (mantahostels#2652). The cost is an injection on a body that
 *    merely QUOTES such a path, plus its command-wide widening: an unrelated
 *    `gh` call sharing a command string with a job-dir path anywhere is told
 *    the rule too.
 *  - THE OTHER SPELLINGS OF A CREATION ARE OUT OF SCOPE HERE. `gh api --method
 *    POST …/issues` and a `gh api graphql` `createIssue` mutation are both
 *    chased by guard-issue-create-label.js (mantahostels#511, mantahostels#519)
 *    and are not chased here, where each would be a row in TRIGGERS.
 *  - SO ARE THE OTHER SPELLINGS OF A LABEL EDIT (#2023): `gh api …/labels`, a
 *    label set at creation, and scripts/park-blocked.sh's own
 *    `waiting:external` write. Only `gh issue edit` and `gh pr edit` label
 *    flags are read.
 *  - The rule is stated ONCE PER SESSION PER ID, by the kit's latch, keyed on
 *    the agent as well as the session so a subagent is told on its own
 *    account.
 *  - It FAILS OPEN on anything it cannot resolve, logged (mantahostels#147),
 *    as its row's `open` policy has it. The one exception is the kit's store
 *    side, which refuses on a fragment it cannot read (mantahostels#1762).
 *  - It guards the Bash tool, so a creation from a script, from a workflow or
 *    from the GitHub web UI sees no hook at all.
 */

const { SPACE, bodyFileWord, bodyWord, newBody } = require("./gh-body.js");
const { NOT_READY_OPENING } = require("./prose-blockers.js");
const { isJobDir } = require("./job-dir.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { isGhCommand, literal, scanFlags } = require("./shell-words.js");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext & {
 *   readFile: (path: string) => string | undefined,
 * }} TrackerContext `readFile` is a body file's text, undefined where it is
 *   absent; it throws where the file cannot be read
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {{ parsed: Parsed, ctx: TrackerContext, jobDirSeen: boolean,
 *   cmd: Command }} Call what a predicate reads beyond the words after `gh`
 * @typedef {(words: string[], call: Call) => boolean} Predicate
 */

/* The prelude's own latch key, in ctx.told's `warn.<id>` namespace. One
 * prelude serves every row, so it is keyed on a name of its own rather than on
 * any one rule's id. */
const PRELUDE_LATCH = "tracker-rules-prelude";

/* The framing sentence (mantahostels#2369). IT STANDS ALONE, never ending in a
 * colon: the kit emits a prelude on its own where the fragments are dropped. */
const PRELUDE =
	"This call engages tracker rules THIS repo authors and the vendored skills do not carry — docs/agents/issue-tracker.md and docs/agents/triage-labels.md are their home, and the vendored defaults are not this repo's.";

/* The script's WRITING subcommands, its USAGE block's list less `show`
 * (mantahostels#2652). The limb reads the word AFTER the script to tell a run
 * from a read, and `show` is a read: it writes nothing, so the `written and
 * verified` signal the rule is about never appears in its output.
 * lib/tracker-rules.test.ts pins this against that USAGE block, so a
 * subcommand added there and not here fails rather than dropping out. */
const ISSUE_BODY_SUBCOMMANDS = new Set([
	"append",
	"append-section",
	"append-decision",
	"delete-lines",
	"tick",
	"annotate",
	"replace",
]);

/** A word's text with its quoted spans put back, read on where it is unknown.
 * @param {string | undefined} word
 * @param {string[]} spans */
const lit = (word, spans) => literal(word ?? "", spans).text;

/** A command word's name: the text after its last `/`.
 * @param {string} p */
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

// --- the flag predicates a TRIGGERS row may name -----------------------------
//
// Each takes the raw words after `gh` and answers whether the row applies. A
// row naming null runs none and matches on the subcommand alone.

/** Whether any word is one of `flags`, a long one's `=`-joined form included.
 * @param {string[]} words
 * @param {string[]} flags */
const hasFlag = (words, flags) =>
	words.some((w) =>
		flags.some((f) => w === f || (f.startsWith("--") && w.startsWith(`${f}=`))),
	);

/* A `gh issue edit` that writes the body whole — the long flags, each
 * `=`-joined form, and gh's own short spellings `-b`/`-F`. guard-issue-body.js
 * DENIES every one of those (mantahostels#132). */
const BODY_FLAGS = ["--body", "--body-file", "-b", "-F"];
/** @type {Predicate} */
const writesBody = (words) =>
	words.some((w) => BODY_FLAGS.some((f) => w === f || w.startsWith(`${f}=`)));

/* A `gh issue edit` that takes the issue. `--add-assignee` only:
 * `--remove-assignee` is a release and engages no claim rule. */
/** @type {Predicate} */
const addsAssignee = (words) => hasFlag(words, ["--add-assignee"]);

/* A `gh api` call on an issue's native dependency or sub-issue endpoint. The
 * path is one word, so the test is on the word rather than on the whole
 * command: an endpoint mentioned inside a `--jq` filter or a `-f` field is not
 * a call to it.
 *
 * THE QUERY STRING IS WHY THE ARMS ARE UNANCHORED. The read the fragment tells
 * a session to make is the PAGED one — `…/sub_issues?per_page=100`, the
 * default being 30 — so an arm anchored at the end of the word would miss
 * exactly the call this rule exists for. `/sub_issue` matches the singular
 * DELETE re-root spelling, and `blocking` the other side of the edge. */
const DEPENDENCY_ENDPOINT =
	/\/dependencies\/blocked_by|\/dependencies\/blocking|\/sub_issue$|\/sub_issue\?|\/sub_issues/s;
/** @type {Predicate} */
const dependencyEndpoint = (words) =>
	words.some((w) => DEPENDENCY_ENDPOINT.test(w));

/* A `gh` call sharing its command string with a path under the background
 * job's scratch tree. `gh` reads one fine — the real risk is `$CLAUDE_JOB_DIR`
 * failing to resolve at all (mantahostels#2088), which breaks the path before
 * `gh`, or any tool, ever opens it. The answer is taken command-wide by
 * scanJobDir below, and this predicate only reports it (mantahostels#2652). */
/** @type {Predicate} */
const jobDirPath = (_words, { jobDirSeen }) => jobDirSeen;

/* A `gh issue comment` whose body opens as lib/prose-blockers.js's
 * NOT_READY_OPENING matches. The body is read through lib/gh-body.js, in the
 * spellings record-acts.js reads; one it cannot read matches nothing, a file
 * fault logged. */
/** @type {Predicate} */
const opensNotReady = (words, { parsed, ctx, cmd }) => {
	const body = newBody();
	const env = {
		spans: parsed.spans,
		subject: parsed.subject,
		subcmd: `issue${SPACE}+comment`,
		what: "gh issue comment",
		cwd: cmd.cwd,
		home: ctx.vars.HOME ?? "",
		readFile: ctx.readFile,
	};
	scanFlags(
		"-b --body -F --body-file -R --repo",
		words.slice(2),
		(kind, name, value) => {
			if (kind !== "opt") return;
			if (name === "-b" || name === "--body")
				bodyWord(body, value, parsed.spans);
			else if (name === "-F" || name === "--body-file")
				bodyFileWord(body, value, env);
		},
	);
	if (body.fault)
		ctx.log(`${body.fault} — rule:blocked-ticket-gate not judged`);
	if (!body.given || body.hidden) return false;
	return NOT_READY_OPENING.test(body.text);
};

/* A `gh` call that reads check runs, which the token cannot
 * (rule:gh-cli-limits): a `--json` field list naming `statusCheckRollup`, or
 * the REST check-runs endpoint. On the word, as dependencyEndpoint is — but
 * unquoted first, since a field list is often quoted and the parser masks a
 * quoted span. */
const CHECK_RUNS = /statusCheckRollup|\/check-runs/;
/** @type {Predicate} */
const readsCheckRuns = (words, { parsed }) =>
	CHECK_RUNS.test(parsed.subject) &&
	words.some((w) => CHECK_RUNS.test(lit(w, parsed.spans)));

/* `gh run list` filtered by commit. `-c` is gh's own short spelling of
 * `--commit`. */
/** @type {Predicate} */
const namesCommit = (words) => hasFlag(words, ["--commit", "-c"]);

/* `gh issue view --comments`. Whether the issue has comments is unknowable
 * before the call, so every such read is told. `-c` is gh's own short
 * spelling of `--comments`. */
/** @type {Predicate} */
const readsComments = (words) => hasFlag(words, ["--comments", "-c"]);

/**
 * Every label a `gh issue edit` or `gh pr edit` adds or removes: each
 * `--add-label`/`--remove-label` value, joined or not, split on gh's own
 * comma, trailing empties dropped as label_values' command substitution
 * dropped its trailing newlines. Unquoted first, so `--add-label "a,urgent"`
 * yields both.
 * @param {string[]} words
 * @param {string[]} spans
 */
function labelEdits(words, spans) {
	/** @type {string[]} */
	const out = [];
	words.forEach((raw, i) => {
		const w = lit(raw, spans);
		let v;
		if (w.startsWith("--add-label=") || w.startsWith("--remove-label="))
			v = w.slice(w.indexOf("=") + 1);
		else if (w === "--add-label" || w === "--remove-label")
			v = lit(words[i + 1], spans);
		else return;
		out.push(v.replaceAll(",", "\n"));
	});
	const text = out.join("\n").replace(/\n+$/, "");
	return text === "" ? [] : text.split("\n");
}

/* A label edit at all — the role table binds on every one. */
/** @type {Predicate} */
const editsLabels = (words, { parsed }) =>
	labelEdits(words, parsed.spans).length > 0;

/* A label edit naming `urgent`, or any `waiting:` value. */
/** @type {Predicate} */
const labelsUrgent = (words, { parsed }) =>
	labelEdits(words, parsed.spans).includes("urgent");
/** @type {Predicate} */
const labelsWaiting = (words, { parsed }) =>
	labelEdits(words, parsed.spans).some((l) => l.startsWith("waiting:"));

// --- THE TABLE ---------------------------------------------------------------
//
// `[<subcommand words>, <predicate or null>, <the ids the shape engages>]`. A
// row's id order has no effect — the emission order is decide's injectRules
// array. Adding a rule adds a row here, an anchored region and a TRIGGERS
// entry in scripts/generate-rule-fragments.js, a needle in
// scripts/guard-fire-needles.json, and its id in that array, which carries the
// priority order.
//
// THE SUBCOMMAND WORDS ARE MATCHED WHOLE, word for word, against the raw words
// following `gh`. `api` is one word; `issue create` is two; an empty list
// matches every `gh` call.

/** @type {[string[], Predicate | null, string[]][]} */
const TRIGGERS = [
	[
		["issue", "create"],
		null,
		[
			"create-command-shape",
			"takes-value-vocabulary",
			"issue-parent-unplaced",
			"issue-created-assigned",
			"citation-inferred-number",
		],
	],
	[
		["issue", "close"],
		null,
		["close-outstanding-line", "ticket-criteria-unticked"],
	],
	[["issue", "edit"], writesBody, ["issue-body-raw-write"]],
	[["issue", "edit"], addsAssignee, ["issue-claim-scope"]],
	[["issue", "comment"], null, ["citation-number-first"]],
	[["issue", "comment"], opensNotReady, ["blocked-ticket-gate"]],
	[["api"], dependencyEndpoint, ["dependency-edge-false-success"]],
	[["issue", "comment"], jobDirPath, ["gh-job-dir-unreadable"]],
	[["issue", "create"], jobDirPath, ["gh-job-dir-unreadable"]],
	[["api"], jobDirPath, ["gh-job-dir-unreadable"]],
	/* The two remaining writes that take a body (mantahostels#2652). `gh issue
	 * close <n> --comment "$(cat <p>)"` is the documented resolution route, so
	 * its silent no-op loses the comment a close is refused without. */
	[["issue", "edit"], jobDirPath, ["gh-job-dir-unreadable"]],
	[["issue", "close"], jobDirPath, ["gh-job-dir-unreadable"]],
	/* The reads this machine's token or gh version gets wrong (#2023). */
	[["pr", "checks"], null, ["gh-cli-limits"]],
	[[], readsCheckRuns, ["gh-cli-limits"]],
	[["run", "list"], namesCommit, ["gh-cli-limits"]],
	[["issue", "view"], readsComments, ["gh-cli-limits"]],
	[["issue", "edit"], editsLabels, ["triage-role-labels"]],
	[["issue", "edit"], labelsUrgent, ["urgent-label"]],
	[["issue", "edit"], labelsWaiting, ["waiting-external-vocabulary"]],
	[["pr", "edit"], editsLabels, ["triage-role-labels"]],
	[["pr", "edit"], labelsUrgent, ["urgent-label"]],
	[["pr", "edit"], labelsWaiting, ["waiting-external-vocabulary"]],
];

/**
 * Whether ANY command of this call names a job-dir path, answered before the
 * table walk so jobDirPath can report it on the `gh` command
 * (mantahostels#2652). GATED ON THE RAW SUBJECT CONTAINING `gh` AT ALL: every
 * job-dir row is a `gh` subcommand, so a command with no `gh` in its text can
 * match none of them. A bare substring, not a word test: the subject is raw
 * text, quoting and all.
 * @param {Parsed} parsed
 * @param {TrackerContext} ctx
 */
function scanJobDir(parsed, ctx) {
	if (!parsed.subject.includes("gh")) return false;
	const where = { pwd: ctx.fallbackCwd, jobDir: ctx.env.CLAUDE_JOB_DIR ?? "" };
	let seen = false;
	walkCommands(
		parsed,
		({ words }) => {
			seen ||= words.some((w) => {
				const text = lit(w, parsed.spans);
				return text !== "" && isJobDir(text, where);
			});
		},
		ctx,
	);
	return seen;
}

/**
 * The ids one command engages, added to `matched`.
 * @param {Command} cmd
 * @param {Set<string>} matched
 * @param {Omit<Call, "cmd">} call
 */
function judge(cmd, matched, call) {
	const { spans } = call.parsed;
	/* The non-`gh` limb, judged first because it reads WORDS rather than a
	 * command word: `node scripts/issue-body.js tick 12 --match "…"` has `node`
	 * at its head, and `./scripts/issue-body.js` has the script itself. Gated
	 * on the MASKED word, so a quoted mention never reaches it. THE WORD AFTER
	 * IT DECIDES (mantahostels#2652): a writing subcommand is what a RUN of the
	 * script always has and a read of it almost never does. */
	const runsIssueBody = cmd.words.some(
		(w, i) =>
			w.includes("issue-body.js") &&
			basename(lit(w, spans)) === "issue-body.js" &&
			ISSUE_BODY_SUBCOMMANDS.has(lit(cmd.words[i + 1], spans)),
	);
	if (runsIssueBody) matched.add("issue-body-success-signal");
	const [head = "", ...words] = cmd.words;
	if (!isGhCommand(head)) return;
	for (const [subcmd, pred, ids] of TRIGGERS) {
		if (!subcmd.every((s, i) => words[i] === s)) continue;
		if (pred && !pred(words, { ...call, cmd })) continue;
		for (const id of ids) matched.add(id);
	}
}

/**
 * @param {string} command
 * @param {TrackerContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	const call = { parsed, ctx, jobDirSeen: scanJobDir(parsed, ctx) };
	/** @type {Set<string>} */
	const matched = new Set();
	walkCommands(parsed, (cmd) => judge(cmd, matched, call), ctx);
	if (matched.size === 0) return null;
	/* The prelude is latched apart from any id (mantahostels#2275), and marked
	 * only once the envelope is out (mantahostels#2528). */
	const framing = ctx.told(PRELUDE_LATCH)
		? {}
		: { prelude: ctx.corePaths(PRELUDE), latchAfter: PRELUDE_LATCH };
	/* THE IDS ARE NAMED LITERALLY, highest priority first, so a deferral under
	 * the cap keeps the costliest breach: lib/rule-emission.js reads them here.
	 * Every one is resolved, so a fragment the store cannot give refuses on
	 * the id leading this order (mantahostels#2592); `skip` takes out each the
	 * table did not match (mantahostels#1805). */
	const decision = {
		injectRules: [
			"gh-job-dir-unreadable",
			"issue-body-success-signal",
			"gh-cli-limits",
			"urgent-label",
			"waiting-external-vocabulary",
			"triage-role-labels",
			"create-command-shape",
			"takes-value-vocabulary",
			"issue-parent-unplaced",
			"issue-created-assigned",
			"close-outstanding-line",
			"ticket-criteria-unticked",
			"issue-body-raw-write",
			"issue-claim-scope",
			"dependency-edge-false-success",
			"blocked-ticket-gate",
			"citation-number-first",
			"citation-inferred-number",
		],
		...framing,
	};
	return {
		...decision,
		skip: decision.injectRules.filter((id) => !matched.has(id)),
	};
}

module.exports = { field: "command", noun: "command", decide };
