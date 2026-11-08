/*
 * implement-carveout.js — the /implement carve-out matcher used to measure
 * how many Opus /implement sessions committed to repo machinery rather than
 * product code (mantahostels#1334, mantahostels#2462).
 *
 * THIS IS THE MEASUREMENT MATCHER, NOT §6'S ROUTING RULE. §6 of
 * .claude/skills/pick-next/SKILL.md decides, ahead of a launch, which model an
 * /implement session should run on — and the founder ruled `.claude/skills/*`
 * OUT of that routing carve-out (mantahostels#1334 Q3). This module asks a different,
 * retrospective question — did an ALREADY-Opus session's own commit touch
 * repo machinery rather than product code, when judging whether that
 * historical launch was a genuine miss — so widening it here does not reopen
 * or contradict the routing ruling.
 *
 * The rules below widen mantahostels#1334's original eight-substring hard list to the
 * eight candidates mantahostels#2449's by-subject census named (mantahostels#2462's own acceptance
 * criteria: see the ticket and `.claude/tmp/scan-2449-bysubject.md` for the
 * evidence).
 *
 * `scripts/lib/*guard*` is widened here to ALL of `scripts/lib/`, which holds
 * nothing but check/guard/arbiter/doc-map support code by directory
 * convention — no product path has ever lived there. This is NOT extended to
 * `docs/research/`, which mixes genuine business/legal research with
 * repo-machinery notes, so widening it wholesale would carve out exactly the
 * false positives mantahostels#2462 exists to remove.
 *
 * RESIDUAL, STATED RATHER THAN PAPERED OVER, NOT CLOSED BY THIS WIDENING:
 * most of mantahostels#2449's flagged population carries NO commit captured in the
 * transcript at all — no width of path list can ever classify a session this
 * scan cannot see a commit for. mantahostels#2462's AC2 is UNMET as filed (see the ticket
 * for the figures and the open question that leaves).
 */

const { requiredGroup } = require("./regex-group.js");
const { mainChainRecords } = require("./transcript.js");

/* How far into a transcript the first <command-name> block is looked for —
 * same cap and same tradeoff as check-pick-next-model.js:99 (HEAD_BYTES),
 * copied rather than shared because that module's is tuned to a 7-day /pick-
 * next window and this one is not. A transcript capped without a command name
 * is reported CAPPED rather than silently read as "not /implement". */
const HEAD_BYTES = 1024 * 1024;

const COMMAND_RE =
	/<command-name>\s*(?:\/\s*)?([a-zA-Z0-9_:-]+)\s*<\/command-name>/;

/**
 * @typedef {{ name: string, test: (path: string) => boolean }} Rule
 * @typedef {Record<string, any>} TranscriptRecord
 *   a parsed transcript line, untyped because `mainChainRecords` yields it
 *   untyped: its fields vary by record type and Claude Code version
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
	/* Widened at mantahostels#2462, on mantahostels#2449's by-subject census: */
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

/* Unchanged by mantahostels#2462 — mantahostels#1334 Q3 kept these as the "adjacent" tier rather than
 * hard carve-out, and the ticket did not ask this tier to move. */
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
 * The first rule in `list` any of `paths` matches, or `null`.
 *
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
 * Whether any committed path is repo machinery under the widened hard list.
 *
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
 * Whether any committed path is one of the two "adjacent" paths (mantahostels#1334 Q3).
 *
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
 * Pull every committed pathspec out of a set of `git commit` Bash command
 * strings — CLAUDE.md's mandated `git commit -m "…" -- <paths>` shape.
 *
 * Takes everything after the FIRST `-- ` on the first line that has one, to
 * end of that line, split on whitespace, quotes stripped — mantahostels#2449's
 * `scan2449.py` rule, kept identical so this module reproduces mantahostels#2449's own
 * findings rather than a subtly
 * different reading of the same transcripts.
 *
 * @param {string[]} commitCommands raw Bash tool `input.command` strings
 *   containing "git commit"
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
 * @returns {number|null}  the record's timestamp, null where it has none that parses
 */
function startOf(record) {
	if (typeof record.timestamp !== "string") return null;
	const t = Date.parse(record.timestamp);
	return Number.isNaN(t) ? null : t;
}

/**
 * @param {unknown} model  an assistant message's `model`
 * @returns {"opus"|"sonnet"|null}  opus where the name carries both
 */
function familyOf(model) {
	if (typeof model !== "string" || !model) return null;
	const l = model.toLowerCase();
	if (l.includes("opus")) return "opus";
	if (l.includes("sonnet")) return "sonnet";
	return null;
}

/**
 * @param {unknown} content  an assistant message's `content`
 * @returns {string[]}  each Bash tool call's command that runs `git commit`
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
 * @param {Set<"opus"|"sonnet">} families  every family the session's turns ran on
 * @returns {"opus"|"sonnet"|"mixed"|"unknown"}
 */
function tierOf(families) {
	if (families.has("opus") && families.has("sonnet")) return "mixed";
	if (families.has("opus")) return "opus";
	if (families.has("sonnet")) return "sonnet";
	return "unknown";
}

/**
 * A session's command, model tier, every path its own `git commit` Bash
 * calls named, when it started, and whether the head read was capped before
 * a `<command-name>` block turned up.
 *
 * A record whose `timestamp` will not parse is skipped for start-time
 * purposes rather than treated as "started now" — the caller decides what an
 * unparseable start means for its window, this function only reports it as
 * `startedAt: null`.
 *
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
