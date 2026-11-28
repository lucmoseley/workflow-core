#!/usr/bin/env node
// #5865
const fs = require("node:fs");
const path = require("node:path");
const hookBlock = require("./lib/hook-block");
const { readFdAll } = require("./lib/read-fd.js");
const { markersDir } = require("./lib/marker-root");
const sessionTranscript = require("./lib/session-transcript");
const {
	PENDING_PREFIX,
	recordCompactions,
	buildCompactionSentence,
	compactionAdvice,
} = require("./lib/compaction-set");
const { buildStateFile } = require("./lib/build-state");
const { readClaimedIssues } = require("./lib/arbiter-issue-claims");
const { isSubagentPayload } = require("./lib/subagent-payload");
const { autocompactions } = require("./lib/transcript");
const { caught, ignoreFailure } = require("./lib/caught.js");
const { envelope } = require("./lib/hook-envelope.js");
const { writeFd } = require("./lib/write-fd.js");

const TRIGGER_PREFIX = ".compaction-trigger-";

/** @param {string} what @param {unknown} err */
function logFailOpen(what, err) {
	ignoreFailure(() =>
		require("./lib/arbiter-core").logError(
			`inject-compaction-count ${what}`,
			err,
		),
	);
}

/** @param {string} sid */
const triggerFile = (sid) =>
	path.join(markersDir(hookBlock.repoRoot()), TRIGGER_PREFIX + sid);

/**
 * @param {string} sid
 * @returns {string | null}
 */
function takeTrigger(sid) {
	const file = triggerFile(sid);
	let trigger;
	try {
		trigger = fs.readFileSync(file, "utf8").trim();
	} catch (err) {
		if (caught(err).code !== "ENOENT")
			logFailOpen("trigger marker unreadable", err);
		return null;
	}
	try {
		fs.unlinkSync(file);
	} catch (err) {
		logFailOpen("trigger marker undeletable", err);
	}
	return trigger;
}

/**
 * @param {{transcript_path?: string}} payload
 * @param {string} sid
 * @returns {string}
 */
function afterCompaction(payload, sid) {
	const trigger = takeTrigger(sid);
	if (trigger === null || trigger === "manual") return "";
	const file = sessionTranscript.resolve(payload, sid);
	if (!file) {
		logFailOpen("transcript", new Error("not found"));
		return "";
	}
	let earlier;
	try {
		earlier = autocompactions(sessionTranscript.read(file), "main");
	} catch (err) {
		logFailOpen("transcript unreadable", err);
		return "";
	}
	const pending = `${PENDING_PREFIX}${new Date().toISOString()}`;
	const count = recordCompactions(sid, [...earlier, pending]);
	return `${buildCompactionSentence(count)} ${compactionAdvice(count, unitOf(sid), sid)}`;
}

/**
 * #4562
 * @param {string} sid
 */
function unitOf(sid) {
	/** @type {number[]} */
	let claimed = [];
	try {
		claimed = readClaimedIssues(sid);
	} catch (err) {
		logFailOpen("issue claims unreadable", err);
	}
	for (const issue of claimed) {
		const file = buildStateFile(issue);
		if (fs.existsSync(file)) return { issue, stateFile: file };
	}
	return { issue: claimed[0] ?? null, stateFile: null };
}

/** @param {string} raw */
function main(raw) {
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return;
	}
	const sid = payload?.session_id;
	if (typeof sid !== "string" || !/^[\w-]+$/.test(sid)) return;
	if (isSubagentPayload(payload)) return;

	if (payload.hook_event_name === "PreCompact") {
		try {
			fs.writeFileSync(triggerFile(sid), String(payload.trigger ?? ""));
		} catch (err) {
			logFailOpen("trigger marker unwritable", err);
		}
		return;
	}
	if (
		payload.hook_event_name !== "SessionStart" ||
		payload.source !== "compact"
	)
		return;
	const text = afterCompaction(payload, sid);
	if (text)
		writeFd(
			1,
			JSON.stringify(envelope("SessionStart", { additionalContext: text })),
		);
}

if (require.main === module) {
	try {
		main(readFdAll(0).toString("utf8"));
	} catch (err) {
		logFailOpen("crashed", err);
	}
}
