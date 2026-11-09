/*
 * record-ticket.js — a landing-queue ticket keyed by a record in the markers
 * directory (lib/stall-ticket.js, lib/alarm-ticket.js, lib/queue-alert.js),
 * filed and closed as lib/queue-issue.js does. The tender decides when to
 * close and what to file; this reads the record, drops a torn one and names
 * it, and writes the record only once the issue act has succeeded, so an act
 * that throws keeps the old record and the next pass retries it.
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { queueIssueCloser, queueIssueFiler } = require("./queue-issue.js");

/**
 * A ticket's record: null where none is, "torn" where `parse` finds none in
 * it or it will not parse. A read failing for any reason but absence throws.
 * @template T
 * @param {string} file
 * @param {(rec: unknown) => T|null} parse null where the record is torn
 * @returns {T|null|"torn"}
 */
function readTicketRecord(file, parse) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (/** @type {{code?: unknown}} */ (e).code === "ENOENT") return null;
		throw e;
	}
	try {
		return parse(JSON.parse(text)) ?? "torn";
	} catch {
		/* Torn by a hand edit: the caller names it and drops it (#4485). */
		return "torn";
	}
}

/**
 * @template T
 * @typedef {object} RecordTicket
 * @property {(said: string[]) => T|null|"torn"} read the record, a torn one
 *   removed and named in `said`
 * @property {(title: string, why: (body: string) => string|null,
 *   next: T|null, said: string[]) => void} close closes the open issue titled
 *   `title`, then writes `next`, or removes the record where it is null
 * @property {(title: string, body: string, next: T, said: string[]) => void}
 *   file files or refreshes the issue titled `title`, then writes `next`
 */

/**
 * @template T
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {object} spec
 * @param {string} spec.record the record's path
 * @param {(rec: unknown) => T|null} spec.parse null where the record is torn
 * @param {string} spec.noun what its lines and refreshes call the ticket
 * @param {string} spec.standalone why it sits under no parent
 * @param {string} spec.subject what a refusal names it filed for
 * @param {string} [spec.tornNote] what a dropped record leaves open, after
 *   the line naming it
 * @returns {RecordTicket<T>}
 */
function recordTicket(
	deps,
	{ record, parse, noun, standalone, subject, tornNote = "" },
) {
	const fileIssue = queueIssueFiler(deps);
	const closeIssue = queueIssueCloser(deps);
	/** @param {T|null} next */
	const save = (next) =>
		next === null
			? fs.rmSync(record, { force: true })
			: writeFileAtomic(record, `${JSON.stringify(next)}\n`, { mkdir: true });
	return {
		read(said) {
			const rec = readTicketRecord(record, parse);
			if (rec === "torn") {
				fs.rmSync(record, { force: true });
				said.push(
					`${noun}: ${record} would not parse and is dropped${tornNote}.`,
				);
			}
			return rec;
		},
		close(title, why, next, said) {
			const closed = closeIssue(title, why);
			save(next);
			if (closed !== null) said.push(`${noun}: closed #${closed}.`);
		},
		file(title, body, next, said) {
			said.push(fileIssue({ title, standalone, noun, subject }, body));
			save(next);
		},
	};
}

module.exports = { recordTicket };
