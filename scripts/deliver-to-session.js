#!/usr/bin/env node
/*
 * deliver-to-session.js — what is due to one live session now (#853, spec #849).
 *
 * The session is CLAUDE_CODE_SESSION_ID, as the arbiter's self-acts take it,
 * never an argument: a run spends that session's record of what it was given.
 * Prints the text due, and nothing at all when nothing is. The delivery mod
 * (#849) runs it and appends what it prints to the session.
 *
 * SOURCES, each its own flag:
 *   --reports   the `ci-status`, `reap-finished-sessions` and repo-checks
 *               reports in the notify-reports store that this session's own
 *               start produced, each text printed to it once
 *   --requests  every release request standing against a subject this session
 *               holds, in the write path's wording and said once with it: the
 *               arbiter's own `held-requests` (#855)
 *   --ci        the CI re-check (#856): one `gh` call for the runs carrying
 *               the newest verdict (lib/ci-verdict.js), and only where they
 *               differ from the last this session saw,
 *               `check-ci-status.js --notify --recheck`, which fires no
 *               sweep; its text printed to it once
 *   --paths     the store directories the mod stats, as JSON, printed alone
 *
 * Every other producer in the store — the Jev
 * flags among them (#829 Q2) — is never printed, nor one added later until a
 * ruling adds it. A report with no owner (written before #853, or by a run
 * with no session) is never printed either; it still reaches the next session
 * start through the replay.
 *
 * THE REPLAY'S CONSUMPTION IS UNTOUCHED. Nothing here writes the replay's
 * `.shown.json` records or the delivery stamps, so the next session start
 * shows every report exactly as it would with no mod, a repeat of what this
 * delivered included (#849 §Reports). What this session has been given lives
 * in a ledger of its own under the store's `delivered/`, which `notify.list()`
 * never matches.
 *
 * Only `--ci` touches the network. `--reports` reads files only; `--requests`
 * runs the arbiter, which may ask git whether a held file is dirty.
 *
 * THE RE-CHECK'S FIRST GATE IS SEEDED FROM THE SESSION'S START. Where this
 * session owns the persisted ci-status report and the newest verdict's runs
 * all finished before that check began, the start already reported it, so the run is
 * recorded as seen and nothing is printed. Otherwise a red standing at start
 * would be delivered twice, the second time worded with later ages.
 *
 * A FAILED, TIMED-OUT OR SKIPPED RE-CHECK DELIVERS NOTHING (#856) and records
 * nothing seen, so the mod's next interval asks again. A skip exits 0 and
 * prints nothing under --notify, its budget spent or GitHub unreachable, so
 * the check runs under --json, whose envelope names the outcome.
 * A BROKEN check's text is delivered once, and the run is still not seen.
 *
 * IN NO SCRIPT FAMILY (§N3). Exit 0 with output or without; 2 on a usage
 * error.
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const core = require("./lib/arbiter-core.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const notify = require("./lib/notify-report.js");
const { newestVerdictRuns } = require("./lib/ci-verdict.js");
const { gh } = require("./lib/gh.js");
const { fromEnv } = require("./lib/session-id.js");
const { caught } = require("./lib/caught.js");
const { isRepoChecksReport } = require("./lib/repo-checks-reading.js");

const USAGE =
	`usage: node ${scriptPath("deliver-to-session.js")} --reports | --requests | --ci | --paths\n` +
	"  the session is CLAUDE_CODE_SESSION_ID\n";

/* Beside these, repo-checks.js's one report per repo (spec #1510 §Where a
 * finding goes). */
const DELIVERED = ["ci-status", "reap-finished-sessions"];

const ARBITER = path.join(__dirname, "session-arbiter.js");
// A guess, never measured: under the mod's 5 s (#849 §Guard safety), so a slow
// arbiter is said as unknown here rather than lost to the mod's kill.
const ARBITER_TIMEOUT_MS = 4000;

/** Why a spawned script failed, in one line. @param {import("node:child_process").SpawnSyncReturns<string>} ran */
const whyFailed = (ran) =>
	(ran.error?.message ?? ran.stderr ?? "").trim() || `exit ${ran.status}`;

const CI_CHECK = path.join(__dirname, "check-ci-status.js");
// check-ci-status.js's branch default.
const CI_BRANCH = "main";
/* Runs the gate reads for one carrying a verdict. A guess: the denylisted
 * workflows are rare enough that 20 always reaches a sweep. */
const CI_GATE_WINDOW = 20;
// check-ci-status.js's own per-call cap (mantahostels#2134).
const CI_GATE_TIMEOUT_MS = 8000;
/* Above the check's 11 s --notify budget, with room for node's start and its
 * git calls; a guess. The variable is for tests. The mod's own timeout sits
 * above this plus the gate. */
const CI_CHECK_TIMEOUT_MS =
	Number(process.env.WFC_RECHECK_TIMEOUT_MS) || 15_000;

// The ledger entry saying a failed run was told. Not core.firstSay: its marker
// lives in the claim store, the likeliest thing to have failed.
const REQUESTS_FAILED = "held-requests failed";

/* A ledger untouched this long is taken to belong to a session long gone. A
 * first guess, never measured against session lifetimes; a ledger pruned under
 * a live session costs at most its start's reports repeated once.
 * Pruned only on a run that writes one, so an idle tick pays nothing for it. */
const LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const UNREADABLE =
	"the notify-reports store could not be read, so whether a report from this " +
	"session's start is waiting is unknown — not nothing (mantahostels#174). " +
	`See: node ${scriptPath("check-guard-errors.js")}`;

/** @param {string} checker */
const buildUnreadableReport = (checker) =>
	`${checker}'s persisted report could not be read, so whether it is one ` +
	"this session's start produced is unknown — not nothing (mantahostels#174). " +
	"Run `node scripts/replay-notify-reports.js` to see what the store holds.";

const ledgerDir = () => path.join(notify.base(), "delivered");

/** @param {string} session */
const ledgerFile = (session) =>
	path.join(ledgerDir(), `${session.replace(/[^A-Za-z0-9_-]/g, "-")}.json`);

/** @param {string} text */
const digestOf = (text) =>
	crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);

/**
 * @typedef {{ given: Set<string>, ci: string|null }} Ledger `given` holds the
 *   `<checker>:<digest>` entries this session has been given; `ci` the sorted,
 *   comma-joined `<run id>:<conclusion>` list of the newest verdict runs its CI
 *   re-check last saw.
 */

/**
 * Unreadable reads as nothing given and nothing seen, failing open (#853):
 * the cost is a report repeated, never one lost.
 * @param {string} session
 * @returns {Ledger}
 */
function readLedger(session) {
	const raw = notify.readJSON(ledgerFile(session));
	return {
		given: new Set(
			Array.isArray(raw?.given)
				? raw.given.filter((/** @type {unknown} */ g) => typeof g === "string")
				: [],
		),
		ci: typeof raw?.ci === "string" ? raw.ci : null,
	};
}

/** @param {string} session @param {Ledger} ledger */
function writeLedger(session, { given, ci }) {
	notify.atomicWriteJSON(ledgerFile(session), { given: [...given], ci });
	const now = Date.now();
	try {
		for (const f of fs.readdirSync(ledgerDir())) {
			const full = path.join(ledgerDir(), f);
			if (now - fs.statSync(full).mtimeMs > LEDGER_MAX_AGE_MS)
				fs.unlinkSync(full);
		}
	} catch {
		/* Fails open (#853): housekeeping, and a ledger left behind costs a
		 * few bytes. */
	}
}

/**
 * The owned reports this session has not yet been given, as printable blocks.
 * @param {string} session
 * @returns {string[]}
 */
function ownedReports(session) {
	const unreadable = blocksForUnlistableStore(session);
	if (unreadable) return unreadable;
	const ledger = readLedger(session);
	const { given } = ledger;
	const blocks = [];
	const repoChecks = notify.list().filter(isRepoChecksReport);
	for (const checker of [...DELIVERED, ...repoChecks]) {
		const block = buildReportBlock(session, checker, given);
		if (block !== null) blocks.push(block);
	}
	if (blocks.length > 0) writeLedger(session, ledger);
	return blocks;
}

/**
 * The blocks to print where the notify-reports store cannot be listed; null
 * where it can.
 * @param {string} session
 * @returns {string[] | null}
 */
function blocksForUnlistableStore(session) {
	try {
		fs.readdirSync(notify.base());
	} catch (e) {
		// ENOENT is a real empty: no producer has written yet.
		if (caught(e).code === "ENOENT") return [];
		// Said once, or a dark store repeats this at every tick of the session.
		if (!core.firstSay(session, "notify-reports store unreadable")) return [];
		core.logError("deliver-to-session reports", e);
		return [UNREADABLE];
	}
	return null;
}

/**
 * One checker's block, where its report is this session's and new to it —
 * recorded in `given` as it is returned; null where nothing is due.
 * @param {string} session
 * @param {string} checker
 * @param {Set<string>} given accumulator: the ledger's given set, the block's entry added
 * @returns {string | null}
 */
function buildReportBlock(session, checker, given) {
	const report = notify.readReport(checker);
	if (!report) {
		/* Absent is nothing due. Present and unparseable cannot say whose it
		 * is, so it is said once rather than read as an all-clear. */
		if (
			fs.existsSync(notify.reportFile(checker)) &&
			core.firstSay(session, `notify report unreadable ${checker}`)
		)
			return buildUnreadableReport(checker);
		return null;
	}
	if (report.owner !== session || !report.text.trim()) return null;
	const entry = `${checker}:${digestOf(report.text)}`;
	if (given.has(entry)) return null;
	given.add(entry);
	return `▸ ${report.checker}\n${report.text.replace(/\n+$/, "")}`;
}

/**
 * The arbiter's request notices for what this session holds, as one block.
 * A failed run is said once as unknown, never read as no request (#855).
 * @param {string} session
 * @returns {string[]}
 */
function heldRequests(session) {
	const ran = spawnSync(process.execPath, [ARBITER, "held-requests"], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
		timeout: ARBITER_TIMEOUT_MS,
	});
	if (ran.status !== 0) {
		const why = whyFailed(ran);
		core.logError("deliver-to-session requests", why);
		const ledger = readLedger(session);
		if (ledger.given.has(REQUESTS_FAILED)) return [];
		ledger.given.add(REQUESTS_FAILED);
		writeLedger(session, ledger);
		return [
			"whether another session has asked for a file this one holds is " +
				`unknown — not nothing (mantahostels#174): ${why}. ` +
				`See: node ${scriptPath("check-guard-errors.js")}`,
		];
	}
	const text = ran.stdout.trim();
	return text ? [`▸ release-request\n${text}`] : [];
}

/** The outcomes that settle a verdict. */
const CONCLUSIVE = new Set(["OK", "WARN", "FAIL"]);

/**
 * Whether this session's own start check began after every one of `runs`
 * finished, and so already reported them. A SKIP or BROKEN start saw no runs,
 * so it reported none (#890). A report with no duration is judged from its end.
 * @param {string} session
 * @param {{ updatedAt?: string }[]} runs
 */
function reportedAtStart(session, runs) {
	const report = notify.readReport("ci-status");
	if (report?.owner !== session || !CONCLUSIVE.has(report.outcome))
		return false;
	const began = Date.parse(report.at) - (report.durationMs ?? 0);
	return runs.every((r) => Date.parse(r.updatedAt ?? "") <= began);
}

/**
 * The CI check's --notify text, where the newest verdict changed since this
 * session last looked and the text is new to it.
 * @param {string} session
 * @returns {string[]}
 */
function ciRecheck(session) {
	const runs = gateRuns();
	if (runs === null) return [];
	const newest = newestVerdictRuns(runs);
	if (newest.length === 0) return [];
	const seen = newest
		.map((r) => `${r.databaseId}:${r.conclusion}`)
		.sort()
		.join(",");
	const ledger = readLedger(session);
	if (ledger.ci === seen) return [];
	if (ledger.ci === null && reportedAtStart(session, newest)) {
		writeLedger(session, { ...ledger, ci: seen });
		return [];
	}
	const envelope = recheckEnvelope();
	if (envelope === null) return [];
	if (CONCLUSIVE.has(String(envelope.outcome))) ledger.ci = seen;
	const text = buildNoticeText(envelope);
	const entry = `ci-recheck:${digestOf(text)}`;
	const isNew = Boolean(text) && !ledger.given.has(entry);
	if (isNew) ledger.given.add(entry);
	writeLedger(session, ledger);
	return isNew ? [`▸ ci-recheck\n${text}`] : [];
}

/**
 * The runs the gate reads for the newest verdict; null, logged, where `gh`
 * failed or answered with no list.
 * @returns {{ databaseId: number, headSha?: string, conclusion?: string|null, workflowName?: string, updatedAt?: string }[] | null}
 */
function gateRuns() {
	try {
		const runs = JSON.parse(
			gh(
				[
					"run",
					"list",
					"--branch",
					CI_BRANCH,
					"--limit",
					String(CI_GATE_WINDOW),
					"--json",
					"databaseId,headSha,conclusion,workflowName,updatedAt",
				],
				{ timeout: CI_GATE_TIMEOUT_MS },
			),
		);
		if (!Array.isArray(runs)) throw new Error("gh returned no list of runs");
		return runs;
	} catch (e) {
		core.logError("deliver-to-session ci gate", e);
		return null;
	}
}

/** @typedef {{ outcome?: unknown, text?: unknown, summary?: unknown }} CiEnvelope */

/**
 * The CI check's --json envelope; null, logged, where it failed, answered
 * unparseably or skipped.
 * @returns {CiEnvelope | null}
 */
function recheckEnvelope() {
	// --json also keeps the run off persist mode: the stored report is the start's.
	const ran = spawnSync(
		process.execPath,
		[CI_CHECK, "--notify", "--recheck", "--json", "--json-text"],
		{ encoding: "utf8", timeout: CI_CHECK_TIMEOUT_MS },
	);
	/** @type {CiEnvelope | null} */
	let envelope = null;
	try {
		envelope = ran.status === 0 ? JSON.parse(ran.stdout) : null;
	} catch {
		/* Unparseable reads as failed, below. */
	}
	if (!envelope || envelope.outcome === "SKIP") {
		core.logError(
			"deliver-to-session ci re-check",
			envelope ? String(envelope.summary) : whyFailed(ran),
		);
		return null;
	}
	return envelope;
}

/**
 * The --notify text.
 * @param {CiEnvelope} envelope
 * @returns {string}
 */
const buildNoticeText = (envelope) =>
	[
		typeof envelope.text === "string" ? envelope.text : "",
		envelope.outcome === "OK" ? "" : String(envelope.summary ?? ""),
	]
		.join("\n")
		.trim();

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE.trimEnd(),
		flags: {
			"--reports": "boolean",
			"--requests": "boolean",
			"--ci": "boolean",
			"--paths": "boolean",
		},
	});
	if (Object.keys(flags).length === 0) {
		process.stderr.write(USAGE);
		return 2;
	}
	if (flags["--paths"]) {
		process.stdout.write(
			`${JSON.stringify({
				notifyReports: notify.base(),
				requests: core.paths.requestsDir(),
				locks: core.paths.locksDir(),
			})}\n`,
		);
		return 0;
	}
	const session = fromEnv();
	if (!session) return 0;
	const blocks = [
		...(flags["--reports"] ? ownedReports(session) : []),
		...(flags["--requests"] ? heldRequests(session) : []),
		...(flags["--ci"] ? ciRecheck(session) : []),
	];
	if (blocks.length > 0) process.stdout.write(`${blocks.join("\n\n")}\n`);
	return 0;
}

process.exitCode = main();
