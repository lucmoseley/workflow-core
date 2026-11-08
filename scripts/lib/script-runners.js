/*
 * script-runners.js — what a command runs through npm, pnpm, yarn and bun
 * (#3947): `RUNNERS`, one row of command-line facts per runner, and the walk
 * from a command through each `package.json` script it runs. A classifier
 * judging a command must see the scripts it reaches, not only its own words, so
 * infer-commands.js's classifiers read each hop of this walk.
 */

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
/** @typedef {import("./package-reader.js").PackageReader} PackageReader */
/**
 * @typedef {{ root: string, readCachedPackage: PackageReader }} PackageTree `root`
 *  the directory a command starts in, which bounds the climb to a
 *  `package.json`; `readCachedPackage` called at each run found, so a command
 *  running none reads no `package.json` (#3546).
 */

/* A backslash-newline, which the shell deletes. */
const CONTINUATION = /\\\n/g;

/* A command is read through each `npm run`, `pnpm run`, `yarn run` or
 * `bun run` it makes, or a runner's alias of its `run`, into the script that
 * names, with the runner's flags before the name, and the script is walked
 * with the words the run hands on to it on its end (#3153, #3193, #3627). The
 * run-less `pnpm <script>`, `yarn <script>` and `bun <script>`, and npm's
 * `test`, `start`, `stop` and `restart`, are runs too; so is each `pre<name>`
 * and `post<name>`, read from the `package.json` of a directory a `cd` or the
 * runner's flag writes out, or its nearest ancestor holding one, as npm finds
 * it (#3851), or in each workspace npm's selector picks (#4041). pnpm's, yarn's
 * and bun's rules are their docs' (pnpm.io/cli/run,
 * yarnpkg.com/cli/run, bun.com/docs/cli/run); npm's are measured on 11.16.0.
 *
 * Read wider than the runner: a built-in sharing a script's name (`bun test`),
 * and yarn modern's `pre` and `post`, which it does not run. A script name
 * holding an expansion is not followed (#3545).
 *
 * Residual, not followed: a script reached through a shell file, `node --run`,
 * pnpm's and yarn's workspace selectors (`pnpm --filter web cs`, `yarn workspace
 * web cs`), npm's set outside the command (`npm_config_workspace=web`, `.npmrc`),
 * a run an `npm exec` or `npx` makes (`npm exec -- npm run cs`, whose npm is
 * unread, and `npx -w web npm run cs`, whose selector is), a member `-ws` reaches
 * only through a symlink past a glob's segment or a `.` in a brace,
 * a directory set any other way (`pushd`, `env -C`, `cd ~/web`), a script name
 * after a value flag other than the directory's (`pnpm --reporter silent cs`),
 * the scripts an npm command other than these runs (`npm install-test`), and
 * a script reached through a script runner (`run-s cs`, `npm-run-all cs`,
 * `concurrently npm:cs`, `turbo run cs`, `nx run cs`, `lerna run cs`), held
 * until a first adopter declares one (#2599). */
/**
 * @typedef {{
 *   isRun: (word: string) => boolean,
 *   dirFlags: Set<string>,
 *   testAliases?: Set<string>,
 *   ownsFlags: boolean,
 *   answersBinary: boolean,
 *   parseRun: (words: Word[], rules: RunnerRules) => RunWords|undefined,
 * }} RunnerRules `dirFlags` name the directory it runs in; `testAliases` are
 *  its run-less words for `test`;
 *  `ownsFlags` where it keeps the flags before a `--` as its own and drops the
 *  `--`, where the others hand on every word (#3413); `answersBinary` where its
 *  `run` falls through to a binary, so runs a word no script has the name of
 *  (yarnpkg.com/cli/run, bun.com/docs/cli/run), where npm's and pnpm's fail on a
 *  missing script (pnpm.io/cli/run).
 */

/** @param {string} word */
const isPlainRun = (word) => word === "run";

/* npm's `test` and aliases are `scriptOfNpmCommand`'s; pnpm's `run` comes with
 * its documented `run-script` alias and pnpm.io/cli/test's aliases of `test`;
 * yarn and bun document no alias. */
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
 * Whether `word` is neither a flag nor a flag's value.
 * @param {Word} word
 * @param {Word|undefined} before the word before it
 * @param {Set<string>} valueFlags the flags taking the next word as their value
 */
const isPlainWord = (word, before, valueFlags) =>
	!word.value.startsWith("-") && !(before && valueFlags.has(before.value));

/**
 * The value `word` gives one of `flags` after a `=`, or undefined.
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

/** @typedef {{rules: RunnerRules, name: string, at: number, end: number, dir:
 *  string, runLess: boolean, selection?: Selection, handed: Word[]}} Run `at` the
 *  runner's index in its command, `end` past the script name's; `dir` the
 *  directory it names, or ""; `runLess` where no `run` was written, so the word
 *  may name no script at all; `selection` where a workspace selector replaces
 *  that directory; `handed` the words reaching the script. */

/** @typedef {{nameAt: number, script?: string, dir: string, runLess: boolean,
 *  selection?: Selection, handed: Word[]}} RunWords `nameAt` indexes the words
 *  after the runner; `script` where the script's name is not all of that word. */

/**
 * npm's options, and the words it reads as operands, each at the word that holds
 * it. Each reaches a script as one literal word, so it counts as unquoted, and is
 * shell-quoted where it is written out (#3545).
 * @param {Word[]} words
 */
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
 * @param {Word[]} words after `npm`
 * @param {RunnerRules} rules its row
 * @returns {RunWords|undefined}
 */
function parseNpmRun(words, rules) {
	const { options, operands } = parseNpmWords(words);
	const [verb, name] = operands;
	if (verb === undefined) return;
	/* `npmCanon` writes the flag's space form with a `=`, so only that is read. */
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
 * The directory the last of `flags` in `words` names, or "".
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
 * The run in the words after pnpm, yarn or bun: the first word past the flags
 * is the verb or a run-less script's name, and a later `run` is a word handed
 * on. A first word after a bare flag, with `run` next, is that flag's value.
 * @param {Word[]} words after the runner
 * @param {RunnerRules} rules its row
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

/**
 * The runner `command` calls and its run's words, its name maybe an expansion.
 * @param {Word[]} command
 */
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
 * A command placed in the directories it may run in, as `cd`s before it leave
 * them: one no `&&` settles is read in the directories before and after it.
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
 * The package directories `run` runs in from `dirs`, and where a workspace
 * selector in it is unresolved, the members it chose among, `[]` being one with
 * none to choose.
 * @param {Run} run
 * @param {string[]} dirs
 * @param {PackageTree} tree
 */
function resolveRunDirs(run, dirs, { root, readCachedPackage }) {
	const { selection } = run;
	if (!selection)
		return {
			dirs: runPackageDirs(run, dirs, root),
			unresolvedMembers: undefined,
		};
	const picks = dirs.map((d) =>
		resolveSelection(
			selection,
			path.resolve(d, run.dir),
			root,
			readCachedPackage,
		),
	);
	return {
		dirs: [...new Set(picks.flatMap((p) => p.dirs))],
		unresolvedMembers: picks.find((p) => p.unresolved)?.members,
	};
}

/**
 * The members of a workspace selector in `placed` that is unresolved, or
 * undefined where it has none.
 * @param {Placed} placed
 * @param {PackageTree} tree
 * @returns {string[]|undefined}
 */
function unresolvedSelectorMembers({ command, dirs }, tree) {
	const run = findRun(command);
	return run && resolveRunDirs(run, dirs, tree).unresolvedMembers;
}

/**
 * The word naming the script `placed`'s run runs, where every directory it
 * reaches has a script of that name, so the word can name nothing else (#4042).
 * A prefix may set npm's selector, and another runner's flag may be a selector
 * this walk does not read, so with either the word is not known to name one.
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
 * `command` with a written `run`'s runner and name shed and its handed-on words
 * kept, so words a missing script's run hands on are still read where they
 * stand (#3413). A run-less word stays, as `yarn biome check` names no script,
 * and so does a run a binary may answer, as `yarn run biome check` runs Biome
 * where no script is called `biome` (#3944).
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
 *   Token[], dir: string, alone: boolean}} Hop `text` is the command itself
 *   where `name` is null, else `package.json`'s script `name`, its
 *   backslash-newlines folded; `handed` the words the run hands on to that
 *   script, each after a space, or ""; `tokens` the text's with those words on
 *   the end; `dir` the directory it runs in; `alone` where its run runs no
 *   other script beside it.
 */

/* `npm restart` runs its `restart` script's three, or with none the rest;
 * `pnpm restart` runs `stop`, `restart` and `start`. Read as one, so wider than
 * either. */
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
 * The scripts `run` runs of those in `scripts`: its own with no such script
 * runs nothing.
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

/** The directory `command` changes to, written out, or undefined.
 * @param {Word[]} command */
function parseCdTarget(command) {
	if (command[0]?.value !== "cd") return;
	const target = command.slice(1).find((w) => !CD_FLAG.test(w.value));
	return target && !isOpaque(target) ? target.value : undefined;
}

/**
 * The first word of each `cd` that `&&` proves ran, in `tokens`' own list and
 * outside a subshell, so what follows runs only in its directory.
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

/**
 * The directory `command` names, by `cd` or its runner's flag, or "".
 * @param {Word[]} command
 */
function parseNamedDir(command) {
	const cd = parseCdTarget(command);
	if (cd !== undefined) return cd;
	const run = parseRunWords(command);
	return run ? run.dir : "";
}

/**
 * The hops `run` makes in `dir`, each with the key that says it was walked.
 * @param {Run} run
 * @param {Word[]} handed
 * @param {{dir: string, scripts: Record<string, unknown>, onlyDir: boolean}} place
 *  `scripts` being `dir`'s; `onlyDir` where the run reaches no other directory
 * @returns {{next: Hop, key: string}[]}
 */
function runHops(run, handed, { dir, scripts, onlyDir }) {
	const names = scriptsRun(run, scripts);
	return names.map((name) => {
		/* A runner hands its words to the script named, never its pre or post
		 * (measured on npm 11.16.0; yarn's run.js says so). */
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
			/* As a set, so a script handing itself more words still ends. */
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
 * Walks `command`, then each script it runs, each script once for each set of
 * words handed on to it, handing `visit` each hop and the path of hops to it;
 * the first result `visit` returns that is not undefined is the walk's.
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
	 * @param {Hop[]} hops ending at `hop`
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
