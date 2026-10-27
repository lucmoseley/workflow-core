/*
 * scratch-overwrite.js — the dispatcher core that refuses the first `Write`
 * over a `.claude/tmp/` file this session did not write, naming a
 * session-suffixed name; the same call re-sent goes through (#1167;
 * refuse-once, #1728). Its production ports are lib/scratch-overwrite-host.js.
 *
 * `.claude/tmp/` is out of file claims on purpose (`scripts/lib/arbiter-core.js`
 * EXEMPT, mantahostels#2089, mantahostels#2103), so a `Write` over a
 * neighbour's scratch is neither refused nor versioned.
 *
 * WHAT IT DOES. Every `Write` whose path sits under a `.claude/tmp/` segment
 * is appended to this session's record. A `Write` to such a path that ALREADY
 * EXISTS, is not on the record, and does not already carry this session's id
 * prefix in its name is refused, once per path: the refusal has already put
 * the path on the record, so the re-send passes.
 *
 * A REFUSAL, NOT A WARN (#1717 Q2 (A), re-ruling #1167 Q1 (A)), though it
 * denies on an inference — an unrecorded file may be this session's own
 * Bash-made one — because a warn rides the write it warns about.
 *
 * KEYED ON THE SESSION ALONE, not `(agent, session)` as a rule latch is keyed:
 * a parent rewriting its own subagent's artefact is not a neighbour's clobber.
 * Its own marker prefix, so `clear-rule-latch.sh` at PreCompact leaves it be
 * and a compacted session is not refused on its own files.
 *
 * LIMITS
 *  - `Write` only. A Bash-route write (`>`, `tee`, a heredoc) is neither seen
 *    nor recorded, so a file a session made through Bash and then `Write`s
 *    over is refused once unless its name carries the session's id prefix.
 *    `Edit` is not judged: it needs the old text matched, so it never replaces
 *    a file blind.
 *  - Recorded at PreToolUse, so a `Write` another hook or the permission
 *    prompt then refuses is on the record anyway.
 *  - The record is swept once it is older than `arbiter-markers.js`'s
 *    MARKER_AGE_MS and its session is no longer live.
 *  - Fail-open, recorded (mantahostels#103 §6): a payload with no session id,
 *    or a record that cannot be read or written, lets the write through.
 */

const path = require("node:path");
const { normAbs } = require("./shell-parse.js");
const { reviewSuffix, segment } = require("./review-suffix.js");

/**
 * @typedef {{ path: string, has: (target: string) => boolean | null,
 *   add: (target: string) => boolean }} ScratchRecord one session's record:
 *   whether it holds a path, null where it cannot be read; and an append,
 *   false where it cannot be written
 * @typedef {import("./guard-dispatch.js").CoreContext & {
 *   scratchRecord: (sid: string) => ScratchRecord | null,
 * }} ScratchContext `scratchRecord` is null where the repo root's markers
 *   directory cannot be resolved
 */

/**
 * @param {string} given
 * @param {ScratchContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(given, ctx) {
	if (!given.includes(".claude/tmp/")) return null;
	const target = normAbs(
		given.startsWith("/") ? given : `${ctx.cwd || ctx.fallbackCwd}/${given}`,
	);
	if (!target.includes("/.claude/tmp/")) return null;
	if (!ctx.session) {
		ctx.log("no session id — a scratch write allowed unrecorded");
		return null;
	}
	const suffix = reviewSuffix(ctx.session);
	const record = ctx.scratchRecord(segment(ctx.session));
	if (!record) {
		ctx.log("repo root unresolved — a scratch write allowed unrecorded");
		return null;
	}
	const ours = record.has(target);
	if (ours === null) {
		ctx.log(
			`scratch record ${record.path} unreadable — a scratch write allowed unchecked`,
		);
		return null;
	}
	if (ours) return null;
	if (!record.add(target)) {
		ctx.log(
			`scratch record ${record.path} unwritable — a scratch write allowed unrecorded`,
		);
		return null;
	}
	if (!ctx.exists(target)) return null;
	/* `<stem>-<sid8>.<ext>`, split at the LAST dot; a name with none, or whose
	 * only dot leads it, takes the suffix at its end. A name already in that
	 * form is this session's by construction. */
	const name = path.basename(target);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	if (stem.endsWith(suffix)) return null;
	const suggested =
		stem === name ? `${name}${suffix}` : `${stem}${suffix}${name.slice(dot)}`;
	return {
		deny: ctx.corePaths(
			`Refused once: this \`Write\` replaces \`${target}\`, which already exists and which this session has not written. \`.claude/tmp/\` takes no file claims and keeps no versions, so if a neighbour wrote it, its bytes would be gone for good. Write \`${path.dirname(target)}/${suggested}\` instead — scratch names carry the session's first eight id characters so two sessions on one issue never pick the same one (\`docs/agents/rules/job-dir-scratch.txt\`). If you know the file is yours, re-send this same call: it goes through, and this path is not refused again this session.`,
		),
	};
}

module.exports = { field: "file_path", noun: "write", decide };
