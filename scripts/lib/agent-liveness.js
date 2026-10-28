/*
 * agent-liveness.js — the one reader of `claude agents --json`, the only
 * documented interface that says which sessions are live (mantahostels#318 fixed it as the
 * oracle). The finished-session reaper and the refill loop's never-started
 * stop read lib/registry-agents.js instead, which needs no CLI (#2665).
 *
 * THIS HEADER OWNS THE ~465 ms FIGURE, and every other statement of it in
 * `scripts/` restates this line. Measured at mantahostels#317, written up in
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-liveness-oracle.md. A site citing **mantahostels#411 cites the BAR the
 * figure justifies**, never the measurement.
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
 * No caller, waived or not, is ever offered an AGED cache hit
 * (mantahostels#1960): a cached success can be served back across a daemon
 * failure in between (mantahostels#1946).
 * Single-flight (`readListing`, below) still serves
 * concurrent readers — `npm run status`'s more than a start's (#1446).
 * The self-test protects a reader whose judgement IS an absence — a session
 * missing from a short list reads dead. A reader that acts only on fields
 * present in a record can merely act less on a short list; and at
 * SessionStart the starting session is not yet registered, so the test was a
 * false positive on every run (mantahostels#535). Opt-in, never a new
 * default: mantahostels#535 rejected the fail-open variant where the list carries a caveat
 * every caller must remember to check. The mutations proving the wiring are
 * recorded at mantahostels#540.
 *
 * The second, `admissionSessionIds`, reads an empty listing as nothing live,
 * outside a session only, where nothing says the list must name anyone
 * (#2180). Inside a session an empty list is still a fault. It is its own
 * export, never an option, so no reader judging by absence can pass it.
 *
 * EVERY LISTING CARRIES THE LIVE HEADLESS RUNS (lib/headless-sessions.js,
 * #2608), which the oracle cannot see: `claude -p` on an overflow seat has no
 * daemon job. They are merged on every read and never cached, and the
 * self-test finds a headless caller among them. A store that will not read
 * is a `why`, as an oracle fault is, read before the oracle so no
 * single-flight follower spawns on one.
 *
 * RESIDUAL: inside a headless run an empty daemon listing is taken as
 * complete, since an overflow-only machine lists no daemon session. A daemon
 * fault answering `[]` there (#2180) reads as no background session live.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const cache = require("./oracle-cache");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { caught } = require("./caught.js");
const { claudeBin } = require("./claude-bin.js");
const headless = require("./headless-sessions.js");

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
 * `kind: "headless"` marks a run lib/headless-sessions.js listed, which
 * `claude stop` cannot reach.
 *
 * @typedef {{sessionId: string, id?: string, name?: string, pid?: number,
 *   kind?: string, state?: string, status?: string, tempo?: string,
 *   startedAt?: number, cwd?: string}} AgentRecord
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
 * @typedef {{read?: (o: {requireSelf: unknown, allowEmpty?: boolean}) => any,
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
 * when the machine is busiest and a finished-session reap is worth the most
 * memory; the reaper then refuses, and gigabytes sit in finished
 * sessions until some later start catches a quiet moment. A timeout there says
 * "queued behind load", not "wedged". The retry gets a LONGER cap, so a second
 * timeout is the wedge signal the first cap was meant to be. Every other
 * failure — ENOENT, a non-zero exit — is deterministic, and retrying it only
 * doubles the wait before the same refusal.
 *
 * Both caps are overridable so the suite can drive them to milliseconds.
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

/* Runs the oracle in its own process group, so a capped read kills the union
 * wrapper's per-seat children too, not the wrapper alone (#2665). */
const RUN_GROUPED = path.join(__dirname, "run-grouped.js");

/**
 * One oracle call, capped. Separate so the retry cannot drift from the first
 * attempt in anything but its ceiling, and exported so every other caller of
 * the oracle kills the same group on its cap.
 *
 * @param {string} bin
 * @param {number} timeoutMs
 * @param {NodeJS.ProcessEnv} [env]  the oracle's environment, else this process's
 * @returns {string}
 */
function runOracle(bin, timeoutMs, env) {
	try {
		return execFileSync(
			process.execPath,
			[RUN_GROUPED, bin, "agents", "--json"],
			{
				env,
				encoding: "utf8",
				timeout: timeoutMs,
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: CHILD_MAX_BUFFER,
			},
		);
	} catch (e) {
		/* A binary that would not start is named by its spawn code, as a
		 * direct spawn names it; run-grouped.js prints only that code. */
		const { status, stderr, code } = caught(e);
		const spawnCode = String(stderr ?? "").trim();
		if (!code && status === 127 && /^E[A-Z]+$/.test(spawnCode))
			throw Object.assign(new Error(spawnCode), { code: spawnCode });
		throw e;
	}
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
 * Runs the oracle and classifies what it said, as `{agents}` or `{why}`.
 *
 * The whole record, not just the id: a reader deciding whether a session is
 * FINISHED rather than merely live needs `state`, `status` and `kind` too
 * (mantahostels#421, the finished-session pool).
 *
 * @param {Opts} [opts]
 * @returns {Listing}
 */
function readListing(opts) {
	const bin = claudeBin();
	const call = oracleCall();
	const runs = readHeadlessRuns();
	if ("why" in runs) return runs;

	/* NO PLAIN CACHE HIT HERE (mantahostels#1960, module header above). Single-
	 * flight only: lead and spawn, or follow and take what the leader publishes
	 * — three readers launched at one instant otherwise pay three spawns of the
	 * same binary (mantahostels#1921, #1446). A follower given nothing usable falls through
	 * and spawns its own. */
	const leading = cache.acquire(bin);
	if (!leading) {
		const followed = cache.waitForLeader(bin);
		if (followed !== null) {
			const answer = classifyRaw(followed, call, opts, runs.agents);
			if (!answer.why) return answer;
		}
	}

	let raw;
	try {
		try {
			raw = runOracle(bin, oracleTimeoutMs());
		} catch (e) {
			const err = caught(e);
			if (err.code !== "ETIMEDOUT")
				return {
					why: `${call} would not run (${failure(e)})`,
				};
			// Exactly one retry: a second timeout is the wedge the cap exists for, and
			// a loop here would wedge the SessionStart hook the cap protects.
			const retryMs = oracleRetryTimeoutMs();
			try {
				raw = runOracle(bin, retryMs);
			} catch (again) {
				return {
					why: `${call} would not run (${failure(again)}) — twice, the retry given ${retryMs} ms`,
				};
			}
		}
		/* PUBLISHED BEFORE THE LOCK IS DROPPED.
		 * A follower treats "no record and no lock" as a leader that died, and
		 * spawns; releasing first opens exactly that window on the happy path, so
		 * the spawn this saves would be given straight back. */
		cache.write(bin, raw);
	} finally {
		/* On every exit including the two refusals: a follower must not be held
		 * past the spawn it is waiting for. */
		if (leading) cache.release(bin);
	}

	return classifyRaw(raw, call, opts, runs.agents);
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
	let agents;
	try {
		agents = JSON.parse(raw);
	} catch {
		return { why: `${call} did not return JSON` };
	}
	if (!Array.isArray(agents))
		return { why: `${call} returned ${typeof agents}, not the expected array` };
	return mergedListing(agents, headlessAgents, call, opts);
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
	for (const a of agents)
		if (a && typeof a.sessionId === "string" && a.sessionId)
			ids.add(a.sessionId);
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
			...agents.filter(
				(a) => a && typeof a.sessionId === "string" && a.sessionId,
			),
			...headlessAgents,
		],
	};
}

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
 * The net under every guard above: an unexpected throw becomes a refusal.
 *
 * `read` is a seam for the suite alone, and it arrives in an options object
 * rather than positionally because both exports are passed around as bare
 * function values — `store.forceRelease(rel, me, listedSessionIds)` — where a
 * stray positional argument would silently stand in for the oracle itself.
 *
 * @template T
 * @param {Opts|undefined} opts
 * @param {unknown} requireSelf
 * @param {(listed: Listing) => T} answer
 * @param {boolean} [allowEmpty]
 * @returns {T | {why: string}}
 */
function refuseOnThrow(opts, requireSelf, answer, allowEmpty = false) {
	const read = opts?.read || readListing;
	try {
		return answer(read({ requireSelf, allowEmpty }));
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
	return refuseOnThrow(opts, opts?.requireSelf, (listed) => {
		// The identity would hand a reader's own answer back unchecked.
		if (listed && (listed.why || listed.agents)) return listed;
		throw new TypeError("answered with neither agents nor a why");
	});
}

/**
 * Whether an oracle record is a background session that has FINISHED and not
 * exited — the reaper's gate 1.
 *
 * `status` IS DELIBERATELY NOT READ (mantahostels#768, https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md): a `shell` session
 * emits `state: done` with `status: busy`, so reading `status` drops finished
 * sessions.
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
 * TERMINAL STATE (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md §F1).
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
	return sessionIdsOf(opts, false);
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
	return sessionIdsOf(opts, true);
}

/**
 * @param {Opts | undefined} opts
 * @param {boolean} allowEmpty
 * @returns {ListedSessions}
 */
function sessionIdsOf(opts, allowEmpty) {
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
				/* Only `admissionSessionIds` lets an empty listing through, taken
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
				 * Off this SAME oracle read, so a caller pricing the daemon+spare
				 * overhead (`daemonSpareOverheadMb`) can build its live-pid set without
				 * a second `claude agents --json` spawn (mantahostels#1295, additive to the shape
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
		allowEmpty,
	);
}

/**
 * The session ids for a SWEEP: the oracle's list with this caller's own id
 * added back, as `{ids}`, with `names` mapping each listed id to its display
 * name, `finished` holding the subset that has FINISHED but is still
 * resident, mirroring `listedSessionIds`'s field (mantahostels#2765), and `terminal`
 * holding the wider subset that has stopped working HOWEVER it ended (mantahostels#2774) —
 * or `{why}`, the sentence explaining why nothing can be said.
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
 * @returns {{ids: Set<string>, names: Map<string, string>, finished: Set<string>, terminal: Set<string>, why?: undefined}
 *   | {why: string, ids?: undefined, names?: undefined, finished?: undefined, terminal?: undefined}}
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
		return { ids, names, finished, terminal };
	});
}

module.exports = {
	capMs,
	claudeBin,
	isFinishedAgent,
	isListedLive,
	isTerminalAgent,
	listedAgents,
	listedSessionIds,
	admissionSessionIds,
	runOracle,
	sweepSessionIds,
	TERMINAL_STATES,
};
