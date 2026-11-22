/*
 * rule-text.js — the Node half of the rule-text store (mantahostels#1644, spec mantahostels#1641).
 *
 * THE SEAM. Each guard-printed rule's operative text lives exactly once, as a plain
 * text file under docs/agents/rules/ keyed by a stable rule id. This module is
 * the only thing Node-side that resolves an id to that text; scripts/lib/
 * rule-text.sh is the bash twin, and the two answer identically by construction
 * (same directories in the same order, same id grammar, same trailing-newline
 * trim, same `{rule:<id>}` expansion).
 *
 * PLAIN TEXT, NOT JSON — spec mantahostels#1641's decision. The guards are half bash and
 * half Node; a fragment must be `cat`-able from one and fs.readFileSync-able
 * from the other with no parser.
 *
 * IT REFUSES LOUDLY. An unknown id throws rather than returning "" — a guard
 * that silently denies with an empty reason is worse than one that crashes,
 * because the session is refused and told nothing. Callers that must not crash
 * call readRuleTextOr, or catch it themselves and fail open in the house style
 * (mantahostels#103). The one
 * exception is expandCommands, on a host config it cannot read (#742).
 *
 * THE DIRECTORY OVERRIDE. WFC_RULES_DIR redirects the store, and with it set
 * WFC_RULES_FALLBACK_DIR is the only layer beneath it — unset, no core
 * fragment resolves (rulesDirs). Both are for tests, and
 * for check-guard-registry.js's --root, which sets both for an adopter root
 * (mantahostels#1753). It is read at
 * call time, not at require time, so a test can set it per case.
 * withRuleStore pins the same pair for one synchronous read, in this module
 * rather than the environment, so a caller sharing the process with other
 * work leaves nothing behind it (#5172).
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { qualifyProse } = require("./qualify-citations.js");
const { readConfig } = require("./workflow-core-config.js");
const {
	docPath,
	expandPastePaths,
	inCheckout,
	resolveScriptPaths,
	scriptPath,
} = require("./script-path.js");
const { caught, ignoreFailure, orFallback } = require("./caught.js");
const { trimEndRun } = require("./trim-run.js");

const RULES_DIR = "docs/agents/rules";

const RULE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RULE_ID_PREFIX = "rule:";

const COMMAND_PLACEHOLDER = /\{command:([a-z_]+)\}/g;

const RULE_INCLUDE = /\{rule:([a-z0-9]+(?:-[a-z0-9]+)*)\}/g;

/** @param {string} id @returns {string} */
function bareRuleId(id) {
	return id.startsWith(RULE_ID_PREFIX) ? id.slice(RULE_ID_PREFIX.length) : id;
}

const FRAGMENT_EXT = ".txt";

const MANIFEST_NAME = "manifest.json";

const CORE_RULES = path.join(__dirname, "..", "..", RULES_DIR);

/** @type {{ dir: string, fallback: string | undefined } | null} */
let pinned = null;

const overrideDir = () => (pinned ? pinned.dir : process.env.WFC_RULES_DIR);

/**
 * @template T
 * @param {string | undefined} dir
 * @param {string | undefined} fallback
 * @param {() => T} read
 * @returns {T}
 */
function withRuleStore(dir, fallback, read) {
	if (dir === undefined) return read();
	const before = pinned;
	pinned = { dir, fallback };
	try {
		return read();
	} finally {
		pinned = before;
	}
}

/** @type {string | null} */
let pinnedHostRoot = null;

/**
 * @template T
 * @param {string} spelling
 * @param {() => T} read
 * @returns {T}
 */
function withHostRootSpelling(spelling, read) {
	const before = pinnedHostRoot;
	pinnedHostRoot = spelling;
	try {
		return read();
	} finally {
		pinnedHostRoot = before;
	}
}

/** @param {string} [root] @returns {string} */
function rulesDir(root) {
	const override = overrideDir();
	if (override) return path.resolve(override);
	const host = path.join(root ?? hostRoot(), RULES_DIR);
	if (fs.statSync(host, { throwIfNoEntry: false })?.isDirectory()) return host;
	return CORE_RULES;
}

/** @returns {string | null} */
function coreLayer() {
	if (!overrideDir()) return CORE_RULES;
	const fallback = pinned
		? pinned.fallback
		: process.env.WFC_RULES_FALLBACK_DIR;
	return fallback ? path.resolve(fallback) : null;
}

/** @param {string} [root] @returns {string[]} */
function rulesDirs(root) {
	const primary = rulesDir(root);
	const second = coreLayer();
	return !second || second === primary ? [primary] : [primary, second];
}

/** @returns {string} */
function manifestPath() {
	return path.join(rulesDir(), MANIFEST_NAME);
}

/**
 * @param {string} dir
 * @returns {fs.Dirent[]}
 */
function readStoreEntries(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
		return [];
	}
}

/** @param {string} [root] @returns {string[]} */
function readRuleIds(root) {
	/** @type {Set<string>} */
	const ids = new Set();
	for (const dir of rulesDirs(root))
		for (const e of readStoreEntries(dir))
			if (e.isFile() && e.name.endsWith(FRAGMENT_EXT)) {
				const id = e.name.slice(0, -FRAGMENT_EXT.length);
				if (RULE_ID_RE.test(id)) ids.add(id);
			}
	return [...ids].sort();
}

/** @param {string} bare @param {string} [root] @returns {string} */
function fragmentPath(bare, root) {
	const name = `${bare}${FRAGMENT_EXT}`;
	for (const dir of rulesDirs(root)) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return file;
	}
	return path.join(rulesDir(root), name);
}

class RuleMissing extends Error {
	/** @override */
	name = "RuleMissing";

	/**
	 * @param {string} message
	 * @param {ErrorOptions & { brief: string }} options
	 */
	constructor(message, { brief, ...options }) {
		super(message, options);
		this.brief = brief;
	}
}

/**
 * @param {string} id
 * @param {string} host
 * @returns {{ file: string, body: string }}
 */
function readFragment(id, host) {
	const bare = typeof id === "string" ? bareRuleId(id) : "";
	if (!RULE_ID_RE.test(bare))
		throw new Error(
			`rule-text: "${id}" is not a rule id — ids are lowercase kebab-case ` +
				`(${RULE_ID_RE.source}).`,
		);
	const file = fragmentPath(bare, host);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		const known = readRuleIds(host);
		const brief = `rule-text: no fragment for rule id "${bare}" (looked in ${rulesDirs(host).join(", ")}).`;
		const held =
			known.length > 0
				? `Known ids: ${known.join(", ")}.`
				: "The store holds no fragments.";
		throw new RuleMissing(`${brief} ${held}`, { cause: e, brief });
	}
	const body = trimEndRun(text, "\n");
	if (!body.trim())
		throw new Error(
			`rule-text: the fragment for rule id "${bare}" (${file}) is empty. ` +
				"A guard printing it would deny a session and state no rule.",
		);
	return { file, body };
}

/** @param {string} body @param {string} host @returns {string} */
function expandIncludes(body, host) {
	return body.replace(RULE_INCLUDE, (_, inc) => {
		const included = readFragment(inc, host).body;
		if (included.includes("{rule:"))
			throw new Error(
				`rule-text: the fragment for rule id "${inc}" is included by another and holds an include of its own.`,
			);
		return included;
	});
}

/**
 * The operative text of rule `id`.
 *
 * Trailing newlines are trimmed so that a fragment splices into a guard's deny
 * reason without a blank line the author of the fragment never saw. Interior
 * whitespace is untouched — a fragment's paragraph breaks are its own.
 *
 * @param {string} id
 * @param {string} [root] as rulesDir takes it; every host read below is under
 *   it, so the root is resolved once a call
 * @returns {string}
 * @throws {Error} as readFragment and expandIncludes do
 */
function readRuleText(id, root) {
	const host = root ?? hostRoot();
	const { file, body } = readFragment(id, host);
	const resolved = expandPastePaths(
		resolveScriptPaths(expandIncludes(body, host)),
		pinnedHostRoot ?? host,
	);
	return expandCommands(
		!inCheckout() && path.dirname(file) === coreLayer()
			? qualifyProse(resolved)
			: resolved,
		host,
	);
}

/** @param {string} text @param {string} root @returns {string} */
function expandCommands(text, root) {
	if (!text.includes("{command:")) return text;
	/** @type {Record<string, string|null>} */
	let commands = {};
	try {
		commands = readConfig({ root, quiet: true }).commands;
	} catch (e) {
		process.stderr.write(
			`WARN rule-text: ${caught(e).message} — every {command:} line dropped\n`,
		);
	}
	const kept = [];
	for (const line of text.split("\n")) {
		let undeclared = false;
		const out = line.replace(COMMAND_PLACEHOLDER, (_, name) => {
			const cmd = commands[name];
			if (cmd) return cmd;
			undeclared = true;
			return "";
		});
		if (!undeclared) kept.push(out);
	}
	return kept.join("\n");
}

/** @param {string} id @param {string} head @returns {string} */
function readRuleParagraph(id, head) {
	const paragraph = orFallback(
		() =>
			readRuleText(id)
				.split(/\n\s*\n/)
				.find((p) => p.startsWith(head)),
		undefined,
	);
	if (paragraph) return paragraph;
	return `The rule could not be read here: run \`${scriptPath("lib/rule-text.sh")} ${bareRuleId(id)}\` and follow the paragraph opening ${head}.`;
}

/** @param {string} id @returns {string} */
function rulePointer(id) {
	return `The full rule: \`${scriptPath("lib/rule-text.sh")} ${bareRuleId(id)}\`.`;
}

/** @param {string} root @returns {(id: string) => string} */
const fragmentLookup = (root) => (id) => {
	try {
		return readRuleText(id, root);
	} catch {
		return "";
	}
};

/**
 * readRuleText for a guard or checker that must not crash: where the fragment
 * cannot be read it logs the failure under `label` and answers `lead` in the
 * guard fallback template (#3018), which rule-fallback-template.test.ts holds.
 * @param {string} id
 * @param {string} lead a one-clause stand-in for the rule, with no closing stop
 * @param {string} label the guard, as the error log names it
 * @param {string} [hostDir] the host root, where a hook entry already resolved
 *   it (#3142)
 * @returns {string}
 */
function readRuleTextOr(id, lead, label, hostDir) {
	let root = hostDir;
	try {
		root ??= hostRoot();
		return readRuleText(id, root);
	} catch (err) {
		ignoreFailure(() =>
			require("./arbiter-core.js").logError(
				`${label} rule-text ${bareRuleId(id)}`,
				err,
				undefined,
				root,
			),
		);
		return fallbackLine(lead, bareRuleId(id));
	}
}

/** @param {string} lead @param {string} id @returns {string} */
const fallbackLine = (lead, id) =>
	`${lead}; the rule could not be read from ${docPath(`agents/rules/${id}.txt`)}. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.`;

module.exports = {
	withRuleStore,
	withHostRootSpelling,
	RULES_DIR,
	RuleMissing,
	CORE_RULES,
	rulesDir,
	fragmentPath,
	manifestPath,
	readRuleIds,
	readRuleParagraph,
	rulePointer,
	readRuleText,
	fragmentLookup,
	readRuleTextOr,
};
