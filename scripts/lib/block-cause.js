/*
 * block-cause.js — why a launched session the listing shows `blocked` is
 * blocked (#2699, spec #2695; rules from #2358 F9, first match wins).
 *
 * Pure: the caller reads the three records and passes them in.
 *
 * UNKNOWN IS THE FAIL-SAFE: an unread record or a field of an unexpected type
 * reads UNKNOWN, on which the loop acts on nothing (#2358 F9) until a restart
 * kills the session, whose resume then asks it what it waits on (#3980).
 *
 * PERMISSION IS TESTED FIRST: a new prompt can open over a stale question
 * `needs` (#2358 F3).
 *
 * LOCKED_OUT IS TESTED BEFORE QUESTION (#4228): a session every one of whose
 * tool calls a guard refused, at least one for want of a guard that could
 * judge it, writes `needs input:` over a fault no answer of the founder's
 * mends. A session with a passed call reads on as before, its lockout, if any,
 * met after it reached its ticket (#4202's ruling).
 */

const { LOCKOUT_TEXTS } = require("./core-fault.js");
const { isMachineWrittenPrompt } = require("./founder-typing.js");
const { parseStatus } = require("./status-marker.js");

/* Below it the transcript carries no `permissionDecision` (#2358 F8). */
const MIN_CLI = [2, 1, 293];

const PERMISSION_WAITS = new Set([
	"permission prompt",
	"sandbox request",
	"worker request",
]);
/* A tool approval's `needs` (#2358 F3; #2699's live reading). */
const APPROVE_TOOL = /^approve (?!plan$)[^:]+: /;
const LIMIT_OPENING = "^You've (hit|reached) your ";
const LIMIT_TEXT = new RegExp(`${LIMIT_OPENING}.*limit`);
/* The bar a limit text names: the 5-hour bar is its "session limit" (#2128). */
const LIMIT_BARS = /** @type {const} */ ([
	[new RegExp(`${LIMIT_OPENING}session limit`), "5-hour"],
	[new RegExp(`${LIMIT_OPENING}weekly limit`), "weekly"],
]);
const LIMIT_NEEDS = new Set([
	"usage limit reached — check plan",
	"choose: continue on usage credits or switch models",
]);
const AUTH_DETAIL =
	/^(Login expired|Could not refresh your login|Invalid API key|Your organization has disabled)/;
const AUTH_NEEDS = /^(login required|org disabled OAuth)/;
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);
/* The `needs` a dialog writes to the job record, the one mark a parked row
 * keeps of it: 2.1.311's `dialog open` table, its managed-settings emit and
 * its startup-wedge watchdog, read from the binary (#3252). A dialog the
 * table gives no `needs` never blocks the job, so a parked row never shows
 * it. Residual: a later CLI's reworded or new `needs` reads QUESTION. */
const DIALOG_NEEDS = new Set([
	"acknowledge the classifier billing notice (Enter continues in auto mode)",
	"choose: run ultraplan in the cloud",
	"choose: make auto mode the default permission mode",
	"choose: retry on fallback model or edit prompt",
	"review: managed settings change",
	"open this session to continue setup",
]);
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
 * @typedef {"5-hour"|"weekly"} LimitBar  the bar a LIMIT's text names, where
 *   it names one
 * @typedef {"PERMISSION"|"QUESTION"|"LIMIT"|"API_ERROR"|"OTHER_DIALOG"
 *   |"LOCKED_OUT"|"RESUMED_IDLE"|"UNKNOWN"} Cause  RESUMED_IDLE is read from
 *   a `working` job by resumedIdleSince, not by blockCause (#2659)
 * @typedef {{tool_name: unknown, tool_input: unknown}} RefusedCall  the call
 *   a lockout's first refusal answered, as the session made it
 * @typedef {{refusal: string, call: RefusedCall|null}} Lockout  `refusal`,
 *   that refusal's first line; `call`, null where its call is not in the
 *   transcript
 * @typedef {{cause: Exclude<Cause,
 *   "API_ERROR"|"LIMIT"|"LOCKED_OUT"|"RESUMED_IDLE"|"UNKNOWN">}
 *   | {cause: "LIMIT", bar?: LimitBar}
 *   | {cause: "API_ERROR", sub: ApiErrorKind}
 *   | {cause: "LOCKED_OUT", lockout: Lockout}
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
	/* 2.1.310's row for a parked session carries `state` and neither `status`
	 * nor `waitingFor` (#3200). */
	if (row.status == null && row.state == null)
		return "row carries neither status nor state";
	if (typeof row.state !== "string") return "row state is not a string";
	if (!isOptionalString(row.status)) return "row status is not a string";
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

/* The head the harness gives a call a PreToolUse hook refused, and the
 * command an exit-2 refusal's text names after it. */
const REFUSAL_HEAD = /^PreToolUse:\S+ hook error: (\[[^\]\n]*\]: )?/;

/**
 * A tool result's text.
 * @param {Record<string, any>} block
 */
function resultText(block) {
	const { content } = block;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
				.filter((c) => c?.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n")
		: "";
}

/**
 * A refusal's first line, past the head the harness gives it.
 * @param {string} text
 */
const refusalLineOf = (text) =>
	(
		text
			.replace(REFUSAL_HEAD, "")
			.split("\n")
			.find((l) => l.trim() !== "") ?? ""
	).trim();

/**
 * Each tool result's text in `tail`, with the call it answers.
 * @param {Record<string, any>[]} tail
 * @returns {{text: string, call: RefusedCall|null}[]}
 */
function readResults(tail) {
	/** @type {Map<unknown, RefusedCall>} */
	const calls = new Map();
	const results = [];
	for (const r of tail)
		for (const b of contentOf(r)) {
			if (r.type === "assistant" && b?.type === "tool_use")
				calls.set(b.id, { tool_name: b.name, tool_input: b.input });
			else if (r.type === "user" && b?.type === "tool_result")
				results.push({
					text: resultText(b),
					call: calls.get(b.tool_use_id) ?? null,
				});
		}
	return results;
}

/**
 * The session's lockout, read off its transcript: its first refusal for want
 * of a guard that could judge the call, where every call's result is a hook's
 * refusal. Null where one passed, or none is such a refusal.
 * @param {Record<string, any>[]} tail
 * @returns {Lockout|null}
 */
function readLockout(tail) {
	const results = readResults(tail);
	if (!results.every((r) => REFUSAL_HEAD.test(r.text))) return null;
	const first = results.find((r) =>
		LOCKOUT_TEXTS.some((t) => r.text.includes(t)),
	);
	return first
		? { refusal: refusalLineOf(first.text), call: first.call }
		: null;
}

/**
 * @typedef {{job: Record<string, any>, needs: string, detail: string,
 *   waiting: string, last: Record<string, any>|undefined,
 *   said: Record<string, any>, lockout: Lockout|null}} Facts
 *   `waiting`, the row's `waitingFor` while its status is `waiting`; `last`,
 *   the last main-chain row; `said`, the last assistant row; `lockout`,
 *   readLockout's
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
		(f) => f.lockout !== null,
		(f) => ({
			cause: "LOCKED_OUT",
			lockout: /** @type {Lockout} */ (f.lockout),
		}),
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
		(f) => {
			const said = isApiError(f) ? textOf(f.said) : "";
			const hit = LIMIT_BARS.find(([text]) =>
				[f.detail, said].some((t) => text.test(t)),
			);
			return hit ? { cause: "LIMIT", bar: hit[1] } : { cause: "LIMIT" };
		},
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
	[
		(f) => f.waiting === "dialog open" || DIALOG_NEEDS.has(f.needs),
		{ cause: "OTHER_DIALOG" },
	],
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
		/* The listing gives `waitingFor` only on a `waiting` row (#2358 F1);
		 * the `status` test keeps it to `waiting` rows should a later CLI
		 * widen it. */
		waiting: row.status === "waiting" ? (row.waitingFor ?? "") : "",
		last: tail.at(-1),
		said: tail.findLast((t) => t.type === "assistant") ?? {},
		lockout: readLockout(tail),
	};
	const hit = RULES.find(([matches]) => matches(facts));
	if (!hit) return { cause: "UNKNOWN", why: "no rule matched" };
	const [, reading] = hit;
	return typeof reading === "function" ? reading(facts) : reading;
}

/* The transcript rows that show a turn ran (#2659). */
const TURN_ROWS = new Set(["assistant", "api-request"]);
/* The harness's own record of a restart, written when it starts a session
 * again after its process died (#2976 F2): a meta row where a turn was in
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
 * its RESUMED_IDLE reading (#2659, #2978), the time of the last restart row
 * after the last `api-request` or assistant row. No other user row starts the
 * clock: a delivery row, one tool result of a parallel batch or a stale
 * notification starts no turn (#2976 F3). Null where the job is not working
 * or holds no such row; "unread" where a record will not read, has an
 * unexpected shape or holds neither a user nor a turn row, so the caller
 * holds what it knew (#2847). The row's own timestamp, never the
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
 * Whether `r` is a row stamped after `at`, ms.
 * @param {unknown} r
 * @param {number} at
 * @returns {r is Record<string, any>}
 */
const isRowAfter = (r, at) =>
	isObject(r) &&
	typeof r.timestamp === "string" &&
	Date.parse(r.timestamp) > at;

/**
 * Whether `rows` hold an `api-request` or assistant row stamped after `at`,
 * ms: a turn the session took after the loop's resume, whatever user rows
 * followed it (#2979). False where `rows` is unread.
 * @param {unknown} rows  as resumedIdleSince's
 * @param {number} at
 */
function hasTurnedSince(rows, at) {
	return (
		Array.isArray(rows) &&
		rows.some((r) => isRowAfter(r, at) && TURN_ROWS.has(r.type))
	);
}

/**
 * Whether `r` is a reply the model wrote, not the harness's `<synthetic>` error row.
 * @param {Record<string, any>} r
 */
const isModelReply = (r) =>
	r.type === "assistant" && r.message?.model !== "<synthetic>";

/**
 * Whether `rows` hold a reply the model wrote, stamped after `at`, ms: the
 * work a resume bought (#3792). A resume its limit refuses writes only the
 * harness's `<synthetic>` error row, so hasTurnedSince cannot tell the two
 * apart.
 * Null where `rows` is unread.
 * @param {unknown} rows  as resumedIdleSince's
 * @param {number} at
 * @returns {boolean|null}
 */
function hasRepliedSince(rows, at) {
	if (!Array.isArray(rows)) return null;
	return rows.some((r) => isRowAfter(r, at) && isModelReply(r));
}

/**
 * Whether a session no longer running took a turn after `since`, ms, and that turn
 * left it unblocked (#3940): its last user or assistant row, machine-written
 * prompts aside (lib/founder-typing.js), a reply the model wrote after `since`,
 * calling no tool, whose governing status marker is not `needs input:`. A pending
 * tool call is a permission or question prompt, the harness's own row a limit or
 * API stop, and his trailing prompt a turn never answered. Its last reply from
 * before `since` is the park itself, whatever it says.
 * @param {unknown[]} rows  lib/transcript.js's main-chain records, in file order
 * @param {number} since
 */
function hasEndedUnblocked(rows, since) {
	const last = rows.findLast(
		(r) =>
			isObject(r) &&
			(r.type === "assistant" ||
				(r.type === "user" && !isMachineWrittenPrompt(rowText(r)))),
	);
	return (
		isRowAfter(last, since) &&
		isModelReply(last) &&
		!contentOf(last).some((b) => b?.type === "tool_use") &&
		parseStatus(textOf(last)).governing?.name !== "needs input:"
	);
}

module.exports = {
	blockCause,
	hasEndedUnblocked,
	hasRepliedSince,
	hasTurnedSince,
	resumedIdleSince,
};
