/*
 * refuse-once.js — the flow of a dispatcher core that refuses a subject once and
 * passes its re-send (workflow-core#2801, workflow-core#3858). It fails open, on the record, where the
 * latch cannot be keyed or written: refused unlatched, the re-send would be
 * refused for ever.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");

/* 64 bits of the sha1: a file name, and no collision within one session's latches. */
const LATCH_HEX = 16;

/**
 * @param {object} refusal
 * @param {string} refusal.prefix  the latch name's stem
 * @param {string} refusal.subject  what a re-send repeats
 * @param {string} refusal.passed  what the log says went through unrefused
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
	/* The kit writes the latch after the refusal is out (mantahostels#2261). */
	return { deny: buildDeny(), latchWrites: [{ name, text: "" }] };
}

/**
 * The `isLatchWritable` port's production answer.
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
