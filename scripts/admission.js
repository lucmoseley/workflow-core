#!/usr/bin/env node
/*
 * admission.js — re-read the machine and say how many sessions may start now.
 *
 * The dispatch-time slot count `.claude/skills/pick-next` §5 calls for, in code
 * rather than in prose (mantahostels#1144; mantahostels#943 measured what the prose arithmetic cost).
 *
 * Usage:  node admission.js [--json] [--launch] [--skip-allowance]
 *         node admission.js --load-only
 *
 * `--skip-allowance` drops the allowance limb below, the memory limb staying
 * armed — what `dispatch-sessions.sh --force` passes (workflow-core#299).
 *
 * `--load-only` judges the CPU limb alone, the load and session ceilings both —
 * what `dispatch-sessions.sh --force-memory` runs, so overriding memory never
 * disarms either (workflow-core#834, workflow-core#2141). Only `WFC_LOAD_CEILING=0` (or a 0 in `~/.claude/load-ceiling`) and
 * `WFC_SESSION_CEILING=0` turn them off.
 *
 * `--launch` reserves, on top of the one idle pair already reserved, the
 * spare pair the caller's next launch is about to make the daemon warm
 * (mantahostels#2588). A launcher re-reading admission before each spawn
 * otherwise sees only what previous members warmed and never what its own
 * member is about to cost — `poolReserve` in `lib/admission.js` has the
 * pricing. It charges each slot past the first its own pair, as the earlier
 * members' pairs are resident by the k-th member's re-read (workflow-core#2511), so
 * `dispatch-sessions.sh`'s per-member re-reads admit every slot the refill
 * loop's free-slot count, also passing it, finds (workflow-core#2500).
 *
 * Exit codes:
 *   0  at least one slot
 *   1  HOLD — no slot, a fresh allowance reading is at 100% (workflow-core#293
 *      ruling 3, workflow-core#294; the backstop at workflow-core#371 item 5), load1 is at or above
 *      the CPU ceiling (workflow-core#830), which a `cpu load` line then names, or the live
 *      sessions fill the session ceiling (workflow-core#2141), which a `cpu sessions` line
 *      names
 *   2  REFUSED — memory or the session count could not be read
 *
 * `--json`'s payload also carries `allowanceWarning` (string | null) — set
 * when the per-spawn allowance re-read found a stale or absent bar. That
 * never changes the exit code: unlike a breach, an untrustworthy reading only
 * warns and admits, since the only refresh is the 11-25s `/usage` call this
 * per-spawn path cannot afford (workflow-core#293 ruling 3).
 *
 * `hungJobs` (mantahostels#2598) rides both output modes off the SAME `listedSessionIds()`
 * read this file already pays for — `lib/hung-jobs.js#findHungJobs` takes that
 * listing rather than calling `claude agents --json` again. It never changes
 * the exit code: a hung job is a courtesy the refusal text can use, not a
 * gate `verdict` does not already carry. `dispatch-sessions.sh`'s roster
 * remedy reads the TEXT-mode rendering (`buildHungJobsText`, below) rather than
 * this field directly — it never passes `--json` — so the two are exercised
 * by separate tests, not one.
 *
 * Mutated at mantahostels#2598: dropping `hungJobs` from the `--json` payload, caught by
 * admission.test.ts's "includes hungJobs in --json even when empty" case.
 * Separately, dropping the TEXT-mode section `buildHungJobsText` renders is caught
 * by dispatch-sessions.test.ts's "names a HUNG-JOB inline" case, which reads
 * dispatch-sessions.sh's own relay of it rather than this file's `--json`.
 */

const { writeFd } = require("./lib/write-fd.js");
const {
	machineAdmission,
	LAUNCH_SPARES,
	readCpuSlots,
	buildSessionCeilingText,
	buildSessionDrawLine,
	buildSessionFloorLine,
	buildLiveDrawLine,
	SUITE_GATE_MB,
	buildMemoryBreakdownLines,
	reclaimableMb,
	SUITE_RESTING_MB,
} = require("./lib/admission");
const { readLiveLanders } = require("./lib/local-tester.js");
const { admissionSessionIds, listedAgents } = require("./lib/agent-liveness");
const { readJobs, findHungJobs } = require("./lib/hung-jobs");
const { readAllowance } = require("./lib/allowance");
const { overloadReading, buildOverloadText } = require("./lib/cpu-sample");
const { parseOrExit } = require("./lib/cli-args");

const USAGE = `Usage: node scripts/admission.js [--json] [--launch] [--skip-allowance]
       node scripts/admission.js --load-only`;

/*
 * A backstop at 100% on both bars, never the launcher's 90/97 thresholds:
 * those size the set once, in `dispatch-sessions.sh`'s cap, and a set the cap
 * admitted must not be refused member by member on the same reading (workflow-core#371
 * item 5).
 */
const ALLOWANCE_BACKSTOP = 100;

/*
 * The per-spawn allowance re-read (workflow-core#293 ruling 3). The session bar is
 * precisely the figure a set launch moves, and the pre-set gate spends its one
 * read before member one — so it cannot see what members two through seven
 * consume.
 *
 * Does NOT fail closed on a stale or absent reading: the only refresh is the
 * 11-25s `claude -p "/usage"` call, which this per-spawn path cannot afford,
 * so refusing here on an untrustworthy reading would strand every remaining
 * member of a set with no path to a better one. It warns and admits instead.
 * @returns {{ breach: string | null, warning: string | null }}
 */
function allowanceCheck() {
	const allowance = readAllowance();
	/** @type {[string, "weekly_all" | "session"][]} */
	const bars = [
		["weekly", "weekly_all"],
		["session", "session"],
	];
	const warnings = [];
	let breach = null;
	for (const [label, key] of bars) {
		const bar = allowance[key];
		if (bar.trust !== "fresh") {
			warnings.push(
				`${label} allowance reading is ${bar.trust} — admitting anyway`,
			);
			continue;
		}
		if (
			breach === null &&
			bar.percent !== null &&
			bar.percent >= ALLOWANCE_BACKSTOP
		) {
			breach = `${label} allowance ${bar.percent}% used (backstop ${ALLOWANCE_BACKSTOP}%)`;
		}
	}
	return { breach, warning: warnings.length > 0 ? warnings.join("; ") : null };
}

/**
 * The pids of the sessions the oracle lists, so the overhead scan can tell a
 * CLAIMED spare — a live session, already priced through its draw — from an
 * idle one (mantahostels#1287). An oracle that will not answer yields an empty set, which
 * over-reserves rather than under-reserves.
 *
 * Off the strict listing where it answered, so the per-member re-read pays one
 * oracle spawn (workflow-core#2876); the `requireSelf: false` read only where it refused.
 * @param {ReturnType<typeof admissionSessionIds>} strict
 */
function liveSessionPids(strict) {
	if (strict.pids) return new Set([...strict.pids.values()].map(String));
	const listed = listedAgents({ requireSelf: false });
	if (listed.why || !listed.agents) return new Set();
	return new Set(
		listed.agents
			.filter((/** @type {{ pid?: unknown }} */ a) => a.pid)
			.map((/** @type {{ pid?: unknown }} */ a) => String(a.pid)),
	);
}

/* Unknown is never calm (mantahostels#1206): the limb fails open on it, so it says so. */
const CPU_LOAD_UNKNOWN =
	"cpu load           unknown — /proc/loadavg unreadable, so nothing is held on load";

/**
 * The `cpu load` and `cpu sessions` lines for each CPU hold, which
 * `dispatch-sessions.sh` keys its remedy off — and off `the only hold`, on the
 * last, for whether a memory or allowance remedy applies too.
 * @param {import("./lib/cpu-sample").LoadReading} load
 * @param {ReturnType<typeof readCpuSlots>} cpu
 * @param {boolean} only
 */
function buildCpuHoldLines(load, cpu, only) {
	const lines = [
		...(load.overloaded
			? [`cpu load           ${buildOverloadText(load)}`]
			: []),
		...(cpu.full ? [`cpu sessions       ${buildSessionCeilingText(cpu)}`] : []),
	];
	if (only && lines.length > 0) lines[lines.length - 1] += " — the only hold";
	return lines;
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--json": "boolean",
			"--launch": "boolean",
			"--skip-allowance": "boolean",
			"--load-only": "boolean",
		},
	});
	if (flags["--load-only"]) return cpuLimbOnly();
	const json = flags["--json"] === true;
	const spares = flags["--launch"] ? LAUNCH_SPARES : 0;
	// One `claude agents --json` read, shared with the hung-job scan below
	// (mantahostels#2598) — `dispatch-sessions.sh`'s per-member re-read must not double it.
	// Empty outside a session reads as nothing live (workflow-core#2180).
	const listed = admissionSessionIds();
	const { overhead, host, live, load, cpu, floorRead, verdict, memory } =
		machineAdmission({
			listed,
			livePids: liveSessionPids(listed),
			reclaimable: reclaimableMb(),
			pendingSpares: spares,
			landers: readLiveLanders(),
		});
	/* Between the figures and the hung-job section, never after it:
	 * `dispatch-sessions.sh` reads from `^hung job(s)` to the end. */
	const memoryText = `\n\n${buildMemoryBreakdownLines(memory).join("\n")}`;

	// Runs even where `verdict` is itself refused — a warning is still worth
	// surfacing on an unreadable memory read — unless the caller has overridden
	// allowance, where a stale-reading warning is noise. Residual: `--json`'s
	// `allowanceWarning` then reads null, as it does for a fresh reading.
	const allowance = flags["--skip-allowance"]
		? { breach: null, warning: null }
		: allowanceCheck();
	if (verdict.ok && allowance.breach) {
		verdict.admit = false;
		verdict.reason = allowance.breach;
	}

	/*
	 * A WORKING job that is alive but silent, off the SAME listing above — no
	 * second oracle spawn. Silent where the listing itself failed (`listed.ids`
	 * absent) or the job store would not open: this is a courtesy the refusal
	 * text can use, never a second gate `verdict` does not already carry.
	 */
	const hungJobs = listed.ids && listed.pids ? readHungJobs(listed) : [];

	/*
	 * Built as one string and written with a single `writeFd`, never
	 * `console.log` (§N6, `docs/code-standards-base.md`): node buffers a pipe's
	 * writes and drops whatever is still buffered at `process.exit`, and
	 * stdout is a pipe under dispatch.
	 */
	if (json)
		return writeJson({ verdict, hungJobs, allowance, memory, floorRead });

	if (!verdict.ok)
		return writeRefusal({ verdict, load, cpu, memoryText, hungJobs });
	const lines = buildReportLines({
		verdict,
		host,
		floorRead,
		live,
		overhead,
		spares,
		allowance,
	});
	writeFd(
		1,
		`${lines.join("\n")}${memoryText}${buildHungJobsText(hungJobs)}\n`,
	);
	return verdict.admit ? 0 : 1;
}

/**
 * @typedef {ReturnType<typeof machineAdmission>} Admission
 * @typedef {{breach: string | null, warning: string | null}} AllowanceRead
 */

/**
 * `--load-only`: the CPU limb's lines alone, exit 1 only where it holds.
 * @returns {number}
 */
function cpuLimbOnly() {
	const load = overloadReading();
	const cpu = readCpuSlots();
	const lines = [
		...(load.load1 === null ? [CPU_LOAD_UNKNOWN] : []),
		...(cpu.unknown === null ? [] : [cpuSessionsUnknown(cpu)]),
		...buildCpuHoldLines(load, cpu, true),
	];
	if (lines.length > 0) writeFd(1, `${lines.join("\n")}\n`);
	return load.overloaded || cpu.full ? 1 : 0;
}

/**
 * The `cpu sessions` line where the session count went unread; unknown is
 * never calm (mantahostels#1206).
 * @param {ReturnType<typeof readCpuSlots>} cpu
 */
const cpuSessionsUnknown = (cpu) =>
	`cpu sessions       unknown — ${cpu.unknown}, so nothing is held on the session count`;

/**
 * The hung jobs off the listing already read; none where the job store
 * would not open.
 * @param {Parameters<typeof findHungJobs>[1]} listed
 * @returns {ReturnType<typeof findHungJobs>}
 */
function readHungJobs(listed) {
	const jobs = readJobs();
	return jobs ? findHungJobs(jobs, listed) : [];
}

/**
 * The `--json` report; exit 2 on an unreadable verdict, else 0 or 1.
 * @param {{verdict: Admission["verdict"], hungJobs: ReturnType<typeof findHungJobs>, allowance: AllowanceRead, memory: Admission["memory"], floorRead: Admission["floorRead"]}} a
 * @returns {number}
 */
function writeJson({ verdict, hungJobs, allowance, memory, floorRead }) {
	// `hungJobs`, `allowanceWarning` and `sessionFloorProblem` ride alongside
	// `verdict` rather than inside it: `verdict` is `lib/admission.js#strictAdmission`'s own return
	// shape, and widening it here would drift the two from what that lib's
	// own tests assert.
	writeFd(
		1,
		`${JSON.stringify({ ...verdict, hungJobs, allowanceWarning: allowance.warning, sessionFloorProblem: floorRead.problem ?? null, memory }, null, 2)}\n`,
	);
	if (!verdict.ok) return 2;
	return verdict.admit ? 0 : 1;
}

/**
 * The text-mode refusal where no verdict could be reached; always exit 2.
 * @param {{verdict: Extract<Admission["verdict"], {ok: false}>, load: Admission["load"], cpu: Admission["cpu"], memoryText: string, hungJobs: ReturnType<typeof findHungJobs>}} a
 * @returns {number}
 */
function writeRefusal({ verdict, load, cpu, memoryText, hungJobs }) {
	writeFd(
		2,
		`ADMISSION REFUSED — ${verdict.error}\n  Start nothing on a guess: an over-admission freezes the machine.${
			/* So dispatch names the CPU remedy beside the memory one. */
			buildCpuHoldLines(load, cpu, false)
				.map((l) => `\n${l}`)
				.join("")
		}${memoryText}\n${buildHungJobsText(hungJobs)}`,
	);
	return 2;
}

/**
 * The text-mode report's figure lines, ahead of the memory breakdown.
 * @param {{verdict: Extract<Admission["verdict"], {ok: true}>, host: Admission["host"], floorRead: Admission["floorRead"], live: Admission["live"], overhead: Admission["overhead"], spares: number, allowance: AllowanceRead}} a
 * @returns {string[]}
 */
function buildReportLines({
	verdict,
	host,
	floorRead,
	live,
	overhead,
	spares,
	allowance,
}) {
	const floorLine = buildSessionFloorLine(floorRead, verdict);
	return [
		`available memory   ${verdict.availableMb} MB`,
		`live sessions      ${verdict.sessions} alongside this one`,
		`session draw       ${buildSessionDrawLine(host)}`,
		...(floorLine ? [`session floor      ${floorLine}`] : []),
		`live draw          ${buildLiveDrawLine(live)}`,
		/* Silent at 0, so a caller not passing the flag reads exactly what it
		 * always has. */
		...(overhead.ok && overhead.pendingMb
			? [
					`pending spares     ${overhead.pendingMb} MB reserved for the ${spares} spare(s) this launch will warm, at ${overhead.perPairMb} MB a pair, and as much again for each slot past the first (workflow-core#2511)`,
				]
			: []),
		`reclaimable        ${verdict.reclaimedMb} MB about to be reaped`,
		`slots              ${verdict.slots} — ${verdict.admit ? "ADMIT" : "HOLD"}: ${verdict.reason}`,
		/* dispatch-sessions.sh relays the unknown line on its admit path. */
		...(verdict.load.load1 === null ? [CPU_LOAD_UNKNOWN] : []),
		...buildCpuHoldLines(
			verdict.load,
			verdict.cpu,
			verdict.cpuIsSoleHold && !allowance.breach,
		),
		/* The suite figure may rest on the reclaim credit, which only the two npm
		 * suite scripts collect — their pre-scripts run the reap (mantahostels#1930, workflow-core#633). */
		`test suites        ${verdict.suites} concurrent${
			verdict.availableMb - verdict.reservedMb >= SUITE_GATE_MB
				? ""
				: ` (under the ~${SUITE_GATE_MB} MB three-suite gate)`
		}${
			verdict.suites > 0 &&
			verdict.availableMb - verdict.reservedMb < SUITE_RESTING_MB[1]
				? " — on the pretest reap `npm run test` and `test:changed` run; a build and a bare `vitest run` collect no credit"
				: ""
		}`,
		/* Silent where there is nothing to say, so a clean run's output is
		 * unchanged — same convention as the pending-spares line above. */
		...(allowance.warning ? [`allowance          ${allowance.warning}`] : []),
	];
}

/**
 * The hung-job section for the text-mode reports above — dispatch-sessions.sh
 * reads this off `admission_out` directly rather than a second `check:ghost-jobs`
 * run (mantahostels#2598). Empty string where there is nothing to say, so a clean run's
 * output is unchanged.
 * @param {ReturnType<typeof findHungJobs>} hungJobs
 */
function buildHungJobsText(hungJobs) {
	if (hungJobs.length === 0) return "";
	const lines = [
		"",
		`hung job(s)        ${hungJobs.length} — listed and alive, but silent; may be holding a slot or a ledger entry:`,
	];
	for (const h of hungJobs) {
		lines.push(
			`  ${h.intent || h.job} — job ${h.job}, session ${h.sessionId}, pid ${h.pid ?? "unknown"}`,
			`    roster: ${h.rosterPath}`,
		);
	}
	return `\n${lines.join("\n")}`;
}

/* The seam every neighbouring script uses: requiring this file runs nothing, so
 * `main` stays callable in-process. */
if (require.main === module) process.exit(main());

module.exports = { main };
