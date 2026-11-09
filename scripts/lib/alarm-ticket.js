/*
 * alarm-ticket.js — the one ticket the refill loop keeps open while an
 * off-machine queue alarm fires (lib/queue-alarms.js, #4772), filed as
 * lib/queue-issue.js files it, so the next /pick-next takes it first. One per
 * stall: it is closed once no alarm fires or `main` moves, so a later stall
 * files a new one.
 *
 * Its body changes only with a new failed run. A record in the markers
 * directory names the `main` sha a ticket was filed at, so a pass with no
 * alarm firing and none on record reads no tracker. Residual: a ticket filed
 * from another checkout of the same repo is closed only by that one.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { queueIssueCloser, queueIssueFiler } = require("./queue-issue.js");
const { ALARM_TITLE: TITLE, readTicketRecord } = require("./queue-tickets.js");

const RECORD = ".landing-alarm-ticket.json";

/**
 * @param {string} main
 * @param {import("./queue-alarms.js").FiringAlarm[]} alarms
 */
function buildAlarmBody(main, alarms) {
	return `## What to build

An off-machine queue alarm has failed with \`main\` at \`${main}\` (#4772):

${alarms.map((a) => `- \`${a.name}\`: run ${a.run}, created ${new Date(a.at).toISOString()}${a.count > 1 ? `, ${a.count} failed runs at this sha` : ""}`).join("\n")}

Each run's log names where to look first: \`gh run view <run> --log-failed\`.

## Acceptance criteria

- [ ] The cause is fixed, and \`main\` moves again or the alarm passes.
`;
}

/**
 * The stall on record's `main` sha; null where none is, "torn" where the file
 * will not parse.
 * @param {string} file
 * @returns {string|null|"torn"}
 */
const readAlarmRecord = (file) =>
	readTicketRecord(file, (rec) => {
		const { main } = /** @type {{main?: unknown}} */ (rec ?? {});
		return typeof main === "string" ? main : null;
	});

/**
 * Why the recorded stall's ticket closes this pass, or null where it stays:
 * no alarm fires, or `main` has moved. A torn record names no stall, so its
 * ticket closes only where no alarm fires (#4772).
 * @param {string|"torn"} rec
 * @param {string|null} main
 * @param {boolean} firing
 * @returns {string|null}
 */
function buildCloseComment(rec, main, firing) {
	if (rec === "torn")
		return firing ? null : "No queue alarm fires; its record had torn.";
	if (main !== rec) return `\`main\` moved from \`${rec}\` to \`${main}\`.`;
	return firing
		? null
		: `No queue alarm fails at \`main\`'s \`${main}\` any more.`;
}

/**
 * One supervision pass's act on the alarm ticket: close the recorded stall's
 * ticket where buildCloseComment gives a reason, then file or refresh one for
 * the alarms firing. A close that throws keeps the record, so the next pass
 * retries it; a torn record is dropped and named first.
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} markers the markers directory
 * @returns {(pass: {main: string|null,
 *   alarms: import("./queue-alarms.js").FiringAlarm[]}) => string[]} the
 *   lines naming what it did
 */
function alarmTicketTender(deps, markers) {
	const file = queueIssueFiler(deps);
	const close = queueIssueCloser(deps);
	const recordFile = path.join(markers, RECORD);
	return ({ main, alarms }) => {
		/** @type {string[]} */
		const lines = [];
		const rec = readAlarmRecord(recordFile);
		if (rec === "torn") {
			fs.rmSync(recordFile, { force: true });
			lines.push(`alarm ticket: ${recordFile} would not parse and is dropped.`);
		}
		const why =
			rec === null ? null : buildCloseComment(rec, main, alarms.length > 0);
		if (why !== null) {
			const closed = close(TITLE, () => why);
			fs.rmSync(recordFile, { force: true });
			if (closed !== null) lines.push(`alarm ticket: closed #${closed}.`);
		}
		if (alarms.length > 0 && main !== null) {
			lines.push(
				file(
					{
						title: TITLE,
						standalone:
							"The alarm ticket tracks the landing queue, not one ticket's work.",
						noun: "alarm ticket",
						subject: "the firing queue alarm",
					},
					buildAlarmBody(main, alarms),
				),
			);
			writeFileAtomic(recordFile, `${JSON.stringify({ main })}\n`, {
				mkdir: true,
			});
		}
		return lines;
	};
}

module.exports = { alarmTicketTender };
