#!/usr/bin/env node
/*
 * check-duplicate-dispatch.js — refuses a `/pick-next` §7 launch whose issues
 * are already running, or were already launched a moment ago (mantahostels#1337).
 *
 * TWO ROUTES, BECAUSE EACH COVERS THE OTHER'S BLIND SPOT.
 *   - The LEDGER (`.pick-next/dispatched.jsonl`, written by --record, its holds
 *     released by the refill loop's hand-off, #2744) catches a
 *     set whose sessions have since finished, which a live-session check alone
 *     would wave through to run again against a closed issue.
 *   - The LIVE ORACLE (`claude agents --json`, read through
 *     `lib/agent-liveness.js`) catches a launch made outside this script — by
 *     hand, or from the agents view — which the ledger never saw.
 *
 * THE LIB IS KEYED ON `sessionId`, THIS GATE ON `name`, so routing the read
 * through it (mantahostels#1400) narrowed what the live limb can see, always toward
 * permitting. Three narrowings, and only two announce themselves:
 *   - An empty list is refused rather than read as "nothing is running" — WARN.
 *   - A list where NO record carries a `sessionId` is refused the same way —
 *     WARN.
 *   - A SINGLE record dropped for lacking a `sessionId` warns NOTHING. The lib
 *     filters it and still answers, so a duplicate named only by that record is
 *     missed in silence.
 *
 * IT FAILS OPEN, DELIBERATELY, AND THE TWO HALVES FAIL DIFFERENTLY. An
 * unreadable ledger or an unreadable oracle WARNS and permits the launch. That
 * is the opposite of the allowance gate's fail-closed stance in
 * `dispatch-sessions.sh`: allowance failure strands half-finished sessions,
 * whereas a missed duplicate is visible and killable.
 *
 * THE LEDGER, ITS PATH AND ITS WINDOW LIVE IN `lib/dispatch-ledger.js`
 * (mantahostels#1528).
 *
 * THE CLAIM LIMB (#2310) refuses a member whose issue, or whose parent, a live
 * session other than this one holds an arbiter claim on: the name-keyed live
 * limb misses a session titled for anything else, and a charting session
 * holds its map's children through the map (#2211); a parent that is no
 * `wayfinder:map` holds nothing. It is read here as well as
 * at pick, so a claim taken between the two still refuses. The parent is one
 * `gh api …/issues/<n>/parent` call a member, asked only where the issue's own
 * claim did not already refuse it; a parent in another repo is read from that
 * repo's store (lib/parent-claims.js). An unreadable parent or store WARNS and
 * permits.
 *
 * THE LEDGER LIMB KEYS ON ISSUE AND COMMAND; THE LIVE LIMB ON ISSUE ALONE
 * (#752). A ledger entry drops a member only where both name the same issue
 * and run the same `/<skill>`, read through the seam's `commandOf`, so
 * `/wayfinder 34` launches after `/triage 34` relabelled it, while a second
 * `/triage 34` inside the window is dropped. A command either side leaves
 * unreadable holds. A session still running on the issue holds it whatever
 * the command, so no stage starts on top of an unfinished one. A legitimate
 * re-dispatch of the same command on the same issue inside the window takes
 * `--force`.
 *
 * REFUSAL IS PER MEMBER, NOT PER SET. `--issues` takes one launch prompt per
 * line, and `--drop-index-out` names the file where the zero-based indices of
 * the offending members are written.
 *
 * Usage:
 *   node scripts/check-duplicate-dispatch.js --issues 341,353 [--window-hours 6]
 *   node scripts/check-duplicate-dispatch.js --issues "$prompts" --drop-index-out <path>
 *   node scripts/check-duplicate-dispatch.js --record --issues 341 --model opus --prompt "/implement 341"
 *
 * Outcomes are §N4's alphabet through `runCheck`: OK/WARN 0 (clear, or clear
 * but a source went unread), FAIL 1 (duplicate found), BROKEN 2 (bad
 * invocation).
 *
 * cli-args-exempt: its `runCheck` answers `--help` and refuses an unknown flag as
 * BROKEN, which `parseArgs` here feeds it by returning null.
 */

const fs = require("node:fs");
const { basename } = require("node:path");
const { runCheck } = require("./lib/check");
const { parseErrLine, gh } = require("./lib/gh");
const { heldIssues } = require("./lib/arbiter-issue-claims");
const {
	hostTracker,
	isMap,
	issueRef,
	parentClaim,
	refLabel,
	sessionName,
} = require("./lib/parent-claims");
const { fromEnv } = require("./lib/session-id");

const {
	DEFAULT_WINDOW_HOURS,
	issuesIn,
	commandOf,
	entryHolds,
	readRecentEntries,
	record,
} = require("./lib/dispatch-ledger");

/* The oracle READ is the lib's, so this script cannot drift onto its own argv,
 * timeout, parse or binary (mantahostels#1374, mantahostels#1400). */
const {
	claudeBin,
	isTerminalAgent,
	listedAgents,
} = require("./lib/agent-liveness");

/** @typedef {import("./lib/dispatch-ledger").DispatchRecord} DispatchRecord */
/** @typedef {import("./lib/check").Ctx} Ctx */

/**
 * Issue numbers named by a live session, mapped to the session name carrying
 * each. Takes the integers from a session's name prefix — the part before the
 * first colon, which is where `/implement 833` puts its issue numbers.
 *
 * `requireSelf: false` waives the lib's self-test, the exemption mantahostels#535 keeps
 * opt-in. That test protects a reader whose judgement is an ABSENCE — a session
 * missing from a short list reads dead. This gate's judgement is a PRESENCE: it
 * refuses only on finding a wanted issue, so a short list can merely make it
 * catch less. Under the strict default, a list that omitted this session while
 * naming a real duplicate would silence the whole limb and permit the launch
 * (mantahostels#1400).
 *
 * TWO RESIDUALS THE WAIVER CARRIES. The list arrives with no caveat attached,
 * so a blind live limb is silent here. And the self-test also screens out a
 * STALE listing, so a presence-judging reader can over-report: a session the
 * oracle still names after it died would refuse a legitimate dispatch.
 *
 * The calling session is never its own duplicate (#1989): a rescuer titled
 * after the ticket it re-dispatches would otherwise refuse that dispatch. It is
 * matched by session id, or by job id against `$CLAUDE_JOB_DIR`'s basename.
 *
 * `listed` is the same read in heldIssues' shape, the calling session left
 * out, so the claim limb never refuses on this session's own claim; `names`
 * maps a session id to its name.
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
		if (!name) continue;
		const [prefix] = name.split(":");
		if (prefix === undefined)
			throw new Error(`splitting the session name ${name} yielded no part`);
		for (const n of issuesIn(prefix)) if (!issues.has(n)) issues.set(n, name);
	}
	return { ok: true, issues, listed, names };
}

/**
 * Whether a listed agent is the session running this check.
 * @param {{sessionId: string, id?: string}} agent
 */
function isCallingSession(agent) {
	const jobDir = process.env.CLAUDE_JOB_DIR;
	return (
		agent.sessionId === fromEnv() ||
		(!!jobDir && agent.id?.slice(0, 8) === basename(jobDir))
	);
}

/**
 * A launch prompt as the ledger limb reads it: the command it runs and the
 * issues it names.
 * @param {string} prompt
 */
function memberOf(prompt) {
	return { command: commandOf(prompt), issues: issuesIn(prompt) };
}

/**
 * One refused issue. `prompt` is the ledger entry's own, on a `ledger` hit
 * alone: it is what scopes the hit to the members running the same command.
 * @typedef {{issue: number, via: string, detail: string, prompt?: string}} Duplicate
 */

/**
 * The verdict on a proposed set.
 * @param {number[]} wanted issue numbers about to be launched
 * @param {{windowHours?: number, prompts?: string[]}} [opts]
 *   `prompts` is the set's launch prompts, one per member, which is where the
 *   ledger limb reads each member's command (#752).
 * @returns {{duplicates: Duplicate[], warnings: string[]}}
 */
function review(wanted, opts = {}) {
	const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
	const duplicates = /** @type {Duplicate[]} */ ([]);
	const warnings = /** @type {string[]} */ ([]);
	const seen = new Set();

	/*
	 * LIVE FIRST, because it holds an issue against every command: an issue it
	 * names is flagged once, and the ledger limb below has nothing to add to it.
	 */
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

	/*
	 * Without `opts.prompts` every member's command is unreadable, so a bare
	 * issue list holds on the issue alone.
	 */
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
 * The live limb's hits, each issue once.
 * @param {number[]} wanted
 * @param {Map<number, string>} running issue → the session name running it
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
 * A session for a reader, named as the live limb names one.
 * @param {Map<string, string>} names
 * @param {string} sessionId
 */
const sessionLabel = (names, sessionId) =>
	`session \`${sessionName(names, sessionId)}\``;

/**
 * The claim limb's hits, each issue once, skipping one the live limb caught.
 * @param {number[]} wanted
 * @param {{listed: {ids: Set<string>, terminal: Set<string>}, names: Map<string, string>}} live
 * @param {Duplicate[]} caught the live limb's hits
 * @param {string[]} warnings accumulator: a line for each claim not read
 * @returns {Duplicate[]}
 */
function claimDuplicates(wanted, live, caught, warnings) {
	const hostHeld = heldIssues(live.listed);
	if (hostHeld.why)
		warnings.push(
			`${hostHeld.why} — a claimed issue or parent may not be caught`,
		);
	const ctx = { live, hostHeld, childRepo: hostTracker() };
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
 * Member `n`'s claim hit: its own claim, else its parent map's; null where
 * neither stands or was read.
 * @param {number} n
 * @param {{live: {listed: {ids: Set<string>, terminal: Set<string>}, names: Map<string, string>}, hostHeld: ReturnType<typeof heldIssues>, childRepo: string|null}} ctx
 * @param {string[]} warnings accumulator: a line for each claim not read
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
	const parent = readParentOfIssue(n, childRepo);
	if ("why" in parent) {
		warnings.push(`${parent.why} — a claim on it would not be caught`);
		return null;
	}
	if (!parent.ref || !parent.map) return null;
	const claim = parentClaim(parent.ref, {
		childRepo,
		listed: live.listed,
		hostHeld,
	});
	if (!claim) return null;
	if ("why" in claim) {
		warnings.push(claim.why);
		return null;
	}
	return {
		issue: n,
		via: "parent-claim",
		detail: `its parent map ${parent.label} is claimed by ${sessionLabel(live.names, claim.sessionId)}`,
	};
}

/**
 * Issue `n`'s parent, as `{ref, label, map}`, `{ref: null}` where it has
 * none, or `{why}` where the call failed. `map` reads the payload's labels.
 * @param {number} n
 * @param {string|null} childRepo the repo `n` lives in, which `label` is read from
 * @returns {{ref: import("./lib/parent-claims").IssueRef, label: string, map: boolean} | {ref: null} | {why: string}}
 */
function readParentOfIssue(n, childRepo) {
	try {
		const parent = JSON.parse(
			gh(["api", `repos/{owner}/{repo}/issues/${n}/parent`]),
		);
		const ref = issueRef(parent?.url);
		if (!ref)
			return { why: `the parent of #${n} named no issue (${parent?.url})` };
		return { ref, label: refLabel(ref, childRepo), map: isMap(parent) };
	} catch (e) {
		if (/No parent issue found/.test(parseErrLine(e))) return { ref: null };
		return {
			why: `the parent of #${n} could not be read (${parseErrLine(e)})`,
		};
	}
}

/**
 * The ledger limb's hits: a recent entry naming a wanted issue the live limb
 * did not, for a member running the entry's command — once per issue and
 * command.
 * @param {number[]} wanted
 * @param {DispatchRecord[]} entries the ledger's entries inside the window
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
				detail: `launched ${rec.ts} as \`${rec.prompt || "?"}\``,
			});
		}
	}
	return out;
}

/**
 * Which members of a proposed set carry a duplicate (mantahostels#1337 follow-up). A
 * ledger hit drops only the members running its entry's command (#752); any
 * other hit drops every member naming the issue.
 * @param {string[]} prompts one launch prompt per member, in dispatch order
 * @param {{issue: number, via?: string, prompt?: string}[]} duplicates
 * @returns {number[]} zero-based indices of the members to drop
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
 * @typedef {{record: boolean, issues: number[], prompts: string[], dropIndexOut: string, model: string, prompt: string, jobId: string, windowHours: number}} Args
 */

/** @typedef {(value: string) => Partial<Args>} SetFlag */

/** Each value flag, and the fields its value sets. */
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
		["--window-hours", (value) => ({ windowHours: Number(value) })],
	]),
);

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Args} */
	let out = {
		record: false,
		issues: /** @type {number[]} */ ([]),
		/* A caller passing a single flat list gets one member. */
		prompts: /** @type {string[]} */ ([]),
		dropIndexOut: "",
		model: "",
		prompt: "",
		jobId: "",
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

/* --record is the non-checking subcommand §N4 permits: it writes the ledger and
 * checks nothing, so it exits on its own path and never enters runCheck. */
/** @param {{issues: number[], model: string, prompt: string, jobId: string}} opts */
function recordMain(opts) {
	if (
		!record({
			issues: opts.issues,
			model: opts.model,
			prompt: opts.prompt,
			jobId: opts.jobId || null,
		})
	) {
		process.stderr.write(
			"WARNING: could not write the dispatch ledger — a resumed session will not\n" +
				"  know this set was launched (mantahostels#1337).\n",
		);
	}
	process.exit(0);
}

/**
 * Says the duplicates, and what happens to them, under the FAIL each carries.
 * @param {Ctx} ctx
 * @param {Duplicate[]} duplicates
 * @param {boolean} partial whether only some members are dropped
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
	"       node check-duplicate-dispatch.js --record --issues <n,n> --model <m> --prompt <p> [--job-id <id>]";

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts?.record && opts.issues.length > 0) recordMain(opts);

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
		/* `any` until this file is opted in: lib/check.js exports CheckContext for
		 * its type (mantahostels#1463), so this becomes an import type then. */
		/** @param {any} ctx */
		run(ctx) {
			if (!opts || opts.issues.length === 0)
				return ctx.usageError("no issue numbers to check");

			const { duplicates, warnings } = review(opts.issues, {
				windowHours: opts.windowHours,
				prompts: opts.prompts,
			});

			/* WARN, not FAIL: WARN exits 0, so the launch is permitted. */
			for (const w of warnings) {
				ctx.warn("unreadable-source", `${w}.`, { source: w });
				ctx.say(`WARNING: ${w}.`);
			}

			/* Say REFUSED only where refusing is what happens. */
			const drop = opts.dropIndexOut
				? dropIndices(opts.prompts, duplicates)
				: [];
			const partial =
				Boolean(opts.dropIndexOut) &&
				drop.length > 0 &&
				drop.length < opts.prompts.length;

			sayDuplicates(ctx, duplicates, partial);

			/* Written before the outcome is returned so a FAIL still carries it.
			 * An unwritable path WARNs
			 * rather than failing: the caller's own fallback is to launch nothing,
			 * which is the safe direction. */
			if (opts.dropIndexOut) writeDropIndex(ctx, opts.dropIndexOut, drop);

			/* count is stated rather than inferred: runCheck counts WARN findings
			 * when there are no FAILs, so a fail-open run with no duplicate at all
			 * would otherwise summarise as "1 already-dispatched issue(s)". */
			return {
				okLine: "no issue in this set is already dispatched",
				noun: "already-dispatched issue(s)",
				count: duplicates.length,
			};
		},
	});
}

if (require.main === module) main();
