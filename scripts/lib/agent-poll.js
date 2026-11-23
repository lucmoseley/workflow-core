const { scratchDir, tabRecords, textOf } = require("./guard-entry.js");
const { ruleOrFallback } = require("./guard-verdict.js");
const { segment } = require("./review-suffix.js");
const {
	PARENT_WAIT,
	SUBAGENT_WAIT,
	WAIT_SLOT,
	withWait,
} = require("./wait-text.js");

// guess, #5529
const WINDOW = 300;

// guess, #482
const ALLOWANCE = { agents: 2, read: 2, noop: 1, check: 3, "check:job": 3 };

/** @type {Record<number, string>} */
const NUMBER_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five" };

/** @param {number} n */
const spelt = (n) => NUMBER_WORDS[n] ?? String(n);

/** @param {string} s */
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const WINDOW_TEXT = `${spelt(WINDOW / 60)} minutes`;

const NOOP =
	/^[ \t\n\v\f\r]*(true|:|exit([ \t\n\v\f\r]+0)?)(?:(?:[ \t\n\v\f\r]+|[ \t\n\v\f\r]*;[ \t\n\v\f\r]*)(?:#[^\n]*(?:\n[ \t\n\v\f\r]*|$))*)?$/;
const SLEEP = /^[ \t\n\v\f\r]*sleep[ \t\n\v\f\r]+[0-9]/;
const JOB_BEAT = /bg-run\.sh[ \t\n\v\f\r]+check([ \t\n\v\f\r]|$)/;

const WATCH =
	"node scripts/watch-artefact.js <artefact> 120 --log <output_file>";

const NOOP_REASON = `Ending a turn is not a tool call. A no-op command like \`true\` re-invokes this session — which is why the loop it is meant to break keeps going. End the turn by emitting your final text with NO tool call at all, and stop: ${WAIT_SLOT}, so each no-op is a full-context turn spent learning nothing.`;
const READ_REASON = `Instead: a subagent, one backgrounded \`${WATCH}\`; your next suite, in the foreground with \`timeout: 600000\`; a bg-run.sh job, \`scripts/bg-run.sh wait <name>\`. Then end the turn (a job: \`rule:job-holds-turn\`).
Re-reading a background job's output file is a wait loop: ${WAIT_SLOT}, so each re-read is a full-context turn spent for nothing.`;
const AGENTS_REASON = `Instead: one backgrounded \`${WATCH}\`, then end the turn (a job: \`rule:job-holds-turn\`).
Polling ListAgents. ${capital(spelt(ALLOWANCE.agents))} calls already in the last ${WINDOW_TEXT} is the shape of a wait loop: ${WAIT_SLOT}, so each poll is a full-context turn spent for nothing. Never narrate "waiting". The elapsed-time column is stale, so the poll does not read true either.`;

const PARENT_REASON = {
	noop: NOOP_REASON,
	read: READ_REASON,
	agents: AGENTS_REASON,
};

const SUBAGENT_WHY = {
	noop: "A no-op like `true` waits on nothing. If your work is done, return your final report.",
	read: "Re-reading a background job's output file is a wait loop, each re-read a full-context call spent for nothing.",
	agents:
		"Polling ListAgents is a wait loop, and its elapsed-time column is stale.",
};

const WATCHES = {
	check: {
		lead: "Timed checks under two minutes apart",
		next: `replace the next with one backgrounded \`${WATCH}\``,
		ceiling: () => "its `STALLED` or `MISSING` means abandon that agent.",
	},
	"check:job": {
		lead: "Timed job beats under two minutes apart",
		next: "space the next to `sleep 120` or more",
		/** @param {PollContext} ctx */
		ceiling: (ctx) =>
			ruleOrFallback(
				ctx,
				"job-wait-ceiling",
				"stop waiting only on a beat no newer than the last landing's",
			),
	},
};

/**
 * @typedef {Pick<import("./core-contract.js").CoreContext,
 *   "input" | "tool" | "agentLabel" | "log" | "env" | "corePaths" | "ruleText" | "docPath"> & {
 *   now: () => number,
 *   readWindow: (file: string) => string | null,
 *   makeDir: (dir: string) => boolean,
 *   writeWindow: (file: string, text: string) => boolean,
 *   sweep: (dir: string, now: number) => void,
 * }} PollContext
 * @typedef {{ key: string, allowance: number, kind: "agents" | "read" | "noop" | "check" | "check:job" }} Route
 */

/**
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
		if (!/\/tasks\/.*\.output$/s.test(file)) return null;
		return {
			key: `read:${file.replace(/^.*\//s, "")}`,
			allowance: ALLOWANCE.read,
			kind: "read",
		};
	}
	if (tool !== "Bash") return null;
	if (NOOP.test(command))
		return { key: "noop", allowance: ALLOWANCE.noop, kind: "noop" };
	if (!SLEEP.test(command)) return null;
	return JOB_BEAT.test(command)
		? { key: "check:job", allowance: ALLOWANCE["check:job"], kind: "check:job" }
		: { key: "check", allowance: ALLOWANCE.check, kind: "check" };
}

/**
 * @param {string} raw
 * @param {string} key
 * @param {number} now
 */
function inWindow(raw, key, now) {
	const recent = [];
	let hits = 0;
	for (const [stamp = "", k = ""] of tabRecords(raw, 2)) {
		if (!/^[0-9]+$/.test(stamp)) continue;
		if (now - Number(stamp) >= WINDOW) continue;
		recent.push(`${stamp}\t${k}`);
		if (k === key) hits++;
	}
	return { recent, hits };
}

/**
 * @param {Route} r
 * @param {boolean} subagent
 * @param {PollContext} ctx
 * @returns {{ warning: string } | { reason: string }}
 */
function overText(r, subagent, ctx) {
	if (r.kind === "check" || r.kind === "check:job") {
		const { lead, next } = WATCHES[r.kind];
		const ceiling = WATCHES[r.kind].ceiling(ctx);
		const head = `${lead}: more than ${r.allowance} inside ${WINDOW_TEXT}. This one runs;`;
		if (!subagent)
			return {
				warning: `${head} ${next}. Act on what it says: ${ceiling} Meanwhile end the turn — the backgrounded watch is what wakes this session, and it cannot while a tool call of yours is in flight.`,
			};
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
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(session, ctx) {
	const r = route(ctx);
	if (!r) return null;
	const agent = ctx.agentLabel;
	const key = r.key.replace(/[^A-Za-z0-9_.:-]/g, "_");
	const dir = scratchDir(ctx.env, "agent-poll");
	const file = `${dir}/${segment(session)}${agent === "main" ? "" : `.${agent}`}`;
	if (!ctx.makeDir(dir)) {
		ctx.log(`could not create ${dir} — poll allowed unchecked`);
		return null;
	}
	const text = ctx.readWindow(file);
	if (text === null) {
		ctx.log(`could not read ${file} — poll allowed unchecked`);
		return null;
	}
	const now = ctx.now();
	const { recent, hits } = inWindow(text, key, now);
	let warning = "";
	if (hits >= r.allowance) {
		const over = overText(r, agent !== "main", ctx);
		if ("reason" in over) return { deny: ctx.corePaths(over.reason) };
		warning = over.warning;
	}
	ctx.sweep(dir, now);
	recent.push(`${now}\t${key}`);
	if (!ctx.writeWindow(file, `${recent.join("\n")}\n`))
		ctx.log(`could not write ${file} — this call went unrecorded`);
	return warning ? { context: ctx.corePaths(warning) } : null;
}

module.exports = {
	NOOP,
	SLEEP,
	decide,
	field: "session_id",
	noun: "poll check",
	top: true,
};
