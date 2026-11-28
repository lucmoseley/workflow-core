const fs = require("node:fs");
const path = require("node:path");
const { MODULES, COMMANDS, CONTRACT } = require("./workflow-core-config.js");
const { formatConfigJson, isObject } = require("./config-json.js");
const { requiredGroup } = require("./regex-group.js");
const { ORIGIN_LABELS } = require("./issue-origin.js");
const { SIGNATURE_LABEL } = require("./signature-label.js");
const { CORE_STYLE, namespaced } = require("./output-styles.js");
const { withoutSelfPlugin } = require("./core-hooks.js");
const { shellQuote } = require("./sh-quote.js");
const { URGENT_LABEL } = require("./urgent-label.js");
const { WATCH_CLOSED_LABEL } = require("./watch-label.js");
const { RESOLVE_CORE_SCRIPT } = require("./tree-core.js");
const { realPathOrNull } = require("./real-path.js");
const { FAIL_OPEN_HOOKS, SHIM_MARK, isHookShim } = require("./hook-shim.js");

const TEMPLATES = path.join(__dirname, "..", "templates", "adopter");

/** @typedef {import("./workflow-core-config.js").Module} Module */

const { MIRRORED_FILE: RULES_FILE } = require("./machine-mirrored-rules.js");
const CORE_OWNED = "<!-- CORE-OWNED.";

const REFERENCE_FILE = ".claude/workflow-core.reference.md";

const PROVENANCE_HEADING = "## Plugin provenance";

const RUNNER = /\b(node|bash|sh|python3) scripts\//g;

const TEMPLATE_FILES = {
	"AGENTS.md": path.join(TEMPLATES, "AGENTS.md"),
	"CLAUDE.md": path.join(TEMPLATES, "CLAUDE.md"),
	"called-cards.md": path.join(TEMPLATES, "called-cards.md"),
	"code-standards.md": path.join(TEMPLATES, "code-standards.md"),
	"doc-map.md": path.join(TEMPLATES, "doc-map.md"),
	"reference-roadmap.html": path.join(TEMPLATES, "reference-roadmap.html"),
	"reference.md": path.join(TEMPLATES, "reference.md"),
	"session-rules.md": path.join(TEMPLATES, "session-rules.md"),
};

/** @param {keyof typeof TEMPLATE_FILES} name */
const readTemplate = (name) => fs.readFileSync(TEMPLATE_FILES[name], "utf8");

const TAG = new RegExp(`^(\\s*(?:-\\s+)?)\\[(${MODULES.join("|")})\\]\\s+`);

const TEMPLATE_HEADER = /^<!-- TEMPLATE for [\s\S]*?-->\n/;

const STATUS_SCRIPT =
	"node scripts/lib/resolve-core.js scripts/status-report.js";

/**
 * @param {{modules: Module[], founder: string, pluginRoot: string}} at
 * @returns {string}
 */
function renderSessionRules({ modules, founder, pluginRoot }) {
	const on = new Set(modules);
	const kept = readTemplate("session-rules.md")
		.replace(TEMPLATE_HEADER, "")
		.split("\n")
		.flatMap((line) => {
			const tag = line.match(TAG);
			if (!tag) return [line];
			return on.has(/** @type {Module} */ (requiredGroup(tag, 2, TAG)))
				? [line.replace(TAG, requiredGroup(tag, 1, TAG))]
				: [];
		})
		.join("\n");
	return rewriteRuleCommands(substitute(kept, { founder }), pluginRoot);
}

/**
 * @param {string} pluginRoot
 * @returns {string}
 */
const renderReference = (pluginRoot) =>
	rewriteRuleCommands(
		readTemplate("reference.md").replace(TEMPLATE_HEADER, ""),
		pluginRoot,
	);

/**
 * @param {string} text
 * @param {string} pluginRoot
 */
function rewriteRuleCommands(text, pluginRoot) {
	const quotedRoot = shellQuote(
		realPathOrNull(pluginRoot) ?? path.resolve(pluginRoot),
	);
	return text
		.replace(RUNNER, (_, runner) => `${runner} ${quotedRoot}/scripts/`)
		.replace(/`scripts\/(?=[^`\s]+ [^`]*`)/g, () => `\`${quotedRoot}/scripts/`);
}

/**
 * @param {import("./plugin-record.js").PluginRecord} at
 * @returns {string}
 */
function describePluginRecord(at) {
	if (at.source === "url") {
		return at.resolvedSha
			? `url source, ref ${at.ref}, HEAD ${at.resolvedSha}`
			: `url source, ref ${at.ref} (sha unknown)`;
	}
	if (at.headSha === null)
		return "directory source, no readable git at the plugin root";
	return `directory source, HEAD ${at.headSha}${at.dirty ? " (dirty)" : ""}`;
}

/**
 * #5826
 * @param {string} block
 * @param {string} ref
 * @returns {string|null}
 */
function recordedUrlSha(block, ref) {
	const line = block.match(/^- url source, ref (\S+), HEAD (\S+)$/m);
	return line && line[1] === ref ? (line[2] ?? null) : null;
}

/**
 * @param {import("./plugin-record.js").PluginRecord} at
 * @returns {string}
 */
function renderPluginRecord(at) {
	return [
		"",
		PROVENANCE_HEADING,
		"",
		`- ${describePluginRecord(at)}`,
		"- the seven husky hooks run from `WFC_PLUGIN_ROOT` in both branches, so this is what the last init or upgrade installed, not what the hooks run today",
		"",
	].join("\n");
}

/**
 * @param {string} text
 * @param {Record<string, string>} values
 */
function substitute(text, values) {
	return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => values[key] ?? whole);
}

/**
 * @param {{founder: string, corpus?: string[], modules: Module[], categories: Record<string, string>, commands: Record<string, string|null>, roadmapVersion?: string, walkedTo?: string}} at
 * @returns {string}
 */
function renderConfig({
	founder,
	corpus,
	modules,
	categories,
	commands,
	roadmapVersion,
	walkedTo,
}) {
	/** @type {Record<string, unknown>} */
	const config = { contract: CONTRACT, founder };
	if (corpus) config.corpus = corpus;
	const declared = Object.fromEntries(
		COMMANDS.filter((c) => commands[c]).map((c) => [c, commands[c]]),
	);
	if (Object.keys(declared).length > 0) config.commands = declared;
	config.modules = modules;
	if (Object.keys(categories).length > 0) config.categories = categories;
	if (walkedTo) config.walkedTo = walkedTo;
	if (modules.includes("roadmap") && roadmapVersion) {
		const major = Number(roadmapVersion.split(".")[0]);
		if (Number.isInteger(major)) config.roadmapMajorPin = major;
	}
	config.admissionGate = false;
	config.alwaysLoaded = ["CLAUDE.md", "AGENTS.md", ".claude/workflow-core.md"];
	return formatConfigJson(config);
}

/**
 * @param {{founder: string, project: string, commands: Record<string, string|null>}} at
 */
function renderClaudeMd({ founder, project, commands }) {
	const declared = COMMANDS.filter((c) => commands[c]).map(
		(c) => `- \`${commands[c]}\` — the repo's ${c.replace("_", " ")} command.`,
	);
	return substitute(readTemplate("CLAUDE.md"), {
		founder,
		project,
		commands:
			declared.length > 0
				? declared.join("\n")
				: "<!-- None declared: `.claude/workflow-core.json` has no `commands`, so every command-gated check skips. -->",
	});
}

const renderAgentsMd = () => readTemplate("AGENTS.md");

/** @param {{project: string, date: string}} at */
const renderDocMap = ({ project, date }) =>
	substitute(readTemplate("doc-map.md"), { project, date });

/** @param {{project: string}} at */
const renderCodeStandards = ({ project }) =>
	substitute(readTemplate("code-standards.md"), { project });

/** @param {{founder: string}} at */
const renderCalledCards = ({ founder }) =>
	substitute(readTemplate("called-cards.md"), { founder });

/**
 * @param {{project: string, categories: Record<string, string>, version: string, stamp: string}} at
 */
function renderRoadmap({ project, categories, version, stamp }) {
	const areas = Object.entries(
		Object.keys(categories).length > 0 ? categories : { core: "Core" },
	)
		.map(([k, v]) => `  ${k}:${JSON.stringify(v)}`)
		.join(",\n");
	return substitute(readTemplate("reference-roadmap.html"), {
		project,
		areas,
		version,
		stamp,
	});
}

const LOCAL_HOOKS = ["pre-commit", "commit-msg"];

const NO_CORE_FIX =
	"Fix: open a Claude Code session in this repo so its project-scope workflow-core plugin installs, or set WORKFLOW_CORE_DIR to a workflow-core checkout.";

/** @param {string} hook */
function renderHookShim(hook) {
	const failOpen = FAIL_OPEN_HOOKS.has(hook);
	const consequence = failOpen
		? `workflow-core's ${hook} checks did not run.`
		: "refused: no workflow-core resolves to run this repo's gates.";
	return `#!/usr/bin/env sh
${SHIM_MARK}

set -e # lucmoseley/workflow-core-tracker#745
WFC_PLUGIN_ROOT="$(node -e '${RESOLVE_CORE_SCRIPT}' </dev/null)" || {
  echo ${shellQuote(`${hook}: ${consequence} ${NO_CORE_FIX}`)} >&2
  exit ${failOpen ? 0 : 1}
}
export WFC_PLUGIN_ROOT
exec sh -e "$WFC_PLUGIN_ROOT/.husky/"${shellQuote(hook)} "$@"
`;
}

const HOOK_ROOT_LINE = /^WFC_PLUGIN_ROOT=(.*)$/m;

/**
 * @param {string} text
 * @returns {string|null}
 */
function hookRootOf(text) {
	if (isHookShim(text)) return null;
	const value = HOOK_ROOT_LINE.exec(text)?.[1];
	if (value === undefined) return null;
	return value.trim().replace(/^"(.*)"$/, "$1");
}

const HOOKS = [
	"pre-commit",
	"prepare-commit-msg",
	"commit-msg",
	"pre-merge-commit",
	"pre-applypatch",
	"post-commit",
	"post-merge",
	"post-checkout",
	"pre-push",
];

const SECRET_DENIES = [
	"Read(./.env)",
	"Read(./.env.*)",
	"Read(./**/*.pem)",
	"Read(~/.config/workflow-core/**)",
	"Bash(cat ~/.ssh/*)",
	"Bash(cat ~/.config/gh/*)",
	"Bash(cat ~/.config/workflow-core/*)",
	"Bash(cat .env*)",
	"Bash(gh auth token*)",
];

/**
 * @param {{marketplace: string, source: object, plugin: string, outputStyle: string|null}} at
 * @param {Record<string, unknown>} [existing]
 * @returns {{permissions: {deny: string[]} & Record<string, unknown>,
 *   env: Record<string, unknown>, autoCompactWindow: unknown,
 *   autoMemoryEnabled: unknown,
 *   worktree: Record<string, unknown>,
 *   outputStyle: unknown, extraKnownMarketplaces: Record<string, unknown>,
 *   enabledPlugins: Record<string, boolean>} & Record<string, unknown>}
 */
function settingsKeys(
	{ marketplace, source, plugin, outputStyle },
	existing = {},
) {
	const env = /** @type {Record<string, unknown>} */ (existing.env ?? {});
	const permissions = /** @type {{deny?: string[]}} */ (
		existing.permissions ?? {}
	);
	const worktree = /** @type {{bgIsolation?: unknown}} */ (
		existing.worktree ?? {}
	);
	return {
		...existing,
		permissions: {
			...permissions,
			deny: [...new Set([...(permissions.deny ?? []), ...SECRET_DENIES])],
		},
		env: { ...env, CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "1" },
		autoCompactWindow: existing.autoCompactWindow ?? 320_000,
		autoMemoryEnabled: existing.autoMemoryEnabled ?? false,
		worktree: {
			...worktree,
			bgIsolation: worktree.bgIsolation ?? "none",
		},
		outputStyle:
			outputStyle ??
			(existing.outputStyle === "core-voice"
				? undefined
				: existing.outputStyle) ??
			namespaced(plugin, CORE_STYLE),
		extraKnownMarketplaces: {
			.../** @type {object} */ (existing.extraKnownMarketplaces ?? {}),
			[marketplace]: { source },
		},
		enabledPlugins: {
			...withoutSelfPlugin(
				/** @type {Record<string, boolean>} */ (existing.enabledPlugins ?? {}),
			),
			[`${plugin}@${marketplace}`]: true,
		},
	};
}

/**
 * @param {{modules: Module[], categories: Record<string, string>,
 *   ciWorkflow: boolean}} at
 * @returns {{name: string, color: string, description: string}[]}
 */
function labelPlan({ modules, categories, ciWorkflow }) {
	const on = new Set(modules);
	const labels = [...CORE_LABELS];
	if (on.has("governance")) labels.push(GATED_LABELS["manual-finding"]);
	if (ciWorkflow) labels.push(GATED_LABELS["ci-red"]);
	for (const [key, title] of Object.entries(categories)) {
		labels.push({
			name: key,
			color: "BFD4F2",
			description: `Category: ${title}. One per \`categories\` key in .claude/workflow-core.json.`,
		});
	}
	return labels;
}

/** @type {{name: string, color: string, description: string}[]} */
const CORE_LABELS = [
	{
		name: "takes:wayfinder",
		color: "1d76db",
		description:
			"An open question whose resolution is a decision. /wayfinder <n>.",
	},
	{
		name: "takes:to-spec",
		color: "1d76db",
		description:
			"A chunk large enough to need a spec before tickets. /to-spec <n>.",
	},
	{
		name: "takes:to-tickets",
		color: "1d76db",
		description: "A spec ready to break into tickets. /to-tickets <n>.",
	},
	{
		name: "takes:implement",
		color: "1d76db",
		description: "A specified unit of work. /implement <n>.",
	},
	{
		name: "takes:triage",
		color: "1d76db",
		description: "Disposition not yet decided. /triage <n>.",
	},
	{
		name: "takes:human",
		color: "5319e7",
		description: "Done outside Claude Code entirely.",
	},
	{
		name: "takes:children",
		color: "5319e7",
		description:
			"A container: every remaining action sits on its open sub-issues. Open a child, not this.",
	},
	{
		name: "kind:spec",
		color: "5319E7",
		description: "A spec/PRD — parent document, not a unit of work",
	},
	{
		name: "kind:ticket",
		color: "0052CC",
		description: "A unit of implementable work, broken out of a spec",
	},
	{
		name: "kind:brief",
		color: "0E8A16",
		description:
			"A hand-off ticket a many-destination map files per deliverable, awaiting its spec",
	},
	{
		name: "wayfinder:map",
		color: "0E4B99",
		description: "Wayfinder map (root issue)",
	},
	{
		name: "wayfinder:research",
		color: "1D76DB",
		description: "Wayfinder ticket: research (AFK)",
	},
	{
		name: "wayfinder:prototype",
		color: "5319E7",
		description: "Wayfinder ticket: prototype (HITL)",
	},
	{
		name: "wayfinder:grilling",
		color: "B60205",
		description: "Wayfinder ticket: grilling (HITL)",
	},
	{
		name: "wayfinder:task",
		color: "0E8A16",
		description: "Wayfinder ticket: task",
	},
	{
		name: "waiting:external",
		color: "FBCA04",
		description:
			"Handed off outside the project; selection ranks it up once the wait reaches 7 days.",
	},
	{
		name: "parked",
		color: "FEF2C0",
		description:
			"Waits on the founder; an away-mode refill loop skips it, a normal-mode one resumes it first.",
	},
	{
		name: WATCH_CLOSED_LABEL,
		color: "D4C5F9",
		description:
			"A closed issue whose Gated on: check the gate sweep still runs; a met reading reopens it.",
	},
	{
		name: URGENT_LABEL,
		color: "D93F0B",
		description:
			"Jumps the selection queue, for every descendant and blocker. Holds until closed or removed.",
	},
	{
		name: "measured:effort-low",
		color: "C5DEF5",
		description:
			"Implemented by a session at Opus --effort low. Provenance, not state; nothing routes on it.",
	},
	...ORIGIN_LABELS,
	{
		name: SIGNATURE_LABEL,
		color: "C5DEF5",
		description:
			"Owes a line in docs/data/outcome-signatures.jsonl on main. Provenance; nothing routes on it.",
	},
];

const GATED_LABELS = {
	"manual-finding": {
		name: "manual-finding",
		color: "C2E0C6",
		description:
			"A finding wider than one settled fact, for the next full operating-manual sync to read.",
	},
	"ci-red": {
		name: "ci-red",
		color: "B60205",
		description: "A red scheduled suite or workflow, filed by the sweep.",
	},
};

const TOOLS = [
	"shellcheck",
	"actionlint",
	"ruff",
	"jq",
	"gitleaks",
	"gh",
	"playwright",
];

const HELPERS = ["scripts/browse.py", "scripts/lib/resolve-core.js"];
const COPIES_IF_HELD = ["scripts/lib/resolve_core.py"];

const IGNORE_BEGIN = "# workflow-core:begin";
const IGNORE_END = "# workflow-core:end";
const IGNORED = [".claude/tmp/", ".claude/worktrees/", "/private/"];

/** @type {[string, string][]} */
const IGNORE_MARKERS = [
	[IGNORE_BEGIN, IGNORE_END],
	[
		"# --- workflow-core: paths the core's rules assume are untracked (init-adopter.js) ---",
		"# --- end workflow-core ignores ---",
	],
];

/**
 * @param {string} text
 * @param {string[]} lines
 */
const appendLines = (text, lines) =>
	`${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`;

/**
 * @param {string} text
 * @param {string[]} [lines]
 * @returns {string|null}
 */
function withIgnoreBlock(text, lines = IGNORED) {
	const block = [IGNORE_BEGIN, ...lines, IGNORE_END];
	const rows = text.split("\n");
	const bare = rows.map((row) => row.replace(/\r$/, ""));
	for (const [open, close] of IGNORE_MARKERS) {
		const start = bare.indexOf(open);
		const end = start === -1 ? -1 : bare.indexOf(close, start + 1);
		if (end === -1) continue;
		const next = [
			...rows.slice(0, start),
			...block,
			...rows.slice(end + 1),
		].join("\n");
		return next === text ? null : next;
	}
	return appendLines(text, block);
}

/**
 * @param {string} text
 * @returns {{body: string|null, kept: boolean}}
 */
function withStatusScript(text) {
	const body = text.replace(/^\uFEFF/, "");
	const manifest = JSON.parse(body);
	const scripts = manifest?.scripts ?? {};
	if (!isObject(manifest) || !isObject(scripts))
		throw new Error("it or its `scripts` is not a JSON object");
	const own = scripts.status;
	if (own !== undefined) return { body: null, kept: own !== STATUS_SCRIPT };
	const [, eol = "\n", indent] = body.match(/^\s*\{(\r?\n)([ \t]*)/) ?? [];
	const next = { ...manifest, scripts: { ...scripts, status: STATUS_SCRIPT } };
	return {
		body: `${JSON.stringify(next, null, indent || "  ")}\n`.replace(/\n/g, eol),
		kept: false,
	};
}

module.exports = {
	renderSessionRules,
	renderReference,
	describePluginRecord,
	renderPluginRecord,
	recordedUrlSha,
	renderConfig,
	renderClaudeMd,
	renderAgentsMd,
	withIgnoreBlock,
	withStatusScript,
	STATUS_SCRIPT,
	appendLines,
	renderDocMap,
	renderCodeStandards,
	renderCalledCards,
	renderRoadmap,
	renderHookShim,
	NO_CORE_FIX,
	RULES_FILE,
	REFERENCE_FILE,
	CORE_OWNED,
	PROVENANCE_HEADING,
	settingsKeys,
	labelPlan,
	HOOKS,
	LOCAL_HOOKS,
	hookRootOf,
	HELPERS,
	COPIES_IF_HELD,
	TOOLS,
};
