/*
 * rule-text.js — the Node half of the rule-text store (mantahostels#1644, spec mantahostels#1641).
 *
 * THE SEAM. Each guard-printed rule's operative text lives exactly once, as a plain
 * text file under docs/agents/rules/ keyed by a stable rule id. This module is
 * the only thing Node-side that resolves an id to that text; scripts/lib/
 * rule-text.sh is the bash twin, and the two answer identically by construction
 * (same directories in the same order, same id grammar, same trailing-newline
 * trim).
 *
 * PLAIN TEXT, NOT JSON — spec mantahostels#1641's decision. The guards are half bash and
 * half Node; a fragment must be `cat`-able from one and fs.readFileSync-able
 * from the other with no parser.
 *
 * IT REFUSES LOUDLY. An unknown id throws rather than returning "" — a guard
 * that silently denies with an empty reason is worse than one that crashes,
 * because the session is refused and told nothing. Callers that must not crash
 * call ruleTextOr, or catch it themselves and fail open in the house style
 * (mantahostels#103). The one
 * exception is expandCommands, on a host config it cannot read (workflow-core#742).
 *
 * THE DIRECTORY OVERRIDE. WFC_RULES_DIR redirects the store, and with it set
 * WFC_RULES_FALLBACK_DIR is the only layer beneath it — unset, no core
 * fragment resolves (rulesDirs). Both are for tests, and
 * for check-guard-registry.js's --root, which sets both for an adopter root
 * (mantahostels#1753). It is read at
 * call time, not at require time, so a test can set it per case.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { qualifyProse } = require("./qualify-citations.js");
const { defaultCommand, readConfig } = require("./workflow-core-config.js");
const {
	expandPastePaths,
	inCheckout,
	resolveScriptPaths,
	scriptPath,
} = require("./script-path.js");
const { caught } = require("./caught.js");

/** The store's home, relative to the repo root. */
const RULES_DIR = "docs/agents/rules";

/**
 * Kebab-case, lowercase, no dots and no slashes.
 *
 * The grammar is the whole path-traversal defence: an id is joined onto the
 * store directory, so `../../etc/passwd` must be refused as an id rather than
 * resolved as a path.
 */
const RULE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/*
 * The spelling ids are QUOTED in — scripts/inject-tracker-docs.sh's per-command
 * index, docs/agents/guard-registry.md §Gotchas, every guard's deny text. It is no part of the id,
 * and it is the only spelling a session is ever shown (mantahostels#2707).
 */
const RULE_ID_PREFIX = "rule:";

/* rule-text.sh's _RT_COMMAND_RE. */
const COMMAND_PLACEHOLDER = /\{command:([a-z_]+)\}/g;

/**
 * `id` with ONE leading `rule:` removed — so `rule:rule:x` bares to `rule:x`,
 * which the grammar then refuses.
 *
 * @param {string} id
 * @returns {string}
 */
function bareRuleId(id) {
	return id.startsWith(RULE_ID_PREFIX) ? id.slice(RULE_ID_PREFIX.length) : id;
}

/** Fragments carry this suffix; nothing else in the directory is a fragment. */
const FRAGMENT_EXT = ".txt";

/* The generator's record of what it rendered, beside the fragments so that
 * WFC_RULES_DIR redirects both together (mantahostels#2493). Spelled here and nowhere
 * else, so the generator writing it and the gate reading it cannot disagree. */
const MANIFEST_NAME = "manifest.json";

/** The CORE's own store: the plugin root's in an adopter, this repo's here. */
const CORE_RULES = path.join(__dirname, "..", "..", RULES_DIR);

/**
 * The store directory in force: the override, else the host repo's own, else
 * the CORE's, which is where an adopter's fragments live — so a guard firing
 * there prints its rule rather than handing over an id and no text (workflow-core#5).
 * @returns {string} absolute path
 */
function rulesDir() {
	const override = process.env.WFC_RULES_DIR;
	if (override) return path.resolve(override);
	const host = path.join(hostRoot(), RULES_DIR);
	/* A directory, as rt_dir's `-d` asks: a FILE there falls through (workflow-core#101). */
	if (fs.statSync(host, { throwIfNoEntry: false })?.isDirectory()) return host;
	return CORE_RULES;
}

/** @returns {string | null} absolute path of the CORE's layer, as rulesDirs() takes it */
function coreLayer() {
	if (!process.env.WFC_RULES_DIR) return CORE_RULES;
	const fallback = process.env.WFC_RULES_FALLBACK_DIR;
	return fallback ? path.resolve(fallback) : null;
}

/**
 * Every store an id is looked up in, first match winning: rulesDir(), then the
 * CORE's. LAYERED, not either/or (workflow-core#97): an adopter that generates one fragment
 * of its own still reads every core guard's fragment out of the plugin root —
 * choosing its store wholesale left every core `rule_text <id>` refusing there.
 *
 * Under the override the core layer is WFC_RULES_FALLBACK_DIR alone, never
 * implied: a test's throwaway store must not inherit the live one.
 * @returns {string[]} absolute paths
 */
function rulesDirs() {
	const primary = rulesDir();
	const second = coreLayer();
	return !second || second === primary ? [primary] : [primary, second];
}

/** @returns {string} absolute path of the manifest in the store in force */
function manifestPath() {
	return path.join(rulesDir(), MANIFEST_NAME);
}

/**
 * @param {string} dir
 * @returns {fs.Dirent[]}
 */
function storeEntries(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		/* ENOENT alone is an empty store. Anything else — EACCES, a store that is
		 * a file, a device error — is a directory this module could not READ, and
		 * answering [] for it makes every trigger look orphaned and blames the
		 * document. Callers let it escape: a checker reports BROKEN, and a guard
		 * fails open in the house style (mantahostels#103). */
		if (caught(e).code !== "ENOENT") throw e;
		return [];
	}
}

/**
 * Every rule id the stores hold, one layer over the next, sorted.
 *
 * A missing store directory is an empty store, not an error.
 *
 * @returns {string[]}
 */
function ruleIds() {
	/** @type {Set<string>} */
	const ids = new Set();
	for (const dir of rulesDirs())
		for (const e of storeEntries(dir))
			if (e.isFile() && e.name.endsWith(FRAGMENT_EXT)) {
				const id = e.name.slice(0, -FRAGMENT_EXT.length);
				if (RULE_ID_RE.test(id)) ids.add(id);
			}
	return [...ids].sort();
}

/**
 * The fragment file `id` resolves to — the first layer holding it — or the
 * primary layer's path where none does, which is what a refusal names.
 * @param {string} bare an id the grammar has accepted
 * @returns {string} absolute path
 */
function fragmentPath(bare) {
	const name = `${bare}${FRAGMENT_EXT}`;
	for (const dir of rulesDirs()) {
		const file = path.join(dir, name);
		if (fs.existsSync(file)) return file;
	}
	return path.join(rulesDir(), name);
}

/**
 * The operative text of rule `id`.
 *
 * Trailing newlines are trimmed so that a fragment splices into a guard's deny
 * reason without a blank line the author of the fragment never saw. Interior
 * whitespace is untouched — a fragment's paragraph breaks are its own.
 *
 * @param {string} id
 * @returns {string}
 * @throws {Error} on a malformed id, an id no fragment answers to, or a
 *   fragment holding nothing but whitespace
 */
function ruleText(id) {
	const bare = typeof id === "string" ? bareRuleId(id) : "";
	if (!RULE_ID_RE.test(bare))
		throw new Error(
			`rule-text: "${id}" is not a rule id — ids are lowercase kebab-case ` +
				`(${RULE_ID_RE.source}).`,
		);
	const file = fragmentPath(bare);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		const known = ruleIds();
		throw new Error(
			`rule-text: no fragment for rule id "${bare}" (looked in ${rulesDirs().join(", ")}). ` +
				(known.length > 0
					? `Known ids: ${known.join(", ")}.`
					: "The store holds no fragments."),
			{ cause: e },
		);
	}
	const body = text.replace(/\n+$/, "");
	/* An empty fragment is the failure this module exists to prevent, arriving by
	 * the one route the id check cannot see. */
	if (!body.trim())
		throw new Error(
			`rule-text: the fragment for rule id "${bare}" (${file}) is empty. ` +
				"A guard printing it would deny a session and state no rule.",
		);
	/* A fragment names core scripts as `scripts/x`; an install serves them
	 * through the plugin root (workflow-core#343). */
	const resolved = expandPastePaths(resolveScriptPaths(body), hostRoot());
	/* A core fragment's bare `#N` is the core's issue, which an install's host
	 * reads as its own (workflow-core#416). The host's own fragments cite its own tracker. */
	return expandCommands(
		!inCheckout() && path.dirname(file) === coreLayer()
			? qualifyProse(resolved)
			: resolved,
	);
}

/**
 * `{command:<name>}` becomes the host's declared `commands.<name>`, or its
 * `defaultCommand` (workflow-core#814), and a line naming one with neither is dropped
 * whole (workflow-core#742). Last, so a
 * host's own `scripts/x` is never rewritten to the plugin root.
 *
 * A config that cannot be read declares nothing, as wfc_command answers there,
 * and says so on stderr — a recipe missing a line costs less than a rule not
 * stated at all.
 * @param {string} text
 * @returns {string}
 */
function expandCommands(text) {
	if (!text.includes("{command:")) return text;
	/** @type {Record<string, string|null>} */
	let commands = {};
	try {
		commands = readConfig({ quiet: true }).commands;
	} catch (e) {
		process.stderr.write(
			`WARN rule-text: ${caught(e).message} — every {command:} line dropped\n`,
		);
	}
	const kept = [];
	for (const line of text.split("\n")) {
		let undeclared = false;
		const out = line.replace(COMMAND_PLACEHOLDER, (_, name) => {
			const cmd = commands[name] ?? defaultCommand(name);
			if (cmd) return cmd;
			undeclared = true;
			return "";
		});
		if (!undeclared) kept.push(out);
	}
	return kept.join("\n");
}

/**
 * The paragraph of a rule opening with `head`, for a Stop guard printing one
 * paragraph of a longer rule in its refusal. IT NEVER THROWS:
 * where the paragraph cannot be read it answers the command that reads the
 * rule, never a paraphrase, which would be a second copy to drift.
 * @param {string} id
 * @param {string} head the paragraph's opening words
 * @returns {string}
 */
function ruleParagraph(id, head) {
	try {
		const paragraph = ruleText(id)
			.split(/\n\s*\n/)
			.find((p) => p.startsWith(head));
		if (paragraph) return paragraph;
	} catch {
		/* Fall through to the pointer. */
	}
	return `The rule could not be read here: run \`${scriptPath("lib/rule-text.sh")} ${bareRuleId(id)}\` and follow the paragraph opening ${head}.`;
}

/**
 * The command that prints rule `id` in full, resolved for an install (workflow-core#343).
 * @param {string} id
 * @returns {string}
 */
function rulePointer(id) {
	return `The full rule: \`${scriptPath("lib/rule-text.sh")} ${bareRuleId(id)}\`.`;
}

/**
 * ruleText for a guard that must not crash: where the fragment cannot be read
 * it logs the failure under `label` and answers `short`, a line saying the
 * rule could not be read, and rulePointer.
 * @param {string} id
 * @param {string} short a one-paragraph stand-in for the rule
 * @param {string} label the guard, as the error log names it
 * @returns {string}
 */
function ruleTextOr(id, short, label) {
	try {
		return ruleText(id);
	} catch (err) {
		try {
			require("./arbiter-core.js").logError(
				`${label} rule-text ${bareRuleId(id)}`,
				err,
			);
		} catch {
			/* A log that cannot be written must not break the guard. */
		}
		return `${short} The rule itself could not be read here. ${rulePointer(id)}`;
	}
}

module.exports = {
	RULES_DIR,
	CORE_RULES,
	rulesDir,
	fragmentPath,
	manifestPath,
	ruleIds,
	ruleParagraph,
	rulePointer,
	ruleText,
	ruleTextOr,
};
