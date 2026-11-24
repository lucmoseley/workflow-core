const crypto = require("node:crypto");
const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");

// guess, workflow-core#3858
const LATCH_HEX = 16;

/**
 * @param {object} refusal
 * @param {string} refusal.prefix
 * @param {string} refusal.subject
 * @param {string} refusal.passed
 * @param {() => string} refusal.buildDeny
 * @param {import("./kit-context.js").KitContext &
 *   { isLatchWritable: () => boolean }} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function refuseOnce({ prefix, subject, passed, buildDeny }, ctx) {
	const sum = crypto.createHash("sha1").update(subject).digest("hex");
	const name = `${prefix}.${sum.slice(0, LATCH_HEX)}`;
	if (ctx.key === null) {
		ctx.log(`latch path unresolved — ${passed} unrefused`);
		return null;
	}
	if (ctx.readLatch(name) !== null) return null;
	if (!ctx.isLatchWritable()) {
		ctx.log(`latch directory unwritable — ${passed} unrefused`);
		return null;
	}
	return { deny: buildDeny(), latchWrites: [{ name, text: "" }] };
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function isMarkersWritable(root) {
	try {
		fs.accessSync(markersDir(root), fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

module.exports = { isMarkersWritable, refuseOnce };
