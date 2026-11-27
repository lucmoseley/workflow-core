const fs = require("node:fs");
const path = require("node:path");
const { run, installFailure } = require("./materialise-plugin.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { SELF_PLUGIN_ID } = require("./core-hooks.js");

const ALWAYS_ON_RE =
	/Always-on:\s*(?:~\s*)?([\d,]+(?:\.\d+)?)\s*(?:(k)\s*)?tok/i;

const COST_TABLE = ".claude/plugin-context-cost.json";
const SETTINGS = ".claude/settings.json";

const SELF_PLUGIN_COST = {
	id: SELF_PLUGIN_ID,
	row: { tokens: 0, measured: "2026-10-22" },
};

// guess, workflow-core#5529
const DETAILS_TIMEOUT_MS = 30_000;

/** @param {unknown} err */
const parseErrMessage = (err) => caught(err).message;

const ABOUT =
	"Per-plugin always-on context cost, in tokens as `claude plugin details <name>` reports it, keyed by the `enabledPlugins` name in .claude/settings.json. check-context-budget.js reads it every session and WARNs on an enabled plugin with no row here. An `uncounted` component is one the figure omits, such as an MCP server's tool schemas.";

/**
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
 * @param {{root: string, pluginId: string, claudeBin?: string,
 * configDir?: string}} at
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
 * @param {{root: string, claudeBin?: string, configDir?: string}} at
 * @returns {Measurer}
 */
function measurerFor(at) {
	return (pluginId) => measureAlwaysOn({ ...at, pluginId });
}

/**
 * @param {string} tablePath
 * @param {string} pluginId
 * @param {(line: string) => void} out
 * @returns {{text: string|null, indent: string,
 * table: {plugins: Record<string, unknown>} & Record<string, unknown>}|null}
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
 * @param {{root: string, pluginId: string, measure: Measurer,
 * dryRun?: boolean, out: (line: string) => void, now?: Date}} at
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
