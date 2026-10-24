#!/usr/bin/env node
/*
 * start-lander.js — start a detached lander where none runs and the remote's
 * `landing` is ahead of `main` (#2405, spec #2261).
 *
 *   node scripts/start-lander.js [--tester <command>]
 *
 * The lander's output is appended to `.lander.log` in the canonical
 * checkout's markers directory. Called by start-lander-on-push.sh after a push
 * to `landing`, and by the session-start launcher, both appending this
 * script's own output there too, so its started line, naming the launching
 * session (#2478), opens the run.
 *
 * Does nothing where the `landing` module is off. Joins no §N3 family: it
 * gates nothing and is no hook.
 *
 * Exit codes: 0 started or skipped; 1 on a throw, an unreadable remote among
 * them; 2 on a command line it refuses.
 */

const path = require("node:path");
const { errorText } = require("./lib/caught.js");
const { listedAgents } = require("./lib/agent-liveness.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { landerFiles, remoteGit, short } = require("./lib/lander.js");
const {
	landerLog,
	launcherName,
	spawnDetachedRun,
	startLander,
} = require("./lib/lander-start.js");
const { pidLock } = require("./lib/pid-lock.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { moduleOffLine, moduleOn } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("start-lander.js")} [--tester <command>]`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = { usage: USAGE, flags: { "--tester": "value" } };

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
	if (!moduleOn("landing", { root })) {
		say(`SKIP: ${moduleOffLine("landing")}`);
		return 0;
	}
	const log = landerLog(root);
	let by = "";
	const result = startLander({
		holder: pidLock(landerFiles(root).pid, "lander.js").holder,
		refs: remoteGit(root).refs,
		spawnRun: () => {
			/* Named before the spawn, so the started line opens the run's log.
			 * Self-test waived: a session-start launch runs before its session
			 * lists (#2478). */
			by = launcherName(() => listedAgents({ requireSelf: false }));
			return spawnDetachedRun({
				root,
				script: path.join(__dirname, "lander.js"),
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
		`${new Date().toISOString()} started the lander, testing ${short(result.landing)} (launched by ${by}; pid ${result.started}); its output: ${log}`,
	);
	return 0;
}

if (require.main === module) {
	try {
		process.exit(main());
	} catch (err) {
		writeFd(2, `start-lander: ${errorText(err)}\n`);
		process.exit(1);
	}
}

module.exports = { main };
