#!/usr/bin/env node
/*
 * queue-wait-alarm.js — the off-machine stall check (#4443, #4458), run hourly
 * on GitHub by .github/workflows/queue-wait.yml: fails where the oldest
 * `queue/<name>` ref on the remote has waited past lib/queue-wait-alarm.js's
 * QUEUE_BACKSTOP_MS, so a stall is caught with the machine off or the refill
 * loop dead.
 *
 *   node scripts/queue-wait-alarm.js
 *
 * Reads GITHUB_API_URL, GITHUB_REPOSITORY and GH_TOKEN, as Actions sets them.
 *
 * NOT A `check-*`: runCheck's alphabet reads GitHub unreachable as SKIP, exit
 * 0, and a liveness alarm that goes green whenever it cannot read the queue
 * is silent exactly when nobody can see the machine. Its own three codes keep
 * the alphabet's meanings for the rest.
 *
 * The machine's stall check and queue alert (lib/landing-stall.js,
 * lib/queue-alert.js) are the primary ones, and this only catches a machine
 * that is down.
 *
 * Exit codes: 0 where no queue ref has waited past QUEUE_BACKSTOP_MS; 1 on a
 * stall; 2 where it could not read the queue.
 * Needs no npm install.
 */

const { buildActionsApi } = require("./lib/actions-api.js");
const { runAlarm } = require("./lib/queue-wait-alarm.js");

/** @returns {Promise<number>} */
const main = () =>
	runAlarm({
		get: (p) =>
			buildActionsApi(process.env).get(
				`/repos/${process.env.GITHUB_REPOSITORY}${p}`,
			),
		now: Date.now(),
		say: (line) => process.stdout.write(`${line}\n`),
	});

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			process.stderr.write(`queue-wait-alarm: ${e}\n`);
			process.exitCode = 2;
		},
	);

module.exports = { main };
