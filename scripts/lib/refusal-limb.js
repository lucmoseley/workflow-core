/*
 * refusal-limb.js — what the priced-options guard's close-rivals and
 * round-check limbs share (#1719, #1753): a per-session refusal record, its
 * retirement once the founder speaks, a pass kept while another Stop hook
 * refuses its turn (#1799, #1844), a transcript read, the limb's durable
 * log, the fail-open log line naming the limb, and two pieces of refusal
 * wording: the closing `RESEND_ONLY` line and the cap-spent `lastRefusal`
 * sentence. Each limb parses its own questions; the `{ at, questions }`
 * envelope around them is this file's.
 *
 * Every failure here is logged and handed back as no answer, for the limb to
 * fail open on (mantahostels#1253).
 */

const fs = require("node:fs");

const hookBlock = require("./hook-block");
const { caught } = require("./caught.js");
const { failOpenLogger } = require("./fail-open-logger");

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A question a passing send carried: its round number and when it passed. The
 * record keeps it while another Stop hook refuses its turn, which the limb
 * cannot see, so the re-send is neither judged nor logged again (#1799).
 * @typedef {{ number: string, passedAt: number }} Passed
 */

/**
 * @template Q
 * @param {Q | Passed} q
 * @returns {q is Passed}
 */
const isPassed = (q) => isObject(q) && "passedAt" in q;

/**
 * The round numbers `record` holds as passed; none where there is no record
 * or it will not read.
 * @template Q
 * @param {{ questions: (Q | Passed)[] } | null | "unreadable"} record
 * @returns {string[]}
 */
const passedNumbers = (record) =>
	record && record !== "unreadable"
		? record.questions.filter(isPassed).map((q) => q.number)
		: [];

/**
 * @param {Record<string, unknown>} question
 * @returns {Passed | null}
 */
const parsePassed = ({ number, passedAt }) =>
	typeof number === "string" && typeof passedAt === "number"
		? { number, passedAt }
		: null;

/**
 * @template Q
 * @param {{ prefix: string, limb: string, skipped: string,
 *   parseQuestion: (question: Record<string, unknown>, at: number) => Q | null,
 *   log: string }} spec
 *   `prefix`, the record's counter prefix; `limb`, the name its fail-open log
 *   lines carry; `skipped`, what a record that will not read costs the limb;
 *   `parseQuestion`, one recorded question in the limb's shape, given the
 *   record's `at`, or null where it is malformed — never a pass, which this
 *   file parses; `log`, the file name of the limb's durable log in the
 *   markers directory
 */
function refusalLimb({ prefix, limb, skipped, parseQuestion, log }) {
	const where = `guard-priced-options ${limb}`;
	/** @param {string} what */
	const logFailOpen = (what) => failOpenLogger(where)?.(what);
	/** @param {string} sessionId */
	const recordPath = (sessionId) => hookBlock.counterPath(prefix, sessionId);

	/**
	 * @param {unknown} json the parsed record
	 * @returns {{ at: number, questions: (Q | Passed)[] } | null} null where
	 *   the envelope or any question is malformed
	 */
	function parseRecord(json) {
		if (
			!isObject(json) ||
			typeof json.at !== "number" ||
			!Array.isArray(json.questions)
		)
			return null;
		const { at } = json;
		/** @type {(Q | Passed)[]} */
		const questions = [];
		for (const q of /** @type {unknown[]} */ (json.questions)) {
			let parsed = null;
			if (isObject(q))
				parsed =
					q.passedAt === undefined ? parseQuestion(q, at) : parsePassed(q);
			if (parsed === null) return null;
			questions.push(parsed);
		}
		return { at, questions };
	}

	/**
	 * The session's record: null where there is none, or `"unreadable"` where
	 * it will not read or parse — logged.
	 * @param {string} sessionId
	 * @returns {{ at: number, questions: (Q | Passed)[] } | null | "unreadable"}
	 */
	function read(sessionId) {
		let text;
		try {
			text = fs.readFileSync(recordPath(sessionId), "utf8");
		} catch (e) {
			if (caught(e).code === "ENOENT") return null;
			logFailOpen(`refusal record would not be read: ${e} — ${skipped}`);
			return "unreadable";
		}
		try {
			const record = parseRecord(JSON.parse(text));
			if (record !== null) return record;
		} catch {
			/* reported below with the malformed case */
		}
		logFailOpen(`refusal record is malformed — ${skipped}`);
		return "unreadable";
	}

	/**
	 * Replace the record with `questions`, or, given none, remove it.
	 * @param {string} sessionId
	 * @param {(Q | Passed)[]} [questions]
	 */
	function write(sessionId, questions) {
		try {
			if (questions && questions.length > 0)
				fs.writeFileSync(
					recordPath(sessionId),
					JSON.stringify({ at: Date.now(), questions }),
				);
			else fs.rmSync(recordPath(sessionId), { force: true });
		} catch (e) {
			logFailOpen(`refusal record would not be written: ${e}`);
		}
	}

	/**
	 * Read the transcript through `count`, or null where it cannot say.
	 * @template T
	 * @param {string | undefined} transcript
	 * @param {string} allowed what passes for it, for the log
	 * @param {(since: typeof import("./tool-calls-since"), file: string) => T | null} count
	 * @returns {T | null}
	 */
	function fromTranscript(transcript, allowed, count) {
		if (!transcript) return null;
		try {
			/* Required here so a reader that will not load costs one logged
			 * count, never the limb (mantahostels#1253). */
			const n = count(require("./tool-calls-since"), transcript);
			if (n === null)
				logFailOpen(
					`transcript parsed to no records at ${transcript} — ${allowed}`,
				);
			return n;
		} catch (e) {
			logFailOpen(
				`transcript would not be read at ${transcript}: ${e} — ${allowed}`,
			);
			return null;
		}
	}

	/**
	 * The record, or null where the founder has spoken since it was written
	 * (#660). One holding no question has nothing to retire, and one the
	 * transcript cannot speak to is kept.
	 * @template {{ at: number, questions: unknown[] } | null | undefined} R
	 * @param {string | undefined} transcript
	 * @param {R} record
	 * @returns {R | null}
	 */
	function liveRecord(transcript, record) {
		if (!record || record.questions.length === 0) return record;
		const { at } = record;
		const spoke = fromTranscript(transcript, "record kept", (since, file) =>
			since.founderMessagesSince(file, at),
		);
		return spoke ? null : record;
	}

	/**
	 * `record` without the passes whose turn has ended — or where the
	 * transcript cannot say, since a pass kept into a new turn would leave a
	 * reused round number unjudged and unlogged.
	 * @template {{ at: number, questions: (Q | Passed)[] } | null} R
	 * @param {string | undefined} transcript
	 * @param {R} record
	 * @returns {R}
	 */
	function withoutEndedPasses(transcript, record) {
		if (!record) return record;
		/** @type {Map<number, boolean>} */
		const running = new Map();
		const isRunning = (/** @type {number} */ at) => {
			if (!running.has(at))
				running.set(
					at,
					fromTranscript(transcript, "pass retired", (since, file) =>
						since.isTurnRefusedSince(file, at),
					) === true,
				);
			return running.get(at);
		};
		return {
			...record,
			questions: record.questions.filter(
				(q) => !isPassed(q) || isRunning(q.passedAt),
			),
		};
	}

	/**
	 * The session's record as `read` gives it, less what has ended: null
	 * where the founder has spoken since it was written, and without the
	 * passes whose turn has ended.
	 * @param {string} sessionId
	 * @param {string | undefined} transcript
	 */
	function readLive(sessionId, transcript) {
		const record = read(sessionId);
		if (record === "unreadable") return record;
		return withoutEndedPasses(transcript, liveRecord(transcript, record));
	}

	/**
	 * Replace the record with the questions `record` held as passed and
	 * `numbers`, each marked passed now.
	 * @param {string} sessionId
	 * @param {{ questions: (Q | Passed)[] } | null} record as `readLive` gave
	 *   it, narrowed past `unreadable`
	 * @param {string[]} numbers
	 */
	function writePasses(sessionId, record, numbers) {
		const passedAt = Date.now();
		write(
			sessionId,
			[...new Set([...passedNumbers(record), ...numbers])].map((number) => ({
				number,
				passedAt,
			})),
		);
	}

	/**
	 * Append the events `build` makes to the limb's log, each stamped with the
	 * session. Built and written inside the try, as the log's library loads
	 * there, so one that will not load costs a logged line and changes no
	 * decision, never the guard requiring this lib (#1747).
	 * @param {string} sessionId
	 * @param {() => { round: string, kind: string }[]} build
	 */
	function appendLog(sessionId, build) {
		try {
			const events = build();
			if (events.length === 0) return;
			require("./refusal-log").appendEvents(
				hookBlock.repoRoot(),
				events.map((event) => ({ session: sessionId, ...event })),
				log,
			);
		} catch (e) {
			logFailOpen(`log ${log} would not be written: ${e}`);
		}
	}

	return { readLive, write, writePasses, fromTranscript, appendLog };
}

/**
 * What a limb's refusal says of the re-send where this refusal spends its cap,
 * in place of the refusal it would otherwise promise (#1808).
 * @param {string} work what the session does before re-sending, or "" for none
 * @param {boolean} misshapen whether the question's shape must be fixed too
 */
const lastRefusal = (work, misshapen) =>
	"This is this check's last refusal this session, so it will not refuse " +
	`the re-send: ${[work, misshapen && "fix its shape"].filter(Boolean).join(" and ")} before sending it.`;

/* The line both limbs' refusals end on. */
const RESEND_ONLY = "RE-SEND ONLY THE CORRECTED QUESTION, not the whole round.";

module.exports = {
	RESEND_ONLY,
	refusalLimb,
	isObject,
	isPassed,
	passedNumbers,
	lastRefusal,
};
