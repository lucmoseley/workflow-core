const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { qualifyProse } = require("./qualify-citations.js");
const { readConfig } = require("./workflow-core-config.js");
const {
	docPath,
	expandPastePaths,
	isCoreRepo,
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

/** @param {NodeJS.ProcessEnv} env */
const overrideDir = (env) => (pinned ? pinned.dir : env.WFC_RULES_DIR);

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

/** @param {string} [root] @param {NodeJS.ProcessEnv} [env] @returns {string} */
function rulesDir(root, env = process.env) {
	const override = overrideDir(env);
	if (override) return path.resolve(override);
	const host = path.join(root ?? hostRoot(undefined, { env }), RULES_DIR);
	if (fs.statSync(host, { throwIfNoEntry: false })?.isDirectory()) return host;
	return CORE_RULES;
}

/** @param {NodeJS.ProcessEnv} env @returns {string | null} */
function coreLayer(env) {
	if (!overrideDir(env)) return CORE_RULES;
	const fallback = pinned ? pinned.fallback : env.WFC_RULES_FALLBACK_DIR;
	return fallback ? path.resolve(fallback) : null;
}

/** @param {string} [root] @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
function rulesDirs(root, env = process.env) {
	const primary = rulesDir(root, env);
	const second = coreLayer(env);
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

/** @param {string} [root] @param {NodeJS.ProcessEnv} [env] @returns {string[]} */
function readRuleIds(root, env = process.env) {
	/** @type {Set<string>} */
	const ids = new Set();
	for (const dir of rulesDirs(root, env))
		for (const e of readStoreEntries(dir))
			if (e.isFile() && e.name.endsWith(FRAGMENT_EXT)) {
				const id = e.name.slice(0, -FRAGMENT_EXT.length);
				if (RULE_ID_RE.test(id)) ids.add(id);
			}
	return [...ids].sort();
}

/** @param {string} bare @param {string} [root] @param {NodeJS.ProcessEnv} [env] @returns {string} */
function fragmentPath(bare, root, env = process.env) {
	const name = `${bare}${FRAGMENT_EXT}`;
	for (const dir of rulesDirs(root, env)) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return file;
	}
	return path.join(rulesDir(root, env), name);
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
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ file: string, body: string }}
 */
function readFragment(id, host, env) {
	const bare = typeof id === "string" ? bareRuleId(id) : "";
	if (!RULE_ID_RE.test(bare))
		throw new Error(
			`rule-text: "${id}" is not a rule id — ids are lowercase kebab-case ` +
				`(${RULE_ID_RE.source}).`,
		);
	const file = fragmentPath(bare, host, env);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		const known = readRuleIds(host, env);
		const brief = `rule-text: no fragment for rule id "${bare}" (looked in ${rulesDirs(host, env).join(", ")}).`;
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

/** @param {string} body @param {string} host @param {NodeJS.ProcessEnv} env @returns {string} */
function expandIncludes(body, host, env) {
	return body.replace(RULE_INCLUDE, (_, inc) => {
		const included = readFragment(inc, host, env).body;
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 * @throws {Error} as readFragment and expandIncludes do
 */
function readRuleText(id, root, env = process.env) {
	const host = root ?? hostRoot(undefined, { env });
	const { file, body } = readFragment(id, host, env);
	const resolved = expandPastePaths(
		resolveScriptPaths(expandIncludes(body, host, env), env),
		pinnedHostRoot ?? host,
		env,
	);
	return expandCommands(
		!isCoreRepo(env) && path.dirname(file) === coreLayer(env)
			? qualifyProse(resolved)
			: resolved,
		host,
		env,
	);
}

/** @param {string} text @param {string} root @param {NodeJS.ProcessEnv} env @returns {string} */
function expandCommands(text, root, env) {
	if (!text.includes("{command:")) return text;
	/** @type {Record<string, string|null>} */
	let commands = {};
	try {
		commands = readConfig({ root, env, quiet: true }).commands;
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

/** @param {string} root @param {NodeJS.ProcessEnv} [env] @returns {(id: string) => string} */
const fragmentLookup =
	(root, env = process.env) =>
	(id) => {
		try {
			return readRuleText(id, root, env);
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
