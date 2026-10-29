#!/usr/bin/env node
/*
 * overflow-view.js — the founder's view of the overflow seats' headless
 * sessions (#3685), which no `claude agents` view lists: an overflow key's
 * credits cover `claude -p` alone, never a `--bg` job (measured 2026-10-29:
 * "Credit balance too low"), so they never become agents-view jobs.
 *
 * A headless session cannot wait for input: one that asks the founder
 * something ends on a `needs input:` line. Answering it resumes that session
 * with the answer as its next turn, on the same overflow seat.
 *
 * Usage:
 *   node scripts/overflow-view.js                    each key's spend, ended runs
 *                                                    waiting on the founder, live runs
 *   node scripts/overflow-view.js --follow <job>     one run's messages and
 *                                                    tool calls as they arrive
 *   node scripts/overflow-view.js --answer <job> <text>
 *                                                    resume that run's session
 *                                                    with <text>
 *   watch -n 15 node scripts/overflow-view.js        a live board
 */

const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { readJsonl } = require("./lib/jsonl.js");

const {
	launch,
	readLiveAgents,
	readStoredRuns,
} = require("./lib/headless-sessions.js");
const { hostRoot } = require("./lib/host-root.js");
const { buildBudgetLine, seatBudget } = require("./lib/overflow-budget.js");
const { loopFiles, readJson } = require("./lib/refill-files.js");
const { readDeclaredSeats } = require("./lib/refill-seats.js");

/* Ended runs older than this are not offered as waiting. Untraced. */
const WAITING_WINDOW_MS = 48 * 60 * 60 * 1000;
/* An answer's spend ceiling, as `--max-budget-usd`. Untraced. */
const ANSWER_BUDGET_USD = 15;

/** @param {number} ms */
function age(ms) {
	const m = Math.floor(ms / 60_000);
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** @param {string} s @param {number} n */
const clip = (s, n) => {
	const one = s.replace(/\s+/g, " ");
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * @param {Record<string, any>} input
 * @returns {string}
 */
const toolSummary = (input) =>
	String(
		input.command ??
			input.description ??
			input.file_path ??
			input.pattern ??
			"",
	);

/**
 * The readable events of one stream-json line.
 * @param {Record<string, any>} o
 * @returns {{kind: string, text: string}[]}
 */
function lineEvents(o) {
	if (o.type === "result")
		return [
			{
				kind: "end",
				text: `${o.subtype}${o.is_error ? " (error)" : ""}`,
			},
		];
	if (o.type !== "assistant") return [];
	return (o.message?.content ?? []).flatMap(
		(/** @type {Record<string, any>} */ c) => {
			if (c.type === "text" && c.text.trim())
				return [{ kind: "says", text: c.text.trim() }];
			if (c.type === "tool_use")
				return [{ kind: c.name, text: toolSummary(c.input ?? {}) }];
			return [];
		},
	);
}

/**
 * A run's readable events: text, tool calls, its end.
 * @param {string} log
 * @returns {{kind: string, text: string}[]}
 */
function events(log) {
	let read;
	try {
		read = readJsonl(log);
	} catch {
		return [];
	}
	return (read?.rows ?? []).flatMap((o) => lineEvents(o));
}

/** @param {{kind: string, text: string}[]} evs */
const lastSaid = (evs) => evs.findLast((e) => e.kind === "says")?.text ?? "";

/** @returns {Map<string, string>} job id to the loop's prompt */
function loopPrompts() {
	const prompts = new Map();
	/** @type {{launches?: {jobId?: string, prompt?: string}[]}|null} */
	const state = /** @type {any} */ (
		readJson(loopFiles().state, (/** @type {string} */ m) => console.error(m))
	);
	for (const l of state?.launches ?? [])
		if (l.jobId) prompts.set(l.jobId, l.prompt ?? "");
	return prompts;
}

/**
 * Ended runs whose last message asks the founder, with no later run of the
 * same session (an answer already sent).
 * @param {import("./lib/headless-sessions.js").RunRecord[]} runs
 * @param {Set<string>} live job ids
 */
function needsInputRuns(runs, live, now = Date.now()) {
	return runs.filter((r) => {
		if (live.has(r.jobId) || now - r.launchedAt > WAITING_WINDOW_MS)
			return false;
		const later = runs.some(
			(o) => o.sessionId === r.sessionId && o.launchedAt > r.launchedAt,
		);
		const lines = lastSaid(events(r.log)).trim().split("\n");
		return !later && /^needs input:/i.test(lines.at(-1)?.trim() ?? "");
	});
}

function board() {
	let runs;
	let liveRecords;
	try {
		runs = readStoredRuns();
		liveRecords = readLiveAgents();
	} catch (err) {
		console.log(
			`overflow sessions unreadable: ${err instanceof Error ? err.message : err}`,
		);
		return 1;
	}
	const prompts = loopPrompts();
	const live = new Set(liveRecords.map((r) => r.id));
	const now = Date.now();
	const title = (/** @type {string} */ job) =>
		clip(prompts.get(job) ?? "(answer or manual run)", 70);

	for (const seat of readDeclaredSeats().seats)
		if (seat.kind === "overflow")
			console.log(buildBudgetLine(seat, seatBudget(seat, hostRoot())));

	const waiting = needsInputRuns(runs, live, now);
	console.log(`\nNEEDS INPUT: ${waiting.length}`);
	for (const r of waiting)
		console.log(
			`\n${r.jobId}  ended ${age(now - r.launchedAt)} after start  ${title(r.jobId)}\n  ${clip(lastSaid(events(r.log)), 600)}\n  answer: node scripts/overflow-view.js --answer ${r.jobId} "<your answer>"`,
		);

	console.log(`\nRUNNING: ${liveRecords.length}`);
	for (const r of liveRecords) {
		const run = runs.find((x) => x.jobId === r.id);
		const last = run ? events(run.log).at(-1) : undefined;
		console.log(
			`\n${r.id}  ${age(now - r.startedAt)}  ${title(r.id)}\n  last: ${last ? `${last.kind}: ${clip(last.text, 110)}` : "(nothing yet)"}`,
		);
	}
	console.log("\nfollow one: node scripts/overflow-view.js --follow <job>");
	return 0;
}

/** @param {string} job */
function runNamed(job) {
	return readStoredRuns().find((r) => r.jobId === job);
}

/** @param {string} job */
function follow(job) {
	const run = runNamed(job);
	if (!run) {
		console.log(`no run ${job}`);
		return 1;
	}
	let shown = 0;
	const tick = () => {
		const evs = events(run.log);
		for (const e of evs.slice(shown))
			console.log(
				`[${e.kind}] ${e.kind === "says" ? e.text : clip(e.text, 300)}`,
			);
		shown = evs.length;
		if (evs.at(-1)?.kind === "end") process.exit(0);
	};
	tick();
	setInterval(tick, 3000);
	return null;
}

/** @param {string} job @param {string} text */
function answer(job, text) {
	const run = runNamed(job);
	if (!run) {
		console.log(`no run ${job}`);
		return 1;
	}
	const runs = readStoredRuns();
	const live = new Set(readLiveAgents().map((r) => r.id));
	if (!needsInputRuns(runs, live).some((r) => r.jobId === job)) {
		console.error(
			`not sent: ${job} is not a run waiting on you (still running, already answered, or not ended on needs input:)`,
		);
		return 1;
	}
	/* Gated as the dispatcher gates a launch (scripts/dispatch-sessions.sh):
	 * nothing past the key's headroom. */
	const seat = readDeclaredSeats().seats.find((s) => s.dir === run.seat);
	const budget =
		seat?.kind === "overflow" ? seatBudget(seat, hostRoot()) : null;
	if (!budget || "why" in budget || budget.exhausted || budget.fit === 0) {
		console.error(
			`not sent: the key's budget does not fit an answer (${budget && "why" in budget ? budget.why : "no headroom"})`,
		);
		return 1;
	}
	const out = launch({
		seat: run.seat,
		cwd: run.cwd,
		budgetUsd: Math.min(ANSWER_BUDGET_USD, budget.headroomUsd),
		prompt: text,
		resume: run.sessionId,
	});
	if ("why" in out) {
		console.log(`not sent: ${out.why}`);
		return 1;
	}
	console.log(
		`answer sent: session ${run.sessionId} resumed as job ${out.record.jobId}\nfollow it: node scripts/overflow-view.js --follow ${out.record.jobId}`,
	);
	return 0;
}

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		follow: { type: "string" },
		answer: { type: "string" },
		help: { type: "boolean" },
	},
});
let code;
if (values.help) {
	console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
	code = 0;
} else if (values.follow) code = follow(values.follow);
else if (values.answer && positionals.length > 0)
	code = answer(values.answer, positionals.join(" "));
else code = board();
if (code !== null) process.exitCode = code;
