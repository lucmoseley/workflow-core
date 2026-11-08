#!/usr/bin/env node
/*
 * session-scope.js — put this Claude session in a cgroup scope of its own,
 * killed whole once the session's process ends (workflow-core#4341, decided at workflow-core#4335).
 *
 * A session's processes all sit in WSL's root-owned `/non-systemd`, so a
 * descendant that outlives the session (a vitest fork worker whose main a
 * `spawnSync` timeout killed, a `setsid` child) is reparented to `/init` and
 * runs on unseen (workflow-core#4333). Every process forked inside
 * a cgroup is born in it and cannot leave a delegated one, `setsid` and double
 * forks included, and `cgroup.kill` ends them all (workflow-core#4334, probes P5, P6).
 *
 * ADOPTION. The session's process is `CLAUDE_PID` (a daemon `bg-spare`, or the
 * `claude` of a terminal session). The user manager's `StartTransientUnit`
 * with `PIDs` moves it, though it sits outside the manager's subtree (workflow-core#4334
 * P14). A move takes only the pids it names, so it names every process of the
 * session found then: the leader's descendants, and every process whose
 * environ carries `CLAUDE_PID=<leader>`, which reaches the detached jobs of
 * this same hook phase that have already been reparented to `/init`. Pass
 * follows pass until none finds a process left behind (lib's attachAll). A
 * session born inside another's scope (a nested `claude`, or a spare of a
 * daemon a session started) moves to a scope of its own the same way.
 *
 * ITS OWN SLICE. The scope sits in `wfc-sessions.slice`, not `app.slice`,
 * so CFS weighs every session together against the lander's scope as one
 * sibling, as workflow-core#2956 had it, not each session as a sibling of its own.
 *
 * THE KILL. A scope outlives its first process (workflow-core#4334 P5), and a session can
 * end with no SessionEnd (`claude stop` kills `bg-spare` and its pty host,
 * probed on workflow-core#4341), and `/clear` fires SessionEnd while the process lives on.
 * So the kill keys on the leader's exit, not on a hook: a watcher, started as
 * a transient user service and so outside the scope, polls the leader's pid
 * and start time and, once they no longer match a live process, kills the
 * scope (lib/session-scope.js's WATCH, which says what it keeps). The watcher
 * is inline shell, not a file, because the worktree that holds this script is
 * often removed as its session ends.
 *
 * WHAT LEAVES THE SCOPE: only a command started under the user manager, which
 * `systemd-run --user` does — the lander's scope (workflow-core#2956) and each test run's
 * capped one (workflow-core#3401), each bounded on its own. The session-end sweep (workflow-core#4342)
 * catches a scope whose watcher died.
 *
 * NO FAMILY (§N3): a detached job of a SessionStart launcher, not itself a
 * hook, a gate, a generator or a filer.
 *
 * Fails open: where the user manager does not answer, or `CLAUDE_PID` names
 * no live session process, it moves nothing, says why on stderr, which the
 * detaching launcher discards, and logs it to the guard-errors log, which
 * `npm run check:guard-errors` reports at the next session start.
 *
 * Usage: node scripts/session-scope.js
 * Exit codes: 0 always.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { logError } = require("./lib/arbiter-core.js");
const { readEnvironVar } = require("./lib/proc-environ.js");
const { procRoot } = require("./lib/proc-root.js");
const { readProcTable } = require("./lib/proc-table.js");
const {
	SLICE,
	attachAll,
	isSessionProcess,
	membersOf,
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
 * @param {string} proc @param {number} pid
 * @returns {string|null} the cgroup path of the v2 hierarchy's line,
 *   `hierarchy-ID:controller-list:cgroup-path` with ID 0 and no controllers
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

/** @param {string[]} args a Manager method and its signature and values */
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
 * Start the watcher that kills `unit` once `leader`, started at `startTicks`,
 * has ended. `--expand-environment=no` keeps systemd from reading the
 * shell's own `$` words as its environment variables.
 * @param {string} unit @param {number} leader @param {number} startTicks
 */
function startWatcher(unit, leader, startTicks) {
	return run(systemdRun(), [
		"--user",
		"--quiet",
		"--collect",
		"--expand-environment=no",
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
	"this session runs uncontained, its leftovers left to the session-end sweep (workflow-core#4342)";

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: boolean, line: string }} what it did, in one line
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
		/* A resume, `/clear` or compaction: the scope stands; its watcher may not. */
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
	const started = busCall([
		"StartTransientUnit",
		"ssa(sv)a(sa(sv))",
		unit,
		"fail",
		"4",
		"PIDs",
		"au",
		"1",
		String(leader),
		"Slice",
		"s",
		SLICE,
		"CollectMode",
		"s",
		"inactive-or-failed",
		"Description",
		"s",
		description,
		"0",
	]);
	if (!started.ok)
		return fault(
			`the user manager refused ${unit} (${started.err}): ${UNCONTAINED}`,
		);

	const left = () => {
		const now = readProcTable(proc);
		if (!now) return [];
		return membersOf({
			procs: now.procs,
			leader,
			home,
			self: process.pid,
			readCgroup: (pid) => readCgroup(proc, pid),
			readClaudePid: (pid) => {
				const r = readEnvironVar(pid, "CLAUDE_PID", proc);
				return r.ok ? r.value : null;
			},
		});
	};
	const moved = attachAll(
		left,
		(pids) =>
			busCall(["AttachProcessesToUnit", "ssau", unit, "", ...pidArgs(pids)]).ok,
	);
	const watch = startWatcher(unit, leader, self.startTicks);
	if (!watch.ok) {
		/* The move cannot be undone: `/non-systemd` takes no pid back (workflow-core#4334 P1). */
		return fault(
			`no session watcher for ${unit} (${watch.err}): ${UNCONTAINED}`,
		);
	}
	return done(
		`session ${String(leader)} in ${unit}, with ${String(moved)} other process(es)`,
	);
}

if (require.main === module) {
	const { ok, line } = adopt(process.env);
	writeFd(2, `session-scope: ${line}\n`);
	if (!ok) logError("session-scope.js", line);
}
