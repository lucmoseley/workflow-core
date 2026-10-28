/*
 * research-ladder.js — which rungs of the research ladder a session's tool
 * calls tried, and the refusal that names the rest (#2006; spec #1995 §The
 * research ladder).
 *
 * A QUALIFYING CALL, one per rung being enough and its content never judged:
 *   rulings   a Bash call running `gh issue list` with `--search` and a
 *             `--state` of closed or all, or `gh search issues` not narrowed
 *             to open issues, on a corpus tracker — one naming no repo
 *             searches the host's own, which the corpus follows
 *   web       a WebSearch or WebFetch call
 *   subagent  an Agent call (`Task`, its older name, too)
 *
 * Commands are read through shell-parse.js, an unquoted `$(…)` and each side
 * of `&&` included. RESIDUALS: a `gh` call inside a quoted `"$(…)"`, backticks,
 * `bash -c`, `eval`, a script or an alias, or behind a wrapper shell-words.js's
 * unwrap does not strip (`timeout`, `watch`), is unseen; and a repo named by a
 * shell variable never matches the corpus.
 */

const { scriptPath } = require("./script-path.js");
const {
	parseCommand,
	walkCommands,
	TEXT_ONLY_PORTS,
} = require("./shell-parse.js");
const { requiredGroup } = require("./regex-group.js");
const { ghWords, literal } = require("./shell-words.js");

/** @typedef {"rulings" | "web" | "subagent"} Rung */
/** @typedef {import("./tool-calls-since").ToolCall} ToolCall */
/** @typedef {Record<Rung, number>} RungCounts */
/** @typedef {string[] | null} Corpus `owner/name` trackers, null where the
 *   config would not read */

/** @type {Rung[]} */
const RUNGS = ["rulings", "web", "subagent"];

const RUNG_NAME = {
	rulings: "rung 1, past rulings",
	web: "rung 2, web or vendor docs",
	subagent: "rung 3, a fresh subagent",
};

/* The budgets the refusal states: ceilings it advises, never enforced. Rungs
 * 2 and 3 are sourced at spec #1995 §The research ladder; rung 1's is
 * untraced there. */
const RULINGS_BUDGET = 5;
const WEB_BUDGET = 10;
const SUBAGENT_BUDGET = 15;

/**
 * Each value `args` gives a flag, `--name v`, `--name=v` and `-x v` alike.
 * @param {string[]} args
 * @param {string[]} names the flag's spellings, `--state` and `-s`
 * @returns {string[]}
 */
function parseFlagValues(args, names) {
	/** @type {string[]} */
	const values = [];
	let isValue = false;
	for (const [i, arg] of args.entries()) {
		if (isValue) {
			isValue = false;
			continue;
		}
		const eq = arg.indexOf("=");
		const next = args[i + 1];
		if (eq > 0 && names.includes(arg.slice(0, eq)))
			values.push(arg.slice(eq + 1));
		else if (names.includes(arg) && next !== undefined) {
			values.push(next);
			isValue = true;
		}
	}
	return values;
}

/* The flags `gh search issues` reads a value from, so their values are not
 * taken for query words. */
const SEARCH_VALUE_FLAGS =
	/^(?:-[RLs]|--(?:repo|owner|state|limit|label|author|assignee|mentions|commenter|involves|language|milestone|app|match|sort|order|created|updated|closed|comments|interactions|reactions|team-mentions|visibility|json|jq|template))$/;

/**
 * Whether `repos` and `owners` reach a corpus tracker: either naming none —
 * the host's own tracker for `gh issue list`, every repo for `gh search` —
 * or one naming a corpus tracker or its owner. An unread corpus is reached
 * by any.
 * @param {string[]} repos
 * @param {string[]} owners
 * @param {Corpus} corpus
 */
function isOnCorpus(repos, owners, corpus) {
	if (corpus === null) return true;
	if (repos.length === 0 && owners.length === 0) return true;
	const trackers = corpus.map((t) => t.toLowerCase());
	const corpusOwners = trackers.map((t) => t.split("/")[0]);
	return (
		repos.some((r) => trackers.includes(r.toLowerCase())) ||
		owners.some((o) => corpusOwners.includes(o.toLowerCase()))
	);
}

/**
 * @param {string[]} args the words after `gh issue list`
 * @param {Corpus} corpus
 */
function isRulingsList(args, corpus) {
	if (parseFlagValues(args, ["--search", "-S"]).length === 0) return false;
	const states = parseFlagValues(args, ["--state", "-s"]);
	if (!states.some((s) => s === "closed" || s === "all")) return false;
	return isOnCorpus(parseFlagValues(args, ["--repo", "-R"]), [], corpus);
}

/**
 * @param {string[]} args the words after `gh search issues`
 * @param {Corpus} corpus
 */
function isRulingsSearch(args, corpus) {
	if (parseFlagValues(args, ["--state"]).includes("open")) return false;
	/** @type {string[]} */
	const query = [];
	let isValue = false;
	for (const arg of args) {
		if (isValue) isValue = false;
		else if (SEARCH_VALUE_FLAGS.test(arg)) isValue = true;
		else if (!arg.startsWith("-")) query.push(...arg.split(/\s+/));
	}
	if (query.some((q) => /^(?:is|state):open$/i.test(q))) return false;
	const qualifier = (/** @type {RegExp} */ re) =>
		query.flatMap((q) => {
			const m = q.match(re);
			return m ? [requiredGroup(m, 1, re)] : [];
		});
	return isOnCorpus(
		[...parseFlagValues(args, ["--repo", "-R"]), ...qualifier(/^repo:(\S+)$/i)],
		[
			...parseFlagValues(args, ["--owner"]),
			...qualifier(/^(?:user|org):(\S+)$/i),
		],
		corpus,
	);
}

/**
 * Whether a Bash command searches past rulings on a corpus tracker.
 * @param {string} command
 * @param {Corpus} corpus
 */
function isRulingsCommand(command, corpus) {
	const parsed = parseCommand(command);
	const read = (/** @type {string} */ w) => literal(w, parsed.spans).text;
	let found = false;
	walkCommands(
		parsed,
		(cmd) => {
			const gh = found ? null : ghWords(cmd.words, parsed.spans);
			if (!gh) return;
			const [sub, verb, ...args] = gh.args.map(read);
			if (gh.repo) args.push("--repo", read(gh.repo));
			found =
				(sub === "issue" && verb === "list" && isRulingsList(args, corpus)) ||
				(sub === "search" &&
					verb === "issues" &&
					isRulingsSearch(args, corpus));
		},
		TEXT_ONLY_PORTS,
	);
	return found;
}

/**
 * The rung one tool call tries, or null.
 * @param {ToolCall} call
 * @param {Corpus} corpus
 * @returns {Rung | null}
 */
function rungOf({ name, input }, corpus) {
	if (name === "WebSearch" || name === "WebFetch") return "web";
	if (name === "Agent" || name === "Task") return "subagent";
	if (
		name === "Bash" &&
		typeof input.command === "string" &&
		isRulingsCommand(input.command, corpus)
	)
		return "rulings";
	return null;
}

/**
 * Qualifying calls per rung.
 * @param {ToolCall[]} calls
 * @param {Corpus} corpus
 * @returns {RungCounts}
 */
function rungCounts(calls, corpus) {
	/** @type {RungCounts} */
	const counts = { rulings: 0, web: 0, subagent: 0 };
	for (const call of calls) {
		const rung = rungOf(call, corpus);
		if (rung) counts[rung]++;
	}
	return counts;
}

/**
 * @param {RungCounts} counts
 * @returns {Rung[]} the rungs with no qualifying call, in ladder order
 */
const missingRungs = (counts) => RUNGS.filter((rung) => counts[rung] === 0);

/**
 * The method for each missing rung, in ladder order.
 * @param {Rung[]} missing
 * @param {Corpus} corpus
 */
function buildRungSteps(missing, corpus) {
	const trackers = corpus
		? corpus.map((t) => `\`${t}\``).join(", ")
		: `\`node ${scriptPath("lib/workflow-core-config.js")} corpus\` lists them`;
	const steps = {
		rulings:
			`${RUNG_NAME.rulings}: search the founder's past rulings on every corpus tracker (${trackers}) — ` +
			'`gh search issues --repo <tracker> "<terms>"`, or `gh issue list --repo <tracker> --state all --search "<terms>"`; ' +
			`an open-only search does not count. Up to ${RULINGS_BUDGET} calls across them.`,
		web:
			`${RUNG_NAME.web}: a WebSearch or WebFetch on the fact that decides the pair; ` +
			`a local read of vendor code does not count. Up to ${WEB_BUDGET} calls.`,
		subagent:
			`${RUNG_NAME.subagent}: one Agent call, told to use at most ${SUBAGENT_BUDGET} tool calls, ` +
			"its prompt your evidence so far as a list, the rulings the first rung found, and: " +
			'"find the single fact that makes the runner-up win, and cite the tool result".',
	};
	return missing.map((rung) => `- ${steps[rung]}`).join("\n");
}

/**
 * The research-ladder refusal.
 * @param {string[]} lines one per refused question, naming its missing rungs
 * @param {{ missing: Rung[], corpus: Corpus, last: string | null }} opts
 *   `missing`, every rung some refused question lacks; `last`, the
 *   last-refusal line where this refusal spends the cap
 */
function buildLadderReason(lines, { missing, corpus, last }) {
	return (
		"This turn re-sends a question the close-rivals check refused, and a test " +
		"still catches it — its top two rivals still close, or no option still " +
		"likely right — but the research ladder is not climbed:\n\n" +
		lines.join("\n") +
		"\n\nA still-caught re-send passes only once each rung of the ladder shows " +
		"a tool call since the first refusal. Climb the missing rungs in this " +
		"order, cheapest first, stopping as soon as one settles the question — a " +
		"re-send no test catches passes:\n\n" +
		buildRungSteps(missing, corpus) +
		"\n\n" +
		(last ? `${last}\n\n` : "") +
		"After the ladder, a choice that is neither a house decision nor an act " +
		"hard to undo or seen outside is not sent to the founder at all: take " +
		"your recommended option and record it with " +
		`\`node ${scriptPath("record-delegated-decision.js")} <n> …\`, its rungs and what ` +
		"each found."
	);
}

/**
 * One refused question's line.
 * @param {string} number its round number
 * @param {Rung[]} missing
 */
const buildLadderLine = (number, missing) =>
	`Q${number}: still caught, with no call since the refusal on ${missing.map((r) => RUNG_NAME[r]).join(", ")}.`;

module.exports = {
	RUNGS,
	rungCounts,
	missingRungs,
	buildLadderLine,
	buildLadderReason,
};
