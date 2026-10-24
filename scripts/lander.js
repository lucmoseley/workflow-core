#!/usr/bin/env node
/*
 * lander.js — one lander run by hand (workflow-core#2402, spec workflow-core#2261): while the remote's
 * `landing` is ahead of `main`, test its tip and fast-forward `main` to it on
 * green; on red, rerun, bisect, revert the confirmed culprit and file its fix
 * ticket, or hold (workflow-core#2404).
 *
 *   node scripts/lander.js run [--tester <command>]
 *
 * The tester is the local one (lib/local-tester.js): the suite in the
 * lander's own worktree. `--tester` swaps in `<command> <sha> [<file>…]`, run
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

const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { errorText } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { ticketFiler } = require("./lib/fix-ticket.js");
const { gh, ghIssueListAll } = require("./lib/gh.js");
const { heldQueueFiler } = require("./lib/held-queue.js");
const {
	actionLine,
	fileLedger,
	heartbeatWriter,
	landerFiles,
	readHeartbeat,
	remoteGit,
	runLander,
} = require("./lib/lander.js");
const { localTester } = require("./lib/local-tester.js");
const { pidLock } = require("./lib/pid-lock.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { similarTitles } = require("./lib/tracker-ops.js");
const { refresh } = require("./lib/tracking-issue.js");
const {
	moduleOffLine,
	moduleOn,
	requireKey,
} = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("lander.js")} run [--tester <command>]
  without --tester, the suite runs in the lander's own worktree
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
 * file-issue.js run in `root`, the body on stdin.
 * @param {string} root
 * @returns {(args: string[], input: string) => import("./lib/fix-ticket.js").Ran}
 */
const fileIssueIn = (root) => (args, input) => {
	const r = spawnSync(
		process.execPath,
		[path.join(__dirname, "file-issue.js"), ...args],
		{ cwd: root, encoding: "utf8", input },
	);
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr || r.error?.message || "",
	};
};

/** @param {string} root */
function liveFiler(root) {
	const repo = () => requireKey("tracker", { root });
	const similar = (/** @type {string} */ title) => {
		try {
			return similarTitles(repo(), title).found;
		} catch {
			/* file-issue.js runs the same check itself and refuses on it. */
			return [];
		}
	};
	const held = heldQueueFiler({
		openNumber: (title) =>
			ghIssueListAll("issues", [
				"--repo",
				repo(),
				"--state",
				"open",
				"--json",
				"number,title",
			]).find((/** @type {{title: string}} */ i) => i.title === title)
				?.number ?? null,
		similar,
		fileIssue: fileIssueIn(root),
		refresh: (n, body) =>
			`held-queue issue: ${refresh(n, body, { repo: repo() })}`,
	});
	return {
		...held,
		...ticketFiler({
			messageOf: (sha) => {
				const r = spawnSync("git", ["log", "-1", "--format=%B", sha], {
					cwd: root,
					encoding: "utf8",
				});
				if (r.status !== 0)
					throw new Error(`git log could not read ${sha}: ${r.stderr.trim()}`);
				return r.stdout;
			},
			similar,
			fileIssue: fileIssueIn(root),
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
		say(`SKIP: ${moduleOffLine("landing")}`);
		return 0;
	}
	const files = landerFiles(root);
	await runLander({
		git: remoteGit(root),
		tester:
			tester === undefined
				? localTester({ root })
				: commandTester(tester, root),
		tracker: liveFiler(root),
		ledger: fileLedger(files.ledger),
		lock: pidLock(files.pid, "lander.js"),
		beat: heartbeatWriter(files.heartbeat),
		lastHold: () => readHeartbeat(files.heartbeat)?.hold ?? null,
		lastRed: () => readHeartbeat(files.heartbeat)?.red ?? null,
		log: (a) => say(`${new Date().toISOString()} ${actionLine(a)}`),
		say,
	});
	return 0;
}

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(err) => {
			writeFd(2, `lander: ${errorText(err)}\n`);
			process.exit(1);
		},
	);

module.exports = { main };
