const fs = require("node:fs");
const path = require("node:path");

const ALARMS = /** @type {const} */ ([
	{ name: "Landing quiet 14h", file: "landing-quiet.yml" },
	{ name: "Queue ref waiting 2h", file: "queue-wait.yml" },
]);

// guess, workflow-core#4772
const RUN_LIMIT = 24;

/**
 * @typedef {{databaseId: number, conclusion: string|null, createdAt: string,
 *   headSha: string}} AlarmRun
 * @typedef {{name: string, run: number, at: number, count: number}} FiringAlarm
 */

/**
 * @param {string} name
 * @param {AlarmRun[]} runs
 * @param {string} main
 * @returns {FiringAlarm|null}
 */
function firingAlarm(name, runs, main) {
	/** @type {AlarmRun[]} */
	const failed = [];
	for (const r of runs) {
		if (r.headSha !== main || r.conclusion === "success") break;
		if (r.conclusion === "failure") failed.push(r);
	}
	const newest = failed[0];
	return newest === undefined
		? null
		: {
				name,
				run: newest.databaseId,
				at: Date.parse(newest.createdAt),
				count: failed.length,
			};
}

/**
 * @param {FiringAlarm} a
 * @param {number} now
 */
function buildAlarmLine({ name, run, at, count }, now) {
	const { formatHoursMin } = require("./queue-gauge.js");
	return `\`${name}\` failed on run ${run}, ${formatHoursMin(now - at)} ago${count > 1 ? `, ${count} failed runs since \`main\` last moved` : ""}`;
}

/**
 * @param {string} root
 * @returns {string|null}
 */
function readRemoteMain(root) {
	const { readRemoteHeads } = require("./lander-git.js");
	const ref = `refs/heads/${require("./landing-refs.js").VERIFIED_BRANCH}`;
	return readRemoteHeads(root, [ref], () => []).get(ref) ?? null;
}

/**
 * @param {string} root
 * @returns {{main: string|null, alarms: FiringAlarm[]}}
 */
function readFiringAlarms(root) {
	const present = ALARMS.filter(({ file }) =>
		fs.existsSync(path.join(root, ".github", "workflows", file)),
	);
	const main = present.length === 0 ? null : readRemoteMain(root);
	if (main === null) return { main, alarms: [] };
	const { gh } = require("./gh.js");
	const { VERIFIED_BRANCH } = require("./landing-refs.js");
	const { codeRepoArgs } = require("./workflow-core-config.js");
	const alarms = present.flatMap(({ name, file }) => {
		/** @type {AlarmRun[]} */
		const runs = JSON.parse(
			gh(
				[
					"run",
					"list",
					"--workflow",
					file,
					"--branch",
					VERIFIED_BRANCH,
					"--event",
					"schedule",
					"--limit",
					String(RUN_LIMIT),
					"--json",
					"databaseId,conclusion,createdAt,headSha",
					...codeRepoArgs({ root }),
				],
				{ cwd: root },
			),
		);
		const firing = firingAlarm(name, runs, main);
		return firing === null ? [] : [firing];
	});
	return { main, alarms };
}

const ALARM_NAMES = ALARMS.map((a) => a.name);

module.exports = {
	ALARMS,
	ALARM_NAMES,
	buildAlarmLine,
	readFiringAlarms,
};
