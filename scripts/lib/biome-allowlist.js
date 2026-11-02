/*
 * biome-allowlist.js — what a `biome check` command's words become on
 * biome-staged.js (#3947): the flags it carries, drops or refuses, and the way
 * out each refusal names. A flag maps only from this list, so one Biome ships
 * later never maps unreviewed (#2599). infer-commands.js's
 * `classifyCheckStaged` finds the command.
 */

const { isUnreadWord } = require("./shell-tokens.js");
const { shellQuote } = require("./sh-quote.js");

/** @typedef {import("./shell-tokens.js").Word} Word */

const BIOME_STAGED_COMMAND = 'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js';

const PINNED = /(?:^|\s)(?:@biomejs\/)?biome@/;

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
 * The one Biome command `words` makes, mapped, or why it does not map.
 * @param {Word[]} words
 * @param {boolean} biome whether `package.json` declares `@biomejs/biome`
 * @param {boolean} inferred whether init reads the script, so can map a bare one
 * @returns {MappedCommand | Unmapped}
 */
function mapBiome(words, biome, inferred) {
	const values = words.map((w) => w.value);
	const at = values.indexOf("check");
	const why =
		unwrittenWord(words) ??
		unmappedRunner(values.slice(0, at).join(" "), biome, inferred);
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
 * @param {boolean} inferred
 * @returns {Unmapped|null}
 */
function unmappedRunner(runner, biome, inferred) {
	if (!MAPPED_NAMES.has(runner.replace(/^npx /, "")))
		return {
			shape: PINNED.test(runner)
				? `pins Biome's version through "${runner}", which biome-staged.js cannot`
				: `runs Biome through "${runner}"`,
			wayOut: declareCheckStaged(
				inferred
					? `instead as a bare "biome check --staged …" script, or '${OWN_FLAGS}'`
					: `instead as '${OWN_FLAGS}'`,
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
 * @param {boolean} inferred
 * @returns {MappedCommand | Unmapped}
 */
const mapAsWritten = (words, biome, inferred) =>
	words.some((w) => w.quoted) ? QUOTED : mapBiome(words, biome, inferred);

module.exports = {
	BIOME_STAGED_COMMAND,
	OWN_FLAGS,
	OWN_FLAGS_WAY_OUT,
	UNREAD,
	declareCheckStaged,
	mapAsWritten,
	mapBiome,
};
