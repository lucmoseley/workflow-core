/*
 * queue-alarms.js — the agent-side reader of the two off-machine queue alarms
 * (#4772): .github/workflows/landing-quiet.yml and main-lag.yml go red on
 * GitHub, whose failure email the founder rarely reads. The morning review
 * lists each alarm firing, and the refill loop's landing supervision keeps the
 * alarm ticket (lib/alarm-ticket.js) open while one fires.
 *
 * FIRING means a failed scheduled run at `main`'s current sha with no
 * success of that workflow since: a scheduled run checks out `main`'s tip, so
 * a run at an older sha predates `main`'s last move. A checkout without the
 * workflow's file reads none of its runs.
 */

const fs = require("node:fs");
const path = require("node:path");

const ALARMS = /** @type {const} */ ([
	{ name: "Landing quiet 14h", file: "landing-quiet.yml" },
	{ name: "Queue ref waiting 2h", file: "main-lag.yml" },
]);

/* A guess: a day of hourly runs, past which a stall has long been ticketed. */
const RUN_LIMIT = 30;

/**
 * @typedef {{databaseId: number, conclusion: string|null, createdAt: string,
 *   headSha: string}} AlarmRun a `gh run list` row, newest first
 * @typedef {{name: string, run: number, at: number, count: number}}
 *   FiringAlarm the newest failed run, when it was created in ms, and how
 *   many failed since `main` last moved
 */

/**
 * The alarm a workflow's runs say fires, or null.
 * @param {string} name
 * @param {AlarmRun[]} runs newest first
 * @param {string} main `main`'s current sha
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
 * `main`'s sha on the remote of the checkout at `root`, or null where it has
 * none.
 * @param {string} root
 * @returns {string|null}
 */
function readRemoteMain(root) {
	const { readRemoteHeads } = require("./lander-git.js");
	const ref = `refs/heads/${require("./landing-refs.js").VERIFIED_BRANCH}`;
	return readRemoteHeads(root, [ref], () => []).get(ref) ?? null;
}

/**
 * The alarms firing for the checkout at `root`, read from its code repo's
 * runs; throws where a read fails. `main` is read only where an alarm's
 * workflow file is present, and none fires where the remote has no `main`.
 * @param {string} root
 * @param {() => string|null} readMain `main`'s current sha
 * @returns {FiringAlarm[]}
 */
function readFiringAlarms(root, readMain = () => readRemoteMain(root)) {
	const present = ALARMS.filter(({ file }) =>
		fs.existsSync(path.join(root, ".github", "workflows", file)),
	);
	const main = present.length === 0 ? null : readMain();
	if (main === null) return [];
	const { gh } = require("./gh.js");
	const { VERIFIED_BRANCH } = require("./landing-refs.js");
	const { codeRepoArgs } = require("./workflow-core-config.js");
	return present.flatMap(({ name, file }) => {
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
}

const ALARM_NAMES = ALARMS.map((a) => a.name);

module.exports = {
	ALARM_NAMES,
	buildAlarmLine,
	firingAlarm,
	readFiringAlarms,
	readRemoteMain,
};
