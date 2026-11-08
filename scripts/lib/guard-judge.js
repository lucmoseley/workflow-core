/*
 * guard-judge.js — the guard dispatcher's judging (workflow-core#2786, ADR-0010): every
 * core lib/guard-dispatch.js's entry loaded for a call judges its payload,
 * and their answers merge into one hook output. A module apart from that
 * entry, its real caller, so the tests drive it in process (workflow-core#4470).
 *
 * THE MERGE. Every enabled core runs; none stops the rest. The permission is
 * `deny` where any core refused, with every refusal's reason; every core's
 * context that fits is carried, joined in manifest order, each core's rules
 * fitted into what the entry's HOOK_PERSIST_CHARS leaves (vendor hooks
 * reference §PreToolUse decision control, §Add context for Claude). A guard's
 * own text is never cut: a context or prelude longer than that room is
 * dropped whole, its latches unwritten, and a closing notice names each such
 * core (workflow-core#4126). A rule fragment over the room is deferred to its next trigger,
 * unlatched and unnamed. The merged context stays inside the cap: the
 * notice's room is set aside where something drops, and the notice naming
 * every core fits HOOK_PERSIST_CHARS. A core's `updatedInput` rides on an
 * `allow`, and reaches the session only where no core refused. On
 * PostToolUse the merge is written in that event's own control: a deny is
 * `decision: "block"` (lib/hook-envelope.js).
 *
 * FAILURE POLICY. A core's throw, or its module's while loading (workflow-core#4125), gets
 * its row's `failure`: `open` allows, logged; `closed` refuses, but for a
 * core's own throw on the repo not resolving, which allows, logged, as
 * lib/refuse-on-throw.js's entries do. A store fault refuses whatever the
 * policy (mantahostels#1762). There is no per-core time budget: a core does
 * no I/O, and every adapter that spawns carries its own timeout, cut to what
 * the entry's budget leaves (lib/hook-deadline.js): each git and gh call's by
 * lib/git.js and lib/gh.js, the other spawns' by their hosts, and
 * npm-install's registry budget runs from the entry's start. An adapter
 * working in process — the PostToolUse cores' scratch stores and the
 * arbiter's record — carries none: only the entry's timeout bounds a hang
 * there, and it costs every core still to run on that call its say.
 */

const { CORE_FAULT_TEXT } = require("./core-fault.js");
const { caught } = require("./caught.js");
const { watchRepoFault } = require("./refuse-on-throw.js");
const { withGitReadMemo, withoutGitReadMemo } = require("./git-read-memo.js");
const { hasOwnText, render, subjectFor } = require("./guard-entry.js");
const { kitContext } = require("./kit-context.js");
const { sessionTree } = require("./host-root.js");
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
 *   updatedInput?: Record<string, unknown> }} Output the merged hook output,
 *   hookEventName aside
 * @typedef {import("./guard-host-ports.js").TreePorts} TreePorts
 * @typedef {import("./guard-host-ports.js").Adapters} Adapters
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 */

/** What joins two reasons or two contexts, counted against the persist room. */
const JOIN = "\n\n";

/**
 * The parts merged into one hook output; null where none says anything.
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
 *   env: import("./kit-context.js").PortEnv }} Answer a core's decision, not yet
 *   rendered
 * @typedef {{ part?: Part, answer?: Answer }} Judgement
 * @typedef {{ part?: Part, latchSet?: LatchSet, overRoom?: boolean }} Outcome
 * @typedef {{ parts: Part[], latches: LatchSet[], dropped: string[] }} Fitted
 */

/**
 * Run every enabled core on one payload and merge what they answer.
 * @param {Core[]} cores
 * @param {DispatchEnv} env
 * @returns {{ output: Output | null, latches: LatchSet[] }}
 */
function dispatch(cores, env) {
	/* post-write's formatter changes files between the reads of its call. */
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
 * Enough to name every core with text of its own, as the reserve can push more
 * of them out; none where a silent trial fit drops nothing.
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
			env: { ...answer.env, log: () => undefined },
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
 * What the entry has left once `used` characters and a separator are spent.
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
 * The session tree's ports for one call, resolved once on first use from the
 * payload's `cwd`, else the hook's own directory; an unresolved tree throws
 * the same fault on every read of the call, from one git call. The host's own
 * ports are reused where the two are one tree.
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
	const cwd =
		typeof payload.cwd === "string" && payload.cwd
			? payload.cwd
			: (adapters.fallbackCwd ?? process.cwd());
	const dir = sessionTree({ cwd });
	if (dir === null) return { fault: new TreeUnresolved(cwd) };
	return { ports: dir === root ? adapters : treePorts(dir) };
}

/**
 * One core judged: the part its fault makes, or its decision to render.
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
		/* Fails open, logged (ADR-0010, workflow-core#2784). */
		log(
			`no ${[core.field].flat().join(" or ")} in payload — ${core.noun} allowed unchecked`,
		);
		return {};
	}
	let decision;
	/** @type {{ ctx: CoreContext, isRepoFault: (e: unknown) => boolean } | undefined} */
	let watched;
	try {
		const own = core.host
			? require(corePath(core.host)).buildHostPorts(root, log)
			: {};
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
			/* The repo unresolved: no tree is the shared one (mantahostels#147). */
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
 * A core's decision as a part of the merge, with the latches it owes.
 * @param {Answer} answer
 * @param {() => number} room read only where the core speaks, so a call no core
 *   speaks to never loads the cap's reader
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
 * A core's throw, given its row's policy.
 * @param {Core} core
 * @param {string} msg
 * @param {(what: string) => void} log
 * @returns {Part | undefined}
 */
function thrown(core, msg, log) {
	if (core.failure !== "closed") {
		/* An advisory core fails open on the record (ADR-0010, workflow-core#2784). */
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
