/*
 * issue-create-label.js — the guard-issue-create-label core (#2796,
 * programme #2733, #3225): does an issue a Bash call creates carry a `takes:` label
 * from the seven, and does a `takes:human` one name its outside act and what
 * closes it?
 *
 * A CORE: it does no I/O. The rule store, the script paths, a body file on
 * disk and gh arrive as ports; lib/issue-create-label-host.js builds the real
 * ones.
 *
 * THE FIRST VERDICT ENDS THE CALL. A deny stops the walk, and so does a
 * fail-open, which is logged and lets the whole call through unjudged. A
 * warn is held until the walk ends, in case a later segment denies.
 *
 * Why: `takes:` is the label naming the command that opens an issue, and
 * every open issue must carry exactly one. The core reads the COMMAND, never
 * the call's output: a backgrounded call's output is the harness's job stub
 * (mantahostels#453).
 *
 * mantahostels#136 rejected a label deny as "not always knowable at creation"
 * — true of `wayfinder:*` and `kind:`, never of `takes:`, where
 * `takes:triage` always fits. It stands, and does not cover this axis
 * (mantahostels#470).
 *
 * The value is validated too: a misspelt value aborts a flag-form create at
 * exit 0, and on the REST route files a label nothing reads.
 *
 * DENY, not warn (mantahostels#103): a label's presence and value are read
 * off the command.
 *
 * LIMITS
 *  - It matches the parsed command form — a segment whose command word is
 *    `gh`, subcommand pair `issue create` — never a substring, so a grep, an
 *    echo or a heredoc mentioning `gh issue create` passes. So does a wrapped
 *    call — `timeout N gh …`, `env gh …` — whose command word is not `gh`.
 *  - `gh api --method POST …/issues` IS chased (mantahostels#511), and gh's
 *    own default with it — a call carrying fields and no --method at all is a
 *    POST.
 *  - `gh api graphql` carrying a `createIssue` mutation IS chased
 *    (mantahostels#519), by reading its `query` field back out of the span the
 *    parser blanked. A mutation carrying no `labelIds` at all is denied; one
 *    carrying labelIds is WARNED, GraphQL taking opaque node ids that name no
 *    label this core can read. A query it cannot read at all — `-F
 *    query=@file`, `--input`, a variable, a command substitution — is left in
 *    SILENCE, the residual this route keeps: warning there would fire almost
 *    entirely on the read-only queries this repo runs daily, and
 *    the guard-issue-body core already warns on exactly those commands, so the
 *    opacity still reaches the session. A `)` inside a string literal
 *    truncates the arguments, and warns rather than denying.
 *  - A PreToolUse hook sees Bash tool calls only, so AN ISSUE CREATED BY A
 *    SCRIPT ESCAPES ENTIRELY. The GitHub web UI and the founder's own
 *    terminal escape the same way (mantahostels#109).
 *    scripts/check-issue-labels.js stays the only control for all three.
 *  - THE `takes:human` LIMB (mantahostels#2775) reads the create's BODY, and
 *    only on the flag form and the REST form, where the body text is on the
 *    command, in a file on disk, or in a heredoc piped into `--body-file -`
 *    (mantahostels#3439) — see lib/gh-body.js for the one-create shapes it
 *    trusts. A body it cannot read — a `$VAR`, a `$(cat …)`, `--body-file -`
 *    fed from anything but such a heredoc or a `cat <path> |`, an unquoted
 *    heredoc whose body would expand, a `-F body=@file` — is REFUSED (#668),
 *    and the refusal names the heredoc form. The GraphQL route never reaches
 *    it at all: labels there are opaque node ids, so the guard cannot tell a
 *    `takes:human` creation from any other one.
 *  - THE OUTSIDE-LINE LIMBS are lib/takes-label.js's four tests, in its
 *    order, on create and on relabel: no act named (mantahostels#2775); a
 *    prohibition named rather than an act (#140); a repo file as the act's
 *    product (mantahostels#3555, ruled on mantahostels#3503); none of the
 *    founder's own acts and no `Tried:` list of three (#1097, ruled on
 *    #1077). Each reads the Outside line alone and lexically, so a line
 *    naming the act without the path, or a list word in a non-act sense,
 *    passes.
 *  - THE CLOSE-WHEN LIMB (#983) refuses a `takes:human` body, on create and
 *    on relabel, carrying no `**Close when:**` line, after the four
 *    Outside-line tests pass. Presence only. The refusal carries the
 *    `founder-deliverable` fragment; a body passing every limb gets a
 *    one-line pointer to it.
 *  - THE EDIT ROUTE (mantahostels#3555) reaches the same limbs through `gh
 *    issue edit <n>… --add-label takes:human`. The body is read off the
 *    command where the edit also carries an inline `--body`, and otherwise
 *    FETCHED — `gh issue view <n> --json body`, in the directory the edit
 *    runs in where it already exists, else the hook's, and against the repo
 *    an issue URL or `--repo` names, at most TWO fetches a command; a third
 *    number and beyond fail open, recorded. `gh` is `$WFC_GH`, else `gh`
 *    (base §N7). A fetch that fails, a `gh` that cannot be found, a number or
 *    a `--repo` the guard cannot read all FAIL OPEN, recorded. A `--body` it
 *    cannot read, or any `--body-file`, is REFUSED (#669): relabelling alone
 *    always has its body fetched, and the refusal names that spelling.
 *    `--remove-label` and every other edit pass unjudged, and a relabel by
 *    script, GraphQL or the web UI still escapes; check-issue-labels.js
 *    catches those after the fact.
 *  - THE BLANK-BODY LIMB (mantahostels#3443) refuses, whatever the label, a
 *    flag-form create whose body is empty or whitespace-only — on the
 *    command, in a heredoc, or in a file — or whose `--body-file` path, or
 *    the one `cat <path> | gh issue create … --body-file -` pipes in, is
 *    absent from disk. A relative path resolves against the directory the
 *    command walk tracks (mantahostels#3453); a directory it cannot know and
 *    an unreadable body file both fail open, recorded — on a takes:human
 *    create, refused (#668). A command naming the file's basename BEFORE the
 *    read is taken to write it first and passes unread, unrecorded: a script
 *    writing a path the command never names is the false refusal left, and a
 *    same-named file in another directory, or a basename inside a longer
 *    word, the missed one. The REST and GraphQL routes are not judged, and
 *    neither is a create carrying no body flag at all.
 *  - THE BASIS LIMB (#672) refuses, on a body the blank-body limb read, a
 *    gate line or a prose wait with no `**Gate basis:**`, or a window in
 *    either that the basis does not name (#823), through lib/issue-gate.js.
 *    It checks the basis names each window, never that it holds up.
 *  - THE CHECK LIMB (#3487) refuses, on the same body, a gate `check:` that
 *    cannot run as a command, and warns that one which can was not run.
 *  - THE SECOND-MAP LIMB (#717) refuses a flag-form or REST create carrying
 *    `wayfinder:map` while an open map's Destination still reads the new-repo
 *    placeholder (#1464). The GraphQL route is not judged: its labels are
 *    opaque node ids, and a lookup would not fit the hook's time limit
 *    (mantahostels#519). A `GH_REPO=…` on the create is not read: where no
 *    --repo or spelled-out REST endpoint names the repo, the maps are listed
 *    for the create's cwd, so that create is judged against the wrong repo.
 *  - It says nothing about PLACEMENT. The parent is not in the create
 *    command, so an unparented issue still passes;
 *    scripts/check-issue-orphans.js remains the only control there
 *    (mantahostels#453).
 *  - Its manifest row runs it only on a command `Bash(gh *)` admits
 *    (mantahostels#2127): some segment leads with `gh`. NEARLY the same test
 *    as the core's own basename check, which differs on one spelling:
 *    `/usr/bin/gh …` passes the basename but matches no `Bash(gh *)`
 *    pattern, so a path-spelled call is unjudged.
 *  - It FAILS OPEN (mantahostels#103 §6): a label value it cannot read — an
 *    unexpanded $VAR, a command substitution — lets the whole call through
 *    unjudged, RECORDED (mantahostels#147) for check-guard-errors.js to
 *    report under `npm run status`, and so does every payload fault the
 *    dispatcher names. A throw of its own refuses.
 *  - THE RULE IT PRINTS lives in docs/agents/rules/, not here
 *    (mantahostels#1649, spec mantahostels#1641): CLAUDE.md keeps a trigger
 *    line naming the id, and this core splices the fragment into its
 *    refusal. An unreadable fragment is one of THREE faults this core does
 *    not fail open on and does not log — the command is resolved and known
 *    bad, only the rule could not be read; it refuses with a pointer to the
 *    fragment instead. The others are an unreadable takes:human body on a
 *    create (#668) and on a relabel (#669), refused above.
 */

const {
	basisFaults,
	basisRefusal,
	MAP_LABEL,
	openMapsArgs,
	secondMapVerdict,
} = require("./issue-gate.js");
const { addedCheckVerdict } = require("./gate-check.js");
const {
	defaultsToPost,
	endpointRepo,
	isGraphql,
	isIssueCollection,
	mutationArgs,
	scanApi,
	scanGraphql,
} = require("./gh-api-call.js");
const {
	SPACE,
	bodyFileWord,
	bodyWord,
	captured,
	newBody,
} = require("./gh-body.js");
const { ISSUE_VALUE_FLAGS, issueWord } = require("./gh-issue-ref.js");
const { shellWord } = require("./script-path.js");
const {
	deny,
	open,
	ruleOrFallback,
	walkVerdict,
} = require("./guard-verdict.js");
const { parseCommand, unmask } = require("./shell-parse.js");
const { isGhCommand, literal, scanFlags } = require("./shell-words.js");
const {
	CLOSE_WHEN_LINE,
	FOUNDER_ACTS,
	TAKES_VALUES,
	TRIED_MIN,
	outsideLineFault,
} = require("./takes-label.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} LabelPorts
 * @property {(path: string) => string | undefined} readFile a body file's
 *   text, undefined where it is absent; throws where it cannot be read
 * @property {(args: string[], cwd: string) => string} gh gh's stdout, run in
 *   `cwd`; throws where gh fails, cannot be found or outlasts its timeout
 * @typedef {import("./kit-context.js").KitContext & LabelPorts} LabelContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./gh-body.js").Body} Body
 * @typedef {import("./gh-body.js").BodyEnv} BodyEnv
 */

/* The line a `takes:human` body must carry (mantahostels#2775). */
const HUMAN_MARKER = "Outside Claude Code:";

/* Fetches a relabel may spend, each bounded by the host's GH_TIMEOUT_MS
 * (lib/issue-create-label-host.js), so a hung gh stays under the hook's 10 s
 * ceiling. */
const FETCH_CAP = 2;

/** @param {LabelContext} ctx */
const labelRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"issue-takes-label",
		"Every gh issue create carries a takes: label",
	);

/** @param {LabelContext} ctx */
const deliverableRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"founder-deliverable",
		"A founder-facing item lives in an open issue, filed the moment it exists: `takes:human` for an act outside Claude Code, with a `**Close when:**` line; `takes:wayfinder` with a `## Question` body for a check by eye or an unanswered decision",
	);

const DELIVERABLE_POINTER_LEAD =
	"This applies takes:human. The issue body is the hand-over's source: the act, why, the deliverable verbatim or each step, then **Close when:**. The full rule:";

const GRAPHQL_FIX =
	'gh issue create --title "…" --body "…" --label takes:triage';

const FLAG_FORM_COST =
	"A `gh issue create` naming a label GitHub does not know ABORTS THE WHOLE CREATE AND STILL EXITS 0: nothing is filed, and the call reads as success.";
const API_FORM_COST =
	"Whether GitHub creates the misspelt label or drops it, nothing downstream reads it: /pick-next shows `none` in its TAKES column, and the issue is as unroutable as one carrying no label at all.";

/**
 * @typedef {object} Run one call's judging
 * @property {Parsed} parsed
 * @property {LabelContext} ctx
 * @property {string} warning the GraphQL warn
 * @property {string[]} checkNotes the check limb's warnings
 * @property {boolean} humanApplied a `takes:human` passed every limb
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 */

/**
 * @param {string} command
 * @param {LabelContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	/** @type {Run} */
	const run = {
		parsed: parseCommand(command),
		ctx,
		warning: "",
		checkNotes: [],
		humanApplied: false,
	};
	const stopped = walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx);
	if (stopped !== undefined) return stopped;
	/* A pointer, not the fragment: its 1.8 KB put the Bash tool over route
	 * (f)'s cap (docs/doc-map.md §Capture and placement). */
	const pointer = run.humanApplied
		? `${DELIVERABLE_POINTER_LEAD} ${ctx.scriptPath("lib/rule-text.sh")} founder-deliverable`
		: "";
	const said = [run.warning, ...run.checkNotes, pointer]
		.filter(Boolean)
		.join("\n\n");
	return said ? { injectRules: [], prelude: ctx.corePaths(said) } : null;
}

/** The seven, rendered for a human, in the order the doc's table lists them. */
const valuesLine = () => TAKES_VALUES.map((v) => `  takes:${v}`).join("\n");

const actsLine = () => FOUNDER_ACTS.join("; ");

/**
 * One command the call runs: `gh issue create`, `gh issue edit` and `gh api`
 * are judged, by the command word's basename.
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	const [head = "", sub, verb] = cmd.words;
	if (!isGhCommand(head)) return;
	if (sub === "issue" && verb === "create")
		judgeCreate(run, cmd, cmd.words.slice(3));
	else if (sub === "issue" && verb === "edit")
		judgeEdit(run, cmd, cmd.words.slice(3));
	else if (sub === "api") judgeApi(run, cmd, cmd.words.slice(2));
}

/**
 * @typedef {object} Creation what a creation route read
 * @property {string[]} labels
 * @property {Body} body
 * @property {string} repo the repo it files into, "" for gh's own default
 * @property {boolean} repoHidden which repo it files into cannot be read
 * @property {Route} route
 * @typedef {object} Route how the route spells a fix
 * @property {string} cost what a wrong value costs here
 * @property {string} fix the command up to its labels
 * @property {string} flag how it spells one label: the flag
 * @property {string} key and the value's prefix
 */

/**
 * One --label word, which gh lets carry a comma-separated list.
 * @param {Run} run
 * @param {string[]} labels accumulator: each label read is pushed here
 * @param {string} word
 * @returns {boolean} false where the word's text cannot be recovered, which
 *   is a fail-open rather than a verdict — the hidden text may be the right
 *   label
 */
function pushLabel(run, labels, word) {
	const text = captured(word, run.parsed.spans);
	if (text === null) return false;
	labels.push(...text.split(",").filter(Boolean));
	return true;
}

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function bodyEnv(run, cmd) {
	return {
		spans: run.parsed.spans,
		subject: run.parsed.subject,
		subcmd: `issue${SPACE}+create`,
		what: "gh issue create",
		cwd: cmd.cwd,
		home: run.ctx.vars.HOME ?? "",
		readFile: run.ctx.readFile,
	};
}

/**
 * `gh issue create …` — the flag form.
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeCreate(run, cmd, args) {
	/** @type {Creation} */
	const made = {
		labels: [],
		body: newBody(),
		repo: "",
		repoHidden: false,
		route: {
			cost: FLAG_FORM_COST,
			fix: 'gh issue create --title "…" --body "…"',
			flag: "--label",
			key: "",
		},
	};
	/** @type {CreateScan} */
	const scan = { run, made, env: bodyEnv(run, cmd), unreadable: "" };
	/* Stopped, the scan met --help: a command that prints documentation and
	 * files nothing. */
	const scanned = scanFlags(
		ISSUE_VALUE_FLAGS.create,
		args,
		(kind, name, value) => createWord(scan, kind, name, value),
	);
	if (!scanned) return;
	if (scan.unreadable)
		open(run.ctx, `${scan.unreadable} — create allowed unchecked`);
	judgeBody(run, cmd.segment, made.body);
	judgeLabels(run, cmd.segment, made);
	judgeSecondMap(run, cmd, made);
	if (made.body.fault)
		open(run.ctx, `${made.body.fault} — create allowed unchecked`);
}

/**
 * @typedef {{ run: Run, made: Creation, env: BodyEnv, unreadable: string }}
 *   CreateScan one create's flag scan: what it has read into `made`, and in
 *   `unreadable` what makes the labels unknowable
 */

/** @type {(scan: CreateScan, value: string) => void} */
const readLabel = (scan, value) => {
	if (!pushLabel(scan.run, scan.made.labels, value))
		scan.unreadable = "could not read a --label value on a gh issue create";
};
/** @type {(scan: CreateScan, value: string) => void} */
const readBody = (scan, value) =>
	bodyWord(scan.made.body, value, scan.run.parsed.spans);
/** @type {(scan: CreateScan, value: string) => void} */
const readBodyFile = (scan, value) =>
	bodyFileWord(scan.made.body, value, scan.env);
/** @type {(scan: CreateScan, value: string) => void} */
const readRepo = (scan, value) => {
	const repo = captured(value, scan.run.parsed.spans);
	if (repo === null) scan.made.repoHidden = true;
	else scan.made.repo = repo;
};

const CREATE_READS = new Map([
	["--label", readLabel],
	["-l", readLabel],
	["--body", readBody],
	["-b", readBody],
	["--body-file", readBodyFile],
	["-F", readBodyFile],
	["--repo", readRepo],
	["-R", readRepo],
]);

/**
 * One word of a create's flag scan; false at --help.
 * @param {CreateScan} scan
 * @param {string} kind
 * @param {string} name
 * @param {string} value
 */
function createWord(scan, kind, name, value) {
	if (name === "--help" || name === "-h") return false;
	if (kind === "opt") CREATE_READS.get(name)?.(scan, value);
	else if (kind === "dangling" && CREATE_READS.get(name) === readLabel)
		scan.unreadable = "a gh issue create ends in a --label with no value";
	else if (kind === "arg" && /[$`]/.test(value))
		/* A bare word gh issue create has no use for. An expansion here can
		 * hold the whole argument list — `gh issue create $ARGS` — so the
		 * labels this scan found say nothing about what will be sent. */
		scan.unreadable = "could not read the arguments of a gh issue create";
	return true;
}

/**
 * The blank-body limb (mantahostels#3443), for every takes: value. Runs
 * before the label verdict, so a blank create is refused for the body even
 * where its label is also wrong, and a takes:human one is never recorded as
 * unreadable first.
 * @param {Run} run
 * @param {string} segment
 * @param {Body} body
 */
function judgeBody(run, segment, body) {
	if (body.missing)
		denyBlank(
			run,
			segment,
			`is read from a file that does not exist: \`${body.missing}\``,
		);
	if (!body.given || body.hidden) return;
	if (!/[^ \t\n\v\f\r]/.test(body.text)) denyBlank(run, segment, "is empty");
	judgeBasis(run, segment, body.text);
	judgeCheck(run, segment, body.text);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} wrong completes "This files an issue whose body …"
 * @returns {never}
 */
function denyBlank(run, segment, wrong) {
	return deny(
		run.ctx,
		segment,
		`This files an issue whose body ${wrong}: @CMD@

gh files an issue from an absent or empty body file as a blank issue, and exits 0 (mantahostels#3443).

Write the body first. Either check the call that should have written the file really ran — a denied compound command writes nothing — or feed the body in this same command:

  cat <<'BODY' | gh issue create --title "…" --label takes:… --body-file -
  <the body>
  BODY

A command that writes the file itself before creating (\`cat > <path> <<'BODY'\`, \`tee <path>\`) is let through: the file's name appearing a second time on the command reads as that write.`,
	);
}

/**
 * The basis limb (#672), read by lib/issue-gate.js, which file-issue.js and
 * issue-body.js share, so the three routes cannot disagree. Only a body this
 * guard read is judged — the REST and GraphQL routes, and a hidden body, pass
 * it unjudged.
 * @param {Run} run
 * @param {string} segment
 * @param {string} text
 */
function judgeBasis(run, segment, text) {
	const faults = basisFaults(text);
	if (faults.length === 0) return;
	deny(
		run.ctx,
		segment,
		`This files an issue whose body sets a wait with nothing behind it: @CMD@

It carries ${basisRefusal(faults, text)}

Ask of the window: what data sets it, and does anything shorter hold? Where the answer is a round figure, cut the window to what the data defends.`,
	);
}

/**
 * The check limb (#3487): a `check:` on a gate line that cannot run as a
 * command is refused. One that runs is never run here: guard-dispatch.js's
 * 60 s hook limit, shared by every core, cannot hold check-gates.js's 60 s
 * budget and its kill grace, so it is warned.
 * @param {Run} run accumulator: its warnings go on `checkNotes`
 * @param {string} segment
 * @param {string} text
 */
function judgeCheck(run, segment, text) {
	const { refusals, warnings } = addedCheckVerdict("", text, { run: false });
	if (refusals.length > 0)
		deny(
			run.ctx,
			segment,
			`This files a gate whose check no sweep can read: @CMD@

Nothing filed: ${refusals.join(" ")}`,
		);
	run.checkNotes.push(...warnings);
}

/**
 * The verdict, given the labels a creation carries. The fix shown carries
 * `takes:triage` and then the command's own labels, each shell-quoted, so
 * copying it keeps them.
 *
 * EVERY takes: word is checked, not just the first. gh aborts on any label it
 * does not know, so `--label takes:implement --label takes:implememt` files
 * nothing at exit 0 — a scan that stopped at the first valid value would wave
 * through the exact failure this guard exists to make impossible.
 * @param {Run} run
 * @param {string} segment
 * @param {Creation} made
 */
function judgeLabels(run, segment, made) {
	const takes = made.labels.filter((l) => l.startsWith("takes:"));
	for (const label of takes) {
		const value = label.slice("takes:".length);
		if (!TAKES_VALUES.includes(value))
			denyInvalid(run, segment, value, made.route.cost);
	}
	if (takes.includes("takes:human")) return judgeHumanBody(run, segment, made);
	if (takes.length > 0) return;
	const { fix, flag, key } = made.route;
	const shown = ["takes:triage", ...made.labels]
		.map((l) => ` ${flag} ${shellWord(`${key}${l}`)}`)
		.join("");
	denyMissing(run, segment, `${fix}${shown}`);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} fix the corrected command to show
 * @returns {never}
 */
function denyMissing(run, segment, fix) {
	return deny(
		run.ctx,
		segment,
		`This creates an issue with no \`takes:\` label: @CMD@

${labelRule(run.ctx)}

Add one of:

${valuesLine()}

  ${fix}

Or file, label and place it in one checked call: node ${run.ctx.scriptPath("file-issue.js")} --title "…" --label takes:… (--parent <n> | --standalone "<why>") --body-file - (#533).`,
	);
}

/**
 * gh refuses a label it does not know, the REST API does not, so `cost`
 * differs by route.
 * @param {Run} run
 * @param {string} segment
 * @param {string} value
 * @param {string} cost
 * @returns {never}
 */
function denyInvalid(run, segment, value, cost) {
	return deny(
		run.ctx,
		segment,
		`This creates an issue with a \`takes:\` label that does not exist — \`takes:${value}\`: @CMD@

${cost}

${labelRule(run.ctx)}

The seven values, in full:

${valuesLine()}`,
	);
}

const humanRule = () =>
	`\`takes:human\` means the next action happens OUTSIDE Claude Code ENTIRELY. It is picked from the next ACTION, never from the subject. Name the concrete outside act, one of the founder's own (#1077): ${actsLine()}. A website job no act on that list covers adds a **Tried:** list of at least ${TRIED_MIN} methods that failed.

Add the act to the body, on its own line:

  **${HUMAN_MARKER}** <the act, in plain words>

IF YOU CANNOT WRITE THAT LINE HONESTLY, THE LABEL IS WRONG. Being barred is not the same as being impossible:

  - a skill's own scope barring THIS pass from the edit    → takes:implement
  - a repo rule barring an agent from the act              → takes:wayfinder, to rule on it
  - a command needing a password or a founder keystroke    → the founder types \`! <cmd>\` IN Claude Code; still not outside it
  - reading repo files and writing a ruling                → takes:wayfinder
  - a founder decision or confirmation                     → takes:wayfinder, where the founder makes it
  - applying a prescribed edit                             → takes:implement
  - an act whose product is a file in this repository     → takes:implement; the founder's review of it is takes:wayfinder

There is no "no command opens this" shape: a scripted tracker whose queue has emptied closes, or moves to the command that owns what is left (mantahostels#3352).

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#804, mantahostels#2775, mantahostels#3439, mantahostels#3555).`;

/**
 * The `takes:human` limb (mantahostels#2775). Reached only where the create
 * carries a VALID takes:human — a missing or misspelt label is refused first.
 *
 * An unreadable body is REFUSED here, not failed open (#668): the quoted
 * heredoc is a spelling this guard always reads, so every legitimate
 * takes:human create has one that passes.
 * @param {Run} run
 * @param {string} segment
 * @param {Creation} made
 */
function judgeHumanBody(run, segment, made) {
	if (made.body.hidden)
		denyUnreadBody(run, segment, {
			wrong: "creates a `takes:human` issue whose body this guard cannot read",
			cite: "(#668)",
			passing: `Re-spell it so the body is read, from a quoted heredoc:

  cat <<'BODY' | gh issue create --title "…" --label takes:human --body-file -
  <the body, with its **Outside Claude Code:** and **Close when:** lines>
  BODY`,
		});
	judgeHumanText(run, segment, made.body.text, "creates a `takes:human` issue");
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {{ wrong: string, cite: string, passing: string }} refusal `wrong`
 *   what the command does wrong; `cite` the refusing ticket, bracketed so the
 *   release build qualifies it; `passing` the spelling that passes
 * @returns {never}
 */
function denyUnreadBody(run, segment, { wrong, cite, passing }) {
	return deny(
		run.ctx,
		segment,
		`This ${wrong}: @CMD@

A \`takes:human\` body must name its outside act, and a body the guard cannot read is one nobody checked ${cite}. ${passing}

${humanRule()}`,
	);
}

/**
 * (#1097, #983)
 * @param {Run} run accumulator: its humanApplied, set where the label passes
 * @param {string} segment
 * @param {string} body
 * @param {string} verb "creates a `takes:human` issue" or "applies
 *   `takes:human` to #n"
 */
function judgeHumanText(run, segment, body, verb) {
	const found = outsideLineFault(body);
	if (found?.fault === "NO-OUTSIDE-ACT")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose body names no act performed outside Claude Code: @CMD@

${humanRule()}`,
		);
	if (found?.fault === "BARRED-NOT-IMPOSSIBLE")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose Outside line names a prohibition rather than an act: @CMD@

  ${found.line}

BEING BARRED IS NOT BEING IMPOSSIBLE (mantahostels#2775). The Outside line names what the founder DOES outside Claude Code, one of his own acts (#1077): ${actsLine()}.

Before relabelling, TEST the bar rather than restating it:

  - a file you believe unwritable   → \`test -w <path>\`; a home-directory file usually is
  - a rule you believe forbids it   → read the rule; most name a surface, not a filesystem
  - a command wanting a password    → the founder types \`! <cmd>\` IN Claude Code

If the bar is real, it is a repo rule and the issue is \`takes:wayfinder\`, to rule on it. If the bar is not real, the issue is \`takes:implement\`.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#2775, #140).`,
		);
	if (found?.fault === "REPO-FILE-ACT")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose outside act produces a file in this repository: @CMD@

  ${found.line}

An act that ends in a repo file is never an outside act, whatever tool a document names as the owner's (mantahostels#3503).

  - the file itself                              → takes:implement, and an agent writes it
  - the founder's taste on what the agent drew  → takes:wayfinder, a review in session

Relabel, and drop the tool and the path from the Outside line if a real outside act remains.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#3555).`,
		);
	if (found?.fault === "NOT-A-FOUNDER-ACT")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose Outside line names none of the founder's own acts: @CMD@

  ${found.line}

The acts are: ${actsLine()}.

Two ways out:

  - name the act from that list on the Outside line
  - or, for a website job no act on it covers, add a **Tried:** line followed directly by at least ${TRIED_MIN} list items, one per different method you actually ran and what it showed

Neither true means an agent can do it, and the label is wrong.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (#1077, #1097).`,
		);
	if (!CLOSE_WHEN_LINE.test(body))
		deny(
			run.ctx,
			segment,
			`This ${verb} whose body has no **Close when:** line: @CMD@

Every founder errand says when it is finished (#983). Add it to the body, on its own line:

  **Close when:** <what finishes it> — and what the closing comment records, naming any issue that waits on the result

${deliverableRule(run.ctx)}`,
		);
	run.humanApplied = true;
}

/**
 * The second-map limb (#717), read by lib/issue-gate.js, which file-issue.js
 * shares. Only a create carrying wayfinder:map spends its one `gh issue
 * list`, run where the create runs so that, with no repo named, gh resolves
 * the same one (#1464).
 * @param {Run} run
 * @param {Command} cmd
 * @param {Creation} made
 */
function judgeSecondMap(run, cmd, made) {
	if (!made.labels.includes(MAP_LABEL)) return;
	const { ctx } = run;
	if (made.repoHidden)
		return ctx.log(
			"could not read which repo a wayfinder:map create files into — second map unchecked on this create",
		);
	if (!cmd.cwd && !made.repo)
		return ctx.log(
			"could not tell which directory a wayfinder:map create runs in — second map unchecked on this create",
		);
	const dir = cmd.cwd || ctx.fallbackCwd;
	if (!ctx.isDir(dir))
		return ctx.log(
			"could not enter the directory a wayfinder:map create runs in — second map unchecked on this create",
		);
	const v = secondMapVerdict([MAP_LABEL], () =>
		JSON.parse(ctx.gh(openMapsArgs(made.repo), dir)),
	);
	if (v && "unreadable" in v)
		return ctx.log(
			"the open maps could not be read — second map unchecked on this create",
			v.unreadable,
		);
	if (v)
		deny(
			run.ctx,
			cmd.segment,
			`This creates a second wayfinder map while the first is unfilled: @CMD@

${v.refusal}`,
		);
}

/**
 * `gh issue edit <n>… --add-label takes:human` — the edit route
 * (mantahostels#3555). The body is read off the command where the edit also
 * writes it, and otherwise fetched, at most FETCH_CAP a command.
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeEdit(run, cmd, args) {
	const edit = scanEdit(run, args);
	if (!edit?.labels.includes("takes:human")) return;
	if (edit.unreadable) open(run.ctx, UNREAD_NUMBER);
	if (edit.repoHidden)
		open(
			run.ctx,
			"could not read which repo a gh issue edit names — takes:human relabel allowed unchecked",
		);
	/* The edit writes the body in the same call, so that text is what the
	 * label lands on — where it can be read. */
	if (edit.body.given) {
		if (edit.body.hidden) denyUnreadRelabel(run, cmd.segment);
		const word = edit.numbers[0];
		const first = (word && issueWord(word, run.parsed.spans)?.number) || word;
		return judgeHumanText(
			run,
			cmd.segment,
			edit.body.text,
			`${APPLIES_HUMAN}${first ?? "?"}`,
		);
	}
	edit.numbers.forEach((word, i) => {
		const ref = issueWord(word, run.parsed.spans);
		if (!ref) open(run.ctx, UNREAD_NUMBER);
		if (i >= FETCH_CAP)
			open(
				run.ctx,
				`more than ${FETCH_CAP} issues on one takes:human relabel — #${ref.number} allowed unchecked`,
			);
		const repo = ref.repo || edit.repo;
		if (cmd.cwd === "" && !repo)
			open(
				run.ctx,
				`could not tell which directory a gh issue edit runs in — #${ref.number}'s takes:human relabel allowed unchecked`,
			);
		const text = fetchBody(run, cmd, ref.number, repo);
		if (text === null)
			open(
				run.ctx,
				`could not fetch #${ref.number}'s body for a takes:human relabel — relabel allowed unchecked`,
			);
		judgeHumanText(run, cmd.segment, text, `${APPLIES_HUMAN}${ref.number}`);
	});
}

/* A relabel's verb, the issue number following it. */
const APPLIES_HUMAN = "applies `takes:human` to #";

const UNREAD_NUMBER =
	"could not read the issue number of a gh issue edit — takes:human relabel allowed unchecked";

/**
 * @typedef {object} Edit what one `gh issue edit`'s flags read
 * @property {Run} run
 * @property {string[]} labels the --add-label values
 * @property {string[]} numbers the issue words, as typed
 * @property {Body} body
 * @property {boolean} unreadable an issue word it cannot read
 * @property {string} repo the --repo value, "" where none
 * @property {boolean} repoHidden a --repo it cannot read
 */

/** @type {(edit: Edit, value: string) => void} */
const editBody = (edit, value) =>
	bodyWord(edit.body, value, edit.run.parsed.spans);
/** @type {(edit: Edit, value: string) => void} */
const editBodyFile = (edit) => {
	/* The create's file readers are tuned to a create's command shape, so a
	 * body from a file or stdin is hidden here, and refused. */
	edit.body.given = true;
	edit.body.hidden = true;
};
/** @type {(edit: Edit, value: string) => void} */
const editRepo = (edit, value) => {
	const named = captured(value, edit.run.parsed.spans);
	if (named === null) edit.repoHidden = true;
	else edit.repo = named;
};

const EDIT_READS = new Map([
	[
		"--add-label",
		(/** @type {Edit} */ edit, /** @type {string} */ value) => {
			pushLabel(edit.run, edit.labels, value);
		},
	],
	["--body", editBody],
	["-b", editBody],
	["--body-file", editBodyFile],
	["-F", editBodyFile],
	["--repo", editRepo],
	["-R", editRepo],
]);

/**
 * An edit's flags, read; null at --help.
 * @param {Run} run
 * @param {string[]} args
 * @returns {Edit | null}
 */
function scanEdit(run, args) {
	/** @type {Edit} */
	const edit = {
		run,
		labels: [],
		numbers: [],
		body: newBody(),
		unreadable: false,
		repo: "",
		repoHidden: false,
	};
	const scanned = scanFlags(
		ISSUE_VALUE_FLAGS.edit,
		args,
		(kind, name, value) => {
			if (name === "--help" || name === "-h") return false;
			if (kind === "opt") EDIT_READS.get(name)?.(edit, value);
			else if (kind === "arg" && /[$`]/.test(value)) edit.unreadable = true;
			else if (kind === "arg") edit.numbers.push(value);
			return true;
		},
	);
	return scanned ? edit : null;
}

/**
 * The body of one issue, off the network, asked where the edit runs — or,
 * where that directory does not exist yet at hook time, where the hook does.
 * Null where it cannot be had, which the caller records rather than reads as
 * "the line is absent".
 * @param {Run} run
 * @param {Command} cmd
 * @param {string} number
 * @param {string} repo "" for gh's own default
 */
function fetchBody(run, cmd, number, repo) {
	const args = ["issue", "view", number];
	if (repo) args.push("--repo", repo);
	args.push("--json", "body", "--jq", '.body // ""');
	const { ctx } = run;
	const dir = cmd.cwd && ctx.isDir(cmd.cwd) ? cmd.cwd : ctx.fallbackCwd;
	try {
		return trimEndRun(ctx.gh(args, dir), "\n");
	} catch {
		return null;
	}
}

/**
 * Names only the relabel-alone spelling (#669): guard-issue-body denies every
 * `gh issue edit --body`, a readable one included.
 * @param {Run} run
 * @param {string} segment
 * @returns {never}
 */
function denyUnreadRelabel(run, segment) {
	const issueBody = run.ctx.scriptPath("issue-body.js");
	return denyUnreadBody(run, segment, {
		wrong:
			"applies `takes:human` while rewriting the body in a way this guard cannot read",
		cite: "(#669)",
		passing: `Write the line first, then relabel alone — the guard fetches the body the label lands on:

  node ${issueBody} append <n> --text "**Outside Claude Code:** <the act, in plain words>"
  node ${issueBody} append <n> --text "**Close when:** <what finishes it>"
  gh issue edit <n> --add-label takes:human`,
	});
}

/**
 * `gh api … repos/<o>/<r>/issues` — the same creation through the REST
 * endpoint (mantahostels#511), and `gh api graphql` carrying a `createIssue`
 * mutation (mantahostels#519).
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeApi(run, cmd, args) {
	const call = scanApi(args, run.parsed.spans);
	/* The method and the endpoint are READ BACK, not merely inspected: the
	 * splitter blanks every quoted span, so judging the blanked word would let
	 * a pair of quotes around `repos/o/r/issues` walk the creation past the
	 * deny. */
	const method = captured(call.method, run.parsed.spans);
	const endpoint = captured(call.endpoint, run.parsed.spans);
	/* Either word, read and plainly not a creation, ends the segment whatever
	 * the other one says — so an unreadable endpoint on a GET, or an
	 * unreadable method on a call aimed elsewhere, records nothing. gh's own
	 * default is POST where the call carries a payload, so `gh api
	 * repos/o/r/issues -f title=x` files an issue with the word POST nowhere
	 * on the command. */
	if (method === "" && !defaultsToPost(call)) return;
	if (method && method.toUpperCase() !== "POST") return;
	/* GraphQL puts what it writes in the query text rather than in the
	 * endpoint, so it is judged before the REST test, which would read it as
	 * neither a creation nor anything else. */
	if (endpoint !== null && isGraphql(endpoint))
		return judgeGraphql(run, cmd.segment, call);
	/* The COLLECTION, never one issue: a POST to `…/issues/<n>/comments` or
	 * `…/dependencies/blocked_by` creates something that takes no label. */
	if (endpoint !== null && !isIssueCollection(endpoint)) return;
	if (method === null || endpoint === null || call.input)
		open(
			run.ctx,
			"could not read a gh api issue creation — create allowed unchecked",
		);
	if (call.opaque)
		open(
			run.ctx,
			"could not read a field name on a gh api issue creation — create allowed unchecked",
		);
	const repo = endpointRepo(endpoint);
	/** @type {Creation} */
	const made = {
		labels: [],
		body: newBody(),
		repo: repo ?? "",
		repoHidden: repo === null,
		route: {
			cost: API_FORM_COST,
			fix: "gh api --method POST repos/<owner>/<repo>/issues -f title=…",
			flag: "-f",
			key: "labels[]=",
		},
	};
	readApiFields(run, call.fields, made);
	judgeLabels(run, cmd.segment, made);
	judgeSecondMap(run, cmd, made);
}

/**
 * THE FIELD NAME DECIDES, never the value. `-f title="$T"` is the ordinary
 * way to pass a title, and literal fails on the whole word for the one `$` in
 * it — so failing open there would disarm the deny on almost every real
 * creation. The value is only read where the name says it is the labels or
 * the body. A name that does not read has already failed open on call.opaque.
 * @param {Run} run
 * @param {string[]} fields
 * @param {Creation} made accumulator: the labels and body each field gives
 */
function readApiFields(run, fields, made) {
	for (const field of fields) readApiField(run, field, made);
}

/**
 * @param {Run} run
 * @param {string} field
 * @param {Creation} made accumulator: the label or body this field gives
 */
function readApiField(run, field, made) {
	const { text: raw, known } = literal(field, run.parsed.spans);
	const text = trimEndRun(raw, "\n");
	if (text.startsWith("body=")) {
		/* The body, for the takes:human limb. `@file` is gh's read-from-disk
		 * spelling on -F, and what follows it is a path rather than the text. */
		const value = text.slice("body=".length);
		if (!known || value.startsWith("@")) made.body.hidden = true;
		else made.body.text += value;
		return;
	}
	/* `labels[]=` is gh's array spelling and the one the endpoint wants; the
	 * bare name is judged too, so a caller who got the array syntax wrong is
	 * told about the label rather than about the syntax. */
	const label = /^labels(\[\])?=/.exec(text);
	if (!label) return;
	made.labels.push(text.slice(label[0].length));
	if (!known)
		open(
			run.ctx,
			"could not read a labels field on a gh api issue creation — create allowed unchecked",
		);
}

/**
 * The GraphQL route (mantahostels#519), the weakest of the three: GraphQL
 * takes label NODE IDS (`LA_kwDO…`), not names, so where a mutation carries
 * labelIds the guard cannot tell whether any of them is a `takes:` value, and
 * no reading of the command would tell it. That splits the verdict:
 *   no labelIds at all   the issue is filed with no labels whatever → DENY
 *   labelIds present     opaque ids, or a variable holding them     → WARN
 *   input passed whole   the mutation names no field at all         → WARN
 * @param {Run} run
 * @param {string} segment
 * @param {import("./gh-api-call.js").ApiCall} call
 */
function judgeGraphql(run, segment, call) {
	const { query, hidden } = scanGraphql(call.fields, run.parsed.spans);
	/* No `createIssue` in the query text: nothing is filed, as far as this
	 * guard can read. Where that text was unreadable the mutation may be in the
	 * part it cannot see, and that is left in silence — see LIMITS. */
	const args = mutationArgs(query, "createIssue");
	if (args === null) return;
	if (hidden || call.opaque || call.input)
		return warnOnce(
			run,
			segment,
			"part of the query is out of sight, so the guard cannot see whether it applies a label",
		);
	/* The arguments stop at the FIRST `)`, so a bracket inside a string
	 * literal — `title:"fix (again)"` — cuts them short and a trailing
	 * `labelIds` falls off the end with it. DENYING ON A TRUNCATED READ WOULD
	 * REFUSE A CORRECTLY-LABELLED CREATION. An odd number of quote marks is the
	 * mark of a literal the cut ran through, so it drops to the warn tier.
	 * Reading to the matching bracket would still not be a faithful parse: the
	 * whitespace squash has already rewritten the inside of every string
	 * literal. */
	if ((args.match(/"/g)?.length ?? 0) % 2)
		return warnOnce(
			run,
			segment,
			"a bracket inside a string literal cut the mutation's arguments short, so the guard cannot see whether a label follows it",
		);
	/* The whole input object arrives as one variable, so the mutation names no
	 * field at all. A variable INSIDE a braced input is different: every field
	 * name is still spelled out there, so a labelIds could not hide in one. */
	if (args.includes("input:$"))
		return warnOnce(
			run,
			segment,
			"the mutation's input arrives whole as a variable, so the guard can see no field names at all",
		);
	/* An empty list applies no label, so it is the missing-label case spelled
	 * long. */
	if (!args.includes("labelIds:[]") && args.includes("labelIds:"))
		return warnOnce(
			run,
			segment,
			"GraphQL takes label NODE IDS rather than names, so nothing on the command says whether any of these `labelIds` is a `takes:` value",
		);
	denyMissing(run, segment, GRAPHQL_FIX);
}

/**
 * The third tier (mantahostels#519), for the one route where the guard can
 * see a creation but not its labels.
 * @param {Run} run accumulator: its warning, set by the first call alone
 * @param {string} segment
 * @param {string} cannot what it cannot tell
 */
function warnOnce(run, segment, cannot) {
	if (run.warning) return;
	run.warning = `This files a GitHub issue through GraphQL, and ${cannot}:

  ${unmask(segment)}

Every open issue carries exactly one \`takes:\` value, naming the command that opens it. Without one, /pick-next shows \`none\` in its TAKES column and nothing says who or what works the issue.

Confirm one of the seven is applied, or file it through the flag form, which the guard can read in full:

${valuesLine()}
  ${GRAPHQL_FIX}

Rule: docs/agents/triage-labels.md §\`takes:\`.`;
}

module.exports = { field: "command", noun: "command", decide };
