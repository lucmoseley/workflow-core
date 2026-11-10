/*
 * alarm-ticket.js — the one ticket the refill loop keeps open while an
 * off-machine queue alarm fires (lib/queue-alarms.js, workflow-core#4772), filed as
 * lib/queue-issue.js files it, so the next /pick-next takes it first. One
 * per stall.
 *
 * Its body changes only with a new failed run. A record in the markers
 * directory names the `main` sha a ticket was filed at, so a pass with no
 * alarm firing and none on record reads no tracker. Residual: a ticket filed
 * from another checkout of the same repo is closed only by that one.
 */

const path = require("node:path");
const { ALARM_TITLE: TITLE } = require("./queue-tickets.js");
const { recordTicket } = require("./record-ticket.js");

const RECORD = ".landing-alarm-ticket.json";

/**
 * @param {string} main
 * @param {import("./queue-alarms.js").FiringAlarm[]} alarms
 */
function buildAlarmBody(main, alarms) {
	return `## What to build

An off-machine queue alarm has failed with \`main\` at \`${main}\` (workflow-core#4772):

${alarms.map((a) => `- \`${a.name}\`: run ${a.run}, created ${new Date(a.at).toISOString()}${a.count > 1 ? `, ${a.count} failed runs at this sha` : ""}`).join("\n")}

\`gh run view <run> --log-failed\`

## Acceptance criteria

- [ ] The cause is fixed, and \`main\` moves again or the alarm passes.
`;
}

/**
 * @typedef {{main: string}} AlarmRecord the `main` sha the ticket was filed
 *   at
 */

/** @param {unknown} rec @returns {AlarmRecord|null} */
function parseAlarmRecord(rec) {
	const { main } = /** @type {{main?: unknown}} */ (rec ?? {});
	return typeof main === "string" ? { main } : null;
}

/**
 * Why the recorded stall's ticket closes this pass, or null where it stays:
 * no alarm fires, or `main` has moved. A torn record names no stall, so its
 * ticket closes only where no alarm fires (workflow-core#4772).
 * @param {AlarmRecord|"torn"} rec
 * @param {string|null} main
 * @param {boolean} firing
 * @returns {string|null}
 */
function buildCloseComment(rec, main, firing) {
	if (rec === "torn")
		return firing ? null : "No queue alarm fires; its record had torn.";
	if (main !== rec.main)
		return `\`main\` moved from \`${rec.main}\` to \`${main}\`.`;
	return firing
		? null
		: `No queue alarm fails at \`main\`'s \`${main}\` any more.`;
}

/**
 * One supervision pass's act on the alarm ticket: close the recorded stall's,
 * then file or refresh one for the alarms firing. A close that throws keeps
 * the record, so the next pass retries it; a torn record is dropped and named
 * first.
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} markers the markers directory
 * @returns {(pass: {main: string|null,
 *   alarms: import("./queue-alarms.js").FiringAlarm[]}) => string[]} the
 *   lines naming what it did
 */
function alarmTicketTender(deps, markers) {
	const ticket = recordTicket(deps, {
		record: path.join(markers, RECORD),
		parse: parseAlarmRecord,
		noun: "alarm ticket",
		subject: "the firing queue alarm",
	});
	return ({ main, alarms }) => {
		/** @type {string[]} */
		const said = [];
		const rec = ticket.read(said);
		const why =
			rec === null ? null : buildCloseComment(rec, main, alarms.length > 0);
		if (why !== null) ticket.close(TITLE, () => why, null, said);
		if (alarms.length > 0 && main !== null)
			ticket.file(TITLE, buildAlarmBody(main, alarms), { main }, said);
		return said;
	};
}

module.exports = { alarmTicketTender };
