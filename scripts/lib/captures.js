/*
 * captures.js — the capture corpus: every `**Captured fact:**` comment on the
 * tracker, and whether the drain has consumed it.
 *
 * A FACT IS FILED IN THE SESSION THAT SETTLES IT (mantahostels#2748), so this corpus is
 * residue: the historical queue on mantahostels#678 (the standing surface, now closed) and
 * any capture that escaped the rule. A comment written under the rule today is
 * marked consumed by the session that writes it (`docs/doc-map.md` §Capture and
 * placement; mantahostels#639, mantahostels#640, mantahostels#2748).
 *
 * Two readers share this module: `capture-drain.js`, the CLI the drain skill
 * drives, and `check-capture-drain.js`, the session-start notifier.
 *
 * ONE CALL COVERS EVERY SURFACE. `repos/{owner}/{repo}/issues/comments` lists
 * every issue comment in the repo, open issue or closed, so the per-issue
 * captures and mantahostels#678's arrive together — mantahostels#678's closure hides none of them — and
 * no caller needs to know which issues to ask about. It
 * carries comments on pull requests too, deliberately: a capture written on one
 * is still a capture.
 */

const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const nodePath = require("node:path");

const { ghApiSlurp } = require("./gh");
const { hostRoot } = require("./host-root.js");

/** The marker a capture comment opens with. Fixed by mantahostels#640. */
const MARKER = "**Captured fact:**";

/*
 * The reaction that marks a comment consumed. Not an edit to the comment text
 * (mantahostels#640) — that is the read-modify-write shape `issue-body.js` exists
 * to prevent — nor a positional high-water mark, which is wrong
 * the moment one capture is deliberately skipped.
 *
 * `rocket` rather than `+1` or `eyes`: those two get added by hand while
 * reading, which would mark a capture drained that nobody placed.
 */
const DRAIN_REACTION = "rocket";

/*
 * How old the oldest undrained capture gets before the notifier speaks.
 *
 * A FIRST GUESS, not a measurement (mantahostels#679). Age rather than count so a
 * productive day never triggers it and a quiet fortnight always does; the
 * number itself has nothing behind it. Re-derive it once there is drain history
 * to derive it from.
 *
 * FIRST DRAIN HISTORY (mantahostels#695, 20 Aug 2026). The first run of the drain found 26
 * undrained captures across 22 issues, every one under 24 hours old: a 16h46m
 * window, 16 of them inside 3h16m. This threshold stayed silent throughout and
 * would have stayed silent another six days. So "a productive day never
 * triggers it" is the wrong way round: a productive day is what buries the
 * queue. The shape this points at is age OR count. It sets no number — n=1, on
 * a day running many parallel sessions, and nothing here bounds a quiet week.
 */
const STALE_CAPTURE_DAYS = 7;

/**
 * @typedef {{
 *   id: number,
 *   issue_url?: string,
 *   html_url?: string,
 *   body?: string,
 *   created_at?: string,
 *   reactions?: Record<string, unknown>,
 * }} GhComment
 * @typedef {{
 *   id: number,
 *   issue: number,
 *   url: string | undefined,
 *   fact: string,
 *   createdAt: string,
 *   ageDays: number,
 *   drained: boolean,
 * }} Capture
 */

/**
 * The issue number a comment hangs off, read from its `issue_url`.
 * @param {GhComment} c
 */
const issueNumberOf = (c) =>
	Number(
		String(c.issue_url || "")
			.split("/")
			.pop(),
	);

/**
 * A capture opens with the marker on its first non-empty line. Anything else
 * mentioning the phrase mid-body — this file, a ticket quoting the convention —
 * is prose about captures, not a capture.
 */
/** @param {string | null | undefined} body */
function captureBody(body) {
	const lines = String(body || "").split("\n");
	const first = lines.findIndex((l) => l.trim() !== "");
	const head = lines[first];
	if (head === undefined) return null;
	if (!head.trimStart().startsWith(MARKER)) return null;
	return [head.trimStart().slice(MARKER.length), ...lines.slice(first + 1)]
		.join("\n")
		.trim();
}

/**
 * True where the drain has consumed this comment.
 *
 * The reaction summary rides on the comment payload — a per-type count,
 * `rocket` among them, verified against the live listing 19 August 2026 — so
 * this costs no extra call. A payload carrying no summary at all reads as
 * undrained — the safe
 * direction: a capture shown again is noise, one silently swept past is lost.
 *
 * Blind spot: a reaction added by hand retires the capture for good, and the
 * drain never sees it. Nothing distinguishes the two, which is why the reaction
 * is one nobody adds while reading.
 */
const isDrained = (/** @type {Pick<GhComment, "reactions">} */ c) =>
	Number(c?.reactions?.[DRAIN_REACTION] || 0) > 0;

/**
 * Every capture comment in the repo, newest last, each as:
 *   { id, issue, url, fact, createdAt, ageDays, drained }
 *
 * Throws whatever gh threw; callers decide between SKIP and BROKEN via
 * `raiseGhFailure`.
 * @returns {Capture[]}
 */
function fetchCaptures() {
	const comments = ghApiSlurp([
		"repos/{owner}/{repo}/issues/comments",
		"-X",
		"GET",
		"-f",
		"per_page=100",
	]);

	// After the call, not before: the fetch takes long enough that a comment
	// written during it would read as fractionally older than it is.
	const now = Date.now();

	const out = [];
	for (const c of comments) {
		const fact = captureBody(c.body);
		if (fact === null) continue;
		/* An unparseable timestamp would make every comparison downstream NaN,
		 * which reads as "not overdue" and silently disables the check. Date it
		 * to the epoch instead, so it surfaces as maximally old. */
		const createdAt = Number.isFinite(Date.parse(c.created_at))
			? c.created_at
			: new Date(0).toISOString();
		out.push({
			id: c.id,
			issue: issueNumberOf(c),
			url: c.html_url,
			fact,
			createdAt,
			ageDays: (now - Date.parse(createdAt)) / 864e5,
			drained: isDrained(c),
		});
	}
	out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	return out;
}

/*
 * THE SCAN IS TOO SLOW TO RUN AT A SESSION START. There is no narrower query:
 * a capture can be on any comment on any issue, so the check reads every issue
 * comment in the repo — 12 paginated pages and 20.3 seconds, measured 19 August
 * 2026 against a `SessionStart` allowance of 15. On that path the check would
 * be killed mid-call every time and print nothing, which is also exactly what
 * it prints when nothing is overdue.
 *
 * So the session-start path reads this state file instead and never calls gh
 * at all, and a detached refresh — kicked by that same run — pays the 20
 * seconds after the session has started. `since=` is no fix: it narrows away
 * the old capture the check exists to find.
 *
 * The state records each undrained capture's `createdAt`, not its age, so a
 * state file written days ago still ages correctly when read. What a stale one
 * misses is a capture drained or created since — it over-reports a drained one
 * and under-reports a new one, both self-correcting at the next refresh.
 */
const STATE_FILE = () =>
	process.env.WFC_CAPTURE_STATE ||
	nodePath.join(markersDir(hostRoot()), ".capture-drain-state.json");

/**
 * How stale a state file may be before it is treated as saying nothing. A
 * capture has to sit 7 days to be reported at all, so a day's lag cannot make
 * the verdict wrong by more than a day. Unmeasured, like the 7.
 */
const STATE_STALE_HOURS = 24;

/** Below this age, a refresh is skipped: every parallel session start would
 *  otherwise kick its own 20-second scan. */
const REFRESH_MIN_AGE_HOURS = 1;

/** The stored scan, or null where there is none, it cannot be read, or it is
 *  too old to speak. Never throws: this runs on the session-start path. */
function readState() {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
	} catch {
		return null;
	}
	const scannedAt = Date.parse(parsed?.scannedAt);
	if (!Number.isFinite(scannedAt)) return null;
	parsed.ageHours = (Date.now() - scannedAt) / 36e5;
	parsed.stale = parsed.ageHours > STATE_STALE_HOURS;
	return parsed;
}

/** Record a completed scan. Returns false where the write failed — the caller
 *  reports it rather than the check dying on a read-only checkout. */
/**
 * @param {Capture[]} captures
 * @param {number} [now]
 */
function writeState(captures, now = Date.now()) {
	const undrained = captures.filter((c) => !c.drained);
	try {
		fs.writeFileSync(
			STATE_FILE(),
			`${JSON.stringify(
				{
					scannedAt: new Date(now).toISOString(),
					captureCount: captures.length,
					undrainedCount: undrained.length,
					// createdAt, never ageDays: the reader ages it itself.
					undrained: undrained.map(({ id, issue, url, createdAt }) => ({
						id,
						issue,
						url,
						createdAt,
					})),
				},
				null,
				2,
			)}\n`,
		);
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	DRAIN_REACTION,
	STALE_CAPTURE_DAYS,
	STATE_STALE_HOURS,
	REFRESH_MIN_AGE_HOURS,
	fetchCaptures,
	readState,
	writeState,
};
