#!/usr/bin/env node
const path = require("node:path");
const { parseErrorText } = require("./lib/caught.js");
const { listedAgents } = require("./lib/agent-liveness.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { landerLock, queueLanderFiles } = require("./lib/lander-files.js");
const { readOwedDrops } = require("./lib/lander-records.js");
const {
	landerLog,
	launcherName,
	readCodeRef,
	spawnDetachedRun,
	startLander,
	buildStartedLine,
} = require("./lib/lander-start.js");
const { queueBranch } = require("./lib/landing-refs.js");
const { ownerDefersDrop } = require("./lib/queue-lander.js");
const { queueGit } = require("./lib/queue-lander-adapters.js");
const { readOwningSessionState } = require("./lib/queue-owning-session.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("start-lander.js")} [--tester <command>] [--launched-by <name>]`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	flags: { "--tester": "value", "--launched-by": "value" },
};

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string[]} [argv] @returns {number} */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const root = repoRoot();
	if (root === null) {
		writeFd(2, "start-lander: not in a git checkout\n");
		return 1;
	}
	const log = landerLog(root);
	let by = "";
	/** @type {import("./lib/lander-records.js").Drop[]} */
	let owedDrops = [];
	const result = startLander({
		holder: landerLock(root).holder,
		waiting: () =>
			queueGit(root)
				.refs()
				.queue.map((q) => queueBranch(q.name)),
		owed: () => {
			owedDrops = readOwedDrops(queueLanderFiles(root).drops);
			return owedDrops.map((d) => d.ref);
		},
		deferred: (ref) => {
			const drop = owedDrops.find((d) => d.ref === ref);
			return (
				drop !== undefined &&
				ownerDefersDrop(readOwningSessionState(root, drop.name))
			);
		},
		spawnRun: () => {
			by =
				flagValue(parsed.flags, "--launched-by") ??
				launcherName(() => listedAgents({ requireSelf: false }));
			return spawnDetachedRun({
				root,
				script: path.join(__dirname, "queue-lander.js"),
				tester: flagValue(parsed.flags, "--tester"),
				log,
			});
		},
	});
	if (!("started" in result)) {
		say(`SKIP: ${result.skipped}`);
		return 0;
	}
	say(
		buildStartedLine(result, {
			at: new Date().toISOString(),
			by,
			log,
			code: readCodeRef(),
		}),
	);
	return 0;
}

if (require.main === module) {
	try {
		process.exit(main());
	} catch (err) {
		writeFd(2, `start-lander: ${parseErrorText(err)}\n`);
		process.exit(1);
	}
}

module.exports = { main };
