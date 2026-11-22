const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const nodePath = require("node:path");
const os = require("node:os");
const { parseErrLine } = require("./gh");
const { readEnvironVar } = require("./proc-environ.js");
const { procRoot } = require("./proc-root.js");
const { availableFrom, readMeminfoKb } = require("./meminfo.js");
const {
	WINDOWS_FLOOR_MB,
	buildWindowsUnreadNote,
	readWindowsMemory,
} = require("./windows-memory.js");
const { checkoutPeakMb } = require("./tsc-slot.js");
const { hostRoot } = require("./host-root.js");
const { configDirFrom } = require("./config-dir.js");
const { readParentOf } = require("./proc-stat.js");
const { isClaudeArgv0 } = require("./claude-argv0.js");
const { sparePairs, isDaemon, readProcCwd } = require("./claude-sessions.js");
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
const { isUnder } = require("./is-under.js");
const {
	DEFAULT_SESSION_DRAW,
	DRAW_Z,
	NO_LIVE_DRAW,
	UNDECLARED_DRAW,
	admissionFigures,
	heldFields,
} = require("./admission-figures.js");

/**
 * @typedef {import("./cpu-sample.js").LoadReading} LoadReading
 */

/**
 * @typedef {{ ceiling: number | null, sessions: number | null, idleSpares: number | null, slots: number | null, full: boolean, unknown: string | null }} CpuSlots
 */

/**
 * @param {PsRead} ps
 * @param {Map<string, string[]>} children
 * @param {SparePair[]} pairs
 * @returns {CpuSlots}
 */
function cpuSlots(ps, children, pairs) {
	const ceiling = sessionCeiling();
	if (!ps.ok)
		return {
			ceiling,
			sessions: null,
			idleSpares: null,
			slots: null,
			full: false,
			unknown: `ps unreadable: ${ps.error}`,
		};
	const orphans = new Set(children.get("1") ?? []);
	const hosts = ps.rows
		.filter((r) => {
			const [argv0, role] = r.args.split(/\s+/);
			return (
				isClaudeArgv0(argv0) && role === "bg-pty-host" && !orphans.has(r.pid)
			);
		})
		.map((r) => r.pid);
	const idleHosts = new Set(pairs.filter((p) => p.idle).map((p) => p.host));
	const sessions = hosts.length;
	const idleSpares = hosts.filter((pid) => idleHosts.has(pid)).length;
	const slots = ceiling === null ? null : Math.max(0, ceiling - sessions);
	return {
		ceiling,
		sessions,
		idleSpares,
		slots,
		full: slots === 0,
		unknown: null,
	};
}

const readCpuSlots = () => {
	const ps = readPsRows();
	return cpuSlots(ps, readProcessChildren(), readSparePairs(ps));
};

/**
 * @param {CpuSlots} cpu
 */
const buildSessionCeilingText = (cpu) =>
	`${cpu.sessions} session(s) running on the machine${cpu.idleSpares ? ` (${cpu.idleSpares} of them an idle spare)` : ""} against the ${cpu.ceiling}-session CPU ceiling (#2141), so ${cpu.slots} slot(s)`;

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
 * @typedef {import("./meminfo.js").MbResult} MbResult
 * @typedef {import("./claude-sessions.js").SparePair} SparePair
 * @typedef {import("./admission-figures.js").LenientProcs} LenientProcs
 * @typedef {({ ok: true, mb: number, idlePairs: number, perPairMb: number | null, drift: string[] }) | { ok: false, error: string }} SpareOverhead
 * @typedef {({ ok: true, mb: number, perPairMb: number, pendingMb: number }) | { ok: false, error: string }} PoolReserve
 * @typedef {{ ok: true, sessions: number, unvouched: boolean, processes: number | null, processesError: string | null } | { ok: false, error: string, processes: number | null, processesError: string | null }} LiveSessionsResult
 * @typedef {{ held: false } | { held: true, swapFreeMb: number, swapTotalMb: number, availableMb: number }} SwapHold
 * @typedef {{ meanMb: number, sigmaMb: number, declared: boolean, problem?: string }} SessionDraw
 * @typedef {{ sessions: number, meanMb: number, varianceMb2: number, pssMb: number, unread: number, noProcess: number, noProcessUncharged: number, problems: string[], refused?: boolean }} LiveDraw
 * @typedef {{ why: string, chargeMb: number }} UnreadReserve
 * @typedef {{ live: { pid: number, chargeMb: number }[], unread: UnreadReserve | null }} Landers
 * @typedef {{ live: { pid: number, chargeMb: number, spawned: boolean, part: boolean }[], unread: UnreadReserve | null }} Gates
 * @typedef {{ landers: Landers, gates: Gates, heldRuns: HeldRuns, testsHeld: number }} Reserves
 * @typedef {{ pssKbOf: (pid: string) => number | null, children: Map<string, string[]>, sessionPids: Set<string> }} HeldTree
 * @typedef {{ pid: string, rssKb: number, args: string }} PsRow
 * @typedef {{ ok: true, rows: PsRow[] } | { ok: false, error: string }} PsRead
 * @typedef {import("./meminfo.js").MeminfoRead} MeminfoRead
 */

/** @typedef {{ pid: number, chargeMb: number, rungMb?: number }[]} HeldRuns */

const REAP_SCRIPT = () =>
	process.env.WFC_REAP_SCRIPT ||
	nodePath.join(__dirname, "..", "reap-finished-sessions.js");

/**
 * @param {string} [root]
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
 * @param {"sessionMeanMb" | "sessionSigmaMb"} key
 * @param {number} fallback
 * @param {string} [root]
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

/** @param {SessionDraw} draw */
function buildSessionDrawLine(draw) {
	const figures = `mean ${draw.meanMb} MB, σ ${draw.sigmaMb} MB`;
	if (draw.declared)
		return `${figures} — this repo's declared sessionMeanMb and sessionSigmaMb, its sessions' tools included`;
	const line = `${figures} — one working session's draw, its tools included (${docPath("environment.md")})`;
	return draw.problem
		? `${line}; a declared figure went unread: ${draw.problem}`
		: line;
}

/** @param {string} cwd */
function repoRootOf(cwd) {
	for (let dir = cwd; ; ) {
		if (fs.existsSync(nodePath.join(dir, ".git"))) return dir;
		const up = nodePath.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/**
 * @param {string} id
 * @param {string} cwd
 * @param {Map<string, SessionDraw>} byRoot
 * @returns {{ draw: SessionDraw, problem: string | null }}
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

/** @param {Set<string>} ids */
function selfId(ids) {
	return (
		process.env.CLAUDE_CODE_SESSION_ID ||
		(ids.size === 1 ? [...ids][0] : undefined)
	);
}

// at most 2 together 90% of the time measured, #5283
const NO_PROCESS_CHARGED = 2;

/**
 * @param {{ ids?: Set<string>, pids?: Map<string, number>, terminal?: Set<string>, cwds?: Map<string, string> }} listed
 * @param {{ pairs: SparePair[], pssKbOf: (pid: string) => number | null, children: Map<string, string[]>, gateSeatPids?: Set<string> }} readings
 * @returns {LiveDraw}
 */
function liveDraw(
	{ ids, pids, terminal, cwds },
	{ pairs, pssKbOf, children, gateSeatPids },
) {
	/** @type {LiveDraw} */
	const draw = { ...NO_LIVE_DRAW, problems: [] };
	if (!ids) return { ...draw, refused: true };
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	const ended = terminal ?? new Set();
	/** @type {Map<string, SessionDraw>} */
	const byRoot = new Map();
	let heldKb = 0;
	/** @type {SessionDraw[]} */
	const waiting = [];
	const charge = (/** @type {SessionDraw} */ d) => {
		draw.meanMb += d.meanMb;
		draw.varianceMb2 += d.sigmaMb ** 2;
	};
	for (const id of ids) {
		if (id === me || ended.has(id)) continue;
		const own = readLiveSessionDraw(id, cwds?.get(id) ?? "", byRoot);
		if (own.problem) draw.problems.push(own.problem);
		draw.sessions++;
		if (pids?.get(id) === undefined) {
			waiting.push(own.draw);
			continue;
		}
		charge(own.draw);
		const sum = sessionsPssKb([id], {
			pids,
			pairs,
			pssKbOf,
			children,
			gateSeatPids,
		});
		if (sum.kb === null) draw.unread++;
		else heldKb += sum.kb;
	}
	const p95Mb = (/** @type {SessionDraw} */ d) => d.meanMb + DRAW_Z * d.sigmaMb;
	waiting.sort((a, b) => p95Mb(b) - p95Mb(a));
	for (const d of waiting.slice(0, NO_PROCESS_CHARGED)) charge(d);
	draw.noProcess = waiting.length;
	draw.noProcessUncharged = Math.max(0, waiting.length - NO_PROCESS_CHARGED);
	draw.pssMb = Math.floor(heldKb / 1024);
	return draw;
}

/** @param {LiveDraw} live */
function buildLiveDrawLine(live) {
	if (live.refused)
		return "unknown — the session listing was refused, so no live session's draw is counted";
	const line = `${live.sessions} live session(s): mean ${live.meanMb} MB + ${DRAW_Z} × σ ${Math.round(Math.sqrt(live.varianceMb2))} MB − ${live.pssMb} MB they already hold`;
	const notes = [
		...(live.noProcess
			? [
					`${live.noProcess - live.noProcessUncharged} with no process, charged in full${live.noProcessUncharged ? `, ${live.noProcessUncharged} more charged nothing until they wake` : ""}`,
				]
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
 * @param {number} k
 * @param {number} launchMb
 */
const buildPairsText = (k, launchMb) =>
	launchMb > 0 && k > 1 ? `${k - 1} more spare pair(s) at ${launchMb} MB` : "";

/**
 * @param {number} k
 * @param {number} launchMb
 */
const pairsClause = (k, launchMb) => {
	const pairs = buildPairsText(k, launchMb);
	return pairs ? `, with ${pairs},` : "";
};

const shortOfOneMore = (/** @type {number} */ needMb) =>
	`, under the ${needMb} MB the live sessions' draw and one more need at p95`;

/**
 * @param {{ held: HeldReserve[], typecheckReserveMb?: number, windowsChargeMb?: number }} heldBack
 */
const buildHeldBackNote = ({
	held,
	typecheckReserveMb = 0,
	windowsChargeMb = 0,
}) =>
	`${held
		.filter(({ mb }) => mb)
		.map(({ mb, holding }) => `, holding ${mb} MB for ${holding}`)
		.join("")}${
		typecheckReserveMb
			? `, holding ${typecheckReserveMb} MB for a type-check`
			: ""
	}${
		windowsChargeMb
			? `, less ${windowsChargeMb} MB of guest free memory Windows cannot back`
			: ""
	}`;

/** @param {number} testsHeld */
const buildTestsHeldText = (testsHeld) =>
	`${testsHeld} queued test run(s) are held on Windows memory, so no session is added until they run (#4956)`;

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

const PS_ROW_RE = /^(\d+)\s+(\d+)\s+(?!\s)(.*)$/;

/** @returns {PsRead} */
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
 * @param {PsRead} ps
 * @returns {SparePair[]}
 */
const readSparePairs = (ps) =>
	ps.ok ? sparePairs(ps.rows, (pid) => readProcCwd(pid)) : [];

/**
 * @param {SparePair[]} pairs
 * @returns {string[]}
 */
function spareShapeDrift(pairs) {
	/** @type {string[]} */
	const drift = [];
	/** @type {Map<string, number>} */
	const idleByDaemon = new Map();
	for (const p of pairs) {
		if (p.claimSock === null || p.dir === null || !fs.existsSync(p.claimSock))
			continue;
		if (p.idle) idleByDaemon.set(p.dir, (idleByDaemon.get(p.dir) ?? 0) + 1);
		else drift.push(`pair ${p.socket} reads claimed but keeps ${p.claimSock}`);
	}
	for (const [dir, n] of idleByDaemon)
		if (n > 1)
			drift.push(`${dir} holds ${n} idle pairs, where its daemon keeps one`);
	return drift;
}

/**
 * @param {PsRead} ps
 * @param {SparePair[]} pairs
 * @returns {SpareOverhead}
 */
function daemonSpareOverheadMb(ps, pairs) {
	if (!ps.ok) return { ok: false, error: ps.error };
	const idle = pairs.filter((p) => p.idle);
	const idlePids = new Set(idle.flatMap((p) => p.pids));
	let kb = 0;
	let pairKb = 0;
	for (const r of ps.rows) {
		const inPair = idlePids.has(r.pid);
		if (!inPair && !isDaemon(r.args)) continue;
		const rowKb = readPssKb(r.pid) ?? r.rssKb;
		kb += rowKb;
		if (inPair) pairKb += rowKb;
	}
	return {
		ok: true,
		mb: Math.floor(kb / 1024),
		idlePairs: idle.length,
		perPairMb: idle.length > 0 ? Math.floor(pairKb / 1024 / idle.length) : null,
		drift: spareShapeDrift(pairs),
	};
}

/**
 * @param {SparePair[]} pairs
 * @param {string} pid
 */
function sessionPairPids(pairs, pid) {
	return pairs.find((p) => p.pids.includes(pid))?.pids ?? [pid];
}

// 101-102 MB measured, #2283
const IDLE_PAIR_MB = 106;

const LAUNCH_SPARES = 1;

/**
 * @param {SpareOverhead} pool
 * @param {number} spares
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

/** @param {string | number} pid */
function readPssKb(pid) {
	try {
		const m = fs
			.readFileSync(`${procRoot()}/${pid}/smaps_rollup`, "utf8")
			.match(/^Pss:\s+(\d+) kB$/m);
		return m ? Number(m[1]) : null;
	} catch {
		return null;
	}
}

// 70 of 88 minutes measured, #2690
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

/** @param {Extract<SwapHold, {held: true}>} hold */
const swapHoldText = (hold) =>
	`swap is ${hold.swapFreeMb} of ${hold.swapTotalMb} MB free and ${hold.availableMb} MB available`;

/** @returns {SwapHold} */
const readSwapHold = () => swapHoldOf(readMeminfoKb());

/**
 * @typedef {{ mb: number | null, unknown: string | null }} MemRow
 * @typedef {{
 *   totalMb: number | null,
 *   rounding: string,
 *   free: MemRow,
 *   live: MemRow & { count: number | null, noProcess?: number },
 *   finished: MemRow & { count: number | null, reapable: number | null, reapableUnknown: string | null },
 *   pool: MemRow & { drift: string[] },
 *   unlisted: MemRow & { count: number | null, dirs: { dir: string, count: number }[] },
 *   other: MemRow & { overlapMb: number, largest: { pid: string, rssMb: number, command: string }[] },
 *   slots: { unknown: string | null, availableMb?: number, poolReserveMb?: number, held?: HeldReserve[], typecheckReserveMb?: number, windowsChargeMb?: number, floorMb?: number, marginMb?: number, reclaimMb?: number, budgetMb?: number, drawNeedMb?: number, nextNeedMb?: number, launchMb?: number, byMemory?: number, memorySlots?: number, slots?: number, overloaded?: boolean, testsHeld?: number },
 *   cpu: CpuSlots,
 * }} MemoryBreakdown
 */

// guess, #5529
const LARGEST_SHOWN = 3;
// guess, #5529
const COMMAND_CHARS = 60;

const ROUNDING =
	"each row floored to the MB; the rows sum to MemTotal, the flooring (under 5 MB) landing in everything else, plus any overlap everything else names";

/** @param {string} reason @returns {MemRow} */
const unknownRow = (reason) => ({ mb: null, unknown: reason });

/** @returns {Map<string, string[]>} */
function readProcessChildren() {
	/** @type {Map<string, string[]>} */
	const children = new Map();
	let entries;
	try {
		entries = fs.readdirSync(procRoot());
	} catch {
		return children;
	}
	for (const pid of entries) {
		if (!/^\d+$/.test(pid)) continue;
		const ppid = String(readParentOf(pid));
		if (ppid === "0") continue;
		const list = children.get(ppid);
		if (list) list.push(pid);
		else children.set(ppid, [pid]);
	}
	return children;
}

/**
 * @param {string[]} ids
 * @param {{
 *   pids: Map<string, number> | undefined,
 *   pairs: SparePair[],
 *   pssKbOf: (pid: string) => number | null,
 *   children: Map<string, string[]>,
 *   gateSeatPids?: Set<string>,
 * }} ctx
 * @returns {({ kb: number, unknown: null } | { kb: null, unknown: string }) & { reached: string[], noProcess: number }}
 */
function sessionsPssKb(ids, { pids, pairs, pssKbOf, children, gateSeatPids }) {
	let kb = 0;
	let noProcess = 0;
	/** @type {string[]} */
	const reached = [];
	const stopPids = new Set([
		...[...(pids?.values() ?? [])].map(String),
		...(gateSeatPids ?? []),
	]);
	for (const id of ids) {
		const pid = pids?.get(id);
		if (pid === undefined) {
			noProcess++;
			continue;
		}
		for (const p of sessionPairPids(pairs, String(pid))) {
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
			{ children, stopPids, pssKbOf },
			reached,
		);
	}
	return { kb, unknown: null, reached, noProcess };
}

/**
 * @param {string} pid
 * @param {{ children: Map<string, string[]>, stopPids: Set<string>, pssKbOf: (pid: string) => number | null }} tree
 * @param {string[]} reached
 */
function descendantsPssKb(pid, { children, stopPids, pssKbOf }, reached) {
	let kb = 0;
	const queue = [...(children.get(pid) ?? [])];
	for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
		if (stopPids.has(d)) continue;
		reached.push(d);
		kb += pssKbOf(d) ?? 0;
		queue.push(...(children.get(d) ?? []));
	}
	return kb;
}

/**
 * @param {Landers} landers
 * @param {HeldTree} tree
 */
function landerHeldMb(landers, { pssKbOf, children, sessionPids }) {
	/** @type {string[]} */
	const underSessions = [];
	for (const pid of sessionPids)
		descendantsPssKb(
			pid,
			{ children, stopPids: sessionPids, pssKbOf: () => 0 },
			underSessions,
		);
	let mb = 0;
	for (const { pid: n, chargeMb } of landers.live) {
		const pid = String(n);
		const kb = underSessions.includes(pid)
			? 0
			: descendantsPssKb(pid, { children, stopPids: sessionPids, pssKbOf }, []);
		mb += Math.max(0, chargeMb - Math.floor(kb / 1024));
	}
	return mb;
}

/**
 * @param {Gates} gates
 * @param {HeldTree} tree
 */
function gateSeatHeldMb({ live }, { pssKbOf, children, sessionPids }) {
	if (live.length === 0) return 0;
	const chargeMb = Math.max(...live.map((g) => g.chargeMb));
	let drawnKb = 0;
	for (const { pid } of live.filter((g) => g.spawned))
		drawnKb += descendantsPssKb(
			String(pid),
			{ children, stopPids: sessionPids, pssKbOf },
			[],
		);
	return Math.max(0, chargeMb - Math.floor(drawnKb / 1024));
}

/**
 * #5555
 * @param {HeldRuns} heldRuns
 */
const heldRunMb = (heldRuns) =>
	Math.max(
		0,
		...heldRuns.map((r) =>
			Math.max(
				r.chargeMb,
				(r.rungMb ?? 0) - EARLYOOM_FLOOR_MB - DRAW_MARGIN_MB,
			),
		),
	);

/**
 * @param {Reserves} reserves
 * @param {HeldTree} tree
 */
const heldReserves = ({ landers, gates, heldRuns }, tree) => [
	{
		field: /** @type {const} */ ("landerMb"),
		...heldOrUnread(landers.unread, () => landerHeldMb(landers, tree), {
			holding: "the lander's suite",
		}),
		term: "lander",
	},
	{
		field: /** @type {const} */ ("gateMb"),
		...heldOrUnread(gates.unread, () => gateSeatHeldMb(gates, tree), {
			holding: "the gate seat",
		}),
		term: "gate seat",
	},
	{
		field: /** @type {const} */ ("heldRunMb"),
		mb: heldRunMb(heldRuns),
		holding: "the queued test run the memory rung holds",
		term: "held run",
	},
];

/**
 * @param {UnreadReserve | null} unread
 * @param {() => number} heldMb
 * @param {{ holding: string }} named
 */
const heldOrUnread = (unread, heldMb, { holding }) =>
	unread === null
		? { mb: heldMb(), holding }
		: { mb: unread.chargeMb, holding: `${holding}, as ${unread.why}` };

/**
 * @typedef {ReturnType<typeof heldReserves>[number]} HeldReserve
 * @typedef {HeldReserve["field"]} HeldField
 */

/**
 * @param {number} pid
 * @returns {{ kb: number, pids: number[] }}
 */
function readTreeSample(pid) {
	const root = String(pid);
	/** @type {string[]} */
	const reached = [];
	const kb =
		(readPssKb(root) ?? 0) +
		descendantsPssKb(
			root,
			{
				children: readProcessChildren(),
				stopPids: new Set(),
				pssKbOf: readPssKb,
			},
			reached,
		);
	return { kb, pids: [pid, ...reached.map(Number)] };
}

/** @param {number} pid */
const readTreePssKb = (pid) => readTreeSample(pid).kb;

// guess, #5529
const TREE_PEAK_SAMPLE_MS = 2000;

/**
 * @param {number | undefined} pid
 * @param {{ treePss?: (pid: number) => number, ms?: number }} [options]
 * @returns {{ stop: () => { peakKb: number, samples: number } }}
 */
function sampleTreePeak(
	pid,
	{ treePss = readTreePssKb, ms = TREE_PEAK_SAMPLE_MS } = {},
) {
	let peakKb = 0;
	let samples = 0;
	if (pid === undefined) return { stop: () => ({ peakKb, samples }) };
	const sample = () => {
		peakKb = Math.max(peakKb, treePss(pid));
		samples += 1;
	};
	sample();
	const sampler = setInterval(sample, ms);
	return {
		stop: () => {
			clearInterval(sampler);
			return { peakKb, samples };
		},
	};
}

/**
 * @param {{
 *   blocked: boolean,
 *   totalMb: number | null,
 *   parts: MemRow[],
 *   ps: PsRead,
 *   pairs: SparePair[],
 *   sessionPids: Set<string>,
 * }} input
 * @returns {MemoryBreakdown["other"]}
 */
function otherRow({ blocked, totalMb, parts, ps, pairs, sessionPids }) {
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
	const poolPids = new Set([
		...pairs.flatMap((p) => p.pids),
		...(ps.ok ? ps.rows.filter((r) => isDaemon(r.args)).map((r) => r.pid) : []),
	]);
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
				held: verdict.held,
				typecheckReserveMb: verdict.typecheckReserveMb,
				windowsChargeMb: verdict.windowsChargeMb,
				floorMb: verdict.floorMb,
				marginMb: verdict.marginMb,
				reclaimMb: verdict.reclaimedMb,
				budgetMb: verdict.budgetMb,
				drawNeedMb: verdict.drawNeedMb,
				nextNeedMb: verdict.nextNeedMb,
				launchMb: verdict.launchMb,
				byMemory: verdict.byMemory,
				memorySlots: verdict.memorySlots,
				slots: verdict.slots,
				overloaded: verdict.load.overloaded,
				testsHeld: verdict.testsHeld,
			}
		: { unknown: verdict.error };
}

/**
 * @param {SparePair[]} pairs
 * @param {Map<string, number>} listedPids
 */
function unlistedPairs(pairs, listedPids) {
	const listed = new Set([...listedPids.values()].map(String));
	return pairs.filter(
		(p) => !p.idle && p.spare !== null && !listed.has(p.spare),
	);
}

/**
 * @param {SparePair} pair
 * @param {ReturnType<typeof readEnvironVar>} configDir
 * @param {string} home
 */
function configDirLabel(pair, configDir, home) {
	if (!configDir.ok)
		return pair.dir === null
			? pair.socket
			: nodePath.basename(nodePath.dirname(pair.dir));
	const dir = configDirFrom(configDir.value) || ".";
	return home && isUnder(dir, [home]) ? `~${dir.slice(home.length)}` : dir;
}

/**
 * @param {SparePair[]} unlisted
 * @param {(pair: SparePair) => string} configDirOf
 */
function unlistedDirs(unlisted, configDirOf) {
	/** @type {Map<string, number>} */
	const byDir = new Map();
	for (const p of unlisted) {
		const label = configDirOf(p);
		byDir.set(label, (byDir.get(label) ?? 0) + 1);
	}
	return [...byDir].map(([dir, count]) => ({ dir, count }));
}

/**
 * @param {{
 *   meminfo: MeminfoRead,
 *   ps: PsRead,
 *   listed: { why?: string, ids?: Set<string>, pids?: Map<string, number>, finished?: Set<string>, unvouched?: boolean },
 *   pssKbOf: (pid: string) => number | null,
 *   pool: SpareOverhead,
 *   pairs: SparePair[],
 *   configDirOf: (pair: SparePair) => string,
 *   reclaimable: { ok: true, mb: number, count: number } | { ok: false, error: string },
 *   verdict: ReturnType<typeof strictAdmission>,
 *   children: Map<string, string[]>,
 *   gateSeatPids?: Set<string>,
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
	pairs,
	configDirOf,
	reclaimable,
	verdict,
	children,
	gateSeatPids,
	cpu,
}) {
	const totalMb =
		meminfo.ok && meminfo.totalKb !== null
			? Math.floor(meminfo.totalKb / 1024)
			: null;
	const free = meminfo.ok
		? { mb: Math.floor(meminfo.availableKb / 1024), unknown: null }
		: unknownRow(`memory unreadable: ${meminfo.error}`);

	/** @type {Set<string>} */
	const sessionPids = new Set();
	const { ids: listedIds, pids, finished: finishedSet } = listed;
	const refused =
		listed.why ?? (listedIds && pids && finishedSet ? null : "no ids listed");
	const unlisted =
		refused === null ? unlistedPairs(pairs, pids ?? new Map()) : [];
	const allPids = new Map(pids);
	const unlistedIds = unlisted.map((p) => {
		const id = `unlisted:${p.socket}`;
		allPids.set(id, Number(p.spare));
		return id;
	});
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
		const sum = sessionsPssKb(ids, {
			pids: allPids,
			pairs,
			pssKbOf,
			children,
			gateSeatPids,
		});
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
	const liveIds = [...(listedIds ?? [])].filter((id) => !finishedSet?.has(id));
	const live = sessionsRow(liveIds);
	const finishedRow = sessionsRow(finishedIds);
	const finished = {
		...finishedRow,
		reapable: reclaimable.ok ? reclaimable.count : null,
		reapableUnknown: reclaimable.ok ? null : `reap plan: ${reclaimable.error}`,
	};
	const poolMem = pool.ok
		? { mb: pool.mb, unknown: null, drift: pool.drift }
		: { ...unknownRow(`spare-pool scan: ${pool.error}`), drift: [] };

	const unlistedMem =
		refused === null && listed.unvouched === true && unlisted.length > 0
			? UNVOUCHED_UNLISTED
			: {
					...sessionsRow(unlistedIds),
					dirs: unlistedDirs(unlisted, configDirOf),
				};

	const parts = [free, live, finishedRow, poolMem, unlistedMem];
	const blocked = parts.find((r) => r.unknown !== null);
	const other = otherRow({
		blocked: Boolean(blocked),
		totalMb,
		parts,
		ps,
		pairs,
		sessionPids,
	});
	const slots = slotsRow(verdict);

	return {
		totalMb,
		rounding: ROUNDING,
		free,
		live,
		finished,
		pool: poolMem,
		unlisted: unlistedMem,
		other,
		slots,
		cpu,
	};
}

/** @type {MemoryBreakdown["unlisted"]} */
const UNVOUCHED_UNLISTED = {
	count: null,
	...unknownRow(
		"session listing: empty and unvouched (#2180), so no claimed pair can be told unlisted",
	),
	dirs: [],
};

/** @param {MemoryBreakdown["unlisted"]} u */
const unlistedText = (u) =>
	`${u.count} session(s), ${u.mb} MB PSS${u.dirs.length > 0 ? ` — ${u.dirs.map((d) => `${d.dir} ${d.count}`).join(", ")}` : ""}`;

/** @param {MemoryBreakdown["slots"]} s */
const heldBackTerms = (s) =>
	/** @type {[number | undefined, string][]} */ ([
		...(s.held ?? []).map(({ mb, term }) => [mb, term]),
		[s.typecheckReserveMb, "type-check"],
		[s.windowsChargeMb, "unbacked by Windows"],
	])
		.filter(([mb]) => mb)
		.map(([mb, what]) => ` − ${mb} ${what}`)
		.join("");

/** @param {MemoryBreakdown["slots"]} s */
function buildSlotLine(s) {
	let slotsNote = "";
	if (s.memorySlots !== s.byMemory)
		slotsNote = `, raised to ${s.memorySlots} as no session is running`;
	if (s.overloaded) slotsNote += ", held to 0 on CPU load (#830)";
	else if (s.testsHeld)
		slotsNote += `, held to 0 while ${s.testsHeld} queued test run(s) wait on Windows memory (#4956)`;
	else if (s.slots !== s.memorySlots)
		slotsNote += `, capped to ${s.slots} by the cpu slots below`;
	return s.unknown === null
		? `${s.availableMb} free − ${s.poolReserveMb} pool${heldBackTerms(s)} − ${s.floorMb} floor − ${s.marginMb} margin + ${s.reclaimMb} reclaim = ${s.budgetMb} MB; the live sessions' draw needs ${s.drawNeedMb} MB of it, and with ${/** @type {number} */ (s.byMemory) + 1} more${pairsClause(/** @type {number} */ (s.byMemory) + 1, s.launchMb ?? 0)} ${s.nextNeedMb} MB, so ${s.byMemory} slot(s)${
				/** @type {number} */ (s.poolReserveMb) >
				/** @type {number} */ (s.availableMb)
					? ", the pool reserve exceeding free memory so the rest counting from 0"
					: ""
			}${slotsNote}`
		: `unknown (${s.unknown})`;
}

/** @param {MemoryBreakdown} m */
function buildMemoryBreakdownLines(m) {
	/** @param {MemRow} r @param {string} text */
	const orUnknown = (r, text) =>
		r.unknown === null ? text : `unknown (${r.unknown})`;
	const slotLine = buildSlotLine(m.slots);
	const f = m.finished;
	return [
		`memory             of ${m.totalMb === null ? "unknown" : `${m.totalMb} MB`} total — ${m.rounding}`,
		`  free             ${orUnknown(m.free, `${m.free.mb} MB`)}`,
		`  live             ${orUnknown(m.live, `${m.live.count} session(s)${m.live.noProcess ? ` (${m.live.noProcess} with no process)` : ""}, ${m.live.mb} MB PSS`)}`,
		`  finished         ${orUnknown(f, `${f.count} session(s) still resident, ${f.mb} MB PSS, ${f.reapable === null ? `unknown (${f.reapableUnknown})` : f.reapable} taken by the next reap`)}`,
		`  daemon + spares  ${orUnknown(m.pool, `${m.pool.mb} MB PSS`)}`,
		...m.pool.drift.map((why) => `    spare shape drift: ${why}`),
		`  unlisted         ${orUnknown(m.unlisted, unlistedText(m.unlisted))}`,
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

/** @returns {{ ok: true, count: number } | { ok: false, error: string }} */
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
 * @param {{ why: string } | { ids: Set<string>, unvouched?: boolean }} listed
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
	return {
		ok: true,
		sessions: ids.size - (selfListed ? 1 : 0),
		unvouched: listed.unvouched === true,
		processes,
		processesError,
	};
}

/**
 * @param {number} reserved
 * @param {number} credited
 * @param {Parameters<typeof buildHeldBackNote>[0]} heldBack
 */
function lenientNotes(reserved, credited, heldBack) {
	const reservedNote = reserved
		? ` after reserving ${reserved} MB for the spare pool`
		: "";
	const creditedNote = `${
		credited
			? `${reserved ? " and" : " after"} crediting ${credited} MB about to be reclaimed`
			: ""
	}${buildHeldBackNote(heldBack)}${HELD_NOTE}`;
	return { reservedNote, creditedNote };
}

/**
 * @param {MbResult} mem
 * @param {LenientProcs} procs
 * @param {import("./admission-figures.js").AdmissionReadings} [readings]
 */
function admissionFrom(mem, procs, readings = {}) {
	const f = admissionFigures(mem, procs, readings);
	const { load, cpu, held } = f;
	const { reservedNote, creditedNote } = lenientNotes(
		f.memRead ? f.reservedMb : 0,
		f.memRead ? f.reclaimedMb : 0,
		f.memRead ? f : { held },
	);
	const freeSlots = f.memRead ? f.freeSlots : null;
	const shared = {
		reservedMb: f.memRead ? f.reservedMb : null,
		reservedError: f.reservedError,
		budgetMb: f.memRead ? f.budgetMb : null,
		drawNeedMb: f.memRead ? f.drawNeedMb : null,
		load,
		cpu,
	};
	if (load.overloaded)
		return {
			freeSlots,
			...shared,
			admit: false,
			reason: buildOverloadText(load),
		};
	if (f.testsHeld > 0)
		return {
			freeSlots,
			...shared,
			admit: false,
			reason: buildTestsHeldText(f.testsHeld),
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
	if (!f.memRead)
		return {
			freeSlots,
			...shared,
			admit: true,
			reason: "headroom unmeasured — check `free -h` before starting a second",
		};
	if (f.freeSlots < 1)
		return {
			freeSlots,
			...shared,
			admit: false,
			reason: `${f.budgetMb} MB available${reservedNote}${creditedNote}${shortOfOneMore(f.nextNeedMb)}`,
		};
	return {
		freeSlots,
		...shared,
		admit: true,
		reason: `${slotsClause(f.freeSlots, f.launchMb)}${reservedNote}${creditedNote}${buildCapNote(f, cpu)}`,
	};
}

/**
 * @param {AdmissionFigures} f
 * @param {CpuSlots} cpu
 */
function buildCapNote(f, cpu) {
	if (f.freeSlots === f.byMemory) return "";
	return `; capped by the CPU: ${buildSessionCeilingText(cpu)}`;
}

/**
 * @param {number} freeSlots
 * @param {number} launchMb
 */
function slotsClause(freeSlots, launchMb) {
	const pairs = buildPairsText(freeSlots, launchMb);
	return `${freeSlots} free slot${freeSlots === 1 ? "" : "s"} on the live sessions' draw at p95${pairs ? ` and ${pairs}` : ""}`;
}

/**
 * @param {number} mb
 * @param {number} [reclaimedMb]
 * @param {number} [rawMb]
 */
function suiteCapacity(mb, reclaimedMb = 0, rawMb = mb) {
	if (mb >= SUITE_GATE_MB) return SUITE_MAX;
	for (const n of /** @type {const} */ ([3, 2, 1]))
		if (mb >= SUITE_RESTING_MB[n]) return n;
	if (rawMb >= SUITE_RESTING_MB[1]) return 0;
	return mb + reclaimedMb >= SUITE_RESTING_MB[1] ? 1 : 0;
}

/**
 * @param {{ guaranteed: boolean, memorySlots: number, budgetMb: number, reservedMb: number, creditedNote: string, needAtMb: number, nextNeedMb: number, launchMb: number }} figures
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
 * @typedef {Extract<ReturnType<typeof admissionFigures>, { memRead: true }>} AdmissionFigures
 */

/**
 * @param {Pick<AdmissionFigures, "load" | "cpu" | "memorySlots" | "testsHeld">} f
 * @param {string} memoryReason
 */
function buildStrictReason(
	{ load, cpu, memorySlots, testsHeld },
	memoryReason,
) {
	if (load.overloaded)
		return `${buildOverloadText(load)}; were it not for the load, ${memoryReason}`;
	if (testsHeld > 0)
		return `${buildTestsHeldText(testsHeld)}; were it not for them, ${memoryReason}`;
	const cpuCap = cpu.slots ?? Number.POSITIVE_INFINITY;
	if (cpuCap < memorySlots)
		return `${buildSessionCeilingText(cpu)}; were it not for the CPU, ${memoryReason}`;
	return memoryReason;
}

/**
 * @param {Pick<Extract<ReturnType<typeof strictAdmission>, { ok: true }>, "windows" | "guestFreeMb" | "windowsChargeMb">} verdict
 * @returns {string | null}
 */
function buildWindowsLine({ windows, guestFreeMb, windowsChargeMb }) {
	if (windows.state !== "fresh")
		return buildWindowsUnreadNote(windows, "sessions");
	if (guestFreeMb === null)
		return `${windows.mb} MB free on Windows, the guest's free memory unread, so nothing is charged against it`;
	const overMb = windows.mb - WINDOWS_FLOOR_MB;
	const room =
		overMb < 0
			? `${-overMb} MB under its ${WINDOWS_FLOOR_MB} MB floor`
			: `${overMb} MB above its ${WINDOWS_FLOOR_MB} MB floor`;
	return `${windows.mb} MB free on Windows (memwatch, ${windows.ageS} s old), ${room}, against ${guestFreeMb} MB free in the guest that it does not yet back, so ${windowsChargeMb} MB comes off the budget (#4956)`;
}

/**
 * @param {MbResult} mem
 * @param {LiveSessionsResult} procs
 * @param {import("./admission-figures.js").AdmissionReadings} [readings]
 * @returns {{ ok: false, error: string } | ({
 *   ok: true,
 *   availableMb: number,
 *   reservedMb: number,
 *   held: HeldReserve[],
 *   typecheckReserveMb: number,
 *   windowsChargeMb: number,
 *   windowsCapped: boolean,
 *   testsHeld: number,
 *   windows: import("./windows-memory.js").WindowsRead,
 *   guestFreeMb: number | null,
 *   floorMb: number,
 *   marginMb: number,
 *   reclaimedMb: number,
 *   budgetMb: number,
 *   drawNeedMb: number,
 *   nextNeedMb: number,
 *   launchMb: number,
 *   byMemory: number,
 *   memorySlots: number,
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
 * } & Record<HeldField, number>)}
 */
function strictAdmission(mem, procs, readings = {}) {
	const f = admissionFigures(mem, procs, readings);
	if (!f.memRead) return { ok: false, error: `memory unreadable: ${f.error}` };
	if (!procs.ok)
		return { ok: false, error: `session count unreadable: ${procs.error}` };
	const { load, cpu, held, launchMb, reservedMb, reclaimedMb } = f;
	const creditedNote = `${
		reclaimedMb ? `, credited ${reclaimedMb} MB about to be reclaimed` : ""
	}${buildHeldBackNote(f)}${HELD_NOTE}`;
	const memoryReason = buildStrictMemoryReason({
		guaranteed: f.guaranteed,
		memorySlots: f.byMemory,
		budgetMb: f.budgetMb,
		reservedMb,
		creditedNote,
		needAtMb: f.needAtMb,
		nextNeedMb: f.nextNeedMb,
		launchMb,
	});
	return {
		ok: /** @type {const} */ (true),
		availableMb: f.availableMb,
		reservedMb,
		held,
		...heldFields(held),
		typecheckReserveMb: f.typecheckReserveMb,
		windowsChargeMb: f.windowsChargeMb,
		windowsCapped: f.windowsCapped,
		testsHeld: f.testsHeld,
		windows: f.windows,
		guestFreeMb: f.guestFreeMb,
		floorMb: EARLYOOM_FLOOR_MB,
		marginMb: DRAW_MARGIN_MB,
		reclaimedMb,
		budgetMb: f.budgetMb,
		drawNeedMb: f.drawNeedMb,
		nextNeedMb: f.nextNeedMb,
		launchMb,
		byMemory: f.byMemory,
		memorySlots: f.memorySlots,
		reclaimableError: f.reclaimableError,
		sessions: procs.sessions,
		processes: procs.processes,
		processesError: procs.processesError,
		slots: f.slots,
		load,
		cpu,
		cpuIsSoleHold: f.slots === 0 && f.memorySlots > 0 && f.testsHeld === 0,
		admit: f.slots > 0,
		reason: buildStrictReason(f, memoryReason),
		suites: suiteCapacity(f.effectiveMb, reclaimedMb, f.availableMb),
	};
}

/**
 * @param {{
 *   listed: Parameters<typeof memoryBreakdown>[0]["listed"] & Parameters<typeof liveDraw>[0] & Parameters<typeof liveSessions>[0],
 *   reclaimable: Parameters<typeof memoryBreakdown>[0]["reclaimable"],
 *   pendingSpares?: number,
 *   reserves: Reserves,
 * }} inputs
 */
function machineAdmission({
	listed,
	reclaimable,
	pendingSpares = 0,
	reserves,
}) {
	const ps = readPsRows();
	const children = readProcessChildren();
	const pairs = readSparePairs(ps);
	const pool = daemonSpareOverheadMb(ps, pairs);
	const overhead = poolReserve(pool, pendingSpares);
	const launchMb = overhead.ok ? overhead.pendingMb : 0;
	const meminfo = readMeminfoKb();
	const mem = availableFrom(meminfo);
	const procs = liveSessions(listed);
	const host = readSessionDraw();
	const gateSeatPids = new Set(reserves.gates.live.map((g) => String(g.pid)));
	const live = liveDraw(listed, {
		pairs,
		pssKbOf: readPssKb,
		children,
		gateSeatPids,
	});
	const load = overloadReading();
	const cpu = cpuSlots(ps, children, pairs);
	const reserveReadings = {
		windows: readWindowsMemory(),
		guestFreeMb:
			meminfo.ok && meminfo.freeKb !== null
				? Math.floor(meminfo.freeKb / 1024)
				: null,
		typecheckChargeMb: checkoutPeakMb(hostRoot()),
		testsHeld: reserves.testsHeld,
	};
	const sessionPids = new Set([...(listed.pids?.values() ?? [])].map(String));
	const held = heldReserves(reserves, {
		pssKbOf: readPssKb,
		children,
		sessionPids,
	});
	const verdict = strictAdmission(mem, procs, {
		overhead,
		reclaimable,
		live,
		host,
		load,
		cpu,
		held,
		launchMb,
		...reserveReadings,
	});
	const memory = memoryBreakdown({
		meminfo,
		ps,
		listed,
		pssKbOf: readPssKb,
		pool,
		pairs,
		configDirOf: (pair) =>
			configDirLabel(
				pair,
				readEnvironVar(/** @type {string} */ (pair.spare), "CLAUDE_CONFIG_DIR"),
				os.homedir(),
			),
		reclaimable,
		verdict,
		children,
		gateSeatPids,
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
		held,
		launchMb,
		reserveReadings,
		verdict,
		memory,
	};
}

/**
 * @param {{
 *   listed: Parameters<typeof machineAdmission>[0]["listed"],
 *   reclaimable: {ok: true, count: number} | {ok: false, error: string},
 *   reserves: Reserves,
 * }} inputs
 */
function selectionAdmission({ listed, reclaimable, reserves }) {
	const readings = machineAdmission({
		listed,
		reclaimable: reclaimable.ok
			? { ok: true, mb: 0, count: reclaimable.count }
			: reclaimable,
		pendingSpares: LAUNCH_SPARES,
		reserves,
	});
	const admission = admissionFrom(readings.mem, readings.procs, {
		overhead: readings.overhead,
		live: readings.live,
		host: readings.host,
		load: readings.load,
		cpu: readings.cpu,
		held: readings.held,
		launchMb: readings.launchMb,
		...readings.reserveReadings,
	});
	return { ...readings, admission };
}

/**
 * @typedef {Extract<ReturnType<typeof strictAdmission>, {ok: true}> & {
 *   memory: MemoryBreakdown,
 *   hungJobs: ReturnType<typeof import("./hung-jobs.js").findHungJobs>,
 *   allowanceWarning: string | null,
 * }} AdmissionJson
 */

module.exports = {
	machineAdmission,
	selectionAdmission,
	LAUNCH_SPARES,
	buildSessionDrawLine,
	buildWindowsLine,
	SWAP_HOLD_AVAILABLE_MB,
	readSessionDraw,
	readSwapHold,
	swapHoldText,
	buildLiveDrawLine,
	SUITE_GATE_MB,
	SUITE_MAX,
	WHOLE_SUITE_MAX,
	LADDER_SUITE_WORKERS,
	WHOLE_SUITE_WORKERS,
	SUITE_RESTING_MB,
	SUITE_LADDER_MEASURED_AT,
	suiteRungMb,
	readPsRows,
	readTreePssKb,
	readTreeSample,
	TREE_PEAK_SAMPLE_MS,
	sampleTreePeak,
	buildMemoryBreakdownLines,
	reclaimableMb,
	readRunningVitestSuites,
	admissionFrom,
	readCpuSlots,
	buildSessionCeilingText,
	descendantsPssKb,
};
