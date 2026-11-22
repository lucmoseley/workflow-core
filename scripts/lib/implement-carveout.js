const { requiredGroup } = require("./regex-group.js");
const { mainChainRecords } = require("./transcript.js");

// measured 7 files capped at 1 MiB against 58 at 256 kB, #362
const HEAD_BYTES = 1024 * 1024;

const COMMAND_RE =
	/<command-name>\s*(?:\/\s*)?([a-zA-Z0-9_:-]+)\s*<\/command-name>/;

/**
 * @typedef {{ name: string, test: (path: string) => boolean }} Rule
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 */

/** @type {Rule[]} */
const HARD_LIST = [
	{ name: "scripts/guard-*", test: (p) => p.includes("scripts/guard-") },
	{ name: ".husky/*", test: (p) => p.includes(".husky/") },
	{ name: "CLAUDE.md", test: (p) => p.includes("CLAUDE.md") },
	{ name: "AGENTS.md", test: (p) => p.includes("AGENTS.md") },
	{
		name: "docs/working-contract.md",
		test: (p) => p.includes("docs/working-contract.md"),
	},
	{ name: "docs/doc-map.md", test: (p) => p.includes("docs/doc-map.md") },
	{
		name: ".claude/settings.json",
		test: (p) => p.includes(".claude/settings.json"),
	},
	{
		name: "scripts/session-arbiter*",
		test: (p) => p.includes("scripts/session-arbiter"),
	},
	{
		name: "scripts/lib/*",
		test: (p) => p.includes("scripts/lib/"),
	},
	{
		name: "scripts/check-*.js",
		test: (p) => /(^|\/)scripts\/check-[^/]+\.(js|ts)$/.test(p),
	},
	{ name: "docs/agents/*", test: (p) => p.includes("docs/agents/") },
	{
		name: "docs/*.json",
		test: (p) => /(^|\/)docs\/[^/]+\.json$/.test(p),
	},
	{
		name: "docs/environment.md",
		test: (p) => p.includes("docs/environment.md"),
	},
	{ name: ".claude/skills/*", test: (p) => p.includes(".claude/skills/") },
	{
		name: ".github/workflows/*",
		test: (p) => p.includes(".github/workflows/"),
	},
];

/** @type {Rule[]} */
const ADJACENT_LIST = [
	{
		name: ".claude/settings.json",
		test: (p) => p.includes(".claude/settings.json"),
	},
	{
		name: "scripts/session-arbiter*",
		test: (p) => p.includes("scripts/session-arbiter"),
	},
];

/**
 * @param {string[]} paths
 * @param {Rule[]} list
 * @returns {{ path: string, rule: string } | null}
 */
function firstMatch(paths, list) {
	for (const p of paths) {
		for (const rule of list) {
			if (rule.test(p)) return { path: p, rule: rule.name };
		}
	}
	return null;
}

/**
 * @param {string[]} paths
 * @returns {{ hit: boolean, path: string | null, rule: string | null }}
 */
function isHardCarveOut(paths) {
	const m = firstMatch(paths, HARD_LIST);
	return m
		? { hit: true, path: m.path, rule: m.rule }
		: { hit: false, path: null, rule: null };
}

/**
 * @param {string[]} paths
 * @returns {{ hit: boolean, path: string | null, rule: string | null }}
 */
function isAdjacent(paths) {
	const m = firstMatch(paths, ADJACENT_LIST);
	return m
		? { hit: true, path: m.path, rule: m.rule }
		: { hit: false, path: null, rule: null };
}

const PATHSPEC_TAIL_RE = /--\s+(\S.*)$/m;

/**
 * @param {string[]} commitCommands
 * @returns {string[]}
 */
function extractCommitPaths(commitCommands) {
	/** @type {string[]} */
	const paths = [];
	for (const cmd of commitCommands) {
		const m = PATHSPEC_TAIL_RE.exec(cmd);
		if (!m) continue;
		for (const tok of requiredGroup(m, 1, PATHSPEC_TAIL_RE).split(/\s+/)) {
			const trimmed = tok.replace(/^['"]|['"]$/g, "");
			if (trimmed) paths.push(trimmed);
		}
	}
	return paths;
}

/**
 * @param {TranscriptRecord} record
 * @returns {number|null}
 */
function startOf(record) {
	if (typeof record.timestamp !== "string") return null;
	const t = Date.parse(record.timestamp);
	return Number.isNaN(t) ? null : t;
}

/**
 * @param {unknown} model
 * @returns {"opus"|"sonnet"|null}
 */
function familyOf(model) {
	if (typeof model !== "string" || !model) return null;
	const l = model.toLowerCase();
	if (l.includes("opus")) return "opus";
	if (l.includes("sonnet")) return "sonnet";
	return null;
}

/**
 * @param {unknown} content
 * @returns {string[]}
 */
function commitCommandsIn(content) {
	if (!Array.isArray(content)) return [];
	/** @type {string[]} */
	const commands = [];
	for (const block of content) {
		if (block?.type !== "tool_use" || block.name !== "Bash") continue;
		const cmd = block.input?.command;
		if (typeof cmd === "string" && cmd.includes("git commit"))
			commands.push(cmd);
	}
	return commands;
}

/**
 * @param {Set<"opus"|"sonnet">} families
 * @returns {"opus"|"sonnet"|"mixed"|"unknown"}
 */
function tierOf(families) {
	if (families.has("opus") && families.has("sonnet")) return "mixed";
	if (families.has("opus")) return "opus";
	if (families.has("sonnet")) return "sonnet";
	return "unknown";
}

/**
 * @param {string} text
 * @returns {{ command: string | null, model: "opus"|"sonnet"|"mixed"|"unknown", paths: string[], startedAt: number | null, capped: boolean }}
 */
function scanSession(text) {
	let command = null;
	/** @type {number|null} */
	let startedAt = null;
	/** @type {Set<"opus"|"sonnet">} */
	const families = new Set();
	/** @type {string[]} */
	const commitCommands = [];

	const head = text.slice(0, HEAD_BYTES);
	const m = COMMAND_RE.exec(head);
	if (m) command = requiredGroup(m, 1, COMMAND_RE);
	const capped = !m && head.length >= HEAD_BYTES;

	for (const record of mainChainRecords(text, "main")) {
		if (startedAt === null) startedAt = startOf(record);
		if (record.type !== "assistant") continue;
		const message = record.message || {};
		const family = familyOf(message.model);
		if (family) families.add(family);
		commitCommands.push(...commitCommandsIn(message.content));
	}

	return {
		command,
		model: tierOf(families),
		paths: extractCommitPaths(commitCommands),
		startedAt,
		capped,
	};
}

module.exports = {
	isHardCarveOut,
	isAdjacent,
	scanSession,
};
