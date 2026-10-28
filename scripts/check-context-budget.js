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
 * INJECTION fails the FIRST limb — scripts/inject-tracker-docs.sh fires on seven
 * commands, ~41% of sessions, not all (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md,
 * mantahostels#1083). Capped separately rather than left ungoverned. Measured as the payload the
 * script actually emits — its own header prose, plus its DOCS array and the markers
 * around each document should one ever return there (mantahostels#1284, mantahostels#1870).
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
 * the working tree on either side, so a neighbour's half-saved CLAUDE.md is not
 * charged to this commit.
 *
 * WHAT --against MEANS FOR A CORE FILE (#36). CAP_SOURCE is a core file
 * (lib/hook-limits.sh) read off rule-emission.js's own CAP_FILE default, not off
 * `--root`, so a HOST revision comparison never varies it — the read no
 * longer depends on which tree `--root` names. The injector is different:
 * THIS repo's `--against` runs are self-hosted (the core's history is the
 * host's), so lib/context-budget-pathspecs.js's materialisePathspecs() still
 * tries `git show <rev>:...` first and reads the REVISION's own copy, preserving growth-detection on the
 * injector's own bytes; only where that fails (a plugin install, whose host
 * git never tracked the file) does it fall back to the live core copy
 * (INJECTOR_FILE), which is then constant across whatever is compared. See
 * its header for the injector limb in full.
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
const { runCheck, errMessage, isBaselineSide } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group");
const { SELF_PLUGIN_COST } = require("./lib/core-context-cost.js");
const {
	SETTINGS_FILE,
	PLUGIN_COST_TABLE,
	INJECTOR,
	INJECTOR_FILE,
	bashArray,
	docsArray,
	SHED_REGISTERS,
	materialisePathspecs,
} = require("./lib/context-budget-pathspecs");
const { readOwnHooks } = require("./lib/core-hooks.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/**
 * runCheck's result contract (`check.js:155-170`).
 *
 * @typedef {{ okLine?: string, noun?: string, count?: number, data?: object }} CheckResult
 */

/** @typedef {{ path: string, bytes: number, note?: string }} FileEntry */

/**
 * One skill/command SKILL.md or command .md, and whether it is vendored.
 *
 * @typedef {{ path: string, vendored: boolean, words: number, bytes: number }} DescEntry
 */

/*
 * docs/doc-map.md §Capture and placement §4 owns this number, its derivation
 * and the argument for the slack band above the measured pool.
 */
const CAP_BYTES = 22_500;

/*
 * docs/doc-map.md §Capture and placement §4 owns this number and its derivation.
 *
 * NOT the limit that binds — injectorBytes()'s header below has why.
 */
const INJECTION_CAP_BYTES = 10_500;

/*
 * docs/doc-map.md §Capture and placement §3 route (f): the bytes of rule text
 * ONE SESSION can be made to pay through a single PreToolUse tool — the sum of
 * the distinct ids that tool's wired guards can reach.
 *
 * THE SESSION, NOT THE EVENT (mantahostels#2046). An `injectRules` id latches per
 * (rule, agent, session), so it is delivered once in a session's life.
 *
 * A CONTEXT-COST CEILING, NOT A TRUNCATION GUARANTEE. RULE_CAP — 4,000 B,
 * enforced by lib/guard-entry.js — holds every delivery under the cut. What
 * this bounds is what the rules layer costs a session that trips every
 * trigger.
 *
 * RATCHETED THE WAY §4 RATCHETS THE POOL'S: the largest live group, rounded up
 * past a slack band under one fragment's worth at the median, so an added rule
 * spends it and has to move the cap rather than pass unseen. That measurement
 * pair DERIVES the cap and is not the live headroom (mantahostels#2272) — read
 * it off `npm run check:context`, which prints the per-tool figures.
 *
 * Last re-seeded at #2023: Bash at 31,079 B across 39 ids, rounded up past a
 * 421 B slack band.
 */
const SESSION_CAP_BYTES = 31_500;

/*
 * docs/doc-map.md §Capture and placement §3 route (f)'s second, independent
 * axis (mantahostels#1720). SESSION_CAP_BYTES above bounds ONE PreToolUse tool; this one is
 * a shared ratchet over the UNION OF EVERY REACHABLE ID across every tool at
 * once — one fragment counted once however many guards or tools reach it, the
 * latch paying it once — moved only by deliberate edit exactly as CAP_BYTES is
 * (mantahostels#1720).
 *
 * SEEDED ON THE SESSION UNIT (mantahostels#2223, taking option (A)): the
 * measured union rounded up past a slack band under one fragment's worth at
 * the median, so an added rule spends it and has to move the cap rather than
 * pass unseen. That is mantahostels#2046's method for SESSION_CAP_BYTES
 * above, applied to the same measurement. The measured union DERIVES the cap
 * and is not the live headroom (mantahostels#2272) — read it off
 * `npm run check:context`, which prints the union in the same run as the
 * per-tool figures.
 *
 * Last re-seeded at #2060: 51,147 B across 69 ids, rounded up past a 353 B
 * slack band.
 *
 * WHY NOT SEED IT BELOW THE MEASUREMENT. The direction gate refuses any commit that RAISES an
 * over-cap total, so a seed permanently below the measurement is not a passive
 * drift report: it makes every addition to the rule layer net-zero-or-below.
 * That is the downward-only ratchet mantahostels#1220 rejected and
 * docs/doc-map.md §Capture and placement §4 legislates against
 * (mantahostels#2223). WHY NOT RETIRE IT. The
 * per-tool cap would permit SESSION_CAP_BYTES on each wired tool with no
 * complaint; the union is what a session actually pays, and nothing else
 * bounds it.
 */
const RATCHET_CAP_BYTES = 51_500;

/*
 * docs/doc-map.md §Capture and placement §4's whole-file members, in the
 * order it names them. Shared with check-doc-map.js's assertion 16, which
 * gates the ledger entry the same bytes owe (mantahostels#1788) — two copies could
 * disagree about membership and refuse different commits.
 */
const {
	getPoolFiles,
	readDeclaredStyle,
	getDoubleLoadedFiles,
} = require("./lib/always-loaded-pool");

/* Shared with lib/fault-profiles.js's `context-budget` profile, whose `gating`
 * predicate names these four tags (mantahostels#1938). */
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

/** The fixed surface name the shared ratchet's finding carries. */
const RATCHET_SURFACE = "rule-ratchet";

/* The session cap's arithmetic, which is a module of its own so that this file
 * holds only the cap, the severity and the reporting (mantahostels#2003, mantahostels#2004). */
const {
	AFTER_EVENTS,
	reachableAfterCall,
	reachableByTool,
} = require("./lib/rule-emission");
const { RULES_DIR, CORE_RULES } = require("./lib/rule-text");
const { caught } = require("./lib/caught.js");
const { readImportedFiles } = require("./lib/pool-imports.js");
const { renderedPayloads } = require("./lib/rendered-injection.js");
const { readConfig, resolveKey } = require("./lib/workflow-core-config.js");
const { ghJson } = require("./lib/gh.js");
const {
	LEDGER_PATH,
	readPoolItems,
	readLedger,
	admit,
} = require("./lib/pool-admission.js");

/** What a declared style names that `alwaysLoaded` does not list — under-counts the pool by the missing second copy. */
const STYLE_NOT_POOLED = "STYLE-NOT-POOLED";

/**
 * A pool member's rows — two for a double-loaded file. `path` stays a real repo
 * path on both, so anything keying off it (`admissibility`) sees both
 * copies; the wording that tells the two apart rides in `note`, which only the
 * renderer reads.
 *
 * `doubleLoaded` is the adopter's declared style where another always-loaded
 * file imports it (`getDoubleLoadedFiles()`) — a top-level session pays it
 * twice, once as the active output style and once as the import, a
 * background job being top-level rather than a subagent (mantahostels#1503, #45).
 *
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
 * Bytes on disk, or BROKEN — a tracked file that will not read is apparatus.
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @param {string} rel
 * @returns {number}
 */
function readSize(ctx, root, rel) {
	try {
		return fs.statSync(path.join(root, rel)).size;
	} catch (e) {
		return ctx.broken(`cannot read ${rel}: ${errMessage(e)}`);
	}
}

/**
 * Bytes of a POOL member, or `null` where this revision does not carry the file
 * at all.
 *
 * ABSENT is not the same as UNREADABLE, and only the second is BROKEN. The pool
 * list is the core's, and a fork of it need not carry every member — an
 * `AGENTS.md` that was never written costs the session no context, so measuring
 * it as a missing instrument refuses every commit in the repo over a file whose
 * absence is the truth. That is check.js's own precedent, "the gitignored data/
 * corpus is absent => SKIP" (scripts/lib/check.js:19).
 *
 * ENOENT is the whole discriminator, and it is a narrow one: the root here is a
 * materialised tree, so a member missing from it is missing from the revision.
 * Any OTHER errno — a permission failure, a directory where a file belongs —
 * is the instrument failing over scope it was meant to cover, and stays BROKEN.
 *
 * The cap can only be UNDER-counted by this, never over, so no breach hides
 * behind it.
 *
 * ONE RESIDUAL, NAMED RATHER THAN CLOSED (#11): `git rm --cached AGENTS.md`
 * leaves the file on disk, where a session goes on loading it, while this reads
 * its bytes as shed. Nothing here can see that — `--against` materialises
 * trees, and a materialised tree is all either side of the comparison gets.
 *
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
 * The text's lines and the index of the one closing its frontmatter, or -1
 * where there is none. Throws on no lines, which `split` never yields.
 *
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
 * A frontmatter value, with YAML block scalars (`description: >`) folded back into
 * one string.
 *
 * Deliberately not a YAML parser: the frontmatter here is hand-written, the failure
 * mode of a miss is one value counted as empty, and a dependency for that is not
 * worth the install.
 *
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
	/* A block scalar's marker carries no words of its own; the value is the
	 * indented run beneath it, which ends at the next top-level key. */
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

/* Past this many characters a derived line is cut to its first 97 and `...`;
 * probed on 2.1.302 (#2054). */
const DERIVED_LINE_CHARS = 100;

/**
 * The line the harness lists in place of a missing `description` for a skill
 * or command in the host's own `.claude/`: the body's first non-blank line, a
 * leading `#` heading marker stripped. Probed on 2.1.302 (#2054). Residual:
 * the harness also HTML-escapes it (`>` is served as `&gt;`), which this does
 * not count.
 *
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

/*
 * The three `skillOverrides` states that stop a description being sent, per the
 * settings schema shipped in 2.1.250: `name-only` lists the skill with its name
 * alone, `user-invocable-only` hides it from the model but keeps `/name`, and
 * `off` hides it from both. `on`, and an absent entry, deliver it (mantahostels#1786).
 */
/* Typed to admit undefined so the absent-entry case needs no separate guard. */
const SILENCING_OVERRIDES = /** @type {Set<string | undefined>} */ (
	new Set(["name-only", "user-invocable-only", "off"])
);

/**
 * The description this skill or command actually costs the pool, or null.
 *
 * Two independent silencers, either sufficient. `disable-model-invocation: true`
 * in the file's own frontmatter, and a `skillOverrides` entry in settings. Which
 * one wins where they disagree is undocumented and does not matter here: both
 * possible answers cost zero description bytes.
 *
 * The frontmatter limb is worth 71 B of the pool (`retire-to-roadmap`,
 * `wait-what`) and 1,586 B of the vendored total (mantahostels#1757). BOUND, and the reason
 * it is not certain: the measurement was taken in a background job, which is
 * served no user-invocable-command listing. An interactive session may be served
 * these names after all, in which case this under-reports by those figures.
 *
 * NAMES ARE NOT CHARGED, under any state. The listing carries every skill's name
 * whatever its override, so charging one only for a `name-only` skill would both
 * understate the `on` skills beside it and make a shed look smaller than it is.
 *
 * @param {string} text
 * @param {string} [override] the file's `skillOverrides` state, if it has one
 * @returns {string | null}
 */
const deliveredDescriptionOf = (text, override) =>
	/* Strict on the bare `true` deliberately: a `True`/`yes` spelling nobody
	 * writes today falls through and is charged, which over-reports — the safe
	 * direction for a ratchet. */
	frontmatterValue(text, "disable-model-invocation") === "true" ||
	SILENCING_OVERRIDES.has(override)
		? null
		: (descriptionOf(text) ?? derivedLineOf(text));

/**
 * `skillOverrides` out of the settings JSON, keyed by skill or command name.
 *
 * ONLY the tracked project file is read, never `~/.claude/settings.json` or the
 * gitignored `.claude/settings.local.json` that the `/skills` menu writes.
 * Deliberate: --against measures a materialised revision, which holds no
 * untracked file at all, so honouring one here would make the two disagree on
 * the same commit.
 *
 * ⚠ THAT BLIND SPOT CUTS BOTH WAYS. A local file sits ABOVE this one in the settings hierarchy,
 * so a local `"on"` re-delivers a description this charges at 0 B — a genuine
 * UNDER-report. Latent today: no local file here carries `skillOverrides` at all.
 * The instrument against it is `/skills` writing the local file, so treat a shed
 * figure as unreliable on any machine whose menu has been used.
 *
 * Unreadable or malformed settings yield {} — every description charged, which
 * over-reports rather than under-reports (mantahostels#1786).
 *
 * @param {string} json the settings file's text
 * @returns {Record<string, string> | null} null where the text will not parse
 */
function parseSkillOverrides(json) {
	return settingsObject(json, "skillOverrides");
}

/**
 * One top-level object out of the settings JSON — the shape both
 * `skillOverrides` and `enabledPlugins` are read through.
 *
 * @param {string} json the settings file's text
 * @param {string} key
 * @returns {Record<string, any> | null} `{}` where the key is absent or not an object; null where the text will not parse
 */
function settingsObject(json, key) {
	try {
		const value = JSON.parse(json)?.[key];
		return value && typeof value === "object" ? value : {};
	} catch {
		return null;
	}
}

/** The finding an enabled plugin with no table row raises (mantahostels#3132). */
const UNPRICED_PLUGIN = "UNPRICED-PLUGIN";

/**
 * One `enabledPlugins` entry against the table.
 *
 * @typedef {{ name: string, enabled: boolean, tokens: number | null, measured?: string, uncounted?: string }} PluginEntry
 */

/**
 * `enabledPlugins` out of the settings JSON, keyed by plugin name.
 *
 * @param {string} json the settings file's text
 * @returns {Record<string, boolean> | null} null where the text will not parse
 */
function parseEnabledPlugins(json) {
	return settingsObject(json, "enabledPlugins");
}

/**
 * `enabledPlugins` out of the settings file; none where it is absent or will
 * not parse.
 *
 * @param {string} root
 * @returns {Record<string, boolean>}
 */
function readEnabledPlugins(root) {
	/** @type {Record<string, boolean>} */
	let enabled = {};
	try {
		enabled =
			parseEnabledPlugins(
				fs.readFileSync(path.join(root, SETTINGS_FILE), "utf8"),
			) ?? {};
	} catch {
		/* Absent settings: no plugin is enabled. */
	}
	return enabled;
}

/**
 * The plugin cost table's `plugins` rows: empty where the table is absent,
 * BROKEN where it will not read or parse.
 *
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
		/* Parsed outside the read's try: broken() throws, and a catch around
		 * both would swallow it as an absent table. */
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
 * Every plugin `enabledPlugins` names, priced from the table where it has a row.
 *
 * A disabled plugin is listed and not summed — the reader sees what a flip of
 * `scripts/design-mode.sh` would cost. An ENABLED plugin with no row is a WARN
 * (mantahostels#3132). The core's `wfc-self` row is lib/core-context-cost.js's,
 * beneath the table's.
 *
 * A settings file that will not parse has already raised UNPARSEABLE-SETTINGS
 * in readDescriptions(); here it yields no plugins rather than a second finding on
 * the same fault. An absent table (a fixture root has none) leaves every
 * enabled plugin a WARN.
 *
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
 * The `skillOverrides` key for a SKILL.md or a command file.
 *
 * The settings schema keys by skill name, which for every skill in this repo is
 * its directory name.
 * A command is keyed by its filename without the extension.
 *
 * @param {string} relPath a repo-relative `.claude/...` path
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
 * Every always-loaded description, split by whether this repo can edit it.
 *
 * The own/vendored split is the symlink, exactly as §A's register draws it: a
 * `.claude/skills/<name>` that is a symlink points into .agents/skills/, so an
 * undeclared edit to it is lost on the next pull (mantahostels#1826).
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {DescEntry[]}
 */
function readDescriptions(ctx, root) {
	/** @type {DescEntry[]} */
	const out = [];
	const skillsDir = path.join(root, ".claude", "skills");
	const commandsDir = path.join(root, ".claude", "commands");
	/**
	 * A run pointed at the shared working tree reads whatever a neighbour has
	 * mid-save, so it can disagree with the same commit's --against reading, which
	 * is materialised out of git (mantahostels#1786).
	 *
	 * @type {Record<string, string>}
	 */
	let overrides = {};
	try {
		const parsed = parseSkillOverrides(
			fs.readFileSync(path.join(root, SETTINGS_FILE), "utf8"),
		);
		if (parsed === null) {
			/* A FINDING, not a note: it changes what every description below is
			 * charged, so a commit that breaks the file must be able to report it
			 * through the envelope rather than only onto a stream (mantahostels#1786). */
			ctx.warn(
				"UNPARSEABLE-SETTINGS",
				`${SETTINGS_FILE} will not parse; every description charged`,
			);
			ctx.say(
				`NOTE: ${SETTINGS_FILE} will not parse; every description charged (mantahostels#1786).`,
			);
		} else overrides = parsed;
	} catch {
		/* Absent settings file is the ordinary case in a fixture, and says nothing. */
	}

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
 * What one `.claude/agents/*.md` definition puts in the system prompt, permanently:
 * its name and its description.
 *
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
 * The docs the injector pastes, read out of its own `DOCS=(...)` array, and
 * whether the script read was the core's because `root` carries none — an
 * adopter, whose real payloads renderedPayloads() measures instead (#1956).
 *
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{ files: FileEntry[], fromCore: boolean, script: string }}
 */
function readInjectedDocs(ctx, root) {
	/** @type {string} */
	let script;
	let fromCore = false;
	try {
		/* Prefers the copy already at `root`: self-hosted live runs and every
		 * `--against` re-run have one (lib/context-budget-pathspecs.js's list names
		 * INJECTOR, so a materialised tree carries the REVISION's own blob — this is what lets a
		 * staged growth of the injector's own bytes still FAIL the gate). Only a
		 * plugin install's host root lacks it, where INJECTOR_FILE — the core's own
		 * disk copy, constant across revisions — is the fallback (#36). */
		script = fs.readFileSync(path.join(root, INJECTOR), "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") {
			try {
				script = fs.readFileSync(INJECTOR_FILE, "utf8");
				fromCore = true;
			} catch (e2) {
				return ctx.broken(`cannot read ${INJECTOR_FILE}: ${errMessage(e2)}`);
			}
		} else return ctx.broken(`cannot read ${INJECTOR}: ${errMessage(e)}`);
	}
	const docs = docsArray(ctx, script);
	const files = docs.map((rel) => ({
		path: rel,
		bytes: readSize(ctx, root, rel),
	}));
	files.push({
		path: `${INJECTOR} (header + markers)`,
		bytes: injectorBytes(ctx, script, docs, (id) => readRuleFragment(root, id)),
		...(fromCore && { note: "the core's union, capped there" }),
	});
	return { files, fromCore, script };
}

/* ------------------------------------------------------------------ *
 * The injector's own bytes (mantahostels#1284).
 * ------------------------------------------------------------------ */

/*
 * The cap counts the injector's own prose as well as its documents: a span
 * relocated out of a document and into a header variable is the same bytes in the
 * same payload, and must not read as a shed (mantahostels#1284). Since mantahostels#1870 there are no
 * documents, so the prose is the whole of it.
 *
 * The cap measures a UNION, not a variant: every payload string the injector
 * emits plus whatever its DOCS array names. A union binding the largest binds
 * them all, where a per-variant cap would need re-deriving on every narrowing.
 * ONE EXCEPTION: `priced_options` is read as its Core voice pointer, the form
 * this repo's sessions get, and `priced_options_whole` is in no sum (#2039).
 * Residual: this cap never sees the whole shape grow, which only
 * inject-tracker-docs.test.ts's per-command persistence test bounds. The
 * pointer is read because its assignment is the last one at column zero;
 * POINTER_VARS turns an assignment from the whole shape into BROKEN.
 *
 * DOCS IS EMPTY, so the union is the injector's prose alone. The two tracker
 * documents are pointed at rather than pasted, which is what keeps
 * every command's payload under the harness's 10,000-CHARACTER persistence
 * threshold and so landing inline instead of behind a link the session opened
 * roughly a tenth of the time.
 *
 * THE BINDING LIMIT IS PER COMMAND, and this cap cannot read it: /implement's
 * payload is 9,891 characters of the harness's 10,000 (29 Aug 2026), leaving 109
 * to spend. This checker parses the injector rather than running it and sums
 * PAYLOAD_VARS flat, with no model of which command takes which string.
 * scripts/inject-tracker-docs.test.ts executes it and asserts each command under
 * the threshold; the other six figures and the repro are on mantahostels#1915.
 *
 * MEASURED_COMMAND seeds `${matched}` in the header, so the union is 2 B short
 * of /code-review's own interpolation — immaterial against that variant's
 * ~5 KB payload, and in the wrong direction to matter for any other.
 *
 * Parsed, never executed. --against reads the injector out of git, so running it
 * would both defeat that and run whatever a neighbour had half-saved to disk.
 */

/* Only these are added up. The five review strings are named directly: since
 * mantahostels#3451 only /code-review's own `emit` line reaches them, and the RESIDUAL
 * below reads that line as zero. A name reached only as a ref of a listed one
 * is not named: `counted` already expands this list transitively, so naming it
 * too double-counts its bytes, which the tripwire does not catch.
 *
 * MAINTAINED BY HAND — the `uncounted` tripwire below is what catches a string
 * that bypasses this list. It reads `emit "..."` and, since mantahostels#1853, a whole-line
 * bare `emit "$context"` too, then expands transitively through `refs` on both
 * sides of the comparison and checks each name's OWN bytes (refs zeroed out),
 * so a string reached only through the `context=` assignment still surfaces
 * there rather than counting as zero, and a pure container like `context`
 * itself — which self-references its own prior value — is not flagged for
 * bytes that are really its already-counted children's. RESIDUAL: a bare
 * `$var` embedded amid other text on an `emit` line — `emit "prefix $var"` —
 * still reads as zero, the injector having no such line today. */
const PAYLOAD_VARS = [
	"takes_line",
	"header",
	"wayfinder_clauses",
	"tracker_index",
	"closing_steps",
	"priced_options",
	"standards",
	"dispatch",
	"deviations_read",
	"ultra",
	"disposition",
];

/* Each payload variable measured as the pointer form, mapped to the whole
 * form it must not be assigned from (#2039). */
const POINTER_VARS = { priced_options: "priced_options_whole" };

/**
 * Why the cap would measure a POINTER_VARS name as its whole form, or null.
 * @param {Map<string, string[]>} refs
 * @returns {string | null}
 */
function pointerAssignedWhole(refs) {
	for (const [pointer, whole] of Object.entries(POINTER_VARS))
		if (refs.get(pointer)?.includes(whole))
			return (
				`${INJECTOR}'s last ${pointer}= line assigns ${whole}, so this cap ` +
				"would measure the whole shape rather than the Core voice pointer. " +
				`Keep the pointer assignment last and assign ${whole} only off column zero (#2039).`
			);
	return null;
}

/* `header` interpolates the command that matched; the injector's other strings
 * are read at their last, longest assignment, whatever variant that is. */
const MEASURED_COMMAND = "implement";

/* An assignment longer than this is prose. It separates "the parser missed a
 * rule" from "the parser skipped a control variable"; only the first is BROKEN. */
const PROSE_BYTES = 100;

/**
 * One assignment's right-hand side, as the string bash would build.
 *
 * Handles exactly what the injector uses: `"..."` and `$'...'` literals
 * concatenated with no separator, `${name}` interpolation, and the escapes each
 * quoting form takes. Everything else — a command substitution, an unbraced
 * `$var`, a parameter expansion with an operator — returns null, which the caller
 * turns into BROKEN rather than a silent short count.
 *
 * @param {string} rhs
 * @param {Record<string, string>} vars
 * @returns {string | null}
 */
function shellString(rhs, vars) {
	let out = "";
	let at = 0;
	while (at < rhs.length) {
		let part;
		if (rhs.startsWith("$'", at)) part = ansiCQuoted(rhs, at + 2);
		else if (rhs[at] === '"') part = doubleQuoted(rhs, at + 1, vars);
		else return null;
		if (part === null) return null;
		out += part.text;
		at = part.at;
	}
	return out;
}

/**
 * A `$'...'` literal whose body starts at `start`: its text and the index past
 * its closing quote, or null where it never closes.
 *
 * @param {string} rhs
 * @param {number} start
 */
function ansiCQuoted(rhs, start) {
	let out = "";
	let at = start;
	while (at < rhs.length && rhs[at] !== "'") {
		if (rhs[at] !== "\\") {
			out += rhs[at++];
			continue;
		}
		const c = rhs[at + 1];
		if (c === "n") out += "\n";
		else if (c === "t") out += "\t";
		else out += c;
		at += 2;
	}
	if (rhs[at] !== "'") return null;
	return { text: out, at: at + 1 };
}

/**
 * A `"..."` literal whose body starts at `start`: its text and the index past
 * its closing quote, or null where it never closes or holds a `$` form other
 * than `${name}`.
 *
 * @param {string} rhs
 * @param {number} start
 * @param {Record<string, string>} vars
 */
function doubleQuoted(rhs, start, vars) {
	let out = "";
	let at = start;
	while (at < rhs.length && rhs[at] !== '"') {
		if (rhs[at] === "\\") {
			out += rhs[at + 1];
			at += 2;
			continue;
		}
		if (rhs.startsWith("${", at)) {
			const ref = interpolation(rhs, at, vars);
			if (ref === null) return null;
			out += ref.text;
			at = ref.at;
			continue;
		}
		if (rhs[at] === "$") return null;
		out += rhs[at++];
	}
	if (rhs[at] !== '"') return null;
	return { text: out, at: at + 1 };
}

/**
 * A `${name}` interpolation starting at `at`: the variable's value and the
 * index past its `}`, or null where the name is malformed or unassigned.
 *
 * @param {string} rhs
 * @param {number} at
 * @param {Record<string, string>} vars
 */
function interpolation(rhs, at, vars) {
	const end = rhs.indexOf("}", at);
	if (end === -1) return null;
	const name = rhs.slice(at + 2, end);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
	if (!(name in vars)) return null;
	return { text: vars[name], at: end + 1 };
}

const REFS = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const namesIn = (/** @type {string} */ s) =>
	[...s.matchAll(REFS)].map((m) => requiredGroup(m, 1, REFS));

const BARE_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * @param {string} payload
 * @param {Set<string>} emitted accumulator: each name the payload emits is added
 */
function addEmitted(payload, emitted) {
	const bare = payload.match(BARE_REF);
	if (bare) emitted.add(requiredGroup(bare, 1, BARE_REF));
	for (const n of namesIn(payload)) emitted.add(n);
}

/* `name="$(rule_text <id> 2>/dev/null)"`, the one spelling by which the injector
 * reads a rule fragment (#1697): its value is the fragment, as a command
 * substitution strips its trailing newlines. */
const RULE_TEXT_RHS = /^"\$\(rule_text ([a-z0-9-]+) 2>\/dev\/null\)"$/;

/**
 * A rule fragment's text at `root`, or the core's own where `root` holds no
 * store — a plugin install's host — or null where neither reads. Not
 * rule-text.js's layered lookup, which reads the live host root: `--against`
 * measures a materialised revision at `root`.
 *
 * @param {string} root
 * @param {string} id
 * @returns {string | null}
 */
function readRuleFragment(root, id) {
	for (const dir of [path.join(root, RULES_DIR), CORE_RULES]) {
		try {
			return fs
				.readFileSync(path.join(dir, `${id}.txt`), "utf8")
				.replace(/\n+$/, "");
		} catch {
			/* Absent at this layer: the next one answers, or null does. */
		}
	}
	return null;
}

/**
 * The injector's string variables, with a later assignment overwriting an earlier
 * one exactly as bash does — `closing_steps` is assigned empty, then reassigned
 * inside each command's branch.
 *
 * `unparsed` is the tripwire: a long assignment this cannot evaluate is a header
 * string written in a spelling the parser reads as zero. `emitted` is the second
 * one — names handed straight to `emit`, either by a braced `${name}`
 * interpolation or (the caller expands this transitively via `refs`) a bare
 * `$name` line such as the real injector's `emit "$context"` — without passing
 * through PAYLOAD_VARS, which is how a tenth string could be injected into a
 * variant this cap does not measure.
 *
 * @param {string} script
 * @param {(id: string) => string | null} fragment a rule fragment's text, for RULE_TEXT_RHS
 * @returns {{ vars: Record<string, string>, refs: Map<string, string[]>, rhsByName: Map<string, string>, unparsed: string[], emitted: Set<string> }}
 */
function injectorStrings(script, fragment) {
	/** @type {Record<string, string>} */
	const vars = { matched: MEASURED_COMMAND };
	/** @type {Map<string, string[]>} */
	const refs = new Map();
	/** @type {Map<string, string>} */
	const rhsByName = new Map();
	/** @type {string[]} */
	const unparsed = [];
	/** @type {Set<string>} */
	const emitted = new Set();

	const emitRe = /^\s*emit\s+"(.*)"\s*$/;
	const assignRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(["$].*?)\s*$/;
	for (const line of script.split("\n")) {
		const emit = line.match(emitRe);
		if (emit) {
			addEmitted(requiredGroup(emit, 1, emitRe), emitted);
			continue;
		}
		const m = line.match(assignRe);
		if (!m) continue;
		const name = requiredGroup(m, 1, assignRe);
		const rhs = requiredGroup(m, 2, assignRe);
		/* `matched` is the command that fired, seeded above with the variant this
		 * cap measures. The script's own `matched=""` initialiser must not
		 * overwrite it, or the header's `/${matched}` counts nine bytes short. */
		if (name === "matched") continue;
		const ruleId = rhs.match(RULE_TEXT_RHS)?.[1];
		const value = ruleId ? fragment(ruleId) : shellString(rhs, vars);
		if (value === null) {
			/* An unreadable fragment would count as zero, however short its spelling. */
			if (ruleId || rhs.length > PROSE_BYTES) unparsed.push(name);
			continue;
		}
		vars[name] = value;
		refs.set(name, namesIn(rhs));
		rhsByName.set(name, rhs);
	}
	return { vars, refs, rhsByName, unparsed, emitted };
}

/**
 * The bytes the injector adds beyond the documents' own content: the /implement
 * header strings, the marker pair wrapped around each document, and the blank
 * line joining the two halves — less one byte per document, because
 * `body="$(cat "$f")"` strips the trailing newline every one of them ends with.
 *
 * @param {Ctx} ctx
 * @param {string} script
 * @param {string[]} docs
 * @param {(id: string) => string | null} fragment
 * @returns {number}
 */
function injectorBytes(ctx, script, docs, fragment) {
	const { vars, refs, rhsByName, unparsed, emitted } = injectorStrings(
		script,
		fragment,
	);

	if (unparsed.length > 0)
		return ctx.broken(
			`${INJECTOR} assigns ${unparsed.join(", ")} in a form this checker cannot ` +
				"evaluate, so those bytes would be counted as zero. Teach shellString() " +
				"the spelling rather than leaving the injection short-counted (mantahostels#1284).",
		);

	if (!("header" in vars))
		return ctx.broken(`no header=... assignment in ${INJECTOR}`);

	const wholeRead = pointerAssignedWhole(refs);
	if (wholeRead) return ctx.broken(wholeRead);

	/* Every name the capped variant actually concatenates, transitively. */
	const counted = new Set(PAYLOAD_VARS);
	for (const name of counted)
		for (const ref of refs.get(name) ?? []) counted.add(ref);

	/* `emitted` names a top-level variable such as `context`, not the leaf
	 * strings concatenated into it — expand through `refs` the same way
	 * `counted` does, so a string reached only via `context=` still surfaces
	 * here rather than passing this check by naming a var nobody has to count. */
	const reached = new Set(emitted);
	for (const name of reached)
		for (const ref of refs.get(name) ?? []) reached.add(ref);

	/* A container's OWN bytes, not the total it resolves to: `context` self-
	 * references its own prior value and otherwise only concatenates already-
	 * counted names, so checking `vars[n]` directly would flag it for bytes that
	 * are really its children's — already caught, if uncounted, at the ref
	 * itself. Re-run shellString with every name zeroed, so what is left is
	 * exactly the literal text `n`'s own assignment typed outside a `${...}`. A
	 * name with no rhs on record (only `matched`) has no interpolation to strip. */
	const ownBytes = (/** @type {string} */ n) => {
		const rhs = rhsByName.get(n);
		if (rhs === undefined) return bytesIn(vars[n] ?? "");
		/** @type {Record<string, string>} */
		const zeroed = {};
		for (const k of Object.keys(vars)) zeroed[k] = "";
		return bytesIn(shellString(rhs, zeroed) ?? "");
	};

	const uncounted = [...reached].filter(
		(n) => !counted.has(n) && ownBytes(n) > PROSE_BYTES,
	);
	if (uncounted.length > 0)
		return ctx.broken(
			`${INJECTOR} injects ${uncounted.join(", ")} into a payload this cap does ` +
				"not measure — PAYLOAD_VARS is the counted set. Either add the string " +
				"to it or move the cap deliberately " +
				"(docs/doc-map.md §Capture and placement §4, the scope trigger).",
		);

	let bytes = bytesIn("\n\n");
	for (const name of PAYLOAD_VARS) bytes += bytesIn(vars[name] ?? "");
	for (const rel of docs)
		bytes +=
			bytesIn(`--- BEGIN ${rel} ---\n`) +
			bytesIn(`\n--- END ${rel} ---\n\n`) -
			1;
	return bytes;
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
 * The hooks `root` registers, settings-shaped, for the rule-emission figures:
 * lib/core-hooks.js's `ownHooks`.
 *
 * A HOOKS FILE THAT WILL NOT READ IS BROKEN, where `readDescriptions()` above
 * degrades an unparseable settings file into charging every description
 * (mantahostels#1786): a wiring nobody can read, reported as 0 B, is a cap
 * that passes whatever is really there. An adopter's absent settings file is
 * no wiring, so its zero is the truth.
 *
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
	return {
		settings,
		root,
		/* CAP_SOURCE names a file that ships WITH the core (hook-limits.sh), so a
		 * plugin install's host root has none — joining it onto `root` was the
		 * HOST-ROOTED-CORE fault #34 found (#36). Omitted, the reach functions
		 * default to rule-emission.js's own `CAP_FILE`, read off that module's
		 * `__dirname`, which finds the core's copy wherever it is installed.
		 * `WFC_CAP_FILE` is the test-injection seam (`lib/host-root.js`'s header
		 * convention): the suite plants a fake hook-limits.sh and points this at
		 * it rather than at a file under --root. */
		capFile: process.env.WFC_CAP_FILE,
		/* RULES_DIR is the fragment store the host's own guards write to
		 * (docs/agents/rules), never core content, so it stays root-relative. */
		rulesDir: path.join(root, RULES_DIR),
		/* A core guard wired in an adopter resolves its injected ids out of the
		 * core's store; without this layer they read as unresolvable (#101).
		 * `WFC_RULES_FALLBACK_DIR` is the test-injection seam `lib/host-root.js`'s
		 * header convention names (as `WFC_CAP_FILE` above honours it for the cap
		 * source): a fixture pins this away from the live core store, rather than
		 * inheriting it and letting a colliding id resolve silently (#109).
		 * `!== undefined`, not `||`: an EMPTY string is a fixture asking for no
		 * fallback layer at all, as rule-text.js's own resolution reads it — `||`
		 * would fall that case through to the live store too. */
		rulesFallbackDir:
			process.env.WFC_RULES_FALLBACK_DIR === undefined
				? CORE_RULES
				: process.env.WFC_RULES_FALLBACK_DIR,
	};
}

/**
 * Per-session reachable route (f) bytes per PreToolUse tool.
 *
 * @param {Ctx} ctx
 * @param {ReturnType<typeof reachOptions>} opts
 * @returns {{ cap: number, tools: Record<string, { bytes: number, ids: string[], guards: { file: string, bytes: number, calls: number, ids: string[] }[] }>, ratchet: { bytes: number, ids: string[] }, overCap: { id: string, bytes: number, guards: string[] }[], direct: { id: string, bytes: number | null, guards: string[], counted: boolean, latched: "none" | "bounded" | "ambiguous" }[], latchFaults: { id: string, guard: string, resolves: boolean, bound: boolean, marked: boolean }[], fragmentBytes: Record<string, number> }}
 */
function sessionFigures(ctx, opts) {
	/* NOTHING WIRED IS NOT AN UNKNOWN. No PreToolUse key, or an empty list, is no
	 * group to price, so the figure is zero without reading RULE_CAP at all.
	 *
	 * A KEY OF THE WRONG SHAPE IS NOT THAT CASE and falls through deliberately:
	 * rule-emission.js throws on it, and a zero here would swallow that throw and
	 * report a wiring nobody could read as compliant. */
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
		return reachableByTool(opts);
	} catch (e) {
		/* Every throw here is apparatus: a guard file, the RULE_CAP assignment,
		 * a malformed settings shape, or an injection naming an id the fragment
		 * store cannot resolve at all — none of them a bug in this checker, but all
		 * of them what it reads the repo WITH rather than what it is asking about.
		 *
		 * A FRAGMENT OVER RULE_CAP ON ITS OWN DOES NOT LAND HERE (mantahostels#2054):
		 * that is the repo's own rule text, not this checker's apparatus, so
		 * reachableByTool() reports it in `overCap` instead, and the OVER_FRAGMENT
		 * finding below is what surfaces it. */
		return ctx.broken(
			`cannot compute the per-session rule emission: ${errMessage(e)}`,
		);
	}
}

/**
 * The rule text each AFTER_EVENTS hook can hand a session (#2144).
 *
 * @param {Ctx} ctx
 * @param {ReturnType<typeof reachOptions>} opts
 * @returns {ReturnType<typeof reachableAfterCall>}
 */
function afterCallFigures(ctx, opts) {
	try {
		return reachableAfterCall(opts);
	} catch (e) {
		return ctx.broken(
			`cannot compute the after-call rule emission: ${errMessage(e)}`,
		);
	}
}

/**
 * The mantahostels#1177 admissibility prompt (the ticket that ruled a new rule on the
 * always-loaded pool faces one question before it ships), as a measurement
 * rather than as a message.
 *
 * ONE-SIDED, BECAUSE THIS CHECKER ONLY EVER SEES ONE REVISION (mantahostels#1834). It fires
 * on GROWTH, which is a two-sided fact, so what it emits here is the reading —
 * the pool files' own byte total — and lib/check.js's `--against` prints the
 * prompt where that total is higher than the baseline's. Outside `--against`
 * nothing prints it.
 *
 * mantahostels#1177 scoped the question to the three files the pool then held; mantahostels#1504 added
 * a fourth — the adopter's declared output style, `overrides.output_style` —
 * without revisiting that scope, and mantahostels#1627 confirmed the question governs it
 * too. mantahostels#1503 then made that fourth file double-loaded, so this counts BOTH its
 * rows and matches what the cap charges.
 *
 * Reads the pool files' own bytes, never the wider pool total the caps gate on —
 * that figure also carries skill/command/agent descriptions, which mantahostels#1177 named
 * out of scope by name. A commit that only lengthens a skill description must
 * not print this.
 *
 * The pointer names `.claude/skills/pressure-test/SKILL.md`'s step 1 by
 * position, and nothing re-checks that a later renumbering keeps it true.
 *
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
/* Which guards make up one tool's figure, and how many injections each holds
 * — a group over its cap is answered by shedding a named guard's text, so the
 * contributors are the finding rather than decoration.
 *
 * A ROW'S BYTES ARE ITS OWN IDS' AND MAY OVERLAP A SIBLING'S: the group total
 * above is the UNION, so the rows can sum past it where two guards reach one
 * id. */
const guardRows = (
	/** @type {{ file: string, bytes: number, calls: number, ids: string[] }[]} */ gs,
) =>
	gs
		.map(
			(g) =>
				`    ${String(g.bytes).padStart(5)} B  ${g.file} (${g.ids.length} id${g.ids.length === 1 ? "" : "s"} over ${g.calls} injection${g.calls === 1 ? "" : "s"})`,
		)
		.join("\n");

/* Decimal KB, because docs/doc-map.md §Capture and placement states caps that way. */
const kb = (/** @type {number} */ b) => `${(b / 1000).toFixed(1)} KB`;

/* Exactly on the cap gets words of its own, never "0 B over" (mantahostels#1940). */
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
 * What the pool's members `@`-import, or BROKEN where a read fails other than
 * by absence.
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
 * The always-loaded pool's rows: every pool file, then the two description
 * totals.
 *
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
 * The refusal's pointer to a shed register, printed only where the host keeps
 * that file: the core's registers list the core's own text (#1673).
 * @param {string} root
 * @param {string} rel
 * @param {string} [cite] what follows the path on its line
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
	/* AT the cap counts, not merely past it: the caps are stated as a ceiling
	 * the surface may reach and not exceed (docs/doc-map.md §Capture and
	 * placement §4), and a one-byte gap here is a gate that never fires on the
	 * commit that lands exactly on it. */
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
			"  (docs/doc-map.md §Capture and placement §4).\n" +
			buildShedCandidatesLine(root, SHED_REGISTERS.pool) +
			"  The only other way past this is to move the cap deliberately, by editing\n" +
			"  docs/doc-map.md §Capture and placement §4 — the unpayable-correction trigger (mantahostels#1220).\n",
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
			`\n  Pasted into ${INJECTOR}'s seven commands; the same shed rule applies\n` +
			"  (docs/doc-map.md §Capture and placement §4).\n" +
			buildShedCandidatesLine(
				root,
				SHED_REGISTERS.injection,
				" (mantahostels#1259, mantahostels#1268)",
			) +
			"  The only other way past this is to move the cap deliberately, by editing\n" +
			"  docs/doc-map.md §Capture and placement §4 — the unpayable-correction trigger (mantahostels#1220).\n",
	);
}

/**
 * @param {Ctx} ctx
 * @param {[string, ReachGroup][]} reachTools
 */
function reportSessionBreaches(ctx, reachTools) {
	/* ONE FINDING PER TOOL, not one for the worst: each group is its own
	 * surface, so a shed on Bash must not mask a rise on Write. The direction
	 * gate keys them apart on `surface` (lib/context-budget-tags.js). */
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
				"  Shed fragment text, or move the cap deliberately in docs/doc-map.md\n" +
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
	/* The shared ratchet: route (f)'s second axis (mantahostels#1720). The UNION of every
	 * reachable id across every tool, never a sum per tool: a guard wired to a
	 * multi-tool matcher (guard-dispatch.js on `Write|Edit|NotebookEdit`)
	 * fires once per tool it is matched against, but it is the same fragment
	 * text every time and the latch pays it once. Summing per tool would
	 * count it three times over. */
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
	/* Null bytes read as zero: an unresolvable id still costs the session the
	 * guard's fallback sentence, but this module cannot know its length. */
	const directTotal = direct.reduce((t, d) => t + (d.bytes ?? 0), 0);
	/* Split out because the two halves answer different questions: the second
	 * is what no figure carries at all, the first is bytes the figures DO
	 * carry once a session and this block carries again per firing. */
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
	/* A fragment a wired guard reaches that is over RULE_CAP on its own
	 * (mantahostels#2054) is the repo's own rule text, not this checker's apparatus, so it
	 * is a finding here rather than a throw sessionFigures() catches — one per
	 * over-cap id, naming every guard that reaches it. Mechanism:
	 * rule-emission.js's guardIds() docstring. */
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
	/* A stranded `ctx.told` (mantahostels#2283). A finding rather than a table row,
	 * the table being suppressed under --notify. */
	for (const f of reach.latchFaults) {
		/* Every failing limb, never the first. */
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

/**
 * The five heaviest vendored descriptions, one line each.
 *
 * @param {DescEntry[]} vendored
 */
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
		/* An over-cap group printed its guards in the breach block
		 * above; repeating them here is eight lines saying nothing
		 * new. An under-cap group has had no other chance to. */
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

/**
 * The rule text hooks hand a session after its call has run (#2144).
 *
 * @param {ReturnType<typeof reachableAfterCall>} after
 */
function afterCallSection(after) {
	const events = AFTER_EVENTS.join(", ");
	/* By id: one guard can be wired on two events. */
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
		"  no cap of its own is seated (docs/doc-map.md §Capture and placement §3).\n"
	);
}

/** @typedef {{ script: string, commands: import("./lib/rendered-injection.js").RenderedPayload[] } | { error: string }} RenderedPayloads */

/**
 * The core injector's payload per command, rendered for a host carrying none
 * of its own (#1956).
 * @param {string} script the injector's text, already read
 * @param {string} root
 * @returns {RenderedPayloads}
 */
function renderedFor(script, root) {
	const commands = bashArray(script, "COMMANDS");
	if (!commands)
		return { error: `no COMMANDS=(...) array in ${INJECTOR_FILE}` };
	return {
		script: INJECTOR_FILE,
		commands: renderedPayloads(INJECTOR_FILE, commands, root),
	};
}

/**
 * What each command hands this host, where the figure above is the core's.
 * Uncapped: the host cannot shed the core's prose.
 * @param {RenderedPayloads | null} rendered
 */
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
		`ALWAYS-LOADED POOL — ${kb(total)} of ${kb(CAP_BYTES)}, ${headroom} B headroom (docs/doc-map.md §Capture and placement).\n` +
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
			/* The direct `rule_text` calls, printed under the two capped figures
			 * and deliberately outside them (mantahostels#2055). The printed text carries
			 * the reasoning. */
			`\nDIRECT RULE TEXT — ${directTotal} B across ${reach.direct.length}, of which ${directUncounted} B is on no figure above. Uncapped.\n` +
			buildDirectLines(reach.direct) +
			"  Spliced into the guard's own deny or warn text, so it is route (e)\n" +
			"  (docs/doc-map.md §Capture and placement §3), which owes no shed. That\n" +
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

/** A guess, unmeasured: one GraphQL call answered in under 1 s when measured
 * at #2033, so 15 s fails only a hung gh. */
const GH_TIMEOUT_MS = 15_000;

/**
 * The open/closed state of each ticket, off one GraphQL call to the host's
 * tracker; `{ error }` where gh cannot answer, so no ticket is called open or
 * closed (#2033).
 *
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
		// Deliberate: an unread state reports as unread, never fails the run (#2033).
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
 * The pool's rule count, and — where `.claude/workflow-core.json` switches
 * `admissionGate` on — the rules the admission ledger does not admit and the
 * `trigger` entries whose ticket has closed (#2033).
 *
 * The unadmitted rules are the envelope's `unadmitted` key, which the
 * direction gate refuses only as this commit's addition (checker-new-faults.js).
 *
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
	/* The baseline side's CLOSED_TRIGGER warns are never compared, so the
	 * lookup is spent on the index side alone (#2056). */
	const states =
		tickets.length === 0 || isBaselineSide()
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

/* Spelled as a constant so the suite can require this file for its pathspecs
 * without running the check (#1120). */
/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "context-budget",
	usage:
		"node check-context-budget.js [--root <dir>] [--notify] [--against <rev>] [--json]",
	valueFlags: ["--root"],
	against: {
		profile: "context-budget",
		/* The scan scope is a declared pathspec, so extracting the whole 19 MB
		 * tree twice would be a cost regression for reading this already does by
		 * sha — MATERIALISERS in lib/check.js. */
		materialise: "blobs",
		pathspecs: materialisePathspecs,
		/* The admissibility prompt fires on a pool that grew without breaching
		 * anything, so the lazy baseline — read only where something already gates
		 * — would silence it on exactly the commits it exists for. Affordable only
		 * because this is a blob fetch: a few hundred KB a side, not 19 MB. */
		baseline: "always",
	},
	/** @returns {CheckResult} */
	run(/** @type {Ctx} */ ctx) {
		/* The HOST repo, through the one seam (#1), never this script's parent:
		 * in a plugin install that is the plugin root, and the always-loaded pool
		 * — CLAUDE.md among it — was read from there (finding F10 of the adoption
		 * dry run). */
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

		const { files: injected, fromCore, script } = readInjectedDocs(ctx, root);
		const rendered = fromCore ? renderedFor(script, root) : null;
		const injTotal = sum(injected, (f) => f.bytes);
		const injHeadroom = INJECTION_CAP_BYTES - injTotal;

		const opts = reachOptions(readHooks(ctx, root), root);
		const reach = sessionFigures(ctx, opts);
		const after = afterCallFigures(ctx, opts);
		/* Sorted heaviest first so the table's first line is the group nearest the
		 * cap, and so a new matcher group lands wherever its bytes put it — the set
		 * of tools is whatever the wiring names, never a list kept here. */
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

		/* The full table is the on-demand answer to "have I room to add this?", so
		 * it prints over a cap as well as under it. Only --notify suppresses it: on
		 * that route, nothing but a breach has earned the founder's attention. */
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
					/* Present whether or not the fragment breached, which `overCap`
					 * is not — the direction gate reads its baseline half here
					 * (mantahostels#2260). */
					fragmentBytes: reach.fragmentBytes,
					ratchet: { cap: RATCHET_CAP_BYTES, total: ratchetTotal },
					/* mantahostels#2055. */
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

if (require.main === module) runCheck(SPEC);
