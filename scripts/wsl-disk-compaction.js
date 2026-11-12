#!/usr/bin/env node
/*
 * wsl-disk-compaction.js — start the monthly WSL disk compaction without
 * killing a live session (#5044). The daily user timer
 * `wsl-disk-compaction.timer` (scripts/install-interop-watchdog.sh) runs
 * `run`; a person runs `run --now` to start one that is not due.
 *
 *   node scripts/wsl-disk-compaction.js run [--now]
 *
 * A RUN IS DUE 30 days after the last success in %LOCALAPPDATA%\wsl-compact.log
 * (lib/wsl-disk.js). A due run:
 *   1. runs the sparse watch, which files a `takes:wayfinder` ticket per new
 *      trigger and changes nothing on the machine (#5041 Q1 (B));
 *   2. holds the refill loop's launches, renewing the hold each poll, until no
 *      session is live; after MAX_WAIT_MS it releases the hold, logs
 *      `deferred`, and the next day's timer tries again;
 *   3. trims the guest (`fstrim -av` as root), since the VHDX learns which
 *      blocks are free only from a trim (docs/environment.md §1);
 *   4. starts the Windows task "WSL Disk Compaction"
 *      (win-interop-watchdog/compact-disk.ps1), whose `wsl --shutdown` ends
 *      this process. It releases the hold once WSL is back.
 *
 * check-wsl-disk.js, on `npm run status`, is what makes a missed run loud.
 *
 * Joins no §N3 family: a launcher, not a checker or a guard.
 *
 * Exit codes: 0 started, not due or not WSL; 1 deferred or a step failed;
 * 2 on a command line.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const {
	isTerminalAgent,
	readAgentsForCompaction,
} = require("./lib/agent-liveness.js");
const { ghJson, parseErrLine } = require("./lib/gh.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const {
	WSL_BUDGET_MS,
	WSL_EXE,
	readInstalled,
} = require("./lib/wsl-version.js");
const disk = require("./lib/wsl-disk.js");
const { writeFd } = require("./lib/write-fd.js");

const TASK = "WSL Disk Compaction";
const SCHTASKS = "/mnt/c/Windows/System32/schtasks.exe";

/** refill-loop.js's HOLD_MAX_MINUTES; renewed each poll, so never lapses. */
const HOLD_MINUTES = 60;
/** Untraced: one poll a few minutes apart costs one listing read. */
const POLL_MS = 5 * 60_000;
/** Untraced: the timer fires at 02:00, so a wait ends by morning. */
const MAX_WAIT_MS = 6 * 3_600_000;

const USAGE = `usage: node ${scriptPath("wsl-disk-compaction.js")} run [--now]`;

/**
 * @typedef {{
 *   now: () => number,
 *   isWsl: () => boolean,
 *   readEntries: () => import("./lib/wsl-disk.js").Entry[] | null,
 *   appendLine: (line: string) => void,
 *   sparseWatch: () => string[],
 *   liveSessions: () => number | {why: string},
 *   hold: () => string | null,
 *   release: () => string | null,
 *   sleep: (ms: number) => void,
 *   trim: () => {out: string, error: string | null},
 *   startTask: () => string | null,
 *   say: (line: string) => void,
 * }} Ports
 */

/**
 * One run, every effect behind a port.
 * @param {Ports} ports
 * @param {{force: boolean}} opts
 * @returns {number}
 */
function runCompaction(ports, { force }) {
	const skipped = skipCode(ports, force);
	if (skipped !== null) return skipped;
	for (const line of ports.sparseWatch()) ports.say(`sparse watch: ${line}`);
	const drained = drain(ports);
	if (drained !== null) return drained;
	const trimmed = ports.trim();
	ports.say(
		trimmed.error === null
			? `trimmed: ${trimmed.out.replace(/\s+/g, " ")}`
			: `fstrim failed, compacting untrimmed: ${trimmed.error}`,
	);
	const started = ports.startTask();
	if (started !== null) return fail(ports, "schtasks", started);
	ports.say(`started "${TASK}"; WSL shuts down now.`);
	return 0;
}

/**
 * The exit of a run that does nothing, or null where it goes ahead.
 * @param {Ports} ports
 * @param {boolean} force
 * @returns {number | null}
 */
function skipCode(ports, force) {
	if (!ports.isWsl()) {
		ports.say("not WSL; nothing to compact.");
		return 0;
	}
	const entries = ports.readEntries();
	if (entries === null) {
		ports.say(
			"no wsl-compact.log on the Windows side, so the task is not registered: run `bash scripts/install-interop-watchdog.sh`.",
		);
		return 1;
	}
	if (force || disk.isDue(entries, ports.now())) return null;
	ports.say(`not due: last success ${disk.lastSuccess(entries)?.line}.`);
	return 0;
}

/**
 * Holds launches until no session is live, renewing the hold each poll: null
 * once none is, else the exit, the hold released. A listing that cannot be
 * read counts as live.
 * @param {Ports} ports
 * @returns {number | null}
 */
function drain(ports) {
	const start = ports.now();
	for (;;) {
		const held = ports.hold();
		if (held !== null) return fail(ports, "hold", held);
		const live = ports.liveSessions();
		if (live === 0) return null;
		const shown = typeof live === "number" ? `${live} live` : live.why;
		if (ports.now() - start >= MAX_WAIT_MS) {
			const released = ports.release();
			ports.appendLine(`deferred sessions=${shown.replace(/\s+/g, "_")}`);
			ports.say(
				`deferred: sessions still live after ${MAX_WAIT_MS / 3_600_000} h (${shown})${released ? `; the hold did not release: ${released}` : ""}.`,
			);
			return 1;
		}
		ports.say(`waiting: ${shown}; launches held.`);
		ports.sleep(POLL_MS);
	}
}

/**
 * @param {Ports} ports
 * @param {string} step
 * @param {string} why
 */
function fail(ports, step, why) {
	const released = ports.release();
	ports.appendLine(`failed step=${step} error=${why.replace(/\s+/g, "_")}`);
	ports.say(
		`${step} failed: ${why}${released ? `; release failed: ${released}` : ""}`,
	);
	return 1;
}

/**
 * The sparse watch's reads and filings, each trigger's ticket filed once.
 * @returns {string[]}
 */
function sparseWatch() {
	const installed = readInstalled(
		process.env.WFC_WSL_EXE || WSL_EXE,
		WSL_BUDGET_MS,
	);
	if ("why" in installed)
		return [`not read: wsl.exe --version: ${installed.why}`];
	let issues;
	let releases;
	try {
		issues = disk.WATCHED_ISSUES.map((n) =>
			ghJson([
				"api",
				`repos/microsoft/WSL/issues/${n}`,
				"--jq",
				"{number, state, state_reason}",
			]),
		);
		releases = ghJson([
			"api",
			"repos/microsoft/WSL/releases?per_page=30",
			"--jq",
			"[.[] | {tag_name, body, prerelease, draft}]",
		]);
	} catch (e) {
		return [`not read: ${parseErrLine(e)}`];
	}
	const triggers = disk.judgeSparse({
		issues,
		releases,
		installed: installed.version.split(".").map(Number),
	});
	if (triggers.length === 0) return ["no trigger"];
	return triggers.map(fileTrigger);
}

/**
 * Files one trigger's ticket where none carries its title, in any state.
 * @param {import("./lib/wsl-disk.js").Trigger} t
 */
function fileTrigger(t) {
	try {
		const found = ghJson([
			"issue",
			"list",
			"--state",
			"all",
			"--search",
			`"${t.title}" in:title`,
			"--json",
			"number,title",
		]).filter((/** @type {{title: string}} */ i) => i.title === t.title);
		if (found.length > 0)
			return `${t.line} Already ticketed: #${found[0].number}.`;
	} catch (e) {
		return `${t.line} Not filed: the dedupe search failed: ${parseErrLine(e)}`;
	}
	const body = `${t.line}\n\n## Question\n\nShould \`ext4.vhdx\` be converted to sparse now (\`wsl --manage Ubuntu --set-sparse true\`, with \`sparseVhd=true\` in \`.wslconfig\`)? #5041 Q1 ruled (A), monthly compaction, and kept (B) waiting on microsoft/WSL#41837's fix. Re-read #41837, #42179 and #10609, and the release notes, before pricing it.\n\nFiled by \`scripts/wsl-disk-compaction.js\`'s sparse watch (#5044).\n`;
	const r = runFileIssue(t.title, body);
	return r.error === null
		? `${t.line} Filed: ${r.out}`
		: `${t.line} Not filed: ${r.error}`;
}

/**
 * @param {string} title
 * @param {string} body
 */
function runFileIssue(title, body) {
	const file = path.join(
		fs.mkdtempSync(path.join(require("node:os").tmpdir(), "wfc-sparse-")),
		"body.md",
	);
	fs.writeFileSync(file, body);
	try {
		return runCommand(process.execPath, [
			path.join(__dirname, "file-issue.js"),
			"--title",
			title,
			"--label",
			"takes:wayfinder",
			"--standalone",
			"the sparse watch of #5044, whose ticket is closed",
			"--body-file",
			file,
			"--origin",
			"disk-watch-script",
			"--no-fault",
		]);
	} finally {
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
	}
}

/** @param {string[]} args */
const refill = (args) => {
	const r = runCommand(process.execPath, [
		path.join(__dirname, "refill-loop.js"),
		"set",
		...args,
	]);
	return r.error;
};

/** @returns {number | {why: string}} */
function liveSessions() {
	const listed = readAgentsForCompaction();
	if ("why" in listed && listed.why) return { why: listed.why };
	return (listed.agents ?? []).filter((a) => !isTerminalAgent(a)).length;
}

/** @returns {Ports} */
function realPorts() {
	const logPath = disk.findLog();
	return {
		now: Date.now,
		isWsl: () => {
			try {
				return /microsoft/i.test(
					fs.readFileSync("/proc/sys/kernel/osrelease", "utf8"),
				);
			} catch {
				return false;
			}
		},
		readEntries: () =>
			logPath === null ? null : disk.parseLog(fs.readFileSync(logPath, "utf8")),
		appendLine: (line) => {
			if (logPath !== null)
				fs.appendFileSync(
					logPath,
					`${disk.buildLogLine(Date.now(), line)}\r\n`,
				);
		},
		sparseWatch,
		liveSessions,
		hold: () => refill(["--hold-launches", String(HOLD_MINUTES)]),
		release: () => refill(["--release-launches"]),
		sleep: (ms) =>
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
		trim: () =>
			runCommand(process.env.WFC_WSL_EXE || WSL_EXE, [
				"-u",
				"root",
				"fstrim",
				"-av",
			]),
		startTask: () => runCommand(SCHTASKS, ["/Run", "/TN", TASK]).error,
		say: (line) => writeFd(1, `${new Date().toISOString()} ${line}\n`),
	};
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		commands: { run: { usage: USAGE, flags: { "--now": "boolean" } } },
	});
	if (typeof parsed === "number") return parsed;
	try {
		return runCompaction(realPorts(), {
			force: parsed.flags["--now"] === true,
		});
	} catch (e) {
		writeFd(2, `wsl-disk-compaction: ${caught(e).message}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { MAX_WAIT_MS, runCompaction };
