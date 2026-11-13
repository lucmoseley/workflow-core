/*
 * rescue-probe.js — the core of `rescue-sessions.js probe` (#620, #5157):
 * whether one named session is frozen, off two samples of the oracle, its
 * transcripts, its job record and its process tree.
 *
 * The oracle, the clock's sleep, `gh` and /proc arrive as RescuePorts
 * (lib/rescue-jobs.js), so a module case samples a fake and waits no real
 * interval. Takeover samples through `sampleHolder` too.
 */

const fs = require("node:fs");
const path = require("node:path");
const { isTerminalAgent, listedAgents } = require("./agent-liveness");
const { caught } = require("./caught.js");
const { readOwnJob } = require("./claude-stop.js");
const { readTail } = require("./file-read.js");
const { readJobRecord, shortJobId } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { FIELD, readStatFields } = require("./proc-stat.js");
const {
	LIMIT_MESSAGE,
	STUCK_STATES,
	die,
	readJobs,
} = require("./rescue-jobs.js");
const { bufferedIo, collectIo } = require("./tracker-ops.js");
const { trimEndRun } = require("./trim-run.js");

/** @typedef {import("./rescue-jobs.js").ParsedArgs} ParsedArgs */
/** @typedef {import("./rescue-jobs.js").RescuePorts} RescuePorts */
/** @typedef {import("./rescue-jobs.js").Outcome} Outcome */
/** @typedef {import("./rescue-jobs.js").Job} Job */
/** @typedef {import("./rescue-jobs.js").ContentBlock} ContentBlock */
/** @typedef {import("./rescue-jobs.js").TranscriptRecord} TranscriptRecord */
/** @typedef {import("./tracker-ops.js").BufferedIo} BufferedIo */
/** @typedef {import("./gh.js").GhRun} GhRun */

/*
 * The probe's thresholds (#620). EACH IS A GUESS UNTIL MEASURED — no wrong
 * verdict has been traced to one yet, and the first that is should move it.
 *
 * The interval is the watch cadence docs/agents/guard-registry.md §Subagent dispatch uses. The CPU
 * floor is what a non-helper descendant must spend between samples to read as
 * working. The session's own CPU is left out: idle, it passes any floor
 * (#620). The helper
 * patterns name the children that live for the whole session and tick whether
 * or not a turn is running, matched on argv; a helper's own children are
 * excluded with it. No live session here had one to match against.
 */
const PROBE_INTERVAL_S = 120;
const PROBE_CPU_FLOOR_S = 0.5;
const HELPER_ARGV = [
	/mcp-server/i,
	/@modelcontextprotocol\//,
	/language-server|tsserver/i,
];

/*
 * ── probe: is one named session frozen? (#620, spec #617) ──────────────────
 *
 * Read-only. Two samples PROBE_INTERVAL_S apart, then one verdict, first
 * match winning — except GHOST, read off the first sample alone (#1989):
 *
 *   GHOST    9  its job record reads "working", no plan lists a process for
 *               it, and it never wrote a transcript, past the grace window —
 *               lib/hung-jobs.js's GHOST-JOB test
 *   UNKNOWN  3  the oracle, the transcript or /proc would not read at either
 *               sample — doubt never reads as frozen
 *   ENDED    4  listed by no plan, or listed in a terminal state
 *   LIMITED 10  oracle state blocked, its job record's detail a session,
 *               weekly or model limit message — stuck until a typed message
 *               after the reset (#2158, #2380)
 *   ASKING   5  oracle state needs_input/blocked, or the turn ended on
 *               `needs input:`
 *   DONE     6  the turn ended on `result:` with nothing in flight
 *   SLOW     7  a transcript changed size, `inFlight` shows work, or a
 *               non-helper descendant spent PROBE_CPU_FLOOR_S of CPU
 *   FROZEN   8  none of the above — a turn ended on `waiting:` with nothing
 *               left running lands here, the lost wake
 *   (bad invocation or nothing to probe: 2, on stderr)
 *
 * SIZE, NOT MTIME, as watch-artefact.js: a touch without an append is not
 * progress, and a size that falls is a rewrite, which is.
 */

const PROBE_EXIT = {
	UNKNOWN: 3,
	ENDED: 4,
	ASKING: 5,
	DONE: 6,
	SLOW: 7,
	FROZEN: 8,
	GHOST: 9,
	LIMITED: 10,
};

/* The unit of /proc/<pid>/stat's CPU fields: USER_HZ, which Linux fixes at
 * 100 whatever the kernel's own tick rate (`getconf CLK_TCK`). */
const CLK_TCK = 100;

/* How much of a transcript's tail is read for its last turn. A guess: room
 * for one long final message and the tool results before it. */
const TAIL_BYTES = 512 * 1024;

/**
 * @typedef {import("./agent-liveness").AgentRecord} AgentRecord
 * @typedef {import("./agent-liveness").Listing} Listing
 * @typedef {{pid: number, ppid: number, start: string, ticks: number, argv: string}} ProcRow
 * @typedef {{
 *   holder: {dir: string | null, row: AgentRecord} | null,
 *   unread: string | null,
 *   transcript: string | null,
 *   size: number | null,
 *   subs: Map<string, number>,
 *   inFlight: {tasks: number, queued: number} | null,
 *   limit: string | null,
 *   tree: {self: number, kids: Map<string, ProcRow>, helpers: number} | null | undefined,
 *   marker: string,
 * }} ProbeSample
 */

/**
 * Whether `sessionId` names `id` — the full id, or its 8-character short form.
 * @param {string} sessionId
 * @param {string} id
 */
const idMatches = (sessionId, id) =>
	sessionId === id || (id.length === 8 && sessionId.startsWith(id));

/**
 * The holder's row, or null with why the listing would not read.
 *
 * @param {Listing} listing
 * @param {string} sessionId
 */
function findHolder(listing, sessionId) {
	const row = listing.agents?.find((a) => a.sessionId === sessionId);
	return { row: row ?? null, unread: listing.why ?? null };
}

/**
 * The main transcript's path: the job's `linkScanPath` where its state reads
 * and names this session, else `<dir>/projects/<any>/<sessionId>.jsonl`. Null
 * where neither exists.
 * @param {string} dir
 * @param {string} sessionId
 */
function readTranscriptOf(dir, sessionId) {
	const linked = readOwnJob(sessionId, { seats: [dir] })?.job.linkScanPath;
	if (typeof linked === "string" && fs.existsSync(linked)) return linked;
	let projects;
	try {
		projects = fs.readdirSync(path.join(dir, "projects"));
	} catch {
		return null;
	}
	for (const p of projects) {
		const f = path.join(dir, "projects", p, `${sessionId}.jsonl`);
		if (fs.existsSync(f)) return f;
	}
	return null;
}

/**
 * Every subagent transcript's size, from the `.jsonl` files under the
 * session's own `<sessionId>/` directory beside its main transcript.
 * @param {string} mainTranscript
 * @param {string} sessionId
 */
function subagentSizes(mainTranscript, sessionId) {
	/** @type {Map<string, number>} */
	const out = new Map();
	/** @param {string} d */
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) {
				try {
					out.set(p, fs.statSync(p).size);
				} catch {
					// Deleted since the listing: absent from this sample, as it now is.
				}
			}
		}
	};
	walk(path.join(path.dirname(mainTranscript), sessionId));
	return out;
}

/**
 * The status marker the session's last turn ended on — `needs input:`,
 * `result:`, `waiting:` — or where the turn has not ended, "tool call", its last
 * assistant entry being one, or "prompt", a user prompt after it going
 * unanswered. "" where it ended on no marker.
 * @param {string} transcript
 */
function readLastTurnMarker(transcript) {
	const { governingMarker } = require("./status-marker");
	const tail = readTail(transcript, TAIL_BYTES);
	// takeSample has already stat'd it, so an unreadable transcript is UNKNOWN there.
	if (tail.state !== "read") return "";
	for (const j of /** @type {TranscriptRecord[]} */ (
		parseJsonl(tail.data.text).rows
	).reverse()) {
		if (isUserPrompt(j)) return "prompt";
		if (j.type !== "assistant" || !Array.isArray(j.message?.content)) continue;
		/** @type {ContentBlock[]} */
		const content = j.message.content;
		if (content.some((c) => c.type === "tool_use")) return "tool call";
		const said = content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		return governingMarker(said).name;
	}
	return "";
}

/**
 * A transcript entry that is a person's prompt — not a tool result, and not an
 * injected `<system-reminder>` or hook payload, which open with a tag.
 * @param {TranscriptRecord} j
 */
function isUserPrompt(j) {
	if (j.type !== "user") return false;
	const c = j.message?.content;
	if (typeof c === "string") return !c.startsWith("<");
	return (
		Array.isArray(c) &&
		c.some((b) => b.type === "text" && !String(b.text ?? "").startsWith("<"))
	);
}

/**
 * `/proc/<pid>/stat`'s parent, CPU ticks and start time.
 * @param {string[] | null} f the line's fields
 */
function parseProcStat(f) {
	if (!f) return null;
	const ppid = Number(f[FIELD.ppid]);
	const ticks = Number(f[FIELD.utime]) + Number(f[FIELD.stime]);
	if (!Number.isFinite(ppid) || !Number.isFinite(ticks)) return null;
	return { ppid, ticks, start: f[FIELD.start] ?? "" };
}

/**
 * The CPU ticks of `pid` and of each of its descendants, keyed `pid:start` so
 * a reused pid is a new process — a HELPER_ARGV match and its whole subtree
 * left out and only counted. Null where /proc or `pid` itself will not read.
 * @param {number} pid
 * @param {string} root  /proc, or the fake a module case points it at
 */
function readProcTree(pid, root) {
	let entries;
	try {
		entries = fs.readdirSync(root).filter((e) => /^\d+$/.test(e));
	} catch {
		return null;
	}
	/** @type {Map<number, ProcRow[]>} */
	const children = new Map();
	/** @type {ProcRow | null} */
	let self = null;
	for (const e of entries) {
		const row = readProcRow(root, e);
		if (!row) continue;
		if (row.pid === pid) self = row;
		const siblings = children.get(row.ppid) ?? [];
		siblings.push(row);
		children.set(row.ppid, siblings);
	}
	if (!self) return null;
	const { kids, helpers } = descendantsOf(children, pid);
	return { self: self.ticks, kids, helpers };
}

/**
 * One /proc entry as a row, or null where it exited between the listing and
 * the read or its stat will not parse.
 * @param {string} root
 * @param {string} e
 * @returns {ProcRow | null}
 */
function readProcRow(root, e) {
	/* Unread where it exited between the listing and the read. */
	const parsed = parseProcStat(readStatFields(e, root));
	if (!parsed) return null;
	return { pid: Number(e), argv: readProcArgv(root, e), ...parsed };
}

/**
 * @param {string} root
 * @param {string} e
 */
function readProcArgv(root, e) {
	try {
		return trimEndRun(
			fs.readFileSync(path.join(root, e, "cmdline"), "utf8"),
			"\0",
		)
			.split("\0")
			.join(" ");
	} catch {
		// Exited after its stat read: an empty argv matches no helper, so its CPU counts.
		return "";
	}
}

/**
 * @param {Map<number, ProcRow[]>} children
 * @param {number} pid
 */
function descendantsOf(children, pid) {
	/** @type {Map<string, ProcRow>} */
	const kids = new Map();
	let helpers = 0;
	const stack = [pid];
	while (stack.length > 0) {
		const parent = /** @type {number} */ (stack.pop());
		for (const k of children.get(parent) ?? []) {
			if (k.pid === pid || kids.has(`${k.pid}:${k.start}`)) continue;
			if (HELPER_ARGV.some((re) => re.test(k.argv))) {
				helpers++;
				continue;
			}
			kids.set(`${k.pid}:${k.start}`, k);
			stack.push(k.pid);
		}
	}
	return { kids, helpers };
}

/**
 * A live holder's process tree, or null where its row records no pid.
 * @param {AgentRecord} row
 * @param {string} root
 */
function readLiveProcTree(row, root) {
	return row.pid ? readProcTree(row.pid, root) : null;
}

/**
 * One sample of everything the verdict reads, off a listing already taken.
 * /proc is read only for a holder that is listed and not terminal: an ended
 * session's pid proves nothing either way.
 *
 * @param {Listing} listing
 * @param {string[]} dirs
 * @param {string} sessionId
 * @param {string} root  /proc
 * @returns {ProbeSample}
 */
function takeSample(listing, dirs, sessionId, root) {
	const { row, unread } = findHolder(listing, sessionId);
	const records = readSessionRecords(dirs, sessionId);
	const holder = row && { dir: records?.dir ?? null, row };
	const transcript = records?.transcript ?? null;
	const live = holder && !isTerminalAgent(holder.row) ? holder.row : null;
	return {
		holder,
		unread,
		transcript,
		size: readTranscriptSize(transcript),
		subs: transcript ? subagentSizes(transcript, sessionId) : new Map(),
		inFlight: inFlightOf(records?.state),
		limit: limitOf(records?.state),
		tree: live ? readLiveProcTree(live, root) : undefined,
		marker: transcript ? readLastTurnMarker(transcript) : "",
	};
}

/**
 * The plan holding the session's transcript, with its job record where that
 * record names the session.
 *
 * The listing names no plan (#3512), so the session's own is the plan
 * holding its transcript, and where two do, the one whose job record names
 * it — a record under the same short id may be another session's (#1146).
 *
 * @param {string[]} dirs
 * @param {string} sessionId
 */
function readSessionRecords(dirs, sessionId) {
	/** @type {{dir: string, transcript: string, state: any} | null} */
	let records = null;
	for (const d of dirs) {
		const transcript = readTranscriptOf(d, sessionId);
		if (!transcript) continue;
		const state = readOwnJob(sessionId, { seats: [d] })?.job ?? null;
		if (state || !records) records = { dir: d, transcript, state };
		if (state) break;
	}
	return records;
}

/**
 * The transcript's size, or null where there is none or it will not stat —
 * which probeVerdict reads as UNKNOWN.
 * @param {string | null} transcript
 */
function readTranscriptSize(transcript) {
	if (!transcript) return null;
	try {
		return fs.statSync(transcript).size;
	} catch {
		return null;
	}
}

/**
 * The job record's in-flight counts, or null where it carries none.
 * @param {any} state the job record's `state`, read off disk unvalidated —
 *   `any` as the probe's record type gives it; every field is coerced here
 */
function inFlightOf(state) {
	const f = state?.inFlight;
	return f && typeof f === "object"
		? { tasks: Number(f.tasks) || 0, queued: Number(f.queued) || 0 }
		: null;
}

/**
 * The job record's limit message, or null where its detail is anything else.
 * @param {any} state the job record's `state`, as inFlightOf's
 */
function limitOf(state) {
	const detail = typeof state?.detail === "string" ? state.detail : "";
	return LIMIT_MESSAGE.test(detail) ? detail : null;
}

/** @typedef {Exclude<keyof typeof PROBE_EXIT, "GHOST">} SampledVerdict */

/**
 * The verdict two samples make, with the evidence lines behind it. First
 * match wins, in the order of the table above.
 *
 * @param {ProbeSample} before
 * @param {ProbeSample} after
 * @returns {{verdict: SampledVerdict, why: string, evidence: string[]}}
 */
function probeVerdict(before, after) {
	const measured = probeEvidence(before, after);
	const { evidence } = measured;
	const row = after.holder?.row;

	/** @param {SampledVerdict} verdict @param {string} why */
	const say = (verdict, why) => ({ verdict, why, evidence });

	const unreadable = [before, after].flatMap((s, i) =>
		unreadableInputs(s, i ? "second sample" : "first sample"),
	);
	if (unreadable.length > 0) return say("UNKNOWN", unreadable.join("; "));

	if (!row) return say("ENDED", "listed by no plan");
	if (isTerminalAgent(row))
		return say("ENDED", `oracle lists it terminal (${row.state})`);

	if (row.state === "blocked" && after.limit)
		return say("LIMITED", `oracle state blocked on its limit: ${after.limit}`);
	if (row.state === "needs_input" || row.state === "blocked")
		return say("ASKING", `oracle state ${row.state}`);
	if (after.marker === "needs input:")
		return say("ASKING", "its last turn ended on needs input:");

	const inFlight = Boolean(
		after.inFlight && (after.inFlight.tasks || after.inFlight.queued),
	);
	if (after.marker === "result:" && !inFlight)
		return say("DONE", "its last turn ended on result:, nothing in flight");

	const slow = slowWhy(before, after, measured, inFlight);
	if (slow) return say("SLOW", slow);

	return say(
		"FROZEN",
		after.marker === "waiting:"
			? "turn ended on waiting: with nothing left running (lost wake)"
			: "nothing grew, nothing in flight, no descendant CPU",
	);
}

/**
 * Why a listed, live session that is neither asking nor done reads SLOW, or
 * null where nothing moved between the samples.
 *
 * @param {ProbeSample} before
 * @param {ProbeSample} after
 * @param {{grownSubs: Array<[string, number]>, busy: number}} measured
 * @param {boolean} inFlight
 */
function slowWhy(before, after, { grownSubs, busy }, inFlight) {
	if (before.size !== after.size) return "the main transcript changed size";
	const newSubs = [...after.subs.keys()].filter((p) => !before.subs.has(p));
	if (grownSubs.length > 0 || newSubs.length > 0)
		return "a subagent transcript changed size";
	if (inFlight) return "state.json shows work in flight";
	if (busy / CLK_TCK >= PROBE_CPU_FLOOR_S)
		return "a descendant process spent CPU";
	return null;
}

/**
 * The inputs one sample could not read, each as an evidence clause.
 * @param {ProbeSample} s
 * @param {string} at
 */
function unreadableInputs(s, at) {
	const out = [];
	if (s.unread) out.push(`${at}: the listing would not read: ${s.unread}`);
	if (s.size === null) out.push(`${at}: transcript would not read`);
	if (s.tree === null)
		out.push(`${at}: /proc would not read for the session's process`);
	return out;
}

/** `, on plan <dir>`, or nothing where no plan holds the session's records. */
const onPlan = (/** @type {string | null | undefined} */ dir) =>
	dir ? `, on plan ${dir}` : "";

/**
 * The evidence lines two samples give, with the subagent transcripts that
 * grew and the descendants' CPU ticks the verdict reads.
 *
 * @param {ProbeSample} before
 * @param {ProbeSample} after
 */
function probeEvidence(before, after) {
	/** @type {string[]} */
	const evidence = [];
	const row = after.holder?.row;
	evidence.push(
		row
			? `oracle: state ${row.state ?? "?"}, kind ${row.kind ?? "?"}, pid ${row.pid ?? "?"}${onPlan(after.holder?.dir)}`
			: "oracle: listed by no plan",
	);
	evidence.push(
		after.transcript
			? `transcript: ${after.transcript} ${before.size ?? "?"}B -> ${after.size ?? "?"}B`
			: "transcript: none found",
	);
	const grownSubs = [...after.subs].filter(
		([p, n]) => before.subs.get(p) !== n,
	);
	evidence.push(
		`subagents: ${after.subs.size} transcript(s), ${grownSubs.length} changed size`,
	);
	evidence.push(
		after.inFlight
			? `in flight: ${after.inFlight.tasks} task(s), ${after.inFlight.queued} queued (state.json)`
			: "in flight: state.json unread",
	);
	let busy = 0;
	if (before.tree && after.tree) {
		for (const [key, k] of after.tree.kids)
			busy += k.ticks - (before.tree.kids.get(key)?.ticks ?? 0);
		evidence.push(
			`cpu: session +${((after.tree.self - before.tree.self) / CLK_TCK).toFixed(2)}s, descendants +${(busy / CLK_TCK).toFixed(2)}s (${after.tree.helpers} helper(s) excluded, floor ${PROBE_CPU_FLOOR_S}s)`,
		);
	}
	const turn = {
		"tool call": "still open on a tool call",
		prompt: "a user prompt after it is unanswered",
		"": "ended on no marker",
	}[after.marker];
	evidence.push(`last turn: ${turn ?? `ended on ${after.marker}`}`);
	return { evidence, grownSubs, busy };
}

/**
 * The session `--issue`/`--session` names, as its full id — or a refusal.
 *
 * @param {ParsedArgs} args
 * @param {string[]} dirs
 * @param {Listing} listing
 * @param {{cmd: string, ports: RescuePorts}} how  `cmd`, the verb a refusal
 *   names: "probe" or "take over"
 * @returns {{sessionId: string, issue: number | null} | {refuse: string}}
 */
function resolveHolder(args, dirs, listing, { cmd, ports }) {
	const me = ports.env.CLAUDE_CODE_SESSION_ID || "";
	const issue = args.issue === undefined ? null : Number(args.issue);
	if (issue !== null && !(Number.isInteger(issue) && issue > 0))
		return { refuse: "--issue takes an issue number" };

	if (typeof args.session !== "string" || !args.session)
		return holderOfIssue(issue, me, cmd, dirs);

	const id = args.session;
	const { full, held } = readSessionsMatching(id, dirs, listing);
	const [sessionId, ...others] = full;
	if (sessionId === undefined)
		return {
			refuse: `no plan, job record, transcript or claim knows a session ${id} — check the id, or ask the founder which session they meant`,
		};
	if (others.length > 0)
		return {
			refuse: `${id} matches ${full.size} sessions — give the full id: ${[...full].join(", ")}`,
		};
	if (sessionId === me)
		return { refuse: `${id} is this session — check the id you were given` };
	if (issue !== null && !held.has(issue))
		return {
			refuse: `${id} holds no claim on #${issue} — check the number, or drop --issue to take the ticket it does hold`,
		};
	if (issue === null && held.size > 1)
		return onlyOpenClaim(id, sessionId, held, { cmd, gh: ports.gh });
	const [heldIssue] = held;
	return { sessionId, issue: issue ?? heldIssue ?? null };
}

/**
 * The one other session holding a claim on `issue` — or, where none does, the
 * one other job whose intent names it (#1989). Else a refusal.
 * @param {number | null} issue
 * @param {string} me
 * @param {string} cmd
 * @param {string[]} dirs
 * @returns {{sessionId: string, issue: number} | {refuse: string}}
 */
function holderOfIssue(issue, me, cmd, dirs) {
	const claims = require("./arbiter-issue-claims");
	if (issue === null)
		return { refuse: `${cmd} needs --issue <n> or --session <id>` };
	const claimed = claims
		.readIssueClaims(issue)
		.map((e) => e.record?.sessionId ?? "")
		.filter((s) => s && s !== me);
	const holders = claimed.length > 0 ? claimed : jobsNaming(issue, me, dirs);
	const [holder, ...others] = holders;
	if (holder === undefined)
		return {
			refuse: `nothing to ${cmd}: no other session holds a claim on #${issue}, and no ${[...STUCK_STATES].join("/")} job's intent names it — name the session with --session, or claim the ticket with claim-issue.js`,
		};
	if (others.length > 0)
		return {
			refuse: `#${issue} has ${holders.length} holders — name one with --session: ${holders.join(", ")}`,
		};
	return { sessionId: holder, issue };
}

/* A launch intent's command and the issue list straight after it, so
 * `/implement 1878 — RESUMED from session 3` names 1878 and not 3. */
const INTENT_ISSUES = /^\/[\w:-]+\s+([#\d\s,]+)/;

/**
 * The session ids of every job on `dirs`, other than this one, still in a
 * STUCK_STATES state and whose intent names `issue`.
 * @param {number} issue
 * @param {string} me
 * @param {string[]} dirs
 */
function jobsNaming(issue, me, dirs) {
	const { issuesIn } = require("./dispatch-ledger");
	/** @type {Set<string>} */
	const out = new Set();
	for (const j of dirs.flatMap(readJobsOn)) {
		if (!STUCK_STATES.has(j.state) || !j.sessionId || j.sessionId === me)
			continue;
		const named = j.intent.match(INTENT_ISSUES)?.[0] ?? "";
		if (issuesIn(named).includes(issue)) out.add(j.sessionId);
	}
	return [...out];
}

/**
 * Every job on plan `dir`: none where it has no jobs/ (#1989). Any other
 * failure to read is doubt, and throws.
 * @param {string} dir
 * @returns {Job[]}
 */
function readJobsOn(dir) {
	try {
		return readJobs(dir).jobs;
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw e;
	}
}

/**
 * Every full session id `id` widens to — off the issue-claim store, each
 * plan's job records and transcripts, and the listing, in that order — with
 * the issues the matching claims hold.
 * @param {string} id
 * @param {string[]} dirs
 * @param {Listing} listing
 */
function readSessionsMatching(id, dirs, listing) {
	const claims = require("./arbiter-issue-claims");
	/** @type {Set<string>} */
	const full = new Set();
	const listed = claims.listIssueClaims();
	/** @type {Set<number>} */
	const held = new Set();
	for (const c of listed?.claims ?? []) {
		if (!c.sessionId || !idMatches(c.sessionId, id)) continue;
		full.add(c.sessionId);
		held.add(c.issue);
	}
	for (const d of dirs) {
		const s = readJobRecord(d, shortJobId(id))?.sessionId;
		if (typeof s === "string" && idMatches(s, id)) full.add(s);
		if (id.length !== 8 && readTranscriptOf(d, id)) full.add(id);
	}
	addListedMatches(full, id, listing);
	return { full, held };
}

/**
 * @param {Set<string>} full accumulator: each listed session id matching `id` is added
 * @param {string} id
 * @param {Listing} listing
 */
function addListedMatches(full, id, listing) {
	for (const agent of listing.agents ?? [])
		if (idMatches(agent.sessionId, id)) full.add(agent.sessionId);
}

/**
 * The one open ticket among the several `sessionId` holds claims on — or a
 * refusal naming them.
 * @param {string} id  the id as given
 * @param {string} sessionId
 * @param {Set<number>} held
 * @param {{cmd: string, gh: GhRun}} how
 * @returns {{sessionId: string, issue: number} | {refuse: string}}
 */
function onlyOpenClaim(id, sessionId, held, { cmd, gh }) {
	const tickets = [...held].map((n) => `#${n}`).join(", ");
	const read = openIssues([...held], gh);
	if ("why" in read)
		return {
			refuse: `${id} holds claims on ${tickets} (the tracker would not read to rule out closed ones: ${read.why}) — name one with --issue`,
		};
	const [onlyOpen, ...moreOpen] = read.open;
	if (onlyOpen === undefined)
		return {
			refuse: `${id} holds claims only on closed tickets (${tickets}) — nothing to ${cmd}. Check the ticket number with the founder; a stale claim on a closed ticket blocks no open work.`,
		};
	if (moreOpen.length === 0) return { sessionId, issue: onlyOpen };
	const closed = [...held].filter((n) => !read.open.includes(n));
	const note =
		closed.length > 0
			? ` (${closed.map((n) => `#${n}`).join(", ")} closed)`
			: "";
	return {
		refuse: `${id} holds claims on ${tickets}${note} — name one with --issue`,
	};
}

/**
 * Which of `issues` the tracker reads as open (#648): a closed ticket's claim
 * is stale, and never the one a takeover adopts. Where any read fails, why —
 * doubt never picks a ticket.
 * @param {number[]} issues
 * @param {GhRun} gh
 * @returns {{open: number[]} | {why: string}}
 */
function openIssues(issues, gh) {
	const { requireKey } = require("./workflow-core-config.js");
	const { readIssue } = require("./tracker-ops.js");
	const { parseErrLine } = require("./gh.js");
	try {
		const repo = requireKey("tracker");
		return {
			open: issues.filter((n) => readIssue(repo, n, gh).state === "open"),
		};
	} catch (e) {
		return { why: parseErrLine(e) };
	}
}

/**
 * @typedef {{dir: string, rec: any, row: AgentRecord | undefined}} GhostJob
 *   the ghost's plan, its job record — `any`, as `readOwnJob` parses it off disk,
 *   printed as found — and its oracle row where one lists it
 */

/**
 * The GHOST verdict off one sample, or null where the session is not one:
 * lib/hung-jobs.js's GHOST-JOB test, plus no transcript — a session that wrote
 * one took a turn, so the two samples judge it. A listing that would not
 * read is doubt, not absence.
 * @param {Listing} listing
 * @param {ProbeSample} sample
 * @param {{dirs: string[], sessionId: string, now: number}} holder  its
 *   plans, its session, and the epoch ms its record's age is taken at
 * @returns {{verdict: "GHOST", why: string, evidence: string[], ghost: GhostJob} | null}
 */
function ghostVerdict(listing, sample, { dirs, sessionId, now }) {
	const { ghostTest, livenessOf } = require("./hung-jobs");
	if (sample.transcript || sample.unread) return null;
	if (sample.holder && isTerminalAgent(sample.holder.row)) return null;
	const own = readOwnJob(sessionId, { seats: dirs });
	if (own?.job.state !== "working") return null;
	const found = { dir: own.seat, rec: own.job };
	const listed = livenessOf(listing.agents ?? []);
	if (!listed.ids) return null;
	const ghost = ghostTest(found.rec, listed, undefined, now);
	if (typeof ghost === "string") return null;
	const age =
		ghost.age === null ? "an unreadable time" : `${Math.floor(ghost.age)}m`;
	return {
		verdict: "GHOST",
		why: `${ghost.reason}, no transcript, record "working" for ${age}`,
		evidence: [
			sample.holder
				? `oracle: listed ${sample.holder.row.state ?? "?"} with no pid, on plan ${found.dir}`
				: "oracle: listed by no plan",
			"transcript: none found",
			`job record: ${found.dir}, state working, detail "${found.rec.detail ?? ""}", updated ${found.rec.updatedAt ?? "?"}`,
		],
		ghost: { ...found, row: sample.holder?.row },
	};
}

/**
 * Resolve the named holder and take the two samples. Dies on a bad invocation
 * or a refusal from resolveHolder, before anything is sampled.
 * @param {BufferedIo} io
 * @param {ParsedArgs} args
 * @param {string} cmd
 * @param {RescuePorts} ports
 */
async function sampleHolder(io, args, cmd, ports) {
	const { sessionDirs } = require("./arbiter-core");
	const interval =
		args.interval === undefined ? PROBE_INTERVAL_S : Number(args.interval);
	if (!(Number.isFinite(interval) && interval > 0))
		die(io, "--interval takes a positive number of seconds");
	const dirs = sessionDirs().filter((d) => fs.existsSync(d));

	// One listing names every plan's sessions (#3512). Its self-test stands
	// (#3525): the probe reads a holder missing from it as ended, so a listing
	// that omits this session leaves every probe and takeover UNKNOWN.
	const oracle = { run: ports.oracle };
	const first = listedAgents(oracle);
	const who = resolveHolder(args, dirs, first, { cmd, ports });
	if ("refuse" in who) return die(io, who.refuse);
	const before = takeSample(first, dirs, who.sessionId, ports.procRoot);
	const ghost = ghostVerdict(first, before, {
		dirs,
		sessionId: who.sessionId,
		now: ports.now(),
	});
	if (ghost) return { who, dirs, after: before, ...ghost };
	await ports.sleep(interval * 1000);
	const after = takeSample(
		listedAgents(oracle),
		dirs,
		who.sessionId,
		ports.procRoot,
	);
	return { who, dirs, after, ...probeVerdict(before, after), ghost: null };
}

/**
 * The verdict line and its evidence, as probe prints them.
 * @param {{verdict: string, why: string, evidence: string[],
 *   who: {sessionId: string, issue: number | null}}} v
 */
const buildVerdictText = (v) =>
	`${v.verdict}  ${v.who.sessionId.slice(0, 8)}${v.who.issue ? ` (#${v.who.issue})` : ""}  ${v.why}\n${v.evidence.map((e) => `  ${e}\n`).join("")}`;

/**
 * @param {BufferedIo} io
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 */
async function probeHolder(io, args, ports) {
	const v = await sampleHolder(io, args, "probe", ports);
	io.out(buildVerdictText(v));
	return PROBE_EXIT[v.verdict];
}

/**
 * `probe`'s outcome. A throw is doubt, never a bad invocation: UNKNOWN.
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 * @returns {Promise<Outcome>}
 */
async function probe(args, ports) {
	const io = bufferedIo("rescue-sessions probe");
	try {
		return await collectIo(io, () => probeHolder(io, args, ports));
	} catch (e) {
		io.err(`UNKNOWN  probe failed: ${caught(e).message ?? e}\n`);
		return io.result(PROBE_EXIT.UNKNOWN);
	}
}

module.exports = {
	INTENT_ISSUES,
	PROBE_EXIT,
	buildVerdictText,
	probe,
	readTranscriptOf,
	sampleHolder,
};
