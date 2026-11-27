const fs = require("node:fs");

const hookBlock = require("./hook-block");
const { caught, orFallback } = require("./caught.js");
const { failOpenLogger } = require("./fail-open-logger");

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** @typedef {{ number: string, passedAt: number }} Passed */

/**
 * @template Q
 * @param {Q | Passed} q
 * @returns {q is Passed}
 */
const isPassed = (q) => isObject(q) && "passedAt" in q;

/**
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
 */
function refusalLimb({ prefix, limb, skipped, parseQuestion, log }) {
	const where = `guard-priced-options ${limb}`;
	/** @param {string} what */
	const logFailOpen = (what) => failOpenLogger(where)?.(what);
	/** @param {string} sessionId */
	const recordPath = (sessionId) => hookBlock.counterPath(prefix, sessionId);

	/**
	 * @param {unknown} json
	 * @returns {{ at: number, questions: (Q | Passed)[] } | null}
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
		const record = orFallback(() => parseRecord(JSON.parse(text)), null);
		if (record !== null) return record;
		logFailOpen(`refusal record is malformed — ${skipped}`);
		return "unreadable";
	}

	/**
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
	 * @template T
	 * @param {string | undefined} transcript
	 * @param {string} allowed
	 * @param {(file: string) => T | null} count
	 * @returns {T | null}
	 */
	function fromTranscript(transcript, allowed, count) {
		if (!transcript) return null;
		try {
			// lucmoseley/mantahostels#1253
			const n = count(transcript);
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
	 * @template {{ at: number, questions: unknown[] } | null | undefined} R
	 * @param {string | undefined} transcript
	 * @param {R} record
	 * @returns {R | null}
	 */
	function liveRecord(transcript, record) {
		if (!record || record.questions.length === 0) return record;
		const { at } = record;
		const spoke = fromTranscript(transcript, "record kept", (file) =>
			require("./tool-calls-since").founderMessagesSince(file, at),
		);
		return spoke ? null : record;
	}

	/**
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
					fromTranscript(transcript, "pass retired", (file) =>
						require("./tool-calls-since").isTurnRefusedSince(file, at),
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
	 * @param {string} sessionId
	 * @param {string | undefined} transcript
	 */
	function readLive(sessionId, transcript) {
		const record = read(sessionId);
		if (record === "unreadable") return record;
		return withoutEndedPasses(transcript, liveRecord(transcript, record));
	}

	/**
	 * @param {string} sessionId
	 * @param {{ questions: (Q | Passed)[] } | null} record
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
	 * @param {string} sessionId
	 * @param {() => { round: string, kind: string }[]} build
	 */
	function appendLog(sessionId, build) {
		try {
			// workflow-core#1747
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
 * @param {string} work
 * @param {boolean} misshapen
 */
const lastRefusal = (work, misshapen) =>
	"This is this check's last refusal this session, so it will not refuse " +
	`the re-send: ${[work, misshapen && "fix its shape"].filter(Boolean).join(" and ")} before sending it.`;

const RESEND_ONLY = "RE-SEND ONLY THE CORRECTED QUESTION, not the whole round.";

module.exports = {
	RESEND_ONLY,
	refusalLimb,
	isObject,
	isPassed,
	passedNumbers,
	lastRefusal,
};
