const { scriptPath } = require("./script-path.js");
const {
	ghWords,
	parseCommand,
	walkCommands,
	TEXT_ONLY_PORTS,
} = require("./shell-parse.js");
const { requiredGroup } = require("./regex-group.js");
const { literal } = require("./shell-words.js");

/** @typedef {"rulings" | "web" | "subagent"} Rung */
/** @typedef {import("./tool-calls-since").ToolCall} ToolCall */
/** @typedef {Record<Rung, number>} RungCounts */
/** @typedef {string[] | null} Corpus */

/** @type {Rung[]} */
const RUNGS = ["rulings", "web", "subagent"];

const RUNG_NAME = {
	rulings: "rung 1, past rulings",
	web: "rung 2, web or vendor docs",
	subagent: "rung 3, a fresh subagent",
};

// guess, #1995
const RULINGS_BUDGET = 5;
const WEB_BUDGET = 10;
const SUBAGENT_BUDGET = 15;

/**
 * @param {string[]} args
 * @param {string[]} names
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

const SEARCH_VALUE_FLAGS =
	/^(?:-[RLs]|--(?:repo|owner|state|limit|label|author|assignee|mentions|commenter|involves|language|milestone|app|match|sort|order|created|updated|closed|comments|interactions|reactions|team-mentions|visibility|json|jq|template))$/;

/**
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

/** @typedef {(value: string) => string[]} Expand */

/**
 * @param {string[]} args
 * @param {Corpus} corpus
 * @param {Expand} expand
 */
function isRulingsList(args, corpus, expand) {
	if (parseFlagValues(args, ["--search", "-S"]).length === 0) return false;
	const states = parseFlagValues(args, ["--state", "-s"]);
	if (!states.some((s) => s === "closed" || s === "all")) return false;
	return isOnCorpus(
		parseFlagValues(args, ["--repo", "-R"]).flatMap(expand),
		[],
		corpus,
	);
}

/**
 * @param {string[]} args
 * @param {Corpus} corpus
 * @param {Expand} expand
 */
function isRulingsSearch(args, corpus, expand) {
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
		[
			...parseFlagValues(args, ["--repo", "-R"]),
			...qualifier(/^repo:(\S+)$/i),
		].flatMap(expand),
		[
			...parseFlagValues(args, ["--owner"]),
			...qualifier(/^(?:user|org):(\S+)$/i),
		].flatMap(expand),
		corpus,
	);
}

const VAR_REF = /\$(?:\{(\w+)\}|(\w+))/g;

/** @param {RegExpMatchArray} m */
function varName(m) {
	const name = m[1] ?? m[2];
	if (name === undefined) throw new Error("VAR_REF matched with no name");
	return name;
}

/**
 * @param {string} value
 * @param {Map<string, string[]>} loops
 * @returns {string[]}
 */
function expandLoopVars(value, loops) {
	const m = [...value.matchAll(VAR_REF)].find((r) => loops.has(varName(r)));
	if (!m || m.index === undefined) return [value];
	const values = loops.get(varName(m)) ?? [];
	const [head, tail] = [
		value.slice(0, m.index),
		value.slice(m.index + m[0].length),
	];
	return values.flatMap((v) => expandLoopVars(`${head}${v}${tail}`, loops));
}

/**
 * @param {string} command
 * @param {Corpus} corpus
 */
function isRulingsCommand(command, corpus) {
	const parsed = parseCommand(command);
	const read = (/** @type {string} */ w) => literal(w, parsed.spans).text;
	/** @type {{ name: string, list: string[] | null }[]} */
	const loops = [];
	/** @type {Expand} */
	const expand = (value) => {
		/** @type {Map<string, string[]>} */
		const bound = new Map();
		for (const { name, list } of loops)
			if (list) bound.set(name, list);
			else bound.delete(name);
		return expandLoopVars(value, bound);
	};
	let found = false;
	walkCommands(
		parsed,
		(cmd) => {
			if (found) return;
			const [first, name, keyword, ...list] = cmd.words;
			if (first === "for" && name !== undefined && keyword === "in") {
				const words = list.map((w) => literal(w, parsed.spans));
				loops.push({
					name,
					list: words.every((w) => w.known && !w.text.includes("$"))
						? words.map((w) => w.text)
						: null,
				});
				return;
			}
			if (first === "done") loops.pop();
			found = ghWords(cmd.words, parsed.spans).some((gh) => {
				const [sub, verb, ...args] = gh.args.map(read);
				if (gh.repo) args.push("--repo", gh.repo.text);
				return (
					(sub === "issue" &&
						verb === "list" &&
						isRulingsList(args, corpus, expand)) ||
					(sub === "search" &&
						verb === "issues" &&
						isRulingsSearch(args, corpus, expand))
				);
			});
		},
		TEXT_ONLY_PORTS,
	);
	return found;
}

/**
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
 * @returns {Rung[]}
 */
const missingRungs = (counts) => RUNGS.filter((rung) => counts[rung] === 0);

/**
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
 * @param {string[]} lines
 * @param {{ missing: Rung[], corpus: Corpus, last: string | null }} opts
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
 * @param {string} number
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
