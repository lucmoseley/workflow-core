/*
 * agent-poll.js — the core that stops a session waiting by looking
 * (mantahostels#627, widened at mantahostels#659). It runs in the PreToolUse
 * dispatcher as the guard-agent-poll core, for Bash, Read and ListAgents; its
 * production ports are lib/agent-poll-host.js.
 *
 * Why: a notification arriving while a tool call is in flight is folded into
 * that call's result and read — 97% on the forensics window (#845, which
 * overturned mantahostels#2516's 0.7%; https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/waiting-stall-forensics.md).
 * So a poll learns nothing the notification would not bring, and each look is
 * a full-context turn: that cost is what the three-look cap below rests on.
 * The rule: while something runs in the background, END THE TURN — a turn
 * ends with text and NO tool call at all.
 *
 * FIVE ROUTES, one rolling 5-minute window per session — and per subagent,
 * each its own (#1169), since a subagent's payload carries its parent's
 * session_id. Counted per key:
 *   agents      a ListAgents call.                       Allowance 2.
 *   read:<file> a Read of a background job's output file Allowance 2.
 *               (a path under tasks/ ending .output).
 *   check       a Bash call opening `sleep <n>` — the    Allowance 3.
 *               timed ARTEFACT check, watching a subagent.
 *   check:job   a Bash call opening `sleep <n>` whose     Allowance 3.
 *               tail runs `bg-run.sh check` — the timed
 *               JOB beat, watching a background job.
 *   noop        a Bash call whose whole command is inert Allowance 1.
 *               (`true`, `:`, `exit`, `exit 0`).
 * The first N pass — a name lookup, a status check, one first read of a
 * result. Past it, `agents`, `read:<file>` and `noop` are denied; `check` and
 * `check:job` are allowed with a cadence warning. Keys never evict each other:
 * reading two different output files twice each is four calls and no deny,
 * because neither file was re-read a third time.
 *
 * `noop` gets 1 because, unlike the others, it has no legitimate first use:
 * nothing is learned by running `true`. Its only caller is a session trying to
 * end a turn by calling a tool, which is the thing that cannot work.
 *
 * THE TWO TIMED WATCHES NEVER DENY (#482). `check` is the hand-timed artefact
 * check, `sleep <n>; wc -c <artefact>`, which watch-artefact.js (#539)
 * replaces and its warning names; `check:job` is
 * docs/agents/rules/killed-background-job.txt's
 * `sleep <n>; scripts/bg-run.sh check <name>`, with an allowance of its own
 * (mantahostels#2590). A refusal there punished the rule it enforced (#482),
 * so past the allowance each now warns through additionalContext that the
 * cadence is under two minutes, and the call runs. The allowance is 3 so the
 * prescribed cadence never meets it: at `sleep 120` only two checks start
 * inside the five-minute window, and a third means a cadence under ~100
 * seconds. Backgrounding exempts neither: this core leaves
 * `run_in_background` unread — lib/bg-job.js is the one that reads it — and
 * judges on cadence alone.
 *
 * DENY on the other three routes. mantahostels#103 set the house rule for the
 * Bash guards: deny on a structured fact where the action has no legitimate
 * use, warn where the hook is inferring. The call count is a structured fact;
 * the wait loop it implies is an inference. Deny wins anyway because a warn
 * cannot stop the failure — the loop's cost is paid per call, and a session
 * that has already ignored the rule in prose will ignore a warning too. Each
 * refusal opens with the corrected command (#482). The timed watches are the
 * exception, above. This core cannot tell a suite's output file from any
 * other job's, so the `read:` refusal's first line names all three one-call
 * waits (#545): the watcher for a subagent, the foreground suite
 * (docs/agents/guard-registry.md §Machine limits), and `bg-run.sh wait`.
 *
 * Narrowed on Bash alone (mantahostels#2811, #3224). The Read and ListAgents
 * routes run unnarrowed, having no command to match on. The Bash routes run
 * only where one of the four `if` clauses on the core's lib/guard-cores.json
 * row matches, and between them they cover every ORDINARY spelling the three
 * Bash routes classify; lib/if-clause.js drops a segment's leading blanks
 * before matching. On the calls it does run on, a call no route classifies
 * leaves before the clock or the filesystem is touched.
 *
 * FAILS CLOSED on a throw (the dispatcher row's `failure`). Every fault it can name — a
 * window directory it cannot create, a window it cannot write — fails open,
 * logged (mantahostels#103 §6, mantahostels#147).
 *
 * LIMITS — six, all deliberate:
 *   * It counts calls, never intent. A session with a real reason to look three
 *     times in five minutes is refused alongside the loop; the refusal costs it
 *     a wait, not the work.
 *   * A `sleep 1; wc -c` loop — the evasion the timed-watch count was built to
 *     catch — is warned, not stopped.
 *   * It cannot see whether other tools ran in between, so an interleaved call
 *     counts the same as a back-to-back one.
 *   * A poll spelled some other way — `cat`/`wc` on the output file with no
 *     leading sleep, a `tail -f`, a script that reads it — is a route this core
 *     does not classify. CLAUDE.md covers it, and lib/echo-call.js refuses its
 *     third identical answer.
 *   * A session that narrates "waiting" while calling no tool at all is
 *     untouched — no hook observes silence.
 *   * Two calls of one agent racing each other can lose one's record: the
 *     window is rewritten whole, unlocked. A lost record delays a refusal; it
 *     never causes one.
 *
 * A SUBAGENT IS TOLD OTHERWISE (#1169). Its turn ending is its work ending —
 * nothing wakes it to resume — so where the parent is told to end the turn, a
 * subagent is told to wait inside it, in lib/wait-text.js's words (#1735).
 */

// deny-timing: delayed — the deny arrives on the THIRD poll, so a session
// that never read the rule has already polled twice by the time this text
// reaches it. CLAUDE.md's copy is the only one that arrives in time: do not
// cut it (mantahostels#964, which settled that test).

const { scratchDir, tabRecords, textOf } = require("./guard-entry.js");
const { segment } = require("./review-suffix.js");
const {
	PARENT_WAIT,
	SUBAGENT_WAIT,
	WAIT_SLOT,
	withWait,
} = require("./wait-text.js");

const field = "session_id";
const top = true;
const noun = "poll check";

/** The rolling window, in seconds: five minutes, a guess never measured —
 * wide enough to hold two beats of the prescribed `sleep 120` cadence, which
 * the timed watches' allowance is set against. */
const WINDOW = 300;

/** Each route's allowance, its derivation in the header above. */
const ALLOWANCE = { agents: 2, read: 2, noop: 1, check: 3, "check:job": 3 };

/** @type {Record<number, string>} */
const NUMBER_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five" };

/** `n` as a word, where the refusal texts spell it. @param {number} n */
const spelt = (n) => NUMBER_WORDS[n] ?? String(n);

/** `s` with its first letter capitalised. @param {string} s */
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The window as the texts say it: `five minutes`. */
const WINDOW_TEXT = `${spelt(WINDOW / 60)} minutes`;

const NOOP =
	/^[ \t\n\v\f\r]*(true|:|exit([ \t\n\v\f\r]+0)?)[ \t\n\v\f\r]*;?[ \t\n\v\f\r]*(#.*)?$/s;
const SLEEP = /^[ \t\n\v\f\r]*sleep[ \t\n\v\f\r]+[0-9]/;
const JOB_BEAT = /bg-run\.sh[ \t\n\v\f\r]+check([ \t\n\v\f\r]|$)/;

const WATCH = "node scripts/watch-artefact.js <artefact> 120";

/** The parent's refusals, WAIT_SLOT holding PARENT_WAIT's place (#1779). */
const NOOP_REASON = `Ending a turn is not a tool call. A no-op command like \`true\` re-invokes this session — which is why the loop it is meant to break keeps going. End the turn by emitting your final text with NO tool call at all, and stop: ${WAIT_SLOT}, so each no-op is a full-context turn spent learning nothing.`;
const READ_REASON = `Instead: a subagent, one backgrounded \`${WATCH}\`; your next suite, in the foreground with \`timeout: 600000\`; a bg-run.sh job, \`scripts/bg-run.sh wait <name>\`. Then end the turn.
Re-reading a background job's output file is a wait loop: ${WAIT_SLOT}, so each re-read is a full-context turn spent for nothing.`;
const AGENTS_REASON = `Instead: one backgrounded \`${WATCH}\` on the subagent's artefact, then end the turn.
Polling ListAgents. ${capital(spelt(ALLOWANCE.agents))} calls already in the last ${WINDOW_TEXT} is the shape of a wait loop: ${WAIT_SLOT}, so each poll is a full-context turn spent for nothing. Never narrate "waiting". The elapsed-time column is stale, so the poll does not read true either.`;

const PARENT_REASON = {
	noop: NOOP_REASON,
	read: READ_REASON,
	agents: AGENTS_REASON,
};

/** What a subagent's refusal says after its in-turn wait. */
const SUBAGENT_WHY = {
	noop: "A no-op like `true` waits on nothing. If your work is done, return your final report.",
	read: "Re-reading a background job's output file is a wait loop, each re-read a full-context call spent for nothing.",
	agents:
		"Polling ListAgents is a wait loop, and its elapsed-time column is stale.",
};

/** Each timed watch's warning parts. */
const WATCHES = {
	check: {
		lead: "Timed checks under two minutes apart",
		next: `replace the next with one backgrounded \`${WATCH}\``,
		ceiling:
			"two consecutive checks with no growth means abandon that agent and proceed without it.",
	},
	"check:job": {
		lead: "Timed job beats under two minutes apart",
		next: "space the next to `sleep 120` or more",
		ceiling:
			"stop waiting only on a beat no newer than the last landing's, or on KILLED or UNKNOWN twice — then say the job is lost and proceed without it.",
	},
};

/**
 * @typedef {Pick<import("./guard-dispatch.js").CoreContext,
 *   "input" | "tool" | "agentLabel" | "log" | "treeClass" | "env" | "corePaths"> & {
 *   now: () => number,
 *   readWindow: (file: string) => string,
 *   makeDir: (dir: string) => boolean,
 *   writeWindow: (file: string, text: string) => boolean,
 *   sweep: (dir: string, now: number) => void,
 * }} PollContext the kit's, and lib/agent-poll-host.js's
 * @typedef {{ key: string, allowance: number, kind: "agents" | "read" | "noop" | "check" | "check:job" }} Route
 */

/**
 * Which route the call takes, or null for a call this core leaves alone. An
 * absent tool name reads as ListAgents only where the payload carries no tool
 * input either: that is the shape the guard was built against, and folding a
 * real Bash or Read call into that bucket would deny it with a reason about
 * polling at a session that never polled.
 * @param {PollContext} ctx
 * @returns {Route | null}
 */
function route(ctx) {
	const file = textOf(ctx.input.file_path);
	const command = textOf(ctx.input.command);
	const tool = ctx.tool || (file + command ? "" : "ListAgents");
	if (tool === "ListAgents")
		return { key: "agents", allowance: ALLOWANCE.agents, kind: "agents" };
	if (tool === "Read") {
		/* A background job's output file, wherever the harness puts it. */
		if (!/\/tasks\/.*\.output$/s.test(file)) return null;
		return {
			key: `read:${file.replace(/^.*\//s, "")}`,
			allowance: ALLOWANCE.read,
			kind: "read",
		};
	}
	if (tool !== "Bash") return null;
	/* The WHOLE command must be inert. `make || true` runs make; only a command
	 * that is nothing but the no-op is a turn-end that is not one. */
	if (NOOP.test(command))
		return { key: "noop", allowance: ALLOWANCE.noop, kind: "noop" };
	if (!SLEEP.test(command)) return null;
	/* The job beat names bg-run.sh; anything else is the artefact check. */
	return JOB_BEAT.test(command)
		? { key: "check:job", allowance: ALLOWANCE["check:job"], kind: "check:job" }
		: { key: "check", allowance: ALLOWANCE.check, kind: "check" };
}

/**
 * Every call still inside the window, whatever its key — one route's
 * allowance must not be spent by another's — and how many are this key's.
 * @param {string} raw the window file's text
 * @param {string} key
 * @param {number} now
 */
function inWindow(raw, key, now) {
	const recent = [];
	let hits = 0;
	/* A record is `<unix seconds>\t<key>`, newline-ended; one with no count
	 * for a stamp is dropped. */
	for (const [stamp = "", k = ""] of tabRecords(raw, 2)) {
		if (!/^[0-9]+$/.test(stamp)) continue;
		if (now - Number(stamp) >= WINDOW) continue;
		recent.push(`${stamp}\t${k}`);
		if (k === key) hits++;
	}
	return { recent, hits };
}

/**
 * The text past the allowance: `{ warning }` for a timed watch, which runs,
 * `{ reason }` for a refusal.
 * @param {Route} r
 * @param {boolean} subagent
 * @returns {{ warning: string } | { reason: string }}
 */
function overText(r, subagent) {
	if (r.kind === "check" || r.kind === "check:job") {
		const { lead, next, ceiling } = WATCHES[r.kind];
		const head = `${lead}: more than ${r.allowance} inside ${WINDOW_TEXT}. This one runs;`;
		if (!subagent)
			return {
				warning: `${head} ${next}. Act on what it says: ${ceiling} Meanwhile end the turn — the backgrounded watch is what wakes this session, and it cannot while a tool call of yours is in flight.`,
			};
		/* The artefact check's ceiling abandons a watched subagent, which a
		 * subagent never has; the job beat's still says when to stop waiting. */
		return {
			warning:
				r.kind === "check"
					? `${head} then ${SUBAGENT_WAIT}`
					: `${head} then ${SUBAGENT_WAIT} Waiting on beats instead, ${ceiling}`,
		};
	}
	if (subagent)
		return { reason: `Instead: ${SUBAGENT_WAIT}\n${SUBAGENT_WHY[r.kind]}` };
	return {
		reason: withWait(PARENT_REASON[r.kind], PARENT_WAIT),
	};
}

/**
 * @param {string} session
 * @param {PollContext} ctx
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function decide(session, ctx) {
	const r = route(ctx);
	if (!r) return null;
	const agent = ctx.agentLabel;
	/* Keyed per session, outside the repo: scratch state, never an artefact.
	 * The session reaches the filesystem, so anything that is not a plain
	 * identifier is replaced; the key shares the sanitiser, since a tab or a
	 * newline in it would split one record into two. A subagent's file is its
	 * session's plus `.a<agent_id>`; the sanitised session holds no `.`, so no
	 * session's file can be mistaken for one. */
	const key = r.key.replace(/[^A-Za-z0-9_.:-]/g, "_");
	const dir = scratchDir(ctx.env, "agent-poll");
	const file = `${dir}/${segment(session)}${agent === "main" ? "" : `.${agent}`}`;
	/* Cannot record => cannot judge: an unwritable TMPDIR would otherwise leave
	 * a disarmed guard looking like one that keeps finding nothing wrong. */
	if (!ctx.makeDir(dir)) {
		ctx.log(`could not create ${dir} — poll allowed unchecked`);
		return null;
	}
	const now = ctx.now();
	const { recent, hits } = inWindow(ctx.readWindow(file), key, now);
	let warning = "";
	if (hits >= r.allowance) {
		const over = overText(r, agent !== "main");
		/* A denied call is not recorded: it is not a poll, and recording it
		 * would keep the window alive forever under a retry loop. */
		if ("reason" in over) return { deny: ctx.corePaths(over.reason) };
		warning = over.warning;
	}
	ctx.sweep(dir, now);
	recent.push(`${now}\t${key}`);
	/* A warned watch ran, so it is recorded too: the warning keeps firing for
	 * as long as the cadence stays under two minutes. A failed write loses the
	 * record, never the warning. */
	if (!ctx.writeWindow(file, `${recent.join("\n")}\n`))
		ctx.log(`could not write ${file} — this call went unrecorded`);
	return warning ? { context: ctx.corePaths(warning) } : null;
}

module.exports = { NOOP, SLEEP, decide, field, noun, top };
