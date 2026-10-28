/*
 * anthropic-report.js — the guard-anthropic-report core (#2798, programme
 * #2733): does a Bash call write to an `anthropics/*` repo?
 *
 * A CORE: it does no I/O. The rule store and the clone's remotes arrive as
 * ports; lib/anthropic-report-host.js builds the real ones.
 *
 * THE FIRST VERDICT ENDS THE CALL. A deny stops the walk, and so does a
 * fail-open, which is logged and lets the whole call through unjudged.
 *
 * NARROWED by its lib/guard-cores.json row to `if: Bash(*gh *)`, unanchored so
 * a `timeout`/`env`/`nohup` prefix still reaches the walker that steps past it
 * (#3224).
 */

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
const { ghWords, literal, unwrap } = require("./shell-words.js");
const { requiredGroup } = require("./regex-group.js");
const { repoSlug } = require("./workflow-core-config.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} ReportPorts
 * @property {(cwd: string) => string} remotes `git -C <cwd> remote -v`'s
 *   stdout, "" where git cannot answer
 * @typedef {import("./kit-context.js").KitContext & ReportPorts} ReportContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

/* The issue and pr flags whose value is free text or a name, skipped. */
const TEXT_FLAGS = new Set(
	"-b --body -t --title -F --body-file -l --label --add-label --remove-label -a --assignee --add-assignee --remove-assignee -m --milestone -p --project --add-project --remove-project -B --base -H --head -r --reviewer --add-reviewer --remove-reviewer -T --template -c --comment --reason".split(
		" ",
	),
);

/* `gh <group> <sub>` pairs that read; every other subcommand is a write. */
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
 * @typedef {object} Run one call's judging
 * @property {Parsed} parsed
 * @property {ReportContext} ctx
 * @property {string | null} exported an earlier `export GH_REPO=…` in the
 *   same command, which the walk's own assignment harvest does not see: ""
 *   where none, null where one was set but cannot be read
 */

/**
 * @param {string} command
 * @param {ReportContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	/** @type {Run} */
	const run = { parsed: parseCommand(command), ctx, exported: "" };
	return walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx) ?? null;
}

/**
 * Refuse, naming the repo, with the stored rule.
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
	deny(
		run.ctx,
		segment,
		`This writes to an Anthropic repo (${repo}): @CMD@\n\n${rule}`,
	);
}

/**
 * A word read back as the shell hands it over, a command substitution's
 * trailing newlines off; null where any of it cannot be recovered.
 * @param {Run} run
 * @param {string} word
 */
function captured(run, word) {
	const { text, known } = literal(word, run.parsed.spans);
	return known ? trimEndRun(text, "\n") : null;
}

/**
 * Is `spec`, a repo as gh reads it, a github.com repo owned by `anthropics`?
 * A repo on another host keeps its host prefix in repoSlug, so never matches.
 * @param {string} spec
 */
const anthropicRepo = (spec) =>
	spec !== "" && /^anthropics\/[^/]+$/.test(repoSlug(spec));

const URL_RE =
	/^(https?:\/\/)?(www\.)?github\.com\/(anthropics\/[^/]+)\/(issues|pull)\/[0-9]+\/?(#\S*)?$/;

/**
 * The anthropics/<repo> an issue or PR URL names. Anchored at both ends, so a
 * body citing an upstream issue in prose is no target.
 * @param {string} word
 */
function urlRepo(word) {
	const m = URL_RE.exec(word.toLowerCase());
	return m ? requiredGroup(m, 3, URL_RE) : null;
}

/**
 * One command the call runs: `gh issue <sub>`, `gh pr <sub>` and `gh api`.
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	if (cmd.words[0] === "export") noteExport(run, cmd.words);
	const gh = ghWords(cmd.words, run.parsed.spans);
	if (!gh) return;
	const group = captured(run, gh.args[0] ?? "");
	if (group === "issue" || group === "pr")
		judgeFlagForm(run, cmd, group, gh.args.slice(1));
	else if (group === "api") judgeApi(run, cmd, gh.args.slice(1));
}

/**
 * @param {Run} run accumulator: exported is set by each `GH_REPO=` the
 *   export carries
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
 * @param {string[]} args
 */
function judgeFlagForm(run, cmd, group, args) {
	const sub = captured(run, args[0] ?? "");
	if (!sub || READS.has(`${group}:${sub}`)) return;
	/** @type {Scan} */
	const scan = { run, cmd, args, named: false, repo: "", hidden: false };
	for (let i = 1; i < args.length; ) {
		const step = readArg(scan, i);
		if (step === 0) break;
		i += step;
	}
	if (!scan.named) return judgeUnnamed(run, cmd);
	if (scan.hidden || scan.repo.includes("$"))
		open(
			run.ctx,
			`could not read the --repo of a gh ${group} ${sub} — allowed unchecked for an Anthropic repo`,
		);
	if (anthropicRepo(scan.repo)) refuseRepo(run, cmd.segment, scan.repo);
}

/**
 * @typedef {object} Scan a flag-form call's arguments, and the repo they name
 * @property {Run} run
 * @property {Command} cmd
 * @property {string[]} args from <sub> on
 * @property {boolean} named it carries `-R`/`--repo`
 * @property {string} repo the last one's value
 * @property {boolean} hidden some `-R` value cannot be read
 */

/**
 * Read the argument at `i`, refusing on an Anthropic issue or PR URL: how
 * many words it took, 0 where the scan stops.
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
 * A `-R`/`--repo` at `i`, in any of its three spellings: how many words it
 * took, 0 where it ran out of words, null where `word` is no repo flag.
 * @param {Scan} scan accumulator: named, repo and hidden are set by a repo flag
 * @param {number} i
 * @param {string} word
 */
function readRepoFlag(scan, i, word) {
	if (word === "-R" || word === "--repo") {
		scan.named = true;
		const next = captured(scan.run, scan.args[i + 1] ?? "");
		if (next === null) scan.hidden = true;
		else scan.repo = next;
		return i + 1 < scan.args.length ? 2 : 0;
	}
	const long = LONG_REPO_RE.exec(word);
	const short = long ? null : SHORT_REPO_RE.exec(word);
	if (long) scan.repo = requiredGroup(long, 1, LONG_REPO_RE);
	else if (short) scan.repo = requiredGroup(short, 1, SHORT_REPO_RE);
	else return null;
	scan.named = true;
	return 1;
}

/**
 * A write whose repo the command did not name: GH_REPO, then the clone.
 * @param {Run} run
 * @param {Command} cmd
 */
function judgeUnnamed(run, cmd) {
	const env = ghRepoEnv(run, cmd);
	if (env === null)
		open(
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
 * The GH_REPO the command runs with: an assignment it carries, by leading
 * assignment or `env`, else an earlier export, the command string's own
 * earlier assignments and the environment. Null where it is set but cannot be
 * read; "" where it is unset.
 * @param {Run} run
 * @param {Command} cmd
 */
function ghRepoEnv(run, cmd) {
	const { wrapperWords } = unwrap(cmd.words, run.parsed.spans);
	for (const w of [...cmd.leading, ...wrapperWords])
		if (w.startsWith("GH_REPO="))
			return captured(run, w.slice("GH_REPO=".length));
	if (run.exported !== "") return run.exported;
	return cmd.resolveWord("$GH_REPO") ?? "";
}

/**
 * The anthropics repo the clone the command runs in has a remote on; null
 * where it has none. ANY remote counts, gh choosing among them by rules the
 * command does not show.
 * @param {Run} run
 * @param {Command} cmd
 */
function cloneRepo(run, cmd) {
	if (!cmd.cwd)
		open(
			run.ctx,
			"could not tell which directory a gh write runs in — its clone's remotes unchecked for an Anthropic repo",
		);
	for (const line of run.ctx.remotes(cmd.cwd).split("\n")) {
		const url = line.trim().split(/[ \t]+/)[1] ?? "";
		if (anthropicRepo(url)) return repoSlug(url);
	}
	return null;
}

const REPOS_PATH_RE = /^repos\/([^/]+)\/([^/]+)(\/|$)/;

/**
 * `gh api …`, from the words after `api`.
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeApi(run, cmd, args) {
	const call = scanApi(args);
	/* The method and endpoint are read back through literal: the splitter
	 * blanks every quoted span, so a quoted endpoint would otherwise walk past.
	 * A method it cannot read is judged as a write. */
	const method = captured(run, call.method);
	if (method === "" && !defaultsToPost(call)) return;
	if (method && !WRITE_METHODS.includes(method.toUpperCase())) return;
	const endpoint = captured(run, call.endpoint);
	if (endpoint === null)
		open(
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
 * `gh api graphql …`: a mutation is a write, and its target is a node id the
 * command cannot show, so the call is refused where it spells `anthropics`.
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
	open(
		run.ctx,
		"a gh api graphql call naming anthropics carries a query the guard cannot read — allowed unchecked",
	);
}

module.exports = { field: "command", noun: "command", decide };
