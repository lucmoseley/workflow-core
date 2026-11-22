const path = require("node:path");
const { ignoreFailure } = require("./caught.js");
const { brokenError } = require("./check");
const { readObjectBatch } = require("./git-objects");
const { requiredGroup } = require("./regex-group");
const { CONFIG_PATH } = require("./workflow-core-config");
const { getPoolFiles } = require("./always-loaded-pool");
const { SELF_PLUGIN_HOOKS, readOwnHooks } = require("./core-hooks.js");
const { AFTER_EVENTS } = require("./hook-events.js");
const { hostRoot } = require("./host-root.js");
const { TRACKER_TEXT } = require("./load-text-module.js");
const { MANIFEST_REL } = require("./guard-cores.js");
const {
	CAP_SOURCE,
	WIRED_SCRIPT_RE,
	EVENT,
	registrationsOn,
	readSourcedClosure,
} = require("./rule-emission");

/** @typedef {import("./check").Ctx} Ctx */
/** @typedef {import("./core-hooks.js").Hooks} Hooks */

const SETTINGS_FILE = ".claude/settings.json";

const PLUGIN_COST_TABLE = ".claude/plugin-context-cost.json";

const TRACKER_TEXT_FILE =
	process.env.WFC_TRACKER_TEXT_FILE ||
	path.join(__dirname, "tracker-inject-text.js");

const CAPPED_PATHSPECS = [
	".claude/skills",
	".claude/commands",
	".claude/agents",
	SETTINGS_FILE,
	CONFIG_PATH,
	SELF_PLUGIN_HOOKS,
	TRACKER_TEXT,
	"docs/agents",
];

const VENDORED_SOURCE = ".agents/skills";

const MEASURED_ONLY = [VENDORED_SOURCE, PLUGIN_COST_TABLE];

const { LEDGER_PATH } = require("./pool-admission.js");

const SHED_REGISTERS = {
	pool: "docs/research/always-loaded-shed-candidates.md",
	injection: "docs/research/injected-tracker-docs-shed-candidates.md",
};

/**
 * @param {string} rev
 * @returns {string[]}
 */
function readRuleSourcePathspecs(rev) {
	const specs = new Set([CAP_SOURCE]);
	/** @type {RegExpMatchArray[]} */
	const matches = [];
	ignoreFailure(() => {
		const settings = { hooks: readOwnHooks(hostRoot(), { rev }) ?? {} };
		const manifest = readManifestAtRev(rev);
		if (manifest) specs.add(MANIFEST_REL);
		for (const event of [EVENT, ...AFTER_EVENTS])
			for (const { commandLine } of registrationsOn(settings, event, manifest))
				matches.push(...commandLine.matchAll(WIRED_SCRIPT_RE));
	});
	const guards = [
		...new Set(matches.map((m) => requiredGroup(m, 1, WIRED_SCRIPT_RE))),
	];
	for (const rel of guards) specs.add(rel);
	/** @type {Map<string, string | null>} */
	const libs = new Map();
	const readLib = (/** @type {string} */ lib) => {
		if (!libs.has(lib)) {
			const [text] = readBlobsAt(rev, [lib]);
			if (text === undefined)
				throw brokenError(`no blob came back for ${rev}:${lib}`);
			libs.set(lib, text);
		}
		return libs.get(lib) ?? null;
	};
	for (const [i, text] of readBlobsAt(rev, guards).entries()) {
		const rel = guards[i];
		if (rel === undefined)
			throw brokenError(`a blob came back for no guard asked of ${rev}`);
		if (text !== null)
			for (const lib of readSourcedClosure(rel, text, readLib).keys())
				specs.add(lib);
	}
	return [...specs];
}

/**
 * @param {string} rev
 * @returns {import("./guard-cores.js").Manifest | undefined}
 */
function readManifestAtRev(rev) {
	const [rows] = readBlobsAt(rev, [MANIFEST_REL]);
	return rows ? JSON.parse(rows) : undefined;
}

/**
 * @param {string} rev
 * @param {string[]} rels
 * @returns {(string | null)[]}
 */
const readBlobsAt = (rev, rels) =>
	readObjectBatch(
		rels.map((rel) => `${rev}:${rel}`),
		`${rev}'s guard sources`,
	).map((r) => (r === null ? null : r.body.toString("utf8")));

/**
 * @param {Ctx} _ctx
 * @param {string} rev
 * @returns {string[]}
 */
const materialisePathspecs = (_ctx, rev) => [
	...getPoolFiles(),
	...CAPPED_PATHSPECS,
	...MEASURED_ONLY,
	LEDGER_PATH,
	...Object.values(SHED_REGISTERS),
	...readRuleSourcePathspecs(rev),
];

module.exports = {
	SETTINGS_FILE,
	PLUGIN_COST_TABLE,
	SHED_REGISTERS,
	TRACKER_TEXT,
	TRACKER_TEXT_FILE,
	materialisePathspecs,
};
