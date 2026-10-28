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
const { requiredGroup } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");

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

/* A quoted span, `$'…'` and `$"…"` included (#3422). */
const QUOTED_SPAN = /\$?(?:"[^"]*"|'[^']*')/g;
/** A `$'…'` holding an escape is kept as written, for EXPANSION to refuse.
 * @param {string} span */
const unquote = (span) =>
	/^\$'.*\\/s.test(span) ? span : span.replace(/^\$?["']|["']$/g, "");
const REDIRECT = new RegExp(
	String.raw`(?:(?<![^\s(\`])\d+)?(?:&>>?|[<>]&|>>?|<)[^\S\n]*(?:${QUOTED_SPAN.source}|[^\s()\`"'])*`,
	"g",
);
/* A backslash-newline, which the shell deletes. */
const CONTINUATION = /\\\n/g;
/* A command substitution, a parameter, brace or ANSI-C escape expansion,
 * whose words are not known until the shell runs it (#3422). */
const EXPANSION = /\$[({\w@*#?!$'-]|`|\{(?=[^{}\s]*(?:,|\.\.))[^{}\s]*\}/;

/* A command is read through each `npm run`, `pnpm run`, `yarn run` or
 * `bun run` it makes into the script that names, with the runner's flags
 * before the name, and the script is walked with the words the run hands on
 * to it on its end (#3153, #3193). Those words run to the end of the line or
 * an operator; `parseHandedWords` decides which reach the script.
 * Residual: a runner's run-less shorthand (`yarn <script>`), a name quoted in
 * part (`li"nt"`), and a script reached through a shell file, are not
 * followed. */
const RUN_WORD = new RegExp(
	String.raw`(?:${QUOTED_SPAN.source}|\$\(|[^\s;&|<>()"'])+`,
	"g",
);
const RUN_SCRIPT = new RegExp(
	String.raw`\b(npm|pnpm|yarn|bun)(?:\s+(?!run\b)[^\s;&|]+)*?\s+run(?:-script)?(?:\s+-\S+)*\s+(${QUOTED_SPAN.source}|[^\s;&|<>()"']+)((?:[^\S\n]*${REDIRECT.source}|[^\S\n]+${RUN_WORD.source})*)`,
	"g",
);
const HANDED_TOKEN = new RegExp(`(${REDIRECT.source})|${RUN_WORD.source}`, "g");

/**
 * The words after a run's script name that reach the script, unquoted, each
 * after a space, one holding a space kept quoted. npm keeps the flags before
 * a `--` as its own and drops the `--`; pnpm, yarn and bun hand on every
 * word (#3413). Residual: the value of an npm flag given after a space
 * (`--loglevel silent`) reads as a word handed on.
 * @param {string} runner
 * @param {string} words
 */
function parseHandedWords(runner, words) {
	const all = [...words.matchAll(HANDED_TOKEN)]
		.filter((m) => m[1] === undefined)
		.map((m) => m[0].replace(QUOTED_SPAN, unquote));
	const cut = all.indexOf("--");
	const kept =
		runner === "npm"
			? [
					...(cut < 0 ? all : all.slice(0, cut)).filter(
						(w) => !w.startsWith("-"),
					),
					...(cut < 0 ? [] : all.slice(cut + 1)),
				]
			: all;
	return kept.map((w) => (/\s/.test(w) ? ` "${w}"` : ` ${w}`)).join("");
}

/* A text with each run's runner and name shed and its handed-on words kept,
 * so words a run's own quote does not close, or a missing script's, are
 * still read where they stand (#3413). */
/** @param {string} text */
const replaceRunsWithHandedWords = (text) =>
	text.replace(RUN_SCRIPT, (...m) => ` ${m[3]}`);

/**
 * @typedef {{name: string|null, text: string, handed: string}} Hop `text` is
 *   the command itself where `name` is null, else `package.json`'s script
 *   `name`, its backslash-newlines folded; `handed` is the words the run
 *   hands on to that script, each after a space, or "".
 */

/**
 * Walks `command`, then each script it runs, each script once, handing `visit` the path of hops to each; the first result `visit`
 * returns that is not undefined is the walk's.
 * @template T
 * @param {Record<string, unknown>} scripts
 * @param {string} command
 * @param {(text: string, hops: Hop[]) => T|undefined} visit
 * @returns {T|undefined}
 */
function walkRunScripts(scripts, command, visit) {
	const seen = new Set();
	/**
	 * @param {Hop[]} hops ending at the hop walked
	 * @param {string} text that hop's text
	 * @returns {T|undefined}
	 */
	const walk = (hops, text) => {
		const hit = visit(text, hops);
		if (hit !== undefined) return hit;
		for (const m of text.matchAll(RUN_SCRIPT)) {
			const name = requiredGroup(m, 2, RUN_SCRIPT).replace(
				QUOTED_SPAN,
				unquote,
			);
			const raw = scripts[name];
			if (seen.has(name) || typeof raw !== "string") continue;
			seen.add(name);
			const script = raw.replace(CONTINUATION, "");
			const handed = parseHandedWords(
				requiredGroup(m, 1, RUN_SCRIPT),
				requiredGroup(m, 3, RUN_SCRIPT),
			);
			const found = walk(
				[...hops, { name, text: script, handed }],
				`${script}${handed}`,
			);
			if (found !== undefined) return found;
		}
		return hit;
	};
	const folded = command.replace(CONTINUATION, "");
	return walk([{ name: null, text: folded, handed: "" }], folded);
}

const LINT_STAGED = /(?:^|[\s;&|(/"'])lint-staged(?=$|[\s;&|)@"'])/;

/**
 * Whether `command` runs lint-staged, itself or through a `package.json`
 * script it runs.
 * @param {string} root
 * @param {string} command
 * @returns {boolean}
 */
function runsLintStaged(root, command) {
	const { scripts } = readPackage(root);
	return (
		walkRunScripts(scripts, command, (text) =>
			LINT_STAGED.test(replaceRunsWithHandedWords(text)) ? true : undefined,
		) ?? false
	);
}

const BIOME_STAGED_COMMAND = 'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js';

/* Biome's --staged lints the worktree's bytes of each staged path, so a
 * `commit-paths.js --patch` commit (#801) is judged on a neighbour's unstaged
 * hunks; biome-staged.js lints the index's (#2429, #2540). A command segment
 * runs it where a `biome check` carries `--staged`. */
const SEGMENT = /&&|\|\||[;|\n]|(?<![<>])&(?!>)/;
const BIOME_CHECK = /(?:^|[\s/])(?:@biomejs\/)?biome(?:@\S*)?\s+check(?=\s|$)/;
const STAGED = /(?:^|\s)--staged(?=[\s=]|$)/;
/* Anything that makes the text more than one command (#2599). */
const COMPOSITE = /[;&|<>()\n`]/;
const PINNED = /(?:^|\s)(?:@biomejs\/)?biome@/;
/* What a segment sheds before it is searched for `biome check --staged`, and
 * a composite's Biome part before it is mapped: a redirect with its target, a
 * subshell's or substitution's brackets, a group's braces, and quoting, a
 * quoted span's spaces joined so it stays one word. Each may touch a word
 * with no space between (#3153, #3191, #3414). Residual: a here-string's
 * word after a space is left behind, to be read as a path; and an expansion
 * inside the command's own words, not handed on (`bi$@ome`, `--sta$@ged`), is
 * read as written, so the word is no `biome` or `--staged` (#3422). */
const BRACKETING = /\$?[()`]|(?<!\S)[{}](?!\S)/g;
const QUOTING = /\$?["']|\\/g;
/** A quoted span's own commands, which a runner such as `concurrently` runs.
 * @param {string} text */
const quotedCommands = (text) =>
	[...text.matchAll(QUOTED_SPAN)].flatMap((m) => unquote(m[0]).split(SEGMENT));
/** @param {string} segment */
const shed = (segment) =>
	segment
		.replace(REDIRECT, " ")
		.replace(BRACKETING, " ")
		.replace(QUOTED_SPAN, (span) => unquote(span).replace(/\s/g, "_"))
		.replace(QUOTING, "");

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

/**
 * The one Biome command `text` holds, mapped, or why it does not map. A
 * write flag is dropped before the rest is judged.
 * @param {string} text
 * @param {boolean} biome whether `package.json` declares `@biomejs/biome`
 * @returns {MappedCommand | Unmapped}
 */
function mapBiome(text, biome) {
	const words = text.trim().split(/\s+/);
	const at = words.indexOf("check");
	const runner = words.slice(0, at).join(" ");
	if (!MAPPED_NAMES.has(runner.replace(/^npx /, "")))
		return {
			shape: PINNED.test(runner)
				? `pins Biome's version through "${runner}", which biome-staged.js cannot`
				: `runs Biome through "${runner}"`,
			wayOut: declareCheckStaged(
				`instead as a bare "biome check --staged …" script, or '${OWN_FLAGS}'`,
			),
		};
	if (!biome)
		return {
			shape:
				"package.json does not declare @biomejs/biome, whose node_modules/.bin/biome biome-staged.js runs",
			wayOut: "Add @biomejs/biome to devDependencies.",
		};
	const kept = [];
	const paths = [];
	let dropped = false;
	const flags = words.slice(at + 1);
	for (const [i, word] of flags.entries()) {
		const verdict = judgeWord(word, flags[i + 1]);
		if (typeof verdict === "object") return verdict;
		if (verdict === "write") dropped = true;
		if (verdict === "keep") kept.push(word);
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
 * mapBiome on a command as written, which is refused, not unquoted, where it
 * quotes or escapes a word: split on spaces, a quoted word cannot be judged
 * against the allowlist (#3414). A composite's Biome part is mapped from its
 * shed, unquoted segment instead.
 * @param {string} text
 * @param {boolean} biome
 * @returns {MappedCommand | Unmapped}
 */
function mapAsWritten(text, biome) {
	if (text.search(QUOTING) >= 0)
		return {
			shape:
				"quotes or backslash-escapes a word, which this classifier cannot judge against biome-staged.js's allowlist",
			wayOut: declareCheckStaged("with every word unquoted and unescaped"),
		};
	return mapBiome(text, biome);
}

/**
 * How a `check_staged` command that runs `biome check --staged` — itself or
 * through a `package.json` script it runs — becomes biome-staged.js (#2731):
 * `none` where it runs no such command; `mapped`, with a note where a write
 * flag was dropped; or `refused`. An explicit command that would map is
 * refused naming the mapped one. One beginning with biome-staged.js is never
 * parsed. The refusal reads after `check_staged "<command>"
 * (<where it came from>) `.
 * @param {string} root
 * @param {string} command
 * @param {{inferred: boolean}} how
 * @returns {StagedClass}
 */
function classifyCheckStaged(root, command, { inferred }) {
	if (command.trim().startsWith(BIOME_STAGED_COMMAND)) return { kind: "none" };
	const { scripts, biome } = readPackage(root);
	const hit = walkRunScripts(
		scripts,
		command,
		/** @param {string} text @param {Hop[]} hops */
		(text, hops) => {
			const opaque = hops.some((h) => EXPANSION.test(h.handed));
			const segment = replaceRunsWithHandedWords(text)
				.split(SEGMENT)
				.concat(quotedCommands(text))
				.map(shed)
				.find((s) => {
					const m = BIOME_CHECK.exec(s);
					return m && (opaque || STAGED.test(s.slice(m.index + m[0].length)));
				});
			return segment === undefined
				? undefined
				: { text, hops, segment, opaque };
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
	 * else, a redirect among its handed-on words included, as must the text
	 * holding it. */
	const above = hit.hops.slice(0, -1);
	const single =
		above.every(
			(h) =>
				[...h.text.matchAll(RUN_SCRIPT)].length === 1 &&
				!h.text.replace(RUN_SCRIPT, "").trim(),
		) &&
		![...above.map((h) => h.text), hit.text].some((t) =>
			COMPOSITE.test(t.trim()),
		);
	/** @param {string} shape @param {string} wayOut */
	const refused = (shape, wayOut) => ({
		kind: /** @type {const} */ ("refused"),
		refusal: `runs biome check --staged${via}, which lints each staged path's worktree bytes, a neighbour's unstaged hunks included (#2583), and ${shape}. ${wayOut}`,
	});
	if (hit.opaque)
		return refused(
			"is handed a command substitution, or a parameter, brace or ANSI-C escape expansion, whose words are not known until the shell runs it",
			declareCheckStaged("with the words it hands on written out"),
		);
	if (!single) {
		const part = mapBiome(hit.segment, biome);
		return refused(
			"holds more than that one command",
			declareCheckStaged(
				`instead as '${"command" in part ? part.command : OWN_FLAGS}' for the Biome part, and put the rest in a gate of its own`,
			),
		);
	}
	const mapped = mapAsWritten(hit.text, biome);
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
				? `package.json does not parse (${err.detail}). Fix it, or declare check_staged in .claude/workflow-core.json as '${OWN_FLAGS}' or another command whose text contains neither 'run' nor 'biome', which the hook does not classify.`
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
