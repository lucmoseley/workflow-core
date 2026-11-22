#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { withoutLateEpipe } = require("./lib/child-failure.js");
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
 * @typedef {{session_id?: string, hook_event_name?: string,
 *   transcript_path?: string, stop_hook_active?: unknown}} Payload
 */

/**
 * @typedef {{toolUseID: string, guard: string, type: string,
 *   durationMs: number|null, timeoutMs: number|null,
 *   exitCode: number|null, pricedAs: string[]}} Loss
 */

const FAILURE_TYPES = new Set(["hook_cancelled", "hook_non_blocking_error"]);

const DENY_EVENT = "PreToolUse";

const SEEN_PREFIX = ".lost-deny-seen-";

/**
 * @param {string} text
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
 * @param {import("./lib/transcript.js").TranscriptRecord} record
 * @param {PriceOf} priceOf
 * @returns {Loss | null}
 */
function lossOf(record, priceOf) {
	const a = record?.attachment;
	if (!a || !FAILURE_TYPES.has(a.type)) return null;
	if (typeof a.command !== "string" || !a.command) return null;
	if (typeof a.toolUseID !== "string" || !a.toolUseID) return null;
	if (a.hookEvent !== DENY_EVENT) return null;
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
 * @param {string} key
 */
function guardName(key) {
	const space = key.indexOf(" ");
	return space === -1 ? key : key.slice(0, space);
}

/**
 * @typedef {(guard: string, toolUseID: string) => string[]} PriceOf
 *
 * @param {string[]} dirs
 * @param {Map<string, {name: string, input: unknown}>} calls
 * @param {string} root
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
 * @param {string} lost
 * @returns {string}
 */
function describeLost(lost) {
	return guardName(lost) === path.basename(DISPATCH_ENTRY)
		? `${lost}: its tool call is not in this transcript, so which cores it ran is UNKNOWN — treat it as worth replaying.`
		: denyRates.describe(lost);
}

/**
 * @param {Loss[]} fresh
 * @param {Map<string, {name: string, input: unknown}>} calls
 * @param {string} transcript
 * @param {number} [skipped]
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
 * @param {{sessionId: string, payload: Payload, root: string,
 *   note: (outcome: string, payload?: Payload) => void}} ctx
 * @returns {boolean}
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
		// lucmoseley/mantahostels#2545
		note("no-finding", payload);
		return false;
	}
	note("message", payload);

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
 * @param {string} guard
 * @param {string} payload
 * @param {string[]} dirs
 * @returns {boolean}
 */
function replayGuard(guard, payload, dirs) {
	const name = guardName(guard);
	const args = guard.split(" ").slice(1);
	process.stdout.write(`\n=== ${guard} ===\n`);
	const script = guardPath(name, dirs);
	if (!script) {
		process.stdout.write("could not run it: the file is gone\n");
		return false;
	}
	const [bin, argv] = name.endsWith(".js")
		? [process.execPath, [script, ...args]]
		: [script, args];
	// #3794
	const run = withoutLateEpipe(
		spawnSync(bin, argv, { input: payload, encoding: "utf8" }),
	);
	if (run.error) {
		process.stdout.write(`could not run it: ${run.error.message}\n`);
		return false;
	}
	process.stdout.write(run.stdout || "");
	if (run.stderr) process.stdout.write(run.stderr);
	process.stdout.write(
		run.status === null ? `killed by ${run.signal}\n` : `exit ${run.status}\n`,
	);
	// #3580
	return (
		run.status === 2 ||
		/"permissionDecision"\s*:\s*"deny"/.test(run.stdout || "")
	);
}

/**
 * @param {string[]} argv
 * @returns {number}
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

// cli-args-exempt: #1017
if (require.main === module) {
	if (process.argv[2] === "replay")
		process.exitCode = replay(process.argv.slice(3));
	else stopGuard.onPayload({ review, record: true });
}
