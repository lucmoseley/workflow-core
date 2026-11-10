/*
 * session-scope.js (lib) — the decisions behind scripts/session-scope.js
 * (#4341), its caller: which processes move with a session, how a refused
 * attach is retried, and the watcher script that kills the scope, whose argv
 * check-orphan-wait-loops.js also reads (#4670). No I/O:
 * each read and call arrives as a port.
 */

const { isClaudeArgv0 } = require("./claude-argv0.js");

const UNIT_PREFIX = "wfc-session-";
const SLICE = "wfc-sessions.slice";
/* The scope's hard memory bound, past which the kernel kills the scope's
 * largest process inside it; its derivation is docs/environment.md §6 (#4590).
 * Residual: where every runaway child is smaller than the session's own
 * process, that process is the one killed. */
const MEMORY_MAX_BYTES = 3.5 * 1024 ** 3;
/* The bound's properties, each `[name, signature, value]`: swap barred, so a
 * capped scope meets the OOM kill rather than paging, and `OOMPolicy`
 * `continue`, since the manager's default `stop` answers one OOM-killed
 * child by stopping the scope, the session's own process with it (#4590). */
const MEMORY_BOUND = [
	["MemoryMax", "t", String(MEMORY_MAX_BYTES)],
	["MemorySwapMax", "t", "0"],
	["OOMPolicy", "s", "continue"],
];
/* A guess at how often the watcher looks at its leader; a leftover spins at
 * most this long before the kill. */
const POLL_S = 2;
/* A guess: long enough for a git child to drop its lock on SIGTERM. */
const GRACE_S = 3;
/* A guess: passes enough for a hook phase's forks to settle. */
const MAX_PASSES = 5;

/** @param {number} leader @param {number} startTicks */
const unitOf = (leader, startTicks) =>
	`${UNIT_PREFIX}${String(leader)}-${String(startTicks)}.scope`;

/* The environ mark of an outliving job (#4749), `<leader>:<ceiling-s>`: the
 * session it was launched to outlive, and its scope's RuntimeMaxSec, empty
 * for none. lib/user-scope.js's spawnOutliving and lib/detach.sh's `outlive`
 * set it wherever they start the job in a user scope. */
const OUTLIVES_KEY = "WFC_OUTLIVES";

/** @param {number|string} leader @param {number|null} ceilingS */
const outlivesMark = (leader, ceilingS) =>
	`${String(leader)}:${ceilingS === null ? "" : String(ceilingS)}`;

/**
 * @param {string|null} value an OUTLIVES_KEY value
 * @returns {{ leader: number, ceilingS: number|null }|null}
 */
function parseOutlives(value) {
	const m = /^(\d+):(\d*)$/.exec(value ?? "");
	if (!m) return null;
	return { leader: Number(m[1]), ceilingS: m[2] === "" ? null : Number(m[2]) };
}

/** @param {number} root @param {number} startTicks */
const releaseUnitOf = (root, startTicks) =>
	`wfc-outlive-${String(root)}-${String(startTicks)}.scope`;

/** @param {string} unit */
const watcherOf = (unit) => unit.replace(/\.scope$/, "-watch.service");

/**
 * Whether `argv` is a Claude session process. A daemon spare rewrites its
 * title into one argv word, `claude bg-spare --bg-spare <socket>`, so the
 * shape is read off that word's first space-separated part.
 * @param {string[]} argv
 */
function isSessionProcess(argv) {
	return isClaudeArgv0((argv[0] ?? "").split(" ")[0]);
}

/**
 * The pids still to move with `leader`: its descendants, and every process
 * whose environ names it as `CLAUDE_PID` and that started no earlier than it,
 * so a dead session's leftover on a reused pid is never taken. Only those
 * still in `home`, the leader's cgroup before the move, so a test run's own
 * scope is never pulled back in. Never the leader, nor `self`, nor a job
 * marked as outliving this leader, wherever it sits.
 * @param {{ procs: Map<number, { ppid: number, startTicks: number }>,
 *   leader: number, home: string|null, self: number,
 *   readCgroup: (pid: number) => string|null,
 *   readClaudePid: (pid: number) => string|null,
 *   readOutlives: (pid: number) => string|null }} at
 */
function membersOf({
	procs,
	leader,
	home,
	self,
	readCgroup,
	readClaudePid,
	readOutlives,
}) {
	const leaderStart = procs.get(leader)?.startTicks ?? 0;
	/** @type {Map<number, number[]>} */
	const children = new Map();
	for (const [pid, { ppid }] of procs) {
		children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const found = new Set();
	const queue = [leader];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		for (const child of children.get(next) ?? []) {
			if (!found.has(child)) {
				found.add(child);
				queue.push(child);
			}
		}
	}
	for (const [pid, { startTicks }] of procs) {
		if (startTicks >= leaderStart && readClaudePid(pid) === String(leader))
			found.add(pid);
	}
	return [...found]
		.filter(
			(pid) =>
				pid !== leader &&
				pid !== self &&
				parseOutlives(readOutlives(pid))?.leader !== leader &&
				readCgroup(pid) === home,
		)
		.sort((a, b) => a - b);
}

/**
 * The jobs marked as outliving `leader` that sit in its scope, whose cgroup
 * is `scope`, each grouped under its outermost marked ancestor there, with
 * that ancestor's ceiling.
 * @param {{ procs: Map<number, { ppid: number, startTicks: number }>,
 *   leader: number, scope: string,
 *   readCgroup: (pid: number) => string|null,
 *   readOutlives: (pid: number) => string|null }} at
 * @returns {{ root: number, startTicks: number, ceilingS: number|null,
 *   pids: number[] }[]}
 */
function straysOf({ procs, leader, scope, readCgroup, readOutlives }) {
	/** @type {Map<number, number|null>} */
	const marked = new Map();
	for (const pid of procs.keys()) {
		const mark = parseOutlives(readOutlives(pid));
		if (mark?.leader === leader && readCgroup(pid) === scope)
			marked.set(pid, mark.ceilingS);
	}
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (const pid of marked.keys()) {
		let root = pid;
		for (
			let up = procs.get(root)?.ppid;
			up !== undefined && up !== root && marked.has(up);
			up = procs.get(root)?.ppid
		)
			root = up;
		groups.set(root, [...(groups.get(root) ?? []), pid]);
	}
	return [...groups]
		.sort(([a], [b]) => a - b)
		.map(([root, pids]) => ({
			root,
			startTicks: procs.get(root)?.startTicks ?? 0,
			ceilingS: marked.get(root) ?? null,
			pids: pids.sort((a, b) => a - b),
		}));
}

/**
 * Attach `pids` through `call`; the count attached. One call refuses the lot
 * where any pid has exited since it was read, as a short-lived hook child
 * often has (#4341), so a refused batch is
 * retried a pid at a time.
 * @param {number[]} pids @param {(pids: number[]) => boolean} call
 */
function attachEach(pids, call) {
	if (pids.length === 0) return 0;
	if (call(pids)) return pids.length;
	return pids.filter((pid) => call([pid])).length;
}

/**
 * Attach the session's processes pass after pass, each reading the table
 * afresh, until a pass finds none left behind — a process forked from an
 * unmoved one during a pass is born outside — or `MAX_PASSES` have run.
 * @param {() => number[]} left the pids still outside, read afresh
 * @param {(pids: number[]) => boolean} call
 */
function attachAll(left, call) {
	let moved = 0;
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const pids = left();
		if (pids.length === 0) break;
		moved += attachEach(pids, call);
	}
	return moved;
}

/**
 * Attach the session's processes (attachAll), then move back out, each group
 * to a scope of its own, every outliving job found in the session's scope
 * (#4749), read after read until one finds none or `MAX_PASSES` have run.
 *
 * WHY AFTER. A job's own `systemd-run --scope` can move it out between a
 * pass's cgroup read and its attach, which then pulls it back in, and at the
 * session's end its watcher kills it. No read before the attach closes that
 * gap. The job's mark is in its environ from systemd-run's exec, before its
 * own move, and every process it forks inherits it. So either that exec came
 * before a `strays` read, which sees the job, or after the attach, and the
 * job's own move, later still, takes it out. A child forked in the scope
 * before its parent's release, or a group the manager refused because one of
 * its pids had exited, is met by the next read.
 * @template {{ pids: number[] }} G
 * @param {{ left: () => number[], attach: (pids: number[]) => boolean,
 *   strays: () => G[], release: (group: G) => boolean }} at
 * @returns {{ moved: number, released: number, kept: number[] }} `kept`, the
 *   marked pids still in the scope after the last read
 */
function attachThenRelease({ left, attach, strays, release }) {
	const moved = attachAll(left, attach);
	let released = 0;
	let groups = strays();
	for (let pass = 0; pass < MAX_PASSES && groups.length > 0; pass++) {
		for (const group of groups)
			if (release(group)) released += group.pids.length;
		groups = strays();
	}
	return {
		moved,
		released,
		kept: groups.flatMap(({ pids }) => pids).sort((a, b) => a - b),
	};
}

const COLLECT = ["CollectMode", "s", "inactive-or-failed"];

/**
 * The user manager's `StartTransientUnit` method and its arguments: `unit`, a
 * scope holding `pids`, with `props`, each `[name, signature, value]`.
 * @param {string} unit @param {number[]} pids @param {string[][]} props
 */
const scopeUnitArgs = (unit, pids, props) => [
	"StartTransientUnit",
	"ssa(sv)a(sa(sv))",
	unit,
	"fail",
	String(1 + props.length),
	"PIDs",
	"au",
	String(pids.length),
	...pids.map(String),
	...props.flat(),
	"0",
];

/**
 * The session's own scope: `leader` alone, in SLICE, under MEMORY_BOUND.
 * @param {string} unit @param {number} leader @param {string} description
 */
const sessionUnitArgs = (unit, leader, description) =>
	scopeUnitArgs(
		unit,
		[leader],
		[
			["Slice", "s", SLICE],
			COLLECT,
			["Description", "s", description],
			...MEMORY_BOUND,
		],
	);

/**
 * A released group's scope, stopped at its ceiling where it has one.
 * @param {{ root: number, startTicks: number, ceilingS: number|null,
 *   pids: number[] }} group
 */
const releaseUnitArgs = ({ root, startTicks, ceilingS, pids }) =>
	scopeUnitArgs(releaseUnitOf(root, startTicks), pids, [
		COLLECT,
		...(ceilingS === null
			? []
			: [["RuntimeMaxUSec", "t", String(ceilingS * 1_000_000)]]),
	]);

/**
 * What adopting `leader` into `unit` did, in one line; not ok where an
 * outliving job stays in the scope.
 * @param {number} leader @param {string} unit
 * @param {{ moved: number, released: number, kept: number[] }} counts
 */
function adoptedLine(leader, unit, { moved, released, kept }) {
	const back =
		released > 0
			? `, ${String(released)} outliving job process(es) moved back out`
			: "";
	const line = `session ${String(leader)} in ${unit}, with ${String(moved)} other process(es)${back}`;
	return kept.length === 0
		? { ok: true, line }
		: {
				ok: false,
				line: `${line}; outliving job process(es) ${kept.join(" ")} left in it, killed at its end (#4749)`,
			};
}

/**
 * The watcher, run as `sh -c WATCH sh <pid> <start> <unit>`. `alive` reads
 * the leader's stat afresh: fields 3 (state) and 22 (start time) are the 1st
 * and 20th words after the comm's closing `) `. A cgroup file's size reads 0
 * whatever it holds, so `left` reads its text, never `-s`.
 *
 * `sample_memory` reads the scope's `memory.peak` and `memory.events`
 * oom_kill count at each poll, since a scope its processes all left is gone
 * by the time the leader's end is seen.
 *
 * KEPT: a Claude daemon, pty host or spare. A session's `claude --bg` starts
 * the daemon where none runs, so the daemon, and every pty host and spare it
 * forks, is born in that session's scope; killing it would end every session
 * the daemon serves. Each is moved to a scope of its own first, where it
 * lives as it did in `/non-systemd`; a spare later claimed moves again, to
 * its own session scope.
 */
const WATCH = `p=$1 start=$2 unit=$3
proc=\${WFC_PROC:-/proc}
root=\${WFC_CGROUP_ROOT:-/sys/fs/cgroup}
ctl=\${WFC_SYSTEMCTL:-systemctl}
bus=\${WFC_BUSCTL:-busctl}
alive() {
  { read -r s < "$proc/$p/stat"; } 2>/dev/null || return 1
  set -- \${s##*) }
  [ "$1" != Z ] && [ "$1" != X ] && [ "\${20}" = "$start" ]
}
d= peak= oom=
sample_memory() {
  [ -n "$d" ] || return 0
  { read -r v < "$d/memory.peak"; } 2>/dev/null && peak=$v
  { while read -r k v; do [ "$k" = oom_kill ] && oom=$v; done < "$d/memory.events"; } 2>/dev/null
}
find_cgroup() {
  cg=$("$ctl" --user show -p ControlGroup --value "$unit" 2>/dev/null)
  [ -n "$cg" ] && d="$root$cg"
}
find_cgroup
while alive; do sample_memory; sleep ${POLL_S}; done
[ -n "$d" ] || find_cgroup
sample_memory
if [ -n "$peak" ]; then
  echo "$unit peaked at $((peak / 1048576)) MiB, oom_kill \${oom:-0}"
elif [ -n "$d" ]; then
  echo "$unit peak unreadable at $d"
fi
[ -n "$d" ] || exit 0
for q in $(cat "$d/cgroup.procs" 2>/dev/null); do
  a=$(tr '\\0' ' ' < "$proc/$q/cmdline" 2>/dev/null)
  case "$a" in
    */claude\\ daemon\\ *|claude\\ daemon\\ *|claude\\ bg-pty-host\\ *|claude\\ bg-spare\\ *)
      "$bus" --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \\
        org.freedesktop.systemd1.Manager StartTransientUnit 'ssa(sv)a(sa(sv))' \\
        "wfc-claude-$q.scope" fail 2 PIDs au 1 "$q" CollectMode s inactive-or-failed 0 \\
        >/dev/null 2>&1 && echo "kept Claude process $q out of $unit: $a" ;;
  esac
done
left() { [ -n "$(cat "$d/cgroup.procs" 2>/dev/null)" ]; }
left || exit 0
echo "session $p ended; killing what is left in $unit:" $(cat "$d/cgroup.procs")
"$ctl" --user kill --signal=SIGTERM "$unit" 2>/dev/null
i=0
while left && [ $i -lt ${GRACE_S} ]; do sleep 1; i=$((i + 1)); done
[ -e "$d/cgroup.kill" ] && echo 1 > "$d/cgroup.kill"
exit 0
`;

/**
 * The watcher's command for `leader`, started at `startTicks`:
 * `sh -c WATCH sh <pid> <start> <unit>`.
 * @param {number} leader @param {number} startTicks
 */
const watcherArgv = (leader, startTicks) => [
	"sh",
	"-c",
	WATCH,
	"sh",
	String(leader),
	String(startTicks),
	unitOf(leader, startTicks),
];

/**
 * The leader a watcher's argv waits on, `{pid, startTicks}`, or null where
 * `argv` is not one watcherArgv built, sh at whatever path the service
 * resolved. Known by its unit, not its script text, so a watcher started from
 * an older WATCH still matches.
 * @param {string[]} argv
 */
function parseWatcherArgv(argv) {
	if (argv.length !== 7 || argv[1] !== "-c") return null;
	const pid = Number(argv[4]);
	const startTicks = Number(argv[5]);
	if (!Number.isInteger(pid) || !Number.isInteger(startTicks)) return null;
	return argv[6] === unitOf(pid, startTicks) ? { pid, startTicks } : null;
}

module.exports = {
	SLICE,
	MEMORY_BOUND,
	WATCH,
	watcherArgv,
	parseWatcherArgv,
	unitOf,
	watcherOf,
	isSessionProcess,
	membersOf,
	straysOf,
	attachThenRelease,
	sessionUnitArgs,
	releaseUnitArgs,
	adoptedLine,
	OUTLIVES_KEY,
	outlivesMark,
};
