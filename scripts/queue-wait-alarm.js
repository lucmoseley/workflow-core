#!/usr/bin/env node

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
