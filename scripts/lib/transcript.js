/*
 * transcript.js — reading a Claude Code session's own JSONL transcript.
 *
 * The seam behind scripts/session-context.js (what a session is carrying right
 * now) and scripts/measure-bundle-cost.js (what whole sessions have cost),
 * which agreed byte-for-byte on how to read a transcript before mantahostels#1094 factored
 * the agreement out; the retro scripts share its content and subagent-path
 * readers (#1055). It exists so the parsing can be asserted in-process, the
 * CLIs staying black-box subprocesses (§X3).
 *
 * STANDING CONTEXT is fresh input + cache write + cache read on an assistant
 * turn — what the model was actually sent, and the quantity spend tracks
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/allowance-burn-measurement.md, mantahostels#830: spend is
 * `turns x standing context`).
 *
 * SIDECHAIN TURNS ARE A SUBAGENT'S CONTEXT, NOT THE SESSION'S — but which
 * "session" that means depends on the FILE. A main session's transcript
 * carries the occasional sidechain record inline, and a reader building that
 * session's own chain skips them. A subagent's transcript is a separate file
 * under that session's `subagents/` directory, and EVERY record in it carries
 * `isSidechain: true` — relative to the parent, not to itself. Skipping
 * `isSidechain` there leaves nothing: the subagent's whole chain, read as
 * empty. `mainChainRecords` takes an explicit tier for exactly this reason.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {object} Usage
 * @property {number} [input_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [cache_read_input_tokens]
 * @property {number} [output_tokens]
 */

/**
 * What the model was sent for one turn.
 * @param {Usage} usage
 * @returns {number}
 */
function standingContext(usage) {
	return (
		(usage.input_tokens || 0) +
		(usage.cache_creation_input_tokens || 0) +
		(usage.cache_read_input_tokens || 0)
	);
}

/**
 * Whether `file` is a subagent's own transcript rather than a main session's:
 * written under that session's `subagents/` directory (`agent-*.jsonl`), one
 * file per dispatched subagent, distinct from the top-level `<sessionId>.jsonl`
 * files `findTranscript` looks up. Path-based, not content-sniffed — every
 * record in a subagent file sets `isSidechain: true` regardless of tier, so
 * content alone cannot tell the two apart from a single line.
 *
 * RESIDUAL (mantahostels#1779): a bare segment match, so a path with an unrelated
 * directory literally named `subagents` would misclassify. Every path this
 * repo constructs comes from the harness's own project-directory layout, so
 * that has never happened; a caller reading an arbitrary path should not
 * assume it can't.
 *
 * @param {string} file
 * @returns {boolean}
 */
function isSubagentTranscript(file) {
	return file.split(path.sep).includes("subagents");
}

/**
 * The directory holding a main session's subagent transcripts.
 * @param {string} mainFile  `<sessionId>.jsonl`
 */
function subagentDirOf(mainFile) {
	return path.join(mainFile.replace(/\.jsonl$/, ""), "subagents");
}

/* A Stop hook's refusal of the turn before it, as the harness writes it into
 * a user record's text. */
const STOP_FEEDBACK = /^\s*Stop hook feedback/;

/**
 * The text of a message's or tool result's content, string or blocks: text
 * blocks, and `[image]` for each image, joined by a space.
 * @param {unknown} content
 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (b?.type === "text" && typeof b.text === "string") return b.text;
			if (b?.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

/**
 * Every main-chain record in a transcript, in order.
 *
 * A transcript is appended to while it is being read, so the final line can be
 * half-written; a line that will not parse is skipped rather than thrown on. A
 * reader that died on one would report nothing at all, which for every caller
 * is worse than reporting a figure one turn stale.
 *
 * `tier` picks what "main chain" means for this file (`isSubagentTranscript`
 * decides it): `"main"` skips a record marked `isSidechain` — a subagent's
 * turn embedded inline — same as always. `"subagent"` skips nothing: every
 * record in a subagent's own file carries `isSidechain: true` relative to its
 * parent, and here that IS the chain. There is no default — a caller that
 * passes neither gets a thrown error, not a silent empty iterator, which is
 * the bug mantahostels#1779 filed this fix against.
 *
 * `stats`, where a caller passes one, gets `stats.skipped` incremented once
 * per unparseable line — opt-in, because most callers only ever consume the
 * iterator with a `for...of` and have nowhere to put a count even if one were
 * pushed on them (mantahostels#3307).
 *
 * WHO PASSES ONE, AND WHY THE REST DO NOT (mantahostels#3311). AN UNPARSEABLE LINE IS
 * PERSISTENT CORRUPTION, NOT A LIVE TAIL — the half-written line above is the
 * mechanism, but not what the corpus holds: four lines in 2.5 million records
 * here, and a second pass reads the same four. So a re-read does not recover
 * one, and no message may promise that it will.
 *
 * The decline rests on that rarity alone, not on the declining callers having
 * nothing to lose — `lib/implement-carveout.js` classifies off the whole text,
 * so one dropped record holding a session's only `git commit` would flip that
 * session's carve-out, and `check-pick-next-model.js` takes its command from the
 * file's head but its tier and cost from the whole of it.
 *
 * That leaves two callers where naming it changes what a reader does, and both
 * pass one: `lost-deny-rates.js`, which reports it in `render()` and `--json`
 * because a census that quietly under-reads is a census nobody can check; and
 * `guard-lost-deny.js`, which reads its own session's transcript at Stop, where
 * a missed line is a missed deny and `replay`'s "not a tool call in this file"
 * would otherwise read as a mistyped id rather than an incomplete read.
 *
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @param {{skipped: number}} [stats] accumulator: counts each line that does not parse
 * @returns {Generator<Record<string, any>>}
 */
function* mainChainRecords(text, tier, stats) {
	if (tier !== "main" && tier !== "subagent")
		throw new TypeError(
			`mainChainRecords needs tier "main" or "subagent", got ${JSON.stringify(tier)}.`,
		);
	for (const line of text.split("\n")) {
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			if (stats) stats.skipped++;
			continue;
		}
		if (tier === "main" && record.isSidechain) continue;
		yield record;
	}
}

/**
 * The standing context of the last assistant turn, and when it was sent.
 * `null` where the transcript carries no assistant turn with a usage record —
 * which callers must never render as a low figure.
 *
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {{ tokens: number, at: string | null } | null}
 */
function lastStandingContext(text, tier) {
	let last = null;
	for (const record of mainChainRecords(text, tier)) {
		if (record.type !== "assistant") continue;
		const usage = record.message?.usage;
		if (!usage) continue;
		const tokens = standingContext(usage);
		if (tokens > 0) last = { tokens, at: record.timestamp || null };
	}
	return last;
}

/**
 * How many turns the session has taken: distinct assistant responses carrying a
 * usage record.
 *
 * DEDUPLICATED BY `requestId` (mantahostels#2601). One API response is written to the
 * transcript as several records — a text block and each tool_use block get a
 * line apiece — and every one of them repeats the same `message.usage`.
 *
 * A record with no `requestId` counts once on its own `uuid`, and one carrying
 * neither counts once unkeyed: an older transcript, or a synthetic record,
 * should not collapse into one turn with every other record that also lacks the
 * field.
 *
 * THE ~2x IS RECORDS, NOT TOOL CALLS (mantahostels#2618). A raw transcript sweep counting
 * assistant records reads a median 2.00x this figure; a TOOL-CALL count reads
 * ~1.0x it. So a tool-call figure is directly comparable and a record figure is
 * not — check which before calibrating a band against it.
 *
 * IT IS A FLOOR. The last usage record describes the request
 * already made, so the count is one turn stale exactly as `lastStandingContext`
 * is; and `lib/session-transcript.js` reads only the tail of a transcript over
 * 16 MB, so a very long session's count is taken from the tail alone.
 *
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {number}
 */
function countTurns(text, tier) {
	const seen = new Set();
	let unkeyed = 0;
	for (const { key } of turnRecords(text, tier)) {
		if (key) seen.add(key);
		/* Collapsing unkeyed records into one — which a shared `uuid:undefined` key
		 * would — undercounts, and this band already errs late. */ else
			unkeyed += 1;
	}
	return seen.size + unkeyed;
}

/**
 * Every assistant record `countTurns` counts, in transcript order, each with
 * the usage it carries and the key it deduplicates on — `null` where it has
 * neither a `requestId` nor a `uuid` and so counts once unkeyed.
 *
 * `scripts/measure-turn-band.js` (mantahostels#2618) walks the same records `countTurns`
 * does, and on this key rather than a restatement of it, so the measurement
 * cannot drift from the band it prices.
 *
 * `record` is the parsed transcript line, typed as loosely as `mainChainRecords`
 * yields it — a transcript is an external format this repo does not define, so
 * a narrower type here would assert a shape nothing guarantees.
 *
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {Generator<{record: Record<string, any>, usage: Usage,
 *   key: string | null}>}
 */
function* turnRecords(text, tier) {
	for (const record of mainChainRecords(text, tier)) {
		if (record.type !== "assistant") continue;
		const usage = record.message?.usage;
		/* The same test `lastStandingContext` applies, so the two readings the
		 * ceiling guard combines agree on what a turn is. */
		if (!usage || standingContext(usage) <= 0) continue;
		let key = null;
		if (record.requestId) key = `req:${record.requestId}`;
		else if (record.uuid) key = `uuid:${record.uuid}`;
		yield { record, usage, key };
	}
}

/**
 * A key for each autocompaction the transcript records: a `compact_boundary`
 * system record (#1032).
 *
 * A boundary whose `compactMetadata.trigger` is `"manual"` is a `/compact`
 * someone typed, not an overrun, and is left out; one carrying no trigger
 * counts. The key is its `uuid`, else its timestamp, else nothing — a keyless
 * boundary cannot be told from itself on the next read, so it is dropped
 * rather than counted twice.
 *
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {string[]}
 */
function autocompactions(text, tier) {
	const keys = [];
	for (const record of mainChainRecords(text, tier)) {
		if (record.type !== "system" || record.subtype !== "compact_boundary")
			continue;
		if (record.compactMetadata?.trigger === "manual") continue;
		const key = record.uuid || record.timestamp;
		if (key) keys.push(String(key));
	}
	return keys;
}

/**
 * The transcript file for one session id, or `null`.
 *
 * The file sits under one of the config dir's project directories, named for
 * the project path. Rather than reproduce that slugging — and get it wrong on
 * a path holding a dot — look it up by session id across all of them.
 *
 * RESIDUAL: only ever the top-level `<sessionId>.jsonl`, never a subagent's
 * own file — a subagent's records carry its PARENT's `sessionId`, so lookup
 * by session id cannot pick out one of possibly several subagent files under
 * that session's `subagents/` directory; an `agentId` would be needed. A
 * caller that already has the exact path (e.g. a hook payload's
 * `transcript_path`) is unaffected — this is only the sessionId-keyed lookup.
 *
 * @param {string} configDir
 * @param {string} sessionId
 * @returns {string | null}
 */
function findTranscript(configDir, sessionId) {
	const root = path.join(configDir, "projects");
	let projects;
	try {
		projects = fs.readdirSync(root);
	} catch {
		return null;
	}
	for (const project of projects) {
		const file = path.join(root, project, `${sessionId}.jsonl`);
		if (fs.existsSync(file)) return file;
	}
	return null;
}

module.exports = {
	standingContext,
	isSubagentTranscript,
	subagentDirOf,
	contentText,
	STOP_FEEDBACK,
	mainChainRecords,
	lastStandingContext,
	countTurns,
	turnRecords,
	autocompactions,
	findTranscript,
};
