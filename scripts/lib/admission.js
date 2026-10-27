/*
 * admission.js — how many more sessions this machine can take.
 *
 * The one place the admission figures and arithmetic live: `pick-next.js`
 * prints its ADMISSION block from here, and `scripts/admission.js` re-reads
 * them at dispatch time (mantahostels#1144, mantahostels#943).
 *
 * FAILS CLOSED for the re-read (`strictAdmission`): where memory or the session
 * count cannot be read the answer is a refusal, never a guessed slot count,
 * because an over-admission freezes the machine. `admissionFrom` keeps
 * pick-next's lenient behaviour, so a full run degrades rather than dying.
 *
 * Both verdicts carry the CPU limb (workflow-core#830, workflow-core#834, workflow-core#2141): load1 at or above
 * `lib/cpu-sample.js`'s ceiling holds every slot, and the session ceiling caps
 * them, so pick-next's slot count and the dispatch re-read agree. It fails open
 * on an unreadable load or `ps`, where the memory limb fails closed.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const nodePath = require("node:path");
const os = require("node:os");
const { parseErrLine } = require("./gh");
const { caught } = require("./caught.js");
const { readParentOf } = require("./proc-stat.js");
const { isClaudeArgv0 } = require("./claude-argv0.js");
const {
	overloadReading,
	buildOverloadText,
	sessionCeiling,
} = require("./cpu-sample.js");
const {
	faultsOn,
	readConfig,
	buildWarningLine,
} = require("./workflow-core-config.js");
const { requiredGroup } = require("./regex-group.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { docPath } = require("./script-path.js");
const {
	DRAW_MARGIN_MB,
	EARLYOOM_FLOOR_MB,
	SUITE_MAX,
	WHOLE_SUITE_MAX,
	LADDER_SUITE_WORKERS,
	suiteRungMb,
	SUITE_RESTING_MB,
	SUITE_GATE_MB,
	SUITE_LADDER_MEASURED_AT,
	runningSuites,
	readCarriedWeightOf,
	readPs,
	PS_BIN,
} = require("./suite-ladder.js");
const { WHOLE_SUITE_WORKERS } = require("./suite-bounded.js");

/**
 * @typedef {import("./cpu-sample.js").LoadReading} LoadReading
 */

/* The default for a caller that has not read the load: no hold. */
/** @type {LoadReading} */
const LOAD_UNREAD = { overloaded: false, load1: null, ceiling: null };

/**
 * `full` is the verdict, as `overloaded` is the load limb's; `slots` is null,
 * capping nothing, where `ceiling` is null (turned off) or `unknown` says why
 * the count went unread.
 * @typedef {{ ceiling: number | null, sessions: number | null, slots: number | null, full: boolean, unknown: string | null }} CpuSlots
 */

/** @type {CpuSlots} */
const CPU_UNREAD = {
	ceiling: null,
	sessions: null,
	slots: null,
	full: false,
	unknown: "not read",
};

/**
 * The CPU limb's slot count (workflow-core#2141): the session ceiling less the machine's
 * sessions, counted as `bg-pty-host` processes, one a session, the unit the
 * ceiling was measured in. So every plan's sessions count, where `claude
 * agents` lists this plan's alone, and so does this run's own, whose memory is
 * already out of MemAvailable but which still runs. A host whose daemon has
 * gone (parent pid 1) is left out; an interactive terminal session runs no
 * host and goes uncounted.
 *
 * @param {PsRead} ps
 * @param {Map<string, string[]>} children
 * @returns {CpuSlots}
 */
function cpuSlots(ps, children) {
	const ceiling = sessionCeiling();
	if (!ps.ok)
		return {
			ceiling,
			sessions: null,
			slots: null,
			full: false,
			unknown: `ps unreadable: ${ps.error}`,
		};
	const orphans = new Set(children.get("1") ?? []);
	const sessions = ps.rows.filter((r) => {
		const [argv0, role] = r.args.split(/\s+/);
		return (
			isClaudeArgv0(argv0) && role === "bg-pty-host" && !orphans.has(r.pid)
		);
	}).length;
	const slots = ceiling === null ? null : Math.max(0, ceiling - sessions);
	return { ceiling, sessions, slots, full: slots === 0, unknown: null };
}

/** `cpuSlots` off reads of its own, for a caller that has taken none. */
const readCpuSlots = () => cpuSlots(readPsRows(), readProcessChildren());

/**
 * @param {number} slots
 * @param {CpuSlots} cpu
 */
const cpuCapped = (slots, cpu) =>
	cpu.slots === null ? slots : Math.min(slots, cpu.slots);

/**
 * @param {CpuSlots} cpu
 */
const buildSessionCeilingText = (cpu) =>
	`${cpu.sessions} session(s) running on the machine against the ${cpu.ceiling}-session CPU ceiling (workflow-core#2141), so ${cpu.slots} slot(s)`;

/**
 * @param {CpuSlots} cpu
 */
function cpuSlotsRow(cpu) {
	if (cpu.unknown !== null) return `none capped (${cpu.unknown})`;
	if (cpu.ceiling === null)
		return "none capped — no session ceiling, WFC_SESSION_CEILING=0 or the cores uncounted";
	return buildSessionCeilingText(cpu);
}

/**
 * @typedef {{ ok: true, mb: number } | { ok: false, error: string }} MbResult
 * @typedef {({ ok: true, mb: number, idlePairs: number, perPairMb: number | null }) | { ok: false, error: string }} SpareOverhead
 * @typedef {({ ok: true, mb: number, perPairMb: number, pendingMb: number }) | { ok: false, error: string }} PoolReserve
 * @typedef {{ ok: true, sessions: number, working: number, self?: boolean, unvouched: boolean, processes: number | null, processesError: string | null } | { ok: false, error: string, processes: number | null, processesError: string | null }} LiveSessionsResult
 * @typedef {{ sessions: number, problem?: string }} SessionFloor
 * @typedef {{ held: false } | { held: true, swapFreeMb: number, swapTotalMb: number, availableMb: number }} SwapHold
 * @typedef {{ sessionFloor: number, sessionFloorWorking: number, sessionFloorSlots: number, sessionFloorLifted: boolean, swapHold: SwapHold }} SessionFloorFigures
 * @typedef {{ sessions: number, working: number, self?: boolean, unvouched?: boolean }} FloorProcs
 * @typedef {(FloorProcs & { ok: true }) | { ok: false, error: string }} LenientProcs
 * @typedef {{ meanMb: number, sigmaMb: number, declared: boolean, problem?: string }} SessionDraw
 * @typedef {{ sessions: number, meanMb: number, varianceMb2: number, pssMb: number, unread: number, noProcess: number, problems: string[], refused?: boolean }} LiveDraw
 * @typedef {{ pids: number[], slotMb: number }} Landers
 * @typedef {{ pid: string, rssKb: number, args: string }} PsRow
 * @typedef {{ ok: true, rows: PsRow[] } | { ok: false, error: string }} PsRead
 * @typedef {{ ok: true, totalKb: number | null, availableKb: number, swapTotalKb: number | null, swapFreeKb: number | null } | { ok: false, error: string }} MeminfoRead
 */

const REAP_SCRIPT = () =>
	process.env.WFC_REAP_SCRIPT ||
	nodePath.join(__dirname, "..", "reap-finished-sessions.js");

/*
 * THE AGGREGATE DRAW (workflow-core#2221). Admission prices the live sessions together, not
 * as N copies of one session's p90: sessions do not peak together, so the
 * sum's tail grows with √N. One session's draw is its pair (the session
 * process and its `bg-pty-host`) plus every process it starts, measured as a
 * mean and a standard deviation (`docs/environment.md` §5). k more sessions are
 * admitted while
 *
 *   Σμ + k·μ + z·√(Σσ² + k·σ²) − the live sessions' current PSS
 *     ≤ free − pool reserve − earlyoom floor − margin + reclaim credit
 *
 * Σ runs over the live sessions, each at its own repo's draw; the bare μ and σ
 * are this host's, whose sessions are the ones admitted. Current PSS counts
 * descendants too, the unit μ is measured in, so the suites μ's sample saw
 * are charged at the rate it saw them. Nothing more is held for suites: the
 * suite gate queues a suite until its ladder rung is free (workflow-core#2305).
 *
 * An undeclared repo is charged DEFAULT_SESSION_DRAW: the pooled draw across
 * every repo workflow-core#2231's 45-minute sample saw working.
 */
/** @type {{ meanMb: number, sigmaMb: number }} */
const DEFAULT_SESSION_DRAW = { meanMb: 587, sigmaMb: 304 };
/** @type {SessionDraw} */
const UNDECLARED_DRAW = { ...DEFAULT_SESSION_DRAW, declared: false };
/** @type {LiveDraw} */
const NO_LIVE_DRAW = {
	sessions: 0,
	meanMb: 0,
	varianceMb2: 0,
	pssMb: 0,
	unread: 0,
	noProcess: 0,
	problems: [],
};
/* The aggregate's p95, ruled at workflow-core#2221. DUPLICATED BY HAND as DRAW_Z in
 * scripts/sample_session_memory.py, whose aggregate check models this p95:
 * move both, or neither. */
const DRAW_Z = 1.645;

/**
 * One repo's session draw: its declared `sessionMeanMb` and `sessionSigmaMb`,
 * each falling back to DEFAULT_SESSION_DRAW's on its own, with `problem`
 * saying why a declaration went unread.
 * @param {string} [root] the repo root, where it is not this run's host
 * @returns {SessionDraw}
 */
function readSessionDraw(root) {
	const mean = readDeclaredMb(
		"sessionMeanMb",
		DEFAULT_SESSION_DRAW.meanMb,
		root,
	);
	const sigma = readDeclaredMb(
		"sessionSigmaMb",
		DEFAULT_SESSION_DRAW.sigmaMb,
		root,
	);
	const problems = [mean.problem, sigma.problem].filter(Boolean);
	return {
		meanMb: mean.mb,
		sigmaMb: sigma.mb,
		declared: mean.declared && sigma.declared,
		...(problems.length > 0 ? { problem: problems.join("; ") } : {}),
	};
}

/**
 * A positive-integer figure a repo declares in its config, else `fallback`,
 * with `problem` saying why a declaration went unread.
 * @param {"sessionMeanMb" | "sessionSigmaMb"} key
 * @param {number} fallback
 * @param {string} [root] the repo root, where it is not this run's host
 * @returns {{ mb: number, declared: boolean, problem?: string }}
 */
function readDeclaredMb(key, fallback, root) {
	try {
		const config = readConfig({ root, quiet: true });
		const mb = config[key];
		if (mb) return { mb, declared: true };
		const [fault] = faultsOn(config, key);
		const problem = fault && buildWarningLine(fault);
		return { mb: fallback, declared: false, problem };
	} catch (e) {
		return { mb: fallback, declared: false, problem: parseErrLine(e) };
	}
}

/**
 * The working sessions this machine keeps over the p95 pricing: the integer in
 * `~/.claude/session-floor`, host configuration like `~/.claude/refill-seats`
 * since every repo's sessions share the machine, or `WFC_SESSION_FLOOR` in its
 * place, the suite's injection point. A stopgap the founder
 * ruled on 22 Oct 2026, removed when workflow-core#2495's spec lands (workflow-core#2501).
 *
 * No file, or an empty `WFC_SESSION_FLOOR`, is no floor. A file that will not
 * read or holds no non-negative integer is no floor too, and `problem` says
 * why.
 * @returns {SessionFloor}
 */
function readDeclaredSessionFloor() {
	const file = nodePath.join(
		process.env.HOME || os.homedir(),
		".claude",
		"session-floor",
	);
	const env = process.env.WFC_SESSION_FLOOR;
	let text;
	if (env === undefined) {
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (e) {
			if (caught(e).code === "ENOENT") return { sessions: 0 };
			return { sessions: 0, problem: `${file}: ${parseErrLine(e)}` };
		}
	} else {
		if (env === "") return { sessions: 0 };
		text = env;
	}
	const n = Number(text.trim());
	if (text.trim() !== "" && Number.isInteger(n) && n >= 0)
		return { sessions: n };
	return {
		sessions: 0,
		problem: `${env === undefined ? file : "WFC_SESSION_FLOOR"} holds ${JSON.stringify(text.trim())}, not a non-negative integer`,
	};
}

/**
 * The session floor's slots: those `sessionFloor` wants past the `working`
 * sessions, each granted only while `effectiveMb` still holds one more
 * session's mean above earlyoom's line and the margin, the machine's hard
 * limit (CLAUDE.md §Machine limits).
 *
 * Priced at the mean, not the p95 aggregate the draw slots use, and against
 * memory the lander's suite reserve (workflow-core#2416) is NOT taken from: a floor slot
 * may admit into the lander's hold. The residual risk is a floor slot's
 * session plus a lander's suite eating into the margin above earlyoom's line,
 * which the founder's floor accepts until workflow-core#2495.
 * @param {number} sessionFloor
 * @param {number} working the sessions in a working state, the caller included
 * @param {number} effectiveMb free memory less the spare pool's reserve
 * @param {SessionDraw} host
 */
function sessionFloorSlotsOf(sessionFloor, working, effectiveMb, host) {
	const wanted = Math.max(0, sessionFloor - working);
	const room = Math.floor(sessionBudgetMb(effectiveMb, 0, 0) / host.meanMb);
	return Math.max(0, Math.min(wanted, room));
}

/**
 * The session floor as the ADMISSION blocks print it, or null where none is
 * declared and none went unread.
 * @param {SessionFloor} floor
 * @param {{ sessionFloorWorking: number, sessionFloorSlots: number, swapHold: SwapHold }} verdict
 */
function buildSessionFloorLine(floor, verdict) {
	if (floor.problem)
		return `none — the declared floor went unread: ${floor.problem}`;
	if (floor.sessions === 0) return null;
	const head = `${floor.sessions} working sessions (~/.claude/session-floor, workflow-core#2501); ${verdict.sessionFloorWorking} working, this run's own counted, so ${verdict.sessionFloorSlots} floor slot(s)`;
	const hold = verdict.swapHold;
	if (!hold.held) return head;
	return `${head}, held while ${swapHoldText(hold)}, under ${SWAP_HOLD_FREE_FRACTION * 100}% and ${SWAP_HOLD_AVAILABLE_MB} MB (workflow-core#2690)`;
}

/**
 * Whether the always-admit-one guarantee holds: nothing of ours running and
 * memory admitting none. A zero count no listing vouched for never unlocks it
 * (workflow-core#2180).
 * @param {FloorProcs} procs
 * @param {number} byMemory
 */
function isGuaranteed(procs, byMemory) {
	return procs.sessions === 0 && !procs.unvouched && byMemory < 1;
}

/**
 * The session floor's figures both verdicts report: the working sessions,
 * this run's own counted, the floor slots, none while `swapHold` binds
 * (workflow-core#2690), and whether they lift `priced`, the slots the p95 pricing and the
 * guarantee give.
 * @param {{ sessionFloor: number, procs: FloorProcs, effectiveMb: number, host: SessionDraw, priced: number, swapHold: SwapHold }} input
 * @returns {SessionFloorFigures}
 */
function sessionFloorFigures({
	sessionFloor,
	procs,
	effectiveMb,
	host,
	priced,
	swapHold,
}) {
	const sessionFloorWorking = procs.working + (procs.self ? 1 : 0);
	const sessionFloorSlots = swapHold.held
		? 0
		: sessionFloorSlotsOf(sessionFloor, sessionFloorWorking, effectiveMb, host);
	return {
		sessionFloor,
		sessionFloorWorking,
		sessionFloorSlots,
		sessionFloorLifted: sessionFloorSlots > priced,
		swapHold,
	};
}

/**
 * A floor lift as both verdicts' reasons name it.
 * @param {SessionFloorFigures} floor
 */
function floorClause(floor) {
	return `FLOOR: ${floor.sessionFloorSlots} slot(s) toward the ${floor.sessionFloor} working sessions ~/.claude/session-floor keeps (workflow-core#2501), ${floor.sessionFloorWorking} working, over the p95 pricing`;
}

/**
 * The host's session draw as the ADMISSION blocks print it.
 * @param {SessionDraw} draw
 */
function buildSessionDrawLine(draw) {
	const figures = `mean ${draw.meanMb} MB, σ ${draw.sigmaMb} MB`;
	if (draw.declared)
		return `${figures} — this repo's declared sessionMeanMb and sessionSigmaMb, its sessions' tools included`;
	const line = `${figures} — one working session's draw, its tools included (${docPath("environment.md")})`;
	return draw.problem
		? `${line}; a declared figure went unread: ${draw.problem}`
		: line;
}

/**
 * The repo a session's cwd sits in: the nearest ancestor holding `.git` (a
 * worktree's is a file, and a submodule's is its own), else null.
 * @param {string} cwd
 */
function repoRootOf(cwd) {
	for (let dir = cwd; ; ) {
		if (fs.existsSync(nodePath.join(dir, ".git"))) return dir;
		const up = nodePath.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/**
 * One live session's draw: its repo's, read once per repo through `byRoot`,
 * and why it fell back to the default, if it did.
 * @param {string} id
 * @param {string} cwd
 * @param {Map<string, SessionDraw>} byRoot accumulator: each repo's draw is cached here on its first read
 * @returns {{ draw: SessionDraw, problem: string | null }} `problem` is set only
 *   on the read that found it, a cached repo's draw carrying none
 */
function readLiveSessionDraw(id, cwd, byRoot) {
	const root = cwd ? repoRootOf(cwd) : null;
	if (!root)
		return {
			draw: UNDECLARED_DRAW,
			problem: cwd ? `${cwd} is in no repo` : `session ${id} lists no cwd`,
		};
	const cached = byRoot.get(root);
	if (cached !== undefined) return { draw: cached, problem: null };
	const draw = readSessionDraw(root);
	byRoot.set(root, draw);
	return {
		draw,
		problem: draw.problem ? `${root}: ${draw.problem}` : null,
	};
}

/**
 * This run's own session id, left out exactly as `liveSessions` leaves it out:
 * by id, or without one as the lone listed session.
 * @param {Set<string>} ids
 */
function selfId(ids) {
	return (
		process.env.CLAUDE_CODE_SESSION_ID ||
		(ids.size === 1 ? [...ids][0] : undefined)
	);
}

/**
 * The live sessions' summed draw for a `listedSessionIds()` read: every
 * listed session other than this run's that has not ended — done, failed or
 * stopped, the listing's `terminal` set, which never draws again. Idle,
 * waiting and parked (`blocked`) sessions are charged their repo's draw, less
 * what they hold: a resumed turn draws like any other (workflow-core#2280). Residual: a
 * parked session's headroom stays reserved, unused, until it is answered or
 * stopped.
 *
 * A listed session with no pid has no process: the daemon retires one parked
 * at its prompt and respawns it when answered, at a working draw, so it is
 * charged its whole draw too (workflow-core#2426). Residual: one that is never answered
 * holds that headroom until it is stopped.
 *
 * A refused listing sums nothing.
 * A session whose memory will not read is credited no current PSS, so it is
 * charged its whole draw; one with no cwd, outside any repo, or whose repo
 * config will not read, is charged the default draw, and `problems` says why.
 * @param {{ ids?: Set<string>, pids?: Map<string, number>, terminal?: Set<string>, cwds?: Map<string, string> }} listed
 * @param {{ ps: PsRead, pssKbOf: (pid: string) => number | null, children: Map<string, string[]> }} readings
 * @returns {LiveDraw}
 */
function liveDraw({ ids, pids, terminal, cwds }, { ps, pssKbOf, children }) {
	/** @type {LiveDraw} */
	const draw = { ...NO_LIVE_DRAW, problems: [] };
	if (!ids) return { ...draw, refused: true };
	/* Only an id names this run's own session here, never selfId's lone-session
	 * guess: the refill loop asks with no session of its own, and leaving out
	 * the one live session would charge it nothing (workflow-core#2139). */
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	const ended = terminal ?? new Set();
	const spares = ps.ok ? spareProcesses(ps.rows) : [];
	/** @type {Map<string, SessionDraw>} */
	const byRoot = new Map();
	let heldKb = 0;
	for (const id of ids) {
		if (id === me || ended.has(id)) continue;
		const own = readLiveSessionDraw(id, cwds?.get(id) ?? "", byRoot);
		if (own.problem) draw.problems.push(own.problem);
		draw.sessions++;
		draw.meanMb += own.draw.meanMb;
		draw.varianceMb2 += own.draw.sigmaMb ** 2;
		const sum = sessionsPssKb([id], { pids, spares, pssKbOf, children });
		draw.noProcess += sum.noProcess;
		if (sum.kb === null) draw.unread++;
		else heldKb += sum.kb;
	}
	draw.pssMb = Math.floor(heldKb / 1024);
	return draw;
}

/**
 * What the live sessions and `k` more still need at the aggregate's p95, less
 * what the live ones already hold. Negative
 * where the live sessions already hold more than that.
 * @param {LiveDraw} live
 * @param {SessionDraw} host
 * @param {number} k
 */
function drawNeedFor(live, host, k) {
	return Math.ceil(
		live.meanMb +
			k * host.meanMb +
			DRAW_Z * Math.sqrt(live.varianceMb2 + k * host.sigmaMb ** 2) -
			live.pssMb,
	);
}

/**
 * What admits sessions, from `baseMb`, memory less the pool reserve.
 * @param {number} baseMb
 * @param {number} landerMb
 * @param {number} reclaimMb
 */
function sessionBudgetMb(baseMb, landerMb, reclaimMb) {
	return baseMb - landerMb - EARLYOOM_FLOOR_MB - DRAW_MARGIN_MB + reclaimMb;
}

/**
 * `drawNeedFor` plus the spare pairs the 2nd to k-th of k launches warm, each
 * `launchMb`: the budget already reserves the 1st's (workflow-core#2511).
 * @param {LiveDraw} live
 * @param {SessionDraw} host
 * @param {number} k
 * @param {number} launchMb
 */
function launchNeedFor(live, host, k, launchMb) {
	return drawNeedFor(live, host, k) + Math.max(0, k - 1) * launchMb;
}

/**
 * How many more of this host's sessions `budgetMb` admits on the aggregate
 * draw: the largest k whose need fits, 0 where none does.
 * @param {number} budgetMb
 * @param {LiveDraw} live
 * @param {SessionDraw} host
 * @param {number} launchMb see `launchNeedFor`
 */
function drawSlots(budgetMb, live, host, launchMb) {
	let k = 0;
	while (launchNeedFor(live, host, k + 1, launchMb) <= budgetMb) k++;
	return k;
}

/** @param {LiveDraw} live */
function buildLiveDrawLine(live) {
	if (live.refused)
		return "unknown — the session listing was refused, so no live session's draw is counted";
	const line = `${live.sessions} live session(s): mean ${live.meanMb} MB + ${DRAW_Z} × σ ${Math.round(Math.sqrt(live.varianceMb2))} MB − ${live.pssMb} MB they already hold`;
	const notes = [
		...(live.noProcess
			? [`${live.noProcess} with no process, charged in full`]
			: []),
		...(live.unread ? [`${live.unread} charged in full, memory unread`] : []),
		...(live.problems.length > 0
			? [
					`charged the default draw where a repo's went unread: ${live.problems.join("; ")}`,
				]
			: []),
	];
	return notes.length > 0 ? `${line}; ${notes.join("; ")}` : line;
}

/**
 * The pending pairs `launchNeedFor` adds to k slots' need: none at one slot or
 * without a launch price.
 * @param {number} k
 * @param {number} launchMb
 */
const buildPairsText = (k, launchMb) =>
	launchMb > 0 && k > 1 ? `${k - 1} more spare pair(s) at ${launchMb} MB` : "";

/**
 * `buildPairsText` as a clause.
 * @param {number} k
 * @param {number} launchMb
 */
const pairsClause = (k, launchMb) => {
	const pairs = buildPairsText(k, launchMb);
	return pairs ? `, with ${pairs},` : "";
};

const shortOfOneMore = (/** @type {number} */ needMb) =>
	`, under the ${needMb} MB the live sessions' draw and one more need at p95`;

/** @param {number} mb */
const buildLanderNote = (mb) =>
	mb ? `, holding ${mb} MB for the lander's suite` : "";

/* The floor and margin as a verdict's reason clause. */
const HELD_NOTE = `, holding ${EARLYOOM_FLOOR_MB} + ${DRAW_MARGIN_MB} MB above earlyoom's kill line`;

/** @returns {{ ok: true, workers: number, whole: number } | { ok: false, error: string }} */
function readRunningVitestSuites() {
	const ps = readPs();
	if (!ps.ok) return ps;
	const { workers, whole } = runningSuites(
		ps.rows,
		undefined,
		readCarriedWeightOf,
	);
	return { ok: true, workers, whole };
}

const MEMINFO = () => process.env.WFC_MEMINFO || "/proc/meminfo";
const PROC = () => process.env.WFC_PROC || "/proc";

/*
 * The daemon process itself plus every pre-warmed spare pair it keeps idle for
 * fast launch, which the memory breakdown shows as resident.
 *
 * THE RESERVE IS ONE IDLE PAIR, NOT THIS WHOLE POOL (workflow-core#2223). The pool is
 * resident, so `MemAvailable` already excludes it. What admission cannot yet
 * see is a spare the daemon spawns beyond the claims it refills, at most one
 * pair in flight at a time; a spare is resident within a second, so the next
 * reading counts it. `poolReserve` prices that one pair.
 *
 * PSS, NEVER RSS (mantahostels#1287). The pool's processes are near-identical forks of one
 * binary, so most of their resident pages are SHARED, and summing RSS counts
 * every one of those pages once per process (`docs/environment.md` §5).
 * `/proc/<pid>/smaps_rollup` divides each shared page by its sharer count. A
 * process whose rollup cannot be read falls back to its own RSS, which
 * over-states rather than under-states.
 *
 * A CLAIMED SPARE IS A LIVE SESSION AND KEEPS ITS `/spare/` PATH (mantahostels#1287,
 * measurement there too). The claim does not rewrite argv, and no process
 * carries `--session-id`, so nothing on the command line tells a claimed pair
 * from an idle one. `livePids` is the discriminator: `claude agents --json` gives
 * each session's pid, that pid IS the `bg-spare` process, and both halves of
 * its pair share one socket id. A live session is priced through its
 * session draw, so counting it here would over-state the idle pair's price.
 *
 * Passing no `livePids` counts every pair as idle — an over-statement, never
 * an under-statement.
 *
 * The claude test on argv[0] comes FIRST, so a shell pipeline whose command
 * line merely mentions `/spare/` is not swept in (`docs/environment.md` §5).
 *
 * DUPLICATED BY HAND as SPARE_SOCKET in scripts/lib/claude_sessions.py, which
 * the session memory sampler pairs by: move both, or neither (workflow-core#2231).
 */
const SPARE_SOCKET = /\/spare\/([A-Za-z0-9]+)\./;

/** One `ps -eo pid=,rss=,args=` row: pid, RSS in KB, argv. */
const PS_ROW_RE = /^(\d+)\s+(\d+)\s+(.*)$/;

/**
 * Every process one `ps` read lists, so the spare-pool scan and the memory
 * breakdown share a single spawn.
 * @returns {PsRead}
 */
function readPsRows() {
	try {
		const out = execFileSync(PS_BIN(), ["-eo", "pid=,rss=,args="], {
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		});
		/** @type {PsRow[]} */
		const rows = [];
		for (const line of out.split("\n")) {
			const m = line.trim().match(PS_ROW_RE);
			if (m)
				rows.push({
					pid: requiredGroup(m, 1, PS_ROW_RE),
					rssKb: Number(requiredGroup(m, 2, PS_ROW_RE)),
					args: requiredGroup(m, 3, PS_ROW_RE),
				});
		}
		return { ok: true, rows };
	} catch (e) {
		return { ok: false, error: parseErrLine(e) };
	}
}

/**
 * The claude processes the spare-pool scan prices: the daemon and every
 * `/spare/` process, each with its pair's socket id.
 * @param {PsRow[]} rows
 */
function spareProcesses(rows) {
	return rows
		.filter((r) => {
			if (!isClaudeArgv0(r.args.split(/\s+/)[0] || "")) return false;
			return (
				r.args.includes("/spare/") || /(^|\s)daemon\s+run(\s|$)/.test(r.args)
			);
		})
		.map((r) => ({ ...r, socket: r.args.match(SPARE_SOCKET)?.[1] }));
}

/**
 * @param {Set<string>} [livePids]
 * @param {PsRead} [ps] a `readPsRows()` read already taken, else one is taken here
 * @returns {SpareOverhead}
 */
function daemonSpareOverheadMb(livePids = new Set(), ps = readPsRows()) {
	if (!ps.ok) return { ok: false, error: ps.error };
	const rows = spareProcesses(ps.rows);
	/* Both halves of a claimed pair share the live session's socket id. */
	const liveSockets = new Set(
		rows.filter((r) => livePids.has(r.pid) && r.socket).map((r) => r.socket),
	);
	let kb = 0;
	/* The idle pairs' own PSS, the daemon left out: it is one process
	 * whatever the pool's size, so no pair costs a share of it (workflow-core#2283). */
	let pairKb = 0;
	/* The idle pool's own PAIR count — one socket id per pair, both halves
	 * sharing it (mantahostels#2588). */
	const idleSockets = new Set();
	for (const r of rows) {
		if (livePids.has(r.pid)) continue;
		if (r.socket && liveSockets.has(r.socket)) continue;
		const pss = readPssKb(r.pid);
		const rowKb = pss === null ? r.rssKb : pss;
		kb += rowKb;
		if (r.socket) {
			idleSockets.add(r.socket);
			pairKb += rowKb;
		}
	}
	return {
		ok: true,
		mb: Math.floor(kb / 1024),
		idlePairs: idleSockets.size,
		/* null, never a fallback, where the pool holds no idle pair: the
		 * caller decides what an unmeasurable pair costs, and a 0 here would
		 * read as a free one. */
		perPairMb:
			idleSockets.size > 0
				? Math.floor(pairKb / 1024 / idleSockets.size)
				: null,
	};
}

/**
 * A session's pids: its own and its socket partner's, paired as the pool scan
 * pairs them. A session with no `/spare/` socket is its own pid alone.
 * DUPLICATED BY HAND as session_pair in scripts/lib/claude_sessions.py: move
 * both, or neither (workflow-core#2231).
 * @param {ReturnType<typeof spareProcesses>} spares
 * @param {string} pid
 */
function sessionPairPids(spares, pid) {
	const socket = spares.find((r) => r.pid === pid)?.socket;
	if (!socket) return [pid];
	return spares.filter((r) => r.socket === socket).map((r) => r.pid);
}

/*
 * What ONE idle spare pair costs where the pool holds no idle pair to measure
 * (mantahostels#2588): the price of the pair `poolReserve` always reserves (workflow-core#2223)
 * and of each pending one. It is the PSS of an IDLE pair, not the ~400 MB a
 * CLAIMED one grows to: the spare a launch is about to warm is unclaimed until
 * the NEXT launch takes it, and the claimed one is already priced through the
 * draw of the session that holds it. Re-measure with `node scripts/admission.js --json`
 * while the pool holds an idle pair and no `--launch`: its `reservedMb` is
 * then one pair's price. Three such readings on 22 Oct 2026 gave 101-102 MB, so
 * 106 errs about 5 MB high, the safe side (workflow-core#2283).
 */
const IDLE_PAIR_MB = 106;

/* The spare pairs one launch makes the daemon warm: it replaces the one the
 * launch claims (mantahostels#2588). */
const LAUNCH_SPARES = 1;

/**
 * What admission reserves for the spare pool: one idle pair (workflow-core#2223), and on
 * top the spare(s) a launch is ABOUT to warm (mantahostels#2588). A launcher re-reading
 * admission immediately before each spawn sees every spare already resident
 * and none of the one the daemon refills the pool with the moment this launch
 * claims its own.
 *
 * Each pair is priced off THIS pool's own idle pairs where there are any, and
 * off `IDLE_PAIR_MB` where there are none.
 *
 * NO CEILING (workflow-core#2223). A pool whose rollups cannot be read prices each pair at
 * its RSS, so a sick reading can still over-reserve; it never under-reserves.
 *
 * An unread pool reserves nothing, the pair included: `strictAdmission` fails
 * open on it, and the memory read it refines already fails closed.
 *
 * @param {SpareOverhead} pool from `daemonSpareOverheadMb`
 * @param {number} spares how many pairs the caller is about to cause
 * @returns {PoolReserve}
 */
function poolReserve(pool, spares) {
	const pending = Number.isFinite(spares) && spares > 0 ? spares : 0;
	if (!pool.ok)
		return {
			ok: false,
			error: pending
				? `${pool.error} — and with it the reserve for the ${pending} spare(s) this launch is about to warm`
				: pool.error,
		};
	const perPairMb =
		typeof pool.perPairMb === "number" && pool.perPairMb > 0
			? pool.perPairMb
			: IDLE_PAIR_MB;
	const pendingMb = Math.round(pending * perPairMb);
	return { ok: true, mb: perPairMb + pendingMb, perPairMb, pendingMb };
}

/**
 * MB a session start is about to reclaim (mantahostels#1288): `claude agents --json` lists
 * a finished-but-resident background session exactly as it lists a working
 * one, but `.claude/skills/pick-next` §5 has the next session start reaping
 * whatever is past grace on its way up, so that memory is about to be free.
 *
 * NEVER RE-DERIVES WHICH SESSIONS QUALIFY. `reap-finished-sessions.js
 * --dry-run --json` already applies every gate — including the grace window —
 * and reports `pss` per reapable session.
 *
 * FAILS CLOSED TO 0: on a spawn failure, unparseable output, a `reaped` field
 * that is not an array, or an individual entry whose own `pss` is not a
 * number (unreadable smaps_rollup) — over-crediting risks the over-admission
 * this gate exists to prevent (mantahostels#1287).
 * @returns {{ ok: true, mb: number, count: number } | { ok: false, error: string }}
 */
function reclaimableMb() {
	try {
		const out = execFileSync(
			process.execPath,
			[REAP_SCRIPT(), "--dry-run", "--json"],
			{ encoding: "utf8", maxBuffer: CHILD_MAX_BUFFER },
		);
		const parsed = JSON.parse(out);
		if (!Array.isArray(parsed.reaped))
			return { ok: false, error: "the reap plan carried no reaped list" };
		const mb = parsed.reaped.reduce(
			(/** @type {number} */ n, /** @type {{ pss?: unknown }} */ r) =>
				n + (typeof r.pss === "number" ? r.pss : 0),
			0,
		);
		return { ok: true, mb, count: parsed.reaped.length };
	} catch (e) {
		return { ok: false, error: parseErrLine(e) };
	}
}

/**
 * `Pss` in kB from a process's smaps_rollup, or null where it cannot be read.
 * @param {string | number} pid
 */
function readPssKb(pid) {
	try {
		const m = fs
			.readFileSync(`${PROC()}/${pid}/smaps_rollup`, "utf8")
			.match(/^Pss:\s+(\d+) kB$/m);
		return m ? Number(m[1]) : null;
	} catch {
		return null;
	}
}

/**
 * MemAvailable, never MemFree — which counts reclaimable cache as spent.
 * @returns {MbResult}
 */
function readAvailableMb() {
	return availableFrom(readMeminfoKb());
}

/**
 * MemAvailable, MemTotal and swap in kB off ONE read, so the admission figure,
 * the breakdown's free row and the swap hold cannot disagree. A missing
 * MemTotal leaves `totalKb` null, which only the breakdown reads; missing swap
 * lines leave theirs null, which `swapHoldOf` reads as no hold.
 * @returns {MeminfoRead}
 */
function readMeminfoKb() {
	const path = MEMINFO();
	try {
		const text = fs.readFileSync(path, "utf8");
		/** @param {string} key */
		const kb = (key) => {
			const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
			return m ? Number(m[1]) : null;
		};
		const availableKb = kb("MemAvailable");
		if (availableKb === null)
			return { ok: false, error: `${path} carries no MemAvailable line` };
		return {
			ok: true,
			totalKb: kb("MemTotal"),
			availableKb,
			swapTotalKb: kb("SwapTotal"),
			swapFreeKb: kb("SwapFree"),
		};
	} catch (e) {
		return { ok: false, error: parseErrLine(e) };
	}
}

/**
 * `readAvailableMb`'s answer, from a `readMeminfoKb` read already taken.
 * @param {MeminfoRead} read
 * @returns {MbResult}
 */
const availableFrom = (read) =>
	read.ok
		? { ok: true, mb: Math.floor(read.availableKb / 1024) }
		: { ok: false, error: read.error };

/*
 * The swap hold's two lines (workflow-core#2668, measured on workflow-core#2690): swap under a quarter
 * free, and MemAvailable under the default session's p95 above earlyoom's line
 * and the margin, rounded up to 100 MB: `WFC_HEADROOM_FLOOR_MB`'s derivation
 * in docs/environment.md, whose default in `scripts/shell-start-warn.sh` the
 * suite holds equal. Residual: the hold goes with the floor when workflow-core#2495's spec
 * removes it.
 */
const SWAP_HOLD_FREE_FRACTION = 0.25;
const SWAP_HOLD_AVAILABLE_MB =
	Math.ceil(
		(EARLYOOM_FLOOR_MB +
			DRAW_MARGIN_MB +
			DEFAULT_SESSION_DRAW.meanMb +
			Math.ceil(DRAW_Z * DEFAULT_SESSION_DRAW.sigmaMb)) /
			100,
	) * 100;
/** @type {SwapHold} */
const NO_SWAP_HOLD = { held: false };

/**
 * Whether the swap hold binds: both lines crossed at once. No swap, or a
 * meminfo carrying no swap lines, is no hold.
 * @param {MeminfoRead} read
 * @returns {SwapHold}
 */
function swapHoldOf(read) {
	if (!read.ok || !read.swapTotalKb || read.swapFreeKb === null)
		return NO_SWAP_HOLD;
	const memAvailableMb = Math.floor(read.availableKb / 1024);
	if (
		read.swapFreeKb >= SWAP_HOLD_FREE_FRACTION * read.swapTotalKb ||
		memAvailableMb >= SWAP_HOLD_AVAILABLE_MB
	)
		return NO_SWAP_HOLD;
	return {
		held: true,
		swapFreeMb: Math.floor(read.swapFreeKb / 1024),
		swapTotalMb: Math.floor(read.swapTotalKb / 1024),
		availableMb: memAvailableMb,
	};
}

/**
 * A binding swap hold's two readings, as a log line names them.
 * @param {Extract<SwapHold, {held: true}>} hold
 */
const swapHoldText = (hold) =>
	`swap is ${hold.swapFreeMb} of ${hold.swapTotalMb} MB free and ${hold.availableMb} MB available`;

/**
 * Whether the swap hold binds now, off a fresh meminfo read.
 * @returns {SwapHold}
 */
const readSwapHold = () => swapHoldOf(readMeminfoKb());

/**
 * @typedef {{ mb: number | null, unknown: string | null }} MemRow
 * @typedef {{
 *   totalMb: number | null,
 *   rounding: string,
 *   free: MemRow,
 *   working: MemRow & { count: number | null, noProcess?: number },
 *   finished: MemRow & { count: number | null, reapable: number | null, reapableUnknown: string | null },
 *   pool: MemRow,
 *   other: MemRow & { overlapMb: number, largest: { pid: string, rssMb: number, command: string }[] },
 *   slots: { unknown: string | null, availableMb?: number, poolReserveMb?: number, landerMb?: number, floorMb?: number, marginMb?: number, reclaimMb?: number, budgetMb?: number, drawNeedMb?: number, nextNeedMb?: number, launchMb?: number, byMemory?: number, memorySlots?: number, sessionFloor?: number, sessionFloorLifted?: boolean, slots?: number, overloaded?: boolean },
 *   cpu: CpuSlots,
 * }} MemoryBreakdown
 */

/* A slot-count reply names a handful of culprits, not a process table. */
const LARGEST_SHOWN = 3;
/* Enough of a command line to tell a vitest from a dev server. */
const COMMAND_CHARS = 60;

const ROUNDING =
	"each row floored to the MB; the rows sum to MemTotal, the flooring (under 5 MB) landing in everything else, plus any overlap everything else names";

/** @param {string} reason @returns {MemRow} */
const unknownRow = (reason) => ({ mb: null, unknown: reason });

/**
 * Each pid's children, off every `<proc>/<pid>/stat` that reads. An unreadable
 * `/proc` gives an empty map, so no descendant is seen: the sessions then read
 * low and are charged more of their draw, erring towards holding a slot back.
 * @returns {Map<string, string[]>}
 */
function readProcessChildren() {
	/** @type {Map<string, string[]>} */
	const children = new Map();
	let entries;
	try {
		entries = fs.readdirSync(PROC());
	} catch {
		/* Unprinted: an unreadable /proc fails every PSS read too, which
		 * buildLiveDrawLine already prints as memory unread (workflow-core#2139). */
		return children;
	}
	for (const pid of entries) {
		if (!/^\d+$/.test(pid)) continue;
		/* Unread where it exited since the listing: it has no children left to
		 * count (workflow-core#2139). */
		const ppid = String(readParentOf(pid, PROC()));
		if (ppid === "0") continue;
		const list = children.get(ppid);
		if (list) list.push(pid);
		else children.set(ppid, [pid]);
	}
	return children;
}

/**
 * The summed PSS of the sessions' pairs and every process each session starts,
 * each pid reached on the way, and how many sessions listed no pid. A descendant that is itself a listed
 * session is left to its own row, and one whose smaps will not read, most
 * often one that has just exited, adds nothing. A session that lists no pid
 * has no process, so adds nothing (workflow-core#2426). The first unreadable pair smaps
 * stops the sum.
 * @param {string[]} ids
 * @param {{
 *   pids: Map<string, number> | undefined,
 *   spares: ReturnType<typeof spareProcesses>,
 *   pssKbOf: (pid: string) => number | null,
 *   children: Map<string, string[]>,
 * }} ctx
 * @returns {({ kb: number, unknown: null } | { kb: null, unknown: string }) & { reached: string[], noProcess: number }}
 */
function sessionsPssKb(ids, { pids, spares, pssKbOf, children }) {
	let kb = 0;
	let noProcess = 0;
	/** @type {string[]} */
	const reached = [];
	const sessionPids = new Set([...(pids?.values() ?? [])].map(String));
	for (const id of ids) {
		const pid = pids?.get(id);
		if (pid === undefined) {
			noProcess++;
			continue;
		}
		for (const p of sessionPairPids(spares, String(pid))) {
			reached.push(p);
			const pss = pssKbOf(p);
			if (pss === null)
				return {
					kb: null,
					unknown: `pid ${p}'s smaps_rollup unreadable`,
					reached,
					noProcess,
				};
			kb += pss;
		}
		kb += descendantsPssKb(
			String(pid),
			{ children, sessionPids, pssKbOf },
			reached,
		);
	}
	return { kb, unknown: null, reached, noProcess };
}

/**
 * The PSS of every process under `pid`, pushing each onto `reached`. A listed
 * session's subtree is its own to charge, so the walk stops there; an
 * unreadable descendant adds nothing. The stop is DUPLICATED BY HAND in
 * scripts/sample_session_memory.py's descendants: move both, or neither (workflow-core#2231).
 * @param {string} pid
 * @param {{ children: Map<string, string[]>, sessionPids: Set<string>, pssKbOf: (pid: string) => number | null }} tree
 * @param {string[]} reached accumulator
 */
function descendantsPssKb(pid, { children, sessionPids, pssKbOf }, reached) {
	let kb = 0;
	const queue = [...(children.get(pid) ?? [])];
	for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
		if (sessionPids.has(d)) continue;
		reached.push(d);
		kb += pssKbOf(d) ?? 0;
		queue.push(...(children.get(d) ?? []));
	}
	return kb;
}

/**
 * What the live landers' suites still need (workflow-core#2416): each lander's slot less
 * the floor and margin every budget already holds, less the current PSS of
 * the processes it started, which MemAvailable already shows, so the suite
 * counts once. The lander's own process was resident before the dip its slot
 * was measured on, so it earns no credit. A lander a session started stays
 * charged its whole draw, as the session's own PSS already credits it.
 * @param {Landers} landers
 * @param {{ pssKbOf: (pid: string) => number | null, children: Map<string, string[]>, sessionPids: Set<string> }} tree
 */
function landerHeldMb({ pids, slotMb }, { pssKbOf, children, sessionPids }) {
	const drawMb = slotMb - EARLYOOM_FLOOR_MB - DRAW_MARGIN_MB;
	/** @type {string[]} */
	const underSessions = [];
	for (const pid of sessionPids)
		descendantsPssKb(
			pid,
			{ children, sessionPids, pssKbOf: () => 0 },
			underSessions,
		);
	let mb = 0;
	for (const pid of pids.map(String)) {
		const kb = underSessions.includes(pid)
			? 0
			: descendantsPssKb(pid, { children, sessionPids, pssKbOf }, []);
		mb += Math.max(0, drawMb - Math.floor(kb / 1024));
	}
	return mb;
}

/**
 * The breakdown's everything-else row: MemTotal less the rows above it, and
 * the largest processes that are neither a session nor the spare pool.
 * @param {{
 *   blocked: boolean,
 *   totalMb: number | null,
 *   parts: MemRow[],
 *   ps: PsRead,
 *   spares: ReturnType<typeof spareProcesses>,
 *   sessionPids: Set<string>,
 * }} input
 * @returns {MemoryBreakdown["other"]}
 */
function otherRow({ blocked, totalMb, parts, ps, spares, sessionPids }) {
	if (blocked || totalMb === null)
		return {
			...unknownRow(
				blocked ? "a row above it is unknown" : "MemTotal unreadable",
			),
			overlapMb: 0,
			largest: [],
		};
	const rest =
		totalMb - parts.reduce((n, r) => n + /** @type {number} */ (r.mb), 0);
	const poolPids = new Set(spares.map((r) => r.pid));
	const largest = ps.ok
		? ps.rows
				.filter((r) => !sessionPids.has(r.pid) && !poolPids.has(r.pid))
				.sort((a, b) => b.rssKb - a.rssKb)
				.slice(0, LARGEST_SHOWN)
				.map((r) => ({
					pid: r.pid,
					rssMb: Math.floor(r.rssKb / 1024),
					command: r.args.slice(0, COMMAND_CHARS).trim(),
				}))
		: [];
	/* PSS carries file-backed pages MemAvailable already counts free, so the
	 * rows can overlap; the overlap is named rather than printed negative. */
	return {
		mb: Math.max(0, rest),
		unknown: null,
		overlapMb: Math.max(0, -rest),
		largest,
	};
}

/**
 * @param {ReturnType<typeof strictAdmission>} verdict
 * @returns {MemoryBreakdown["slots"]}
 */
function slotsRow(verdict) {
	return verdict.ok
		? {
				unknown: null,
				availableMb: verdict.availableMb,
				poolReserveMb: verdict.reservedMb,
				landerMb: verdict.landerMb,
				floorMb: verdict.floorMb,
				marginMb: verdict.marginMb,
				reclaimMb: verdict.reclaimedMb,
				budgetMb: verdict.budgetMb,
				drawNeedMb: verdict.drawNeedMb,
				nextNeedMb: verdict.nextNeedMb,
				launchMb: verdict.launchMb,
				byMemory: verdict.byMemory,
				memorySlots: verdict.memorySlots,
				sessionFloor: verdict.sessionFloor,
				sessionFloorLifted: verdict.sessionFloorLifted,
				slots: verdict.slots,
				overloaded: verdict.load.overloaded,
			}
		: { unknown: verdict.error };
}

/**
 * Where the machine's memory is going (workflow-core#589): free, working sessions, finished
 * sessions still resident, the daemon and spare pool, everything else, and the
 * arithmetic from free memory to the slot count, with the CPU limb's slot count
 * beside it (workflow-core#2141). PURE: every reading comes in.
 *
 * A session is its pair's PSS, the pairing `daemonSpareOverheadMb` uses, plus
 * every process it starts, so it agrees with the session draw, which counts
 * both. "Finished" is the listing's own
 * `finished` set, the reaper's gate 1; how many the next reap takes is the
 * count off the dry-run read `reclaimableMb` already made, never a reap.
 *
 * An unreadable input makes its row `unknown` with the reason, never 0, and
 * everything else is `unknown` whenever any row it is the remainder of is.
 *
 * @param {{
 *   meminfo: MeminfoRead,
 *   ps: PsRead,
 *   listed: { why?: string, ids?: Set<string>, pids?: Map<string, number>, finished?: Set<string> },
 *   pssKbOf: (pid: string) => number | null,
 *   pool: SpareOverhead,
 *   reclaimable: { ok: true, mb: number, count: number } | { ok: false, error: string },
 *   verdict: ReturnType<typeof strictAdmission>,
 *   children: Map<string, string[]>,
 *   cpu: CpuSlots,
 * }} readings
 * @returns {MemoryBreakdown}
 */
function memoryBreakdown({
	meminfo,
	ps,
	listed,
	pssKbOf,
	pool,
	reclaimable,
	verdict,
	children,
	cpu,
}) {
	const totalMb =
		meminfo.ok && meminfo.totalKb !== null
			? Math.floor(meminfo.totalKb / 1024)
			: null;
	const free = meminfo.ok
		? { mb: Math.floor(meminfo.availableKb / 1024), unknown: null }
		: unknownRow(`memory unreadable: ${meminfo.error}`);

	const spares = ps.ok ? spareProcesses(ps.rows) : [];
	/* Filled as the session rows are summed, to keep sessions out of the
	 * largest-process list. An early `unknown` return leaves it partial, which
	 * is safe only because that makes everything else unknown too. */
	/** @type {Set<string>} */
	const sessionPids = new Set();
	const { ids: listedIds, pids, finished: finishedSet } = listed;
	const refused =
		listed.why ?? (listedIds && pids && finishedSet ? null : "no ids listed");
	/**
	 * @param {string[]} ids
	 * @returns {MemRow & { count: number | null, noProcess?: number }}
	 */
	const sessionsRow = (ids) => {
		if (refused !== null)
			return { count: null, ...unknownRow(`session listing: ${refused}`) };
		if (!ps.ok)
			return {
				count: ids.length,
				...unknownRow(
					`ps unreadable, so no session can be paired: ${ps.error}`,
				),
			};
		const sum = sessionsPssKb(ids, { pids, spares, pssKbOf, children });
		for (const p of sum.reached) sessionPids.add(p);
		if (sum.kb === null)
			return { count: ids.length, ...unknownRow(sum.unknown) };
		return {
			count: ids.length,
			mb: Math.floor(sum.kb / 1024),
			unknown: null,
			...(sum.noProcess ? { noProcess: sum.noProcess } : {}),
		};
	};
	const finishedIds = [...(finishedSet ?? [])];
	const workingIds = [...(listedIds ?? [])].filter(
		(id) => !finishedSet?.has(id),
	);
	const working = sessionsRow(workingIds);
	const finishedRow = sessionsRow(finishedIds);
	const finished = {
		...finishedRow,
		reapable: reclaimable.ok ? reclaimable.count : null,
		reapableUnknown: reclaimable.ok ? null : `reap plan: ${reclaimable.error}`,
	};
	const poolMem = pool.ok
		? { mb: pool.mb, unknown: null }
		: unknownRow(`spare-pool scan: ${pool.error}`);

	const parts = [free, working, finishedRow, poolMem];
	const blocked = parts.find((r) => r.unknown !== null);
	const other = otherRow({
		blocked: Boolean(blocked),
		totalMb,
		parts,
		ps,
		spares,
		sessionPids,
	});
	const slots = slotsRow(verdict);

	return {
		totalMb,
		rounding: ROUNDING,
		free,
		working,
		finished,
		pool: poolMem,
		other,
		slots,
		cpu,
	};
}

/**
 * The breakdown as text rows, for `admission.js`'s report.
 * @param {MemoryBreakdown} m
 */
function buildMemoryBreakdownLines(m) {
	/** @param {MemRow} r @param {string} text */
	const orUnknown = (r, text) =>
		r.unknown === null ? text : `unknown (${r.unknown})`;
	const s = m.slots;
	let slotsNote = "";
	if (s.sessionFloorLifted)
		slotsNote = `, raised to ${s.memorySlots} by the session floor of ${s.sessionFloor} working sessions (workflow-core#2501)`;
	else if (s.memorySlots !== s.byMemory)
		slotsNote = `, raised to ${s.memorySlots} as no session is running`;
	if (s.overloaded) slotsNote += ", held to 0 on CPU load (workflow-core#830)";
	else if (s.slots !== s.memorySlots)
		slotsNote += `, capped to ${s.slots} by the cpu slots below`;
	const slotLine =
		s.unknown === null
			? `${s.availableMb} free − ${s.poolReserveMb} pool${s.landerMb ? ` − ${s.landerMb} lander` : ""} − ${s.floorMb} floor − ${s.marginMb} margin + ${s.reclaimMb} reclaim = ${s.budgetMb} MB; the live sessions' draw needs ${s.drawNeedMb} MB of it, and with ${/** @type {number} */ (s.byMemory) + 1} more${pairsClause(/** @type {number} */ (s.byMemory) + 1, s.launchMb ?? 0)} ${s.nextNeedMb} MB, so ${s.byMemory} slot(s)${
					/** @type {number} */ (s.poolReserveMb) >
					/** @type {number} */ (s.availableMb)
						? ", the pool reserve exceeding free memory so the rest counting from 0"
						: ""
				}${slotsNote}`
			: `unknown (${s.unknown})`;
	const f = m.finished;
	return [
		`memory             of ${m.totalMb === null ? "unknown" : `${m.totalMb} MB`} total — ${m.rounding}`,
		`  free             ${orUnknown(m.free, `${m.free.mb} MB`)}`,
		`  working          ${orUnknown(m.working, `${m.working.count} session(s)${m.working.noProcess ? ` (${m.working.noProcess} with no process)` : ""}, ${m.working.mb} MB PSS`)}`,
		`  finished         ${orUnknown(f, `${f.count} session(s) still resident, ${f.mb} MB PSS, ${f.reapable === null ? `unknown (${f.reapableUnknown})` : f.reapable} taken by the next reap`)}`,
		`  daemon + spares  ${orUnknown(m.pool, `${m.pool.mb} MB PSS`)}`,
		`  everything else  ${orUnknown(
			m.other,
			`${m.other.mb} MB${m.other.overlapMb ? ` (the rows above overlap by ${m.other.overlapMb} MB of page cache)` : ""}${
				m.other.largest.length > 0
					? ` — largest by RSS: ${m.other.largest.map((p) => `${p.command} (pid ${p.pid}, ${p.rssMb} MB)`).join("; ")}`
					: ""
			}`,
		)}`,
		`  slot arithmetic  ${slotLine}`,
		`  cpu slots        ${cpuSlotsRow(m.cpu)}`,
	];
}

/*
 * The three argv[0] shapes, and why `comm` alone matches nothing, are in
 * `lib/claude-argv0.js`. This counter tests `comm` AS WELL AS argv[0] — it is
 * display only, so an over-count costs a printed figure and nothing else.
 */

/**
 * Every Claude process, whatever its role. DISPLAY ONLY: nothing is admitted or
 * held on it.
 * @returns {{ ok: true, count: number } | { ok: false, error: string }}
 */
function claudeProcessCount() {
	try {
		const out = execFileSync(PS_BIN(), ["-eo", "comm=,args="], {
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		});
		return {
			ok: true,
			count: out
				.split("\n")
				.filter((l) => l.trim())
				.map((line) => {
					const [comm, ...argv] = line.trim().split(/\s+/);
					return { comm, argv0: argv[0] || "" };
				})
				.filter((p) => isClaudeArgv0(p.comm) || isClaudeArgv0(p.argv0)).length,
		};
	} catch (e) {
		return { ok: false, error: parseErrLine(e) };
	}
}

/**
 * How many sessions are running ALONGSIDE this one, from `claude agents --json`
 * via the shared reader.
 *
 * SELF IS SUBTRACTED, identified by `CLAUDE_CODE_SESSION_ID`. Without that var
 * neither this nor the reader's own self-test can pick this run out of the
 * list, so the count becomes an upper bound — except at exactly one listed
 * session, taken to be this one.
 *
 * DEGRADES TO UNKNOWN, NEVER TO A NUMBER, on any answer the reader will not
 * vouch for — and the ps scan is NOT a fallback: it counts every Claude
 * process whatever its role, so it is display only (docs/environment.md).
 *
 * The oracle DOES list a session driven interactively in a terminal
 * (mantahostels#594); the one shape it does not list is a claude spawned with
 * another session's CLAUDE* env inherited, which a fresh terminal launch does
 * not do.
 *
 * `working` counts the others the oracle reads `state: working`: idle,
 * waiting, blocked, ended and stateless records are live but not working,
 * and only working ones count toward the session floor (workflow-core#2505).
 * @param {{ why: string } | { ids: Set<string>, states?: Map<string, string>, unvouched?: boolean }} listed
 * @returns {LiveSessionsResult}
 */
function liveSessions(listed) {
	const scan = claudeProcessCount();
	const processes = scan.ok ? scan.count : null;
	const processesError = scan.ok ? null : scan.error;
	if ("why" in listed)
		return {
			ok: false,
			error: listed.why,
			processes,
			processesError,
		};
	const ids = listed.ids;
	const me = selfId(ids);
	const selfListed = me !== undefined && ids.has(me);
	const working = [...ids].filter(
		(id) => id !== me && listed.states?.get(id) === "working",
	).length;
	return {
		ok: true,
		sessions: ids.size - (selfListed ? 1 : 0),
		working,
		self: selfListed,
		unvouched: listed.unvouched === true,
		processes,
		processesError,
	};
}

/**
 * `admissionFrom`'s arithmetic: the pool reserve, the reclaim credit, the
 * budget the draw is held against and the slots it leaves, `null` where memory
 * is unread.
 * @param {{ mem: MbResult, overhead: MbResult, reclaimable: MbResult, live: LiveDraw, host: SessionDraw, landerMb: number, launchMb: number }} input
 */
function lenientFigures({
	mem,
	overhead,
	reclaimable,
	live,
	host,
	landerMb,
	launchMb,
}) {
	if (!mem.ok)
		return { reserved: 0, credited: 0, budgetMb: null, freeSlots: null };
	const reserved = overhead.ok ? overhead.mb : 0;
	const credited = reclaimable.ok ? reclaimable.mb : 0;
	const budgetMb = sessionBudgetMb(mem.mb - reserved, landerMb, credited);
	return {
		reserved,
		credited,
		budgetMb,
		freeSlots: drawSlots(budgetMb, live, host, launchMb),
	};
}

/**
 * `admissionFrom`'s reserve and credit clauses.
 * @param {number} reserved
 * @param {number} credited
 * @param {number} landerMb
 */
function lenientNotes(reserved, credited, landerMb) {
	/* Silent where nothing was reserved/credited, so a caller that hasn't wired
	 * either read (the default) gets the exact wording it always has. */
	const reservedNote = reserved
		? ` after reserving ${reserved} MB for the spare pool`
		: "";
	const creditedNote = `${
		credited
			? `${reserved ? " and" : " after"} crediting ${credited} MB about to be reclaimed`
			: ""
	}${buildLanderNote(landerMb)}${HELD_NOTE}`;
	return { reservedNote, creditedNote };
}

/**
 * pick-next's own verdict — lenient; see the header. `overhead` reserves the
 * spare pool's margin off the top before dividing into slots (see
 * `poolReserve`); `reclaimable` credits back what a session start is
 * about to reap (see `reclaimableMb`); both default to no adjustment for a
 * caller that hasn't read them.
 * @param {MbResult} mem
 * @param {LenientProcs} procs
 * @param {{ overhead?: MbResult, reclaimable?: MbResult, live?: LiveDraw, host?: SessionDraw, load?: LoadReading, cpu?: CpuSlots, landerMb?: number, sessionFloor?: number, swapHold?: SwapHold, launchMb?: number }} [opts]
 *   `launchMb` is charged for each slot past the first, as in
 *   `strictAdmission` (workflow-core#2568); `live` is the live sessions' draw, from `liveDraw`, and `host` this
 *   host's session draw, from `readSessionDraw` (workflow-core#2221); `landerMb`, from
 *   `landerHeldMb`, is held back for the lander's suite; `sessionFloor`, from
 *   `readDeclaredSessionFloor`, lifts the free slots to `sessionFloorSlotsOf`'s
 *   as `strictAdmission` does (workflow-core#2507), and none while `swapHold` binds (workflow-core#2690); `load` comes from
 *   `overloadReading`, and an overload holds every slot, the always-admit-one
 *   guarantee included; `cpu`, from `cpuSlots`, caps them, that guarantee
 *   included (workflow-core#2141)
 */
function admissionFrom(
	mem,
	procs,
	{
		overhead = { ok: true, mb: 0 },
		reclaimable = { ok: true, mb: 0 },
		live = NO_LIVE_DRAW,
		host = UNDECLARED_DRAW,
		load = LOAD_UNREAD,
		cpu = CPU_UNREAD,
		landerMb = 0,
		sessionFloor = 0,
		swapHold = NO_SWAP_HOLD,
		launchMb = 0,
	} = {},
) {
	const figures = lenientFigures({
		mem,
		overhead,
		reclaimable,
		live,
		host,
		landerMb,
		launchMb,
	});
	const { reserved, credited, budgetMb } = figures;
	const floor = lenientFloor(mem, procs, {
		sessionFloor,
		swapHold,
		reserved,
		host,
		pricedSlots: figures.freeSlots,
	});
	const memorySlots =
		figures.freeSlots === null
			? null
			: Math.max(figures.freeSlots, floor.sessionFloorSlots);
	const freeSlots = memorySlots === null ? null : cpuCapped(memorySlots, cpu);
	const { reservedNote, creditedNote } = lenientNotes(
		reserved,
		credited,
		landerMb,
	);
	/*
	 * The guaranteed slot keys off the SESSION count with this run's own session
	 * subtracted, never off whether any claude process is alive: the host process
	 * and the daemon are always there, so testing for those would make the
	 * guarantee unreachable in every real run (the always-admit-one rule,
	 * docs/environment.md).
	 */
	/* `null` where memory is unread, exactly as `strictAdmission` reports it —
	 * so a machine reader of pick-next's own --json can reconstruct `freeSlots`
	 * the same way a human reads the reservedNote in `reason` (mantahostels#1295). */
	const reservedMb = mem.ok ? reserved : null;
	const reservedError = overhead.ok ? null : overhead.error;
	const drawNeedMb = mem.ok ? drawNeedFor(live, host, 0) : null;
	const shared = {
		reservedMb,
		reservedError,
		budgetMb,
		drawNeedMb,
		...floor,
		load,
		cpu,
	};
	if (load.overloaded)
		return {
			freeSlots: freeSlots === null ? null : 0,
			...shared,
			admit: false,
			reason: buildOverloadText(load),
		};
	if (cpu.full)
		return {
			freeSlots,
			...shared,
			admit: false,
			reason: buildSessionCeilingText(cpu),
		};
	if (procs.ok && procs.sessions === 0)
		return {
			freeSlots,
			...shared,
			admit: true,
			reason: `no session is running, so one is admitted whatever the headroom${reservedNote}${creditedNote}`,
		};
	if (!mem.ok)
		return {
			freeSlots,
			...shared,
			admit: true,
			reason: "headroom unmeasured — check `free -h` before starting a second",
		};
	// mem.ok is true from here on, so lenientFigures computed a non-null
	// freeSlots.
	const knownFreeSlots = /** @type {number} */ (freeSlots);
	if (knownFreeSlots < 1)
		return {
			freeSlots,
			...shared,
			admit: false,
			reason: `${budgetMb} MB available${reservedNote}${creditedNote}${shortOfOneMore(drawNeedFor(live, host, 1))}`,
		};
	return {
		freeSlots,
		...shared,
		admit: true,
		reason: `${slotsClause(knownFreeSlots, floor, launchMb)}${reservedNote}${creditedNote}${
			freeSlots === memorySlots
				? ""
				: `; capped by the CPU: ${buildSessionCeilingText(cpu)}`
		}`,
	};
}

/**
 * `admissionFrom`'s admitting clause: the free slots and what priced them.
 * @param {number} freeSlots
 * @param {SessionFloorFigures} floor
 * @param {number} launchMb
 */
function slotsClause(freeSlots, floor, launchMb) {
	const head = `${freeSlots} free slot${freeSlots === 1 ? "" : "s"}`;
	const pairs = buildPairsText(freeSlots, launchMb);
	return floor.sessionFloorLifted
		? `${head}, ${floorClause(floor)}`
		: `${head} on the live sessions' draw at p95${pairs ? ` and ${pairs}` : ""}`;
}

/**
 * `admissionFrom`'s session floor: no floor where memory or the session count
 * is unread.
 * @param {MbResult} mem
 * @param {LenientProcs} procs
 * @param {{ sessionFloor: number, swapHold: SwapHold, reserved: number, host: SessionDraw, pricedSlots: number | null }} figures
 * @returns {SessionFloorFigures}
 */
function lenientFloor(
	mem,
	procs,
	{ sessionFloor, swapHold, reserved, host, pricedSlots },
) {
	if (!mem.ok || !procs.ok || pricedSlots === null)
		return {
			sessionFloor,
			sessionFloorWorking: 0,
			sessionFloorSlots: 0,
			sessionFloorLifted: false,
			swapHold,
		};
	return sessionFloorFigures({
		sessionFloor,
		procs,
		effectiveMb: Math.max(0, mem.mb - reserved),
		host,
		priced: isGuaranteed(procs, pricedSlots) ? 1 : pricedSlots,
		swapHold,
	});
}

/**
 * How many test suites this much available memory admits, 0 for none.
 *
 * THE RECLAIM CREDIT LIFTS 0 TO 1 AND NOTHING ELSE (mantahostels#1930). `npm run test`
 * reaps finished sessions on its own path before vitest starts, as an npm
 * `pretest` script (`pretest-reap.js`, mantahostels#1840), so below the one-suite rung the pool that reap
 * returns is memory the run really will get. Two limits keep it honest:
 * admission cannot know how many suites a launched session will find
 * running, so it credits only the one-suite rung, although the reap judges
 * against the rung for the suite being started (workflow-core#631); and the reap never
 * refuses, printing and continuing where the pool stays short, so the credit
 * answers "may this run at all" and never "may a second suite join it".
 *
 * `rawMb` IS THE QUANTITY THE REAP ITSELF GATES ON — `readAvailableMb()`, before
 * the daemon-and-spare reservation `mb` has already lost. Comparing the rung
 * against `mb` would credit a reap that never fires for a first suite whenever the
 * reservation alone straddles the rung.
 * @param {number} mb available MB, less any reservation
 * @param {number} [reclaimedMb] MB the pretest reap would return, 0 for none
 * @param {number} [rawMb] unreserved available MB, which is what the reap reads
 */
function suiteCapacity(mb, reclaimedMb = 0, rawMb = mb) {
	if (mb >= SUITE_GATE_MB) return SUITE_MAX;
	for (const n of /** @type {const} */ ([3, 2, 1]))
		if (mb >= SUITE_RESTING_MB[n]) return n;
	if (rawMb >= SUITE_RESTING_MB[1]) return 0;
	return mb + reclaimedMb >= SUITE_RESTING_MB[1] ? 1 : 0;
}

/**
 * `strictAdmission`'s memory clause, before any load hold is prefixed.
 * @param {{ guaranteed: boolean, memorySlots: number, budgetMb: number, reservedMb: number, creditedNote: string, needAtMb: number, nextNeedMb: number, launchMb: number }} figures
 *   `needAtMb` is what the live draw and `memorySlots` more need, `nextNeedMb`
 *   what one past them would, each with `launchMb` a slot past the first
 * @returns {string}
 */
function buildStrictMemoryReason({
	guaranteed,
	memorySlots,
	budgetMb,
	reservedMb,
	creditedNote,
	needAtMb,
	nextNeedMb,
	launchMb,
}) {
	const head = `${budgetMb} MB available after reserving ${reservedMb} MB for the spare pool${creditedNote}`;
	if (guaranteed)
		return `${head}, under the ${nextNeedMb} MB one session's draw needs at p95, but no session is running, so one is admitted`;
	if (memorySlots > 0)
		return `${head}; the live sessions' draw and ${memorySlots} more${pairsClause(memorySlots, launchMb)} need ${needAtMb} MB at p95`;
	return `${head}${shortOfOneMore(nextNeedMb)}`;
}

/**
 * `strictAdmission`'s reason: the load hold, else the CPU cap where it binds.
 * @param {LoadReading} load
 * @param {CpuSlots} cpu
 * @param {number} memorySlots
 * @param {string} memoryReason
 */
function buildStrictReason(load, cpu, memorySlots, memoryReason) {
	if (load.overloaded)
		return `${buildOverloadText(load)}; were it not for the load, ${memoryReason}`;
	if (cpu.slots !== null && cpu.slots < memorySlots)
		return `${buildSessionCeilingText(cpu)}; were it not for the CPU, ${memoryReason}`;
	return memoryReason;
}

/**
 * The dispatch-time verdict.
 *
 * `slots` is what may START, so the guaranteed always-admit-one raises a zero
 * to one only when nothing of ours is running. `overhead` — the spare pool's
 * reservation from `poolReserve` — FAILS OPEN to no reservation
 * where it cannot be read: it refines the memory/session gate, which
 * already fails closed, so an unreadable overhead should not itself block a
 * launch. `reclaimable` — from `reclaimableMb` — FAILS CLOSED to no credit
 * where it cannot be read, the opposite direction: crediting memory that
 * never materialises is the over-admission this gate exists to prevent.
 *
 * `slots` takes the credit in full, from `creditedMb`; `suites` takes it only to
 * lift 0 to 1, for the reasons on `suiteCapacity` (mantahostels#1930).
 * @param {MbResult} mem
 * @param {LiveSessionsResult} procs
 * @param {{ overhead?: MbResult, reclaimable?: MbResult, live?: LiveDraw, host?: SessionDraw, load?: LoadReading, cpu?: CpuSlots, landerMb?: number, sessionFloor?: number, swapHold?: SwapHold, launchMb?: number }} [opts]
 *   `launchMb`, the pending pairs `overhead` reserves for one launch, is
 *   charged again for each slot past the first (workflow-core#2511); `live` is the live
 *   sessions' draw, from `liveDraw`, and `host` this host's session draw,
 *   from `readSessionDraw` (workflow-core#2221); `landerMb`, from
 *   `landerHeldMb`, is held back for the lander's suite; `sessionFloor`, from
 *   `readDeclaredSessionFloor`, lifts the memory slots to
 *   `sessionFloorSlotsOf`'s, none while `swapHold`, from `swapHoldOf`,
 *   binds; `load` comes from
 *   `overloadReading`, `cpu` from `cpuSlots` (workflow-core#2141). An overload holds
 *   `slots` at 0 and `cpu` caps it, the guarantee included in both;
 *   `byMemory` and `memorySlots` keep the memory figures, and `cpuIsSoleHold`
 *   says memory would admit and only the CPU limb holds.
 * @returns {{ ok: false, error: string } | {
 *   ok: true,
 *   availableMb: number,
 *   reservedMb: number,
 *   landerMb: number,
 *   floorMb: number,
 *   marginMb: number,
 *   reclaimedMb: number,
 *   budgetMb: number,
 *   drawNeedMb: number,
 *   nextNeedMb: number,
 *   launchMb: number,
 *   byMemory: number,
 *   memorySlots: number,
 *   sessionFloor: number,
 *   sessionFloorWorking: number,
 *   sessionFloorSlots: number,
 *   sessionFloorLifted: boolean,
 *   swapHold: SwapHold,
 *   reclaimableError: string | null,
 *   sessions: number,
 *   processes: number | null,
 *   processesError: string | null,
 *   slots: number,
 *   load: LoadReading,
 *   cpu: CpuSlots,
 *   cpuIsSoleHold: boolean,
 *   admit: boolean,
 *   reason: string,
 *   suites: number,
 * }}
 */
function strictAdmission(
	mem,
	procs,
	{
		overhead = { ok: true, mb: 0 },
		reclaimable = { ok: true, mb: 0 },
		live = NO_LIVE_DRAW,
		host = UNDECLARED_DRAW,
		load = LOAD_UNREAD,
		cpu = CPU_UNREAD,
		landerMb = 0,
		sessionFloor = 0,
		swapHold = NO_SWAP_HOLD,
		launchMb = 0,
	} = {},
) {
	if (!mem.ok) return { ok: false, error: `memory unreadable: ${mem.error}` };
	if (!procs.ok)
		return { ok: false, error: `session count unreadable: ${procs.error}` };
	const reservedMb = overhead.ok ? overhead.mb : 0;
	const effectiveMb = Math.max(0, mem.mb - reservedMb);
	const reclaimedMb = reclaimable.ok ? reclaimable.mb : 0;
	/* The floor and margin come off what admits sessions and nothing else:
	 * the suite ladder below carries earlyoom's line in its own rungs. */
	const budgetMb = sessionBudgetMb(effectiveMb, landerMb, reclaimedMb);
	const byMemory = drawSlots(budgetMb, live, host, launchMb);
	const guaranteed = isGuaranteed(procs, byMemory);
	const priced = guaranteed ? 1 : byMemory;
	const floor = sessionFloorFigures({
		sessionFloor,
		procs,
		effectiveMb,
		host,
		priced,
		swapHold,
	});
	const { sessionFloorSlots, sessionFloorLifted } = floor;
	const memorySlots = Math.max(priced, sessionFloorSlots);
	const slots = load.overloaded ? 0 : cpuCapped(memorySlots, cpu);
	const nextNeedMb = launchNeedFor(live, host, byMemory + 1, launchMb);
	const creditedNote = `${
		reclaimedMb ? `, credited ${reclaimedMb} MB about to be reclaimed` : ""
	}${buildLanderNote(landerMb)}${HELD_NOTE}`;
	/* The guarantee's "so one is admitted" would contradict a floor lift past it. */
	const pricedReason = buildStrictMemoryReason({
		guaranteed: guaranteed && !sessionFloorLifted,
		memorySlots: byMemory,
		budgetMb,
		reservedMb,
		creditedNote,
		needAtMb: launchNeedFor(live, host, byMemory, launchMb),
		nextNeedMb,
		launchMb,
	});
	const memoryReason = sessionFloorLifted
		? `${floorClause(floor)}, where ${pricedReason}`
		: pricedReason;
	return {
		ok: true,
		availableMb: mem.mb,
		reservedMb,
		landerMb,
		floorMb: EARLYOOM_FLOOR_MB,
		marginMb: DRAW_MARGIN_MB,
		reclaimedMb,
		/* The slot arithmetic's own figures, so the memory breakdown prints
		 * these rather than re-deriving them (workflow-core#589). */
		budgetMb,
		drawNeedMb: drawNeedFor(live, host, 0),
		nextNeedMb,
		launchMb,
		byMemory,
		memorySlots,
		...floor,
		/* Each error field keeps a failed read visible: a broken reap plan is
		 * not nothing-to-reclaim, and a failed ps scan is not zero claude processes. */
		reclaimableError: reclaimable.ok ? null : reclaimable.error,
		sessions: procs.sessions,
		processes: procs.processes,
		processesError: procs.processesError,
		slots,
		load,
		cpu,
		cpuIsSoleHold: slots === 0 && memorySlots > 0,
		admit: slots > 0,
		reason: buildStrictReason(load, cpu, memorySlots, memoryReason),
		suites: suiteCapacity(effectiveMb, reclaimedMb, mem.mb),
	};
}

/**
 * The machine reads both `admission.js` and `pick-next.js` make, the strict
 * verdict over them and the memory breakdown (workflow-core#614). It reads memory, `ps`,
 * PSS and the load itself; the session listing and the reclaim reading come in, each
 * caller already making them for other uses, and so does `livePids`, the
 * listed pids the pool scan leaves out: `admission.js` takes them off the
 * strict listing, reading the oracle again, self-optional, only where that
 * listing refuses (workflow-core#2876). An empty set prices every pair as idle, erring safe.
 *
 * `pool` is the spare pool as resident, which the breakdown's pool row shows;
 * `overhead` is what the verdict reserves for it, from `poolReserve`.
 * @param {{
 *   listed: Parameters<typeof memoryBreakdown>[0]["listed"] & Parameters<typeof liveDraw>[0] & Parameters<typeof liveSessions>[0],
 *   livePids: Set<string>,
 *   reclaimable: Parameters<typeof memoryBreakdown>[0]["reclaimable"],
 *   pendingSpares?: number,
 *   landers: Landers,
 * }} inputs `landers` are the live landers, from `readLiveLanders`
 */
function machineAdmission({
	listed,
	livePids,
	reclaimable,
	pendingSpares = 0,
	landers,
}) {
	const ps = readPsRows();
	const children = readProcessChildren();
	const pool = daemonSpareOverheadMb(livePids, ps);
	const overhead = poolReserve(pool, pendingSpares);
	const launchMb = overhead.ok ? overhead.pendingMb : 0;
	const meminfo = readMeminfoKb();
	const mem = availableFrom(meminfo);
	const procs = liveSessions(listed);
	const host = readSessionDraw();
	const live = liveDraw(listed, { ps, pssKbOf: readPssKb, children });
	const load = overloadReading();
	const cpu = cpuSlots(ps, children);
	const floorRead = readDeclaredSessionFloor();
	const swapHold = swapHoldOf(meminfo);
	const landerMb = landerHeldMb(landers, {
		pssKbOf: readPssKb,
		children,
		sessionPids: new Set([...(listed.pids?.values() ?? [])].map(String)),
	});
	const verdict = strictAdmission(mem, procs, {
		overhead,
		reclaimable,
		live,
		host,
		load,
		cpu,
		landerMb,
		sessionFloor: floorRead.sessions,
		swapHold,
		launchMb,
	});
	const memory = memoryBreakdown({
		meminfo,
		ps,
		listed,
		pssKbOf: readPssKb,
		pool,
		reclaimable,
		verdict,
		children,
		cpu,
	});
	return {
		mem,
		procs,
		overhead,
		host,
		live,
		load,
		cpu,
		landerMb,
		floorRead,
		swapHold,
		launchMb,
		verdict,
		memory,
	};
}

module.exports = {
	machineAdmission,
	LAUNCH_SPARES,
	buildSessionDrawLine,
	buildSessionFloorLine,
	SWAP_HOLD_AVAILABLE_MB,
	readSwapHold,
	swapHoldText,
	buildLiveDrawLine,
	SUITE_GATE_MB,
	EARLYOOM_FLOOR_MB,
	DRAW_MARGIN_MB,
	SUITE_MAX,
	WHOLE_SUITE_MAX,
	LADDER_SUITE_WORKERS,
	WHOLE_SUITE_WORKERS,
	SUITE_RESTING_MB,
	SUITE_LADDER_MEASURED_AT,
	suiteRungMb,
	readAvailableMb,
	buildMemoryBreakdownLines,
	reclaimableMb,
	readRunningVitestSuites,
	admissionFrom,
	readCpuSlots,
	buildSessionCeilingText,
};
