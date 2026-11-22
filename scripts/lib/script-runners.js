const path = require("node:path");
const { findPackageDir } = require("./package-reader.js");
const {
	isNpmRun,
	parseNpmArgv,
	scriptOfNpmCommand,
} = require("./npm-options.js");
const { parseSelection, resolveSelection } = require("./npm-workspaces.js");
const { allCommands, isOpaque, tokenise } = require("./shell-tokens.js");
const { shellQuote } = require("./sh-quote.js");

/** @typedef {import("./shell-tokens.js").Word} Word */
/** @typedef {import("./shell-tokens.js").Token} Token */
/** @typedef {import("./package-reader.js").PackageTree} PackageTree */

const CONTINUATION = /\\\n/g;

/**
 * @typedef {{
 *   isRun: (word: string) => boolean,
 *   dirFlags: Set<string>,
 *   testAliases?: Set<string>,
 *   ownsFlags: boolean,
 *   answersBinary: boolean,
 *   parseRun: (words: Word[], rules: RunnerRules) => RunWords|undefined,
 * }} RunnerRules
 */

/** @param {string} word */
const isPlainRun = (word) => word === "run";

// yarn's and bun's `run` falls through to a binary; pnpm's fails on a missing script (https://yarnpkg.com/cli/run, https://bun.com/docs/cli/run, https://pnpm.io/cli/run)
/** @type {[string, RunnerRules][]} */
const RUNNER_ROWS = [
	[
		"npm",
		{
			isRun: isNpmRun,
			dirFlags: new Set(["--prefix"]),
			ownsFlags: true,
			answersBinary: false,
			parseRun: parseNpmRun,
		},
	],
	[
		"pnpm",
		{
			isRun: (w) => w === "run" || w === "run-script",
			dirFlags: new Set(["--dir", "-C"]),
			testAliases: new Set(["t", "tst"]),
			ownsFlags: false,
			answersBinary: false,
			parseRun: parseOtherRun,
		},
	],
	[
		"yarn",
		{
			isRun: isPlainRun,
			dirFlags: new Set(["--cwd"]),
			ownsFlags: false,
			answersBinary: true,
			parseRun: parseOtherRun,
		},
	],
	[
		"bun",
		{
			isRun: isPlainRun,
			dirFlags: new Set(["--cwd"]),
			ownsFlags: false,
			answersBinary: true,
			parseRun: parseOtherRun,
		},
	],
];
const RUNNERS = new Map(RUNNER_ROWS);
const RUNNER_NAMES = [...RUNNERS.keys()];

/**
 * @param {Word} word
 * @param {Word|undefined} before
 * @param {Set<string>} valueFlags
 */
const isPlainWord = (word, before, valueFlags) =>
	!word.value.startsWith("-") && !(before && valueFlags.has(before.value));

/**
 * @param {string} word
 * @param {Set<string>} flags
 */
function parseEqFormValue(word, flags) {
	const eq = word.indexOf("=");
	return eq >= 0 && flags.has(word.slice(0, eq))
		? word.slice(eq + 1)
		: undefined;
}

/** @typedef {import("./npm-workspaces.js").Selection} Selection */

/**
 * @typedef {{rules: RunnerRules, name: string, at: number, end: number, dir:
 *  string, runLess: boolean, selection?: Selection, handed: Word[]}} Run
 */

/**
 * @typedef {{nameAt: number, script?: string, dir: string, runLess: boolean,
 *  selection?: Selection, handed: Word[]}} RunWords
 */

/** @param {Word[]} words */
function parseNpmWords(words) {
	const { options, operands } = parseNpmArgv(
		words.map((held, at) => ({ value: held.value, held, at })),
	);
	return {
		options,
		operands: operands.map(({ value, from: { held, at } }) => {
			const raw = held.value === value ? held.raw : value;
			return { at, word: { ...held, value, raw, quoted: false } };
		}),
	};
}

/**
 * @param {Word[]} words
 * @param {RunnerRules} rules
 * @returns {RunWords|undefined}
 */
function parseNpmRun(words, rules) {
	const { options, operands } = parseNpmWords(words);
	const [verb, name] = operands;
	if (verb === undefined) return;
	const dir =
		options
			.map((w) => parseEqFormValue(w, rules.dirFlags))
			.findLast((v) => v !== undefined) ?? "";
	const selection = parseSelection(options, dir);
	const handedAfter = (/** @type {number} */ n) =>
		operands.slice(n).map(({ word }) => word);
	const script = scriptOfNpmCommand(verb.word.value);
	if (script)
		return {
			nameAt: verb.at,
			script,
			dir,
			runLess: true,
			selection,
			handed: handedAfter(1),
		};
	if (!rules.isRun(verb.word.value)) return;
	return {
		nameAt: name ? name.at : -1,
		script: name?.word.value,
		dir,
		runLess: false,
		selection,
		handed: handedAfter(2),
	};
}

/**
 * @param {Word[]} words
 * @param {Set<string>} flags
 */
function parseDirFlag(words, flags) {
	let dir = "";
	for (const [i, w] of words.entries()) {
		const next = words[i + 1];
		if (next && flags.has(w.value)) dir = next.value;
		else dir = parseEqFormValue(w.value, flags) ?? dir;
	}
	return dir;
}

/**
 * @param {Word[]} words
 * @param {RunnerRules} rules
 * @returns {RunWords|undefined}
 */
function parseOtherRun(words, rules) {
	const { dirFlags: flags, isRun } = rules;
	/** @type {{word: string, at: number}[]} */
	const plain = [];
	for (const [at, w] of words.entries())
		if (isPlainWord(w, words[at - 1], flags)) plain.push({ word: w.value, at });
	const [first, second, third] = plain;
	const isValue =
		first !== undefined &&
		words[first.at - 1]?.value.startsWith("-") === true &&
		second !== undefined &&
		isRun(second.word) &&
		third !== undefined;
	const isVerb = first !== undefined && isRun(first.word);
	const skipped = isValue ? 2 : 0;
	const named = plain[isVerb ? 1 : skipped];
	if (named === undefined) return;
	const nameAt = named.at;
	const dir = parseDirFlag(words.slice(0, nameAt + 1), flags);
	const runLess = !isVerb && !isValue;
	const handed = words.slice(nameAt + 1).map((w) => ({ ...w, quoted: false }));
	return runLess && rules.testAliases?.has(named.word)
		? { nameAt, script: "test", dir, runLess, handed }
		: { nameAt, dir, runLess, handed };
}

/** @param {Word[]} command */
function parseRunWords(command) {
	const at = command.findIndex(
		(w) => !isOpaque(w) && RUNNERS.has(path.posix.basename(w.value)),
	);
	const head = command[at];
	const rules = head && RUNNERS.get(path.posix.basename(head.value));
	if (!rules) return;
	const words = command.slice(at + 1);
	const found = rules.parseRun(words, rules);
	return found && { ...found, rules, at, words };
}

/** @param {Word[]} command @returns {Run|undefined} */
function findRun(command) {
	const found = parseRunWords(command);
	const name = found?.words[found.nameAt];
	if (!found || !name || isOpaque(name)) return;
	return {
		rules: found.rules,
		name: found.script ?? name.value,
		at: found.at,
		end: found.at + found.nameAt + 2,
		dir: found.dir,
		runLess: found.runLess,
		selection: found.selection,
		handed: found.handed,
	};
}

/** @typedef {{command: Word[], dirs: string[]}} Placed */

/**
 * @param {Hop} hop
 * @returns {Generator<Placed>}
 */
function* placedCommands(hop) {
	let dirs = [hop.dir];
	const settled = parseSettledCds(hop.tokens);
	for (const command of allCommands(hop.tokens)) {
		const cd = parseCdTarget(command);
		if (cd !== undefined) {
			const moved = dirs.map((d) => path.resolve(d, cd));
			const [head] = command;
			dirs = head && settled.has(head) ? moved : [...dirs, ...moved];
		}
		yield { command, dirs };
	}
}

/**
 * @param {Run} run
 * @param {string[]} dirs
 * @param {string} root
 */
const runPackageDirs = (run, dirs, root) => [
	...new Set(dirs.map((d) => findPackageDir(path.resolve(d, run.dir), root))),
];

/**
 * @param {Run} run
 * @param {string[]} dirs
 * @param {PackageTree} tree
 */
function resolveRunDirs(run, dirs, tree) {
	const { selection } = run;
	if (!selection)
		return {
			dirs: runPackageDirs(run, dirs, tree.root),
			unresolvedMembers: undefined,
		};
	const picks = dirs.map((d) =>
		resolveSelection(selection, path.resolve(d, run.dir), tree),
	);
	return {
		dirs: [...new Set(picks.flatMap((p) => p.dirs))],
		unresolvedMembers: picks.find((p) => p.unresolved)?.members,
	};
}

/**
 * @param {Placed} placed
 * @param {PackageTree} tree
 * @returns {string[]|undefined}
 */
function unresolvedSelectorMembers({ command, dirs }, tree) {
	const run = findRun(command);
	return run && resolveRunDirs(run, dirs, tree).unresolvedMembers;
}

/**
 * @param {Placed} placed
 * @param {PackageTree} tree
 * @returns {Word|undefined}
 */
function namedScriptWord({ command, dirs }, tree) {
	const run = findRun(command);
	if (!run || run.at > 0) return;
	if (!run.rules.ownsFlags && command.some((w) => w.value.startsWith("-")))
		return;
	const targets = resolveRunDirs(run, dirs, tree).dirs;
	return targets.length > 0 &&
		targets.every(
			(d) => typeof tree.readCachedPackage(d).scripts[run.name] === "string",
		)
		? command[run.end - 1]
		: undefined;
}

/**
 * @param {Placed} placed
 * @param {PackageTree} tree
 */
function withoutRun({ command, dirs }, { root, readCachedPackage }) {
	const run = findRun(command);
	if (!run || run.runLess) return command;
	const isScriptIn = (/** @type {string} */ dir) =>
		typeof readCachedPackage(dir).scripts[run.name] === "string";
	return run.rules.answersBinary &&
		!runPackageDirs(run, dirs, root).every(isScriptIn)
		? command
		: [...command.slice(0, run.at), ...command.slice(run.end)];
}

/** @param {Word[]} words */
const showHanded = (words) =>
	words.map((w) => ` ${isOpaque(w) ? w.raw : shellQuote(w.value)}`).join("");

/**
 * @typedef {{name: string|null, text: string, handed: string, tokens:
 *   Token[], dir: string, alone: boolean}} Hop
 */

const RESTART_SCRIPTS = [
	"prerestart",
	"restart",
	"postrestart",
	"prestop",
	"stop",
	"poststop",
	"prestart",
	"start",
	"poststart",
];

/**
 * @param {Run} run
 * @param {Record<string, unknown>} scripts
 */
function scriptsRun(run, scripts) {
	const has = (/** @type {string} */ n) => typeof scripts[n] === "string";
	if (run.runLess && run.name === "restart") return RESTART_SCRIPTS.filter(has);
	if (!has(run.name)) return [];
	return [`pre${run.name}`, run.name, `post${run.name}`].filter(has);
}

const CD_FLAG = /^-(?:[LPe@]+|-)$/;

/** @param {Word[]} command */
function parseCdTarget(command) {
	if (command[0]?.value !== "cd") return;
	const target = command.slice(1).find((w) => !CD_FLAG.test(w.value));
	return target && !isOpaque(target) ? target.value : undefined;
}

/**
 * @param {Token[]} tokens
 * @returns {Set<Word>}
 */
function parseSettledCds(tokens) {
	/** @type {Set<Word>} */
	const settled = new Set();
	/** @type {Word|undefined} */
	let head;
	let depth = 0;
	let surely = true;
	for (const t of tokens) {
		if (t.type === "word") head ??= t;
		if (t.type !== "op") continue;
		if (t.value === "(") depth++;
		if (t.value === ")") depth--;
		if (t.value === "&&" && depth === 0 && surely && head?.value === "cd")
			settled.add(head);
		surely = t.value === "&&" || t.value === ";" || t.value === "\n";
		head = undefined;
	}
	return settled;
}

/** @param {Word[]} command */
function parseNamedDir(command) {
	const cd = parseCdTarget(command);
	if (cd !== undefined) return cd;
	const run = parseRunWords(command);
	return run ? run.dir : "";
}

/**
 * @param {Run} run
 * @param {Word[]} handed
 * @param {{dir: string, scripts: Record<string, unknown>, onlyDir: boolean}} place
 * @returns {{next: Hop, key: string}[]}
 */
function runHops(run, handed, { dir, scripts, onlyDir }) {
	const names = scriptsRun(run, scripts);
	return names.map((name) => {
		const given = name === run.name ? handed : [];
		const raw = String(scripts[name]);
		return {
			next: {
				name,
				text: raw.replace(CONTINUATION, ""),
				handed: showHanded(given),
				tokens: [...tokenise(raw), ...given],
				dir,
				alone: names.length === 1 && onlyDir,
			},
			key: JSON.stringify([
				dir,
				name,
				[...new Set(given.map((w) => w.raw))].sort(),
			]),
		};
	});
}

/**
 * @param {Hop} hop
 * @param {PackageTree} tree
 */
function* hopsFrom(hop, tree) {
	for (const { command, dirs } of placedCommands(hop)) {
		const run = findRun(command);
		if (!run) continue;
		const targets = resolveRunDirs(run, dirs, tree).dirs;
		for (const dir of targets)
			yield* runHops(run, run.handed, {
				dir,
				scripts: tree.readCachedPackage(dir).scripts,
				onlyDir: targets.length === 1,
			});
	}
}

/**
 * @template T
 * @param {PackageTree} tree
 * @param {string} command
 * @param {(hop: Hop, hops: Hop[]) => T|undefined} visit
 * @returns {T|undefined}
 */
function walkRunScripts(tree, command, visit) {
	const seen = new Set();
	/**
	 * @param {Hop} hop
	 * @param {Hop[]} hops
	 * @returns {T|undefined}
	 */
	const walk = (hop, hops) => {
		const hit = visit(hop, hops);
		if (hit !== undefined) return hit;
		for (const { next, key } of hopsFrom(hop, tree)) {
			if (seen.has(key)) continue;
			seen.add(key);
			const found = walk(next, [...hops, next]);
			if (found !== undefined) return found;
		}
		return hit;
	};
	/** @type {Hop} */
	const top = {
		name: null,
		text: command.replace(CONTINUATION, ""),
		handed: "",
		tokens: tokenise(command),
		dir: tree.root,
		alone: true,
	};
	return walk(top, [top]);
}

module.exports = {
	RUNNER_NAMES,
	findRun,
	isPlainWord,
	namedScriptWord,
	parseNamedDir,
	placedCommands,
	unresolvedSelectorMembers,
	walkRunScripts,
	withoutRun,
};
