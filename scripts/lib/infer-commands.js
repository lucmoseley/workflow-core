/*
 * infer-commands.js — a repo's commands, `SCRIPT_NAMES`'s keys, found rather than asked (#692): `package.json` scripts first, then
 * pytest config, then `*.test.js` files ⇒ `node --test`. Only `test` has the
 * two fallbacks. An empty repo gets none. `isLintStagedCommand` judges whether a
 * `check_staged` runs lint-staged, which init refuses (#2587), and
 * `classifyCheckStaged` whether one running `biome check --staged` maps to
 * biome-staged.js or is refused (#2731). Run as a script it is
 * `.husky/pre-commit`'s check of the declared `check_staged` (#2775): a
 * one-verb entry, not a `check-*`, since it judges one command, and it FAILS
 * CLOSED — a command it cannot classify refuses the commit.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { isNpmRun, npmCanon, npmScriptCommand } = require("./npm-options.js");
const { isOpaque, tokenise } = require("./shell-tokens.js");
const { writeFd } = require("./write-fd.js");
const { shellQuote } = require("./sh-quote.js");

/** @typedef {import("./shell-tokens.js").Word} Word */
/** @typedef {import("./shell-tokens.js").Token} Token */

/** The `package.json` script names each command is read from, first match
 *  wins. Past the command's own name, a guess at the common spelling. */
const SCRIPT_NAMES = {
	test: ["test"],
	lint: ["lint"],
	typecheck: ["typecheck", "type-check"],
	check: ["check"],
	check_staged: ["check:staged"],
	push_check: ["push:check"],
};

/* `npm init` writes this as the test script; it is no test command. */
const NPM_INIT_PLACEHOLDER = /no test specified/;

/** `package.json` does not parse. The message is init's way out; `detail`
 * is the parser's, for a caller whose way out differs (#3192). */
class PackageParseError extends Error {
	/** @param {string} detail @param {ErrorOptions} options */
	constructor(detail, options) {
		super(
			`package.json does not parse, so no command can be inferred from it — fix it, or name each with --command: ${detail}`,
			options,
		);
		this.detail = detail;
	}
}

/** A `readPackage` that reads each directory at its first call and keeps it. */
function buildPackageReader() {
	/** @type {Map<string, ReturnType<typeof readPackage>>} */
	const read = new Map();
	return (/** @type {string} */ dir) => {
		const pkg = read.get(dir) ?? readPackage(dir);
		read.set(dir, pkg);
		return pkg;
	};
}

/* A word read as a directory may be no path at all. Any other read error
 * throws, as a file that cannot be read shows no absence of Biome. */
const ABSENT_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG"]);

/** @param {unknown} err */
const isAbsentFile = (err) =>
	err instanceof Error &&
	"code" in err &&
	ABSENT_FILE_CODES.has(String(err.code));

/**
 * Throws a PackageParseError on a `package.json` that does not parse, which
 * would otherwise read as one naming no script.
 * @param {string} root
 */
function readPackage(root) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, "package.json"), "utf8");
	} catch (err) {
		if (!isAbsentFile(err)) throw err;
		return { scripts: {}, biome: false, biomeEvident: false };
	}
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch (err) {
		throw new PackageParseError(caught(err).message, { cause: err });
	}
	const scripts =
		pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
	return {
		scripts,
		biome: ["dependencies", "devDependencies"].some(
			(k) => typeof pkg?.[k]?.["@biomejs/biome"] === "string",
		),
		biomeEvident:
			[
				"dependencies",
				"devDependencies",
				"peerDependencies",
				"optionalDependencies",
			].some((k) => typeof pkg?.[k]?.["@biomejs/biome"] === "string") ||
			Object.values(scripts).some(
				(s) => typeof s === "string" && s.includes("biome"),
			),
	};
}

/* A backslash-newline, which the shell deletes. */
const CONTINUATION = /\\\n/g;

/** @param {Token[]} tokens each simple command's words, split at operators */
function simpleCommands(tokens) {
	/** @type {Word[][]} */
	const commands = [];
	/** @type {Word[]} */
	let current = [];
	for (const t of tokens) {
		if (t.type === "word") current.push(t);
		else if (t.type === "op") {
			commands.push(current);
			current = [];
		}
	}
	commands.push(current);
	return commands.filter((c) => c.length > 0);
}

/** @param {Token} t */
const wordOf = (t) => (t.type === "redirect" ? t.target : t);

/**
 * Every simple command `tokens` holds: its own, then each substitution's,
 * and unless `quoted` is false each quoted word's, which a runner such as
 * `concurrently` or `sh -c` runs.
 * @param {Token[]} tokens
 * @param {boolean} [quoted]
 * @returns {Word[][]}
 */
function allCommands(tokens, quoted = true) {
	return simpleCommands(tokens).concat(
		tokens.flatMap((t) => {
			const word = wordOf(t);
			if (word?.type !== "word") return [];
			const read = quoted && word.quoted ? [tokenise(word.value)] : [];
			return [...word.subs, ...read].flatMap((sub) => allCommands(sub, quoted));
		}),
	);
}

/**
 * `allCommands` without reading a quoted word as a script: what `tokens` run
 * whatever their runner. A quoted word is a command only where a runner runs
 * it, and reading it as one calls `echo '$X'` a hidden command (#3545).
 * Residual: `concurrently '$X'` reads as not hidden.
 * @param {Token[]} tokens
 */
const writtenCommands = (tokens) => allCommands(tokens, false);

/* A command is read through each `npm run`, `pnpm run`, `yarn run` or
 * `bun run` it makes, or a runner's alias of its `run`, into the script that
 * names, with the runner's flags before the name, and the script is walked
 * with the words the run hands on to it on its end (#3153, #3193, #3627). The
 * run-less `pnpm <script>`, `yarn <script>` and `bun <script>`, and npm's
 * `test`, `start`, `stop` and `restart`, are runs too; so is each `pre<name>`
 * and `post<name>`, read from the `package.json` of a directory a `cd` or the
 * runner's flag writes out, or its nearest ancestor holding one, as npm finds
 * it (#3851). pnpm's, yarn's and bun's rules are their docs' (pnpm.io/cli/run,
 * yarnpkg.com/cli/run, bun.com/docs/cli/run); npm's are measured on 11.16.0.
 *
 * Read wider than the runner, so refused where it reaches Biome: a built-in
 * sharing a script's name (`bun test`), and yarn modern's `pre` and `post`,
 * which it does not run. A script name holding an expansion is refused
 * (#3545).
 *
 * Residual, not followed: a script reached through a shell file, `node --run`,
 * a workspace selector (`pnpm --filter web cs`, `yarn workspace web cs`), a
 * directory set any other way (`pushd`, `env -C`, `cd ~/web`), a script name
 * after a value flag other than the directory's (`pnpm --reporter silent cs`),
 * and the scripts an npm command other than these runs (`npm install-test`). */
/** @type {Map<string, (word: string) => boolean>} Each runner's test for its
 *  `run`: npm's per `isNpmRun`, pnpm's with its documented `run-script`
 *  alias; yarn and bun document none. */
const RUN_VERB = new Map([
	["npm", isNpmRun],
	["pnpm", (w) => w === "run" || w === "run-script"],
	["yarn", (w) => w === "run"],
	["bun", (w) => w === "run"],
]);

/* Each runner's flag naming the directory it runs in, past npm's, which
 * `npmCanon` reads as `--prefix`. */
const DIR_FLAGS = new Map([
	["pnpm", new Set(["--dir", "-C"])],
	["yarn", new Set(["--cwd"])],
	["bun", new Set(["--cwd"])],
]);

/** @typedef {{runner: string, name: string, at: number, end: number, dir:
 *  string, runLess: boolean}} Run `at` the runner's index in its command, `end`
 *  past the script name's; `dir` the directory it names, or ""; `runLess` where
 *  no `run` was written, so the word may name no script at all. */

/** @typedef {{nameAt: number, script?: string, dir: string, runLess: boolean}}
 *  RunWords `nameAt` indexes the words after the runner; `script` where the
 *  script's name is not that word. */

/** @param {Word[]} words after `npm` @returns {RunWords|undefined} */
function parseNpmRun(words) {
	const canon = npmCanon(words.map((w) => w.value));
	const cut = canon.indexOf("--");
	const options = cut < 0 ? canon : canon.slice(0, cut);
	const [verb, name] = [
		...options.filter((w) => !w.startsWith("-")),
		...(cut < 0 ? [] : canon.slice(cut + 1)),
	];
	if (verb === undefined) return;
	const verbAt = words.findIndex((w) => w.value === verb);
	const prefix = options.find((w) => w.startsWith("--prefix="));
	const dir = prefix ? prefix.slice("--prefix=".length) : "";
	const script = npmScriptCommand(verb);
	if (script) return { nameAt: verbAt, script, dir, runLess: true };
	if (!isNpmRun(verb)) return;
	const nameAt = words.findIndex((w, i) => i > verbAt && w.value === name);
	return { nameAt, dir, runLess: false };
}

/**
 * The directory the last of `flags` in `words` names, or "".
 * @param {Word[]} words
 * @param {Set<string>} flags
 */
function parseDirFlag(words, flags) {
	let dir = "";
	for (const [i, w] of words.entries()) {
		const eq = w.value.indexOf("=");
		const next = words[i + 1];
		if (next && flags.has(w.value)) dir = next.value;
		else if (eq >= 0 && flags.has(w.value.slice(0, eq)))
			dir = w.value.slice(eq + 1);
	}
	return dir;
}

/**
 * The run in the words after pnpm, yarn or bun: the first word past the flags
 * is the verb or a run-less script's name, and a later `run` is a word handed
 * on. A first word after a bare flag, with `run` next, is that flag's value.
 * @param {string} runner
 * @param {Word[]} words after it
 * @returns {RunWords|undefined}
 */
function parseOtherRun(runner, words) {
	const flags = DIR_FLAGS.get(runner);
	const isRun = RUN_VERB.get(runner);
	if (!flags || !isRun) throw new Error(`no run rules for ${runner}`);
	/** @type {number[]} */
	const plain = [];
	for (const [i, w] of words.entries()) {
		const before = words[i - 1];
		if (!w.value.startsWith("-") && !(before && flags.has(before.value)))
			plain.push(i);
	}
	const [first, second, third] = plain.map((i) => words[i]?.value);
	const isValue =
		plain[0] !== undefined &&
		words[plain[0] - 1]?.value.startsWith("-") === true &&
		second !== undefined &&
		isRun(second) &&
		third !== undefined;
	const isVerb = first !== undefined && isRun(first);
	const skipped = isValue ? 2 : 0;
	const nameAt = plain[isVerb ? 1 : skipped];
	if (nameAt === undefined) return;
	const dir = parseDirFlag(words.slice(0, nameAt + 1), flags);
	return { nameAt, dir, runLess: !isVerb && !isValue };
}

/**
 * The runner `command` calls and its run's words, its name maybe an expansion.
 * @param {Word[]} command
 */
function parseRunWords(command) {
	const at = command.findIndex(
		(w) => !isOpaque(w) && RUN_VERB.has(path.posix.basename(w.value)),
	);
	const head = command[at];
	if (!head) return;
	const runner = path.posix.basename(head.value);
	const words = command.slice(at + 1);
	const found =
		runner === "npm" ? parseNpmRun(words) : parseOtherRun(runner, words);
	return found && { ...found, runner, at, words };
}

/** @param {Word[]} command @returns {Run|undefined} */
function findRun(command) {
	const found = parseRunWords(command);
	const name = found?.words[found.nameAt];
	if (!found || !name || isOpaque(name)) return;
	return {
		runner: found.runner,
		name: found.script ?? name.value,
		at: found.at,
		end: found.at + found.nameAt + 2,
		dir: found.dir,
		runLess: found.runLess,
	};
}

/* A command with a written `run`'s runner and name shed and its handed-on
 * words kept, so words a missing script's run hands on are still read where
 * they stand (#3413). A run-less word stays, as `yarn biome check` names no
 * script. */
/** @param {Word[]} command */
function withoutRun(command) {
	const run = findRun(command);
	return run && !run.runLess
		? [...command.slice(0, run.at), ...command.slice(run.end)]
		: command;
}

/**
 * The words after a run's script name that reach the script. npm keeps the
 * flags before a `--` as its own and drops the `--`; pnpm, yarn and bun hand
 * on every word (#3413). Each reaches the script as one literal word, so it
 * counts as unquoted, and is shell-quoted where it is written out (#3545).
 * Residual: the value of an npm flag given after a space (`--loglevel
 * silent`) reads as a word handed on.
 * @param {string} runner
 * @param {Word[]} words
 * @returns {Word[]}
 */
function handedWords(runner, words) {
	const cut = words.findIndex((w) => w.value === "--");
	const kept =
		runner === "npm"
			? [
					...(cut < 0 ? words : words.slice(0, cut)).filter(
						(w) => !w.value.startsWith("-"),
					),
					...(cut < 0 ? [] : words.slice(cut + 1)),
				]
			: words;
	return kept.map((w) => ({ ...w, quoted: false }));
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

/**
 * `dir`, or its nearest ancestor up to `root` holding a `package.json`, where a
 * runner finds it.
 * @param {string} dir
 * @param {string} root
 */
function findPackageDir(dir, root) {
	for (let d = dir; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "package.json"))) return d;
		if (d === root || d === path.dirname(d)) return dir;
	}
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
function settledCds(tokens) {
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
 * @param {string} dir
 * @param {Record<string, unknown>} scripts `dir`'s
 * @returns {{next: Hop, key: string}[]}
 */
function runHops(run, handed, dir, scripts) {
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
				alone: names.length === 1,
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
 * Each hop `hop`'s runs make. A run after a `cd` no `&&` settles is read in the
 * directories before and after it.
 * @param {Hop} hop
 * @param {string} root
 * @param {(dir: string) => Record<string, unknown>} readScripts
 */
function* hopsFrom(hop, root, readScripts) {
	let dirs = [hop.dir];
	const settled = settledCds(hop.tokens);
	for (const simple of allCommands(hop.tokens)) {
		const cd = parseCdTarget(simple);
		if (cd !== undefined) {
			const moved = dirs.map((d) => path.resolve(d, cd));
			const [head] = simple;
			dirs = head && settled.has(head) ? moved : [...dirs, ...moved];
		}
		const run = findRun(simple);
		if (!run) continue;
		const handed = handedWords(run.runner, simple.slice(run.end));
		for (const base of new Set(dirs)) {
			const dir = findPackageDir(path.resolve(base, run.dir), root);
			yield* runHops(run, handed, dir, readScripts(dir));
		}
	}
}

/**
 * Walks `command`, then each script it runs, each script once for each set of
 * words handed on to it, handing `visit` each hop and the path of hops to it;
 * the first result `visit` returns that is not undefined is the walk's.
 * @template T
 * @param {string} root the directory the command starts in
 * @param {(dir: string) => Record<string, unknown>} readScripts called at each
 *   run found, so a command running none reads no `package.json` (#3546); a
 *   caller passes one that reads each once
 * @param {string} command
 * @param {(hop: Hop, hops: Hop[]) => T|undefined} visit
 * @returns {T|undefined}
 */
function walkRunScripts(root, readScripts, command, visit) {
	const seen = new Set();
	/**
	 * @param {Hop} hop
	 * @param {Hop[]} hops ending at `hop`
	 * @returns {T|undefined}
	 */
	const walk = (hop, hops) => {
		const hit = visit(hop, hops);
		if (hit !== undefined) return hit;
		for (const { next, key } of hopsFrom(hop, root, readScripts)) {
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
		dir: root,
		alone: true,
	};
	return walk(top, [top]);
}

const LINT_STAGED = /(?:^|\/)lint-staged(?:@.*)?$/;

/**
 * Whether `command` runs lint-staged, itself or through a `package.json`
 * script it runs.
 * @param {string} root
 * @param {string} command
 * @returns {boolean}
 */
function isLintStagedCommand(root, command) {
	const readCachedPackage = buildPackageReader();
	return (
		walkRunScripts(
			path.resolve(root),
			(dir) => readCachedPackage(dir).scripts,
			command,
			(hop) =>
				allCommands(hop.tokens).some((c) =>
					withoutRun(c).some((w) => LINT_STAGED.test(w.value)),
				)
					? true
					: undefined,
		) ?? false
	);
}

const BIOME_STAGED_COMMAND = 'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js';

/* Biome's --staged lints the worktree's bytes of each staged path, so a
 * `commit-paths.js --patch` commit (#801) is judged on a neighbour's unstaged
 * hunks; biome-staged.js lints the index's (#2429, #2540). A simple command
 * runs it where a `biome` word, then `check`, is followed by `--staged`. */
const BIOME_WORD = /(?:^|\/)biome(?:@.*)?$/;
const CHECK_WORD = /^check$/;
const STAGED_WORD = /^--staged(?:=|$)/;
const PINNED = /(?:^|\s)(?:@biomejs\/)?biome@/;
const BIOME_TEXT = /biome/;

/**
 * Whether `word` is, or could be once expanded, a word `re` matches: any word
 * holding an expansion could, in any slot (#3545).
 * @param {Word} word @param {RegExp} re
 */
const isPossibly = (word, re) => re.test(word.value) || isOpaque(word);

const GLOB_SOURCE = new Map([
	["*", ".*"],
	["?", "."],
]);

/** @param {string} c */
const escapeRegex = (c) => c.replace(/[.+^${}()|[\]\\]/, "\\$&");

/**
 * Whether `word` is a glob that could name `biome`, each `[…]` read as any
 * one character.
 * @param {Word} word
 */
const isBiomeGlob = (word) => {
	if (!word.glob) return false;
	const source = path.posix
		.basename(word.value)
		.replace(
			/\[[^\]]*\]|./gs,
			(c) => GLOB_SOURCE.get(c) ?? (c.length > 1 ? "." : escapeRegex(c)),
		);
	return new RegExp(`^${source}$`).test("biome");
};

/** The index of `command`'s `biome` word followed by `check`, or -1.
 * @param {Word[]} command */
const biomeCheckAt = (command) =>
	command.findIndex((w, i) => {
		const next = command[i + 1];
		return (
			next !== undefined &&
			(isPossibly(w, BIOME_WORD) || isBiomeGlob(w)) &&
			isPossibly(next, CHECK_WORD)
		);
	});

/** Whether `command` is `biome check --staged`, as far as it can be read.
 * @param {Word[]} command */
const isBiomeCheck = (command) => {
	const at = biomeCheckAt(command);
	return (
		at >= 0 && command.slice(at + 2).some((w) => isPossibly(w, STAGED_WORD))
	);
};

/**
 * The subcommand of a `biome` word written out and followed by `--staged`, or
 * undefined; "" for none.
 * @param {Word[]} command
 */
function parseBiomeSubcommand(command) {
	const at = command.findIndex(
		(w) => BIOME_WORD.test(w.value) || isBiomeGlob(w),
	);
	const rest = command.slice(at + 1);
	if (at < 0 || !rest.some((w) => isPossibly(w, STAGED_WORD))) return;
	const subcommand = rest.find((w) => !w.value.startsWith("-"));
	return subcommand ? subcommand.value : "";
}

/* Text that could run Biome or a script, read with its quotes and
 * backslashes deleted, which split a word without changing it (`bi""ome`,
 * `n\pm`), classify the hop (#3545). The word is the package manager, not its
 * verb, as an expansion may be the verb (#3851). A `$'…'` escape may decode to
 * either, so counts too. All of this binds only a repo with Biome evidence
 * (`hasBiomeEvidence`).
 *
 * Residual, read as it stands: a hop mentioning neither (`./lint.sh $(…)`, even
 * where the file runs Biome); a global `biome` reached through a file, in a
 * repo with no other evidence; a runner other than `parallel`, `xargs`, `eval` or a shell with an expansion for
 * its command (`find -exec`, `su -c`, `env $X`, `exec $X`, `time $X`); and a glob outside
 * a command name's or Biome's slot (`npm run c?`, `biome check --st?ged`), which
 * makes its word only from a file of that name where it runs. */
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun", "bunx", "npx"];
const MENTIONS = new RegExp(
	`biome|(?:^|[\\s;&|(\`$"'=/])(?:${PACKAGE_MANAGERS.join("|")})(?=$|[\\s;&|)\`"'@])|\\$'[^']*\\\\`,
);

/* Commands that re-read their words as shell text, or append their input to
 * them, so the words written are not the words run (#3545), each with whether
 * the words after it hide what it runs. */
/** @type {Map<string, (rest: Word[]) => boolean>} */
const INDIRECT = new Map([
	["xargs", (rest) => isHiddenCommand(xargsCommand(rest))],
	["eval", (rest) => rest.some(isUnreadWord)],
]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
/* A shell's flag word holding `c`: it runs its operand as script text. */
const SCRIPT_FLAG = /^-[a-z]*c/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/* The shell's reserved words a command can follow. */
const RESERVED = new Set([
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"do",
	"!",
]);
/* GNU xargs's flags taking the next word (`xargs --help`, findutils). */
const XARGS_VALUE_FLAGS = new Set([
	"-a",
	"--arg-file",
	"-d",
	"--delimiter",
	"-E",
	"-I",
	"-L",
	"--max-lines",
	"-n",
	"--max-args",
	"-P",
	"--max-procs",
	"--process-slot-var",
	"-s",
	"--max-chars",
]);

/* Here-documents, whose bodies this tokeniser lexes as commands (#3545). */
const HEREDOCS = new Set(["<<", "<<-"]);

/**
 * Whether `re` matches `text`, with its quotes and backslashes deleted or not,
 * or a word `tokens` hold.
 * @param {RegExp} re @param {string} text @param {Token[]} tokens
 */
const hasMatch = (re, text, tokens) =>
	re.test(text.replace(/["'\\]/g, "")) ||
	re.test(text) ||
	allCommands(tokens).some((c) => c.some((w) => re.test(w.value)));

/**
 * The words naming what a shell runs, past its leading assignments and
 * reserved words.
 * @param {Word[]} command
 */
function withoutPrefix(command) {
	const at = command.findIndex(
		(w) => !ASSIGNMENT.test(w.value) && !RESERVED.has(w.value),
	);
	return at < 0 ? [] : command.slice(at);
}

/** @param {Word|undefined} before the word before */
const isXargsValue = (before) =>
	before !== undefined && XARGS_VALUE_FLAGS.has(before.value);

/**
 * The command in the words after `xargs`, past its flags.
 * @param {Word[]} words
 */
function xargsCommand(words) {
	const at = words.findIndex(
		(w, i) => !w.value.startsWith("-") && !isXargsValue(words[i - 1]),
	);
	return at < 0 ? [] : words.slice(at);
}

/**
 * The script a shell's `-c` runs, or undefined.
 * @param {Word[]} command
 */
function parseShellScript(command) {
	const [head, ...rest] = withoutPrefix(command);
	if (!head || !SHELLS.has(path.posix.basename(head.value))) return;
	const flag = rest.findIndex((w) => SCRIPT_FLAG.test(w.value));
	return flag < 0 ? undefined : rest[flag + 1];
}

/**
 * Whether `command` runs what its text does not show, mentioned or not: its
 * name is an expansion or a glob, it is `parallel`, whose command line is built
 * from its input, a shell reading its script from stdin, a shell whose script, or an `eval` whose words, hold an
 * expansion, or an `xargs` whose command's name is one (#3545, #3851). A shell's
 * single-quoted `-c` script holding one only past its command's name is read:
 * there it can only be an argument.
 * @param {Word[]} command
 */
function isHiddenCommand(command) {
	const [head, ...rest] = withoutPrefix(command);
	if (!head) return false;
	if (isUnreadWord(head) || head.glob) return true;
	const name = path.posix.basename(head.value);
	if (name === "parallel") return true;
	const indirect = INDIRECT.get(name);
	if (indirect) return indirect(rest);
	if (!SHELLS.has(name)) return false;
	if (!rest.some((w) => SCRIPT_FLAG.test(w.value)))
		return rest.every((w) => w.value.startsWith("-"));
	const script = parseShellScript(command);
	return (
		script !== undefined &&
		(isUnreadWord(script) ||
			writtenCommands(tokenise(script.value)).some(isHiddenCommand))
	);
}

/** Whether a word holds an expansion, or a construct dash reads otherwise.
 * @param {Word} w */
const isUnreadWord = (w) => isOpaque(w) || w.bashOnly;

/**
 * Whether `tokens` hold what this classifier cannot read as dash would: an
 * expansion or substitution, nested ones included; a construct bash reads
 * otherwise; a here-document; an INDIRECT command; or any of those in a
 * shell's `-c` script, quoted or not.
 * @param {Token[]} tokens
 * @returns {boolean}
 */
const isUnreadable = (tokens) =>
	tokens.some((t) => {
		const word = wordOf(t);
		return (
			(t.type === "redirect" && HEREDOCS.has(t.op)) ||
			(word?.type === "word" && isUnreadWord(word))
		);
	}) ||
	allCommands(tokens).some((c) => {
		const script = parseShellScript(c);
		return (
			c.some((w) => INDIRECT.has(path.posix.basename(w.value))) ||
			(script !== undefined && isUnreadable(tokenise(script.value)))
		);
	});

/* The names that find the `biome` the hook puts on PATH from
 * `node_modules/.bin` (#2597 §7), as the words before `check`, bare or after
 * `npx`. */
const MAPPED_NAMES = new Set(["biome", "@biomejs/biome"]);

/* Dropped, with WRITE_NOTE: their fixes would land in biome-staged.js's
 * thrown-away extract (#2597, #2598). */
const WRITE_FLAGS = new Set([
	"--write",
	"--fix",
	"--unsafe",
	"--apply",
	"--apply-unsafe",
]);
const WRITE_NOTE =
	"auto-fix on commit dropped; `biome-staged.js` lints a thrown-away extract of the index, and Biome's `--write` would rewrite the worktree file, a neighbour's hunks included (#2583)";

/* What each fails or checks on the extract, a fresh repo with no commits
 * (#2597 §5). */
const NO_EXTRACT = new Map([
	["--changed", "fails, as the extract has no commits"],
	["--since", "fails, as the extract has no commits"],
	["--watch", "never exits, so the commit hangs"],
	["--help", "prints help and checks nothing"],
	["--", "marks a path list biome-staged.js cannot keep"],
]);

/* Their paths resolve in, or write to, the thrown-away extract (#2597 §5). */
const PATH_FLAGS = new Set([
	"--config-path",
	"--vcs-root",
	"--reporter-file",
	"--log-file",
	"--stdin-file-path",
]);

/* The allowlist (#2597 §6's carry rows, #2599), by family: a switch, or a
 * value flag taking `--flag=value` with the value carried verbatim. Names are
 * `biome check --help`'s on 2.5.15 and 1.9.4. */
const CARRY_SWITCHES = new Set([
	// output and exit
	"--verbose",
	"--error-on-warnings",
	"--no-errors-on-unmatched",
	"--profile-rules",
	"--json",
	// per-file behaviour
	"--skip-errors",
	"--skip-parse-errors",
	"--use-server",
]);
const CARRY_VALUES = new Set([
	// output and exit
	"--reporter",
	"--max-diagnostics",
	"--diagnostic-level",
	"--colors",
	// per-file behaviour
	"--files-ignore-unknown",
	"--files-max-size",
	// analysis selection
	"--formatter-enabled",
	"--linter-enabled",
	"--assist-enabled",
	"--assists-enabled",
	"--organize-imports-enabled",
	"--enforce-assist",
	"--format-with-errors",
	"--only",
	"--skip",
	// general formatter options
	"--indent-style",
	"--indent-width",
	"--indent-size",
	"--line-ending",
	"--line-width",
	"--attribute-position",
	"--bracket-same-line",
	"--bracket-spacing",
	"--delimiter-spacing",
	"--expand",
	"--trailing-newline",
	"--use-editorconfig",
	"--jsx-quote-style",
	"--quote-properties",
	"--quote-style",
	"--trailing-commas",
	"--trailing-comma",
	"--semicolons",
	"--arrow-parentheses",
	"--jsx-everywhere",
	// logging
	"--log-level",
	"--log-kind",
	"--log-path",
	"--log-prefix-name",
	// VCS
	"--vcs-enabled",
	"--vcs-client-kind",
	"--vcs-use-ignore-file",
	"--vcs-default-branch",
]);
const CARRY_VALUE_PREFIXES = [
	"--javascript-",
	"--json-",
	"--css-",
	"--graphql-",
	"--grit-",
	"--html-",
];

/** @param {string} name */
const isValueFlag = (name) =>
	CARRY_VALUES.has(name) ||
	CARRY_VALUE_PREFIXES.some((p) => name.startsWith(p));

const OWN_FLAGS = `${BIOME_STAGED_COMMAND} <flags>`;

/**
 * @typedef {{command: string, note?: string}} MappedCommand `note`, present
 *   only where a write flag was dropped, is init's to print beside the command.
 */

/**
 * @typedef {{kind: "none"}
 *   | ({kind: "mapped"} & MappedCommand)
 *   | {kind: "refused", refusal: string}} StagedClass
 */

/** @typedef {{shape: string, wayOut: string}} Unmapped */

/** @param {string} clause */
const declareCheckStaged = (clause) => `Declare check_staged ${clause}.`;

const OWN_FLAGS_WAY_OUT = declareCheckStaged(
	`instead as an explicit '${OWN_FLAGS}' whose flags you own`,
);

/* `biome check`'s one short flag, judged under its long name (#2597 R5, #2871). */
const SHORT_FLAGS = new Map([["-h", "--help"]]);

/**
 * @param {string} word
 * @param {string|undefined} next the word after it
 * @returns {"drop"|"write"|"keep"|"path"|Unmapped} "write" is dropped too, and noted
 */
function judgeWord(word, next) {
	const eq = word.indexOf("=");
	const name = eq >= 0 ? word.slice(0, eq) : word;
	if (word === "--staged") return "drop";
	if (WRITE_FLAGS.has(word)) return "write";
	const fails = NO_EXTRACT.get(SHORT_FLAGS.get(name) ?? name);
	if (fails)
		return {
			shape: `passes ${name}, which on biome-staged.js's extract of the index ${fails}`,
			wayOut: declareCheckStaged(`without '${name}'`),
		};
	if (PATH_FLAGS.has(name))
		return {
			shape: `passes ${name}, whose path would resolve in, or write to, biome-staged.js's thrown-away extract`,
			wayOut: OWN_FLAGS_WAY_OUT,
		};
	if (!word.startsWith("-")) return "path";
	return judgeFlag(name, eq >= 0 ? word.slice(eq + 1) : null, next);
}

/**
 * A flag's verdict against the allowlist, which holds no short flag.
 * @param {string} name
 * @param {string|null} value what follows its `=`, or null for none
 * @param {string|undefined} next the word after it
 * @returns {"keep"|Unmapped}
 */
function judgeFlag(name, value, next) {
	if (CARRY_SWITCHES.has(name) || WRITE_FLAGS.has(name) || name === "--staged")
		return value === null
			? "keep"
			: {
					shape: `gives the switch ${name} a value, which Biome rejects`,
					wayOut: declareCheckStaged(`with the bare ${name}`),
				};
	if (isValueFlag(name)) {
		if (value) return "keep";
		return value === null
			? {
					shape: `gives ${name}'s value after a space`,
					wayOut: declareCheckStaged(
						`with the = form, ${name}=${next && !next.startsWith("-") ? next : "<value>"}`,
					),
				}
			: {
					shape: `gives ${name} an empty value`,
					wayOut: declareCheckStaged(`with ${name}=<value>`),
				};
	}
	return {
		shape: `passes ${name}, a flag not on biome-staged.js's allowlist`,
		wayOut: OWN_FLAGS_WAY_OUT,
	};
}

/** @type {Unmapped} */
const UNREAD = {
	shape:
		"holds words not known until the shell runs it, or read otherwise by dash than by bash — an expansion or substitution, $'…' or $\"…\", a brace expansion, a here-document, a command name that is an expansion or a glob, or a command such as xargs, eval or a shell reading stdin that builds its own command line — so whether it runs biome check --staged cannot be read",
	wayOut: declareCheckStaged(
		`with every word written out, as an explicit '${OWN_FLAGS}', or, where it never runs Biome, as a shell file (sh ./your-gate.sh) holding the command, whose text this check does not read`,
	),
};

/** @type {Unmapped} */
const QUOTED = {
	shape:
		"quotes or backslash-escapes a word, which this classifier cannot judge against biome-staged.js's allowlist",
	wayOut: declareCheckStaged("with every word unquoted and unescaped"),
};

/**
 * The one Biome command `words` makes, mapped, or why it does not map. A
 * write flag is dropped before the rest is judged.
 * @param {Word[]} words
 * @param {boolean} biome whether `package.json` declares `@biomejs/biome`
 * @returns {MappedCommand | Unmapped}
 */
function mapBiome(words, biome) {
	const values = words.map((w) => w.value);
	const at = values.indexOf("check");
	const why =
		unwrittenWord(words) ??
		unmappedRunner(values.slice(0, at).join(" "), biome);
	if (why) return why;
	const kept = [];
	const paths = [];
	let dropped = false;
	const flags = values.slice(at + 1);
	for (const [i, word] of flags.entries()) {
		const verdict = judgeWord(word, flags[i + 1]);
		if (typeof verdict === "object") return verdict;
		if (verdict === "write") dropped = true;
		if (verdict === "keep") kept.push(shellQuote(word));
		if (verdict === "path") paths.push(`"${word}"`);
	}
	const command = [BIOME_STAGED_COMMAND, ...kept].join(" ");
	if (paths.length > 0)
		return {
			shape: `passes the path ${paths.join(", ")}`,
			wayOut: declareCheckStaged(
				`instead as '${command}', with no path, as biome-staged.js checks every staged path`,
			),
		};
	return dropped ? { command, note: WRITE_NOTE } : { command };
}

/**
 * Why the words before `check` do not find the `biome` biome-staged.js runs,
 * or null.
 * @param {string} runner
 * @param {boolean} biome
 * @returns {Unmapped|null}
 */
function unmappedRunner(runner, biome) {
	if (!MAPPED_NAMES.has(runner.replace(/^npx /, "")))
		return {
			shape: PINNED.test(runner)
				? `pins Biome's version through "${runner}", which biome-staged.js cannot`
				: `runs Biome through "${runner}"`,
			wayOut: declareCheckStaged(
				`instead as a bare "biome check --staged …" script, or '${OWN_FLAGS}'`,
			),
		};
	return biome
		? null
		: {
				shape:
					"package.json does not declare @biomejs/biome, whose node_modules/.bin/biome biome-staged.js runs",
				wayOut: "Add @biomejs/biome to devDependencies.",
			};
}

/**
 * Why `words` cannot be carried into the mapped command as they stand, or
 * null.
 * @param {Word[]} words
 * @returns {Unmapped|null}
 */
const unwrittenWord = (words) => (words.some(isUnreadWord) ? UNREAD : null);

/**
 * mapBiome on a command as written, which is refused, not unquoted, where it
 * quotes or escapes a word: a quoted word is not judged against the
 * allowlist (#3414). A composite's Biome part is mapped from its unquoted
 * words instead.
 * @param {Word[]} words
 * @param {boolean} biome
 * @returns {MappedCommand | Unmapped}
 */
const mapAsWritten = (words, biome) =>
	words.some((w) => w.quoted) ? QUOTED : mapBiome(words, biome);

/** Whether `tokens` hold no operator, redirect or substitution.
 * @param {Token[]} tokens */
const isPlain = (tokens) =>
	tokens.every((t) => t.type === "word" && t.subs.length === 0);

/** Whether `tokens` are one simple command and nothing else, and what it is.
 * @param {Token[]} tokens */
const onlyCommand = (tokens) => {
	const [only, ...more] = simpleCommands(tokens);
	return isPlain(tokens) && more.length === 0 ? only : undefined;
};

/**
 * How a `check_staged` command that runs `biome check --staged` — itself or
 * through a `package.json` script it runs — becomes biome-staged.js (#2731):
 * `none` where it runs no such command; `mapped`, with a note where a write
 * flag was dropped; or `refused`. An explicit command that would map is
 * refused naming the mapped one, and, in a repo with Biome evidence, one that
 * mentions Biome or a package manager but holds what cannot be read as dash
 * would is refused unread. A `biome <subcommand> --staged` other than `check`
 * is refused and never mapped. One beginning with biome-staged.js is never
 * parsed. The refusal reads after `check_staged "<command>"
 * (<where it came from>) `.
 * @param {string} root
 * @param {string} command
 * @param {{inferred: boolean}} how
 * @returns {StagedClass}
 */
function classifyCheckStaged(root, command, { inferred }) {
	if (command.trim().startsWith(BIOME_STAGED_COMMAND)) return { kind: "none" };
	const top = path.resolve(root);
	const readCachedPackage = buildPackageReader();
	/**
	 * Evidence this repo runs Biome at all: `biome` written in the hop, or
	 * declared or in a script of the `package.json` at the top, the hop's
	 * directory, or a directory the hop's `cd` or runner's flag names (#3851).
	 * @param {Hop} hop
	 */
	const hasBiomeEvidence = ({ text, tokens, dir }) => {
		const hasEvidence = (/** @type {string} */ d) =>
			readCachedPackage(d).biomeEvident;
		return (
			hasMatch(BIOME_TEXT, text, tokens) ||
			hasEvidence(top) ||
			hasEvidence(dir) ||
			allCommands(tokens).some((c) =>
				hasEvidence(path.resolve(dir, parseNamedDir(c))),
			)
		);
	};
	const hit = walkRunScripts(
		top,
		(dir) => readCachedPackage(dir).scripts,
		command,
		/** @param {Hop} hop @param {Hop[]} hops */
		(hop, hops) => {
			const { text, tokens } = hop;
			const candidates = allCommands(tokens).map(withoutRun);
			const segment = candidates.find(isBiomeCheck);
			const other = candidates
				.map(parseBiomeSubcommand)
				.find((s) => s !== undefined);
			const biomeCommand = segment !== undefined || other !== undefined;
			const unread =
				((biomeCommand || hasMatch(MENTIONS, text, tokens)) &&
					isUnreadable(tokens)) ||
				writtenCommands(tokens).some(isHiddenCommand);
			if ((!unread && !biomeCommand) || !hasBiomeEvidence(hop)) return;
			if (unread) return { hops, unread: /** @type {const} */ (true) };
			if (segment === undefined)
				return {
					hops,
					other: other ?? "",
					unread: /** @type {const} */ (false),
				};
			const only = onlyCommand(tokens);
			/* The Biome command is the text's one command, with no run shed. */
			const own =
				only !== undefined &&
				segment === candidates[0] &&
				segment.length === only.length;
			return { hops, segment, own, unread: /** @type {const} */ (false) };
		},
	);
	if (!hit) return { kind: "none" };
	const via = hit.hops
		.slice(1)
		.map(
			(h) =>
				` through package.json script "${h.name}" ("${h.text}")${h.handed ? `, handed${h.handed}` : ""}`,
		)
		.join(",");
	/* Each hop above the Biome command must run that one script and nothing
	 * else, a redirect among its handed-on words included. */
	const single =
		hit.own &&
		hit.hops.every((h) => h.alone) &&
		hit.hops.slice(0, -1).every((h) => {
			const only = onlyCommand(h.tokens);
			return only !== undefined && findRun(only)?.at === 0;
		});
	/** @param {string} shape @param {string} wayOut @param {string} [runs] */
	const refused = (shape, wayOut, runs = "runs") => ({
		kind: /** @type {const} */ ("refused"),
		refusal: `${runs} biome check --staged${via}, which lints each staged path's worktree bytes, a neighbour's unstaged hunks included (#2583), and ${shape}. ${wayOut}`,
	});
	if (hit.unread) return refused(UNREAD.shape, UNREAD.wayOut, "may run");
	if (hit.segment === undefined)
		return {
			kind: "refused",
			refusal: `runs biome${hit.other ? ` ${hit.other}` : ""} --staged${via}, which reads or rewrites each staged path's worktree bytes, a neighbour's unstaged hunks included (#2583), in a shape biome-staged.js does not map. ${OWN_FLAGS_WAY_OUT}`,
		};
	const elsewhere = hit.hops.find((h) => h.dir !== top);
	if (elsewhere)
		return refused(
			`runs it in ${path.relative(top, elsewhere.dir)}, where biome-staged.js, which runs from the work tree's top, cannot follow`,
			OWN_FLAGS_WAY_OUT,
		);
	if (!single) {
		const part = mapBiome(hit.segment, readCachedPackage(top).biome);
		return refused(
			"holds more than that one command",
			declareCheckStaged(
				`instead as '${"command" in part ? part.command : OWN_FLAGS}' for the Biome part, and put the rest in a gate of its own`,
			),
		);
	}
	const mapped = mapAsWritten(hit.segment, readCachedPackage(top).biome);
	if (!("command" in mapped)) return refused(mapped.shape, mapped.wayOut);
	if (!inferred)
		return refused(
			`would map${mapped.note ? ` (${mapped.note})` : ""}, and an explicit value is never rewritten`,
			declareCheckStaged(`instead as '${mapped.command}'`),
		);
	return { kind: "mapped", ...mapped };
}

/** @param {string} root */
function hasPytestConfig(root) {
	/** @type {[string, RegExp|null][]} */
	const files = [
		["pytest.ini", null],
		["pyproject.toml", /^\[tool\.pytest\.ini_options\]/m],
		["setup.cfg", /^\[tool:pytest\]/m],
		["tox.ini", /^\[pytest\]/m],
	];
	return files.some(([file, section]) => {
		try {
			const text = fs.readFileSync(path.join(root, file), "utf8");
			return section === null || section.test(text);
		} catch {
			return false;
		}
	});
}

/* node --test's own default patterns' `.js` family (Node 24 docs, §Running
 * tests from the command line): `*.test`, `*-test`, `*_test`, `test-*`, `test`
 * and anything under a `test/` directory. Its `.ts` family is left out: a
 * `.ts` test in a repo declaring no test command is a vitest or jest suite far
 * more often than a type-stripped node one (#3170), so a repo whose node
 * tests are all `.ts` gets no command inferred. The walk skips dot-directories and `node_modules`. */
const NODE_TEST_FILE = /^(?:.*[.\-_]test|test-.*|test)\.[cm]?js$/;
const NODE_TEST_DIR_FILE = /\.[cm]?js$/;

/**
 * @param {string} dir
 * @param {boolean} [underTest] whether `dir` is, or sits under, a `test/`
 * @returns {boolean}
 */
function hasNodeTestFile(dir, underTest = false) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	const testPattern = underTest ? NODE_TEST_DIR_FILE : NODE_TEST_FILE;
	for (const e of entries) {
		if (e.isFile() && testPattern.test(e.name)) return true;
	}
	return entries.some(
		(e) =>
			e.isDirectory() &&
			!e.name.startsWith(".") &&
			e.name !== "node_modules" &&
			hasNodeTestFile(path.join(dir, e.name), underTest || e.name === "test"),
	);
}

/** @typedef {MappedCommand & {from: string}} Inferred */

/**
 * The command for `package.json`'s script `name`: `npm run <name>`, but for a
 * `check_staged` that maps to biome-staged.js. Residual: one refused stays
 * `npm run <name>`, until init's refusal step refuses it (#2774).
 * @param {string} root
 * @param {string} key
 * @param {string} name
 * @returns {MappedCommand}
 */
function scriptCommand(root, key, name) {
	const kept = `npm run ${name}`;
	if (key !== "check_staged") return { command: kept };
	const c = classifyCheckStaged(root, kept, { inferred: true });
	if (c.kind !== "mapped") return { command: kept };
	const { kind: _, ...mapped } = c;
	return mapped;
}

/**
 * @param {string} root
 * @returns {Partial<Record<keyof typeof SCRIPT_NAMES, Inferred>>}
 */
function inferCommands(root) {
	const { scripts } = readPackage(root);
	/** @type {Partial<Record<keyof typeof SCRIPT_NAMES, Inferred>>} */
	const found = {};
	for (const [command, names] of Object.entries(SCRIPT_NAMES)) {
		const name = names.find(
			(n) =>
				typeof scripts[n] === "string" &&
				scripts[n].trim() &&
				!(n === "test" && NPM_INIT_PLACEHOLDER.test(scripts[n])),
		);
		if (name)
			found[/** @type {keyof typeof SCRIPT_NAMES} */ (command)] = {
				...scriptCommand(root, command, name),
				from: "package.json",
			};
	}
	if (!found.test && hasPytestConfig(root))
		found.test = { command: "python3 -m pytest", from: "pytest config" };
	else if (!found.test && hasNodeTestFile(root))
		found.test = {
			command: "node --test",
			from: "node --test's default test files",
		};
	return found;
}

/**
 * The hook's check of a configured `check_staged`, from the work tree's top:
 * 1, printing the refusal, where it runs `biome check --staged`, mappable or
 * not — and where it cannot be
 * classified, so a fault refuses the commit; 2 on bad usage; else 0.
 * @param {string[]} argv
 * @returns {0|1|2}
 */
function main(argv) {
	const [verb, command, ...more] = argv;
	if (verb !== "check-staged" || command === undefined || more.length > 0) {
		writeFd(2, "usage: infer-commands.js check-staged <command>\n");
		return 2;
	}
	const named = `pre-commit: check_staged "${command}" (.claude/workflow-core.json)`;
	try {
		const verdict = classifyCheckStaged(process.cwd(), command, {
			inferred: false,
		});
		if (verdict.kind !== "refused") return 0;
		writeFd(2, `${named} ${verdict.refusal}\n`);
	} catch (err) {
		const why =
			err instanceof PackageParseError
				? `package.json does not parse (${err.detail}). Fix it, or declare check_staged in .claude/workflow-core.json as '${OWN_FLAGS}' or another command naming no ${PACKAGE_MANAGERS.join(", ")} or biome and with no expansion or glob for a command's name, no parallel and no shell reading stdin, which the hook checks without reading package.json.`
				: caught(err).message;
		writeFd(2, `${named} cannot be checked: ${why}\n`);
	}
	return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
	inferCommands,
	isLintStagedCommand,
	classifyCheckStaged,
	BIOME_STAGED_COMMAND,
};
