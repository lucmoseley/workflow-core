#!/usr/bin/env node
/*
 * repair-sweep-slot.js — fire the sweep for a cron slot GitHub dropped (#4447).
 *
 *   node scripts/repair-sweep-slot.js
 *
 * GitHub drops or delays queued scheduled runs at load (mantahostels#2204), so
 * `scheduled-checks.yml` delivers two or three of its four daily slots. The
 * session-start autofire (mantahostels#1816) fires only when a session starts
 * and only on a stale verdict, so a slot nobody starts a session after stays
 * missed.
 *
 * WHICH SLOT: the newest one the ledger (lib/sweep-ledger.js) can judge, past
 * the same grace the liveness report judges a miss by, so a slot GitHub
 * delivers late inside it is never doubled. Only that one: an older miss means
 * the loop was down through its whole repair window, and firing several now
 * would test the same tree several times over.
 *
 * ONCE PER SLOT, two ways. The dispatch carries the slot (`-f slot=…`), which
 * the workflow's `run-name` turns into a title the ledger reads as that slot's
 * run, so a repair from any machine is seen as delivery. And the
 * `.sweep-slot-repair` marker in the git common dir records the slot settled
 * once the fire is spent, which covers GitHub's few seconds of not yet listing
 * a queued run (mantahostels#1832) and keeps every later tick off `gh` until
 * the next slot passes its grace.
 *
 * A DISPATCH THAT FAILS IS RE-JUDGED, never settled: the next tick reads the
 * runs again, and a timed-out dispatch that did reach GitHub is listed by then
 * under its slot's title, so the retry fires only where none did.
 *
 * IT SPENDS THE DAY'S SWEEP BUDGET (lib/sweep-budget.js), as every route does:
 * no exemption for repairing a slot (mantahostels#2188 Q3), and the budget is
 * what bounds the retries. A day out of budget leaves the slot missed, said
 * once.
 *
 * Joins no §N3 family: it fires a workflow and reports nothing a checker
 * would.
 *
 * Prints nothing where nothing was fired or failed. Exit codes: 0 on a pass;
 * 1 where the runs, the marker or the budget would not read, or the dispatch
 * failed.
 *
 * Caller: the refill loop, every tick (lib/refill-tick.js's runMachineChild).
 */

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

/* The bound check-ci-status.js gives each of its own gh calls (mantahostels#2134),
 * not gh.js's 300 s default: a refill tick runs this inline. */
const GH_TIMEOUT_MS = 8000;

/**
 * The newest slot the ledger judges at `t`. The 24h window always holds three
 * past the grace.
 * @param {number} t
 */
function dueSlot(t) {
	const slot = sweepLedger([], t).judgeable.at(-1);
	if (!slot) throw new Error("the sweep grid has no judgeable slot");
	return slot.at;
}

/**
 * The marker's settled slot, or null where none is; throws where it will not
 * read.
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
 * Whether the slot is settled or produced a run, settling it where it did.
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
		/* Settled once spent, before the dispatch: a marker that will not write
		 * fires nothing, where a repair it cannot record would fire every tick. */
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
