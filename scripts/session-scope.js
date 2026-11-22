#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { logError } = require("./lib/arbiter-core.js");
const { readEnvironVar } = require("./lib/proc-environ.js");
const { procRoot } = require("./lib/proc-root.js");
const { readProcTable } = require("./lib/proc-table.js");
const {
	OUTLIVES_KEY,
	adoptedLine,
	attachThenRelease,
	isSessionProcess,
	membersOf,
	releaseUnitArgs,
	sessionUnitArgs,
	straysOf,
	unitOf,
	watcherArgv,
	watcherOf,
} = require("./lib/session-scope.js");
const {
	MANAGER_TIMEOUT_MS,
	busctl,
	systemctl,
	systemdRun,
} = require("./lib/systemd-bins.js");
const { writeFd } = require("./lib/write-fd.js");

/**
 * @param {string} proc
 * @param {number} pid
 * @returns {string|null}
 */
function readCgroup(proc, pid) {
	try {
		const text = fs.readFileSync(
			path.join(proc, String(pid), "cgroup"),
			"utf8",
		);
		for (const line of text.split("\n")) {
			const fields = line.split(":", 3);
			if (fields.length === 3 && fields[0] === "0" && fields[1] === "")
				return line.slice(3);
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * @param {string} cmd @param {string[]} args
 */
function run(cmd, args) {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		timeout: MANAGER_TIMEOUT_MS,
	});
	return {
		ok: r.status === 0,
		err: (r.stderr || r.error?.message || "").trim(),
	};
}

/** @param {number[]} pids */
const pidArgs = (pids) => [String(pids.length), ...pids.map(String)];

/** @param {string[]} args */
const busCall = (args) =>
	run(busctl(), [
		"--user",
		"call",
		"org.freedesktop.systemd1",
		"/org/freedesktop/systemd1",
		"org.freedesktop.systemd1.Manager",
		...args,
	]);

/**
 * @param {string} unit
 * @param {number} leader
 * @param {number} startTicks
 */
function startWatcher(unit, leader, startTicks) {
	return run(systemdRun(), [
		"--user",
		"--quiet",
		"--collect",
		"--expand-environment=no",
		// #4848
		"--property=OOMScoreAdjust=0",
		`--unit=${watcherOf(unit)}`,
		`--description=Kill ${unit} once session ${String(leader)} ends`,
		"--",
		...watcherArgv(leader, startTicks),
	]);
}

/** @param {string} line */
const done = (line) => ({ ok: true, line });
/** @param {string} line */
const fault = (line) => ({ ok: false, line });

const UNCONTAINED =
	"this session runs uncontained, its leftovers left to the session-end sweep (#4342)";

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: boolean, line: string }}
 */
function adopt(env) {
	const proc = procRoot();
	const leader = Number(env.CLAUDE_PID);
	if (!Number.isInteger(leader) || leader <= 1)
		return fault(`no CLAUDE_PID: ${UNCONTAINED}`);
	const table = readProcTable(proc);
	const self = table?.procs.get(leader);
	if (!table || !self || !isSessionProcess(self.argv))
		return fault(
			`CLAUDE_PID ${String(leader)} is no live Claude process: ${UNCONTAINED}`,
		);
	const unit = unitOf(leader, self.startTicks);
	const home = readCgroup(proc, leader);
	if (home?.endsWith(`/${unit}`)) {
		if (
			run(systemctl(), ["--user", "is-active", "--quiet", watcherOf(unit)]).ok
		)
			return done(`session ${String(leader)} already in ${unit}`);
		const watch = startWatcher(unit, leader, self.startTicks);
		return watch.ok
			? done(
					`session ${String(leader)} already in ${unit}; its watcher restarted`,
				)
			: fault(`no session watcher for ${unit} (${watch.err}): ${UNCONTAINED}`);
	}

	const description = `Claude session ${env.CLAUDE_CODE_SESSION_ID ?? String(leader)}`;
	const started = busCall(sessionUnitArgs(unit, leader, description));
	if (!started.ok)
		return fault(
			`the user manager refused ${unit} (${started.err}): ${UNCONTAINED}`,
		);

	/** @param {string} key */
	const environOf = (key) => (/** @type {number} */ pid) => {
		const r = readEnvironVar(pid, key, proc);
		return r.ok ? r.value : null;
	};
	const readOutlives = environOf(OUTLIVES_KEY);
	const counts = attachThenRelease({
		left: () => {
			const now = readProcTable(proc);
			if (!now) return [];
			return membersOf({
				procs: now.procs,
				leader,
				home,
				self: process.pid,
				readCgroup: (pid) => readCgroup(proc, pid),
				readClaudePid: environOf("CLAUDE_PID"),
				readOutlives,
			});
		},
		attach: (pids) =>
			busCall(["AttachProcessesToUnit", "ssau", unit, "", ...pidArgs(pids)]).ok,
		strays: () => {
			const now = readProcTable(proc);
			const scope = readCgroup(proc, leader);
			if (!now || !scope) return [];
			return straysOf({
				procs: now.procs,
				leader,
				scope,
				readCgroup: (pid) => readCgroup(proc, pid),
				readOutlives,
			});
		},
		release: (group) => busCall(releaseUnitArgs(group)).ok,
	});
	const watch = startWatcher(unit, leader, self.startTicks);
	if (!watch.ok) {
		// #4334
		return fault(
			`no session watcher for ${unit} (${watch.err}): ${UNCONTAINED}`,
		);
	}
	return adoptedLine(leader, unit, counts);
}

if (require.main === module) {
	const { ok, line } = adopt(process.env);
	writeFd(2, `session-scope: ${line}\n`);
	if (!ok) logError("session-scope.js", line);
}
