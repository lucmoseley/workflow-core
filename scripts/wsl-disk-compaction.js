#!/usr/bin/env node
/*
 * wsl-disk-compaction.js — start the monthly WSL disk compaction without
 * killing a live session (#5044). The daily user timer
 * `wsl-disk-compaction.timer` (scripts/install-interop-watchdog.sh) runs
 * `run`; a person runs `run --now` to start one that is not due.
 *
 *   node scripts/wsl-disk-compaction.js run [--now]
 *
 * A RUN IS DUE 30 days after the last success in %LOCALAPPDATA%\wsl-compact.log.
 * A due run (lib/wsl-disk.js's runCompaction):
 *   1. runs the sparse watch, which files a `takes:wayfinder` ticket per new
 *      trigger and changes nothing on the machine (#5041 Q1 (B));
 *   2. holds the refill loop's launches, renewing the hold each poll, until no
 *      session is live; after 6 h it releases the hold, logs `deferred`, and
 *      the next night's timer tries again;
 *   3. trims the guest (`fstrim -av` as root), since the VHDX learns which
 *      blocks are free only from a trim (docs/environment.md §1);
 *   4. starts the Windows task "WSL Disk Compaction"
 *      (win-interop-watchdog/compact-disk.ps1), whose `wsl --shutdown` ends
 *      this process. It releases the hold once WSL is back.
 *
 * check-wsl-disk.js, on `npm run status`, is what makes a missed run loud.
 *
 * THE SPARSE WATCH FILES through file-issue.js, not a `report-*` program: it
 * fires at most once a trigger, with no standing finding to keep current.
 *
 * Every line goes to stderr, which the timer's journal keeps.
 *
 * WFC_PROC, WFC_WSL_COMPACT_LOG, WFC_WIN_C (lib/wsl-disk-host.js), WFC_WSL_EXE,
 * WFC_SCHTASKS and WFC_GH (lib/gh.js) inject each read and effect (§N7).
 *
 * Joins no §N3 family: a launcher, not a checker or a guard.
 *
 * Exit codes: 0 started, not due or not WSL; 1 deferred, not installed, the
 * log or kernel release unread, or a step failed; 2 on a command line.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	isTerminalAgent,
	readAgentsForCompaction,
} = require("./lib/agent-liveness.js");
const { caught } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { ghJson, parseErrLine } = require("./lib/gh.js");
const { originLabel } = require("./lib/issue-origin.js");
const { HOLD_MAX_MINUTES } = require("./lib/launch-hold.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { findTrackingIssue } = require("./lib/tracking-issue.js");
const { runCompaction, runSparseWatch } = require("./lib/wsl-disk.js");
const host = require("./lib/wsl-disk-host.js");
const {
	WSL_BUDGET_MS,
	WSL_EXE,
	readInstalled,
} = require("./lib/wsl-version.js");
const { writeFd } = require("./lib/write-fd.js");

const TASK = "WSL Disk Compaction";
const ORIGIN = "disk-watch-script";

/*
 * The launch hold's holder, compact-disk.ps1's too: refill-loop.js refuses a
 * release from a holder other than the one that held, and the ps1 runs in no
 * session.
 */
const HOLDER = "wsl-disk-compaction";

/** rescue-sessions.js's states for a session waiting on a person. */
const WAITING_STATES = new Set(["blocked", "needs_input"]);

/*
 * Untraced: WSL ships a few releases a month, so 30 reach well past any
 * installed version the currency check (check-wsl-currency.js) lets lag.
 */
const RELEASES_READ = 30;

const USAGE = `usage: node ${scriptPath("wsl-disk-compaction.js")} run [--now]`;

const wslExe = () => process.env.WFC_WSL_EXE || WSL_EXE;

/**
 * A gh read, or why it failed.
 * @param {() => any} read
 */
function ghRead(read) {
	try {
		return read();
	} catch (e) {
		return { why: parseErrLine(e) };
	}
}

/**
 * Files one trigger's ticket. file-issue.js refuses while an open issue with
 * a similar title goes unnamed, so its `--check` list is named distinct: the
 * trigger's own title was already searched for (findFiled).
 * @param {string} title
 * @param {string} body
 * @returns {string | {why: string}}
 */
function fileTicket(title, body) {
	const fileIssue = path.join(__dirname, "file-issue.js");
	const similar = runCommand(process.execPath, [fileIssue, "--check", title]);
	if (similar.error !== null) return { why: similar.error };
	const distinct = [...similar.out.matchAll(/^ *#(\d+) /gm)].map((m) => m[1]);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-sparse-"));
	const file = path.join(dir, "body.md");
	fs.writeFileSync(file, body);
	try {
		const r = runCommand(process.execPath, [
			fileIssue,
			"--title",
			title,
			"--label",
			"takes:wayfinder",
			"--standalone",
			"the sparse watch of #5044, whose ticket is closed",
			"--body-file",
			file,
			"--origin",
			ORIGIN,
			"--no-fault",
			...(distinct.length > 0 ? ["--distinct-from", distinct.join(",")] : []),
		]);
		return r.error === null ? r.out : { why: r.error };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** @type {import("./lib/wsl-disk.js").SparsePorts} */
const sparsePorts = {
	readInstalled: () => readInstalled(wslExe(), WSL_BUDGET_MS),
	readIssue: (n) =>
		ghRead(() =>
			ghJson([
				"api",
				`repos/microsoft/WSL/issues/${n}`,
				"--jq",
				"{number, state, state_reason}",
			]),
		),
	readReleases: () =>
		ghRead(() =>
			ghJson([
				"api",
				`repos/microsoft/WSL/releases?per_page=${RELEASES_READ}`,
				"--jq",
				"[.[] | {tag_name, body, prerelease, draft}]",
			]),
		),
	// The origin label, unlike `takes:`, stays on the ticket through triage.
	findFiled: (title) =>
		ghRead(
			() =>
				findTrackingIssue({ title, label: originLabel(ORIGIN) }, "all")
					?.number ?? null,
		),
	file: fileTicket,
};

/** @param {string[]} args */
function setRefill(args) {
	return runCommand(
		process.execPath,
		[path.join(__dirname, "refill-loop.js"), "set", ...args],
		{ env: { ...process.env, CLAUDE_CODE_SESSION_ID: HOLDER } },
	).error;
}

/** @returns {{live: number, waiting: number} | {why: string}} */
function readLiveSessions() {
	const listed = readAgentsForCompaction();
	if (listed.why) return { why: listed.why };
	const live = (listed.agents ?? []).filter((a) => !isTerminalAgent(a));
	return {
		live: live.length,
		waiting: live.filter((a) => WAITING_STATES.has(a.state ?? "")).length,
	};
}

/** @type {import("./lib/wsl-disk.js").RunPorts} */
const runPorts = {
	now: () => now(),
	readKernelRelease: host.readKernelRelease,
	readLog: host.readCompactLog,
	appendLine: host.appendCompactLog,
	sparseWatch: () => runSparseWatch(sparsePorts),
	readLiveSessions,
	hold: () => setRefill(["--hold-launches", String(HOLD_MAX_MINUTES)]),
	release: () => setRefill(["--release-launches"]),
	sleep: sleepSync,
	trim: () => runCommand(wslExe(), ["-u", "root", "fstrim", "-av"]),
	startTask: () =>
		runCommand(
			process.env.WFC_SCHTASKS || "/mnt/c/Windows/System32/schtasks.exe",
			["/Run", "/TN", TASK],
		).error,
	say: (line) => writeFd(2, `${new Date(now()).toISOString()} ${line}\n`),
};

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		commands: { run: { usage: USAGE, flags: { "--now": "boolean" } } },
	});
	if (typeof parsed === "number") return parsed;
	try {
		return runCompaction(runPorts, { force: parsed.flags["--now"] === true });
	} catch (e) {
		writeFd(2, `wsl-disk-compaction: ${caught(e).message}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
