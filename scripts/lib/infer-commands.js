/*
 * infer-commands.js — a repo's commands, `SCRIPT_NAMES`'s keys, found rather than asked (#692): `package.json` scripts first, then
 * pytest config, then `*.test.js` files ⇒ `node --test`. Only `test` has the
 * two fallbacks. An empty repo gets none. `runsLintStaged` judges whether a
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
const { isOpaque, tokenise } = require("./shell-tokens.js");
const { writeFd } = require("./write-fd.js");

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

/** `readPackage(root)`, read at the first call and kept. @param {string} root */
function packageOnDemand(root) {
	/** @type {ReturnType<typeof readPackage>|undefined} */
	let pkg;
	return () => {
		pkg ??= readPackage(root);
		return pkg;
	};
}

/**
 * Throws a PackageParseError on a `package.json` that does not parse, which
 * would otherwise read as one naming no script.
 * @param {string} root
 */
function readPackage(root) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, "package.json"), "utf8");
	} catch {
		return { scripts: {}, biome: false };
	}
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch (err) {
		throw new PackageParseError(caught(err).message, { cause: err });
	}
	const scripts = pkg?.scripts;
	return {
		scripts: scripts && typeof scripts === "object" ? scripts : {},
		biome: ["dependencies", "devDependencies"].some(
			(k) => typeof pkg?.[k]?.["@biomejs/biome"] === "string",
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

/* A command is read through each `npm run`, `pnpm run`, `yarn run` or
 * `bun run` it makes into the script that names, with the runner's flags
 * before the name, and the script is walked with the words the run hands on
 * to it on its end (#3153, #3193). Residual: a runner's run-less shorthand
 * (`yarn <script>`) and a script reached through a shell file are not
 * followed; a script name holding an expansion is refused (#3545). */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** @typedef {{runner: string, name: string, at: number, end: number}} Run
 *  `at` the runner's index in its command, `end` past the script name's. */

/** @param {Word[]} command @returns {Run|undefined} */
function findRun(command) {
	const at = command.findIndex((w) => !isOpaque(w) && RUNNERS.has(w.value));
	const runner = command[at];
	if (!runner) return;
	let k = command.findIndex(
		(w, i) => i > at && (w.value === "run" || w.value === "run-script"),
	);
	if (k < 0) return;
	do k++;
	while (command[k]?.value.startsWith("-"));
	const name = command[k];
	if (!name || isOpaque(name)) return;
	return { runner: runner.value, name: name.value, at, end: k + 1 };
}

/* A command with its run's runner and name shed and its handed-on words
 * kept, so words a missing script's run hands on are still read where they
 * stand (#3413). */
/** @param {Word[]} command */
function withoutRun(command) {
	const run = findRun(command);
	return run
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

/* What `sh -c` reads as a literal word unquoted. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** `text` as one word `sh -c` passes on exactly (#3545). @param {string} text */
const shellQuote = (text) =>
	SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;

/** @param {Word[]} words */
const showHanded = (words) =>
	words.map((w) => ` ${isOpaque(w) ? w.raw : shellQuote(w.value)}`).join("");

/**
 * @typedef {{name: string|null, text: string, handed: string, tokens:
 *   Token[]}} Hop `text` is the command itself where `name` is null, else
 *   `package.json`'s script `name`, its backslash-newlines folded; `handed`
 *   the words the run hands on to that script, each after a space, or "";
 *   `tokens` the text's with those words on the end.
 */

/**
 * Walks `command`, then each script it runs, each script once, handing
 * `visit` each hop and the path of hops to it; the first result `visit` returns that is
 * not undefined is the walk's.
 * @template T
 * @param {() => Record<string, unknown>} scriptsOf called at each run found,
 *   so a command running none reads no `package.json` (#3546); a caller
 *   passes one that reads it once
 * @param {string} command
 * @param {(hop: Hop, hops: Hop[]) => T|undefined} visit
 * @returns {T|undefined}
 */
function walkRunScripts(scriptsOf, command, visit) {
	const seen = new Set();
	/**
	 * @param {Hop} hop
	 * @param {Hop[]} hops ending at `hop`
	 * @returns {T|undefined}
	 */
	const walk = (hop, hops) => {
		const hit = visit(hop, hops);
		if (hit !== undefined) return hit;
		for (const simple of allCommands(hop.tokens)) {
			const run = findRun(simple);
			if (!run) continue;
			const raw = scriptsOf()[run.name];
			if (seen.has(run.name) || typeof raw !== "string") continue;
			seen.add(run.name);
			const handed = handedWords(run.runner, simple.slice(run.end));
			/** @type {Hop} */
			const next = {
				name: run.name,
				text: raw.replace(CONTINUATION, ""),
				handed: showHanded(handed),
				tokens: [...tokenise(raw), ...handed],
			};
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
function runsLintStaged(root, command) {
	const pkg = packageOnDemand(root);
	return (
		walkRunScripts(
			() => pkg().scripts,
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

/**
 * Whether `word` is, or could be once expanded, a word `re` matches: any word
 * holding an expansion could, in any slot (#3545).
 * @param {Word} word @param {RegExp} re
 */
const isPossibly = (word, re) => re.test(word.value) || isOpaque(word);

/** The index of `command`'s `biome` word followed by `check`, or -1.
 * @param {Word[]} command */
const biomeCheckAt = (command) =>
	command.findIndex((w, i) => {
		const next = command[i + 1];
		return (
			next !== undefined &&
			isPossibly(w, BIOME_WORD) &&
			isPossibly(next, CHECK_WORD)
		);
	});

/* Text that could run Biome or a script, read with its quotes and
 * backslashes deleted, which split a word without changing it (`bi""ome`,
 * `r\un`), classify the hop (#3545). A `$'…'` escape may decode to either, so counts too.
 * Residual: a hop mentioning neither is not, nor is a runner outside
 * HIDING (`find -exec`, `su -c`) or a script reached through a shell file. */
const MENTIONS = /biome|\brun\b|\$'[^']*\\/;

/* A command whose command line is built from its input, so it can hold what
 * the text never mentions (#3545). */
const HIDING = new Set(["parallel"]);
/* Commands that re-read their words as shell text, or append their input to
 * them, so the words written are not the words run (#3545). */
const INDIRECT = new Set(["xargs", "eval"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
/* A shell's flag word holding `c`: it runs its operand as script text. */
const SCRIPT_FLAG = /^-[a-z]*c/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/* Here-documents, whose bodies this tokeniser lexes as commands (#3545). */
const HEREDOCS = new Set(["<<", "<<-"]);

/**
 * Whether `text`, or a word `tokens` hold, could run Biome or a script.
 * @param {string} text @param {Token[]} tokens
 */
const hasMention = (text, tokens) =>
	MENTIONS.test(text.replace(/["'\\]/g, "")) ||
	MENTIONS.test(text) ||
	allCommands(tokens).some((c) => c.some((w) => MENTIONS.test(w.value)));

/**
 * Whether `command` runs what its text does not show, mentioned or not: its
 * name is an expansion, it is a HIDING command, a shell reading its script
 * from stdin, or a shell, `xargs` or `eval` whose command or script holds
 * an expansion (#3545).
 * @param {Word[]} command
 */
function isHiddenCommand(command) {
	const words = command.filter((w, i) => i > 0 || !ASSIGNMENT.test(w.value));
	const head = words[0];
	if (!head) return false;
	if (isUnreadWord(head)) return true;
	const name = path.posix.basename(head.value);
	const rest = words.slice(1);
	if (HIDING.has(name)) return true;
	if (name === "xargs")
		return isHiddenCommand(rest.filter((w) => !w.value.startsWith("-")));
	if (name === "eval") return rest.some(isUnreadWord);
	if (!SHELLS.has(name)) return false;
	const script = rest.findIndex((w) => SCRIPT_FLAG.test(w.value));
	if (script >= 0) return rest.slice(script + 1, script + 2).some(isUnreadWord);
	return rest.every((w) => w.value.startsWith("-"));
}

/** Whether a word holds an expansion, or a construct dash reads otherwise.
 * @param {Word} w */
const isUnreadWord = (w) => isOpaque(w) || w.bashOnly;

/**
 * Whether `tokens` hold what this classifier cannot read as dash would: an
 * expansion or substitution, nested ones included; a construct bash reads
 * otherwise; a here-document; or an INDIRECT command.
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
	allCommands(tokens).some((c) =>
		c.some((w) => INDIRECT.has(path.posix.basename(w.value))),
	);

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
		"holds words not known until the shell runs it, or read otherwise by dash than by bash — an expansion or substitution, $'…' or $\"…\", a brace expansion, a here-document, a command name that is an expansion, or a command such as xargs, eval or a shell reading stdin that builds its own command line — so whether it runs biome check --staged cannot be read",
	wayOut: declareCheckStaged(
		`with every word written out, or as an explicit '${OWN_FLAGS}'`,
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
 * refused naming the mapped one, and one that mentions Biome or a run but
 * holds what cannot be read as dash would is refused unread. One beginning
 * with biome-staged.js is never parsed. The refusal reads after `check_staged "<command>"
 * (<where it came from>) `.
 * @param {string} root
 * @param {string} command
 * @param {{inferred: boolean}} how
 * @returns {StagedClass}
 */
function classifyCheckStaged(root, command, { inferred }) {
	if (command.trim().startsWith(BIOME_STAGED_COMMAND)) return { kind: "none" };
	const pkg = packageOnDemand(root);
	const hit = walkRunScripts(
		() => pkg().scripts,
		command,
		/** @param {Hop} hop @param {Hop[]} hops */
		({ text, tokens }, hops) => {
			const candidates = allCommands(tokens).map(withoutRun);
			const segment = candidates.find((c) => {
				const at = biomeCheckAt(c);
				return (
					at >= 0 && c.slice(at + 2).some((w) => isPossibly(w, STAGED_WORD))
				);
			});
			if (
				((segment || hasMention(text, tokens)) && isUnreadable(tokens)) ||
				allCommands(tokens, false).some(isHiddenCommand)
			)
				return { hops, unread: /** @type {const} */ (true) };
			if (segment === undefined) return;
			const only = onlyCommand(tokens);
			/* The Biome command is the text's one command, with no run shed. */
			const own =
				only !== undefined && !findRun(only) && segment === candidates[0];
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
	if (!single) {
		const part = mapBiome(hit.segment, pkg().biome);
		return refused(
			"holds more than that one command",
			declareCheckStaged(
				`instead as '${"command" in part ? part.command : OWN_FLAGS}' for the Biome part, and put the rest in a gate of its own`,
			),
		);
	}
	const mapped = mapAsWritten(hit.segment, pkg().biome);
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
				? `package.json does not parse (${err.detail}). Fix it, or declare check_staged in .claude/workflow-core.json as '${OWN_FLAGS}' or another command holding no npm, pnpm, yarn or bun run and no biome check, which the hook checks without reading package.json.`
				: caught(err).message;
		writeFd(2, `${named} cannot be checked: ${why}\n`);
	}
	return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
	inferCommands,
	runsLintStaged,
	classifyCheckStaged,
	BIOME_STAGED_COMMAND,
};
