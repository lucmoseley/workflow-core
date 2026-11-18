#!/usr/bin/env node
/*
 * check-contract-live.js — which live contract cases have skipped in every
 * scheduled sweep for over a week since they last ran live (#5408)?
 *
 * Usage:
 *   node check-contract-live.js [--reports <dir>] [--ledger <file>] [--json]
 *
 * Folds each sweep not yet read into the ledger (lib/contract-live.js), then
 * judges it. `--reports <dir>` reads sweeps already downloaded, one
 * subdirectory per run id as `gh run download <id> -p 'vitest-report-*' -D
 * <dir>/<id>` leaves them.
 *
 * WARN, NEVER FAIL: the cause is a service outside the repo, and the finding
 * asks a person to look, not a commit to change.
 *
 * Only a finished sweep is folded, and the first unfinished one stops the
 * fold: the ledger's newest run never passes a sweep still uploading shards.
 *
 * Residual: a ledger begun while a case was already silent has no live run
 * for it, and counts it among the never-live cases.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), downloads each scheduled sweep's vitest reports not yet read, records each contract case's newest live run in `.claude/tmp/markers/contract-live-ledger.json`, and warns on each skipped in every sweep for over a week since.
 * JUSTIFIED: fail-safe — a contract case that skips on a silent service passes, and nothing else says it stopped checking (#5402).
 * DEFEAT:    convenience — --reports reads sweeps already downloaded, with no gh call; --ledger names another ledger.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { runCheck } = require("./lib/check.js");
const {
	DAY_MS,
	WINDOW_MS,
	fold,
	judge,
	readLedger,
	readSweep,
	writeLedger,
} = require("./lib/contract-live.js");
const { hostRoot } = require("./lib/host-root.js");
const { markersDir } = require("./lib/marker-root.js");
const {
	downloadRun,
	listSweepRuns,
	localRuns,
} = require("./lib/sweep-reports.js");

const ROOT = hostRoot();
const WINDOW = `${WINDOW_MS / DAY_MS} days`;

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The finished runs newer than `newestRun`, oldest first, up to the first
 * unfinished one; and whether the listing no longer reaches `newestRun`, so
 * sweeps between went unread.
 * @param {{ id: string, completed: boolean }[]} listed newest first
 * @param {number} newestRun
 */
function unread(listed, newestRun) {
	const newer = listed
		.map((r) => ({ run: Number(r.id), completed: r.completed }))
		.filter((r) => r.run > newestRun)
		.reverse();
	const stop = newer.findIndex((r) => !r.completed);
	return {
		runs: (stop === -1 ? newer : newer.slice(0, stop)).map((r) => r.run),
		gap: newestRun > 0 && newer.length === listed.length,
	};
}

/**
 * The ledger with every finished sweep newer than its newest folded in,
 * oldest first, and written back. A download gh refuses writes what was
 * folded, then skips.
 * @param {import("./lib/check.js").Ctx} ctx
 * @param {string} ledgerFile
 * @param {string} reports a directory of sweeps already downloaded, or ""
 */
function foldNewSweeps(ctx, ledgerFile, reports) {
	const read = readLedger(ledgerFile);
	if (read.fault) {
		const message = `${ledgerFile}: ${read.fault}; begun again from the sweeps listed.`;
		ctx.warn("CONTRACT-LIVE-LEDGER", message);
		ctx.say(message);
	}
	let ledger = read.ledger;
	const listed = reports
		? localRuns(reports).map((id) => ({ id, completed: true }))
		: listSweepRuns((why) => ctx.skip(why));
	const { runs, gap } = unread(listed, ledger.newestRun);
	const work =
		reports || fs.mkdtempSync(path.join(os.tmpdir(), "contract-live-"));
	const skip = (/** @type {string} */ why) => {
		writeLedger(ledgerFile, ledger);
		return ctx.skip(why);
	};
	try {
		for (const [i, run] of runs.entries()) {
			const dir = path.join(work, String(run));
			const sweep =
				(reports || downloadRun(String(run), dir, skip)) &&
				readSweep(dir, ROOT);
			if (sweep) ledger = fold(ledger, run, sweep, gap && i === 0);
			if (!reports) fs.rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		if (!reports) fs.rmSync(work, { recursive: true, force: true });
	}
	writeLedger(ledgerFile, ledger);
	return ledger;
}

/**
 * @param {import("./lib/check.js").Ctx} ctx
 * @param {ReturnType<typeof judge>["fresh"]} fresh
 */
function sayFresh(ctx, fresh) {
	if (fresh.length === 0) return;
	ctx.say(
		`${fresh.length} contract case(s) first seen in the last ${WINDOW} have never run live in a sweep — by design on the runner, or a service silent from the start:`,
	);
	for (const f of fresh) ctx.say(`  first seen ${day(f.firstSeen)}  ${f.key}`);
}

runCheck({
	name: "contract-live",
	usage:
		"node check-contract-live.js [--reports <dir>] [--ledger <file>] [--json]",
	valueFlags: ["--reports", "--ledger"],
	run(/** @type {import("./lib/check.js").Ctx} */ ctx) {
		const ledger = foldNewSweeps(
			ctx,
			ctx.value(
				"--ledger",
				path.join(markersDir(), "contract-live-ledger.json"),
			),
			ctx.value("--reports", ""),
		);
		if (ledger.newestAt === 0)
			ctx.skip("no sweep's vitest reports read: nothing judged.");
		const { silent, fresh, neverLive } = judge(ledger);
		sayFresh(ctx, fresh);
		const tail = `${neverLive} case(s) never ran live in a sweep read, and are not judged.`;
		if (silent.length === 0)
			return {
				okLine: `no live contract case has skipped in every sweep for over ${WINDOW} (newest sweep ${day(ledger.newestAt)}). ${tail}`,
			};
		ctx.say(
			`CONTRACT-LIVE — ${silent.length} contract case(s) skipped in every sweep for over ${WINDOW} since they last ran live, so their contract goes unchecked:`,
		);
		for (const s of silent) {
			ctx.warn(
				"CONTRACT-LIVE-SILENT",
				`${s.key}: last ran live ${day(s.lastLive)}.`,
				s,
				`CONTRACT-LIVE-SILENT\t${s.key}`,
			);
			ctx.say(`  last live ${day(s.lastLive)}  ${s.key}`);
		}
		ctx.say(
			`  Re-run the case's URL or command by hand: a service that answers it means the skip is the test's fault. ${tail}`,
		);
		return { noun: "silent contract case(s)", data: { silent, neverLive } };
	},
});
