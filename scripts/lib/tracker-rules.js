const { SPACE, bodyFileWord, bodyWord, newBody } = require("./gh-body.js");
const { ISSUE_VALUE_FLAGS } = require("./gh-issue-ref.js");
const { expandHome } = require("./home-path.js");
const { NOT_READY_OPENING } = require("./prose-blockers.js");
const { isJobDir } = require("./job-dir.js");
const { readJobDir } = require("./job-paths.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { ghCall, literal, scanFlags } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");
const { URGENT_LABEL } = require("./urgent-label.js");

/**
 * @typedef {import("./core-contract.js").CoreContext & {
 *  readFile: (path: string) => string | undefined,
 * }} TrackerContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {{ parsed: Parsed, ctx: TrackerContext, jobDirSeen: boolean,
 *  cmd: Command }} Call
 * @typedef {(words: string[], call: Call) => boolean} Predicate
 */

const PRELUDE_LATCH = "tracker-rules-prelude";

const PRELUDE =
	"This call engages tracker rules THIS repo authors and the vendored skills do not carry — docs/agents/issue-tracker.md and docs/agents/triage-labels.md are their home, and the vendored defaults are not this repo's.";

const ISSUE_BODY_SUBCOMMANDS = new Set([
	"append",
	"append-section",
	"append-decision",
	"delete-lines",
	"tick",
	"annotate",
	"replace",
]);

/** @param {string | undefined} word @param {string[]} spans */
const lit = (word, spans) => literal(word ?? "", spans).text;

/** @param {string} p */
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

/** @param {string[]} words @param {string[]} flags */
const hasFlag = (words, flags) =>
	words.some((w) =>
		flags.some((f) => w === f || (f.startsWith("--") && w.startsWith(`${f}=`))),
	);

const BODY_FLAGS = ["--body", "--body-file", "-b", "-F"];
/** @type {Predicate} */
const writesBody = (words) =>
	words.some((w) => BODY_FLAGS.some((f) => w === f || w.startsWith(`${f}=`)));

/** @type {Predicate} */
const addsAssignee = (words) => hasFlag(words, ["--add-assignee"]);

const DEPENDENCY_ENDPOINT =
	/\/dependencies\/blocked_by|\/dependencies\/blocking|\/sub_issue$|\/sub_issue\?|\/sub_issues/s;
// `gh api`'s value-taking flags: https://cli.github.com/manual/gh_api
const API_VALUE_FLAGS =
	"--cache -F --field -H --header --hostname --input -q --jq -X --method -p --preview -f --raw-field -t --template";
/** @type {Predicate} */
const dependencyEndpoint = (words, { parsed }) => {
	let endpoint = "";
	scanFlags(API_VALUE_FLAGS, words.slice(1), (kind, _name, value) => {
		if (kind !== "arg") return;
		endpoint = value;
		return false;
	});
	return DEPENDENCY_ENDPOINT.test(lit(endpoint, parsed.spans));
};

/** @type {Predicate} */
const jobDirPath = (_words, { jobDirSeen }) => jobDirSeen;

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

const CHECK_RUNS = /statusCheckRollup|\/check-runs/;
/** @type {Predicate} */
const readsCheckRuns = (words, { parsed }) =>
	CHECK_RUNS.test(parsed.subject) &&
	words.some((w) => CHECK_RUNS.test(lit(w, parsed.spans)));

/** @type {Predicate} */
const namesCommit = (words) => hasFlag(words, ["--commit", "-c"]);

/** @type {Predicate} */
const readsComments = (words) => hasFlag(words, ["--comments", "-c"]);

/** @param {string[]} words @param {string[]} spans */
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
	const text = trimEndRun(out.join("\n"), "\n");
	return text === "" ? [] : text.split("\n");
}

/** @type {Predicate} */
const editsLabels = (words, { parsed }) =>
	labelEdits(words, parsed.spans).length > 0;

/** @type {Predicate} */
const labelsUrgent = (words, { parsed }) =>
	labelEdits(words, parsed.spans).includes(URGENT_LABEL);
/** @type {Predicate} */
const labelsWaiting = (words, { parsed }) =>
	labelEdits(words, parsed.spans).some((l) => l.startsWith("waiting:"));

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
	[["issue", "edit"], jobDirPath, ["gh-job-dir-unreadable"]],
	[["issue", "close"], jobDirPath, ["gh-job-dir-unreadable"]],
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

const API_BODY_FLAGS = "-F --field --input";

/** @param {string[]} args @param {string[]} spans */
function ghBodyPaths(args, spans) {
	/** @type {string[]} */
	const found = [];
	const [group = "", sub = ""] = args;
	if (group === "api") {
		scanFlags(API_BODY_FLAGS, args.slice(1), (kind, name, value) => {
			if (kind !== "opt") return;
			const text = lit(value, spans);
			if (name === "--input") found.push(text);
			else if (text.includes("=@"))
				found.push(text.slice(text.indexOf("=@") + 2));
		});
	} else if (group === "issue" && Object.hasOwn(ISSUE_VALUE_FLAGS, sub)) {
		const spec =
			ISSUE_VALUE_FLAGS[/** @type {keyof typeof ISSUE_VALUE_FLAGS} */ (sub)];
		scanFlags(spec, args.slice(2), (kind, name, value) => {
			if (kind === "opt" && (name === "-F" || name === "--body-file"))
				found.push(lit(value, spans));
		});
	}
	return found;
}

/** @param {string[]} words @param {string[]} spans */
function bodyPathWords(words, spans) {
	const [head = "", ...args] = words;
	if (basename(lit(head, spans)) === "cat")
		return args.map((w) => lit(w, spans)).filter((t) => !t.startsWith("-"));
	const gh = ghCall(words, spans);
	return gh ? ghBodyPaths(gh.args, spans) : [];
}

/** @param {Parsed} parsed @param {TrackerContext} ctx */
function scanJobDir(parsed, ctx) {
	if (!parsed.subject.includes("gh")) return false;
	const jobDir = readJobDir(ctx.env) ?? "";
	const home = ctx.vars.HOME ?? "";
	let seen = false;
	walkCommands(
		parsed,
		(cmd) => {
			for (const run of cmd.runs()) {
				const [cwd] = run.dirs();
				const where = { pwd: cwd || ctx.fallbackCwd, jobDir };
				seen ||= bodyPathWords(run.words, parsed.spans).some((text) => {
					if (text.startsWith("$") && !text.includes("CLAUDE_JOB_DIR"))
						return false;
					return isJobDir(expandHome(text, home) ?? text.slice(1), where);
				});
			}
		},
		ctx,
	);
	return seen;
}

/** @param {Command} cmd @param {Set<string>} matched @param {Omit<Call, "cmd">} call */
function judge(cmd, matched, call) {
	const { spans } = call.parsed;
	for (const { words, dirs } of cmd.runs()) {
		if (runsIssueBody(words, spans)) matched.add("issue-body-success-signal");
		const gh = ghCall(words, spans);
		if (!gh) continue;
		const [cwd] = dirs();
		matchRows(gh.args, { ...call, cmd: { ...cmd, cwd } }, matched);
	}
}

/** @param {string[]} args @param {Call} call @param {Set<string>} matched */
function matchRows(args, call, matched) {
	for (const [subcmd, pred, ids] of TRIGGERS) {
		if (!subcmd.every((s, i) => args[i] === s)) continue;
		if (pred && !pred(args, call)) continue;
		for (const id of ids) matched.add(id);
	}
}

/** @param {string[]} words @param {string[]} spans */
const runsIssueBody = (words, spans) =>
	words.some(
		(w, i) =>
			w.includes("issue-body.js") &&
			basename(lit(w, spans)) === "issue-body.js" &&
			ISSUE_BODY_SUBCOMMANDS.has(lit(words[i + 1], spans)),
	);

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
	const framing = ctx.told(PRELUDE_LATCH)
		? {}
		: { prelude: ctx.corePaths(PRELUDE), latchAfter: PRELUDE_LATCH };
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
