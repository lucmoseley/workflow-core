/*
 * guard-dispatch.js — the dispatcher kit: every always-on guard of one hook
 * event runs as a core inside one Node entry, scripts/guard-dispatch.js
 * (#2786, ADR-0010). The guard dispatcher, not subagent dispatch
 * (lib/dispatch-*.js). A plain call starts one Node process for them, and every
 * deny and every context still reaches the session as separate hooks would
 * deliver them.
 *
 * THE CORES are lib/guard-cores.json's, per event, in order: each row names
 * the core (its `name` is what `disabled` lists and the error log names), the
 * module under scripts/lib that holds its `field`, `noun`, `decide` and any
 * `top` (the shape lib/guard-entry.js's `run` takes), the tools it judges as a matcher
 * regex, its failure policy, the module that gates it, if any, the module
 * whose `buildHostPorts(root, log)` builds the ports of its own, if any, built only
 * where the core runs, and any `if` clauses narrowing the Bash commands it
 * judges, so a call none admits never loads its module (#3224).
 *
 * THE MERGE. Every enabled core runs; none stops the rest. The permission is
 * the strongest any core gave, PreToolUse's `deny` > `defer` > `ask` >
 * `allow`, with every reason at that strength; every core's context is
 * carried, joined in manifest order, each core's rules fitted into what the
 * entry's HOOK_PERSIST_CHARS leaves (vendor hooks reference §PreToolUse
 * decision control, §Add context for Claude). A guard's own text is never
 * cut. A core's `updatedInput` rides on an
 * `allow`, and reaches the session only where `allow` is the merged strength:
 * any core's `ask`, `defer` or `deny` drops it. On PostToolUse the merge is
 * written in that event's own control: a deny is `decision: "block"`
 * (lib/hook-envelope.js).
 *
 * FAILURE POLICY. A core's throw gets its row's `failure`: `open` allows,
 * logged; `closed` refuses, but for the repo not resolving, which allows,
 * logged, as lib/refuse-on-throw.js's entries do. A store fault refuses whatever the policy
 * (mantahostels#1762). Anything else that throws here
 * crashes the entry, and the registration's `"onFailure": "block"` refuses the
 * call. There is no per-core time budget: a core does no I/O, and every
 * adapter that spawns carries its own timeout. The shared git reader's and
 * branch-publish's are cut to what the entry's budget leaves, and
 * npm-install's registry budget runs from the entry's start
 * (lib/hook-deadline.js); the other hosts' reads are not cut. An adapter working in process — the
 * PostToolUse cores' scratch stores and the arbiter's record — carries none:
 * only the entry's timeout bounds a hang there, and it costs every core still
 * to run on that call its say.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { watchRepoFault } = require("./refuse-on-throw.js");
const { gitOutcome, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { budgetMs, startEntryClock } = require("./hook-deadline.js");
const { guardDisabled } = require("./workflow-core-config.js");
const {
	emit,
	guardFile,
	render,
	subjectFor,
	writeLatches,
} = require("./guard-entry.js");
const { logger, readPayload } = require("./entry-input.js");
const { kitContext, sharedReaders } = require("./kit-context.js");
const { hostRoot } = require("./host-root.js");
const {
	admits,
	corePath,
	dispatchRows,
	isCoreFor,
} = require("./guard-cores.js");

/**
 * @typedef {import("./kit-context.js").KitContext} KitContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./guard-entry.js").Latch} Latch
 * @typedef {import("./workflow-core-config.js").Module} Module
 * @typedef {import("./guard-cores.js").CoreRow} CoreRow
 * @typedef {(NonNullable<Decision> & { updatedInput?: Record<string, unknown> }) | null} CoreDecision
 *   a guard decision, a context under the persist room; either beside a
 *   context may carry the tool input the call runs with instead, allowed
 *   (vendor §PreToolUse decision control)
 * @typedef {CoreRow & { field: string | string[], noun: string, top?: boolean,
 *   decide: (subject: string, ctx: CoreContext) => CoreDecision }} Core
 * @typedef {"deny" | "defer" | "ask" | "allow"} Permission
 * @typedef {{ permissionDecision?: Permission, reason?: string,
 *   context?: string, updatedInput?: Record<string, unknown> }} Part
 * @typedef {{
 *   root: string,
 *   git: import("./git.js").GitReader,
 *   readText: (rel: string) => string | null,
 *   repoRel: (file: string) => string | null,
 *   exists: (p: string) => boolean,
 *   isFile: (p: string) => boolean,
 *   env: Record<string, string | undefined>,
 * }} CorePorts the dispatcher core contract its production adapters fill
 *   (#2786), the ports a core reads beyond the kit's: the host
 *   root; git, one call per distinct argument list; a repo-relative file's
 *   text, null where it is absent; a path's spelling under the root; whether
 *   a path exists, and whether it is a regular file; and the environment the
 *   entry was run in
 * @typedef {Pick<KitContext, "moduleOn" | "treeClass"> & CorePorts} Adapters
 * @typedef {KitContext & CorePorts & { session: string }} CoreContext
 *   `session` is the payload's session id, "" where it carries none
 */

const PRECEDENCE = /** @type {const} */ (["deny", "defer", "ask", "allow"]);

/** What joins two reasons or two contexts, counted against the persist room. */
const JOIN = "\n\n";

/**
 * The cores of `event`'s rows that `keep` passes, each row filtered before its
 * module is required, so a call loads only the cores that can fire on it
 * (#3141).
 * @param {string} event
 * @param {(row: CoreRow) => boolean} [keep]
 * @returns {Core[]}
 */
function loadCores(event, keep = () => true) {
	return dispatchRows(event)
		.filter(keep)
		.map((row) => ({
			...row,
			...require(corePath(row.core)),
		}));
}

/**
 * The parts merged into one hook output; null where none says anything.
 * @param {Part[]} parts
 * @returns {Record<string, unknown> | null}
 */
function merge(parts) {
	/** @type {Record<string, unknown>} */
	const out = {};
	const top = PRECEDENCE.find((p) =>
		parts.some((x) => x.permissionDecision === p),
	);
	if (top) {
		out.permissionDecision = top;
		const reasons = parts
			.filter((x) => x.permissionDecision === top && x.reason)
			.map((x) => x.reason);
		if (reasons.length > 0) out.permissionDecisionReason = reasons.join(JOIN);
		const rewrite = parts.find((x) => x.updatedInput)?.updatedInput;
		if (top === "allow" && rewrite) out.updatedInput = rewrite;
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
 */

/**
 * Run every enabled core on one payload and merge what they answer.
 * @param {Core[]} cores
 * @param {DispatchEnv} env
 * @returns {{ output: Record<string, unknown> | null, latches: LatchSet[] }}
 */
function dispatch(cores, env) {
	const { payload, adapters, disabled } = env;
	const tool = toolOf(payload);
	/** @type {Part[]} */
	const parts = [];
	/** @type {LatchSet[]} */
	const latches = [];
	let used = 0;
	for (const core of cores) {
		if (!isCoreFor(core, tool) || !admits(core, payload)) continue;
		if (disabled(core.name)) continue;
		if (core.module && !adapters.moduleOn(core.module)) continue;
		const spent = used;
		const room = () => persistRoom(env.persistChars(), spent);
		const { part, latchSet } = runCore(core, env, room);
		if (!part) continue;
		parts.push(part);
		if (part.context) used = persistUsed(used, part.context);
		if (latchSet) latches.push(latchSet);
	}
	return { output: merge(parts), latches };
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string | undefined}
 */
const toolOf = (payload) =>
	typeof payload.tool_name === "string" ? payload.tool_name : undefined;

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
 * One core's answer as a part of the merge, with the latches it owes.
 * @param {Core} core
 * @param {DispatchEnv} env
 * @param {() => number} room read only where the core injects, so a call no
 *   core speaks to never loads the cap's reader
 * @returns {{ part?: Part, latchSet?: LatchSet }}
 */
function runCore(core, { payload, root, adapters, logFor }, room) {
	const log = logFor(core.name);
	const subject = subjectFor(payload, core);
	if (subject === null) {
		/* Fails open, logged (ADR-0010, #2784). */
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
			{ ...adapters, session, ...own },
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
	return decision ? answered(decision, core, { payload, root, log }, room) : {};
}

/**
 * A core's non-null decision as a part of the merge.
 * @param {NonNullable<CoreDecision>} decision
 * @param {Core} core
 * @param {import("./kit-context.js").PortEnv} env
 * @param {() => number} room
 * @returns {{ part?: Part, latchSet?: LatchSet }}
 */
function answered(decision, core, env, room) {
	const r = render(decision, { ...env, name: core.name, room });
	if (r.launch) {
		env.log("a dispatcher core answered a launch — dropped");
		return {};
	}
	const latchSet = { latches: r.latches, log: env.log };
	if (r.deny)
		return { part: { permissionDecision: "deny", reason: r.deny }, latchSet };
	const rewrite = decision.updatedInput
		? {
				permissionDecision: /** @type {const} */ ("allow"),
				updatedInput: decision.updatedInput,
			}
		: {};
	const part = { ...(r.context ? { context: r.context } : {}), ...rewrite };
	return Object.keys(part).length > 0 ? { part, latchSet } : { latchSet };
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
		/* An advisory core fails open on the record (ADR-0010, #2784). */
		log(`core threw — allowed unchecked: ${msg}`);
		return;
	}
	log(`core threw — refused: ${msg}`);
	return {
		permissionDecision: "deny",
		reason: `${core.name} could not judge this call, and it fails closed: ${msg}`,
	};
}

/**
 * The adapters every core of one call shares.
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {Adapters}
 */
function hostAdapters(root, log) {
	/** @type {Map<string, import("./git.js").GitRead>} */
	const seen = new Map();
	return {
		...sharedReaders(root, log),
		root,
		git: (args, noMatch) => {
			const key = JSON.stringify([args, noMatch]);
			let r = seen.get(key);
			if (!r) {
				r = gitOutcome(args, noMatch, root, budgetMs(HOOK_GIT_TIMEOUT_MS));
				seen.set(key, r);
			}
			return r;
		},
		readText: (rel) => {
			try {
				return fs.readFileSync(path.join(root, rel), "utf8");
			} catch (e) {
				if (caught(e).code === "ENOENT") return null;
				throw e;
			}
		},
		repoRel: (file) => repoRel(file, root),
		exists: (p) => fs.existsSync(p),
		isFile: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
		env: process.env,
	};
}

/**
 * An absolute path's spelling under `root`, null where it is
 * relative or lies outside. A path not under `root` as spelled is retried with
 * its longest existing ancestor's symlinks resolved, so a write spelled
 * through a link to the checkout is still the checkout's (#2553).
 * @param {string} file
 * @param {string} root symlink-resolved
 * @returns {string | null}
 */
function repoRel(file, root) {
	if (!path.isAbsolute(file)) return null;
	/** @param {string} p */
	const under = (p) => {
		const rel = path.relative(root, p);
		return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
	};
	const abs = path.resolve(file);
	const direct = under(abs);
	if (direct !== null) return direct;
	let dir = abs;
	let tail = "";
	for (;;) {
		try {
			return under(path.join(fs.realpathSync(dir), tail));
		} catch {
			if (dir === path.dirname(dir)) return null;
			tail = path.join(path.basename(dir), tail);
			dir = path.dirname(dir);
		}
	}
}

/**
 * The hook entry. `only` runs that core alone, for a hook that hands one
 * core a payload of its own making (inject-tracker-docs.sh's typed
 * /code-review, #1697); a name no core of the event carries runs none, logged.
 * @param {string} [only]
 */
function runDispatch(only) {
	startEntryClock();
	const root = hostRoot(process.cwd(), { timeoutMs: HOOK_GIT_TIMEOUT_MS });
	if (guardDisabled(guardFile(), { root })) return;
	const entryLog = logger(guardFile(), root);
	const payload = readPayload("call", entryLog);
	if (!payload) return;
	const event = String(payload.hook_event_name ?? "");
	const tool = toolOf(payload);
	/* dispatch judges each core again; this filter only spares the load. */
	const cores = loadCores(
		event,
		(row) =>
			isCoreFor(row, tool) &&
			admits(row, payload) &&
			(only === undefined || row.name === only),
	);
	if (
		only !== undefined &&
		cores.length === 0 &&
		!dispatchRows(event).some((r) => r.name === only)
	)
		entryLog(`--only names no ${event} core: ${only} — nothing run`);
	const { output, latches } = dispatch(cores, {
		payload,
		root,
		adapters: hostAdapters(root, entryLog),
		logFor: (name) => logger(name, root),
		disabled: (name) => guardDisabled(name, { root }),
		persistChars: () => require("./rule-emission.js").readHookPersistChars(),
	});
	if (output)
		emit(/** @type {import("./guard-entry.js").HookEvent} */ (event), output);
	for (const { latches: l, log } of latches)
		writeLatches({ root, payload, log }, l);
}

module.exports = {
	dispatch,
	hostAdapters,
	loadCores,
	merge,
	repoRel,
	runDispatch,
};
