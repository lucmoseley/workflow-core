#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { buildErrorText, caught } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { gh } = require("./lib/gh.js");
const { gitCommonDir } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { spendFire } = require("./lib/sweep-budget.js");
const {
	SLOT_INPUT,
	SWEEP_WORKFLOW,
	readLedgerRuns,
	slotKey,
	sweepLedger,
} = require("./lib/sweep-ledger.js");
const { writeFd } = require("./lib/write-fd.js");

const MARKER = ".sweep-slot-repair";

const GH_TIMEOUT_MS = 8000;

/** @param {number} t */
function dueSlot(t) {
	const slot = sweepLedger([], t).judgeable.at(-1);
	if (!slot) throw new Error("the sweep grid has no judgeable slot");
	return slot.at;
}

/**
 * @param {string} marker
 * @returns {string|null}
 */
function readSettled(marker) {
	try {
		const slot = JSON.parse(fs.readFileSync(marker, "utf8")).slot;
		return typeof slot === "string" ? slot : null;
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
}

/**
 * @param {string} marker
 * @param {string} slot
 * @param {"delivered"|"fired"|"budget out"} outcome
 */
const settle = (marker, slot, outcome) =>
	fs.writeFileSync(marker, JSON.stringify({ slot, outcome }));

/**
 * @param {string} marker
 * @param {number} slot
 * @param {number} t
 */
function isRepairDone(marker, slot, t) {
	const key = slotKey(slot);
	if (readSettled(marker) === key) return true;
	const delivered = sweepLedger(readLedgerRuns(GH_TIMEOUT_MS), t).slots.some(
		(s) => s.at === slot && s.run !== null,
	);
	if (delivered) settle(marker, key, "delivered");
	return delivered;
}

/** @returns {number} */
function main() {
	const root = hostRoot();
	if (!fs.existsSync(path.join(root, ".github", "workflows", SWEEP_WORKFLOW)))
		return 0;
	const common = gitCommonDir(root);
	if (!common) {
		writeFd(2, "git would not name a common dir, so no slot was repaired\n");
		return 1;
	}
	const marker = path.join(common, MARKER);
	const t = now();
	const slot = dueSlot(t);
	const key = slotKey(slot);
	try {
		if (isRepairDone(marker, slot, t)) return 0;
	} catch (e) {
		writeFd(2, `slot ${key} not judged: ${buildErrorText(e)}\n`);
		return 1;
	}
	const spend = spendFire(root, t);
	if ("fault" in spend) {
		writeFd(2, `slot ${key} missed, not repaired: ${spend.fault}\n`);
		return 1;
	}
	try {
		// #4447
		settle(marker, key, spend.out ? "budget out" : "fired");
	} catch (e) {
		writeFd(2, `slot ${key} missed, not repaired: ${buildErrorText(e)}\n`);
		return 1;
	}
	if (spend.out) {
		writeFd(
			1,
			`slot ${key} missed, not repaired: ${spend.cap} sweeps already fired on ${spend.day} (UTC)\n`,
		);
		return 0;
	}
	try {
		gh(["workflow", "run", SWEEP_WORKFLOW, "-f", `${SLOT_INPUT}=${key}`], {
			timeout: GH_TIMEOUT_MS,
		});
	} catch (e) {
		fs.rmSync(marker, { force: true });
		writeFd(2, `slot ${key} missed, its repair failed: ${buildErrorText(e)}\n`);
		return 1;
	}
	writeFd(
		1,
		`slot ${key} missed, sweep fired (${spend.spent} of ${spend.cap} today)\n`,
	);
	return 0;
}

if (require.main === module) process.exitCode = main();
