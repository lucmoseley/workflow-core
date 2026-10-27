/*
 * issue-create-label.js — guard-issue-create-label.js's core (#2796,
 * programme #2733): does an issue a Bash call creates carry a `takes:` label
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
 */

const {
	basisFaults,
	basisRefusal,
	MAP_LABEL,
	openMapsArgs,
	secondMapVerdict,
} = require("./issue-gate.js");
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
const { deny, open, walkVerdict } = require("./guard-verdict.js");
const { parseCommand, unmask } = require("./shell-parse.js");
const { QUOTED, isGhCommand, literal, scanFlags } = require("./shell-words.js");
const {
	CLOSE_WHEN_LINE,
	FOUNDER_ACTS,
	TAKES_VALUES,
	TRIED_MIN,
	outsideLineFault,
} = require("./takes-label.js");

/**
 * @typedef {object} LabelPorts
 * @property {() => string} labelRule the issue-takes-label fragment, or a
 *   stand-in pointing at it where the store cannot give it
 * @property {() => string} deliverableRule the founder-deliverable fragment,
 *   or a stand-in pointing at it
 * @property {(path: string) => string | undefined} readFile a body file's
 *   text, undefined where it is absent; throws where it cannot be read
 * @property {(args: string[], cwd: string) => string} gh gh's stdout, run in
 *   `cwd`; throws where gh fails, cannot be found or outlasts its timeout
 * @typedef {import("./guard-entry.js").KitContext & LabelPorts} LabelContext
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

const DELIVERABLE_POINTER_LEAD =
	"This applies takes:human. The issue body is the hand-over's source: the act, why, the deliverable verbatim or each step, then **Close when:**. The full rule:";

const GRAPHQL_FIX =
	'gh issue create --title "…" --body "…" --label takes:triage';

const FLAG_FORM_COST =
	"That is worse than a missing label. A `gh issue create` naming a label GitHub does not know ABORTS THE WHOLE CREATE AND STILL EXITS 0: nothing is filed, and the call reads as success.";
const API_FORM_COST =
	"Whether GitHub creates the misspelt label or drops it, nothing downstream reads it: /pick-next shows `none` in its TAKES column, and the issue is as unroutable as one carrying no label at all.";

/**
 * @typedef {object} Run one call's judging
 * @property {Parsed} parsed
 * @property {LabelContext} ctx
 * @property {string} warning the GraphQL warn
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
		humanApplied: false,
	};
	const stopped = walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx);
	if (stopped !== undefined) return stopped;
	/* A pointer, not the fragment: its 1.8 KB put the Bash tool over route
	 * (f)'s cap (docs/doc-map.md §Capture and placement). */
	const pointer = run.humanApplied
		? `${DELIVERABLE_POINTER_LEAD} ${ctx.scriptPath("lib/rule-text.sh")} founder-deliverable`
		: "";
	const said = [run.warning, pointer].filter(Boolean).join("\n\n");
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

${run.ctx.labelRule()}

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

${run.ctx.labelRule()}

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
 * carries a VALID takes:human — a missing or misspelt label is the older,
 * larger fault and is refused first.
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

${run.ctx.deliverableRule()}`,
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
		return ctx.gh(args, dir).replace(/\n+$/, "");
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
	const call = scanApi(args);
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
 * the body. The opaque flag is deliberately not consulted: a masked field
 * name is still legible to literal, which is where every name is read.
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
	const text = raw.replace(/\n+$/, "");
	const eq = text.indexOf("=");
	const name = eq < 0 ? text : text.slice(0, eq);
	if (/[$`]/.test(name) || name.includes(QUOTED))
		open(
			run.ctx,
			"could not read a field name on a gh api issue creation — create allowed unchecked",
		);
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

module.exports = { decide };
