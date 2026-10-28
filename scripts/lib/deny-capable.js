/*
 * deny-capable.js — whether a guard script can refuse a tool call, read off
 * its own source. The one test the lost-deny reporter (`guard-lost-deny.js`),
 * the trigger table (`lib/guard-triggers.js`) and through it the census
 * (`lost-deny-rates.js`) all apply, so the three never disagree (#1815).
 *
 * THREE ROUTES TO A REFUSAL, each recognised in the guard's own text:
 *
 *   - A `permissionDecision` of `"deny"` written out by hand, as a JS object,
 *     a JSON string or a jq filter spells it — the shape an adopter's own
 *     node guard takes (#1815).
 *   - A `DENIES-THROUGH:` line in the guard's header comment, naming the
 *     script whose verdict it relays: a guard refusing through
 *     `session-arbiter.js check` names it. DECLARED, NOT DERIVED, because the delegate's
 *     text cannot say which subcommand denies — `push-review-owed.sh` calls the
 *     same arbiter's `writes`, which never does. It counts only where the
 *     script it names, beside the guard or under its `lib/`, writes a verdict
 *     by the first route: guard-dispatch.js relays its cores'
 *     merged verdict from lib/guard-dispatch.js.
 *   - A `DENIES-BY: exit 2` line in the header, for a hook that refuses by
 *     Claude Code's blocking exit with its reason on stderr, as
 *     `self-plugin-canary.sh` does to fail closed without jq (#2473).
 *     Declared, because most scripts here exit 2 on a usage error; it counts
 *     only where the script's body, below the header, carries an `exit 2`.
 *
 * A DISPATCHER CORE (lib/guard-cores.json) has a fourth route, since it
 * returns its verdict to lib/guard-dispatch.js rather than writing one:
 * `isDenyingCore` reads its module for a `deny:` key, or for guard-verdict.js's
 * `deny` or `denyText` helper, outside its whole-line comments (#3272).
 * Residual: a `deny:` in a string or a trailing comment reads as one.
 *
 * TEXTUAL, NOT A CALL GRAPH: a script that merely spells a deny verdict — in
 * a comment, or because it greps the guards for one — reads as deny-capable. Each
 * caller asks only of a `PreToolUse` registration, which is where that would
 * mislead.
 *
 * Residual: a guard that stops relaying its delegate's refusal keeps its
 * marker until someone deletes it, and still reads as deny-capable.
 */

const fs = require("node:fs");
const path = require("node:path");

/* `"?` and `\\?"` admit `permissionDecision: "deny"`, `"permissionDecision":
 * "deny"` and the escaped quotes of a JSON string inside a shell literal. */
const LITERAL_DENY = /\bpermissionDecision\\?"?\s*:\s*\\?"deny\\?"/;

const DENIES_THROUGH_MARKER =
	/^[ \t]*(?:#|\*|\/\/)[ \t]*DENIES-THROUGH:[ \t]*((?:lib\/)?[\w.-]+)/m;

const DENIES_BY_EXIT_MARKER =
	/^[ \t]*(?:#|\*|\/\/)[ \t]*DENIES-BY:[ \t]*exit 2\b/m;
const EXIT_2 = /\bexit 2\b/;

const CORE_DENY =
	/\bdeny\s*:|\{[^}]*\bdeny(?:Text)?\b[^}]*\}\s*=\s*require\(\s*["']\.\/guard-verdict\.js["']/;

/* A header line: blank, a shebang, or a shell, block or line comment. */
const HEADER_LINE = /^[ \t]*(?:$|#|\/\*|\*|\/\/)/;

/**
 * The leading comment block, so a marker quoted further down declares nothing.
 *
 * @param {string} text a guard's source
 * @returns {string}
 */
function headerOf(text) {
	const lines = text.split("\n");
	const end = lines.findIndex((l) => !HEADER_LINE.test(l));
	return (end === -1 ? lines : lines.slice(0, end)).join("\n");
}

/**
 * The script a guard's header says it relays a refusal from, or null.
 *
 * @param {string} text a guard's source
 * @returns {string | null}
 */
function deniesThrough(text) {
	return DENIES_THROUGH_MARKER.exec(headerOf(text))?.[1] ?? null;
}

/**
 * @param {string} text a guard's source
 * @returns {boolean}
 */
function hasExitDeny(text) {
	const header = headerOf(text);
	return (
		DENIES_BY_EXIT_MARKER.test(header) && EXIT_2.test(text.slice(header.length))
	);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function writesVerdict(text) {
	return LITERAL_DENY.test(text);
}

/**
 * @param {string} file
 * @returns {string | null} its text, or null where it will not read
 */
function readOrNull(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * Where guards are looked up: the core's first, then the session repo's own
 * (#1815). Core first, because an adopter's repo holds none of the core's
 * guards (#1017) and a same-named file there is not the script the plugin
 * wired. One directory where the two are the same checkout.
 *
 * @param {string} core the checkout or install that ships these scripts
 * @param {string} host the session's repo
 * @returns {string[]}
 */
function guardDirs(core, host) {
	return [...new Set([path.join(core, "scripts"), path.join(host, "scripts")])];
}

/**
 * Where `name` lives: the first of `dirs` that holds it, or null.
 *
 * The name comes off a hook command or a transcript record, so it is never
 * trusted as a path: anything but a bare filename resolves nowhere.
 *
 * @param {string} name a guard's basename, e.g. `guard-dispatch.js`
 * @param {string[]} dirs searched in order
 * @returns {string | null}
 */
function guardPath(name, dirs) {
	if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") return null;
	for (const dir of dirs) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return file;
	}
	return null;
}

/**
 * Whether the guard `name`, as found in `dirs`, can deny. A guard that cannot
 * be found or read cannot be shown to deny, and reads as one that cannot: a
 * false report of a lost deny costs a turn and teaches nothing.
 *
 * @param {string} name
 * @param {string[]} dirs
 * @returns {boolean}
 */
function isDenyCapable(name, dirs) {
	const file = guardPath(name, dirs);
	const text = file && readOrNull(file);
	if (!file || !text) return false;
	if (writesVerdict(text) || hasExitDeny(text)) return true;
	const delegate = deniesThrough(text);
	const [sub, base] = delegate?.startsWith("lib/")
		? ["lib", delegate.slice(4)]
		: ["", delegate];
	const relayed = base && guardPath(base, [path.join(path.dirname(file), sub)]);
	const relayedText = relayed && readOrNull(relayed);
	return Boolean(relayedText && writesVerdict(relayedText));
}

/**
 * Whether the dispatcher core module at `file` can refuse a call. One the
 * manifest names that will not read can: unknown is not zero, and the
 * dispatcher would have loaded it (#3272).
 *
 * @param {string} file
 * @returns {boolean}
 */
function isDenyingCore(file) {
	const text = readOrNull(file);
	if (!text) return true;
	const code = text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
	return CORE_DENY.test(code);
}

/**
 * `isDenyCapable` over fixed `dirs`, memoised for one process.
 *
 * @param {string[]} dirs
 * @returns {(name: string) => boolean}
 */
function isDenyCapableIn(dirs) {
	/** @type {Map<string, boolean>} */
	const memo = new Map();
	return (name) => {
		let capable = memo.get(name);
		if (capable === undefined) {
			capable = isDenyCapable(name, dirs);
			memo.set(name, capable);
		}
		return capable;
	};
}

module.exports = { isDenyingCore, guardDirs, guardPath, isDenyCapableIn };
