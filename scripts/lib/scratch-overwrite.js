const path = require("node:path");
const { normAbs } = require("./shell-parse.js");
const { reviewSuffix, segment } = require("./review-suffix.js");
const { SCRATCH_DIR } = require("./scratch-dir.js");

/**
 * @typedef {{ path: string, has: (target: string) => boolean | null,
 *   add: (target: string) => boolean }} ScratchRecord
 * @typedef {import("./core-contract.js").CoreContext & {
 *   scratchRecord: (sid: string) => ScratchRecord | null,
 * }} ScratchContext
 */

/**
 * @param {string} given
 * @param {ScratchContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(given, ctx) {
	if (!given.includes(SCRATCH_DIR)) return null;
	const target = normAbs(
		given.startsWith("/") ? given : `${ctx.cwd || ctx.fallbackCwd}/${given}`,
	);
	if (!target.includes(`/${SCRATCH_DIR}`)) return null;
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
