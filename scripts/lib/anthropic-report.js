const {
	apiPath,
	defaultsToPost,
	isGraphql,
	scanApi,
	scanGraphql,
} = require("./gh-api-call.js");
const {
	deny,
	open,
	ruleOrFallback,
	walkVerdict,
} = require("./guard-verdict.js");
const { parseCommand } = require("./shell-parse.js");
const { dispatchingGhCall, literal } = require("./shell-words.js");
const { requiredGroup } = require("./regex-group.js");
const { repoSlug } = require("./workflow-core-config.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} ReportPorts
 * @property {(cwd: string) => string} remotes
 * @typedef {import("./kit-context.js").KitContext & ReportPorts} ReportContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./shell-words.js").GhRepo} GhRepo
 * @typedef {import("./shell-words.js").GhCall} GhCall
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

const TEXT_FLAGS = new Set(
	"-b --body -t --title -F --body-file -l --label --add-label --remove-label -a --assignee --add-assignee --remove-assignee -m --milestone -p --project --add-project --remove-project -B --base -H --head -r --reviewer --add-reviewer --remove-reviewer -T --template -c --comment --reason".split(
		" ",
	),
);

const READS = new Set([
	"issue:list",
	"issue:view",
	"issue:status",
	"pr:list",
	"pr:view",
	"pr:status",
	"pr:checks",
	"pr:diff",
	"pr:checkout",
]);

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * @typedef {object} Run
 * @property {Parsed} parsed
 * @property {ReportContext} ctx
 * @property {string | null} exported
 * @property {boolean} unsettled
 */

const UNSETTLED =
	"could not tell which directory a gh write runs in — its clone's remotes unchecked for an Anthropic repo";

/**
 * @param {string} command
 * @param {ReportContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	/** @type {Run} */
	const run = {
		parsed: parseCommand(command),
		ctx,
		exported: "",
		unsettled: false,
	};
	const verdict = walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx);
	if (verdict === undefined && run.unsettled) ctx.log(UNSETTLED);
	return verdict ?? null;
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} repo
 * @returns {never}
 */
function refuseRepo(run, segment, repo) {
	const rule = ruleOrFallback(
		run.ctx,
		"anthropic-report",
		"Nothing is reported or requested to Anthropic",
	);
	return deny(
		run.ctx,
		segment,
		`This writes to an Anthropic repo (${repo}): @CMD@\n\n${rule}`,
	);
}

/**
 * @param {Run} run
 * @param {string} word
 */
function captured(run, word) {
	return capturedRead(literal(word, run.parsed.spans));
}

/** @param {GhRepo} read */
const capturedRead = ({ text, known }) =>
	known ? trimEndRun(text, "\n") : null;

/** @param {string} spec */
const anthropicRepo = (spec) =>
	spec !== "" && /^anthropics\/[^/]+$/.test(repoSlug(spec));

const URL_RE =
	/^(https?:\/\/)?(www\.)?github\.com\/(anthropics\/[^/]+)\/(issues|pull)\/[0-9]+\/?(#\S*)?$/;

/** @param {string} word */
function urlRepo(word) {
	const m = URL_RE.exec(word.toLowerCase());
	return m ? requiredGroup(m, 3, URL_RE) : null;
}

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	if (cmd.words[0] === "export") noteExport(run, cmd.words);
	for (const { words, wrapperWords, dirs } of cmd.runs()) {
		const gh = dispatchingGhCall(words, run.parsed.spans);
		if (!gh) continue;
		const cwds = dirs();
		const at = {
			...cmd,
			leading: [...cmd.leading, ...wrapperWords],
			cwd: cwds[0],
			cwds,
		};
		const group = captured(run, gh.args[0] ?? "");
		if (group === "issue" || group === "pr") judgeFlagForm(run, at, group, gh);
		else if (group === "api") judgeApi(run, at, gh.args.slice(1));
	}
}

/**
 * @param {Run} run
 * @param {string[]} words
 */
function noteExport(run, words) {
	for (const w of words.slice(1))
		if (w.startsWith("GH_REPO="))
			run.exported = captured(run, w.slice("GH_REPO=".length));
}

/**
 * @param {Run} run
 * @param {Command} cmd
 * @param {string} group
 * @param {GhCall} gh
 */
function judgeFlagForm(run, cmd, group, { args: words, repo: before }) {
	const args = words.slice(1);
	const sub = captured(run, args[0] ?? "");
	if (!sub || READS.has(`${group}:${sub}`)) return;
	/** @type {Scan} */
	const scan = {
		run,
		cmd,
		args,
		named: before !== null,
		repo: (before && capturedRead(before)) ?? "",
		hidden: before !== null && !before.known,
	};
	for (let i = 1; i < args.length; ) {
		const step = readArg(scan, i);
		if (step === 0) break;
		i += step;
	}
	if (!scan.named) return judgeUnnamed(run, cmd);
	if (scan.hidden || scan.repo.includes("$"))
		return open(
			run.ctx,
			`could not read the --repo of a gh ${group} ${sub} — allowed unchecked for an Anthropic repo`,
		);
	if (anthropicRepo(scan.repo)) refuseRepo(run, cmd.segment, scan.repo);
}

/**
 * @typedef {object} Scan
 * @property {Run} run
 * @property {Command} cmd
 * @property {string[]} args
 * @property {boolean} named
 * @property {string} repo
 * @property {boolean} hidden
 */

/**
 * @param {Scan} scan
 * @param {number} i
 */
function readArg(scan, i) {
	const word = captured(scan.run, scan.args[i] ?? "") ?? "";
	if (word === "--") return 0;
	const repoStep = readRepoFlag(scan, i, word);
	if (repoStep !== null) return repoStep;
	if (TEXT_FLAGS.has(word)) return i + 1 < scan.args.length ? 2 : 0;
	const url = word.startsWith("-") ? null : urlRepo(word);
	if (url) refuseRepo(scan.run, scan.cmd.segment, url);
	return 1;
}

const LONG_REPO_RE = /^--repo=(.*)$/s;
const SHORT_REPO_RE = /^-R(.+)$/s;

/**
 * @param {Scan} scan
 * @param {number} i
 * @param {string} word
 */
function readRepoFlag(scan, i, word) {
	if (word === "-R" || word === "--repo") {
		const next = captured(scan.run, scan.args[i + 1] ?? "");
		if (next === null) scan.hidden = true;
		else scan.repo = next;
		scan.named = scan.repo !== "" || scan.hidden;
		return i + 1 < scan.args.length ? 2 : 0;
	}
	const long = LONG_REPO_RE.exec(word);
	const short = long ? null : SHORT_REPO_RE.exec(word);
	if (long) scan.repo = requiredGroup(long, 1, LONG_REPO_RE);
	else if (short) scan.repo = requiredGroup(short, 1, SHORT_REPO_RE);
	else return null;
	scan.named = scan.repo !== "" || scan.hidden;
	return 1;
}

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function judgeUnnamed(run, cmd) {
	const env = ghRepoEnv(run, cmd);
	if (env === null)
		return open(
			run.ctx,
			"could not read GH_REPO on a gh write — allowed unchecked for an Anthropic repo",
		);
	if (env !== "") {
		if (anthropicRepo(env)) refuseRepo(run, cmd.segment, env);
		return;
	}
	const repo = cloneRepo(run, cmd);
	if (repo) refuseRepo(run, cmd.segment, repo);
}

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function ghRepoEnv(run, cmd) {
	const set = cmd.leading.findLast((w) => w.startsWith("GH_REPO="));
	if (set !== undefined) return captured(run, set.slice("GH_REPO=".length));
	if (run.exported !== "") return run.exported;
	return cmd.resolveWord("$GH_REPO") ?? "";
}

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function cloneRepo(run, cmd) {
	for (const cwd of cmd.cwds) {
		if (!cwd) continue;
		for (const line of run.ctx.remotes(cwd).split("\n")) {
			const url = line.trim().split(/[ \t]+/)[1] ?? "";
			if (anthropicRepo(url)) return repoSlug(url);
		}
	}
	if (cmd.cwds.includes("")) run.unsettled = true;
	return null;
}

const REPOS_PATH_RE = /^repos\/([^/]+)\/([^/]+)(\/|$)/;

/**
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeApi(run, cmd, args) {
	const call = scanApi(args, run.parsed.spans);
	const method = captured(run, call.method);
	if (method === "" && !defaultsToPost(call)) return;
	if (method && !WRITE_METHODS.includes(method.toUpperCase())) return;
	const endpoint = captured(run, call.endpoint);
	if (endpoint === null)
		return open(
			run.ctx,
			"could not read a gh api endpoint — allowed unchecked for an Anthropic repo",
		);
	if (isGraphql(endpoint)) return judgeGraphql(run, cmd, args, call);
	const m = REPOS_PATH_RE.exec(apiPath(endpoint));
	if (!m) return;
	const owner = requiredGroup(m, 1, REPOS_PATH_RE);
	const name = requiredGroup(m, 2, REPOS_PATH_RE);
	if (/^(\{owner\}|:owner)$/.test(owner)) return judgeUnnamed(run, cmd);
	if (anthropicRepo(`${owner}/${name}`))
		refuseRepo(run, cmd.segment, `${owner}/${name}`);
}

const NAMES_ANTHROPICS_RE =
	/(^|[^a-z0-9-])(anthropics\/[a-z0-9._-]+|anthropics)/;

/**
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 * @param {import("./gh-api-call.js").ApiCall} call
 */
function judgeGraphql(run, cmd, args, call) {
	const { query, hidden } = scanGraphql(call.fields, run.parsed.spans);
	const mutation = query.includes("mutation");
	if (!mutation && !hidden) return;
	const text = args
		.map((w) => ` ${trimEndRun(literal(w, run.parsed.spans).text, "\n")}`)
		.join("");
	const m = NAMES_ANTHROPICS_RE.exec(text.toLowerCase());
	if (!m) return;
	if (mutation)
		refuseRepo(run, cmd.segment, requiredGroup(m, 2, NAMES_ANTHROPICS_RE));
	return open(
		run.ctx,
		"a gh api graphql call naming anthropics carries a query the guard cannot read — allowed unchecked",
	);
}

module.exports = { field: "command", noun: "command", decide };
