const { isLockoutText } = require("./core-fault.js");
const { parseFirstLine } = require("./first-line.js");
const { isMachineWrittenPrompt } = require("./founder-typing.js");
const { HOLD_PROMPT } = require("./loop-prompts.js");
const { parseStatus } = require("./status-marker.js");
const { isTurnRow } = require("./transcript.js");

const MIN_CLI = [2, 1, 293];

const PERMISSION_WAITS = new Set([
	"permission prompt",
	"sandbox request",
	"worker request",
]);
const APPROVE_TOOL = /^approve (?!plan$)[^:]+: /;
const LIMIT_OPENING = "^You've (hit|reached) your ";
const LIMIT_TEXT = new RegExp(`${LIMIT_OPENING}.*limit`);
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
const BILLING_TEXT = /can't use your Claude subscription/;
const BILLING_NEEDS = /^can't use subscription — pay or renew/;
const EDGE_BLOCK = /API Error: 403\b.*\bCloudflare\b/s;
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
 * @typedef {"5-hour"|"weekly"} LimitBar
 * @typedef {"PERMISSION"|"QUESTION"|"LIMIT"|"API_ERROR"|"OTHER_DIALOG"
 *   |"LOCKED_OUT"|"RESUMED_IDLE"|"SYNTHETIC_STOP"|"UNKNOWN"} Cause
 * @typedef {{tool_name: unknown, tool_input: unknown}} RefusedCall
 * @typedef {{refusal: string, call: RefusedCall|null}} Lockout
 * @typedef {{cause: Exclude<Cause,
 *   "API_ERROR"|"LIMIT"|"LOCKED_OUT"|"RESUMED_IDLE"|"SYNTHETIC_STOP"|"UNKNOWN">}
 *   | {cause: "LIMIT", bar?: LimitBar}
 *   | {cause: "API_ERROR", sub: ApiErrorKind, billing?: true}
 *   | {cause: "LOCKED_OUT", lockout: Lockout}
 *   | {cause: "UNKNOWN", why: string}} Reading
 * @typedef {{row: unknown, job: unknown, tail: unknown}} Records
 * @typedef {number|null|"unread"} IdleReading
 */

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
 * @param {Record<string, any>} row
 * @param {Record<string, any>} job
 * @param {unknown} cliVersion
 */
function fieldFault(row, job, cliVersion) {
	if (row.status == null && row.state == null)
		return "row carries neither status nor state";
	if (typeof row.state !== "string") return "row state is not a string";
	if (!isOptionalString(row.status)) return "row status is not a string";
	if (!isOptionalString(row.waitingFor))
		return "row waitingFor is not a string";
	if (!isCliAtLeastMin(cliVersion))
		return `cliVersion ${JSON.stringify(cliVersion)} is below ${MIN_CLI.join(".")}`;
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
 * @param {import("./transcript.js").TranscriptRecord} row
 * @returns {import("./transcript.js").TranscriptBlock[]}
 */
const contentOf = (row) =>
	Array.isArray(row.message?.content) ? row.message.content : [];

/** @param {import("./transcript.js").TranscriptRecord} row */
const textOf = (row) =>
	contentOf(row)
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");

/** @param {import("./transcript.js").TranscriptRecord} row */
const rowText = (row) =>
	typeof row.message?.content === "string" ? row.message.content : textOf(row);

const REFUSAL_HEAD = /^PreToolUse:\S+ hook error: (\[[^\]\n]*\]: )?/;

/** @param {import("./transcript.js").TranscriptBlock} block */
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
 * @param {import("./transcript.js").TranscriptRecord[]} tail
 * @returns {{text: string, call: RefusedCall|null}[]}
 */
function resultsOf(tail) {
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

/** @param {import("./transcript.js").TranscriptRecord} row */
const isHoldResumeRow = (row) =>
	row.type === "user" && rowText(row).trimStart().startsWith(HOLD_PROMPT);

/**
 * @param {import("./transcript.js").TranscriptRecord[]} tail
 * @returns {Lockout|null}
 */
function lockoutOf(tail) {
	const results = resultsOf(
		tail.slice(tail.findLastIndex(isHoldResumeRow) + 1),
	);
	if (!results.every((r) => REFUSAL_HEAD.test(r.text))) return null;
	const first = results.find((r) => isLockoutText(r.text));
	return first
		? {
				refusal: parseFirstLine(first.text.replace(REFUSAL_HEAD, "")),
				call: first.call,
			}
		: null;
}

/**
 * @typedef {{job: Record<string, any>, needs: string, detail: string,
 *   waiting: string, last: import("./transcript.js").TranscriptRecord|undefined,
 *   said: import("./transcript.js").TranscriptRecord, lockout: Lockout|null}} Facts
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
			EDGE_BLOCK.test(f.detail) ||
			(isApiError(f) && EDGE_BLOCK.test(textOf(f.said))),
		{ cause: "API_ERROR", sub: "transient" },
	],
	/* #5479 */
	[
		(f) =>
			BILLING_TEXT.test(f.detail) ||
			BILLING_NEEDS.test(f.needs) ||
			(isApiError(f) && BILLING_TEXT.test(textOf(f.said))),
		{ cause: "API_ERROR", sub: "transient", billing: true },
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
	const said = tail.findLast((t) => t.type === "assistant") ?? {};
	const fault = fieldFault(row, job, job.cliVersion ?? said.version);
	if (fault) return { cause: "UNKNOWN", why: fault };
	/** @type {Facts} */
	const facts = {
		job,
		needs: job.needs ?? "",
		detail: job.detail ?? "",
		// #2358
		waiting: row.status === "waiting" ? (row.waitingFor ?? "") : "",
		last: tail.at(-1),
		said,
		lockout: lockoutOf(tail),
	};
	const hit = RULES.find(([matches]) => matches(facts));
	if (!hit) return { cause: "UNKNOWN", why: "no rule matched" };
	const [, reading] = hit;
	return typeof reading === "function" ? reading(facts) : reading;
}

const TURN_ROWS = new Set(["assistant", "api-request"]);
const RESTART_PROMPT =
	"Continue from where you left off. Note: this session was automatically restarted";
const RESTART_SHELL =
	"Background shell command didn't finish before the previous session ended";

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
 * @param {{job: unknown, rows: unknown}} records
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
 * @param {unknown} r
 * @param {number} at
 * @returns {r is import("./transcript.js").TranscriptRecord}
 */
const isRowAfter = (r, at) =>
	isObject(r) &&
	typeof r.timestamp === "string" &&
	Date.parse(r.timestamp) > at;

/**
 * @param {unknown} rows
 * @param {number} at
 */
function hasTurnedSince(rows, at) {
	return (
		Array.isArray(rows) &&
		rows.some((r) => isRowAfter(r, at) && TURN_ROWS.has(r.type))
	);
}

/** @param {import("./transcript.js").TranscriptRecord} r */
const isModelReply = (r) =>
	r.type === "assistant" && r.message?.model !== "<synthetic>";

/**
 * @param {unknown} rows
 * @param {number} at
 * @returns {boolean|null}
 */
function hasRepliedSince(rows, at) {
	if (!Array.isArray(rows)) return null;
	return rows.some((r) => isRowAfter(r, at) && isModelReply(r));
}

/**
 * @param {unknown} rows
 * @returns {number|null}
 */
function apiStopAt(rows) {
	if (!Array.isArray(rows)) return null;
	const stop = rows.findLast(
		(r) =>
			isObject(r) && r.type === "assistant" && r.isApiErrorMessage === true,
	);
	return stop && typeof stop.timestamp === "string"
		? Date.parse(stop.timestamp)
		: null;
}

/**
 * @param {unknown[]} timeline
 * @param {number} at
 */
const hasWorkedSince = (timeline, at) =>
	timeline.some(
		(r) =>
			isObject(r) &&
			r.state === "working" &&
			typeof r.at === "string" &&
			Date.parse(r.at) > at,
	);

/** @param {unknown[]} timeline */
function blockedAt(timeline) {
	const row = timeline.findLast(
		(r) => isObject(r) && r.state === "blocked" && typeof r.at === "string",
	);
	return isObject(row) && typeof row.at === "string"
		? Date.parse(row.at)
		: Number.NEGATIVE_INFINITY;
}

/**
 * @param {unknown} rows
 * @param {unknown} timeline
 * @param {number} [since]
 * @returns {boolean|null}
 */
function hasTurnSinceApiStop(rows, timeline, since) {
	if ((promptsAfterApiStop(rows)?.length ?? 0) > 0) return true;
	const at = apiStopAt(rows);
	if (at !== null)
		return Array.isArray(timeline) && hasWorkedSince(timeline, at);
	if (since === undefined || !Array.isArray(timeline)) return null;
	return hasWorkedSince(timeline, Math.max(since, blockedAt(timeline)));
}

/**
 * @param {unknown} job
 * @param {{rows: unknown, timeline: unknown, since?: number}} read
 * @returns {boolean|null}
 */
function isResumedSinceApiStop(job, { rows, timeline, since }) {
	if (isObject(job) && job.tempo === "active") return true;
	return hasTurnSinceApiStop(rows, timeline, since);
}

/**
 * @param {unknown} rows
 * @returns {string[]|null}
 */
function promptsAfterApiStop(rows) {
	const at = apiStopAt(rows);
	if (at === null || !Array.isArray(rows)) return null;
	return rows.flatMap((r) =>
		isRowAfter(r, at) && r.type === "user" && r.isMeta !== true
			? [rowText(r)].filter((t) => t.trim() !== "")
			: [],
	);
}

/**
 * @param {unknown} rows
 * @returns {boolean|null}
 */
function hasFounderTypedSinceApiStop(rows) {
	const prompts = promptsAfterApiStop(rows);
	return prompts === null
		? null
		: prompts.some((t) => !isMachineWrittenPrompt(t));
}

/**
 * @param {unknown[]} rows
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

const SYNTHETIC_MODEL = "<synthetic>";
const NO_RESPONSE_TEXT = "No response requested.";
const SYNTHETIC_STOP_STATES = new Set(["done", "stopped"]);
const ENDING_MARKERS = new Set(["result:", "needs input:"]);

/**
 * @param {{job: unknown, rows: unknown}} records
 * @returns {IdleReading}
 */
function syntheticStopAt({ job, rows: read }) {
	if (!isObject(job) || typeof job.state !== "string") return "unread";
	if (!SYNTHETIC_STOP_STATES.has(job.state)) return null;
	const rows = typeof read === "function" ? read() : read;
	if (!Array.isArray(rows) || !rows.every(isObject)) return "unread";
	const last = rows.findLastIndex(isTurnRow);
	if (last === -1) return "unread";
	const stop = /** @type {import("./transcript.js").TranscriptRecord} */ (
		rows[last]
	);
	if (
		stop.type !== "assistant" ||
		stop.message?.model !== SYNTHETIC_MODEL ||
		stop.isApiErrorMessage === true ||
		rowText(stop) !== NO_RESPONSE_TEXT
	)
		return null;
	const said = rows.slice(0, last).findLast(isModelReply);
	const marker = said ? parseStatus(textOf(said)).governing?.name : undefined;
	if (marker && ENDING_MARKERS.has(marker)) return null;
	const at =
		typeof stop.timestamp === "string"
			? Date.parse(stop.timestamp)
			: Number.NaN;
	return Number.isNaN(at) ? "unread" : at;
}

module.exports = {
	NO_RESPONSE_TEXT,
	SYNTHETIC_MODEL,
	syntheticStopAt,
	blockCause,
	hasEndedUnblocked,
	hasFounderTypedSinceApiStop,
	isResumedSinceApiStop,
	hasRepliedSince,
	hasTurnedSince,
	resumedIdleSince,
};
