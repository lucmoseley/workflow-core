/*
 * core-context-cost.js — seeds the core's own row in an adopter's
 * `.claude/plugin-context-cost.json`, so check-context-budget.js does not WARN
 * from day one on the one plugin the adopter was told to install (#679).
 *
 * Shared by init-adopter.js, after it materialises the plugin, and by
 * `upgrade()`'s every-run steps, so an adopter adopted before this landed
 * picks the row up on its next bump. Only a MISSING row is added: an existing
 * one is the adopter's, re-measured or not.
 *
 * The figure is `claude plugin details`' own always-on token count, as the
 * table's `about` requires (mantahostels#3116) — never computed here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { run, installFailure } = require("./materialise-plugin.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { SELF_PLUGIN_ID } = require("./core-hooks.js");

const ALWAYS_ON_RE = /Always-on:\s*~?\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*tok/i;

const COST_TABLE = ".claude/plugin-context-cost.json";
const SETTINGS = ".claude/settings.json";

/**
 * The core's own row for `wfc-self`, the self-plugin that registers its hooks
 * and nothing else (#2295). `claude plugin details` on 2.1.306 lists no skill
 * or agent, calls its hooks harness-only and reads Always-on ~0 tok; the rule
 * text those hooks hand a session is priced from lib/core-hooks.js, with the
 * rest of check-context-budget.js's hook figures. Kept here, not in the core's
 * table, so seeding never copies it into an adopter's.
 */
const SELF_PLUGIN_COST = {
	id: SELF_PLUGIN_ID,
	row: { tokens: 0, measured: "2026-10-22" },
};

/* Stops a hung CLI holding a SessionEnd hook to its budget. */
const DETAILS_TIMEOUT_MS = 30_000;

/** @param {unknown} err */
const parseErrMessage = (err) => caught(err).message;

const ABOUT =
	"Per-plugin always-on context cost, in tokens as `claude plugin details <name>` reports it, keyed by the `enabledPlugins` name in .claude/settings.json. check-context-budget.js reads it every session and WARNs on an enabled plugin with no row here. An `uncounted` component is one the figure omits, such as an MCP server's tool schemas.";

/**
 * The `Always-on:` figure out of `claude plugin details` output — `~22 tok`,
 * `~2,273 tok` or `~2.3k tok`. Null where no such line reads as a number.
 * @param {string} text
 * @returns {number|null}
 */
function parseAlwaysOn(text) {
	const m = ALWAYS_ON_RE.exec(text);
	if (!m) return null;
	const n =
		Number(requiredGroup(m, 1, ALWAYS_ON_RE).replace(/,/g, "")) *
		(m[2] ? 1000 : 1);
	return Number.isFinite(n) ? Math.round(n) : null;
}

/** @typedef {{tokens: number} | {reason: string}} Measurement */
/** @typedef {(pluginId: string) => Measurement} Measurer */

/**
 * `claude plugin details <pluginId>` against the adopter's tree. Never throws.
 * @param {{root: string, pluginId: string, claudeBin?: string,
 *   configDir?: string}} at
 * @returns {Measurement}
 */
function measureAlwaysOn({ root, pluginId, claudeBin = "claude", configDir }) {
	let text;
	try {
		text = run(root, [claudeBin, "plugin", "details", pluginId], {
			quiet: true,
			configDir,
			timeoutMs: DETAILS_TIMEOUT_MS,
		});
	} catch (err) {
		return { reason: installFailure(err) };
	}
	const tokens = parseAlwaysOn(text);
	return tokens === null
		? {
				reason: `no always-on figure in its output: ${text.trim().split("\n")[0] || "(empty)"}`,
			}
		: { tokens };
}

/**
 * `measureAlwaysOn` bound to one adopter, for the callers that hand it on.
 * @param {{root: string, claudeBin?: string, configDir?: string}} at
 * @returns {Measurer}
 */
function measurerFor(at) {
	return (pluginId) => measureAlwaysOn({ ...at, pluginId });
}

/**
 * The cost table as it stands — or, where it is absent, the empty one to
 * create — with its raw text and indent. Null where seeding stops here: the
 * table does not parse, has no `plugins` object, or already holds the row.
 *
 * @param {string} tablePath
 * @param {string} pluginId
 * @param {(line: string) => void} out
 * @returns {{text: string|null, indent: string,
 *   table: {plugins: Record<string, unknown>} & Record<string, unknown>}|null}
 */
function readCostTable(tablePath, pluginId, out) {
	if (!fs.existsSync(tablePath))
		return { text: null, table: { about: ABOUT, plugins: {} }, indent: "\t" };
	const text = fs.readFileSync(tablePath, "utf8");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		out(
			`skipped the ${pluginId} row: ${COST_TABLE} does not parse (${parseErrMessage(err)})`,
		);
		return null;
	}
	if (!parsed?.plugins || typeof parsed.plugins !== "object") {
		out(`skipped the ${pluginId} row: ${COST_TABLE} has no \`plugins\` object`);
		return null;
	}
	if (pluginId in parsed.plugins) return null;
	const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? "\t";
	return { text, table: parsed, indent };
}

/**
 * Adds `pluginId`'s row where the table lacks it, creating the table where it
 * is absent. Silent where the row is already there, or where no settings file
 * or no enabled entry declares the plugin; one line otherwise, an unparseable
 * settings file included.
 *
 * AN EXISTING TABLE IS WRITTEN ONLY WHERE IT IS ALREADY IN CANONICAL LAYOUT —
 * `JSON.stringify` at its own indent, one trailing newline — so every other
 * row comes back byte-identical. A table in any other layout is left alone
 * and the line names the row to add by hand.
 *
 * @param {{root: string, pluginId: string, measure: Measurer,
 *   dryRun?: boolean, out: (line: string) => void, now?: Date}} at
 */
function seedCoreCost({
	root,
	pluginId,
	measure,
	dryRun = false,
	out,
	now = new Date(),
}) {
	const settingsPath = path.join(root, SETTINGS);
	if (!fs.existsSync(settingsPath)) return;
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch (err) {
		out(
			`skipped the ${pluginId} row: ${SETTINGS} does not parse (${parseErrMessage(err)})`,
		);
		return;
	}
	if (settings?.enabledPlugins?.[pluginId] !== true) return;

	const tablePath = path.join(root, COST_TABLE);
	const existing = readCostTable(tablePath, pluginId, out);
	if (existing === null) return;
	const { text, table, indent } = existing;

	if (dryRun) {
		out(`would   add the ${pluginId} row to ${COST_TABLE}`);
		return;
	}
	const measured = measure(pluginId);
	if ("reason" in measured) {
		out(
			`MISSING the ${pluginId} row in ${COST_TABLE}, so check-context-budget.js WARNs on it: ` +
				`${measured.reason} — run \`claude plugin details ${pluginId}\` and add its always-on figure`,
		);
		return;
	}
	const row = {
		tokens: measured.tokens,
		measured: now.toISOString().slice(0, 10),
	};
	const serialise = (/** @type {unknown} */ v) =>
		`${JSON.stringify(v, null, indent)}\n`;
	if (text !== null && serialise(table) !== text) {
		out(
			`skipped the ${pluginId} row: ${COST_TABLE} is not in canonical layout, and rewriting it would reformat the other rows — add "${pluginId}": ${JSON.stringify(row)} by hand`,
		);
		return;
	}
	table.plugins[pluginId] = row;
	fs.mkdirSync(path.dirname(tablePath), { recursive: true });
	fs.writeFileSync(tablePath, serialise(table));
	out(
		`${text === null ? "wrote  " : "rewrote"} ${COST_TABLE} (the ${pluginId} row, ~${row.tokens} tok)`,
	);
}

module.exports = {
	COST_TABLE,
	SELF_PLUGIN_COST,
	measurerFor,
	seedCoreCost,
};
