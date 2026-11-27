const { WRITE_BOUND_MS, readGateWrite } = require("./gate-judge.js");
const {
	MAP_LABEL,
	openMapsArgs,
	secondMapVerdict,
	selfReviewRefusal,
} = require("./issue-gate.js");
const { addedCheckVerdict } = require("./gate-check.js");
const {
	defaultsToPost,
	endpointRepo,
	isBodyField,
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
const { shellQuote } = require("./sh-quote.js");
const {
	deny,
	open,
	ruleOrFallback,
	walkVerdict,
} = require("./guard-verdict.js");
const { parseCommand, unmask } = require("./shell-parse.js");
const { ghCall, literal, runText, scanFlags } = require("./shell-words.js");
const {
	CLOSE_WHEN_LINE,
	TAKES_VALUES,
	TRIED_MIN,
	TRIED_WAY,
	outsideLineFault,
	UNTRIED_FAULTS,
} = require("./takes-label.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} LabelPorts
 * @property {(path: string) => string | undefined} readFile
 * @property {(args: string[], cwd: string) => string} gh
 * @property {() => number} now
 * @typedef {import("./kit-context.js").KitContext & LabelPorts} LabelContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./gh-body.js").Body} Body
 * @typedef {import("./gh-body.js").BodyEnv} BodyEnv
 */

const HUMAN_MARKER = "Outside Claude Code:";

// guess, workflow-core#2796
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
const FLAG_FORM_BLANK = `gh files an issue from an absent or empty body file as a blank issue, and exits 0 (mantahostels#3443).

Write the body first. Either check the call that should have written the file really ran — a denied compound command writes nothing — or feed the body in this same command:

  cat <<'BODY' | gh issue create --title "…" --label takes:… --body-file -
  <the body>
  BODY

A command that writes the file itself before creating (\`cat > <path> <<'BODY'\`, \`tee <path>\`) is let through: the file's name appearing a second time on the command reads as that write.`;
const API_FORM_BLANK = `GitHub files an issue from an empty body field as a blank issue (mantahostels#3443).

Write the body into the field, or read it from a file gh opens itself:

  gh api --method POST repos/<owner>/<repo>/issues -f title=… -f 'labels[]=takes:…' -F body=@<path>`;
const API_FORM_COST =
	"Whether GitHub creates the misspelt label or drops it, nothing downstream reads it: /pick-next shows `none` in its TAKES column, and the issue is as unroutable as one carrying no label at all.";

/**
 * @typedef {object} Run
 * @property {Parsed} parsed
 * @property {LabelContext} ctx
 * @property {string} warning
 * @property {string[]} checkNotes
 * @property {boolean} humanApplied
 * @property {number} leftMs
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./shell-words.js").GhRepo} GhRepo
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
		leftMs: WRITE_BOUND_MS,
	};
	const stopped = walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx);
	if (stopped !== undefined) return stopped;
	// workflow-core#983
	const pointer = run.humanApplied
		? `${DELIVERABLE_POINTER_LEAD} ${ctx.scriptPath("lib/rule-text.sh")} founder-deliverable`
		: "";
	const said = [run.warning, ...run.checkNotes, pointer]
		.filter(Boolean)
		.join("\n\n");
	return said ? { injectRules: [], prelude: ctx.corePaths(said) } : null;
}

const valuesLine = () => TAKES_VALUES.map((v) => `  takes:${v}`).join("\n");

/** @param {LabelContext} ctx */
const readActsLine = (ctx) =>
	ruleOrFallback(ctx, "founder-acts", "one of the founder's own acts");

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	const { spans } = run.parsed;
	for (const unwrapped of cmd.runs()) {
		const gh = ghCall(unwrapped.words, spans);
		if (!gh) continue;
		const [sub, verb] = gh.args;
		const ghCmd = {
			...cmd,
			segment: runText(unwrapped, cmd.segment),
			cwd: unwrapped.dirs()[0],
		};
		if (sub === "issue" && verb === "create")
			judgeCreate(run, ghCmd, gh.args.slice(2), gh.repo);
		else if (sub === "issue" && verb === "edit")
			judgeEdit(run, ghCmd, gh.args.slice(2), gh.repo);
		else if (sub === "api") judgeApi(run, ghCmd, gh.args.slice(1));
	}
}

/** @param {GhRepo | null} repo */
const seedRepo = (repo) => ({
	repo: repo?.known ? repo.text : "",
	repoHidden: repo !== null && !repo.known,
});

/**
 * @typedef {object} Creation
 * @property {string[]} labels
 * @property {Body} body
 * @property {string} repo
 * @property {boolean} repoHidden
 * @property {Route} route
 * @typedef {object} Route
 * @property {string} cost
 * @property {string} fix
 * @property {string} flag
 * @property {string} key
 * @property {string} blank
 */

/**
 * @param {Run} run
 * @param {string[]} labels
 * @param {string} word
 * @returns {boolean}
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
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 * @param {GhRepo | null} repo
 */
function judgeCreate(run, cmd, args, repo) {
	/** @type {Creation} */
	const made = {
		labels: [],
		body: newBody(),
		...seedRepo(repo),
		route: {
			cost: FLAG_FORM_COST,
			blank: FLAG_FORM_BLANK,
			fix: 'gh issue create --title "…" --body "…"',
			flag: "--label",
			key: "",
		},
	};
	/** @type {CreateScan} */
	const scan = { run, made, env: bodyEnv(run, cmd), unreadable: "" };
	const scanned = scanFlags(
		ISSUE_VALUE_FLAGS.create,
		args,
		(kind, name, value) => createWord(scan, kind, name, value),
	);
	if (!scanned) return;
	if (scan.unreadable)
		open(run.ctx, `${scan.unreadable} — create allowed unchecked`);
	judgeBody(run, cmd.segment, made);
	judgeLabels(run, cmd.segment, made);
	judgeSecondMap(run, cmd, made);
	if (made.body.fault)
		open(run.ctx, `${made.body.fault} — create allowed unchecked`);
}

/** @typedef {{ run: Run, made: Creation, env: BodyEnv, unreadable: string }} CreateScan */

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
		scan.unreadable = "could not read the arguments of a gh issue create";
	return true;
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {Creation} made
 */
function judgeBody(run, segment, { body, route }) {
	if (body.missing)
		denyBlank(
			run,
			segment,
			`is read from a file that does not exist: \`${body.missing}\``,
			route,
		);
	if (!body.given || body.hidden) return;
	if (!/[^ \t\n\v\f\r]/.test(body.text))
		denyBlank(run, segment, "is empty", route);
	const selfReview = selfReviewRefusal(body.text);
	if (selfReview)
		deny(
			run.ctx,
			segment,
			`This files an issue whose body reviews its own gate-judge override: @CMD@

It carries ${selfReview}`,
		);
	judgeBasis(run, segment, body.text);
	judgeCheck(run, segment, body.text);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} wrong
 * @param {Route} route
 * @returns {never}
 */
function denyBlank(run, segment, wrong, route) {
	return deny(
		run.ctx,
		segment,
		`This files an issue whose body ${wrong}: @CMD@

${route.blank}`,
	);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} text
 */
function judgeBasis(run, segment, text) {
	const startedAt = run.ctx.now();
	const { refusal, advice } = readGateWrite(text, {
		route: "create-guard",
		leftMs: run.leftMs,
		env: run.ctx.vars,
	});
	run.leftMs -= run.ctx.now() - startedAt;
	if (!refusal) {
		if (advice) run.checkNotes.push(advice);
		return;
	}
	deny(
		run.ctx,
		segment,
		`This files an issue whose body sets a wait with nothing behind it: @CMD@

Ask of the window: what data sets it, and does anything shorter hold? Where the answer is a round figure, cut the window to what the data defends.

It carries ${refusal}`,
	);
}

/**
 * @param {Run} run
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
		.map((l) => ` ${flag} ${shellQuote(`${key}${l}`)}`)
		.join("");
	denyMissing(run, segment, `${fix}${shown}`);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} fix
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

Or file, label and place it in one checked call: node ${run.ctx.scriptPath("file-issue.js")} --title "…" --label takes:… (--parent <n> | --standalone "<why>") --origin <class> (--fault-signature <file> | --no-fault) --body-file - (workflow-core#533, workflow-core#4796).`,
	);
}

/**
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

/** @param {LabelContext} ctx */
const humanRule = (ctx) =>
	`\`takes:human\` means the next action happens OUTSIDE Claude Code ENTIRELY. It is picked from the next ACTION, never from the subject. Name the concrete outside act, one of the founder's own (workflow-core#1077):

  ${readActsLine(ctx)}

A website job no act on that list covers adds a **Tried:** list of at least ${TRIED_MIN} methods that failed.

Add the act to the body, on its own line:

  **${HUMAN_MARKER}** <the act, in plain words>

IF YOU CANNOT WRITE THAT LINE HONESTLY, THE LABEL IS WRONG. Being barred is not the same as being impossible:

  - a skill's own scope barring THIS pass from the edit    → takes:implement
  - a repo rule barring an agent from the act              → takes:wayfinder, to rule on it
  - a command needing a password or a founder keystroke    → the founder types \`! <cmd>\` IN Claude Code; still not outside it
  - reading repo files and writing a ruling                → takes:wayfinder
  - a founder decision or confirmation                     → takes:wayfinder, where the founder makes it
  - applying a prescribed edit                             → takes:implement
  - an act that ends in a repo file                        → takes:implement; the founder's review of it is takes:wayfinder

${ruleOrFallback(ctx, "no-command-opens-shape", "No issue sits under takes:human because no command opens it")}

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#804, mantahostels#2775, mantahostels#3439, mantahostels#3555).`;

/**
 * @param {Run} run
 * @param {string} segment
 * @param {Creation} made
 */
function judgeHumanBody(run, segment, made) {
	if (made.body.hidden)
		denyUnreadBody(run, segment, {
			wrong: "creates a `takes:human` issue whose body this guard cannot read",
			cite: "(workflow-core#668)",
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
 * @param {{ wrong: string, cite: string, passing: string }} refusal
 * @returns {never}
 */
function denyUnreadBody(run, segment, { wrong, cite, passing }) {
	return deny(
		run.ctx,
		segment,
		`This ${wrong}: @CMD@

A \`takes:human\` body must name its outside act, and a body the guard cannot read is one nobody checked ${cite}. ${passing}

${humanRule(run.ctx)}`,
	);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} body
 * @param {string} verb
 */
function judgeHumanText(run, segment, body, verb) {
	const found = outsideLineFault(body);
	if (found?.fault === "NO-OUTSIDE-ACT")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose body names no act performed outside Claude Code: @CMD@

${humanRule(run.ctx)}`,
		);
	if (found?.fault === "BARRED-NOT-IMPOSSIBLE")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose Outside line names a prohibition rather than an act: @CMD@

  ${found.line}

BEING BARRED IS NOT BEING IMPOSSIBLE (mantahostels#2775). The Outside line names what the founder DOES outside Claude Code, one of his own acts (workflow-core#1077): ${readActsLine(run.ctx)}

Before relabelling, TEST the bar rather than restating it:

  - a file you believe unwritable   → \`test -w <path>\`; a home-directory file usually is
  - a rule you believe forbids it   → read the rule; most name a surface, not a filesystem
  - a command wanting a password    → the founder types \`! <cmd>\` IN Claude Code

If the bar is real, it is a repo rule and the issue is \`takes:wayfinder\`, to rule on it. If the bar is not real, the issue is \`takes:implement\`.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#2775, workflow-core#140).`,
		);
	if (found?.fault === "REPO-FILE-ACT")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose outside act produces a file in this repository: @CMD@

  ${found.line}

The rule (mantahostels#3503): ${ruleOrFallback(run.ctx, "repo-file-act", "An act that ends in a repo file is never an outside act")}

  - the file itself                              → takes:implement, and an agent writes it
  - the founder's taste on what the agent drew  → takes:wayfinder, a review in session

Relabel, and drop the tool and the path from the Outside line if a real outside act remains.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (mantahostels#3555).`,
		);
	if (found?.fault === "SURFACE-UNTRIED" || found?.fault === "REFUSED-UNTRIED")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose Outside line ${UNTRIED_FAULTS[found.fault].says}: @CMD@

  ${found.line}

${UNTRIED_FAULTS[found.fault].fix}

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (workflow-core#4142, ruled on workflow-core#3720).`,
		);
	if (found?.fault === "OBSERVE-ONLY")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose Outside line's only founder part is to observe a result: @CMD@

  ${found.line}

A place the act happens, the desktop app or his phone, is not an act. Only where every route below failed, ${TRIED_WAY}.

${ruleOrFallback(run.ctx, "observe-first", "A check by eye or ear is the session's to try first, closing on its own evidence")}`,
		);
	if (found?.fault === "NOT-A-FOUNDER-ACT")
		deny(
			run.ctx,
			segment,
			`This ${verb} whose Outside line names none of the founder's own acts: @CMD@

  ${found.line}

The acts are: ${readActsLine(run.ctx)}

Two ways out:

  - name the act from that list on the Outside line
  - or, for a website job no act on it covers, ${TRIED_WAY}

Neither true means an agent can do it, and the label is wrong.

Rule: docs/agents/triage-labels.md §\`takes:\`, the nuances block (workflow-core#1077, workflow-core#1097).`,
		);
	if (!CLOSE_WHEN_LINE.test(body))
		deny(
			run.ctx,
			segment,
			`This ${verb} whose body has no **Close when:** line: @CMD@

Every founder errand says when it is finished (workflow-core#983). Add it to the body, on its own line:

  ${ruleOrFallback(run.ctx, "close-when-line", "**Close when:** <what finishes it>")}

${deliverableRule(run.ctx)}`,
		);
	run.humanApplied = true;
}

/**
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
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 * @param {GhRepo | null} repo
 */
function judgeEdit(run, cmd, args, repo) {
	const edit = scanEdit(run, args, repo);
	if (!edit?.labels.includes("takes:human")) return;
	if (edit.unreadable) open(run.ctx, UNREAD_NUMBER);
	if (edit.repoHidden)
		open(
			run.ctx,
			"could not read which repo a gh issue edit names — takes:human relabel allowed unchecked",
		);
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
	for (const entry of edit.numbers.entries())
		judgeEditNumber(run, cmd, edit.repo, entry);
}

/**
 * @param {Run} run
 * @param {Command} cmd
 * @param {Edit["repo"]} namedRepo
 * @param {[number, string]} entry
 */
function judgeEditNumber(run, cmd, namedRepo, [i, word]) {
	const ref = issueWord(word, run.parsed.spans);
	if (!ref) return open(run.ctx, UNREAD_NUMBER);
	if (i >= FETCH_CAP)
		return open(
			run.ctx,
			`more than ${FETCH_CAP} issues on one takes:human relabel — #${ref.number} allowed unchecked`,
		);
	const repo = ref.repo || namedRepo;
	if (cmd.cwd === "" && !repo)
		return open(
			run.ctx,
			`could not tell which directory a gh issue edit runs in — #${ref.number}'s takes:human relabel allowed unchecked`,
		);
	const text = fetchBody(run, cmd, ref.number, repo);
	if (text === null)
		return open(
			run.ctx,
			`could not fetch #${ref.number}'s body for a takes:human relabel — relabel allowed unchecked`,
		);
	judgeHumanText(run, cmd.segment, text, `${APPLIES_HUMAN}${ref.number}`);
}

const APPLIES_HUMAN = "applies `takes:human` to #";

const UNREAD_NUMBER =
	"could not read the issue number of a gh issue edit — takes:human relabel allowed unchecked";

/**
 * @typedef {object} Edit
 * @property {Run} run
 * @property {string[]} labels
 * @property {string[]} numbers
 * @property {Body} body
 * @property {boolean} unreadable
 * @property {string} repo
 * @property {boolean} repoHidden
 */

/** @type {(edit: Edit, value: string) => void} */
const editBody = (edit, value) =>
	bodyWord(edit.body, value, edit.run.parsed.spans);
/** @type {(edit: Edit, value: string) => void} */
const editBodyFile = (edit) => {
	edit.body.given = true;
	edit.body.fromFile = true;
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
 * @param {Run} run
 * @param {string[]} args
 * @param {GhRepo | null} repo
 * @returns {Edit | null}
 */
function scanEdit(run, args, repo) {
	/** @type {Edit} */
	const edit = {
		run,
		labels: [],
		numbers: [],
		body: newBody(),
		unreadable: false,
		...seedRepo(repo),
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
 * @param {Run} run
 * @param {Command} cmd
 * @param {string} number
 * @param {string} repo
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
 * @param {Run} run
 * @param {string} segment
 * @returns {never}
 */
function denyUnreadRelabel(run, segment) {
	const issueBody = run.ctx.scriptPath("issue-body.js");
	return denyUnreadBody(run, segment, {
		wrong:
			"applies `takes:human` while rewriting the body in a way this guard cannot read",
		cite: "(workflow-core#669)",
		passing: `Write the line first, then relabel alone — the guard fetches the body the label lands on:

  node ${issueBody} append <n> --text "**Outside Claude Code:** <the act, in plain words>"
  node ${issueBody} append <n> --text "**Close when:** <what finishes it>"
  gh issue edit <n> --add-label takes:human`,
	});
}

/**
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeApi(run, cmd, args) {
	const call = scanApi(args, run.parsed.spans);
	const method = captured(call.method, run.parsed.spans);
	const endpoint = captured(call.endpoint, run.parsed.spans);
	if (method === "" && !defaultsToPost(call)) return;
	if (method && method.toUpperCase() !== "POST") return;
	if (endpoint !== null && isGraphql(endpoint))
		return judgeGraphql(run, cmd.segment, call);
	if (endpoint !== null && !isIssueCollection(endpoint)) return;
	if (method === null || endpoint === null || call.input)
		return open(
			run.ctx,
			"could not read a gh api issue creation — create allowed unchecked",
		);
	if (call.opaque)
		open(
			run.ctx,
			"could not read a field name on a gh api issue creation — create allowed unchecked",
		);
	if (call.fields.filter((f) => isBodyField(f, run.parsed.spans)).length > 1)
		return;
	const repo = endpointRepo(endpoint);
	/** @type {Creation} */
	const made = {
		labels: [],
		body: newBody(),
		repo: repo ?? "",
		repoHidden: repo === null,
		route: {
			cost: API_FORM_COST,
			blank: API_FORM_BLANK,
			fix: "gh api --method POST repos/<owner>/<repo>/issues -f title=…",
			flag: "-f",
			key: "labels[]=",
		},
	};
	readApiFields(run, call, made);
	judgeBody(run, cmd.segment, made);
	judgeLabels(run, cmd.segment, made);
	judgeSecondMap(run, cmd, made);
}

/**
 * @param {Run} run
 * @param {import("./gh-api-call.js").ApiCall} call
 * @param {Creation} made
 */
function readApiFields(run, call, made) {
	for (const field of call.fields)
		readApiField(run, field, call.magicFields.has(field), made);
}

/**
 * @param {Run} run
 * @param {string} field
 * @param {boolean} magic
 * @param {Creation} made
 */
function readApiField(run, field, magic, made) {
	const { text: raw, known } = literal(field, run.parsed.spans);
	const text = trimEndRun(raw, "\n");
	if (text.startsWith("body=")) {
		const value = text.slice("body=".length);
		made.body.given = true;
		if (!known || (magic && value.startsWith("@"))) made.body.hidden = true;
		else made.body.text = magic && value === "null" ? "" : value;
		return;
	}
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
 * @param {Run} run
 * @param {string} segment
 * @param {import("./gh-api-call.js").ApiCall} call
 */
function judgeGraphql(run, segment, call) {
	const { query, hidden } = scanGraphql(call.fields, run.parsed.spans);
	const args = mutationArgs(query, "createIssue");
	if (args === null) return;
	if (hidden || call.opaque || call.input)
		return warnOnce(
			run,
			segment,
			"part of the query is out of sight, so the guard cannot see whether it applies a label",
		);
	if ((args.match(/"/g)?.length ?? 0) % 2)
		return warnOnce(
			run,
			segment,
			"a bracket inside a string literal cut the mutation's arguments short, so the guard cannot see whether a label follows it",
		);
	if (args.includes("input:$"))
		return warnOnce(
			run,
			segment,
			"the mutation's input arrives whole as a variable, so the guard can see no field names at all",
		);
	if (!args.includes("labelIds:[]") && args.includes("labelIds:"))
		return warnOnce(
			run,
			segment,
			"GraphQL takes label NODE IDS rather than names, so nothing on the command says whether any of these `labelIds` is a `takes:` value",
		);
	denyMissing(run, segment, GRAPHQL_FIX);
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} cannot
 */
function warnOnce(run, segment, cannot) {
	if (run.warning) return;
	run.warning = `This files a GitHub issue through GraphQL, and ${cannot}:

  ${unmask(segment)}

Every open issue carries exactly one \`takes:\` value, naming the command that opens it. ${ruleOrFallback(run.ctx, "takes-label-unrouted", "Without one, /pick-next shows `none` in its TAKES column")}

Confirm one of the seven is applied, or file it through the flag form, which the guard can read in full:

${valuesLine()}
  ${GRAPHQL_FIX}

Rule: docs/agents/triage-labels.md §\`takes:\`.`;
}

module.exports = { field: "command", noun: "command", decide };
