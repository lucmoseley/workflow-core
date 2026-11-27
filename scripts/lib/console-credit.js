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

// guess, workflow-core#4061
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
 * @param {string} stdout
 * @param {string|null} account
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

/** @param {string} text */
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
 * @param {OverflowSeat} seat
 * @returns {ConsoleLog}
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
		return null;
	}
}

module.exports = {
	appendConsoleRow,
	consoleLogFile,
	isConsoleReadDue,
	parseConsoleRead,
	readConsoleLog,
	readSeatAccount,
};
