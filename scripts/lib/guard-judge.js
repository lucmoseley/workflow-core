// code-edges loads: guard-cores.json host

const { noop } = require("./noop.js");
const { CORE_FAULT_TEXT } = require("./core-fault.js");
const { caught } = require("./caught.js");
const { watchRepoFault } = require("./refuse-on-throw.js");
const { withGitReadMemo, withoutGitReadMemo } = require("./git-read-memo.js");
const { hasOwnText, render, subjectFor } = require("./guard-entry.js");
const { kitContext } = require("./kit-context.js");
const { sessionDir, sessionTree } = require("./host-root.js");
const { TreeUnresolved } = require("./tree-or.js");
const { corePath, isDispatchedOn } = require("./guard-cores.js");
const { treePorts } = require("./guard-host-ports.js");

/**
 * @typedef {import("./guard-entry.js").Latch} Latch
 * @typedef {import("./core-contract.js").CoreDecision} CoreDecision
 * @typedef {import("./core-contract.js").Core} Core
 * @typedef {"deny" | "allow"} Permission
 * @typedef {{ permissionDecision: "deny", reason: string, context?: undefined,
 *   updatedInput?: undefined } | { permissionDecision?: "allow",
 *   context?: string, updatedInput?: Record<string, unknown> }} Part
 * @typedef {{ permissionDecision?: Permission,
 *   permissionDecisionReason?: string, additionalContext?: string,
 *   updatedInput?: Record<string, unknown> }} Output
 * @typedef {import("./guard-host-ports.js").TreePorts} TreePorts
 * @typedef {import("./guard-host-ports.js").Adapters} Adapters
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 */

const JOIN = "\n\n";

/**
 * @param {Part[]} parts
 * @returns {Output | null}
 */
function merge(parts) {
	/** @type {Output} */
	const out = {};
	const reasons = parts.flatMap((x) =>
		x.permissionDecision === "deny" ? [x.reason] : [],
	);
	if (reasons.length > 0) {
		out.permissionDecision = "deny";
		out.permissionDecisionReason = reasons.join(JOIN);
	} else if (parts.some((x) => x.permissionDecision === "allow")) {
		out.permissionDecision = "allow";
		const rewrite = parts.find((x) => x.updatedInput)?.updatedInput;
		if (rewrite) out.updatedInput = rewrite;
	}
	const context = parts.flatMap((x) => (x.context ? [x.context] : []));
	if (context.length > 0) out.additionalContext = context.join(JOIN);
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * @typedef {{ payload: Record<string, unknown>, root: string,
 *   adapters: Adapters,
 *   logFor: (name: string) => (what: string, detail?: string) => void,
 *   disabled: (name: string) => boolean, persistChars: () => number }} DispatchEnv
 * @typedef {{ latches: Latch[], log: (what: string) => void }} LatchSet
 * @typedef {{ decision: NonNullable<CoreDecision>, name: string,
 *   env: import("./kit-context.js").PortEnv }} Answer
 * @typedef {{ part?: Part, answer?: Answer }} Judgement
 * @typedef {{ part?: Part, latchSet?: LatchSet, overRoom?: boolean }} Outcome
 * @typedef {{ parts: Part[], latches: LatchSet[], dropped: string[] }} Fitted
 */

/**
 * @param {Core[]} cores
 * @param {DispatchEnv} env
 * @returns {{ output: Output | null, latches: LatchSet[] }}
 */
function dispatch(cores, env) {
	// #4127
	const scoped =
		env.payload.hook_event_name === "PostToolUse"
			? withoutGitReadMemo
			: withGitReadMemo;
	return scoped(() => judgeAndMerge(cores, env));
}

/**
 * @param {Core[]} cores
 * @param {DispatchEnv} env
 * @returns {{ output: Output | null, latches: LatchSet[] }}
 */
function judgeAndMerge(cores, env) {
	const { payload, adapters, disabled } = env;
	const host = { disabled, moduleOn: adapters.moduleOn };
	const tree = lazyTree(payload, adapters, env.root);
	const judged = cores
		.filter((core) => isDispatchedOn(core, payload, host))
		.map((core) => runCore(core, env, tree));
	const reserve = noticeRoom(judged, env.persistChars);
	const { parts, latches, dropped } = fitToCap(
		judged,
		() => env.persistChars() - reserve,
	);
	if (dropped.length > 0) parts.push({ context: overRoomNotice(dropped) });
	return { output: merge(parts), latches };
}

/**
 * @param {Judgement[]} judged
 * @param {() => number} cap
 */
function noticeRoom(judged, cap) {
	const names = judged.flatMap(({ answer }) =>
		answer && hasOwnText(answer.decision) ? [answer.name] : [],
	);
	if (names.length === 0) return 0;
	const silent = judged.map(({ part, answer }) => ({
		part,
		answer: answer && {
			...answer,
			env: { ...answer.env, log: noop },
		},
	}));
	return fitToCap(silent, cap).dropped.length > 0
		? overRoomNotice(names).length + JOIN.length
		: 0;
}

/**
 * @param {Judgement[]} judged
 * @param {() => number} cap
 * @returns {Fitted}
 */
function fitToCap(judged, cap) {
	/** @type {Fitted} */
	const fitted = { parts: [], latches: [], dropped: [] };
	let used = 0;
	for (const { part, answer } of judged) {
		const spent = used;
		/** @type {Outcome} */
		const outcome = answer
			? answered(answer, () => persistRoom(cap(), spent))
			: { part };
		if (answer && outcome.overRoom) fitted.dropped.push(answer.name);
		if (outcome.latchSet) fitted.latches.push(outcome.latchSet);
		if (!outcome.part) continue;
		fitted.parts.push(outcome.part);
		if (outcome.part.context) used = persistUsed(used, outcome.part.context);
	}
	return fitted;
}

/**
 * @param {number} cap
 * @param {number} used
 */
const persistRoom = (cap, used) => cap - used - (used > 0 ? JOIN.length : 0);

/**
 * @param {number} used
 * @param {string} context
 */
const persistUsed = (used, context) =>
	used + (used > 0 ? JOIN.length : 0) + context.length;

/**
 * @param {string[]} names
 */
const overRoomNotice = (names) =>
	`Over the hook context cap, these guards' advice was dropped unread: ${names.join(", ")}.`;

/**
 * @param {Record<string, unknown>} payload
 * @param {Adapters} adapters
 * @param {string} root
 * @returns {() => TreePorts}
 */
function lazyTree(payload, adapters, root) {
	/** @type {{ ports: TreePorts } | { fault: Error } | undefined} */
	let found;
	return () => {
		found ??= resolveTree(payload, adapters, root);
		if ("fault" in found) throw found.fault;
		return found.ports;
	};
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Adapters} adapters
 * @param {string} root
 * @returns {{ ports: TreePorts } | { fault: Error }}
 */
function resolveTree(payload, adapters, root) {
	const cwd = sessionDir(payload, adapters.fallbackCwd);
	const dir = sessionTree({ cwd });
	if (dir === null) return { fault: new TreeUnresolved(cwd) };
	return { ports: dir === root ? adapters : treePorts(dir) };
}

/**
 * @param {Core} core
 * @param {DispatchEnv} env
 * @param {() => TreePorts} tree
 * @returns {Judgement}
 */
function runCore(core, { payload, root, adapters, logFor }, tree) {
	const log = logFor(core.name);
	if ("loadFault" in core) return { part: thrown(core, core.loadFault, log) };
	const subject = subjectFor(payload, core);
	if (subject === null) {
		log(
			`no ${[core.field].flat().join(" or ")} in payload — ${core.noun} allowed unchecked`,
		);
		return {};
	}
	let decision;
	/** @type {{ ctx: CoreContext, isRepoFault: (e: unknown) => boolean } | undefined} */
	let watched;
	try {
		/** @type {import("./core-contract.js").HostBuilder | undefined} */
		const build = core.host && require(corePath(core.host)).buildHostPorts;
		const own = build ? build({ root, log }) : {};
		const session =
			typeof payload.session_id === "string" ? payload.session_id : "";
		/** @type {CoreContext} */
		const ctx = kitContext(
			{ root, payload, log },
			{ ...adapters, session, tree, ...own },
		);
		watched = watchRepoFault(ctx);
		decision = core.decide(subject, watched.ctx);
	} catch (e) {
		if (watched?.isRepoFault(e)) {
			log(caught(e).message);
			return {};
		}
		return { part: thrown(core, caught(e).message, log) };
	}
	return decision
		? { answer: { decision, name: core.name, env: { payload, root, log } } }
		: {};
}

/**
 * @param {Answer} answer
 * @param {() => number} room
 * @returns {Outcome}
 */
function answered({ decision, name, env }, room) {
	const r = render(decision, { ...env, name, room });
	if (r.launch) {
		env.log("a dispatcher core answered a launch — dropped");
		return {};
	}
	const latchSet = { latches: r.latches, log: env.log };
	const { overRoom } = r;
	if (r.deny)
		return {
			part: { permissionDecision: "deny", reason: r.deny },
			latchSet,
			overRoom,
		};
	const rewrite = decision.updatedInput
		? {
				permissionDecision: /** @type {const} */ ("allow"),
				updatedInput: decision.updatedInput,
			}
		: {};
	const part = { ...(r.context ? { context: r.context } : {}), ...rewrite };
	return Object.keys(part).length > 0
		? { part, latchSet, overRoom }
		: { latchSet, overRoom };
}

/**
 * @param {Core} core
 * @param {string} msg
 * @param {(what: string) => void} log
 * @returns {Part | undefined}
 */
function thrown(core, msg, log) {
	if (core.failure !== "closed") {
		log(`core threw — allowed unchecked: ${msg}`);
		return;
	}
	log(`core threw — refused: ${msg}`);
	return {
		permissionDecision: "deny",
		reason: `${core.name} ${CORE_FAULT_TEXT}, and it fails closed: ${msg}`,
	};
}

module.exports = { dispatch };
