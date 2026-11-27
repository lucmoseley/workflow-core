#!/usr/bin/env node
// cli-args-exempt: workflow-core#5540

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { basename } = require("node:path");
const { runCheck } = require("./lib/check");
const { parseErrLine, gh } = require("./lib/gh");
const { heldIssues } = require("./lib/arbiter-issue-claims");
const { holderName, parentVerdictOf } = require("./lib/parent-claims");
const { readHostTracker } = require("./lib/refill-repos");
const { readJobDir } = require("./lib/job-paths");
const { fromEnv } = require("./lib/session-id");
const { OVERFLOW_PREFIX } = require("./lib/model-table");

const {
	DEFAULT_WINDOW_HOURS,
	issuesIn,
	buildHeldText,
	commandOf,
	entryHolds,
	readRecentEntries,
	record,
} = require("./lib/dispatch-ledger");

const {
	claudeBin,
	isTerminalAgent,
	listedAgents,
} = require("./lib/agent-liveness");

/** @typedef {import("./lib/dispatch-ledger").DispatchRecord} DispatchRecord */
/** @typedef {import("./lib/check").Ctx} Ctx */

/**
 * @returns {{ok: false, error: string} | {ok: true, issues: Map<number, string>, listed: {ids: Set<string>, terminal: Set<string>}, names: Map<string, string>}}
 */
function liveIssues() {
	const listing = listedAgents({ requireSelf: false });
	if (listing.why || !listing.agents)
		return {
			ok: false,
			error: listing.why || `${claudeBin()} agents --json answered no agents`,
		};
	const issues = new Map();
	const others = listing.agents.filter((s) => !isCallingSession(s));
	const listed = {
		ids: new Set(others.map((s) => s.sessionId)),
		terminal: new Set(others.filter(isTerminalAgent).map((s) => s.sessionId)),
	};
	const names = new Map(others.map((s) => [s.sessionId, s.name || ""]));
	for (const s of others) {
		const name = typeof s?.name === "string" ? s.name : "";
		for (const n of nameIssues(name)) if (!issues.has(n)) issues.set(n, name);
	}
	return { ok: true, issues, listed, names };
}

/**
 * @param {string} name
 * @returns {number[]}
 */
function nameIssues(name) {
	const bare = name.startsWith(OVERFLOW_PREFIX)
		? name.slice(OVERFLOW_PREFIX.length)
		: name;
	const [prefix] = bare.split(":");
	if (prefix === undefined)
		throw new Error(`splitting the session name ${name} yielded no part`);
	return issuesIn(prefix);
}

/**
 * @param {{sessionId: string, id?: string}} agent
 */
function isCallingSession(agent) {
	const jobDir = readJobDir(process.env);
	return (
		agent.sessionId === fromEnv() ||
		(!!jobDir && agent.id?.slice(0, 8) === basename(jobDir))
	);
}

/**
 * @param {string} prompt
 */
function memberOf(prompt) {
	return { command: commandOf(prompt), issues: issuesIn(prompt) };
}

/**
 * @typedef {{issue: number, via: string, detail: string, prompt?: string, heldUntil?: string}} Duplicate
 */

/**
 * @param {number[]} wanted
 * @param {{windowHours?: number, prompts?: string[]}} [opts]
 * @returns {{duplicates: Duplicate[], warnings: string[]}}
 */
function review(wanted, opts = {}) {
	const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
	const duplicates = /** @type {Duplicate[]} */ ([]);
	const warnings = /** @type {string[]} */ ([]);
	const seen = new Set();

	const live = liveIssues();
	if (live.ok) {
		const hits = liveDuplicates(wanted, live.issues);
		hits.push(...claimDuplicates(wanted, live, hits, warnings));
		duplicates.push(...hits);
		for (const d of hits) seen.add(d.issue);
	} else {
		warnings.push(
			live.error +
				" — a session launched outside this script, or holding a claim on an issue or its parent, would not be caught",
		);
	}

	const members =
		opts.prompts && opts.prompts.length > 0
			? opts.prompts.map(memberOf)
			: [{ command: null, issues: wanted }];
	const ledger = readRecentEntries(undefined, windowHours);
	if (ledger.ok) {
		duplicates.push(
			...ledgerDuplicates(wanted, ledger.entries, { members, seen }),
		);
	} else {
		warnings.push(
			"could not read the dispatch ledger (" +
				ledger.error +
				") — a set already launched from this script would not be caught",
		);
	}
	return { duplicates, warnings };
}

/**
 * @param {number[]} wanted
 * @param {Map<number, string>} running
 * @returns {Duplicate[]}
 */
function liveDuplicates(wanted, running) {
	const out = /** @type {Duplicate[]} */ ([]);
	const seen = new Set();
	for (const n of wanted) {
		if (!running.has(n) || seen.has(n)) continue;
		seen.add(n);
		out.push({
			issue: n,
			via: "live",
			detail: `already running as \`${running.get(n)}\``,
		});
	}
	return out;
}

/**
 * @param {Map<string, string>} names
 * @param {string} sessionId
 */
const sessionLabel = (names, sessionId) =>
	`session \`${holderName(names, sessionId)}\``;

/**
 * @param {number[]} wanted
 * @param {{listed: {ids: Set<string>, terminal: Set<string>}, names: Map<string, string>}} live
 * @param {Duplicate[]} caught
 * @param {string[]} warnings
 * @returns {Duplicate[]}
 */
function claimDuplicates(wanted, live, caught, warnings) {
	const hostHeld = heldIssues(live.listed);
	if (hostHeld.why)
		warnings.push(
			`${hostHeld.why} — a claimed issue or parent may not be caught`,
		);
	const ctx = { live, hostHeld, childRepo: readHostTracker() };
	const done = new Set(caught.map((d) => d.issue));
	const out = /** @type {Duplicate[]} */ ([]);
	for (const n of wanted) {
		if (done.has(n)) continue;
		done.add(n);
		const hit = claimHitOf(n, ctx, warnings);
		if (hit) out.push(hit);
	}
	return out;
}

/**
 * @param {number} n
 * @param {{live: {listed: {ids: Set<string>, terminal: Set<string>}, names: Map<string, string>}, hostHeld: ReturnType<typeof heldIssues>, childRepo: string|null}} ctx
 * @param {string[]} warnings
 * @returns {Duplicate|null}
 */
function claimHitOf(n, { live, hostHeld, childRepo }, warnings) {
	const own = hostHeld.held.get(n);
	if (own)
		return {
			issue: n,
			via: "claim",
			detail: `claimed by ${sessionLabel(live.names, own)}`,
		};
	const verdict = parentVerdictOf(n, readParentOfIssue(n), {
		childRepo,
		listed: live.listed,
		hostHeld,
	});
	if (verdict.state === "unread") warnings.push(verdict.why);
	if (verdict.state !== "claimed") return null;
	return {
		issue: n,
		via: "parent-claim",
		detail: `its parent map ${verdict.label} is claimed by ${sessionLabel(live.names, verdict.sessionId)}`,
	};
}

/**
 * @param {number} n
 * @returns {Parameters<typeof parentVerdictOf>[1]}
 */
function readParentOfIssue(n) {
	try {
		return JSON.parse(gh(["api", `repos/{owner}/{repo}/issues/${n}/parent`]));
	} catch (e) {
		if (/No parent issue found/.test(parseErrLine(e))) return null;
		return { error: parseErrLine(e) };
	}
}

/**
 * @param {number[]} wanted
 * @param {DispatchRecord[]} entries
 * @param {{members: {command: string | null, issues: number[]}[], seen: Set<number>}} set
 * @returns {Duplicate[]}
 */
function ledgerDuplicates(wanted, entries, { members, seen }) {
	const out = /** @type {Duplicate[]} */ ([]);
	const held = new Set();
	for (const rec of entries) {
		for (const n of rec.issues || []) {
			const key = `${n} ${commandOf(rec.prompt)}`;
			if (!wanted.includes(n) || seen.has(n) || held.has(key)) continue;
			if (
				!members.some((m) => m.issues.includes(n) && entryHolds(rec, m.command))
			)
				continue;
			held.add(key);
			out.push({
				issue: n,
				via: "ledger",
				prompt: rec.prompt,
				...(rec.heldUntil ? { heldUntil: rec.heldUntil } : {}),
				detail: `launched ${rec.ts} as \`${rec.prompt || "?"}\`${buildHeldText(rec)}`,
			});
		}
	}
	return out;
}

/**
 * @param {string[]} prompts
 * @param {{issue: number, via?: string, prompt?: string, heldUntil?: string}[]} duplicates
 * @returns {number[]}
 */
function dropIndices(prompts, duplicates) {
	const out = /** @type {number[]} */ ([]);
	prompts.forEach((p, i) => {
		const { issues, command } = memberOf(p);
		const hit = duplicates.some(
			(d) =>
				issues.includes(d.issue) &&
				(d.via !== "ledger" || entryHolds(d, command)),
		);
		if (hit) out.push(i);
	});
	return out;
}

/**
 * @typedef {{record: boolean, issues: number[], prompts: string[], dropIndexOut: string, model: string, prompt: string, jobId: string, seatReason: string, overflowKey: string, allowanceUsd: number, sessionId: string, windowHours: number}} Args
 */

/** @typedef {(value: string) => Partial<Args>} SetFlag */

const VALUE_FLAGS = new Map(
	/** @type {[string, SetFlag][]} */ ([
		[
			"--issues",
			(value) => {
				const prompts = value.split("\n").filter((l) => l.trim());
				return { issues: prompts.flatMap(issuesIn), prompts };
			},
		],
		["--drop-index-out", (value) => ({ dropIndexOut: value })],
		["--model", (value) => ({ model: value })],
		["--prompt", (value) => ({ prompt: value })],
		["--job-id", (value) => ({ jobId: value })],
		["--seat-reason", (value) => ({ seatReason: value })],
		["--overflow-key", (value) => ({ overflowKey: value })],
		["--allowance-usd", (value) => ({ allowanceUsd: Number(value) })],
		["--session-id", (value) => ({ sessionId: value })],
		["--window-hours", (value) => ({ windowHours: Number(value) })],
	]),
);

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Args} */
	let out = {
		record: false,
		issues: /** @type {number[]} */ ([]),
		prompts: /** @type {string[]} */ ([]),
		dropIndexOut: "",
		model: "",
		prompt: "",
		jobId: "",
		seatReason: "",
		overflowKey: "",
		allowanceUsd: 0,
		sessionId: "",
		windowHours: DEFAULT_WINDOW_HOURS,
	};
	let i = 0;
	while (i < argv.length) {
		const flag = argv[i];
		const value = argv[i + 1] || "";
		i += 1;
		if (flag === "--record") {
			out.record = true;
			continue;
		}
		const set = VALUE_FLAGS.get(flag ?? "");
		if (!set) return null;
		out = { ...out, ...set(value) };
		i += 1;
	}
	return out;
}

/** @param {{issues: number[], model: string, prompt: string, jobId: string, seatReason: string, overflowKey: string, allowanceUsd: number, sessionId: string}} opts */
function recordMain(opts) {
	if (
		!record({
			issues: opts.issues,
			model: opts.model,
			prompt: opts.prompt,
			jobId: opts.jobId || null,
			seatReason: opts.seatReason,
			...(opts.overflowKey
				? {
						overflow: {
							keyVar: opts.overflowKey,
							allowanceUsd: opts.allowanceUsd,
							sessionId: opts.sessionId || null,
						},
					}
				: {}),
		})
	) {
		writeFd(
			2,
			"WARNING: could not write the dispatch ledger — a resumed session will not\n" +
				"  know this set was launched (mantahostels#1337).\n" +
				(opts.overflowKey
					? `  This session bills ${opts.overflowKey} but will read as a plan session (workflow-core#3694).\n`
					: ""),
		);
	}
	process.exit(0);
}

/**
 * @param {Ctx} ctx
 * @param {Duplicate[]} duplicates
 * @param {boolean} partial
 */
function sayDuplicates(ctx, duplicates, partial) {
	if (duplicates.length > 0) {
		ctx.say(
			(partial ? "DROPPING " : "REFUSED: ") +
				duplicates.length +
				" issue(s) in this set are already dispatched or claimed:",
		);
	}
	for (const d of duplicates) {
		ctx.fail("already-dispatched", `#${d.issue} — ${d.detail}`, {
			issue: d.issue,
			via: d.via,
		});
		ctx.say(`  #${d.issue} — ${d.detail}`);
	}
	if (duplicates.length > 0) {
		ctx.say(
			partial
				? "  Their members are dropped; the rest of the set still launches" +
						" (mantahostels#1337).\n  --force to launch them anyway."
				: "  A set is recorded when it launches, so a session that lost its " +
						"launch from\n  context cannot dispatch it twice (mantahostels#1337). Kill the " +
						"running sessions first,\n  or --force if you genuinely mean to " +
						"re-launch.",
		);
	}
}

/**
 * @param {Ctx} ctx
 * @param {string} path
 * @param {number[]} drop
 */
function writeDropIndex(ctx, path, drop) {
	try {
		fs.writeFileSync(
			path,
			drop.map(String).join("\n") + (drop.length > 0 ? "\n" : ""),
		);
	} catch (err) {
		ctx.warn("drop-index-unwritable", String(err), { path });
		ctx.say(`WARNING: could not write ${path}.`);
	}
}

const USAGE =
	"node check-duplicate-dispatch.js --issues <n,n> [--window-hours <h>] [--drop-index-out <path>]\n" +
	"       node check-duplicate-dispatch.js --record [--issues <n,n>] --model <m> --prompt <p> [--job-id <id>] [--overflow-key <var> --allowance-usd <usd> [--session-id <id>]]";

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts?.record) recordMain(opts);

	runCheck({
		name: "duplicate-dispatch",
		usage: USAGE,
		valueFlags: [
			"--issues",
			"--model",
			"--prompt",
			"--window-hours",
			"--drop-index-out",
		],
		/** @param {any} ctx */
		run(ctx) {
			if (!opts || opts.issues.length === 0)
				return ctx.usageError("no issue numbers to check");

			const { duplicates, warnings } = review(opts.issues, {
				windowHours: opts.windowHours,
				prompts: opts.prompts,
			});

			for (const w of warnings) {
				ctx.warn("unreadable-source", `${w}.`, { source: w });
				ctx.say(`WARNING: ${w}.`);
			}

			const drop = opts.dropIndexOut
				? dropIndices(opts.prompts, duplicates)
				: [];
			const partial =
				Boolean(opts.dropIndexOut) &&
				drop.length > 0 &&
				drop.length < opts.prompts.length;

			sayDuplicates(ctx, duplicates, partial);

			if (opts.dropIndexOut) writeDropIndex(ctx, opts.dropIndexOut, drop);

			return {
				okLine: "no issue in this set is already dispatched",
				noun: "already-dispatched issue(s)",
				count: duplicates.length,
			};
		},
	});
}

if (require.main === module) main();
