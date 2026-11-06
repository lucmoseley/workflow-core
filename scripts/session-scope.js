#!/usr/bin/env node
/*
 * session-scope.js — put this Claude session in a cgroup scope of its own,
 * killed whole once the session's process ends (#4341, decided at #4335).
 *
 * A session's processes all sit in WSL's root-owned `/non-systemd`, so a
 * descendant that outlives the session (a vitest fork worker whose main a
 * `spawnSync` timeout killed, a `setsid` child) is reparented to `/init` and
 * runs on unseen (#4333, the 2026-11-04 incident). Every process forked inside
 * a cgroup is born in it and cannot leave a delegated one, `setsid` and double
 * forks included, and `cgroup.kill` ends them all (#4334, probes P5, P6).
 *
 * ADOPTION. The session's process is `CLAUDE_PID` (a daemon `bg-spare`, or the
 * `claude` of a terminal session). The user manager's `StartTransientUnit`
 * with `PIDs` moves it, though it sits outside the manager's subtree (#4334
 * P14). A move takes only the pids it names, so it names every process of the
 * session found then: the leader's descendants, and every process whose
 * environ carries `CLAUDE_PID=<leader>`, which reaches the detached jobs of
 * this same hook phase that have already been reparented to `/init`. A second
 * pass attaches what forked from an unmoved process during the first.
 *
 * ITS OWN SLICE. The scope sits in `wfc-sessions.slice`, not `app.slice`,
 * so CFS weighs every session together against the lander's scope as one
 * sibling, as #2956 had it, not each session as a sibling of its own.
 *
 * THE KILL. A scope outlives its first process (#4334 P5), and a session can
 * end with no SessionEnd (`claude stop` kills `bg-spare` and its pty host,
 * probed on #4341), and `/clear` fires SessionEnd while the process lives on.
 * So the kill keys on the leader's exit, not on a hook: a watcher, started as
 * a transient user service and so outside the scope, polls the leader's pid
 * and start time and, once they no longer match a live process, sends
 * SIGTERM to what is left in the scope, waits `GRACE_S`, and writes
 * `cgroup.kill`. The watcher is inline shell, not a file, because the worktree
 * that holds this script is often removed as its session ends, and a shell
 * loop holds some 4 MB where a node one would hold forty.
 *
 * WHAT LEAVES THE SCOPE: only a command started under the user manager, which
 * `systemd-run --user` does — the lander's scope (#2956) and each test run's
 * capped one (#3401), each bounded on its own. The session-end sweep (#4342)
 * catches a scope whose watcher died.
 *
 * Fails open: where the user manager does not answer, or `CLAUDE_PID` names
 * no live session process, it does nothing and says why on stderr, which the
 * detaching launcher discards.
 *
 * Usage: node scripts/session-scope.js
 * Exit codes: 0 always.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { logError } = require("./lib/arbiter-core.js");
const { isClaudeArgv0 } = require("./lib/claude-argv0.js");
const { readEnvironVar } = require("./lib/proc-environ.js");
const { procRoot } = require("./lib/proc-root.js");
const { readProcTable } = require("./lib/proc-table.js");
const { writeFd } = require("./lib/write-fd.js");

const UNIT_PREFIX = "wfc-session-";
const SLICE = "wfc-sessions.slice";
/* A guess: a user manager that has not answered in this long is read as none. */
const CALL_TIMEOUT_MS = 5000;
/* A guess at how often the watcher looks at its leader; a leftover spins at
 * most this long before the kill. */
const POLL_S = 2;
/* A guess: long enough for a git child to drop its lock on SIGTERM. */
const GRACE_S = 3;
const CGROUP_ROOT_ENV = "WFC_CGROUP_ROOT";
const SCOPE_RE = /\/wfc-session-[^/]+\.scope$/;

/**
 * The watcher, run as `sh -c WATCH sh <pid> <start> <unit>`. `alive` reads
 * the leader's stat afresh: fields 3 (state) and 22 (start time) are the
 * 1st and 20th words after the comm's closing `) `. A cgroup file's size
 * reads 0 whatever it holds, so `left` reads its text, never `-s`.
 */
const WATCH = `p=$1 start=$2 unit=$3
root=\${${CGROUP_ROOT_ENV}:-/sys/fs/cgroup}
alive() {
  { read -r s < "/proc/$p/stat"; } 2>/dev/null || return 1
  set -- \${s##*) }
  [ "$1" != Z ] && [ "$1" != X ] && [ "\${20}" = "$start" ]
}
while alive; do sleep ${POLL_S}; done
cg=$(systemctl --user show -p ControlGroup --value "$unit" 2>/dev/null)
[ -n "$cg" ] || exit 0
d="$root$cg"
left() { [ -n "$(cat "$d/cgroup.procs" 2>/dev/null)" ]; }
left || exit 0
echo "session $p ended; killing what is left in $unit:" $(cat "$d/cgroup.procs")
systemctl --user kill --signal=SIGTERM "$unit" 2>/dev/null
i=0
while left && [ $i -lt ${GRACE_S} ]; do sleep 1; i=$((i + 1)); done
[ -e "$d/cgroup.kill" ] && echo 1 > "$d/cgroup.kill"
exit 0
`;

/**
 * @param {string} proc @param {number} pid
 * @returns {string|null} the cgroup path, `0::` stripped
 */
function cgroupOf(proc, pid) {
	try {
		const text = fs.readFileSync(
			path.join(proc, String(pid), "cgroup"),
			"utf8",
		);
		const line = text.split("\n").find((l) => l.startsWith("0::"));
		return line ? line.slice(3) : null;
	} catch {
		return null;
	}
}

/**
 * Whether `argv` is a Claude session process. A daemon spare rewrites its
 * title into one argv word, `claude bg-spare --bg-spare <socket>`, so the
 * shape is read off that word's first space-separated part.
 * @param {string[]} argv
 */
function isClaude(argv) {
	return isClaudeArgv0((argv[0] ?? "").split(" ")[0]);
}

/**
 * The pids to move with `leader`: itself, its descendants, and every process
 * whose environ names it as `CLAUDE_PID`, each only while it still shares the
 * leader's cgroup, so a test run's own scope is never pulled back in.
 * @param {Map<number, { ppid: number }>} procs
 * @param {number} leader
 * @param {(pid: number) => string|null} cgroup
 * @param {(pid: number) => string|null} claudePidOf
 */
function membersOf(procs, leader, cgroup, claudePidOf) {
	const home = cgroup(leader);
	/** @type {Map<number, number[]>} */
	const children = new Map();
	for (const [pid, { ppid }] of procs) {
		children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const found = new Set([leader]);
	const queue = [leader];
	while (queue.length > 0) {
		for (const child of children.get(/** @type {number} */ (queue.shift())) ??
			[]) {
			if (!found.has(child)) {
				found.add(child);
				queue.push(child);
			}
		}
	}
	for (const pid of procs.keys()) {
		if (claudePidOf(pid) === String(leader)) found.add(pid);
	}
	return [...found]
		.filter((pid) => pid === leader || cgroup(pid) === home)
		.sort((a, b) => a - b);
}

/**
 * @param {string} cmd @param {string[]} args
 */
function run(cmd, args) {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		timeout: CALL_TIMEOUT_MS,
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
	run("busctl", [
		"--user",
		"call",
		"org.freedesktop.systemd1",
		"/org/freedesktop/systemd1",
		"org.freedesktop.systemd1.Manager",
		...args,
	]);

/**
 * Attach `pids` to `unit`; the count attached. One call refuses the lot
 * where any pid has exited since it was read, as a short-lived hook child
 * often has (probed on #4341: "No such process"), so a refused batch is
 * retried a pid at a time.
 * @param {string} unit @param {number[]} pids
 */
function attach(unit, pids) {
	const call = (/** @type {number[]} */ some) =>
		busCall(["AttachProcessesToUnit", "ssau", unit, "", ...pidArgs(some)]).ok;
	if (pids.length === 0) return 0;
	if (call(pids)) return pids.length;
	return pids.filter((pid) => call([pid])).length;
}

/** @param {string} unit */
const watcherOf = (unit) => unit.replace(/\.scope$/, "-watch.service");

/**
 * Start the watcher that kills `unit` once `leader`, started at `startTicks`,
 * has ended. `--expand-environment=no` keeps systemd from reading the
 * shell's own `$` words as its environment variables.
 * @param {string} unit @param {number} leader @param {number} startTicks
 */
function startWatcher(unit, leader, startTicks) {
	return run("systemd-run", [
		"--user",
		"--quiet",
		"--collect",
		"--expand-environment=no",
		`--unit=${watcherOf(unit)}`,
		`--description=Kill ${unit} once session ${String(leader)} ends`,
		"--",
		"sh",
		"-c",
		WATCH,
		"sh",
		String(leader),
		String(startTicks),
		unit,
	]);
}

/** @param {string} line */
const done = (line) => ({ ok: true, line });
/** @param {string} line */
const fault = (line) => ({ ok: false, line });

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: boolean, line: string }} what it did, in one line
 */
function adopt(env = process.env) {
	const proc = procRoot();
	const leader = Number(env.CLAUDE_PID);
	if (!Number.isInteger(leader) || leader <= 1)
		return fault("no CLAUDE_PID: nothing to scope");
	const table = readProcTable(proc);
	const self = table?.procs.get(leader);
	if (!table || !self || !isClaude(self.argv))
		return fault(
			`CLAUDE_PID ${String(leader)} is no live Claude process: nothing to scope`,
		);
	const unit = `${UNIT_PREFIX}${String(leader)}-${String(self.startTicks)}.scope`;
	const home = cgroupOf(proc, leader);
	if (home && SCOPE_RE.test(home)) {
		/* A resume, `/clear` or compaction: the scope stands; its watcher may not. */
		if (
			run("systemctl", ["--user", "is-active", "--quiet", watcherOf(unit)]).ok
		)
			return done(`session ${String(leader)} already in ${unit}`);
		const watch = startWatcher(unit, leader, self.startTicks);
		return watch.ok
			? done(
					`session ${String(leader)} already in ${unit}; its watcher restarted`,
				)
			: fault(`no session watcher for ${unit} (${watch.err})`);
	}

	const cgroup = (/** @type {number} */ pid) => cgroupOf(proc, pid);
	const claudePidOf = (/** @type {number} */ pid) => {
		const r = readEnvironVar(pid, "CLAUDE_PID", proc);
		return r.ok ? r.value : null;
	};
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
			`no session scope: the user manager refused ${unit}: ${started.err}`,
		);

	const after = readProcTable(proc);
	const rest = after
		? membersOf(after.procs, leader, cgroup, claudePidOf).filter(
				/* Itself, too: it ends within the second. */
				(pid) => pid !== leader && pid !== process.pid,
			)
		: [];
	const moved = attach(unit, rest);
	const watch = startWatcher(unit, leader, self.startTicks);
	if (!watch.ok) {
		/* The move cannot be undone: `/non-systemd` takes no pid back (#4334 P1). */
		return fault(
			`no session watcher (${watch.err}); ${unit} stays until the session-end sweep`,
		);
	}
	return done(
		`session ${String(leader)} in ${unit}, with ${String(moved)} of its ${String(rest.length)} other process(es)`,
	);
}

if (require.main === module) {
	const { ok, line } = adopt();
	writeFd(2, `session-scope: ${line}\n`);
	/* An uncontained session looks like a contained one: the fault log is
	 * what tells them apart, at the next session start. */
	if (!ok) logError("session-scope.js", line);
}

module.exports = { adopt, membersOf, isClaude, WATCH, UNIT_PREFIX, SLICE };
