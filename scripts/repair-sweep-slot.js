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
 * missed. The refill loop runs this every tick instead.
 *
 * WHICH SLOT: the newest one past SWEEP_GRACE_MS (lib/sweep-ledger.js), the
 * same grace the liveness report judges a miss by, so a slot GitHub delivers
 * late inside it is never doubled. Only that one: an older miss means the loop
 * was down through its whole repair window, and firing several now would test
 * the same tree several times over.
 *
 * ONCE PER SLOT, two ways. The dispatch carries the slot (`-f slot=…`), which
 * the workflow's `run-name` turns into a title the ledger reads as that slot's
 * run, so a repair from any machine is seen as delivery. And the
 * `.sweep-slot-repair` marker in the git common dir records the slot settled
 * before the dispatch, which covers GitHub's few seconds of not yet listing a
 * queued run (mantahostels#1832) and keeps every later tick off `gh` until the
 * next slot passes its grace.
 *
 * IT SPENDS THE DAY'S SWEEP BUDGET (lib/sweep-budget.js), as every route does:
 * no exemption for repairing a slot (mantahostels#2188 Q3). A day out of budget
 * leaves the slot missed, said once.
 *
 * A dispatch that fails is not retried: whether a timed-out one reached GitHub
 * is unknown, and a retry could double it.
 *
 * Prints nothing where nothing was fired or failed. Exit codes: 0 on a pass;
 * 1 where the runs, the marker or the budget would not read, or the dispatch
 * failed, so the refill loop logs it.
 *
 * Caller: the refill loop, every tick (lib/refill-tick.js's repairSweepSlot).
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
	SWEEP_GRACE_MS,
	SWEEP_WORKFLOW,
	slotKey,
	slotsFrom,
	sweepLedger,
} = require("./lib/sweep-ledger.js");
const { writeFd } = require("./lib/write-fd.js");

const MARKER = ".sweep-slot-repair";
const DAY_MS = 24 * 60 * 60 * 1000;
const GH_TIMEOUT_MS = 8000;

/**
 * The newest slot past its grace at `t`.
 * @param {number} t
 */
function dueSlot(t) {
	const due = slotsFrom(t - DAY_MS).filter((at) => t - at > SWEEP_GRACE_MS);
	return /** @type {number} */ (due.at(-1));
}

/**
 * Whether `slot` produced a run among `runs`, by the ledger's own reading.
 * @param {import("./lib/sweep-ledger.js").LedgerRun[]} runs
 * @param {number} slot
 * @param {number} t
 */
const isDelivered = (runs, slot, t) =>
	sweepLedger(runs, t).slots.some((s) => s.at === slot && s.run !== null);

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
 * @param {"delivered"|"repairing"|"budget out"} outcome
 */
const settle = (marker, slot, outcome) =>
	fs.writeFileSync(marker, JSON.stringify({ slot, outcome }));

/** @returns {import("./lib/sweep-ledger.js").LedgerRun[]} */
const readRuns = () =>
	JSON.parse(
		gh(
			[
				"run",
				"list",
				"--workflow",
				SWEEP_WORKFLOW,
				/* check-ci-status.js's readSweepRuns() window, so the two judge one list. */
				"--limit",
				"50",
				"--json",
				"createdAt,event,displayTitle",
			],
			{ timeout: GH_TIMEOUT_MS },
		),
	);

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
		if (readSettled(marker) === key) return 0;
		if (isDelivered(readRuns(), slot, t)) {
			settle(marker, key, "delivered");
			return 0;
		}
		/* Before the spend, so a marker that will not write fires nothing: a
		 * repair it cannot record would fire again every tick. */
		settle(marker, key, "repairing");
	} catch (e) {
		writeFd(2, `slot ${key} not judged: ${buildErrorText(e)}\n`);
		return 1;
	}
	const spend = spendFire(root, t);
	if ("fault" in spend) {
		writeFd(2, `slot ${key} missed, not repaired: ${spend.fault}\n`);
		return 1;
	}
	if (spend.out) {
		settle(marker, key, "budget out");
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
