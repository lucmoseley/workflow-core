#!/usr/bin/env node
/*
 * inject-compaction-count.js — PreCompact and SessionStart (`compact`) hook.
 * Tells the model, once per autocompaction, how many times this session has
 * autocompacted (workflow-core#1148, ruled at workflow-core#1142 Q1 (A)).
 *
 * IN NO §N3 FAMILY: it refuses nothing and checks nothing, and keeps the
 * guard contract — fails open, exits 0.
 *
 * TWO EVENTS, BECAUSE NEITHER SEES BOTH HALVES. `SessionStart` output reaches
 * the model after a compaction, but its payload has no trigger, and its hooks
 * finish before the new `compact_boundary` reaches the transcript. So
 * `PreCompact`, which carries `trigger`, leaves it in a marker, and
 * `SessionStart:compact` reads and deletes it, staying silent on `manual` as
 * `autocompactions` does.
 *
 * THE NEW COMPACTION ENTERS THE SET AS A `pending:` KEY, which the ceiling
 * guard's next Stop settles against the boundary's own key
 * (`lib/compaction-set.js`), so the set holds the announced count throughout.
 * Earlier boundaries the set lacks — a Stop not yet run since one — are read
 * from the transcript tail first.
 *
 * RESIDUAL: the ordering above is measured, not documented. A harness that
 * wrote the boundary before these hooks ran would count it twice, as a
 * boundary and as a pending key, until the guard's next Stop drops the key.
 *
 * A SUBAGENT'S COMPACTION IS TOLD APART ONLY IN PART (workflow-core#1785, workflow-core#1837). Harness
 * 2.1.302 sends both events without `agent_id`, with the parent's session id.
 * `lib/subagent-payload.js` reads most of them on `SessionStart:compact` by
 * transcript freshness; the rest are told the parent's count and to end, and
 * `lib/compaction-set.js` drops the pending key they leave.
 *
 * IMPLICIT:  at every compaction, writes a trigger marker; after one, reads
 *            and deletes it, reads the transcript tail and writes the
 *            compaction set.
 * JUSTIFIED: fail-safe — refuses nothing (workflow-core#1142).
 * DEFEAT:    none; silent on every failure path. A payload that does not
 *            parse or names no session, and a missing trigger marker, are
 *            nothing to report; every other failure is logged to the
 *            guard-error log `npm run check:guard-errors` reads.
 */

const fs = require("node:fs");
const path = require("node:path");
const hookBlock = require("./lib/hook-block");
const { markersDir } = require("./lib/marker-root");
const sessionTranscript = require("./lib/session-transcript");
const {
	PENDING_PREFIX,
	recordCompactions,
	compactionSentence,
	COMPACTION_ADVICE,
} = require("./lib/compaction-set");
const { isSubagentPayload } = require("./lib/subagent-payload");
const { autocompactions } = require("./lib/transcript");
const { caught } = require("./lib/caught.js");

const TRIGGER_PREFIX = ".compaction-trigger-";

/** @param {string} what @param {unknown} err */
function logFailOpen(what, err) {
	try {
		require("./lib/arbiter-core").logError(
			`inject-compaction-count ${what}`,
			err,
		);
	} catch {
		/* A log that cannot be written must not break the hook. */
	}
}

/** @param {string} sid */
const triggerFile = (sid) =>
	path.join(markersDir(hookBlock.repoRoot()), TRIGGER_PREFIX + sid);

/**
 * The trigger PreCompact left, deleted as it is read, or null where none was.
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
 * @returns {string} the model-facing text, or "" for silence
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
	return `${compactionSentence(count)} ${COMPACTION_ADVICE}`;
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
	/* A subagent's payload: its compaction is not this session's. */
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
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: text,
				},
			}),
		);
}

if (require.main === module) {
	try {
		main(fs.readFileSync(0, "utf8"));
	} catch (err) {
		logFailOpen("crashed", err);
	}
}
