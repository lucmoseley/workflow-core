/*
 * console-credit.js — each overflow key's credit as the Console's Billing page
 * last showed it (#4071, research #4061), the anchor lib/overflow-budget-core.js
 * sizes a key from. No API gives a balance to these keys, so a Chrome child reads
 * the page (scripts/read-console-credit.js).
 *
 * THE LOG sits beside the key's ledger, one JSONL row per event:
 *
 *   {at, started: true}   a tick launched a read
 *   {at, credits: [...]}  a read that parsed
 *   {at, why}             a read that failed, which leaves the last reading held
 *
 * A read's `at` is when it began, so a run ending during the read is charged
 * against the reading rather than assumed to be in it.
 *
 * THE CADENCE: at most one attempt per key per 24 hours, failed ones included; only
 * while the key is in use or has no launch left, as a read spends the plan seat's
 * allowance; and only while that seat has room, as a Chrome child on a limited seat
 * fails (mmm-infra#42) and would use up the day's try.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readJsonl } = require("./jsonl.js");
const { isBudgetSpent } = require("./overflow-budget-core.js");
const { refillPath } = require("./refill-dir.js");

/**
 * @typedef {import("./refill-seats.js").OverflowSeat} OverflowSeat
 * @typedef {import("./overflow-budget-core.js").Credit} Credit
 * @typedef {import("./overflow-budget-core.js").ConsoleReading} ConsoleReading
 * @typedef {{reading: ConsoleReading|null, lastAttemptAt: number|null,
 *   failure: string|null}} ConsoleLog
 */

/* The ticket's "at most one read per key per day"; #4061 records it as untraced. */
const READ_EVERY_MS = 24 * 3600 * 1000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} v */
function isCalendarDate(v) {
	if (typeof v !== "string" || !DATE.test(v)) return false;
	const ms = Date.parse(`${v}T00:00:00Z`);
	return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(v);
}

/**
 * @param {unknown} v
 * @returns {v is Credit}
 */
function isCredit(v) {
	if (typeof v !== "object" || v === null) return false;
	const { remainingUsd, grantUsd, grantedOn, expiresOn } =
		/** @type {Record<string, unknown>} */ (v);
	return (
		typeof remainingUsd === "number" &&
		typeof grantUsd === "number" &&
		remainingUsd >= 0 &&
		remainingUsd <= grantUsd &&
		isCalendarDate(grantedOn) &&
		isCalendarDate(expiresOn) &&
		/** @type {string} */ (grantedOn) <= /** @type {string} */ (expiresOn)
	);
}

/**
 * Only validated numbers and dates leave here, as the child read an outside page.
 * @param {string} stdout `claude -p --output-format json`'s result
 * @param {string|null} account the plan seat's own email, which the page must show
 * @returns {{credits: Credit[]}|{why: string}}
 */
function parseConsoleRead(stdout, account) {
	const outer = parseObject(stdout);
	if (outer?.subtype !== "success" || typeof outer.result !== "string")
		return { why: "the Chrome child gave no finished result" };
	const text = outer.result.trim();
	const page = parseObject(fenceBody(text) ?? text);
	if (!page) return { why: "the Chrome child's report is no JSON object" };
	if (page.page === "sign-in")
		return { why: "the Console asked for a sign-in" };
	if (page.page === "no-browser")
		return { why: "Chrome is closed or its extension is not connected" };
	if (page.page !== "billing")
		return { why: "the Chrome child did not reach the Billing page" };
	if (account === null) return { why: "the plan seat names no account" };
	if (
		typeof page.signedInAs !== "string" ||
		page.signedInAs.toLowerCase() !== account.toLowerCase()
	)
		return { why: "the Console is signed in to another account" };
	if (!Array.isArray(page.credits) || !page.credits.every(isCredit))
		return { why: "the Promotional credits rows do not parse" };
	return {
		credits: page.credits.map(
			({ remainingUsd, grantUsd, grantedOn, expiresOn }) => ({
				remainingUsd,
				grantUsd,
				grantedOn,
				expiresOn,
			}),
		),
	};
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
function parseObject(text) {
	try {
		const v = JSON.parse(text);
		return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

/**
 * The body of a code fence, plain or `json`, wrapping all of `text`, its
 * leading whitespace cut; else undefined. Read by index: the regex
 * `/^```(?:json)?\s*([\s\S]*?)```$/` would re-read the body at every split of
 * that whitespace (#4109).
 * @param {string} text
 */
function fenceBody(text) {
	if (text.length < 6 || !text.startsWith("```") || !text.endsWith("```"))
		return;
	const open = text.startsWith("json", 3) ? 7 : 3;
	return text.slice(open, -3).trimStart();
}

/** @param {OverflowSeat} seat */
const consoleLogFile = (seat) =>
	refillPath(path.join(".overflow-ledger", `${seat.keyVar}.console.jsonl`));

/**
 * @param {OverflowSeat} seat
 * @param {Record<string, unknown>} row
 */
function appendConsoleRow(seat, row) {
	const file = consoleLogFile(seat);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/**
 * The newest reading, the newest attempt and, where the newest read to finish
 * failed, why.
 * @param {OverflowSeat} seat
 * @returns {ConsoleLog}
 * @throws where the log cannot be read
 */
function readConsoleLog(seat) {
	/** @type {ConsoleLog} */
	const log = { reading: null, lastAttemptAt: null, failure: null };
	for (const { at, credits, why } of readJsonl(consoleLogFile(seat))?.rows ??
		[]) {
		if (typeof at !== "number") continue;
		log.lastAttemptAt = Math.max(log.lastAttemptAt ?? at, at);
		if (Array.isArray(credits) && credits.every(isCredit)) {
			log.reading = { at, credits };
			log.failure = null;
		} else if (typeof why === "string") log.failure = why;
	}
	return log;
}

/**
 * @param {OverflowSeat} seat
 * @param {import("./overflow-budget.js").SeatBudget} budget
 * @param {import("./refill-decide.js").SeatReading[]} plan
 * @param {number} now
 */
function isConsoleReadDue(seat, budget, plan, now) {
	const { lastAttemptAt, running, settledUsd } = budget;
	const planSeat = plan.find((s) => s.seat === seat.dir);
	return (
		planSeat !== undefined &&
		!planSeat.weekFull &&
		!planSeat.sessionFull &&
		(lastAttemptAt === null || now - lastAttemptAt >= READ_EVERY_MS) &&
		(running > 0 || settledUsd > 0 || isBudgetSpent(budget))
	);
}

/**
 * @param {string} planDir
 */
function readSeatAccount(planDir) {
	try {
		const parsed = parseObject(
			fs.readFileSync(path.join(planDir, ".claude.json"), "utf8"),
		);
		const email = /** @type {{emailAddress?: unknown}|undefined} */ (
			parsed?.oauthAccount
		)?.emailAddress;
		return typeof email === "string" ? email : null;
	} catch {
		/* Fails closed: parseConsoleRead refuses a read with no account to match. */
		return null;
	}
}

module.exports = {
	appendConsoleRow,
	isConsoleReadDue,
	parseConsoleRead,
	readConsoleLog,
	readSeatAccount,
};
