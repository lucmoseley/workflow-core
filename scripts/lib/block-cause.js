/*
 * block-cause.js — why a launched session the listing shows `blocked` is
 * blocked (workflow-core#2699, spec workflow-core#2695; rules from workflow-core#2358 F9, first match wins).
 *
 * Pure: the caller reads the three records and passes them in.
 *
 * UNKNOWN IS THE FAIL-SAFE: an unread record or a field of an unexpected type
 * reads UNKNOWN, on which the loop acts on nothing (workflow-core#2358 F9).
 *
 * PERMISSION IS TESTED FIRST: a new prompt can open over a stale question
 * `needs` (workflow-core#2358 F3).
 */

/* Below it the transcript carries no `permissionDecision` (workflow-core#2358 F8). */
const MIN_CLI = [2, 1, 293];

const PERMISSION_WAITS = new Set([
	"permission prompt",
	"sandbox request",
	"worker request",
]);
/* A tool approval's `needs` (workflow-core#2358 F3; workflow-core#2699's live reading). */
const APPROVE_TOOL = /^approve (?!plan$)[^:]+: /;
const LIMIT_TEXT = /^You've (hit|reached) your .*limit/;
const LIMIT_NEEDS = new Set([
	"usage limit reached — check plan",
	"choose: continue on usage credits or switch models",
]);
const AUTH_DETAIL =
	/^(Login expired|Could not refresh your login|Invalid API key|Your organization has disabled)/;
const AUTH_NEEDS = /^(login required|org disabled OAuth)/;
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);
const API_DETAIL = /^(API Error|Request timed out)/;
const INVALID_NEEDS = new Set([
	"request too large — /compact or trim",
	"invalid API request — see detail",
]);
const API_NEEDS = new Set([
	"rate limited — wait and retry",
	"API overloaded — wait and retry",
	"API unavailable — retry",
	"API error — see detail",
	...INVALID_NEEDS,
]);

/**
 * @typedef {"transient"|"auth"|"invalid_request"} ApiErrorKind
 * @typedef {"PERMISSION"|"QUESTION"|"LIMIT"|"API_ERROR"|"OTHER_DIALOG"
 *   |"RESUMED_IDLE"|"UNKNOWN"} Cause  RESUMED_IDLE is read from a `working`
 *   job by resumedIdleSince, not by blockCause (workflow-core#2659)
 * @typedef {{cause: Exclude<Cause, "API_ERROR"|"RESUMED_IDLE"|"UNKNOWN">}
 *   | {cause: "API_ERROR", sub: ApiErrorKind}
 *   | {cause: "UNKNOWN", why: string}} Reading
 * @typedef {{row: unknown, job: unknown, tail: unknown}} Records
 *   `row`, the launch's `claude agents --json` row; `job`, its parsed
 *   `jobs/<id>/state.json`; `tail`, its transcript's last main-chain user and
 *   assistant rows, oldest first. Each null where it would not read.
 * @typedef {number|null|"unread"} IdleReading  resumedIdleSince's
 */

/* `any`, not `unknown`, in this file's records: the harness owns their
 * schemas, and each rule reads a field only after fieldFault has checked its
 * type. */
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {unknown} v */
const isOptionalString = (v) =>
	v === undefined || v === null || typeof v === "string";

/** @param {unknown} v */
function isCliAtLeastMin(v) {
	const m = typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
	if (!m) return false;
	const parts = m.slice(1).map(Number);
	for (const [i, min] of MIN_CLI.entries()) {
		const p = parts[i] ?? 0;
		if (p !== min) return p > min;
	}
	return true;
}

/**
 * Why the row or the job record cannot be read, or null.
 * @param {Record<string, any>} row
 * @param {Record<string, any>} job
 */
function fieldFault(row, job) {
	if (typeof row.status !== "string") return "row status is not a string";
	if (!isOptionalString(row.waitingFor))
		return "row waitingFor is not a string";
	if (!isCliAtLeastMin(job.cliVersion))
		return `cliVersion ${JSON.stringify(job.cliVersion)} is below ${MIN_CLI.join(".")}`;
	const wrong =
		["state", "tempo"].find((f) => typeof job[f] !== "string") ??
		["detail", "needs", "needsOverlay"].find((f) => !isOptionalString(job[f]));
	if (wrong) return `job ${wrong} is not a string`;
	if (job.block != null && !isObject(job.block))
		return "job block is not an object";
	if (!isObject(job.inFlight) || typeof job.inFlight.tasks !== "number")
		return "job inFlight.tasks is not a number";
	return null;
}

/**
 * @param {Record<string, any>} row
 * @returns {Record<string, any>[]}
 */
const contentOf = (row) =>
	Array.isArray(row.message?.content) ? row.message.content : [];

/** @param {Record<string, any>} row */
const textOf = (row) =>
	contentOf(row)
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");

/**
 * @typedef {{job: Record<string, any>, needs: string, detail: string,
 *   waiting: string, last: Record<string, any>|undefined,
 *   said: Record<string, any>}} Facts
 *   `waiting`, the row's `waitingFor` while its status is `waiting`; `last`,
 *   the last main-chain row; `said`, the last assistant row
 */

/** @param {Facts} f */
const isApiError = (f) => f.said.isApiErrorMessage === true;

/**
 * @type {[(f: Facts) => boolean, Reading | ((f: Facts) => Reading)][]}
 */
const RULES = [
	[(f) => PERMISSION_WAITS.has(f.waiting), { cause: "PERMISSION" }],
	[
		(f) =>
			APPROVE_TOOL.test(f.needs) &&
			f.job.state === "working" &&
			f.job.tempo === "blocked",
		{ cause: "PERMISSION" },
	],
	[
		(f) =>
			f.last?.type === "assistant" &&
			contentOf(f.last).some((b) => b?.type === "tool_use") &&
			f.job.inFlight.tasks === 0,
		{ cause: "PERMISSION" },
	],
	[
		(f) =>
			f.waiting === "input needed" ||
			(Array.isArray(f.job.block?.questions) &&
				f.job.block.questions.length > 0) ||
			f.needs === "approve plan",
		{ cause: "QUESTION" },
	],
	[
		(f) =>
			LIMIT_TEXT.test(f.detail) ||
			LIMIT_NEEDS.has(f.needs) ||
			(isApiError(f) &&
				f.said.error === "rate_limit" &&
				LIMIT_TEXT.test(textOf(f.said))),
		{ cause: "LIMIT" },
	],
	[
		(f) =>
			AUTH_DETAIL.test(f.detail) ||
			AUTH_NEEDS.test(f.needs) ||
			AUTH_ERRORS.has(f.said.error),
		{ cause: "API_ERROR", sub: "auth" },
	],
	[
		(f) => API_DETAIL.test(f.detail) || API_NEEDS.has(f.needs) || isApiError(f),
		(f) => ({
			cause: "API_ERROR",
			sub:
				INVALID_NEEDS.has(f.needs) || f.said.error === "invalid_request"
					? "invalid_request"
					: "transient",
		}),
	],
	[(f) => f.waiting === "dialog open", { cause: "OTHER_DIALOG" }],
	[(f) => f.job.tempo === "blocked", { cause: "QUESTION" }],
];

/**
 * @param {Records} records
 * @returns {Reading}
 */
function blockCause({ row, job, tail }) {
	if (!isObject(row)) return { cause: "UNKNOWN", why: "no listing row" };
	if (!isObject(job)) return { cause: "UNKNOWN", why: "no job record" };
	if (!Array.isArray(tail) || !tail.every(isObject))
		return { cause: "UNKNOWN", why: "no transcript" };
	const fault = fieldFault(row, job);
	if (fault) return { cause: "UNKNOWN", why: fault };
	/** @type {Facts} */
	const facts = {
		job,
		needs: job.needs ?? "",
		detail: job.detail ?? "",
		/* The listing gives `waitingFor` only on a `waiting` row (workflow-core#2358 F1);
		 * the `status` test keeps it to `waiting` rows should a later CLI
		 * widen it. */
		waiting: row.status === "waiting" ? (row.waitingFor ?? "") : "",
		last: tail.at(-1),
		said: tail.findLast((t) => t.type === "assistant") ?? {},
	};
	const hit = RULES.find(([matches]) => matches(facts));
	if (!hit) return { cause: "UNKNOWN", why: "no rule matched" };
	const [, reading] = hit;
	return typeof reading === "function" ? reading(facts) : reading;
}

/* The transcript rows that show a turn ran (workflow-core#2659). */
const TURN_ROWS = new Set(["assistant", "api-request"]);
/* The harness's own record of a restart, written when it starts a session
 * again after its process died (workflow-core#2976 F2): a meta row where a turn was in
 * flight, a stopped-shell notification where a background shell ran. */
const RESTART_PROMPT =
	"Continue from where you left off. Note: this session was automatically restarted";
const RESTART_SHELL =
	"Background shell command didn't finish before the previous session ended";

/** @param {Record<string, any>} row */
const rowText = (row) =>
	typeof row.message?.content === "string" ? row.message.content : textOf(row);

/** @param {unknown} row */
function isRestartRow(row) {
	if (!isObject(row) || row.type !== "user") return false;
	const text = rowText(row);
	if (row.isMeta === true) return text.startsWith(RESTART_PROMPT);
	return (
		row.origin?.kind === "task-notification" &&
		text.includes("<status>stopped</status>") &&
		text.includes(RESTART_SHELL)
	);
}

/**
 * When a `working` job's harness restarted it and no turn has run since, ms:
 * its RESUMED_IDLE reading (workflow-core#2659, workflow-core#2978), the time of the last restart row
 * after the last `api-request` or assistant row. No other user row starts the
 * clock: a delivery row, one tool result of a parallel batch or a stale
 * notification starts no turn (workflow-core#2976 F3). Null where the job is not working
 * or holds no such row; "unread" where a record will not read, has an
 * unexpected shape or holds neither a user nor a turn row, so the caller
 * holds what it knew (workflow-core#2847). The row's own timestamp, never the
 * transcript's mtime, which the attachment and cost-state rows written after
 * a resume move.
 * @param {{job: unknown, rows: unknown}} records  `job`, the parsed
 *   state.json; `rows`, lib/transcript.js's main-chain records in file
 *   order, null unread
 * @returns {IdleReading}
 */
function resumedIdleSince({ job, rows }) {
	if (!isObject(job) || typeof job.state !== "string") return "unread";
	if (job.state !== "working") return null;
	if (!Array.isArray(rows)) return "unread";
	if (
		!rows.some(
			(r) => isObject(r) && (r.type === "user" || TURN_ROWS.has(r.type)),
		)
	)
		return "unread";
	const turn = rows.findLastIndex((r) => isObject(r) && TURN_ROWS.has(r.type));
	const restart = rows.slice(turn + 1).findLast(isRestartRow);
	if (!restart) return null;
	const at =
		typeof restart.timestamp === "string"
			? Date.parse(restart.timestamp)
			: Number.NaN;
	return Number.isNaN(at) ? "unread" : at;
}

/**
 * Whether `rows` hold an `api-request` or assistant row stamped after `at`,
 * ms: a turn the session took after the loop's resume, whatever user rows
 * followed it (workflow-core#2979). False where `rows` is unread.
 * @param {unknown} rows  as resumedIdleSince's
 * @param {number} at
 */
function turnedSince(rows, at) {
	return (
		Array.isArray(rows) &&
		rows.some(
			(r) =>
				isObject(r) &&
				TURN_ROWS.has(r.type) &&
				typeof r.timestamp === "string" &&
				Date.parse(r.timestamp) > at,
		)
	);
}

module.exports = { blockCause, resumedIdleSince, turnedSince };
