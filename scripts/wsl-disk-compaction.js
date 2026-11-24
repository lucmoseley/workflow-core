#!/usr/bin/env node

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

const HOLDER = "wsl-disk-compaction";

const WAITING_STATES = new Set(["blocked", "needs_input"]);

// workflow-core#5044 guess: WSL ships a few releases a month, so 30 reach past any lag the currency check allows
const RELEASES_READ = 30;

const USAGE = `usage: node ${scriptPath("wsl-disk-compaction.js")} run [--now]`;

const wslExe = () => process.env.WFC_WSL_EXE || WSL_EXE;

/** @param {() => any} read */
function ghRead(read) {
	try {
		return read();
	} catch (e) {
		return { why: parseErrLine(e) };
	}
}

/**
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
			"the sparse watch of workflow-core#5044, whose ticket is closed",
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
