const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sessionDirs } = require("./arbiter-core.js");
const { realKey } = require("./deref.js");
const cache = require("./oracle-cache");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { caught } = require("./caught.js");
const { claudeBin } = require("./claude-bin.js");
const { killGroup } = require("./grouped-child.js");
const { budgetMs } = require("./hook-deadline.js");
const { capMs } = require("./cap-ms.js");
const { buildSeatEnv } = require("./seat-claude.js");
const { seatDir } = require("./config-dir.js");
const headless = require("./headless-runs.js");

/**
 * @typedef {{sessionId: string, id?: string, name?: string, pid?: number,
 *   kind?: string, state?: string, status?: string, tempo?: string,
 *   startedAt?: number, cwd?: string, seat?: string,
 *   founderReply?: true}} AgentRecord
 * @typedef {{agents: AgentRecord[], why?: undefined, readAt?: number}
 *   | {why: string, agents?: undefined, readAt?: undefined}} Listing
 * @typedef {{why: string, ids?: undefined, names?: undefined,
 *   finished?: undefined, terminal?: undefined, pids?: undefined,
 *   cwds?: undefined}} SessionsRefused
 * @typedef {{why?: undefined, ids: Set<string>, names: Map<string, string>,
 *   finished: Set<string>, terminal: Set<string>,
 *   pids: Map<string, number>, cwds: Map<string, string>,
 *   unvouched?: boolean}} SessionsListed
 * @typedef {SessionsRefused|SessionsListed} ListedSessions
 * @typedef {(bin: string, timeoutMs: number, dirs: string[]) => string[]} RunOracle
 * @typedef {{requireSelf?: unknown, allowEmpty?: boolean, shared?: boolean,
 *   shownAgeMs?: number, run?: RunOracle}} ReadOpts
 * @typedef {{read?: (o: ReadOpts) => any, run?: RunOracle,
 *   requireSelf?: unknown, allowEmpty?: boolean}} Opts
 */

// guess, #5529
const QUOTE_CHARS = 200;

const oracleCall = () => `\`${claudeBin()} agents --json\``;

// guess, lucmoseley/mantahostels#1900
const oracleTimeoutMs = () => capMs("WFC_ORACLE_TIMEOUT_MS", 10_000);
const oracleRetryTimeoutMs = () => capMs("WFC_ORACLE_RETRY_TIMEOUT_MS", 20_000);

const READ_EVERY_DIR = `
out=$1 bin=$2 blocks=$3
shift 3
case $bin in
*/*)
	[ -e "$bin" ] || { printf ENOENT >&2; exit 127; }
	[ -f "$bin" ] && [ -x "$bin" ] || { printf EACCES >&2; exit 127; } ;;
*) command -v "$bin" >/dev/null 2>&1 || { printf ENOENT >&2; exit 127; } ;;
esac
ulimit -f "$blocks"
i=0
pids=
for dir; do
	CLAUDE_CONFIG_DIR=$dir "$bin" agents --json >"$out/$i" 2>/dev/null &
	pids="$pids $!"
	i=$((i + 1))
done
first=0
for pid in $pids; do
	wait "$pid"
	status=$?
	[ "$first" -ne 0 ] || first=$status
done
exit "$first"
`;

const OVER_CAP_STATUS = 128 + os.constants.signals.SIGXFSZ;

/** @returns {string[]} */
function oracleDirs() {
	return sessionDirs().filter((d, i) => i === 0 || fs.existsSync(d));
}

/**
 * @param {string} [bin]
 * @param {string[]} [dirs]
 * @returns {string}
 */
function oracleCacheKey(bin = claudeBin(), dirs = oracleDirs()) {
	return JSON.stringify([bin, ...dirs.map(realKey).sort()]);
}

/**
 * @param {string} bin
 * @param {number} timeoutMs
 * @param {string[]} dirs
 * @returns {string[]}
 */
function runOracle(bin, timeoutMs, dirs) {
	const [seat] = dirs;
	if (seat === undefined) throw new Error("runOracle was given no config dir");
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"));
	/** @type {import("node:child_process").SpawnSyncOptionsWithStringEncoding & {detached: boolean}} */
	const opts = {
		detached: true,
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["ignore", "ignore", "pipe"],
		env: buildSeatEnv(process.env, seat),
	};
	try {
		const r = spawnSync(
			"/bin/sh",
			[
				"-c",
				READ_EVERY_DIR,
				"sh",
				outDir,
				bin,
				String(Math.floor(CHILD_MAX_BUFFER / 512) + 1),
				...dirs,
			],
			opts,
		);
		if (r.pid) killGroup(r.pid, "SIGKILL");
		if (r.error) throw r.error;
		const overCap = Object.assign(new Error("stdout over the buffer cap"), {
			code: "ENOBUFS",
		});
		if (r.status === OVER_CAP_STATUS) throw overCap;
		const spawnCode = r.stderr.trim();
		if (r.status === 127 && /^E[A-Z]+$/.test(spawnCode))
			throw Object.assign(new Error(spawnCode), { code: spawnCode });
		if (r.status !== 0)
			throw Object.assign(new Error(`${bin} agents --json failed`), {
				status: r.status,
			});
		return dirs.map((_, i) => {
			const file = path.join(outDir, String(i));
			if (fs.statSync(file).size > CHILD_MAX_BUFFER) throw overCap;
			return fs.readFileSync(file, "utf8");
		});
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
}

/**
 * @param {string} raw
 * @param {string} call
 * @returns {{agents: any[]} | {why: string}}
 */
function parseListing(raw, call) {
	let agents;
	try {
		agents = JSON.parse(raw);
	} catch {
		return { why: `${call} did not return JSON` };
	}
	if (!Array.isArray(agents))
		return { why: `${call} returned ${typeof agents}, not the expected array` };
	return { agents };
}

/**
 * @param {string} dir
 * @param {number} timeoutMs
 * @param {RunOracle} [run]
 * @returns {ReturnType<typeof parseListing>}
 */
function readSeatListing(dir, timeoutMs, run = runOracle) {
	const [raw] = run(claudeBin(), timeoutMs, [dir]);
	if (raw === undefined)
		throw new Error(`runOracle answered no stdout for its one dir, ${dir}`);
	return parseListing(raw, oracleCall());
}

/**
 * @param {string[]} stdouts
 * @param {string} call
 * @param {string[]} dirs
 * @returns {{raw: string} | {why: string}}
 */
function unionOf(stdouts, call, dirs) {
	/** @type {any[]} */
	const all = [];
	for (const [i, raw] of stdouts.entries()) {
		const parsed = parseListing(raw, call);
		if ("why" in parsed) return parsed;
		const dir = dirs[i];
		if (dir === undefined)
			throw new Error(
				`runOracle answered ${stdouts.length} stdouts for ${dirs.length} dirs`,
			);
		const seat = seatDir(dir, os.homedir());
		all.push(
			...parsed.agents.map((a) =>
				typeof a === "object" && a !== null && !a.seat ? { ...a, seat } : a,
			),
		);
	}
	return { raw: JSON.stringify(preferLiveRecords(all)) };
}

/**
 * @param {any[]} records
 * @returns {any[]}
 */
function preferLiveRecords(records) {
	/** @type {any[]} */
	const union = [];
	/** @type {Map<string, number>} */
	const at = new Map();
	for (const a of records) {
		const id = sessionIdOf(a);
		const i = id === null ? undefined : at.get(id);
		if (i === undefined) {
			if (id !== null) at.set(id, union.length);
			union.push(a);
		} else if (isTerminalAgent(union[i]) && !isTerminalAgent(a)) union[i] = a;
	}
	return union;
}

/**
 * @param {unknown} a
 * @returns {string | null}
 */
function sessionIdOf(a) {
	if (typeof a !== "object" || a === null || !("sessionId" in a)) return null;
	return typeof a.sessionId === "string" ? a.sessionId : null;
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function failure(e) {
	const { code, status } = caught(e);
	return code || `exit ${status ?? "on a signal"}`;
}

/**
 * @param {string} call
 * @param {unknown} e
 * @returns {string}
 */
const wouldNotRun = (call, e) => `${call} would not run (${failure(e)})`;

/**
 * @param {ReadOpts} [opts]
 * @returns {Listing}
 */
function readListing(opts) {
	const bin = claudeBin();
	const call = oracleCall();
	const runs = readHeadlessRuns();
	if ("why" in runs) return runs;
	const dirs = oracleDirs();
	const key = oracleCacheKey(bin, dirs);

	/** @param {Listing} answer @param {number} at */
	const dated = (answer, at) =>
		answer.agents ? { agents: answer.agents, readAt: at } : answer;
	/** @param {import("./oracle-cache.js").Hit|null} cached */
	const served = (cached) => {
		if (cached === null) return null;
		const answer = classifyRaw(cached.raw, call, opts, runs.agents);
		return answer.why ? null : dated(answer, cached.at);
	};
	if (opts?.shared || opts?.shownAgeMs !== undefined) {
		const hit = served(cache.readFresh(key, undefined, opts.shownAgeMs));
		if (hit) return hit;
		const refused = cache.readRefusal(key);
		if (refused !== null) return { why: `${refused} (a shared reading)` };
	}

	const leading = cache.acquire(key);
	if (!leading) {
		const followed = served(cache.waitForLeader(key));
		if (followed) return followed;
		if (opts?.shared)
			return {
				why: `another reader is refreshing ${call} and has not answered yet`,
			};
	}

	let raw;
	try {
		const union = spawnUnion(bin, call, dirs, opts?.run);
		if ("why" in union) {
			cache.writeRefusal(key, union.why);
			return union;
		}
		raw = union.raw;
		cache.write(key, raw);
	} finally {
		if (leading) cache.release(key);
	}

	return dated(classifyRaw(raw, call, opts, runs.agents), Date.now());
}

/**
 * @param {string} bin
 * @param {string} call
 * @param {string[]} dirs
 * @param {RunOracle} [run]
 * @returns {{raw: string} | {why: string}}
 */
function spawnUnion(bin, call, dirs, run = runOracle) {
	let out;
	const firstCapMs = oracleTimeoutMs();
	const firstMs = budgetMs(firstCapMs);
	try {
		out = run(bin, firstMs, dirs);
	} catch (e) {
		const why = wouldNotRun(call, e);
		if (caught(e).code !== "ETIMEDOUT") return { why };
		if (firstMs < firstCapMs)
			return { why: `${why} inside the hook's time budget, ${firstMs} ms` };
		const retryMs = budgetMs(oracleRetryTimeoutMs());
		try {
			out = run(bin, retryMs, dirs);
		} catch (again) {
			return {
				why: `${wouldNotRun(call, again)} — twice, the retry given ${retryMs} ms`,
			};
		}
	}
	return unionOf(out, call, dirs);
}

/**
 * @param {string} raw
 * @param {string} call
 * @param {Opts|undefined} opts
 * @param {AgentRecord[]} headlessAgents
 * @returns {Listing}
 */
function classifyRaw(raw, call, opts, headlessAgents) {
	const parsed = parseListing(raw, call);
	if ("why" in parsed) return parsed;
	return mergedListing(parsed.agents, headlessAgents, call, opts);
}

/**
 * @param {any[]} agents
 * @param {AgentRecord[]} headlessAgents
 * @param {string} call
 * @param {Opts} [opts]
 * @returns {Listing}
 */
function mergedListing(agents, headlessAgents, call, opts) {
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	const meHeadless =
		Boolean(me) && headlessAgents.some((a) => a.sessionId === me);
	if (agents.length === 0) {
		if ((opts?.allowEmpty === true && !me) || meHeadless)
			return { agents: headlessAgents };
		return {
			why: `${call} listed no agents at all — a daemon that is running lists at least the session this ran in`,
		};
	}

	/** @type {Set<string>} */
	const ids = new Set();
	for (const a of agents) if (hasSessionId(a)) ids.add(a.sessionId);
	if (ids.size === 0)
		return {
			why: `${call} listed ${agents.length} agent(s), none of them carrying a sessionId — the shape it reports has changed`,
		};

	if (opts?.requireSelf !== false && me && !ids.has(me) && !meHeadless)
		return {
			why: `${call} does not list this very session (${me}), so its list is not a list of what is live`,
		};

	return {
		agents: [
			...withoutHeadlessCopies(agents, headlessAgents),
			...headlessAgents,
		],
	};
}

/**
 * @param {any[]} agents
 * @param {AgentRecord[]} headlessAgents
 * @returns {AgentRecord[]}
 */
function withoutHeadlessCopies(agents, headlessAgents) {
	const ids = new Set(headlessAgents.map((a) => a.sessionId));
	const pids = new Set(headlessAgents.map((a) => a.pid));
	return agents.filter(
		(a) =>
			hasSessionId(a) &&
			!ids.has(a.sessionId) &&
			!(!isTerminalAgent(a) && pids.has(a.pid)),
	);
}

/**
 * @param {any} a
 * @returns {boolean}
 */
const hasSessionId = (a) =>
	Boolean(a) && typeof a.sessionId === "string" && a.sessionId !== "";

/**
 * @returns {{agents: AgentRecord[]} | {why: string}}
 */
function readHeadlessRuns() {
	try {
		return { agents: headless.readLiveAgents() };
	} catch (e) {
		const { code, message } = caught(e);
		return {
			why: `the headless-run store could not be read (${code || String(message).slice(0, QUOTE_CHARS)})`,
		};
	}
}

/** @returns {{dirs: Array<{dir: string} & Listing>, headless: Listing}} */
function readEverySeat() {
	const store = readHeadlessRuns();
	const runs = "why" in store ? [] : store.agents;
	const dirs = oracleDirs().map((dir) => {
		try {
			const read = readSeatListing(dir, oracleTimeoutMs());
			if ("why" in read) return { dir, why: read.why };
			return { dir, agents: withoutHeadlessCopies(read.agents, runs) };
		} catch (e) {
			return { dir, why: wouldNotRun(oracleCall(), e) };
		}
	});
	return { dirs, headless: store };
}

/**
 * @template T
 * @param {Opts|undefined} opts
 * @param {unknown} requireSelf
 * @param {(listed: Listing) => T} answer
 * @param {Omit<ReadOpts, "requireSelf">} [how]
 * @returns {T | {why: string}}
 */
function refuseOnThrow(opts, requireSelf, answer, how = {}) {
	const read = opts?.read || readListing;
	try {
		return answer(read({ requireSelf, run: opts?.run, ...how }));
	} catch (e) {
		const said = String(caught(e).message || e).slice(0, QUOTE_CHARS);
		return { why: `${oracleCall()} could not be read: ${said}` };
	}
}

/**
 * @param {Opts} [opts]
 * @returns {Listing}
 */
function listedAgents(opts) {
	return refuseOnThrow(opts, opts?.requireSelf, checkedListing);
}

/** @param {Listing} listed */
function checkedListing(listed) {
	if (listed && (listed.why || listed.agents)) return listed;
	throw new TypeError("answered with neither agents nor a why");
}

/** @returns {Listing} */
function readAgentsAllowingEmpty() {
	return refuseOnThrow(undefined, false, checkedListing, { allowEmpty: true });
}

/** @returns {Listing} */
function readAgentsAfterBoot() {
	return readAgentsAllowingEmpty();
}

/** @returns {Listing} */
function readAgentsForBudget() {
	return readAgentsAllowingEmpty();
}

/** @returns {Listing} */
function readAgentsForLevelling() {
	return readAgentsAllowingEmpty();
}

/** @returns {Listing} */
function readAgentsForCutover() {
	return refuseOnThrow(undefined, undefined, checkedListing, {
		allowEmpty: true,
	});
}

/** @returns {Listing} */
function readAgentsForCompaction() {
	return readAgentsAllowingEmpty();
}

// ~2.5 CPU-s a refresh measured, #4169
const DISPLAY_MAX_AGE_MS = 240_000;

/** @returns {Listing} */
function readAgentsForDisplay() {
	return refuseOnThrow(undefined, false, checkedListing, {
		allowEmpty: true,
		shownAgeMs: DISPLAY_MAX_AGE_MS,
	});
}

/** @param {AgentRecord} a */
const isFinishedAgent = (a) =>
	a.kind === "background" && a.state === "done" && a.tempo !== "active";

const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);

/** @param {AgentRecord} a */
const isTerminalAgent = (a) =>
	a.kind === "background" && TERMINAL_STATES.has(a.state ?? "");

/**
 * @param {unknown} sessionId
 * @param {Set<string>} ids
 * @param {Set<string>|null} [terminal]
 */
const isListedLive = (sessionId, ids, terminal) =>
	ids.has(String(sessionId)) && !terminal?.has(String(sessionId));

/** @param {AgentRecord[]} agents */
function agentFieldMaps(agents) {
	/** @type {Map<string, string>} */
	const names = new Map();
	/** @type {Map<string, number>} */
	const pids = new Map();
	/** @type {Map<string, string>} */
	const cwds = new Map();
	for (const a of agents) {
		if (a.name) names.set(a.sessionId, a.name);
		if (a.pid) pids.set(a.sessionId, a.pid);
		cwds.set(a.sessionId, a.cwd ?? "");
	}
	return { names, pids, cwds };
}

/**
 * @param {Opts} [opts]
 * @returns {ListedSessions}
 */
function listedSessionIds(opts) {
	return sessionIdsOf(opts);
}

/**
 * @param {Opts} [opts]
 * @returns {ListedSessions}
 */
function sharedSessionIds(opts) {
	return sessionIdsOf(opts, { shared: true });
}

/**
 * @param {Opts} [opts]
 * @returns {ListedSessions}
 */
function admissionSessionIds(opts) {
	return sessionIdsOf(opts, { allowEmpty: true });
}

/**
 * @param {Opts | undefined} opts
 * @param {Omit<ReadOpts, "requireSelf">} [how]
 * @returns {ListedSessions}
 */
function sessionIdsOf(opts, how = {}) {
	return refuseOnThrow(
		opts,
		true,
		(listed) => {
			if (listed.why) return { why: listed.why };
			if (!listed.agents)
				throw new TypeError("answered with neither agents nor a why");
			const { names, pids, cwds } = agentFieldMaps(listed.agents);
			return {
				ids: new Set(listed.agents.map((a) => a.sessionId)),
				unvouched: listed.agents.length === 0,
				names,
				finished: new Set(
					listed.agents.filter(isFinishedAgent).map((a) => a.sessionId),
				),
				terminal: new Set(
					listed.agents.filter(isTerminalAgent).map((a) => a.sessionId),
				),
				pids,
				cwds,
			};
		},
		how,
	);
}

/**
 * @param {Opts} [opts]
 * @param {string} [starter]
 * @returns {{ids: Set<string>, names: Map<string, string>, finished: Set<string>, terminal: Set<string>, cwds: Map<string, string>, why?: undefined}
 *   | {why: string, ids?: undefined, names?: undefined, finished?: undefined, terminal?: undefined, cwds?: undefined}}
 */
function sweepSessionIds(opts, starter) {
	return refuseOnThrow(opts, false, (listed) => {
		if (listed.why) return { why: listed.why };
		if (!listed.agents)
			throw new TypeError("answered with neither agents nor a why");
		const ids = new Set(listed.agents.map((a) => a.sessionId));
		/** @type {Map<string, string>} */
		const names = new Map();
		for (const a of listed.agents) if (a.name) names.set(a.sessionId, a.name);
		const me = starter || process.env.CLAUDE_CODE_SESSION_ID;
		if (me) ids.add(me);
		const finished = new Set(
			listed.agents.filter(isFinishedAgent).map((a) => a.sessionId),
		);
		const terminal = new Set(
			listed.agents.filter(isTerminalAgent).map((a) => a.sessionId),
		);
		const { cwds } = agentFieldMaps(listed.agents);
		return { ids, names, finished, terminal, cwds };
	});
}

module.exports = {
	DISPLAY_MAX_AGE_MS,
	claudeBin,
	isFinishedAgent,
	isListedLive,
	isTerminalAgent,
	listedAgents,
	readAgentsAfterBoot,
	readAgentsForBudget,
	readAgentsForCompaction,
	readAgentsForCutover,
	readAgentsForLevelling,
	readAgentsForDisplay,
	readEverySeat,
	listedSessionIds,
	admissionSessionIds,
	oracleCacheKey,
	readSeatListing,
	runOracle,
	sharedSessionIds,
	sweepSessionIds,
	TERMINAL_STATES,
};
