const path = require("node:path");
const { ALARM_TITLE: TITLE } = require("./queue-tickets.js");
const { recordTicket } = require("./record-ticket.js");

const RECORD = ".landing-alarm-ticket.json";

const CRITERION =
	"The cause is fixed, and `main` moves again or the alarm passes.";

/**
 * @param {string} main
 * @param {import("./queue-alarms.js").FiringAlarm[]} alarms
 */
function buildAlarmBody(main, alarms) {
	return `## What to build

An off-machine queue alarm has failed with \`main\` at \`${main}\` (#4772):

${alarms.map((a) => `- \`${a.name}\`: run ${a.run}, created ${new Date(a.at).toISOString()}${a.count > 1 ? `, ${a.count} failed runs at this sha` : ""}`).join("\n")}

\`gh run view <run> --log-failed\`

## Acceptance criteria

- [ ] ${CRITERION}
`;
}

/** @typedef {{main: string}} AlarmRecord */

/** @param {unknown} rec @returns {AlarmRecord|null} */
function parseAlarmRecord(rec) {
	const { main } = /** @type {{main?: unknown}} */ (rec ?? {});
	return typeof main === "string" ? { main } : null;
}

/**
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
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} markers
 * @returns {(pass: {main: string|null,
 *   alarms: import("./queue-alarms.js").FiringAlarm[]}) => string[]}
 */
function alarmTicketTender(deps, markers) {
	const ticket = recordTicket(deps, {
		record: path.join(markers, RECORD),
		parse: parseAlarmRecord,
		noun: "alarm ticket",
		subject: "the firing queue alarm",
		criterion: CRITERION,
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
