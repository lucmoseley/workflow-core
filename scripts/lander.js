#!/usr/bin/env node
/*
 * lander.js — one lander run by hand (#2402, spec #2261): while the remote's
 * `landing` is ahead of `main`, test its tip and fast-forward `main` to it on
 * green; on red, rerun, bisect, revert the confirmed culprit and file its fix
 * ticket, or hold (#2404).
 *
 *   node scripts/lander.js run [--tester <command>]
 *
 * The tester is the one `landingTester` names in .claude/workflow-core.json:
 * the local one (lib/local-tester.js), the suite in the lander's own
 * worktree, or the Actions one (lib/actions-tester.js), the suite workflow's
 * push run on `landing`, handing the local one what no push run tests.
 * `--tester` swaps in `<command> <sha> [<file>…]`, run
 * in the canonical checkout:
 * the whole suite, or only the files where they are given. Exit 0 is green,
 * exit 1 red with each non-empty stdout line a failing file, any other exit
 * no verdict.
 *
 * Does nothing where the `landing` module is off. Joins no §N3 family: it
 * gates nothing and is no hook.
 *
 * Exit codes: 0 on any exit or hold the lander reaches, a held lock and a
 * failed git call included; 1 on a throw before the run; 2 on a command line
 * it refuses.
 */

const { spawn } = require("node:child_process");
const { spawnGitSync } = require("./lib/git.js");
const { parseErrorText } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { ticketFiler } = require("./lib/fix-ticket.js");
const { gh } = require("./lib/gh.js");
const { heldQueueFiler } = require("./lib/held-queue.js");
const {
	buildActionLine,
	fileLedger,
	heartbeatWriter,
	landerFiles,
	readHeartbeat,
	remoteGit,
	runLander,
} = require("./lib/lander.js");
const { actionsTester } = require("./lib/actions-tester.js");
const { localTester } = require("./lib/local-tester.js");
const { pidLock } = require("./lib/pid-lock.js");
const { liveQueueDeps } = require("./lib/queue-issue.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	buildModuleOffLine,
	moduleOn,
	readConfig,
	requireKey,
} = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("lander.js")} run [--tester <command>]
  without --tester, the tester .claude/workflow-core.json's landingTester names
  <command> <sha> [<file>…] exits 0 green, 1 red (stdout: failing files),
  else no verdict`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	commands: { run: { usage: USAGE, flags: { "--tester": "value" } } },
};

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/**
 * @param {string} command
 * @param {string} root
 * @returns {import("./lib/lander.js").Tester}
 */
const commandTester = (command, root) => ({
	verdict: (sha, files = []) =>
		new Promise((resolve) => {
			const child = spawn(
				"sh",
				["-c", `${command} "$@"`, "tester", sha, ...files],
				{ cwd: root, stdio: ["ignore", "pipe", "inherit"] },
			);
			let out = "";
			child.stdout.on("data", (chunk) => {
				out += chunk;
			});
			child.on("error", (err) =>
				resolve({
					kind: "unknown",
					reason: `tester did not start: ${err.message}`,
				}),
			);
			child.on("close", (code, signal) => {
				if (code === 0) resolve({ kind: "green" });
				else if (code === 1)
					resolve({
						kind: "red",
						files: out
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean),
					});
				else
					resolve({
						kind: "unknown",
						reason: `tester ended ${signal ?? `exit ${code}`}`,
					});
			});
		}),
});

/**
 * The tester `landingTester` names.
 * @param {string} root
 * @returns {import("./lib/lander.js").Tester}
 */
function configuredTester(root) {
	const local = localTester({ root });
	return readConfig({ root, quiet: true }).landingTester === "actions"
		? actionsTester({ root, fallback: local })
		: local;
}

/** @param {string} root */
function liveFiler(root) {
	const repo = () => requireKey("tracker", { root });
	const deps = liveQueueDeps(root);
	return {
		...heldQueueFiler(deps),
		...ticketFiler({
			messageOf: (sha) => {
				const r = spawnGitSync(["log", "-1", "--format=%B", sha], {
					cwd: root,
					encoding: "utf8",
				});
				if (r.status !== 0)
					throw new Error(`git log could not read ${sha}: ${r.stderr.trim()}`);
				return r.stdout;
			},
			similar: deps.similar,
			fileIssue: deps.fileIssue,
			stateOf: (n) =>
				gh([
					"issue",
					"view",
					String(n),
					"--repo",
					repo(),
					"--json",
					"state",
					"--jq",
					".state",
				]).trim() === "CLOSED"
					? "closed"
					: "open",
			reopen: (n, comment) => {
				gh([
					"issue",
					"reopen",
					String(n),
					"--repo",
					repo(),
					"--comment",
					comment,
				]);
			},
		}),
	};
}

/** @param {string[]} [argv] @returns {Promise<number>} */
async function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const tester = flagValue(parsed.flags, "--tester");
	const root = repoRoot();
	if (root === null) {
		writeFd(2, "lander: not in a git checkout\n");
		return 1;
	}
	if (!moduleOn("landing", { root })) {
		say(`SKIP: ${buildModuleOffLine("landing")}`);
		return 0;
	}
	const files = landerFiles(root);
	await runLander({
		git: remoteGit(root),
		tester:
			tester === undefined
				? configuredTester(root)
				: commandTester(tester, root),
		tracker: liveFiler(root),
		ledger: fileLedger(files.ledger),
		noVerdict: fileLedger(files.noVerdict),
		lock: pidLock(files.pid, "lander.js"),
		beat: heartbeatWriter(files.heartbeat),
		lastHold: () => readHeartbeat(files.heartbeat)?.hold ?? null,
		lastRed: () => readHeartbeat(files.heartbeat)?.red ?? null,
		lastMoved: () => readHeartbeat(files.heartbeat)?.movedAt ?? null,
		log: (a) => say(`${new Date().toISOString()} ${buildActionLine(a)}`),
		say,
	});
	return 0;
}

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(err) => {
			writeFd(2, `lander: ${parseErrorText(err)}\n`);
			process.exit(1);
		},
	);

module.exports = { main };
