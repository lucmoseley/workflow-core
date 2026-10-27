/*
 * run-ledger.js — one slim JSON line per test run that wrote a pass or fail
 * marker (#2824), kept 30 days, so a run-level reading reaches past the
 * marker archive's 7 days (`ARCHIVE_MS`, `test-pass-marker.js`).
 *
 * THE STORE is `.test-runs.jsonl` beside the marker stores, in the canonical
 * checkout's `.claude/tmp/markers`. `test-pass-marker.js`'s `append` writes
 * the line for every marker. A refused launch (`refused`) ran nothing and
 * gets no line. 30 days lets a 7-day window be read up to three weeks after
 * it closes: chosen, not measured.
 *
 * NEVER THROWS: an unwritable ledger costs the line, never the run or its
 * marker.
 *
 * `startedAt` and `durationMs` are null on a marker that carries none.
 * `treeAtEnd` and `argv`, with `sha`, are what `reruns.py` keys a same-code
 * re-run on; the selected files are left out to keep the line slim.
 *
 * `resolvedFiles` and `wholeSlot` are the admission weight the run carried
 * (#2931): null and false on a marker that carries none.
 *
 * `kind` and `fullCause` are #2812's rules; `runs.py` reads them, with
 * `verdict`, from here. Its `lander-rerun` (no session, after the lander's first run) is a
 * dated inference it applies itself, off `session`.
 */

const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { gitRead } = require("./dirty-tree.js");

const RUN_LEDGER = ".test-runs.jsonl";
const RETAIN_MS = 30 * DAY_MS;

/** @typedef {import("./test-pass-marker.js").Marker} Marker */

/**
 * @param {Marker} m
 * @param {boolean} fullFlag
 */
function ranFull({ scope }, fullFlag) {
	const total = scope?.modulesTotal ?? 0;
	return Boolean(
		scope?.full ||
			fullFlag ||
			(total > 0 && (scope?.modulesRun ?? 0) >= 0.9 * total),
	);
}

/**
 * @param {Marker} m
 * @returns {string}
 */
function kindOf(m) {
	const { argv, scope } = m;
	if (scope?.touched) return "touched";
	if (m.suite === "pytest") return "pytest";
	const fullFlag = argv?.some((a) => a.startsWith("--full")) ?? false;
	if (argv?.includes("--shared") && fullFlag && !m.sessionId) return "lander";
	if (ranFull(m, fullFlag)) return "full";
	if (argv?.includes("--adopt")) return "adopt";
	if (argv?.includes("--changed") || scope?.viaChanged) return "changed";
	if (!argv) return scope?.fileFilters?.length ? "named" : "bare";
	const named =
		argv.includes("--retest") ||
		argv.includes("-t") ||
		argv.some((a) => !a.startsWith("-"));
	return named ? "named" : "bare";
}

/**
 * @param {Marker} m
 * @returns {string|null}
 */
function fullCauseOf({ argv, scope }) {
	const flag = argv?.find((a) => a.startsWith("--full="));
	if (flag) return flag.slice("--full=".length);
	if (scope?.fullCause) return scope.fullCause;
	if (scope?.full && scope.full !== "flag") return `escalation:${scope.full}`;
	return argv?.includes("--full") ? "bare --full" : null;
}

/**
 * @param {Marker} m
 * @param {boolean} green whether the marker went to the pass store
 */
function verdictOf(m, green) {
	if (m.ceilingKill) return "killed";
	if (m.stalled) return "stalled";
	return green ? "green" : "red";
}

/**
 * @param {Marker} m
 * @param {{ green: boolean, root: string }} where
 */
function buildLedgerLine(m, { green, root }) {
	const kind = kindOf(m);
	const fullCause =
		kind === "full" || kind === "lander" ? fullCauseOf(m) : null;
	return {
		startedAt: m.startedAt ?? null,
		at: m.at ?? new Date().toISOString(),
		durationMs: m.durationMs ?? null,
		kind,
		...(fullCause ? { fullCause } : {}),
		verdict: verdictOf(m, green),
		suite: m.suite ?? "vitest",
		session: m.sessionId ?? null,
		sha: m.sha,
		treeAtEnd: m.treeAtEnd ?? null,
		argv: m.argv ?? null,
		resolvedFiles: m.scope?.resolvedFiles ?? null,
		wholeSlot: m.scope?.wholeSlot === true,
		repo: path.basename(root),
	};
}

/**
 * Silent on a lost line: the run's output is its verdict, read by the
 * session that launched it, and a gap in an analysis log is not that
 * session's to act on.
 * @param {string} root the canonical checkout
 * @param {Marker} marker
 * @param {boolean} green whether the marker went to the pass store
 */
function appendLedgerLine(root, marker, green) {
	if (marker.refused) return;
	try {
		appendRetained(
			path.join(markersDir(root), RUN_LEDGER),
			buildLedgerLine(marker, { green, root }),
			RETAIN_MS,
		);
	} catch {
		/* appendRetained never throws, so only a marker shaped past its
		 * typedef reaches here (#2824) */
	}
}

/**
 * The line of a touched run that selected nothing: it spawns nothing and
 * writes no marker, which no push reads under `landing` (#2930, #2958).
 *
 * @param {string} root the canonical checkout
 * @param {string} tree the tree the run selected in, whose HEAD it records
 * @param {{ suite: string, sessionId?: string|null, argv: string[] }} run
 */
function appendEmptyTouchedLine(root, tree, { suite, sessionId, argv }) {
	const at = new Date().toISOString();
	appendLedgerLine(
		root,
		{
			sha: gitRead(["rev-parse", "HEAD"], tree)?.trim() || "unknown",
			at,
			startedAt: at,
			durationMs: 0,
			suite,
			scope: {
				modulesRun: 0,
				modulesTotal: 0,
				tests: 0,
				skipped: 0,
				touched: true,
				resolvedFiles: 0,
			},
			sessionId,
			argv,
		},
		true,
	);
}

module.exports = { appendEmptyTouchedLine, appendLedgerLine };
