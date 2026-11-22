#!/usr/bin/env node
/*
 * check-context-budget.js — measures the context every session pays for before
 * it does any work, against the caps docs/doc-map.md §Capture and placement sets.
 *
 * Usage:
 *   node check-context-budget.js [--root <dir>] [--notify] [--against <rev>] [--json]
 *
 * FOUR CAPS now (POOL, INJECTION, the per-session-per-tool SESSION_CAP_BYTES
 * and the cross-tool RATCHET_CAP_BYTES, mantahostels#1787) — paid on different schedules.
 * Membership is
 * decided by the test settled at mantahostels#1235 and narrowed at mantahostels#1503 — bytes in EVERY
 * TOP-LEVEL session's context before any work, that THIS REPO CAN DELETE. A
 * subagent is not top-level; its dispatch is priced where it is made.
 *
 * POOL passes both limbs:
 *   - The host's declared `alwaysLoaded` files (lib/always-loaded-pool.js, #33),
 *     in bytes on disk. One of them may be the adopter's declared output
 *     style (`overrides.output_style`, lib/always-loaded-pool.js's
 *     `getDoubleLoadedFiles()`) — counted TWICE where another always-loaded
 *     file `@`-imports it, once as the active style and once as the import
 *     (mantahostels#1503, #45); once otherwise (#2034).
 *   - Own skill and command frontmatter `description` values, or the body line
 *     the harness lists for a file with none (#2054), EXCEPT where the
 *     description is not delivered at all. Two independent silencers: a skill
 *     carrying `disable-model-invocation: true` (mantahostels#1757), and a `skillOverrides`
 *     entry of `name-only`, `user-invocable-only` or `off` in
 *     `.claude/settings.json` (mantahostels#1786). A delivered description sits in the
 *     system prompt every turn whether or not the skill ever fires (mantahostels#608).
 *   - Agent definitions (.claude/agents/*.md) — their `name` and `description`
 *     ONLY, never the body. 0 B today, the directory being absent.
 *   - Whatever a pool file `@`-imports at the root and `alwaysLoaded` does not
 *     list, which the harness loads with it (lib/pool-imports.js, #1956).
 *
 * Vendored descriptions fail the second limb: symlinked from .agents/skills/, so
 * an undeclared EDIT is lost on the next vendor pull (declared ones survive via
 * .agents/vendored-skill-edits.json, mantahostels#1826). Reported, never capped.
 * ALWAYS-ENABLED PLUGINS are a third measured-and-uncapped surface (mantahostels#3116):
 * each `true` entry in `.claude/settings.json` `enabledPlugins` is priced from
 * .claude/plugin-context-cost.json in the TOKENS `claude plugin details`
 * reports — no bytes-per-token conversion — and an enabled plugin with no row
 * there is a WARN, never a silent zero. Not direction-gated: the bytes live in
 * ~/.claude/plugins/cache, outside git's sight, so the enabling commit names
 * the figure in its message instead.
 * A `skillOverrides` entry is not an edit — it lives in settings and survives the
 * pull — so it zeroes a vendored description as readily as an own one (mantahostels#1786).
 *
 * INJECTION fails the FIRST limb — scripts/inject-tracker-docs.js fires on seven
 * commands, ~41% of sessions, not all (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md,
 * mantahostels#1083). Capped separately rather than left ungoverned. Measured as a union of
 * the payload parts lib/tracker-inject-text.js holds (mantahostels#1284, mantahostels#1870).
 *
 * Severity turns on DIRECTION, not on level (mantahostels#1224). An over-cap total this commit
 * did not increase is a WARN: the caps are ratchets against drift rather than
 * measured limits, and gating on an undefended number teaches the reader to skip the
 * gate (mantahostels#155's severity model). A commit that ADDS bytes and leaves a surface at
 * or over its cap is REFUSED, whether the surface was over already or this
 * commit crossed it (#1014) — that reading turns on the sign of the delta and
 * never on the number. No second threshold: a pool one byte under cap prints its
 * headroom and raises nothing.
 *
 * --notify is the quiet path, passed only by a hand run: silent unless a cap
 * is breached.
 *
 * --against HEAD is the .husky/pre-commit path (mantahostels#1834).
 * This checker measures ONE revision and raises the level finding; the direction
 * is lib/check.js's, which materialises the index and HEAD by blob fetch, runs
 * this file over each and reports only what the commit adds. Nothing here reads
 * the working tree on either side, so a half-saved CLAUDE.md is not
 * charged to this commit.
 *
 * WHAT --against MEANS FOR A CORE FILE (#36). CAP_SOURCE is a core file
 * (lib/hook-limits.js) read off rule-emission.js's own CAP_FILE default, not off
 * `--root`, so a HOST revision comparison never varies it — the read no
 * longer depends on which tree `--root` names. The injector's text module is
 * different: THIS repo's `--against` runs are self-hosted (the core's history
 * is the host's), so lib/context-budget-pathspecs.js lists TRACKER_TEXT among the
 * paths materialised at the revision, preserving growth-detection on the
 * injector's own bytes; only where the root carries none (a plugin install,
 * whose host git never tracked the file) does readInjection() fall back to the
 * live core copy (TRACKER_TEXT_FILE), which is then constant across whatever is
 * compared.
 *
 * lib/fault-profiles.js's `context-budget` profile is what names the over-cap
 * tags gate material despite being WARN. Their `total` rides in the
 * finding so that profile's `worse` can tell growth from a shed that leaves the
 * surface still over — lib/fault-diff.js.
 *
 * The mantahostels#1177 admissibility prompt fires on the same seam: `admissibility` below
 * emits the pool's own byte total on every run, and --against prints the prompt
 * where the index's is higher than HEAD's. It never gates.
 *
 * IMPLICIT:  on `npm run status` (lifted off SessionStart into scripts/status-report.js), measures the always-loaded context every session pays for against its caps, printing the pool's own figures and raising a finding when a cap is breached.
 * JUSTIFIED: fail-safe — the pool grows a few bytes per tranche and nothing else measures it before a session has already paid.
 * DEFEAT:    none; --notify is silent while every cap holds.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { runCheck, errMessage } = require("./lib/check");
const { SELF_PLUGIN_COST } = require("./lib/core-context-cost.js");
const {
	SETTINGS_FILE,
	PLUGIN_COST_TABLE,
	TRACKER_TEXT,
	TRACKER_TEXT_FILE,
	SHED_REGISTERS,
	materialisePathspecs,
} = require("./lib/context-budget-pathspecs");
const { readOwnHooks } = require("./lib/core-hooks.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/** @typedef {{ okLine?: string, noun?: string, count?: number, data?: object }} CheckResult */

/** @typedef {{ path: string, bytes: number, note?: string }} FileEntry */

/** @typedef {{ path: string, vendored: boolean, words: number, bytes: number }} DescEntry */

// measured 20,334 B on 18 Oct 2026, past a 1,813 B band, #2034
const CAP_BYTES = 22_500;

// measured 9,637 B on 18 Oct 2026, past a 515 B band, #2039
const INJECTION_CAP_BYTES = 10_500;

/* #5447: measured 33,577 B for Bash at the install spelling, past a 423 B slack band. */
const SESSION_CAP_BYTES = 34_000;

/* #5447: measured 56,878 B across 70 ids at the install spelling, past a 122 B slack band. */
const RATCHET_CAP_BYTES = 57_000;

const {
	getPoolFiles,
	readDeclaredStyle,
	getDoubleLoadedFiles,
} = require("./lib/always-loaded-pool");

const {
	OVER_POOL,
	OVER_INJECTION,
	OVER_SESSION,
	OVER_RATCHET,
	OVER_FRAGMENT,
	DEAD_LATCH,
	CLOSED_TRIGGER,
	SESSION_SURFACE_PREFIX,
	FRAGMENT_SURFACE_PREFIX,
	LATCH_SURFACE_PREFIX,
} = require("./lib/context-budget-tags");

const RATCHET_SURFACE = "rule-ratchet";

const { reachableAfterCall, reachableByTool } = require("./lib/rule-emission");
const { asInstall, installStore } = require("./lib/install-probe.js");
const { AFTER_EVENTS } = require("./lib/hook-events.js");
const { fragmentLookup } = require("./lib/rule-text");
const { caught, orFallback } = require("./lib/caught.js");
const { readImportedFiles } = require("./lib/pool-imports.js");
const {
	INJECTOR_ENTRY,
	PROBE_SESSION_ID,
	renderedPayloads,
} = require("./lib/rendered-injection.js");
const { loadTextModule } = require("./lib/load-text-module.js");
const { reviewSuffix } = require("./lib/review-suffix.js");
const { standardsBase, standardsShown } = require("./lib/review-standards.js");
const { readConfig, resolveKey } = require("./lib/workflow-core-config.js");
const { ghJson } = require("./lib/gh.js");
const {
	LEDGER_PATH,
	keyOf,
	readPoolItems,
	readLedger,
	admit,
} = require("./lib/pool-admission.js");

const STYLE_NOT_POOLED = "STYLE-NOT-POOLED";

/**
 * @param {string} file
 * @param {number} bytes
 * @param {Set<string>} doubleLoaded
 * @returns {FileEntry[]}
 */
const poolRows = (file, bytes, doubleLoaded) =>
	doubleLoaded.has(file)
		? [
				{ path: file, bytes },
				{ path: file, bytes, note: "second copy, the active output style" },
			]
		: [{ path: file, bytes }];

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rel
 * @returns {number | null}
 */
function readPoolSize(ctx, root, rel) {
	try {
		return fs.statSync(path.join(root, rel)).size;
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		return ctx.broken(`cannot read ${rel}: ${errMessage(e)}`);
	}
}

/**
 * @param {string} text
 * @returns {{ lines: string[], end: number }}
 */
function splitFrontmatter(text) {
	const lines = text.split("\n");
	const [first] = lines;
	if (first === undefined)
		throw new Error("splitFrontmatter: splitting the text yielded no line");
	return {
		lines,
		end: first.trim() === "---" ? lines.indexOf("---", 1) : -1,
	};
}

/**
 * @param {string} text
 * @param {string} key
 * @returns {string | null}
 */
function frontmatterValue(text, key) {
	const { lines, end } = splitFrontmatter(text);
	if (end === -1) return null;

	const front = lines.slice(1, end);
	const at = front.findIndex((l) => new RegExp(`^${key}:`).test(l));
	const line = front[at];
	if (line === undefined) return null;

	let value = line.replace(new RegExp(`^${key}:\\s*`), "").trim();
	if (value === ">" || value === "|" || value === ">-" || value === "|-") {
		const body = [];
		for (const l of front.slice(at + 1)) {
			if (/^\S/.test(l)) break;
			body.push(l.trim());
		}
		value = body.join(" ");
	}
	return value.replace(/^["']|["']$/g, "").trim();
}

const descriptionOf = (/** @type {string} */ text) =>
	frontmatterValue(text, "description");

// measured on harness 2.1.302, #2054
const DERIVED_LINE_CHARS = 100;

/**
 * @param {string} text
 * @returns {string}
 */
function derivedLineOf(text) {
	const { lines, end } = splitFrontmatter(text);
	const first = lines
		.slice(end + 1)
		.map((l) => l.trim())
		.find((l) => l !== "");
	const line = (first ?? "").replace(/^#+\s+/, "");
	return line.length > DERIVED_LINE_CHARS
		? `${line.slice(0, DERIVED_LINE_CHARS - 3)}...`
		: line;
}

const SILENCING_OVERRIDES = /** @type {Set<string | undefined>} */ (
	new Set(["name-only", "user-invocable-only", "off"])
);

/**
 * @param {string} text
 * @param {string} [override]
 * @returns {string | null}
 */
const deliveredDescriptionOf = (text, override) =>
	frontmatterValue(text, "disable-model-invocation") === "true" ||
	SILENCING_OVERRIDES.has(override)
		? null
		: (descriptionOf(text) ?? derivedLineOf(text));

/**
 * @param {string} json
 * @returns {Record<string, string> | null}
 */
function parseSkillOverrides(json) {
	return settingsObject(json, "skillOverrides");
}

/**
 * @param {string} json
 * @param {string} key
 * @returns {Record<string, any> | null}
 */
function settingsObject(json, key) {
	try {
		const value = JSON.parse(json)?.[key];
		return value && typeof value === "object" ? value : {};
	} catch {
		return null;
	}
}

const UNPRICED_PLUGIN = "UNPRICED-PLUGIN";

/** @typedef {{ name: string, enabled: boolean, tokens: number | null, measured?: string, uncounted?: string }} PluginEntry */

/**
 * @param {string} json
 * @returns {Record<string, boolean> | null}
 */
function parseEnabledPlugins(json) {
	return settingsObject(json, "enabledPlugins");
}

/**
 * @param {string} root
 * @returns {Record<string, boolean>}
 */
function readEnabledPlugins(root) {
	return orFallback(
		() =>
			parseEnabledPlugins(
				fs.readFileSync(path.join(root, SETTINGS_FILE), "utf8"),
			) ?? {},
		{},
	);
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {Record<string, { tokens?: unknown, measured?: string, uncounted?: string }>}
 */
function readPluginCostTable(ctx, root) {
	/** @type {string | null} */
	let text = null;
	try {
		text = fs.readFileSync(path.join(root, PLUGIN_COST_TABLE), "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT")
			return ctx.broken(`cannot read ${PLUGIN_COST_TABLE}: ${errMessage(e)}`);
	}
	/** @type {Record<string, { tokens?: unknown, measured?: string, uncounted?: string }>} */
	let table = {};
	if (text !== null) {
		let parsed;
		try {
			parsed = JSON.parse(text)?.plugins;
		} catch (e) {
			return ctx.broken(
				`${PLUGIN_COST_TABLE} will not parse: ${errMessage(e)}`,
			);
		}
		if (!parsed || typeof parsed !== "object")
			return ctx.broken(`${PLUGIN_COST_TABLE} has no \`plugins\` object`);
		table = parsed;
	}
	return table;
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {PluginEntry[]}
 */
function pluginCosts(ctx, root) {
	const enabled = readEnabledPlugins(root);
	/** @type {ReturnType<typeof readPluginCostTable>} */
	const table = {
		[SELF_PLUGIN_COST.id]: SELF_PLUGIN_COST.row,
		...readPluginCostTable(ctx, root),
	};

	/** @type {PluginEntry[]} */
	const out = [];
	for (const [name, on] of Object.entries(enabled)) {
		const row = table[name];
		const tokens =
			typeof row?.tokens === "number" && Number.isFinite(row.tokens)
				? row.tokens
				: null;
		/** @type {PluginEntry} */
		const entry = { name, enabled: on === true, tokens };
		if (row?.measured) entry.measured = row.measured;
		if (row?.uncounted) entry.uncounted = row.uncounted;
		out.push(entry);
		if (entry.enabled && tokens === null)
			ctx.warn(
				UNPRICED_PLUGIN,
				`${name} is enabled in ${SETTINGS_FILE} but has no token figure in ${PLUGIN_COST_TABLE} — measure it (\`claude plugin details\`) and add the row (mantahostels#3132)`,
				{ surface: `plugin:${name}` },
			);
	}
	return out;
}

/**
 * @param {string} relPath
 * @returns {string}
 */
function overrideKeyFor(relPath) {
	const parts = relPath.split("/");
	return parts[1] === "commands"
		? path.basename(relPath, ".md")
		: /** @type {string} */ (parts[2]);
}
const wordsIn = (/** @type {string | null | undefined} */ s) =>
	s ? s.split(/\s+/).filter(Boolean).length : 0;
const bytesIn = (/** @type {string | null | undefined} */ s) =>
	s ? Buffer.byteLength(s) : 0;

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {DescEntry[]}
 */
function readDescriptions(ctx, root) {
	/** @type {DescEntry[]} */
	const out = [];
	const skillsDir = path.join(root, ".claude", "skills");
	const commandsDir = path.join(root, ".claude", "commands");
	/** @type {Record<string, string>} */
	let overrides = {};
	const parsed = orFallback(
		() =>
			parseSkillOverrides(
				fs.readFileSync(path.join(root, SETTINGS_FILE), "utf8"),
			),
		{},
	);
	if (parsed === null) {
		ctx.warn(
			"UNPARSEABLE-SETTINGS",
			`${SETTINGS_FILE} will not parse; every description charged`,
		);
		ctx.say(
			`NOTE: ${SETTINGS_FILE} will not parse; every description charged (mantahostels#1786).`,
		);
	} else overrides = parsed;

	for (const name of readDir(skillsDir)) {
		const at = path.join(skillsDir, name);
		let vendored;
		try {
			vendored = fs.lstatSync(at).isSymbolicLink();
		} catch {
			continue;
		}
		const file = path.join(at, "SKILL.md");
		if (!fs.existsSync(file)) continue;
		out.push(readDescribedFile(root, file, vendored, overrides));
	}

	for (const name of readDir(commandsDir)) {
		if (!name.endsWith(".md")) continue;
		out.push(
			readDescribedFile(root, path.join(commandsDir, name), false, overrides),
		);
	}

	return out;
}

/**
 * @param {string} root
 * @returns {FileEntry[]}
 */
function readAgentDefinitions(root) {
	const dir = path.join(root, ".claude", "agents");
	return readDir(dir)
		.filter((n) => n.endsWith(".md"))
		.map((n) => {
			const text = fs.readFileSync(path.join(dir, n), "utf8");
			return {
				path: path.relative(root, path.join(dir, n)),
				bytes:
					bytesIn(frontmatterValue(text, "name")) +
					bytesIn(descriptionOf(text)),
			};
		});
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{ files: FileEntry[], fromCore: boolean, text: TextModule }}
 */
function readInjection(ctx, root) {
	/** @type {string} */
	let source;
	let fromCore = false;
	try {
		source = fs.readFileSync(path.join(root, TRACKER_TEXT), "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") {
			try {
				source = fs.readFileSync(TRACKER_TEXT_FILE, "utf8");
				fromCore = true;
			} catch (e2) {
				return ctx.broken(
					`cannot read ${TRACKER_TEXT_FILE}: ${errMessage(e2)}`,
				);
			}
		} else return ctx.broken(`cannot read ${TRACKER_TEXT}: ${errMessage(e)}`);
	}
	/** @type {TextModule} */
	let text;
	try {
		text = /** @type {TextModule} */ (loadTextModule(source, TRACKER_TEXT));
	} catch (e) {
		return ctx.broken(`${TRACKER_TEXT} will not evaluate: ${errMessage(e)}`);
	}
	const files = [
		{
			path: TRACKER_TEXT,
			bytes: injectorBytes(ctx, text, fragmentLookup(root)),
			...(fromCore && { note: "the core's union, capped there" }),
		},
	];
	return { files, fromCore, text };
}

/** @typedef {typeof import("./lib/tracker-inject-text.js")} TextModule */

const UNION_EXPORTS = {
	COMMANDS: "array",
	TAKES_READ: "array",
	takesLine: "function",
	header: "function",
	WAYFINDER_CLAUSES: "string",
	INDEX: "object",
	trackerIndex: "function",
	CLOSING_STEPS: "object",
	PRICED_OPTIONS_POINTER: "string",
	codeReviewParts: "function",
};

const MEASURED_ISSUE = "1";
const MEASURED_REVIEW_TYPE = "workflow-core:code-reviewer";
const STANDARDS_STATES = /** @type {const} */ ([
	"base",
	"local",
	"neither",
	"both",
]);
const CORE_DIR = require("./lib/script-path.js").coreRoot();
const STANDARDS_SHOWN = standardsShown(standardsBase(CORE_DIR), CORE_DIR);
const GLOSSARY_SHOWN = "GLOSSARY.md";

/** @param {string[]} xs */
const longest = (xs) =>
	xs.reduce((a, b) => (bytesIn(b) > bytesIn(a) ? b : a), "");

/**
 * @param {TextModule} t
 * @param {(id: string) => string} fragment
 * @returns {string[]}
 */
function injectorParts(t, fragment) {
	/** @type {string[]} */
	const commands = t.COMMANDS;
	/** @type {string[]} */
	const takesRead = t.TAKES_READ;
	return [
		longest(
			takesRead.flatMap((m) =>
				commands
					.filter((o) => o !== m)
					.map((o) => t.takesLine(MEASURED_ISSUE, o, m)),
			),
		),
		longest(
			commands.map((c) => t.header(c, buildArbiterCommand`claim-issue <n>`)),
		),
		t.WAYFINDER_CLAUSES,
		longest(Object.keys(t.INDEX).map((c) => t.trackerIndex(c))),
		longest(Object.values(t.CLOSING_STEPS)),
		t.PRICED_OPTIONS_POINTER,
		...longestParts(
			STANDARDS_STATES.map((standardsState) =>
				t.codeReviewParts({
					standardsState,
					standardsBase: STANDARDS_SHOWN,
					glossary: GLOSSARY_SHOWN,
					reviewType: MEASURED_REVIEW_TYPE,
					sidSuffix: reviewSuffix(PROBE_SESSION_ID),
					fragment,
				}),
			),
		),
	];
}

/** @param {string[][]} lists */
const longestParts = (lists) =>
	lists.reduce((a, b) => (sum(b, bytesIn) > sum(a, bytesIn) ? b : a));

/**
 * @param {Ctx} ctx
 * @param {TextModule} t
 * @param {(id: string) => string} fragment
 * @returns {number}
 */
function injectorBytes(ctx, t, fragment) {
	const loose = /** @type {Record<string, unknown>} */ (t);
	const missing = Object.entries(UNION_EXPORTS)
		.filter(([name, kind]) =>
			kind === "array"
				? !Array.isArray(loose[name])
				: typeof loose[name] !== kind || loose[name] === null,
		)
		.map(
			([name, kind]) =>
				`${name} (${kind === "object" ? "an object" : `a ${kind}`})`,
		);
	if (missing.length > 0)
		return ctx.broken(`${TRACKER_TEXT} exports no ${missing.join(", ")}`);
	/** @type {string[]} */
	let parts;
	try {
		parts = injectorParts(t, fragment);
	} catch (e) {
		return ctx.broken(`${TRACKER_TEXT}'s exports threw: ${errMessage(e)}`);
	}
	const bad = parts.findIndex((p) => typeof p !== "string");
	if (bad !== -1)
		return ctx.broken(
			`${TRACKER_TEXT}'s union part ${bad + 1} is not a string`,
		);
	return sum(parts, bytesIn);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readDir(dir) {
	try {
		return fs.readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/**
 * @param {string} root
 * @param {string} file
 * @param {boolean} vendored
 * @param {Record<string, string>} overrides
 * @returns {DescEntry}
 */
function readDescribedFile(root, file, vendored, overrides) {
	const text = fs.readFileSync(file, "utf8");
	const rel = path.relative(root, file);
	const value = deliveredDescriptionOf(text, overrides[overrideKeyFor(rel)]);
	return {
		path: rel,
		vendored,
		words: wordsIn(value),
		bytes: bytesIn(value),
	};
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {object}
 */
function readHooks(ctx, root) {
	try {
		return { hooks: readOwnHooks(root) ?? {} };
	} catch (e) {
		return ctx.broken(
			"cannot read the hook wiring for the per-session rule emission, so it " +
				`is unknown: ${errMessage(e)}`,
		);
	}
}

/**
 * @param {object} settings
 * @param {string} root
 */
function reachOptions(settings, root) {
	const store = installStore(root);
	return {
		settings,
		root,
		capFile: process.env.WFC_CAP_FILE,
		rulesDir: store.dir,
		/* #109 */
		rulesFallbackDir:
			process.env.WFC_RULES_FALLBACK_DIR === undefined
				? store.fallback
				: process.env.WFC_RULES_FALLBACK_DIR,
	};
}

/**
 * @param {Ctx} ctx
 * @param {ReturnType<typeof reachOptions>} opts
 * @returns {{ cap: number, tools: Record<string, { bytes: number, ids: string[], guards: { file: string, bytes: number, calls: number, ids: string[] }[] }>, ratchet: { bytes: number, ids: string[] }, overCap: { id: string, bytes: number, guards: string[] }[], direct: { id: string, bytes: number | null, guards: string[], counted: boolean, latched: "none" | "bounded" | "ambiguous" }[], latchFaults: { id: string, guard: string, resolves: boolean, bound: boolean, marked: boolean }[], fragmentBytes: Record<string, number> }}
 */
function sessionFigures(ctx, opts) {
	const entries =
		/** @type {{ hooks?: { PreToolUse?: unknown } } | undefined} */ (
			opts.settings
		)?.hooks?.PreToolUse;
	if (entries === undefined || (Array.isArray(entries) && entries.length === 0))
		return {
			cap: 0,
			tools: {},
			ratchet: { bytes: 0, ids: [] },
			overCap: [],
			direct: [],
			latchFaults: [],
			fragmentBytes: {},
		};
	try {
		return asInstall(opts.root, () => reachableByTool(opts));
	} catch (e) {
		return ctx.broken(
			`cannot compute the per-session rule emission: ${errMessage(e)}`,
		);
	}
}

/**
 * @param {Ctx} ctx
 * @param {ReturnType<typeof reachOptions>} opts
 * @returns {ReturnType<typeof reachableAfterCall>}
 */
function afterCallFigures(ctx, opts) {
	try {
		return asInstall(opts.root, () => reachableAfterCall(opts));
	} catch (e) {
		return ctx.broken(
			`cannot compute the after-call rule emission: ${errMessage(e)}`,
		);
	}
}

/**
 * @param {FileEntry[]} poolFiles
 * @returns {{ surface: string, bytes: number, message: string }[]}
 */
function admissibility(poolFiles) {
	const bytes = poolFiles
		.filter((f) => getPoolFiles().includes(f.path))
		.reduce((n, f) => n + f.bytes, 0);
	return [
		{
			surface: "pool-files",
			bytes,
			message:
				`ADMISSIBILITY — the always-loaded pool's own prose is ${bytes} B, and\n` +
				"  where that is a rise, mantahostels#1177's question binds:\n" +
				"  What already covers this need, and why isn't a pointer enough?\n" +
				"  .claude/skills/pressure-test/SKILL.md step 1 has the two refusable\n" +
				"  shapes and where a refusal is recorded.",
		},
	];
}

/**
 * @template T
 * @param {T[]} xs
 * @param {(x: T) => number} f
 * @returns {number}
 */
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const rows = (/** @type {FileEntry[]} */ xs) =>
	xs
		.map((f) => `  ${f.bytes} B  ${f.path}${f.note ? ` — ${f.note}` : ""}`)
		.join("\n");
const guardRows = (
	/** @type {{ file: string, bytes: number, calls: number, ids: string[] }[]} */ gs,
) =>
	gs
		.map(
			(g) =>
				`    ${String(g.bytes).padStart(5)} B  ${g.file} (${g.ids.length} id${g.ids.length === 1 ? "" : "s"} over ${g.calls} injection${g.calls === 1 ? "" : "s"})`,
		)
		.join("\n");

const kb = (/** @type {number} */ b) => `${(b / 1000).toFixed(1)} KB`;

const atOrOver = (/** @type {number} */ headroom) =>
	headroom === 0 ? "exactly at" : `${-headroom} B over`;
const capHeading = (/** @type {number} */ headroom) =>
	headroom === 0 ? "AT CAP" : "OVER CAP";
const capClause = (/** @type {number} */ headroom) =>
	headroom === 0 ? "landing exactly on it" : `${-headroom} B over it`;
const buildLatchNote = (/** @type {string} */ latched) => {
	if (latched === "bounded")
		return "  [latched — paid once a session, not per firing]";
	if (latched === "ambiguous")
		return "  [bound present but uncorrelatable — priced per firing]";
	return "";
};

/**
 * @typedef {ReturnType<typeof sessionFigures>} Reach
 * @typedef {Reach["tools"][string]} ReachGroup
 * @typedef {Reach["direct"][number]} DirectEntry
 */

/**
 * @param {Ctx} ctx
 * @param {string | null} styled
 */
function warnUnpooledStyle(ctx, styled) {
	if (styled && !getPoolFiles().includes(styled))
		ctx.warn(
			STYLE_NOT_POOLED,
			`overrides.output_style names ${styled}, which alwaysLoaded does not list — ` +
				"the pool leaves out the copy every top-level session pays for it as " +
				`its active style. Add ${styled} to alwaysLoaded (#45).`,
			{ surface: "pool-files" },
		);
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 */
function readImports(ctx, root) {
	try {
		return readImportedFiles(root, getPoolFiles());
	} catch (e) {
		return ctx.broken(`cannot follow the pool's @-imports: ${errMessage(e)}`);
	}
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {{ own: DescEntry[], agents: FileEntry[], doubleLoaded: Set<string> }} parts
 * @returns {FileEntry[]}
 */
function readPoolEntries(ctx, root, { own, agents, doubleLoaded }) {
	return [
		...getPoolFiles().flatMap((rel) => {
			const bytes = readPoolSize(ctx, root, rel);
			return bytes === null ? [] : poolRows(rel, bytes, doubleLoaded);
		}),
		...readImports(ctx, root).flatMap(({ path: rel, importedBy }) => {
			const bytes = readPoolSize(ctx, root, rel);
			return bytes === null
				? []
				: [{ path: rel, bytes, note: `imported by ${importedBy}` }];
		}),
		{
			path: `own skill + command descriptions (${own.length})`,
			bytes: sum(own, (d) => d.bytes),
		},
		{
			path: `agent definitions, name + description (${agents.length})`,
			bytes: sum(agents, (a) => a.bytes),
		},
	];
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} [cite]
 * @returns {string}
 */
const buildShedCandidatesLine = (root, rel, cite = "") =>
	fs.existsSync(path.join(root, rel)) ? `  Candidates: ${rel}${cite}.\n` : "";

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {{ total: number, headroom: number, pool: FileEntry[] }} figures
 */
function reportPoolBreach(ctx, root, { total, headroom, pool }) {
	if (headroom > 0) return;
	ctx.warn(
		OVER_POOL,
		`always-loaded pool is ${total} B, ${atOrOver(headroom)} the doc map's ${CAP_BYTES} B cap`,
		{ surface: "pool", total, cap: CAP_BYTES, over: -headroom },
	);
	ctx.say(
		`ALWAYS-LOADED POOL ${capHeading(headroom)} — ${kb(total)} against the doc map's ${kb(CAP_BYTES)}, ${capClause(headroom)}.\n` +
			rows(pool) +
			"\n  Name the shed that pays for the bytes and take it in the same commit\n" +
			"  (.claude/workflow-core.doc-map.md §Capture and placement §4).\n" +
			buildShedCandidatesLine(root, SHED_REGISTERS.pool) +
			"  The only other way past this is to move the cap deliberately, by editing\n" +
			"  .claude/workflow-core.doc-map.md §Capture and placement §4 — the unpayable-correction trigger (mantahostels#1220).\n",
	);
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {{ injTotal: number, injHeadroom: number, injected: FileEntry[] }} figures
 */
function reportInjectionBreach(ctx, root, { injTotal, injHeadroom, injected }) {
	if (injHeadroom > 0) return;
	ctx.warn(
		OVER_INJECTION,
		`injected tracker docs are ${injTotal} B, ${atOrOver(injHeadroom)} the ${INJECTION_CAP_BYTES} B cap`,
		{
			surface: "injection",
			total: injTotal,
			cap: INJECTION_CAP_BYTES,
			over: -injHeadroom,
		},
	);
	ctx.say(
		`INJECTED TRACKER DOCS ${capHeading(injHeadroom)} — ${kb(injTotal)} against ${kb(INJECTION_CAP_BYTES)}, ${capClause(injHeadroom)}.\n` +
			rows(injected) +
			`\n  Pasted into ${TRACKER_TEXT}'s seven commands; the same shed rule applies\n` +
			"  (.claude/workflow-core.doc-map.md §Capture and placement §4).\n" +
			buildShedCandidatesLine(
				root,
				SHED_REGISTERS.injection,
				" (mantahostels#1259, mantahostels#1268)",
			) +
			"  The only other way past this is to move the cap deliberately, by editing\n" +
			"  .claude/workflow-core.doc-map.md §Capture and placement §4 — the unpayable-correction trigger (mantahostels#1220).\n",
	);
}

/**
 * @param {Ctx} ctx
 * @param {[string, ReachGroup][]} reachTools
 */
function reportSessionBreaches(ctx, reachTools) {
	for (const [tool, group] of reachTools) {
		const reachHeadroom = SESSION_CAP_BYTES - group.bytes;
		if (reachHeadroom > 0) continue;
		ctx.warn(
			OVER_SESSION,
			`one session can be made to pay ${group.bytes} B of rule text through PreToolUse ${tool}, ${atOrOver(reachHeadroom)} the ${SESSION_CAP_BYTES} B route (f) cap`,
			{
				surface: `${SESSION_SURFACE_PREFIX}${tool}`,
				tool,
				total: group.bytes,
				cap: SESSION_CAP_BYTES,
				over: -reachHeadroom,
			},
		);
		ctx.say(
			`PreToolUse ${tool.toUpperCase()} ${capHeading(reachHeadroom)} — ${kb(group.bytes)} against route (f)'s ${kb(SESSION_CAP_BYTES)}, ${capClause(reachHeadroom)}.\n` +
				guardRows(group.guards) +
				`\n  An injected id latches per (rule, agent, session), so this is the ${group.ids.length} distinct ids\n` +
				`  every guard wired on ${tool} can reach, each paid once however many events carry it.\n` +
				"  Shed fragment text, or move the cap deliberately in .claude/workflow-core.doc-map.md\n" +
				"  §Capture and placement §3 route (f), which mantahostels#1720 owns.\n",
		);
	}
}

/**
 * @param {Ctx} ctx
 * @param {{ reach: Reach, reachTools: [string, ReachGroup][], ratchetTotal: number, ratchetHeadroom: number }} figures
 */
function reportRatchetBreach(
	ctx,
	{ reach, reachTools, ratchetTotal, ratchetHeadroom },
) {
	const ratchetGuardBytes = new Map();
	for (const [, group] of reachTools)
		for (const g of group.guards) ratchetGuardBytes.set(g.file, g.bytes);
	const ratchetGuards = [...ratchetGuardBytes.entries()].sort(
		([, a], [, b]) => b - a,
	);
	if (ratchetHeadroom > 0) return;
	ctx.warn(
		OVER_RATCHET,
		`The reachable injection delivery unioned across every tool is ${ratchetTotal} B, ${atOrOver(ratchetHeadroom)} the ${RATCHET_CAP_BYTES} B shared ratchet`,
		{
			surface: RATCHET_SURFACE,
			total: ratchetTotal,
			cap: RATCHET_CAP_BYTES,
			over: -ratchetHeadroom,
		},
	);
	ctx.say(
		`RULE-EMISSION RATCHET ${capHeading(ratchetHeadroom)} — ${kb(ratchetTotal)} against the shared ratchet's ${kb(RATCHET_CAP_BYTES)}, ${capClause(ratchetHeadroom)}.\n` +
			ratchetGuards
				.map(([file, bytes]) => `  ${String(bytes).padStart(5)} B  ${file}`)
				.join("\n") +
			`\n  This is the union of all ${reach.ratchet.ids.length} reachable ids, each counted once however\n` +
			"  many guards or tools reach it; route (f)'s per-session cap above bounds one\n" +
			"  tool at a time. Move it deliberately in docs/doc-map.md §Capture and\n" +
			"  placement §3 route (f) — mantahostels#1720 owns that decision.\n",
	);
}

/**
 * @param {DirectEntry[]} direct
 */
function directFigures(direct) {
	const directTotal = direct.reduce((t, d) => t + (d.bytes ?? 0), 0);
	const directUncounted = direct.reduce(
		(t, d) => t + (d.counted ? 0 : (d.bytes ?? 0)),
		0,
	);
	return { directTotal, directUncounted };
}

/**
 * @param {Ctx} ctx
 * @param {Pick<Reach, "cap" | "overCap">} reach
 */
function reportOverCapFragments(ctx, reach) {
	for (const frag of reach.overCap) {
		ctx.warn(
			OVER_FRAGMENT,
			`rule fragment "${frag.id}" is ${frag.bytes} B, over the ${reach.cap} B RULE_CAP, reached by ${frag.guards.join(", ")}`,
			{
				surface: `${FRAGMENT_SURFACE_PREFIX}${frag.id}`,
				total: frag.bytes,
				cap: reach.cap,
				over: frag.bytes - reach.cap,
			},
		);
		ctx.say(
			`RULE FRAGMENT OVER CAP — "${frag.id}" is ${frag.bytes} B against RULE_CAP's ${reach.cap} B, ${frag.bytes - reach.cap} B over it.\n` +
				`  reached by: ${frag.guards.join(", ")}\n` +
				"  It can never be injected whole: offered first in an injection it\n" +
				"  denies the tool call outright; offered after other ids it defers\n" +
				"  instead, so the same denial lands once those have latched.\n" +
				"  Split the rule or shorten the fragment.\n",
		);
	}
}

/**
 * @param {Ctx} ctx
 * @param {Pick<Reach, "latchFaults">} reach
 */
function reportDeadLatches(ctx, reach) {
	for (const f of reach.latchFaults) {
		const why = [
			f.resolves ? "" : "no fragment answers to that id",
			f.bound
				? ""
				: "no direct accessor call on it is visible in that guard or the libs it sources",
			f.marked
				? ""
				: "no latchAfter decision on it is visible in that guard or the libs it sources",
		]
			.filter(Boolean)
			.join("; ");
		ctx.warn(
			DEAD_LATCH,
			`${f.guard} latches "${f.id}" but bounds nothing: ${why}`,
			{ surface: `${LATCH_SURFACE_PREFIX}${f.guard}:${f.id}` },
		);
		ctx.say(
			`DEAD RULE LATCH — ${f.guard} calls ctx.told("${f.id}"), and ${why}.\n` +
				"  The bound can never come true, so whatever text it was meant to bound\n" +
				"  is delivered whole on every one of that guard's firings.\n" +
				"  Usually a typo, and the pair to compare depends on what the latch\n" +
				"  bounds: a store fragment, where the latch id and the accessor call's\n" +
				"  id must be the same string; text the guard composes itself, where it\n" +
				"  is the ctx.told id and the latchAfter one (mantahostels#2446).\n",
		);
	}
}

/** @param {DescEntry[]} vendored */
function topVendored(vendored) {
	return vendored
		.slice()
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, 5)
		.map((d) => `  ${String(d.bytes).padStart(4)} B  ${d.path}`)
		.join("\n");
}

/** @param {PluginEntry} p */
function buildPluginLine(p) {
	return `  ${String(p.tokens === null ? "?" : `~${p.tokens}`).padStart(5)} tok  ${p.name}${p.enabled ? "" : "  [disabled — listed, not summed]"}${p.enabled && p.tokens === null ? "  [no row in the table — WARN]" : ""}${p.uncounted ? `  [uncounted: ${p.uncounted}]` : ""}`;
}

/** @param {[string, ReachGroup]} entry */
function buildReachLine([tool, g]) {
	return (
		`  ${String(g.bytes).padStart(5)} B  ${tool}  (${
			g.bytes >= SESSION_CAP_BYTES
				? `${atOrOver(SESSION_CAP_BYTES - g.bytes)} it`
				: `${SESSION_CAP_BYTES - g.bytes} B headroom`
		})` +
		(g.bytes >= SESSION_CAP_BYTES || g.guards.length === 0
			? ""
			: `\n${guardRows(g.guards)}`)
	);
}

/** @param {[string, ReachGroup][]} reachTools */
function buildReachLines(reachTools) {
	return reachTools.length > 0
		? reachTools.map(buildReachLine).join("\n")
		: "  no PreToolUse matcher names a tool.";
}

/** @param {DirectEntry} d */
function buildDirectLine(d) {
	return `  ${String(d.bytes ?? "?").padStart(5)} B  ${d.id}  ${d.guards.join(", ")}${d.counted ? "  [also pre-emitted — these bytes are in the figures above]" : ""}${buildLatchNote(d.latched)}`;
}

/** @param {DirectEntry[]} direct */
function buildDirectLines(direct) {
	return direct.length > 0 ? `${direct.map(buildDirectLine).join("\n")}\n` : "";
}

/** @param {import("./lib/rule-emission.js").AfterHook} h */
function buildAfterHookLines(h) {
	const head = `  ${String(h.once.bytes).padStart(5)} B  ${h.event} ${h.matcher || "(every tool)"}  ${h.file}`;
	const once =
		h.once.ids.length > 0 ? `  once a session: ${h.once.ids.join(", ")}` : "";
	const perFire = h.perFire.map(
		(f) =>
			`\n    ${String(f.bytes ?? "?").padStart(5)} B  ${f.id}  [every firing]`,
	);
	return head + once + perFire.join("");
}

/** @param {ReturnType<typeof reachableAfterCall>} after */
function afterCallSection(after) {
	const events = AFTER_EVENTS.join(", ");
	const perFire = [
		...new Map(
			after.hooks.flatMap((h) => h.perFire).map((f) => [f.id, f]),
		).values(),
	];
	return (
		`RULE TEXT AFTER A CALL — ${after.once.bytes} B once a session across ${after.once.ids.length}, and ${sum(perFire, (f) => f.bytes ?? 0)} B paid on every firing across ${perFire.length}. Uncapped.\n` +
		(after.hooks.length > 0
			? `${after.hooks.map(buildAfterHookLines).join("\n")}\n`
			: `  no ${events} hook reaches a fragment.\n`) +
		"  A hook lists every id its guard reaches, whichever event branch takes\n" +
		"  it. On neither of route (f)'s caps, which price PreToolUse alone, and\n" +
		"  no cap of its own is seated (.claude/workflow-core.doc-map.md §Capture and placement §3).\n"
	);
}

/** @typedef {{ script: string, commands: import("./lib/rendered-injection.js").RenderedPayload[] } | { error: string }} RenderedPayloads */

/**
 * @param {TextModule} text
 * @param {string} root
 * @returns {RenderedPayloads}
 */
function renderedFor(text, root) {
	return {
		script: INJECTOR_ENTRY,
		commands: renderedPayloads(text.COMMANDS, root),
	};
}

/** @param {RenderedPayloads | null} rendered */
function buildRenderedLines(rendered) {
	if (rendered === null) return "";
	if ("error" in rendered)
		return `\n  This host's own payloads could not be rendered: ${rendered.error}.`;
	const sizes = rendered.commands.flatMap((r) =>
		r.chars === null ? [] : [r.chars],
	);
	const largest =
		sizes.length > 0 ? `largest ${Math.max(...sizes)} chars` : "none rendered";
	return (
		`\n  As this host receives it from ${rendered.script}, per command — ${largest}, uncapped:\n` +
		rendered.commands
			.map(
				(r) =>
					`    ${r.chars === null ? `? (${r.error})` : `${r.chars} chars`}  /${r.command}`,
			)
			.join("\n")
	);
}

/**
 * @param {Ctx} ctx
 * @param {{ total: number, headroom: number, pool: FileEntry[], injTotal: number, injHeadroom: number, injected: FileEntry[], rendered: RenderedPayloads | null, own: DescEntry[], vendored: DescEntry[], plugins: PluginEntry[], enabledPlugins: PluginEntry[], pluginTokens: number, reachTools: [string, ReachGroup][], reach: Reach, ratchetTotal: number, ratchetHeadroom: number, directTotal: number, directUncounted: number }} t
 */
function printTable(ctx, t) {
	const { total, headroom, pool, injTotal, injHeadroom, injected, rendered } =
		t;
	const { own, vendored, plugins, enabledPlugins, pluginTokens } = t;
	const { reachTools, reach, ratchetTotal, ratchetHeadroom } = t;
	const { directTotal, directUncounted } = t;
	ctx.say(
		`ALWAYS-LOADED POOL — ${kb(total)} of ${kb(CAP_BYTES)}, ${headroom} B headroom (.claude/workflow-core.doc-map.md §Capture and placement).\n` +
			rows(pool) +
			`\n\nINJECTED TRACKER DOCS — ${kb(injTotal)} of ${kb(INJECTION_CAP_BYTES)}, ${injHeadroom} B headroom (~41% of sessions).\n` +
			rows(injected) +
			buildRenderedLines(rendered) +
			`\n\nVENDORED SKILL DESCRIPTIONS — ${sum(vendored, (d) => d.bytes)} B across ${vendored.length}, of which ${vendored.filter((d) => d.bytes === 0).length} cost nothing (disable-model-invocation, or a skillOverrides entry — mantahostels#1757, mantahostels#1786). Uncapped in bytes.\n` +
			"  Adopting a new vendored skill names its description bytes (mantahostels#1235).\n" +
			`  Own descriptions, inside the pool above: ${sum(own, (d) => d.words)} words; vendored: ${sum(vendored, (d) => d.words)} words (mantahostels#608).\n` +
			topVendored(vendored) +
			`\n\nALWAYS-ENABLED PLUGINS — ~${pluginTokens} tok across ${enabledPlugins.length}, uncounted: ${
				enabledPlugins
					.filter((p) => p.uncounted)
					.map((p) => p.name)
					.join(", ") || "none"
			}. Uncapped.\n` +
			`  \`claude plugin details\`' Always-on figure, in tokens, from ${PLUGIN_COST_TABLE}; an enabling commit names it (mantahostels#3116).\n` +
			plugins.map(buildPluginLine).join("\n") +
			`\n\nREACHABLE RULE TEXT PER SESSION, PER PreToolUse TOOL — against route (f)'s ${kb(SESSION_CAP_BYTES)}${reach.cap ? `, one delivery capped at ${reach.cap} B (RULE_CAP)` : ""}.\n` +
			buildReachLines(reachTools) +
			`\n\nRULE-EMISSION RATCHET — ${kb(ratchetTotal)} of ${kb(RATCHET_CAP_BYTES)}, ${ratchetHeadroom} B headroom (route (f)'s second axis, unioned across every tool).\n` +
			`\nDIRECT RULE TEXT — ${directTotal} B across ${reach.direct.length}, of which ${directUncounted} B is on no figure above. Uncapped.\n` +
			buildDirectLines(reach.direct) +
			"  Spliced into the guard's own deny or warn text, so it is route (e)\n" +
			"  (.claude/workflow-core.doc-map.md §Capture and placement §3), which owes no shed. That\n" +
			"  is why none of it is on route (f)'s caps: a cap bounds the standing\n" +
			"  cost every session pays, and this is paid only by one that erred.\n" +
			"  It is outside the injection latch, so unlike the figures above every line\n" +
			"  here is paid AGAIN each time its guard fires, the pre-emitted ones too\n" +
			"  — except where a line is marked `latched`, whose guard bounds its own\n" +
			"  repeat to once a session (mantahostels#2275). The bytes stay route (e) and stay\n" +
			"  uncapped either way.\n" +
			"  `uncorrelatable` is a guard whose bound cannot be tied to the bytes it\n" +
			"  covers: more than one direct call on that id (mantahostels#2283), more than one\n" +
			"  latchAfter decision marking it, or none at all (mantahostels#2354).\n" +
			"  A `?` is an id the store could not answer for, missing or unreadable\n" +
			"  alike: the guard falls back to its own hardcoded sentence.\n",
	);
}

// guess, #2033
const GH_TIMEOUT_MS = 15_000;

/**
 * @param {number[]} tickets
 * @returns {Map<number, string> | { error: string }}
 */
function readTicketStates(tickets) {
	const [owner, name] = String(resolveKey("tracker") ?? "").split("/");
	const fields = tickets
		.map((n) => `i${n}: issue(number: ${n}) { state }`)
		.join(" ");
	try {
		const repo = ghJson(
			[
				"api",
				"graphql",
				"-f",
				`query=query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${fields} } }`,
				"-f",
				`o=${owner}`,
				"-f",
				`n=${name}`,
			],
			{ timeout: GH_TIMEOUT_MS },
		)?.data?.repository;
		return new Map(tickets.map((n) => [n, repo?.[`i${n}`]?.state]));
	} catch (e) {
		const [first = ""] = errMessage(e).split("\n");
		return { error: first };
	}
}

/**
 * @param {import("./lib/pool-admission.js").LedgerEntry} e
 * @returns {e is import("./lib/pool-admission.js").LedgerEntry & { ticket: number }}
 */
const isTicketedTrigger = (e) =>
	e.route === "trigger" && e.ticket !== undefined;

/**
 * @param {Ctx} ctx
 * @param {string} root
 */
function poolRuleAdmission(ctx, root) {
	let items;
	try {
		items = readPoolItems(root, getPoolFiles());
	} catch (e) {
		return ctx.broken(`cannot read the pool's rules: ${errMessage(e)}`);
	}
	const byFile = Object.fromEntries(
		getPoolFiles().map((f) => [f, items.filter((i) => i.file === f).length]),
	);
	const rules = { count: items.length, byFile };
	if (readConfig().admissionGate !== true)
		return { gate: false, rules, unadmitted: [], closed: [], unread: null };

	let entries;
	try {
		entries = readLedger(root);
	} catch (e) {
		return ctx.broken(`cannot read the admission ledger: ${errMessage(e)}`);
	}
	const { unadmitted, admitted } = admit(items, entries);
	const triggers = admitted.filter(isTicketedTrigger);
	const tickets = [...new Set(triggers.map((e) => e.ticket))];
	const states =
		tickets.length === 0 || ctx.isBaselineSide()
			? new Map()
			: readTicketStates(tickets);
	const closed =
		states instanceof Map
			? triggers.filter((e) => states.get(e.ticket) === "CLOSED")
			: [];
	for (const e of closed)
		ctx.warn(
			CLOSED_TRIGGER,
			`#${e.ticket} has closed, but the rule it was to print is still in ${e.file}: "${e.headline}". ` +
				"Read that guard's output and cut from the bullet what it carries. Where nothing of the bullet " +
				"stays, move its tag and citations to docs/agents/guard-registry.md and drop its " +
				`${LEDGER_PATH} entry; where a limb stays, keep the entry and set its route to no-trigger.`,
			{ surface: `ledger:${e.file}:${e.headline}` },
		);
	return {
		gate: true,
		rules,
		unadmitted: unadmitted.map((i) => ({
			file: i.file,
			headline: i.headline,
			key: keyOf(i),
			message:
				`${i.file}:${i.line} adds the pool rule "${i.headline}", which ${LEDGER_PATH} does not admit. ` +
				"Add its entry in this commit — file, headline exactly as quoted, claim (the wrong act a session " +
				"takes without the rule), route (no-trigger; trigger, with the /implement ticket whose guard will " +
				"print it; or pre-first-tool-call). A reworded headline moves its old entry. A rule a guard prints " +
				"goes to docs/agents/guard-registry.md, not the pool.",
		})),
		closed,
		unread: states instanceof Map ? null : states.error,
	};
}

/**
 * @param {ReturnType<typeof poolRuleAdmission>} a
 * @returns {string}
 */
function admissionSection(a) {
	const files = Object.entries(a.rules.byFile)
		.map(([f, n]) => `${n} ${f}`)
		.join(", ");
	const head = `POOL RULES — ${a.rules.count} top-level list items and bold-led paragraphs, rule or not (${files}).`;
	if (!a.gate)
		return `${head}
  The admission gate is off: \`admissionGate\` in .claude/workflow-core.json.`;
	return [
		head,
		`  Admission gate on: ${a.unadmitted.length} without a ${LEDGER_PATH} entry, refused only where a commit adds one.`,
		...a.closed.map(
			(e) =>
				`  #${e.ticket} closed, its rule still in ${e.file}: "${e.headline}"`,
		),
		...(a.unread === null
			? []
			: [
					`  Ticket states unread (${a.unread}), so no closed trigger ticket is reported.`,
				]),
	].join("\n");
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "context-budget",
	usage:
		"node check-context-budget.js [--root <dir>] [--notify] [--against <rev>] [--json]",
	valueFlags: ["--root"],
	against: {
		profile: "context-budget",
		materialise: "blobs",
		pathspecs: materialisePathspecs,
		baseline: "always",
		baselineCode: "rev",
	},
	/** @returns {CheckResult} */
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());

		const descs = readDescriptions(ctx, root);
		const own = descs.filter((d) => !d.vendored);
		const vendored = descs.filter((d) => d.vendored);
		const agents = readAgentDefinitions(root);
		const plugins = pluginCosts(ctx, root);
		const enabledPlugins = plugins.filter((p) => p.enabled);
		const pluginTokens = sum(enabledPlugins, (p) => p.tokens ?? 0);

		warnUnpooledStyle(ctx, readDeclaredStyle());
		const doubleLoaded = getDoubleLoadedFiles(root);

		const pool = readPoolEntries(ctx, root, { own, agents, doubleLoaded });
		const total = sum(pool, (f) => f.bytes);
		const headroom = CAP_BYTES - total;

		const { files: injected, fromCore, text } = readInjection(ctx, root);
		const rendered =
			fromCore && !ctx.isBaselineSide() ? renderedFor(text, root) : null;
		const injTotal = sum(injected, (f) => f.bytes);
		const injHeadroom = INJECTION_CAP_BYTES - injTotal;

		const opts = reachOptions(readHooks(ctx, root), root);
		const reach = sessionFigures(ctx, opts);
		const after = afterCallFigures(ctx, opts);
		const reachTools = Object.entries(reach.tools).sort(
			([a, x], [b, y]) => y.bytes - x.bytes || a.localeCompare(b),
		);

		reportPoolBreach(ctx, root, { total, headroom, pool });

		reportInjectionBreach(ctx, root, { injTotal, injHeadroom, injected });

		reportSessionBreaches(ctx, reachTools);

		const ratchetTotal = reach.ratchet.bytes;
		const { directTotal, directUncounted } = directFigures(reach.direct);
		const ratchetHeadroom = RATCHET_CAP_BYTES - ratchetTotal;
		reportRatchetBreach(ctx, {
			reach,
			reachTools,
			ratchetTotal,
			ratchetHeadroom,
		});

		reportOverCapFragments(ctx, reach);
		reportOverCapFragments(ctx, after);

		reportDeadLatches(ctx, reach);
		reportDeadLatches(ctx, after);

		const admitted = poolRuleAdmission(ctx, root);

		if (!ctx.notify)
			printTable(ctx, {
				total,
				headroom,
				pool,
				injTotal,
				injHeadroom,
				injected,
				rendered,
				own,
				vendored,
				plugins,
				enabledPlugins,
				pluginTokens,
				reachTools,
				reach,
				ratchetTotal,
				ratchetHeadroom,
				directTotal,
				directUncounted,
			});
		if (!ctx.notify) ctx.say(afterCallSection(after));
		if (!ctx.notify) ctx.say(admissionSection(admitted));

		return {
			okLine: `always-loaded pool ${kb(total)} of ${kb(CAP_BYTES)}, ${headroom} B headroom, ${admitted.rules.count} list items and bold-led paragraphs; injection ${kb(injTotal)} of ${kb(INJECTION_CAP_BYTES)}.`,
			noun: "budget breach",
			data: {
				admissibility: admissibility(pool),
				rules: admitted.rules,
				unadmitted: admitted.unadmitted,
				cap: CAP_BYTES,
				total,
				headroom,
				pool,
				injection: {
					cap: INJECTION_CAP_BYTES,
					total: injTotal,
					headroom: injHeadroom,
					files: injected,
					rendered,
				},
				session: {
					cap: SESSION_CAP_BYTES,
					gpRuleCap: reach.cap,
					tools: reach.tools,
					overCap: reach.overCap,
					fragmentBytes: reach.fragmentBytes,
					ratchet: { cap: RATCHET_CAP_BYTES, total: ratchetTotal },
					direct: {
						total: directTotal,
						uncounted: directUncounted,
						fragments: reach.direct,
					},
				},
				afterCall: after,
				agents,
				plugins: {
					tokens: pluginTokens,
					enabled: enabledPlugins.length,
					unpriced: enabledPlugins
						.filter((p) => p.tokens === null)
						.map((p) => p.name),
					uncounted: enabledPlugins
						.filter((p) => p.uncounted)
						.map((p) => p.name),
					entries: plugins,
				},
				descriptions: {
					ownWords: sum(own, (d) => d.words),
					vendoredWords: sum(vendored, (d) => d.words),
					ownBytes: sum(own, (d) => d.bytes),
					vendoredBytes: sum(vendored, (d) => d.bytes),
					entries: descs,
				},
			},
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
