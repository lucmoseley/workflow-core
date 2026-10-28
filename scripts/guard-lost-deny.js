#!/usr/bin/env node
/*
 * guard-lost-deny.js — Stop hook. Tells a session that a DENY-CAPABLE guard was
 * killed mid-call and failed open, while that session is still alive to re-check
 * the act that escaped. That happens only below Claude Code 2.1.295 or on a
 * registration without `onFailure: "block"` (#2670).
 *
 * WHY IT EXISTS (mantahostels#2299, ruled at mantahostels#2289 option (A); part of the mantahostels#2265 map). A
 * guard cancelled at its timeout fails open silently: the tool call it was
 * judging simply proceeds, and nothing in the session says so.
 *
 * WHAT IS LEFT TO IT (#2670). Every deny-capable registration the plugin ships
 * carries `"onFailure": "block"`, so on Claude Code 2.1.295 and later the
 * harness refuses the call instead and writes no `hook_cancelled` record
 * (measured on 2.1.309). A registration without the field is an adopter's own.
 *
 * WHY Stop AND NOT SessionStart OR PreToolUse (censuses at mantahostels#2299). The two
 * existing reporters, check-hook-liveness.js and check-guard-errors.js, ran at
 * SessionStart then, where the failure volume is and where they were themselves
 * cancelled — and they reached a session before its loss had happened, not one
 * that could still act. Both now run only under `npm run status`. A PreToolUse reporter would add a 21st shell to the
 * fan-out that causes the burst in the first place (mantahostels#2287).
 *
 * THE DENY-CAPABLE SET IS DERIVED, NEVER LISTED. `lib/deny-capable.js` reads
 * each guard's own source for a route to a refusal, so a guard added later
 * joins the set with no edit here.
 *
 * IT SPEAKS BY BLOCKING, WHICH IS THE ONE THING mantahostels#2299 ASKED IT NOT TO DO. A Stop
 * hook has no other channel to the model — an exit-0 hook reaches the transcript
 * and the user, never the session — so a report that is never read is no report.
 * The block is bounded twice over: once per tool call for ever, and at most
 * MAX_BLOCKS turns per session. Demanding nothing of the turn makes it a
 * REPORTING guard (docs/agents/guard-authoring.md), which is why the first
 * bound is a `seen` set of toolUseIDs and not a counter.
 *
 * IMPLICIT:  reads this session's own transcript at every Stop and refuses one
 *            turn where a deny-capable PreToolUse guard was cancelled or
 *            exited non-zero, and the call went ahead, since the last report, recording each reported
 *            call and block under .claude/tmp/markers.
 * JUSTIFIED: fail-safe — an unenforced rule the session does not know about is
 *            the failure this exists to end, and the remedy is one command.
 * DEFEAT:    once per tool call and at most MAX_BLOCKS times per session; silent
 *            where no deny-capable guard was lost, and on every failure path.
 *
 * EACH GUARD IT NAMES CARRIES ITS MEASURED DENY RATE (mantahostels#3261, on mantahostels#3260's
 * census). A replay costs a second turn, and the rate is what tells a session
 * whether to spend it. `lib/guard-deny-rates.js` holds the figures, the cut and
 * their provenance.
 *
 * IT HAS A SECOND MODE, WHICH IS NOT A HOOK. `replay <transcript> <toolUseID>`
 * is run by hand, from the command line the block prints, and exits 2 where it
 * cannot act — no arguments, an unreadable transcript, a tool call that lost no
 * deny-capable guard. The `guard-*` contract, failing open and exiting 0 on a
 * fault it catches, is the hook path's and is untouched; this is the shape §N4 sanctions for `check-*`, a
 * non-checking subcommand exiting on its own path.
 *
 * ONE RESIDUAL, UNREACHABLE TODAY. Past 16 MB `lib/session-transcript.js` reads
 * the last 8 MB only, so a cancellation inside that tail whose `tool_use` record
 * sits before it is named but not described, and `replay` cannot rebuild its
 * payload.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { guardDirs, guardPath, isDenyCapableIn } = require("./lib/deny-capable");
const { DISPATCH_ENTRY, denyingCoresOn } = require("./lib/guard-cores.js");
const denyRates = require("./lib/guard-deny-rates");
const { guardKey } = require("./lib/guard-fires");
const { coreHost } = require("./lib/workflow-core-config.js");
const hookBlock = require("./lib/hook-block");
const { describeCall, reportOnce } = require("./lib/report-once");
const { coreRoot, scriptPath } = require("./lib/script-path.js");
const sessionTranscript = require("./lib/session-transcript");
const stopGuard = require("./lib/stop-guard");
const { isSubagentTranscript, mainChainRecords } = require("./lib/transcript");
const { caught } = require("./lib/caught.js");

/**
 * The slice of the Stop payload this guard reads.
 * @typedef {{session_id?: string, hook_event_name?: string,
 *   transcript_path?: string, stop_hook_active?: unknown}} Payload
 */

/**
 * One lost hook, as the harness records it.
 * @typedef {{toolUseID: string, guard: string, type: string,
 *   durationMs: number|null, timeoutMs: number|null,
 *   exitCode: number|null, pricedAs: string[]}} Loss `pricedAs` names
 *   what the loss is priced as: the guard, or the dispatcher's cores (#3272)
 */

/** The two attachment types that say a hook did not complete. */
const FAILURE_TYPES = new Set(["hook_cancelled", "hook_non_blocking_error"]);

/*
 * ONLY A PreToolUse LOSS IS AN ESCAPED DENY. A deny is a PreToolUse verdict; a deny-capable script also
 * wired somewhere else has no permission authority on that other event, so
 * reporting one would be a false alarm and `replay` would fabricate a payload
 * for an authority it never had.
 */
const DENY_EVENT = "PreToolUse";

/** Tool calls already reported, one id per line (lib/report-once.js). */
const SEEN_PREFIX = ".lost-deny-seen-";

/**
 * Every deny-capable guard killed in this transcript, newest last.
 *
 * `stats`, where a caller passes one, gets `stats.skipped` incremented per line
 * that would not parse (mantahostels#3311), and a loss recorded on such a line is silently
 * absent from this list. It is rare, and it does NOT heal — the corruption is
 * persistent (`lib/transcript.js` `mainChainRecords`), so the count is a limit
 * on this reading and never something a later Stop makes good.
 *
 * @param {string} text the transcript
 * @param {"main" | "subagent"} tier
 * @param {PriceOf} priceOf
 * @param {{skipped: number}} [stats]
 * @returns {Loss[]}
 */
function lossesIn(text, tier, priceOf, stats) {
	/** @type {Loss[]} */
	const out = [];
	for (const record of mainChainRecords(text, tier, stats)) {
		const loss = lossOf(record, priceOf);
		if (loss) out.push(loss);
	}
	return out;
}

/**
 * One record's loss of a deny-capable guard, or null where it records none.
 * @param {Record<string, any>} record as `mainChainRecords` yields it — a
 *   transcript is an external format this repo does not define
 * @param {PriceOf} priceOf
 * @returns {Loss | null}
 */
function lossOf(record, priceOf) {
	const a = record?.attachment;
	if (!a || !FAILURE_TYPES.has(a.type)) return null;
	if (typeof a.command !== "string" || !a.command) return null;
	if (typeof a.toolUseID !== "string" || !a.toolUseID) return null;
	if (a.hookEvent !== DENY_EVENT) return null;
	/* The harness writes the exec form's `args` into `.command` already
	 * (measured at mantahostels#2059), so there is no second field to pass. */
	const guard = guardKey(a.command);
	if (!guard) return null;
	const pricedAs = priceOf(guard, a.toolUseID);
	if (pricedAs.length === 0) return null;
	return {
		toolUseID: a.toolUseID,
		guard,
		type: a.type,
		durationMs: typeof a.durationMs === "number" ? a.durationMs : null,
		timeoutMs: typeof a.timeoutMs === "number" ? a.timeoutMs : null,
		exitCode: typeof a.exitCode === "number" ? a.exitCode : null,
		pricedAs,
	};
}

/**
 * A guard key's script file: its first word, as guardKey writes it.
 *
 * @param {string} key
 */
function guardName(key) {
	const space = key.indexOf(" ");
	return space === -1 ? key : key.slice(0, space);
}

/**
 * What a guard lost on a call is priced as, [] where it could not have denied
 * it. guardKey appends the arguments that distinguish two registrations of
 * one script; the file is the first word. The dispatcher is priced as the
 * cores able to deny that it ran on the call, none where it ran none, and as
 * itself where the transcript no longer holds the call (#3272).
 * @typedef {(guard: string, toolUseID: string) => string[]} PriceOf
 *
 * @param {string[]} dirs
 * @param {Map<string, {name: string, input: unknown}>} calls
 * @param {string} root the session's repo, whose config disables cores
 * @returns {PriceOf}
 */
function priceIn(dirs, calls, root) {
	const isDenyCapable = isDenyCapableIn(dirs);
	const host = coreHost(root);
	return (guard, toolUseID) => {
		const name = guardName(guard);
		if (!isDenyCapable(name)) return [];
		const call = calls.get(toolUseID);
		if (name !== path.basename(DISPATCH_ENTRY) || !call) return [guard];
		return denyingCoresOn(
			{ tool_name: call.name, tool_input: call.input },
			host,
		);
	};
}

/**
 * Every tool call in this transcript, by its id.
 *
 * `stats` is `lossesIn`'s, and for the same reason: a call recorded on an
 * unparseable line is absent from this map, and `replay` reports that as "not a
 * tool call in this file" unless it is told to say otherwise (mantahostels#3311).
 *
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @param {{skipped: number}} [stats]
 * @returns {Map<string, {name: string, input: unknown}>}
 */
function toolCallsIn(text, tier, stats) {
	/** @type {Map<string, {name: string, input: unknown}>} */
	const calls = new Map();
	for (const record of mainChainRecords(text, tier, stats)) {
		if (record?.type !== "assistant") continue;
		const content = record.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
			calls.set(block.id, {
				name: typeof block.name === "string" ? block.name : "?",
				input: block.input,
			});
		}
	}
	return calls;
}

/**
 * How one guard came to be lost, in the words its record supports. A cancelled
 * hook was killed mid-call; a `hook_non_blocking_error` one RAN and exited
 * non-zero, which is a different fact and reads wrongly as "killed".
 * @param {Loss} l
 * @returns {string}
 */
function howItWent(l) {
	if (l.type === "hook_non_blocking_error")
		return `${l.guard} ran and exited ${l.exitCode === null ? "non-zero" : String(l.exitCode)}`;
	if (l.durationMs !== null && l.timeoutMs !== null)
		return `${l.guard} was cancelled after ${l.durationMs} ms against a ${l.timeoutMs} ms timeout`;
	return `${l.guard} did not complete`;
}

/**
 * One line pricing what a call lost.
 * @param {string} lost a guard's key, or a core's name
 * @returns {string}
 */
function describeLost(lost) {
	return guardName(lost) === path.basename(DISPATCH_ENTRY)
		? `${lost}: its tool call is not in this transcript, so which cores it ran is UNKNOWN — treat it as worth replaying.`
		: denyRates.describe(lost);
}

/**
 * The block's text: one stanza per tool call, each naming the guards lost on it
 * and the command that re-runs them against the same payload.
 *
 * @param {Loss[]} fresh
 * @param {Map<string, {name: string, input: unknown}>} calls
 * @param {string} transcript
 * @param {number} [skipped] unparseable lines in the read this list came from
 * @returns {string}
 */
function reportFor(fresh, calls, transcript, skipped = 0) {
	/** @type {Map<string, Loss[]>} */
	const byCall = new Map();
	for (const loss of fresh) {
		const at = byCall.get(loss.toolUseID) ?? [];
		at.push(loss);
		byCall.set(loss.toolUseID, at);
	}

	const lostBy = new Map(
		[...byCall.entries()].map(([id, group]) => [
			id,
			[...new Set(group.flatMap((l) => l.pricedAs))],
		]),
	);

	const stanzas = [...byCall.entries()].map(([id, group]) => {
		const guards = [...new Set(group.map((l) => l.guard))];
		const timing = group.map(howItWent).join("; ");
		const lost = lostBy.get(id) ?? [];
		const together = lost.length > 1 ? denyRates.describeTogether(lost) : null;
		return [
			`${guards.join(", ")} — lost on ${describeCall(calls.get(id))}`,
			`  ${timing}.`,
			...lost.map((g) => `  ${describeLost(g)}`),
			...(together ? [`  ${together}`] : []),
			"  Re-run it against that same payload:",
			`    node ${scriptPath("guard-lost-deny.js")} replay ${transcript} ${id}`,
		].join("\n");
	});

	const n = byCall.size;
	const worth = [...lostBy.values()].filter((lost) =>
		denyRates.isWorthReplaying(lost),
	).length;
	let worthWhich = `${worth} of ${n} are`;
	if (worth === n) worthWhich = n === 1 ? "This one is" : `All ${n} are`;
	return [
		`${n === 1 ? "A deny guard" : `A deny guard on each of ${n} tool calls`} FAILED OPEN — the act it judges went through unchecked, and nothing else in this session says so.`,
		"",
		...stanzas,
		"",
		worth === 0
			? "No guard here denies often enough to make a replay worth a turn on the measured rates; replay one anyway if the act it judged matters to you."
			: `${worthWhich} worth the replay. Read the verdict: if it denies, undo the act; if it allows, carry on.`,
		`Each tool call is named here once, and this guard costs at most ${hookBlock.MAX_BLOCKS} turns a session.`,
		...(skipped
			? [
					`${skipped} line(s) of the transcript would not parse and were skipped, so a loss recorded on one is missing from this list — and a later Stop will not recover it.`,
				]
			: []),
		denyRates.PROVENANCE,
	].join("\n");
}

/**
 * EVERY PATH BELOW FAILS OPEN AND LEAVES A BREADCRUMB (mantahostels#1731, on the house rule
 * at mantahostels#103 §6 — breaking a session is worse than missing one). The two paths that
 * do not appear here — an unparseable payload and a missing session id — are
 * `lib/stop-guard.js`'s, and crumb the same vocabulary from there.
 *
 * @param {{sessionId: string, payload: Payload, root: string,
 *   note: (outcome: string, payload?: Payload) => void}} ctx
 * @returns {boolean} whether a block was emitted
 */
function review({ sessionId: sid, payload, root, note }) {
	const file = sessionTranscript.resolve(payload, sid);
	if (!file) {
		note("no-transcript", payload);
		return false;
	}

	let text;
	try {
		text = sessionTranscript.read(file);
	} catch {
		note("unreadable-transcript", payload);
		return false;
	}

	const tier = isSubagentTranscript(file) ? "subagent" : "main";
	const stats = { skipped: 0 };
	let losses;
	let calls;
	try {
		calls = toolCallsIn(text, tier);
		losses = lossesIn(
			text,
			tier,
			priceIn(guardDirs(coreRoot(), root), calls, root),
			stats,
		);
	} catch {
		note("unreadable-transcript", payload);
		return false;
	}
	if (losses.length === 0) {
		/* Read the transcript and found no lost deny — a verdict, not a failure
		 * to reach one. Spelled `no-finding` rather than `empty-message`, which in
		 * every other guard means there was no text to read at all (mantahostels#2545). */
		note("no-finding", payload);
		return false;
	}
	note("message", payload);

	/* Already continuing because some Stop hook blocked: a second demand on the
	 * same turn teaches neither. Tested after the read so that every invocation
	 * leaves exactly one breadcrumb. */
	if (payload?.stop_hook_active === true) return false;

	return reportOnce({
		root,
		sessionId: sid,
		seenPrefix: SEEN_PREFIX,
		items: losses,
		idOf: (l) => l.toolUseID,
		block: (fresh) =>
			hookBlock.blockStop({
				prefix: ".lost-deny-nagged-",
				sessionId: sid,
				reason: reportFor(fresh, calls, file, stats.skipped),
			}),
	});
}

/**
 * The transcript's session id: the last one any main-chain record carries, or "".
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {string}
 */
function lastSessionId(text, tier) {
	let sessionId = "";
	for (const record of mainChainRecords(text, tier)) {
		if (typeof record?.sessionId === "string") sessionId = record.sessionId;
	}
	return sessionId;
}

/**
 * Run one lost guard on the reconstructed payload, printing what it said.
 * @param {string} guard the guard's key, as `guardKey` gives it
 * @param {string} payload
 * @param {string[]} dirs where to find it, as `guardDirs` gives them
 * @returns {boolean} whether it denied the call
 */
function replayGuard(guard, payload, dirs) {
	const name = guardName(guard);
	const args = guard.split(" ").slice(1);
	process.stdout.write(`\n=== ${guard} ===\n`);
	/* `lossesIn` admitted it on reading it there, so only a file removed since
	 * lands here. */
	const script = guardPath(name, dirs);
	if (!script) {
		process.stdout.write("could not run it: the file is gone\n");
		return false;
	}
	/* guardKey throws the `node` prefix away with the rest of the wrapper, so
	 * a .js guard spawned on its own path would need an exec bit it has no
	 * reason to carry. */
	const [bin, argv] = name.endsWith(".js")
		? [process.execPath, [script, ...args]]
		: [script, args];
	const run = spawnSync(bin, argv, { input: payload, encoding: "utf8" });
	if (run.error) {
		process.stdout.write(`could not run it: ${run.error.message}\n`);
		return false;
	}
	process.stdout.write(run.stdout || "");
	if (run.stderr) process.stdout.write(run.stderr);
	process.stdout.write(
		run.status === null ? `killed by ${run.signal}\n` : `exit ${run.status}\n`,
	);
	/* A PreToolUse deny is a JSON verdict on stdout, not an exit code. */
	return /"permissionDecision"\s*:\s*"deny"/.test(run.stdout || "");
}

/**
 * Re-run every deny-capable guard that was killed on one tool call, against the
 * payload the harness would have handed it.
 *
 * THE PAYLOAD IS RECONSTRUCTED, NOT REPLAYED FROM A RECORDING: the harness keeps
 * no copy of what it piped into a hook, so this rebuilds the four fields the
 * PreToolUse guards read (`lib/guard-entry.js`) out of the tool_use
 * record and the transcript's own session id. A guard reading a field outside
 * that set sees it empty and, by its own fail-open contract, allows.
 *
 * THE GUARDS RUN FOR REAL, side effects and all — a rule-injection latch, a poll
 * counter. That is the point: the verdict is what was lost, and a guard that
 * only pretended to run would be the same silence again.
 *
 * @param {string[]} argv `[transcriptPath, toolUseID]`
 * @returns {number} an exit code
 */
function replay(argv) {
	const [file, toolUseID] = argv;
	if (!file || !toolUseID) {
		process.stderr.write(
			"usage: node " +
				scriptPath("guard-lost-deny.js") +
				" replay <transcript> <toolUseID>\n",
		);
		return 2;
	}

	let text;
	try {
		text = sessionTranscript.read(file);
	} catch (e) {
		process.stderr.write(`cannot read ${file}: ${caught(e).message}\n`);
		return 2;
	}

	const root = hookBlock.repoRoot();
	const dirs = guardDirs(coreRoot(), root);
	const tier = isSubagentTranscript(file) ? "subagent" : "main";
	const stats = { skipped: 0 };
	/* Both "not found" exits below are indistinguishable from "found nothing"
	 * unless the incomplete read is named, and the reader's next move differs:
	 * read the file at that line, rather than hunt a mistyped id (mantahostels#3311). */
	const partial = () =>
		stats.skipped
			? ` (${stats.skipped} line(s) of it would not parse and were skipped, so the call may be there and unreadable.)`
			: "";
	const calls = toolCallsIn(text, tier, stats);
	const call = calls.get(toolUseID);
	if (!call) {
		process.stderr.write(
			`${toolUseID} is not a tool call in ${file}${partial()}\n`,
		);
		return 2;
	}
	/* Reset: the two reads walk the same text, so an unreset counter would have
	 * `partial()` report every skipped line twice. */
	stats.skipped = 0;
	const guards = [
		...new Set(
			lossesIn(text, tier, priceIn(dirs, calls, root), stats)
				.filter((l) => l.toolUseID === toolUseID)
				.map((l) => l.guard),
		),
	];
	if (guards.length === 0) {
		process.stderr.write(
			`no deny-capable guard was lost on ${toolUseID}${partial()}\n`,
		);
		return 2;
	}

	const payload = `${JSON.stringify({
		session_id: lastSessionId(text, tier),
		hook_event_name: "PreToolUse",
		transcript_path: file,
		cwd: root,
		tool_name: call.name,
		tool_input: call.input,
	})}\n`;

	let denied = 0;
	for (const guard of guards) {
		if (replayGuard(guard, payload, dirs)) denied++;
	}
	process.stdout.write(
		denied > 0
			? `\n${denied} of ${guards.length} DENY this call. Undo it.\n`
			: `\nNone of the ${guards.length} lost guard(s) deny this call.\n`,
	);
	return 0;
}

/* cli-args-exempt: the hook path takes no argv and must fail open, where a
 * parseOrExit refusal exits 2, a Stop block; `replay` checks its own two. */
if (require.main === module) {
	if (process.argv[2] === "replay")
		process.exitCode = replay(process.argv.slice(3));
	else stopGuard.onPayload({ review, record: true });
}
