/*
 * agent-liveness.js — the one reader of `claude agents --json`, the only
 * documented interface that says which sessions are live (mantahostels#318 fixed it as the
 * oracle). The finished-session reaper and the refill loop's never-started
 * stop read lib/registry-agents.js instead, which needs no CLI (#2665).
 *
 * THIS HEADER OWNS THE ~465 ms FIGURE, and every other statement of it in
 * `scripts/` restates this line. Measured at mantahostels#317. A site citing
 * **mantahostels#411 cites the BAR the figure justifies**, never the
 * measurement.
 *
 * NO `docs/doc-map.md` §B ENTRY, because it is repo machinery (mantahostels#2504).
 *
 * ~465 ms BARS IT FROM A PreToolUse HOOK (mantahostels#411) — and a read can also spend up
 * to `waitMs` following another process's spawn (mantahostels#1924). Every caller is something a
 * person waits for once. The issue-claim prune is a SessionStart hook, and pays
 * the ~465 ms only once `agedUnspared` says a record would actually be deleted
 * (`arbiter-issue-claims.js`, `pruneIssueClaims`).
 *
 * NEVER ~/.claude/jobs/<id>/state.json (mantahostels#104). CLAUDE_JOB_DIR is cleaned under a
 * session that is still running, so its absence proves nothing.
 *
 * DEGRADES TO DOUBT, NEVER TO "DEAD". Every unexpected answer returns a `why`
 * for the caller to refuse or skip on, and no input throws — a throw aborts the
 * caller mid-pass, which no caller catches (mantahostels#517, the ticket that found a JSON
 * `null` throwing here). No caller may narrow the live set on a partial read.
 *
 * TWO EXEMPTIONS, DELIBERATE. `requireSelf: false` waives the self-test alone.
 * No caller but `sharedSessionIds` and `readAgentsForDisplay` is offered an
 * AGED cache hit (mantahostels#1960): a cached success can be served back
 * across a daemon failure in between (mantahostels#1946).
 * The self-test protects a reader whose judgement IS an absence — a session
 * missing from a short list reads dead. A reader that acts only on fields
 * present in a record can merely act less on a short list; and at
 * SessionStart the starting session is not yet registered, so the test was a
 * false positive on every run (mantahostels#535). Opt-in, never a new
 * default: mantahostels#535 rejected the fail-open variant where the list carries a caveat
 * every caller must remember to check. The mutations proving the wiring are
 * recorded at mantahostels#540.
 *
 * `sharedSessionIds` is `wait`'s alone (#3561): one reading per TTL for every
 * waiter. `readAgentsForDisplay` is `refill-loop.js`'s shown overflow budget's
 * (#4169) — the panel's status poll, and the seats line `start` and `set`
 * print — which acts on nothing it shows, so its hit may be older. A stale record is
 * never served; past the TTL it
 * spawns or, with another reader already refreshing, answers `{why}`. A
 * failed refresh is published too, and served as `{why}` for the TTL. Its
 * one verdict off a hit is confirmed by a fresh read before it fires.
 *
 * The second, `admissionSessionIds`, reads an empty listing as nothing live,
 * outside a session only, where nothing says the list must name anyone
 * (#2180). Inside a session an empty list is still a fault. It is its own
 * export, never an option, so no reader judging by absence can pass it. The
 * readers that may are `readAgentsAfterBoot` and `readAgentsForBudget`, whose
 * names say when (#3880, #3695).
 *
 * EVERY LISTING IS EVERY PLAN'S (#3512). `claude agents --json` is scoped to
 * CLAUDE_CONFIG_DIR, so the oracle is read once per `sessionDirs()` dir
 * (lib/arbiter-core.js). One dir's read failing refuses the whole listing.
 *
 * EVERY LISTING CARRIES THE LIVE HEADLESS RUNS (lib/headless-runs.js,
 * #2608): `claude -p` on an overflow seat has no daemon job. They are merged
 * on every read and never cached, each replacing the row the oracle derives
 * from its transcript (same session id, or a live row's pid, #4588), and the
 * self-test finds a headless caller among them. A store that will not read
 * is a `why`, as an oracle fault is, read before the oracle so no
 * single-flight follower spawns on one.
 *
 * RESIDUAL: inside a headless run an empty daemon listing is taken as
 * complete, since an overflow-only machine lists no daemon session. A daemon
 * fault answering `[]` there (#2180) reads as no background session live.
 */

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
const { buildSeatEnv } = require("./seat-claude.js");
const headless = require("./headless-runs.js");

/**
 * One record as `claude agents --json` reports it. Every field but the id is
 * optional, and a record missing one is dropped or skipped rather than trusted.
 *
 * One field or the other is set, never both. Each absent field is spelled
 * `?: undefined` so a caller can destructure the answer and still narrow on
 * one field.
 *
 * `startedAt` is EPOCH MILLISECONDS, not an ISO string — the oracle emits a
 * number. `lib/scratch-sweep.js` reads it: a file is safe to delete exactly
 * where no live session predates its mtime.
 *
 * `kind: "headless"` marks a run lib/headless-runs.js listed, which
 * `claude stop` cannot reach: lib/claude-stop.js stops it by its group. Its
 * `seat` is the config dir it runs under.
 *
 * @typedef {{sessionId: string, id?: string, name?: string, pid?: number,
 *   kind?: string, state?: string, status?: string, tempo?: string,
 *   startedAt?: number, cwd?: string, seat?: string,
 *   founderReply?: true}} AgentRecord
 * @typedef {{agents: AgentRecord[], why?: undefined}
 *   | {why: string, agents?: undefined}} Listing
 * @typedef {{why: string, ids?: undefined, names?: undefined,
 *   finished?: undefined, terminal?: undefined, pids?: undefined,
 *   cwds?: undefined, states?: undefined, kinds?: undefined}} SessionsRefused
 * @typedef {{why?: undefined, ids: Set<string>, names: Map<string, string>,
 *   finished: Set<string>, terminal: Set<string>,
 *   pids: Map<string, number>, cwds: Map<string, string>,
 *   states: Map<string, string>, kinds: Map<string, string>,
 *   unvouched?: boolean}} SessionsListed
 * @typedef {SessionsRefused|SessionsListed} ListedSessions
 * @typedef {{requireSelf?: unknown, allowEmpty?: boolean, shared?: boolean,
 *   shownAgeMs?: number}} ReadOpts  `shownAgeMs`, a hit up to that old for a
 *   reader that only shows it, which otherwise reads as a strict reader does
 * @typedef {{read?: (o: ReadOpts) => any,
 *   requireSelf?: unknown, allowEmpty?: boolean}} Opts
 *   `read` answers `any` on purpose: it is the suite's seam, and its job is to
 *   hand this module shapes the oracle should never produce.
 */

/* Untraced: enough of a quoted message to name a fault without printing a
 * whole stringified value. */
const QUOTE_CHARS = 200;

/* Every refusal names the command it could not read. */
const oracleCall = () => `\`${claudeBin()} agents --json\``;

/*
 * The ceiling is for a daemon that hangs rather than answers, which must not
 * wedge a SessionStart hook.
 *
 * WHY A TIMEOUT IS RETRIED AND NOTHING ELSE IS (mantahostels#1900). One cap is not a clean
 * wedge signal: one timed sample in six ran over it with the machine quiet,
 * the slowest at 10.8 s. The tail is load-driven, so it blows at SessionStart,
 * when the machine is busiest. A timeout there says
 * "queued behind load", not "wedged". The retry gets a LONGER cap, so a second
 * timeout is the wedge signal the first cap was meant to be. Every other
 * failure — ENOENT, a non-zero exit — is deterministic, and retrying it only
 * doubles the wait before the same refusal.
 *
 * Both caps are overridable so the suite can drive them to milliseconds, and
 * a hook that started lib/hook-deadline.js's clock cuts both to what its
 * budget leaves. A first read cut by that budget is not retried: its timeout
 * says the hook's time ran out, not that the daemon queued (#4115). RESIDUAL:
 * a cold daemon the 20 s retry would have waited out now answers that Stop
 * hook a `why`, and guard-uncommitted-work.js then subtracts no neighbour's
 * writes and says so in its block.
 */
const oracleTimeoutMs = () => capMs("WFC_ORACLE_TIMEOUT_MS", 10_000);
const oracleRetryTimeoutMs = () => capMs("WFC_ORACLE_RETRY_TIMEOUT_MS", 20_000);

/**
 * A positive millisecond cap from `env`, else `fallback` — a garbled knob must
 * not disable the ceiling.
 *
 * @param {string} env
 * @param {number} fallback
 * @returns {number}
 */
function capMs(env, fallback) {
	const n = Number(process.env[env]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/*
 * Every dir's read, all at once, as background jobs of one shell: each stdout
 * to its own file, capped at the output cap by the shell's file-size limit,
 * then the first failed read's status, else 0. A binary missing, a directory or
 * not executable exits 127 with the spawn code a direct spawn would give, alone
 * on stderr; one that passes those checks and still will not start (a missing
 * shebang interpreter) reads as its exit status instead.
 *
 * WHY IN PARALLEL. Serially the reads cost the sum of three or four CLI starts
 * against the 10 s cap.
 * WHY A SHELL. A synchronous spawn cannot run children in parallel, and a
 * second node is the costlier start (#4609).
 */
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

/**
 * The config dirs the oracle is read in: this caller's own, then every other
 * seat's that exists.
 * @returns {string[]}
 */
function oracleDirs() {
	return sessionDirs().filter((d, i) => i === 0 || fs.existsSync(d));
}

/**
 * The oracle cache's key: the binary and the dirs it reads, in a fixed order,
 * so every reader of one set of dirs shares a record and a reader of another
 * set, which starts from its own config dir, never takes it (#3561).
 * Exported for the suite, which finds the record on disk through it.
 * @param {string} [bin]
 * @param {string[]} [dirs]
 * @returns {string}
 */
function oracleCacheKey(bin = claudeBin(), dirs = oracleDirs()) {
	return JSON.stringify([bin, ...dirs.map(realKey).sort()]);
}

/**
 * One oracle call per dir, all at once and capped together, answering each
 * dir's stdout in `dirs` order. The shell runs in a process group of its own,
 * killed whole once it ends, so a capped read kills every child it started,
 * not the shell alone (#2665).
 *
 * RESIDUAL: the group is its own, so a kill of this caller's group misses it,
 * and a caller killed mid-read leaves its reads and their temp dir behind until
 * each read ends.
 *
 * @param {string} bin
 * @param {number} timeoutMs
 * @param {string[]} dirs
 * @returns {string[]}
 */
function runOracle(bin, timeoutMs, dirs) {
	/* Each job sets its own dir; the first seat's env stands for every seat's. */
	const [seat] = dirs;
	if (seat === undefined) throw new Error("runOracle was given no config dir");
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"));
	/* Node honours `detached` on a synchronous spawn, undocumented and missing
	 * from its types; the suite's leftover-children case fails should that stop. */
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
 * One oracle stdout as its parsed array, or `{why}` where it is not one. Its
 * records are `any`, as `mergedListing` takes them: each is judged there field
 * by field.
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
 * One seat's own listing, read in `dir` alone, as `parseListing` answers it.
 * A caller asking which of one plan's sessions are live reads this, never the
 * union `listedAgents` takes, since only within its own seat does a session
 * missing from the listing read dead (#3512). Throws where the read would not
 * run, as `runOracle` does.
 * @param {string} dir
 * @param {number} timeoutMs
 * @returns {ReturnType<typeof parseListing>}
 */
function readSeatListing(dir, timeoutMs) {
	const [raw] = runOracle(claudeBin(), timeoutMs, [dir]);
	if (raw === undefined)
		throw new Error(`runOracle answered no stdout for its one dir, ${dir}`);
	return parseListing(raw, oracleCall());
}

/**
 * The per-dir stdouts as one JSON array, the first record per
 * session id kept, unless it is terminal and a later one is not: a session
 * moved between seats reads live though its old seat's dir leads (#3734). `{why}`
 * where any one is not an array. A record with no id is kept for
 * `mergedListing` to judge.
 *
 * @param {string[]} stdouts  runOracle's
 * @param {string} call
 * @returns {{raw: string} | {why: string}}
 */
function unionOf(stdouts, call) {
	/* `any`, as parseListing's records are. */
	/** @type {any[]} */
	const all = [];
	for (const raw of stdouts) {
		const parsed = parseListing(raw, call);
		if ("why" in parsed) return parsed;
		all.push(...parsed.agents);
	}
	return { raw: JSON.stringify(preferLiveRecords(all)) };
}

/**
 * `records` with one per session id, in first-seen order: the first, unless it
 * is terminal and a later one is not. A record with no id is always kept. `any`,
 * as `mergedListing` takes them: each is judged there field by field.
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
 * A failed oracle call's code, or its exit status — never its message, which
 * embeds the whole argv and so names the command rather than the failure.
 *
 * @param {unknown} e
 * @returns {string}
 */
function failure(e) {
	const { code, status } = caught(e);
	return code || `exit ${status ?? "on a signal"}`;
}

/**
 * The refusal for an oracle call that threw rather than answered.
 * @param {string} call
 * @param {unknown} e
 * @returns {string}
 */
const wouldNotRun = (call, e) => `${call} would not run (${failure(e)})`;

/**
 * Runs the oracle and classifies what it said, as `{agents}` or `{why}`.
 *
 * The whole record, not just the id: a reader deciding whether a session is
 * FINISHED rather than merely live needs `state`, `status` and `kind` too
 * (mantahostels#421, the finished-session pool).
 *
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

	/* A plain hit for the shared and shown readers alone (module header). */
	/** @param {string|null} cached */
	const served = (cached) => {
		if (cached === null) return null;
		const answer = classifyRaw(cached, call, opts, runs.agents);
		return answer.why ? null : answer;
	};
	if (opts?.shared || opts?.shownAgeMs !== undefined) {
		const hit = served(cache.readFresh(key, undefined, opts.shownAgeMs));
		if (hit) return hit;
		const refused = cache.readRefusal(key);
		if (refused !== null) return { why: `${refused} (a shared reading)` };
	}

	/* Otherwise single-flight only: lead and spawn, or follow and take what the
	 * leader publishes — three readers launched at one instant otherwise pay
	 * three spawns of the same binary (mantahostels#1921, #1446). A follower
	 * given nothing usable falls through and spawns its own; a shared one
	 * answers doubt instead (#3561), while a shown one spawns, as a panel row
	 * reading unread while a slow leader finishes would flicker (#4169). */
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
		const union = spawnUnion(bin, call, dirs);
		if ("why" in union) {
			cache.writeRefusal(key, union.why);
			return union;
		}
		raw = union.raw;
		/* PUBLISHED BEFORE THE LOCK IS DROPPED.
		 * A follower treats "no record and no lock" as a leader that died, and
		 * spawns; releasing first opens exactly that window on the happy path, so
		 * the spawn this saves would be given straight back. */
		cache.write(key, raw);
	} finally {
		/* A follower must not be held past the spawn it is waiting for. */
		if (leading) cache.release(key);
	}

	return classifyRaw(raw, call, opts, runs.agents);
}

/**
 * Every dir's oracle read, unioned, as `{raw}` — or `{why}` where it would not
 * run or one dir's answer is not a listing.
 * @param {string} bin
 * @param {string} call
 * @param {string[]} dirs
 * @returns {{raw: string} | {why: string}}
 */
function spawnUnion(bin, call, dirs) {
	let out;
	const firstCapMs = oracleTimeoutMs();
	const firstMs = budgetMs(firstCapMs);
	try {
		out = runOracle(bin, firstMs, dirs);
	} catch (e) {
		const why = wouldNotRun(call, e);
		if (caught(e).code !== "ETIMEDOUT") return { why };
		if (firstMs < firstCapMs)
			return { why: `${why} inside the hook's time budget, ${firstMs} ms` };
		// Exactly one retry: a second timeout is the wedge the cap exists for, and
		// a loop here would wedge the SessionStart hook the cap protects.
		const retryMs = budgetMs(oracleRetryTimeoutMs());
		try {
			out = runOracle(bin, retryMs, dirs);
		} catch (again) {
			return {
				why: `${wouldNotRun(call, again)} — twice, the retry given ${retryMs} ms`,
			};
		}
	}
	return unionOf(out, call);
}

/**
 * Classifies one oracle stdout, as `{agents}` or `{why}`.
 *
 * Split from the reading above so a CACHED stdout passes through exactly the
 * same guards as a freshly spawned one (mantahostels#1924). The self-test in particular is
 * per-caller — two sessions reading one listing get different answers from it —
 * so it has to run on the read, never once at the point of caching.
 *
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
 * The oracle's parsed array with the live headless runs merged in, as
 * `{agents}` — or `{why}` where the empty-list or self-test guard refuses it.
 *
 * @param {any[]} agents
 * @param {AgentRecord[]} headlessAgents
 * @param {string} call
 * @param {Opts} [opts]
 * @returns {Listing}
 */
function mergedListing(agents, headlessAgents, call, opts) {
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	/* A headless caller's own run is no daemon's, so a daemon listing nothing
	 * beside it says nothing of the daemon. */
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

	/*
	 * The self-test. If this is running inside a session the oracle does not name,
	 * then whatever that list is, it is not the list of live sessions — and every
	 * claim would read dead. Absent outside a session, where there is nothing to
	 * test against, and waived wherever `requireSelf: false` is passed.
	 */
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
 * `agents` less any record without a session id and any row the oracle derives
 * from a headless run's transcript: same session id, or a live row's pid
 * (#4588).
 * @param {any[]} agents  oracle records, unjudged: this is where each is judged
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
 * @param {any} a an oracle record, unjudged
 * @returns {boolean}
 */
const hasSessionId = (a) =>
	Boolean(a) && typeof a.sessionId === "string" && a.sessionId !== "";

/**
 * The live headless runs as `{agents}`, or `{why}` where the store will not
 * read.
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

/**
 * Every seat's listing kept apart by config dir, for a person to read
 * (#4224): each existing dir's own records or its `why`, then the live
 * headless runs or the store's `why`. Each dir is read alone, so one failing
 * names itself and the rest still answer, and a session moved between seats
 * shows under each dir that lists it. Uncached and unchecked: no caller may
 * judge liveness off it, which `listedAgents` is for.
 * @returns {{dirs: Array<{dir: string} & Listing>, headless: Listing}}
 */
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
 * The net under every guard above: an unexpected throw becomes a refusal.
 *
 * `read` is a seam for the suite alone, and it arrives in an options object
 * rather than positionally because both exports are passed around as bare
 * function values, where a stray positional argument would silently stand in
 * for the oracle itself.
 *
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
		return answer(read({ requireSelf, ...how }));
	} catch (e) {
		const said = String(caught(e).message || e).slice(0, QUOTE_CHARS);
		return { why: `${oracleCall()} could not be read: ${said}` };
	}
}

/**
 * Every record `claude agents --json` lists, as `{agents}` — or `{why}`, the
 * sentence explaining why nothing can be said.
 *
 * `opts.requireSelf: false` waives the self-test and nothing else.
 * Fail-closed: only the literal `false` waives it.
 *
 * @param {Opts} [opts]
 * @returns {Listing}
 */
function listedAgents(opts) {
	// The identity would hand a reader's own answer back unchecked.
	return refuseOnThrow(opts, opts?.requireSelf, checkedListing);
}

/**
 * The listing as listedAgents's answer takes it, a reader's own answer refused.
 * @param {Listing} listed
 */
function checkedListing(listed) {
	if (listed && (listed.why || listed.agents)) return listed;
	throw new TypeError("answered with neither agents nor a why");
}

/**
 * `listedAgents` waiving the self-test, for a refill-loop tick with a boot's
 * killed launches still to bring back, reading an empty listing outside a session
 * as nothing live (#3880): a restart leaves no session for the listing to name, so
 * refusing it would hold every resume until something else started. Its residual
 * is `admissionSessionIds`'s: a daemon answering `[]` reads as no session running.
 * @returns {Listing}
 */
function readAgentsAfterBoot() {
	return refuseOnThrow(undefined, false, checkedListing, { allowEmpty: true });
}

/**
 * `listedAgents` for the overflow budget (lib/overflow-budget.js), waiving the
 * self-test, reading an empty listing outside a session as nothing live: a loop
 * with no session running must still size a key. Its residual is
 * `admissionSessionIds`'s; Anthropic's refusal at the grant bounds what it grants.
 * @returns {Listing}
 */
function readAgentsForBudget() {
	return refuseOnThrow(undefined, false, checkedListing, { allowEmpty: true });
}

/*
 * HOW OLD A SHOWN LISTING MAY BE (#4169), measured 4 Nov 2026 at load ~13:
 * one refresh of every plan's listing cost ~2.5 CPU-s and a cached
 * `refill-loop.js status --json` ~0.16, so the panel's 3 s poll costs ~0.05
 * core plus 2.5 s per this age, under 0.1 core from ~60 s; 120 s leaves room for a
 * slower refresh. Any strict read writes the reading too, so beside a running
 * loop's tick it is fresher than this.
 */
const DISPLAY_MAX_AGE_MS = 120_000;

/**
 * `readAgentsForBudget` off the shared reading, for what `refill-loop.js
 * status` only shows (#4169): up to DISPLAY_MAX_AGE_MS old. The panel polls it
 * every few seconds, and a strict read there started every plan's CLI each poll.
 * @returns {Listing}
 */
function readAgentsForDisplay() {
	return refuseOnThrow(undefined, false, checkedListing, {
		allowEmpty: true,
		shownAgeMs: DISPLAY_MAX_AGE_MS,
	});
}

/**
 * Whether an oracle record is a background session that has FINISHED and not
 * exited — the reaper's gate 1.
 *
 * `status` IS DELIBERATELY NOT READ (mantahostels#768, research at
 * mantahostels#765): a `shell` session emits `state: done` with `status: busy`,
 * so reading `status` drops finished sessions.
 *
 * `tempo: "active"` IS NOT FINISHED (#2980): a forced Stop-hook turn runs
 * under `state: done`, and `claude stop` itself counts a job settled only where
 * `tempo` is not `active` — on one that is, it writes `stopped` over the
 * result (#2977's research, Finding 3). So the reclaimable pools built off
 * this predicate leave such a job out too: its memory is not yet the reaper's
 * to return. Only the job record carries `tempo`; a CLI record lacks it and is
 * judged on `state` alone.
 */
/** @param {AgentRecord} a */
const isFinishedAgent = (a) =>
	a.kind === "background" && a.state === "done" && a.tempo !== "active";

/**
 * The three states the oracle emits for a background session that has REACHED A
 * TERMINAL STATE (mantahostels#765's research, §F1).
 */
const TERMINAL_STATES = new Set(["done", "failed", "stopped"]);

/**
 * Whether an oracle record is a background session that has STOPPED DOING WORK,
 * however it ended — done, failed or stopped.
 *
 * WIDER THAN `isFinishedAgent`, AND DELIBERATELY NOT THE SAME PREDICATE
 * (mantahostels#2774). The reaper's gate stops a process, and pick-next's `reclaimable`
 * headline promises the memory that reap returns, so both must name exactly the
 * pool the reaper acts on — `done` alone. This one only decides whether the
 * oracle still listing a session counts as evidence it is alive, and a session
 * the oracle calls `failed` or `stopped` is no more alive than one it calls
 * `done`.
 *
 * `status` IS NOT READ HERE EITHER, for `isFinishedAgent`'s reason above.
 *
 * @param {AgentRecord} a
 */
const isTerminalAgent = (a) =>
	a.kind === "background" && TERMINAL_STATES.has(a.state ?? "");

/**
 * Whether the oracle read `ids`/`terminal` counts `sessionId` as live: listed
 * AND not terminal (#268, #619). `terminal` absent is an oracle that cannot
 * say, so every listed id reads live. The id is coerced, as an issue-claim
 * record read off disk is not typed.
 * @param {unknown} sessionId
 * @param {Set<string>} ids
 * @param {Set<string>|null} [terminal]
 */
const isListedLive = (sessionId, ids, terminal) =>
	ids.has(String(sessionId)) && !terminal?.has(String(sessionId));

/**
 * `listedSessionIds`'s per-field maps, keyed by session id.
 *
 * The maps are filled by one walk rather than by filter-then-map: a
 * `filter` proves the field is there to a reader and to nothing else, so
 * the map would carry an optional value every caller then has to re-test.
 *
 * A record without a field is simply absent from that field's map, so a
 * caller falls back to the id rather than to "" (mantahostels#708, mantahostels#1295).
 * @param {AgentRecord[]} agents
 */
function agentFieldMaps(agents) {
	/** @type {Map<string, string>} */
	const names = new Map();
	/** @type {Map<string, number>} */
	const pids = new Map();
	/** @type {Map<string, string>} */
	const cwds = new Map();
	/** @type {Map<string, string>} */
	const states = new Map();
	/** @type {Map<string, string>} */
	const kinds = new Map();
	for (const a of agents) {
		if (a.name) names.set(a.sessionId, a.name);
		if (a.pid) pids.set(a.sessionId, a.pid);
		if (a.state) states.set(a.sessionId, a.state);
		if (a.kind) kinds.set(a.sessionId, a.kind);
		cwds.set(a.sessionId, a.cwd ?? "");
	}
	return { names, pids, cwds, states, kinds };
}

/**
 * The session ids `claude agents --json` lists, as `{ids}` — with `names`
 * mapping each to its display name, `pids` mapping each to its pid, `states`
 * and `kinds` each to the oracle's own field,
 * `finished` holding the subset that has FINISHED but is still resident, and
 * `terminal` the wider subset that has stopped working however it ended
 * (mantahostels#2774) — or `{why}`, the sentence explaining why nothing can be said.
 *
 * Always strict: `requireSelf` is not honoured here. pick-next.js subtracts
 * itself from its session count on the strength of this reader listing its own
 * caller (mantahostels#437), so the waiver is kept off this export rather than trusted to
 * every future caller not to pass it.
 *
 * @param {Opts} [opts]
 * @returns {ListedSessions}
 */
function listedSessionIds(opts) {
	return sessionIdsOf(opts);
}

/**
 * `listedSessionIds` off the shared reading, for `wait` alone (#3561): up to the cache TTL old, so a caller acting on what it says
 * confirms with `listedSessionIds` first.
 * @param {Opts} [opts]
 * @returns {ListedSessions}
 */
function sharedSessionIds(opts) {
	return sessionIdsOf(opts, { shared: true });
}

/**
 * `listedSessionIds` for admission alone, reading an empty listing outside a
 * session as nothing live (#2180, the module header). Its residual: a daemon
 * answering `[]` there reads as no session running, and only admission's
 * memory read then bounds what it grants.
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
			/* Thrown so `refuseOnThrow` turns it into a why a reader can act on,
			 * rather than leaving it to a TypeError raised further down. */
			if (!listed.agents)
				throw new TypeError("answered with neither agents nor a why");
			const { names, pids, cwds, states, kinds } = agentFieldMaps(
				listed.agents,
			);
			return {
				ids: new Set(listed.agents.map((a) => a.sessionId)),
				/* Of these readers only `admissionSessionIds` lets an empty listing through, taken
				 * on trust: a daemon fault answers the same (#2180). */
				unvouched: listed.agents.length === 0,
				names,
				/*
				 * The finished-but-resident pool, for a caller reporting reclaimable
				 * memory off this same read (mantahostels#653).
				 *
				 * REPORTING, never a reap: whether a member is past the reaper's grace
				 * window is not readable here.
				 */
				finished: new Set(
					listed.agents.filter(isFinishedAgent).map((a) => a.sessionId),
				),
				/* The wider pool a caller judging LIVENESS reads (`isTerminalAgent`). */
				terminal: new Set(
					listed.agents.filter(isTerminalAgent).map((a) => a.sessionId),
				),
				/*
				 * Off this SAME oracle read, so admission can pair each session
				 * with its processes for its draw and memory rows without a
				 * second `claude agents --json` spawn (mantahostels#1295, additive to the shape
				 * `admission.js`, `wayfinder-frontier.js` and `session-arbiter.js`
				 * already destructure).
				 */
				pids,
				/* Each session's cwd, "" where the oracle gave none, for the repo
				 * whose session draw admission charges it (#2221). */
				cwds,
				/* Each session's own `state` and `kind`, for the memory breakdown's
				 * finished-but-resident row (#588). */
				states,
				kinds,
			};
		},
		how,
	);
}

/**
 * The session ids for a SWEEP: the oracle's list with this caller's own id
 * added back, as `{ids}`, with `names` mapping each listed id to its display
 * name, `finished` holding the subset that has FINISHED but is still
 * resident, mirroring `listedSessionIds`'s field (mantahostels#2765), and `terminal`
 * holding the wider subset that has stopped working HOWEVER it ended (mantahostels#2774),
 * and `cwds` each listed session's cwd — or `{why}`, the sentence explaining
 * why nothing can be said.
 *
 * See `isTerminalAgent` for why they are not one predicate.
 *
 * `names` carries only what the oracle listed, so this caller's own id is
 * absent from it and a reader falls back to the id (mantahostels#1924).
 *
 * WHY NOT `listedSessionIds` (mantahostels#710). The issue-claim prune's only wiring is a
 * SessionStart hook, where the starting session is not yet registered, so the
 * strict reader refused on every single run. Only a SessionStart caller earns
 * it: one running mid-session is listed, so the waiver can only cost it (#1390).
 *
 * WHY NOT the reaper's bare waiver. A prune's judgement IS an absence — a
 * session missing from the list gets its claim deleted — which is exactly the
 * reader the self-test exists for.
 *
 * RESIDUAL: a session that is live, missing from a short list for some reason
 * other than being this caller, and stale in the sessions registry is still
 * swept. The prune spares on the union of both oracles, so the registry covers
 * a session it can still resolve; this is the gap where neither can.
 *
 * THAT COSTS A READER'S ANSWER, NOT MERELY A RECORD: selection excludes only
 * where a live-backed claim exists, so a deleted claim puts the issue back in
 * the shortlist while its session works on — a deliberate fail-open (.claude/skills/pick-next/SKILL.md).
 *
 * @param {Opts} [opts]
 * @returns {{ids: Set<string>, names: Map<string, string>, finished: Set<string>, terminal: Set<string>, cwds: Map<string, string>, why?: undefined}
 *   | {why: string, ids?: undefined, names?: undefined, finished?: undefined, terminal?: undefined, cwds?: undefined}}
 */
function sweepSessionIds(opts) {
	return refuseOnThrow(opts, false, (listed) => {
		if (listed.why) return { why: listed.why };
		if (!listed.agents)
			throw new TypeError("answered with neither agents nor a why");
		const ids = new Set(listed.agents.map((a) => a.sessionId));
		/** @type {Map<string, string>} */
		const names = new Map();
		for (const a of listed.agents) if (a.name) names.set(a.sessionId, a.name);
		const me = process.env.CLAUDE_CODE_SESSION_ID;
		if (me) ids.add(me);
		// `me` is added to `ids` only, never to `finished` or `terminal`: this
		// caller is running.
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
	capMs,
	claudeBin,
	isFinishedAgent,
	isListedLive,
	isTerminalAgent,
	listedAgents,
	readAgentsAfterBoot,
	readAgentsForBudget,
	readAgentsForDisplay,
	readEverySeat,
	listedSessionIds,
	admissionSessionIds,
	oracleCacheKey,
	readSeatListing,
	sharedSessionIds,
	sweepSessionIds,
	TERMINAL_STATES,
};
