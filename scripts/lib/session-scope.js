const { isClaudeArgv0 } = require("./claude-argv0.js");

const UNIT_PREFIX = "wfc-session-";
const SLICE = "wfc-sessions.slice";
// measured 3,145 MiB p99 host plus tsc max, with a 10% margin, workflow-core#4590
const MEMORY_MAX_BYTES = 3.5 * 1024 ** 3;
// workflow-core#4590
const MEMORY_BOUND = [
	["MemoryMax", "t", String(MEMORY_MAX_BYTES)],
	["MemorySwapMax", "t", "0"],
	["OOMPolicy", "s", "continue"],
];
// workflow-core#4341 guess
const POLL_S = 2;
// workflow-core#4341 guess
const GRACE_S = 3;
// workflow-core#4341 guess
const MAX_PASSES = 5;

/** @param {number} leader @param {number} startTicks */
const unitOf = (leader, startTicks) =>
	`${UNIT_PREFIX}${String(leader)}-${String(startTicks)}.scope`;

const OUTLIVES_KEY = "WFC_OUTLIVES";

/** @param {number|string} leader @param {number|null} ceilingS */
const outlivesMark = (leader, ceilingS) =>
	`${String(leader)}:${ceilingS === null ? "" : String(ceilingS)}`;

/**
 * @param {string|null} value
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

/** @param {string[]} argv */
function isSessionProcess(argv) {
	return isClaudeArgv0((argv[0] ?? "").split(" ")[0]);
}

/**
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
 * @param {number[]} pids
 * @param {(pids: number[]) => boolean} call
 */
function attachEach(pids, call) {
	if (pids.length === 0) return 0;
	if (call(pids)) return pids.length;
	return pids.filter((pid) => call([pid])).length;
}

/**
 * @param {() => number[]} left
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
 * @template {{ pids: number[] }} G
 * @param {{ left: () => number[], attach: (pids: number[]) => boolean,
 *   strays: () => G[], release: (group: G) => boolean }} at
 * @returns {{ moved: number, released: number, kept: number[] }}
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
 * @param {string} unit
 * @param {number[]} pids
 * @param {string[][]} props
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
 * @param {string} unit
 * @param {number} leader
 * @param {string} description
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
 * @param {number} leader
 * @param {string} unit
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
				line: `${line}; outliving job process(es) ${kept.join(" ")} left in it, killed at its end (workflow-core#4749)`,
			};
}

// /proc/<pid>/stat fields 3 and 22 are the 1st and 20th words after the comm's ") " (https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)
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
 * @param {number} leader
 * @param {number} startTicks
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

/** @param {string[]} argv */
function parseWatcherArgv(argv) {
	if (argv.length !== 7 || argv[1] !== "-c") return null;
	const pid = Number(argv[4]);
	const startTicks = Number(argv[5]);
	if (!Number.isInteger(pid) || !Number.isInteger(startTicks)) return null;
	return argv[6] === unitOf(pid, startTicks) ? { pid, startTicks } : null;
}

module.exports = {
	MEMORY_BOUND,
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
