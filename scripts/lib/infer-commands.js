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
const {
	BIOME_STAGED_COMMAND,
	BIOME_STAGED_START,
	OWN_FLAGS,
	OWN_FLAGS_WAY_OUT,
	UNREAD,
	UNRESOLVED_SELECTOR,
	declareCheckStaged,
	mapAsWritten,
	mapBiome,
} = require("./biome-allowlist.js");
const { bracketUnits } = require("./bracket-units.js");
const { caught } = require("./caught.js");
const {
	PackageReadError,
	buildPackageTree,
	readPackage,
} = require("./package-reader.js");
const {
	RUNNER_NAMES,
	findRun,
	isPlainWord,
	namedScriptWord,
	parseNamedDir,
	placedCommands,
	unresolvedSelectorMembers,
	walkRunScripts,
	withoutRun,
} = require("./script-runners.js");
const {
	allCommands,
	isOpaque,
	isUnreadWord,
	simpleCommands,
	tokenise,
	wordOf,
	writtenCommands,
} = require("./shell-tokens.js");
const { escapeRe } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");

/** @typedef {import("./shell-tokens.js").Word} Word */
/** @typedef {import("./shell-tokens.js").Token} Token */
/** @typedef {import("./script-runners.js").Hop} Hop */
/** @typedef {import("./package-reader.js").PackageTree} PackageTree */
/** @typedef {import("./script-runners.js").Placed} Placed */
/** @typedef {import("./biome-allowlist.js").MappedCommand} MappedCommand */

/**
 * @typedef {{kind: "none"}
 *   | ({kind: "mapped"} & MappedCommand)
 *   | {kind: "refused", refusal: string}} StagedClass
 */

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

const LINT_STAGED = /(?:^|\/)lint-staged(?:@.*)?$/;

/**
 * Whether `command` runs lint-staged, itself or through a `package.json`
 * script it runs.
 * @param {string} root
 * @param {string} command
 * @returns {boolean}
 */
function isLintStagedCommand(root, command) {
	const tree = buildPackageTree(root);
	return (
		walkRunScripts(tree, command, (hop) =>
			[...placedCommands(hop)].some((placed) =>
				withoutRun(placed, tree).some((w) => LINT_STAGED.test(w.value)),
			)
				? true
				: undefined,
		) ?? false
	);
}

/* Biome's --staged lints the worktree's bytes of each staged path, so a
 * `commit-paths.js --patch` commit (#801) is judged on its unstaged
 * hunks; biome-staged.js lints the index's (#2429, #2540). A simple command
 * runs it where a `biome` word, then `check`, is followed by `--staged`. */
const BIOME_WORD = /(?:^|\/)biome(?:@.*)?$/;
const CHECK_WORD = /^check$/;
const STAGED_WORD = /^--staged(?:=|$)/;
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

/**
 * Whether `word` is a glob that could name `biome`, each `[…]` read as any
 * one character.
 * @param {Word} word
 */
const isBiomeGlob = (word) => {
	if (!word.glob) return false;
	const source = bracketUnits(path.posix.basename(word.value))
		.map((c) => GLOB_SOURCE.get(c) ?? (c.length > 1 ? "." : escapeRe(c)))
		.join("");
	return new RegExp(`^${source}$`).test("biome");
};

/** The index of `command`'s `biome` word followed by `check`, a `--` between
 * them being npm exec's (`npm exec biome -- check`), or -1.
 * @param {Word[]} command */
const biomeCheckAt = (command) =>
	command.findIndex((w, i) => {
		const next = command[command[i + 1]?.value === "--" ? i + 2 : i + 1];
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
 * repo with no other evidence; Biome declared only in a nested package the
 * command does not name, which is no evidence, so `$GATE` at the top passes
 * (write its words out, or declare Biome at the top); a runner other than
 * `parallel`, `xargs`, `eval` or a shell with an expansion for its command
 * (`find -exec`, `su -c`, `env --split-string=sh`); npx's command set outside it
 * (`npm_config_call='biome check --staged' npx`), for which declare biome-staged.js; and a glob outside a
 * command name's or Biome's slot (`npm run c?`, `biome check --st?ged`), which
 * makes its word only from a file of that name where it runs.
 *
 * Residual, refused though Biome never runs, as the words cannot be shown not to
 * be Biome's (#4042): text naming the command, as an operand or a flag's value
 * (`echo "run biome check --staged by hand" && eslint .`,
 * `eslint --rule='biome check --staged'`), whose output a later word or an outer
 * script may run, so word the text otherwise; and expansions fitting Biome's
 * slots (`eslint $A $B $C`, `python -m ruff $OPTS check $FILES`), as any command
 * may run its operands, so write the words out. Either may instead go in a shell
 * file (`sh ./your-gate.sh`). */
const PACKAGE_MANAGERS = [...RUNNER_NAMES, "bunx", "npx"];
const MENTIONS = new RegExp(
	`biome|(?:^|[\\s;&|(\`$"'=/])(?:${PACKAGE_MANAGERS.join("|")})(?=$|[\\s;&|)\`"'@])|\\$'[^']*\\\\`,
);

/* Commands that re-read their words as shell text, or append their input to
 * them, so the words written are not the words run (#3545), each with whether
 * the words after it hide what it runs. */
/** @type {Map<string, (rest: Word[]) => boolean>} */
const INDIRECT = new Map([
	["xargs", (rest) => isHiddenCommand(parseXargsCommand(rest))],
	["eval", (rest) => rest.some(isUnreadWord)],
]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
/* A shell's flag word holding `c`: it runs its operand as script text. */
const SCRIPT_FLAG = /^-[a-z]*c/;
/* A shell's flag word holding `s`: it reads stdin, whatever operands follow. */
const STDIN_FLAG = /^-[a-zA-Z]*s/;
/* A shell's flags taking the next word (bash(1), dash(1)). */
const SHELL_VALUE_FLAG = /^(?:[-+][a-zA-Z]*[oO]|--rcfile|--init-file)$/;
/* Commands that run the words after them, each with its flags taking the next
 * word (their `--help`, coreutils; dash(1)). `env -S`'s next word is the
 * command. */
const EXEC_PREFIXES = new Map([
	["env", new Set(["-u", "--unset", "-C", "--chdir"])],
	["command", new Set()],
	["exec", new Set(["-a"])],
	["nice", new Set(["-n", "--adjustment"])],
	["nohup", new Set()],
	["time", new Set(["-f", "--format", "-o", "--output"])],
]);
/* `command`'s flags that name the command and run nothing. */
const COMMAND_LOOKUP = /^-p?[vV]/;
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
 * The words naming what a shell runs, past its leading assignments, reserved
 * words and any EXEC_PREFIXES command.
 * @param {Word[]} command
 * @returns {Word[]}
 */
function withoutPrefix(command) {
	const at = command.findIndex(
		(w) => !ASSIGNMENT.test(w.value) && !RESERVED.has(w.value),
	);
	const head = command[at];
	if (!head) return [];
	const flags = EXEC_PREFIXES.get(path.posix.basename(head.value));
	const rest = command.slice(at + 1);
	if (!flags) return command.slice(at);
	const [first] = rest;
	if (head.value === "command" && first && COMMAND_LOOKUP.test(first.value))
		return [];
	const next = rest.findIndex((w, i) => isPlainWord(w, rest[i - 1], flags));
	return next < 0 ? [] : withoutPrefix(rest.slice(next));
}

/**
 * The command in the words after `xargs`, past its flags.
 * @param {Word[]} words
 */
function parseXargsCommand(words) {
	const at = words.findIndex((w, i) =>
		isPlainWord(w, words[i - 1], XARGS_VALUE_FLAGS),
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
 * Whether a shell handed `words`, with no `-c`, reads its script from stdin:
 * it has no operand, or its flags hold an `s`.
 * @param {Word[]} words
 */
function isStdinScript(words) {
	let at = 0;
	for (let word = words[0]; word; word = words[at]) {
		if (word.value === "--") {
			at += 1;
			break;
		}
		if (!/^[-+]/.test(word.value)) break;
		at += SHELL_VALUE_FLAG.test(word.value) ? 2 : 1;
	}
	return (
		at >= words.length ||
		words.slice(0, at).some((w) => STDIN_FLAG.test(w.value))
	);
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
	if (!rest.some((w) => SCRIPT_FLAG.test(w.value))) return isStdinScript(rest);
	const script = parseShellScript(command);
	return (
		script !== undefined &&
		(isUnreadWord(script) ||
			writtenCommands(tokenise(script.value)).some(isHiddenCommand))
	);
}

/**
 * Whether `hop`'s tokens hold what this classifier cannot read as dash would: an
 * expansion or substitution, nested ones included; a construct bash reads
 * otherwise; a here-document; an INDIRECT command; or any of those in a
 * shell's `-c` script, quoted or not. A word naming a script is no INDIRECT
 * command (`npm run eval`, #4042).
 * @param {Hop} hop
 * @param {PackageTree} tree
 * @returns {boolean}
 */
const isUnreadable = (hop, tree) =>
	hop.tokens.some((t) => {
		const word = wordOf(t);
		return (
			(t.type === "redirect" && HEREDOCS.has(t.op)) ||
			(word?.type === "word" && isUnreadWord(word))
		);
	}) ||
	[...placedCommands(hop)].some((placed) => {
		const script = parseShellScript(placed.command);
		const name = namedScriptWord(placed, tree);
		return (
			placed.command.some(
				(w) => w !== name && INDIRECT.has(path.posix.basename(w.value)),
			) ||
			(script !== undefined &&
				isUnreadable({ ...hop, tokens: tokenise(script.value) }, tree))
		);
	});

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
 * `hop` past a biome-staged.js command it begins with, so that command's words
 * are not judged and what follows them is (#4042). One handed a word not known
 * until the shell runs it, which may run anything, is left whole.
 * @param {Hop} hop
 * @returns {Hop}
 */
function pastBiomeStaged(hop) {
	const start = BIOME_STAGED_START.exec(hop.text);
	if (!start) return hop;
	const end = hop.tokens.findIndex((t) => t.type !== "word");
	const own = end < 0 ? hop.tokens : hop.tokens.slice(0, end);
	const [, , ...handed] = own;
	if (handed.some((t) => t.type === "word" && isUnreadWord(t))) return hop;
	return {
		...hop,
		text: hop.text.slice(start[0].length),
		tokens: end < 0 ? [] : hop.tokens.slice(end),
	};
}

/**
 * The directory other than `top` the Biome command surely runs in, by its hop's
 * directory and its own `cd` or runner's flag, or undefined: a `cd` no `&&`
 * settles is refused as holding more than the Biome command. A hop passed through
 * on the way back to `top` is no such directory (#4069). Of several, the first
 * is named, as the refusal needs one.
 * @param {Placed|undefined} placed the Biome command
 * @param {string} top
 */
function findElsewhere(placed, top) {
	if (!placed) return;
	const own = parseNamedDir(placed.command);
	const dirs = placed.dirs.map((d) => path.resolve(d, own));
	return dirs.every((d) => d !== top) ? dirs[0] : undefined;
}

/**
 * How a `check_staged` command that runs `biome check --staged` — itself or
 * through a `package.json` script it runs — becomes biome-staged.js (#2731):
 * `none` where it runs no such command; `mapped`, with a note where a write
 * flag was dropped; or `refused`. An explicit command that would map is
 * refused naming the mapped one, and, in a repo with Biome evidence, one that
 * mentions Biome or a package manager but holds what cannot be read as dash
 * would, or an npm workspace selector no member answers, is refused unread. A `biome <subcommand> --staged` other than `check`
 * is refused and never mapped. One beginning with biome-staged.js is never
 * parsed; a text beginning with it in the hook's spelling of the root, or a script
 * in either, is judged on what follows it (#4042). What the walk reads wider than its runner is refused where it reaches
 * Biome, as is a script name holding an expansion (#3545); for a script the walk
 * does not follow, declare the Biome part as biome-staged.js and the rest in a
 * gate of its own (#2599). The refusal reads after `check_staged "<command>"
 * (<where it came from>) `.
 * @param {string} root
 * @param {string} command
 * @param {{inferred: boolean}} how
 * @returns {StagedClass}
 */
function classifyCheckStaged(root, command, { inferred }) {
	if (command.trim().startsWith(BIOME_STAGED_COMMAND)) return { kind: "none" };
	const tree = buildPackageTree(root);
	const { root: top, readCachedPackage } = tree;
	/**
	 * Evidence this repo runs Biome at all: `biome` written in the hop, or
	 * declared or in a script of the `package.json` at the top, the hop's
	 * directory, or a directory the hop's `cd` or runner's flag names (#3851), or
	 * a member an unresolved selector may reach (#4069).
	 * @param {Hop} hop
	 * @param {string[]} [members]
	 */
	const hasBiomeEvidence = ({ text, tokens, dir }, members = []) => {
		const hasEvidence = (/** @type {string} */ d) =>
			readCachedPackage(d).biomeEvident;
		return (
			hasMatch(BIOME_TEXT, text, tokens) ||
			hasEvidence(top) ||
			hasEvidence(dir) ||
			members.some(hasEvidence) ||
			allCommands(tokens).some((c) =>
				hasEvidence(path.resolve(dir, parseNamedDir(c))),
			)
		);
	};
	const hit = walkRunScripts(
		tree,
		command,
		/** @param {Hop} hop @param {Hop[]} hops */
		(hop, hops) => {
			const judged = pastBiomeStaged(hop);
			const { text, tokens } = judged;
			const placed = [...placedCommands(judged)];
			const candidates = placed.map((p) => withoutRun(p, tree));
			const segment = candidates.find(isBiomeCheck);
			const subcommand = candidates
				.map(parseBiomeSubcommand)
				.find((s) => s !== undefined);
			const biomeCommand = segment !== undefined || subcommand !== undefined;
			const unread =
				((biomeCommand || hasMatch(MENTIONS, text, tokens)) &&
					isUnreadable(judged, tree)) ||
				writtenCommands(tokens).some(isHiddenCommand);
			const unresolvedMembers = placed
				.map((p) => unresolvedSelectorMembers(p, tree))
				.find((members) => members !== undefined);
			if (
				(!unread && !unresolvedMembers && !biomeCommand) ||
				!hasBiomeEvidence(hop, unresolvedMembers)
			)
				return;
			if (unread) return { hops, unread: UNREAD };
			if (unresolvedMembers) return { hops, unread: UNRESOLVED_SELECTOR };
			if (segment === undefined) return { hops, subcommand, unread: null };
			const only = onlyCommand(tokens);
			/* The Biome command is the text's one command, with no run shed. */
			const own =
				only !== undefined &&
				segment === candidates[0] &&
				segment.length === only.length;
			return {
				hops,
				segment,
				own,
				elsewhere: findElsewhere(placed[candidates.indexOf(segment)], top),
				unread: null,
			};
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
		refusal: `${runs} biome check --staged${via}, which lints each staged path's worktree bytes, unstaged hunks included (#2583), and ${shape}. ${wayOut}`,
	});
	if (hit.unread)
		return refused(hit.unread.shape, hit.unread.wayOut, "may run");
	if (hit.segment === undefined)
		return {
			kind: "refused",
			refusal: `runs biome${hit.subcommand ? ` ${hit.subcommand}` : ""} --staged${via}, which reads or rewrites each staged path's worktree bytes, unstaged hunks included (#2583), in a shape biome-staged.js does not map. ${OWN_FLAGS_WAY_OUT}`,
		};
	if (hit.elsewhere)
		return refused(
			`runs it in ${path.relative(top, hit.elsewhere)}, where biome-staged.js, which runs from the work tree's top, cannot follow`,
			OWN_FLAGS_WAY_OUT,
		);
	if (!single) {
		const part = mapBiome(hit.segment, readCachedPackage(top).biome, inferred);
		return refused(
			"holds more than that one command",
			declareCheckStaged(
				`instead as '${"command" in part ? part.command : OWN_FLAGS}' for the Biome part, and put the rest in a gate of its own`,
			),
		);
	}
	const mapped = mapAsWritten(
		hit.segment,
		readCachedPackage(top).biome,
		inferred,
	);
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
			err instanceof PackageReadError
				? `${err.fault}. Fix it, or declare check_staged in .claude/workflow-core.json as '${OWN_FLAGS}' or another command naming no ${PACKAGE_MANAGERS.join(", ")} or biome and with no expansion or glob for a command's name, no parallel and no shell reading stdin, which the hook checks without reading package.json.`
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
};
