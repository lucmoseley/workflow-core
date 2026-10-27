/*
 * guard-entry.js — the kit a Node guard's entry is built from (#2784,
 * ADR-0010). The entry is the composition root: it hands `run` the payload
 * field it judges, its core's `decide` and any ports of its own, and this file
 * owns every read and write around that call, so the core holds no I/O.
 *
 * THE DECISION. `decide(subject, ctx)` answers null to allow, `{ injectRules:
 * [<id>…] }` to hand the session those rules before the call, `{ deny:
 * <reason> }` to refuse it, `{ context: <text> }` to hand it that text as
 * additionalContext, or, on PostToolUse, `{ launch: { script, log } }` to
 * start a scripts/ program detached (#2785). The ids are a literal array at
 * the core's call site, where lib/rule-emission.js and check-guard-registry.js
 * read them.
 *
 * A REFUSAL IS `permissionDecision` JSON ON EXIT 0, never exit 2.
 *
 * FAILURE POLICY. A payload fault, a core that throws and an unreadable latch
 * all fail open, logged to the guard-error log gl_log writes (mantahostels#103),
 * but for an entry run with `onThrow: "refuse"`, whose core's throw refuses.
 * A store fault — a rule the store cannot give, or one too large to emit at
 * all — fails closed (mantahostels#1762).
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const { guardDisabled, moduleReader } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { segment } = require("./review-suffix.js");
const { logger, readPayload } = require("./entry-input.js");

/**
 * @typedef {import("./workflow-core-config.js").Module} Module
 * @typedef {"PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch" | "UserPromptSubmit"} HookEvent
 * @typedef {object} Injection
 * @property {string[]} injectRules the ids, highest priority first
 * @property {string[]} [skip] ids taken out of this call:
 *   still resolved, so one naming nothing is a store fault, and left unlatched
 *   (mantahostels#1805)
 * @property {string} [prelude] the guard's own text, ahead of the fragments in
 *   the same envelope and outside the cap (mantahostels#2369)
 * @property {string} [latchAfter] a `warn.` latch marked told once the
 *   envelope is written (mantahostels#2528)
 * @property {{ name: string, text: string }[]} [latchWrites] latches of the
 *   guard's own, at latchPath, written with the envelope
 * @typedef {{ launch: { script: string, log: string } }} Launch a program
 *   under scripts/, run by node in a session of its own, its output appended
 *   to `log` under the markers directory
 * @typedef {{ context: string, latchWrites?: { name: string, text: string }[] }} Context
 *   text handed the session as additionalContext as it stands, and latches of
 *   the guard's own written once it is out
 * @typedef {{ deny: string, latchWrites?: { name: string, text: string }[] }} Deny
 *   a refusal, and latches of the guard's own written once it is out
 * @typedef {Injection | Deny | Launch | Context | null} Decision
 * @typedef {import("./shell-parse.js").WalkPorts & {
 *   moduleOn: (module: Module) => boolean,
 *   treeClass: (dir: string) => "shared" | "linked" | "other" | "unknown",
 *   log: (what: string, detail?: string) => void,
 *   told: (id: string) => boolean,
 *   readLatch: (name: string) => string | null,
 *   input: Record<string, unknown>,
 *   tool: string | undefined,
 *   response: unknown,
 *   key: { agent: string, sid: string } | null,
 *   agent: string,
 *   agentLabel: string,
 *   permissionMode: string | undefined,
 *   ruleText: (id: string) => string,
 *   corePaths: (text: string) => string,
 *   scriptPath: (name: string) => string,
 *   docPath: (name: string) => string,
 * }} KitContext the walks' ports, so a core hands them straight to
 *   walkCommands and walkGit; the module gate, which reads a config fault as
 *   off and never throws; whether a rule is told; and a read of a
 *   latch of the guard's own, null where it is absent or has no key; the
 *   payload's `tool_input`, `tool_name` and `tool_response`, undefined where
 *   it carries none; agentKey's answer for it; its `agent_id`, which the
 *   harness sets only on a call from inside a subagent, "" where it is absent;
 *   `main` or `a<agent_id>`; its `permission_mode`; a rule's fragment,
 *   throwing where the store cannot give it; and lib/script-path.js's
 *   spellings of a core path as an install reaches it: every one in `text`,
 *   a script's, a doc's
 * @typedef {{ root: string, payload: Record<string, unknown>,
 *   log: (what: string, detail?: string) => void }} PortEnv
 */

/** The entry's file name, as `disabled` lists it and the error log names it. */
function guardFile() {
	return path.basename(process.argv[1] || "guard");
}

const CONTEXT_EVENTS = ["PostToolUse", "PostToolUseFailure", "PostToolBatch"];

/**
 * The event a context answers under: the payload's own where it is one that
 * takes additionalContext, else the entry's declared one.
 * @param {unknown} named the payload's hook_event_name
 * @param {HookEvent} declared
 * @returns {HookEvent}
 */
const contextEvent = (named, declared) =>
	typeof named === "string" && CONTEXT_EVENTS.includes(named)
		? /** @type {HookEvent} */ (named)
		: declared;

/**
 * The hook's output, written in `event`'s own decision control.
 * @param {HookEvent} event
 * @param {Record<string, unknown>} output
 */
function emit(event, output) {
	process.stdout.write(
		JSON.stringify(require("./hook-envelope.js").envelope(event, output)),
	);
}

/**
 * A store fault's refusal; a held prelude rides in it.
 * @param {string} reason
 * @param {string} [prelude]
 */
const refusal = (reason, prelude) =>
	prelude ? `${reason}\n\nThe guard also had this to say:\n${prelude}` : reason;

/** @param {string} id */
const bare = (id) => (id.startsWith("rule:") ? id.slice(5) : id);

/**
 * A payload value as text: itself where it is a string, "" for anything else.
 * @param {unknown} v
 */
const textOf = (v) => (typeof v === "string" ? v : "");

/**
 * A core's scratch-state directory, `wfc-<name>` under TMPDIR or /tmp:
 * outside the repo, never an artefact.
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
const scratchDir = (env, name) => `${env.TMPDIR || "/tmp"}/wfc-${name}`;

/**
 * The `makeDir` port a host hands its core: `dir` made, parents and all; true
 * where it stands after, false where it could not be made.
 * @param {string} dir
 */
function makeDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		return true;
	} catch {
		/* The port's contract: a directory that cannot be made answers false,
		 * which the core logs and allows on (mantahostels#103 §6). */
		return false;
	}
}

/**
 * A tab-separated store's records, `n` fields each, in the grammar of
 * bash's `IFS=$'\t' read -r`: only a newline-ended line is a record; tab is IFS whitespace, so leading
 * and trailing tabs go and a run of them is one delimiter; the last field
 * takes the rest, its inner tabs kept; a missing field reads "".
 * @param {string} text
 * @param {number} n
 * @returns {string[][]}
 */
function tabRecords(text, n) {
	return text
		.split("\n")
		.slice(0, -1)
		.map((line) => {
			/** @type {string[]} */
			const out = [];
			let rest = line.replace(/^\t+/, "").replace(/\t+$/, "");
			while (out.length < n - 1) {
				const at = rest.indexOf("\t");
				if (at < 0) break;
				out.push(rest.slice(0, at));
				rest = rest.slice(at).replace(/^\t+/, "");
			}
			out.push(rest);
			while (out.length < n) out.push("");
			return out;
		});
}

/**
 * The payload's `agent_id` as text, "" where it is absent, null or empty. Any
 * other value names a subagent: misreading one
 * as the main session would refuse a sanctioned subagent call.
 * @param {Record<string, unknown>} payload
 */
const agentId = (payload) =>
	payload.agent_id === undefined || payload.agent_id === null
		? ""
		: String(payload.agent_id);

/**
 * `main` or `a<agent_id>`, and the session id, both made path
 * segments. Null where the payload carries no session id.
 * @param {Record<string, unknown>} payload
 */
function agentKey(payload) {
	const sid = typeof payload.session_id === "string" ? payload.session_id : "";
	if (!sid) return null;
	const id = agentId(payload);
	const agent = id ? `a${segment(id)}` : "main";
	return { agent, sid: segment(sid) };
}

/**
 * A rule's latch: one file per (id, agent, session). The id keeps its dot,
 * the namespaces' (`warn.`, `sum.`) separator.
 * @param {string} root
 * @param {string} id
 * @param {{ agent: string, sid: string }} key
 */
const latchPath = (root, id, key) =>
	path.join(
		markersDir(root),
		`.rule-injected-${id.replace(/[^A-Za-z0-9_.-]/g, "_")}-${key.agent}-${key.sid}`,
	);

/** @param {string} id */
const warnId = (id) => `warn.${bare(id)}`;

/**
 * @typedef {{ name: string, text: string }} Latch
 * @typedef {{ deny?: string, context?: string, launch?: Launch["launch"],
 *   latches: Latch[] }} Rendered what one decision hands the session — a
 *   refusal, a context or a detached start — and the latches to write once
 *   it is out
 * @typedef {PortEnv & { name: string, room?: () => number,
 *   corePaths?: (text: string) => string }} RenderAt `name` is the guard a
 *   refusal names; `room`, what the hook entry has left, read only where the
 *   decision says something; `corePaths` respells a Context's script paths
 */

/**
 * One decision as what it hands the session: the one reading of a decision's
 * kind, for a guard's own entry and a dispatcher core alike.
 * @param {NonNullable<Decision>} decision
 * @param {RenderAt} at
 * @returns {Rendered}
 */
function render(decision, at) {
	if ("launch" in decision) return { launch: decision.launch, latches: [] };
	if ("deny" in decision)
		return { deny: decision.deny, latches: decision.latchWrites ?? [] };
	if (!("context" in decision)) return renderInjection(decision, at);
	const context = at.corePaths
		? at.corePaths(decision.context)
		: decision.context;
	if (!at.room || context.length <= at.room())
		return { context, latches: decision.latchWrites ?? [] };
	at.log("a core's context overran the persist room — dropped");
	return { latches: [] };
}

/**
 * Each id's fragment once a session, highest priority first, as many
 * as fit RULE_CAP after the prelude — and inside `room` — the rest deferred
 * unlatched, latched with the prelude's own latch once emitted.
 * @param {Injection} decision
 * @param {RenderAt} at
 * @returns {Rendered}
 */
function renderInjection(decision, { payload, root, name, log, room }) {
	const { prelude = "", latchAfter, latchWrites = [] } = decision;
	const key = agentKey(payload);
	if (!key) {
		log("no session_id in payload — rule injection skipped");
		return prelude ? { context: prelude, latches: [] } : { latches: [] };
	}
	const { readRuleText } = require("./rule-text.js");
	const { readRuleCap } = require("./rule-emission.js");
	/** @type {Map<string, string>} */
	const texts = new Map();
	/* A prelude alone is outside the cap, so a warn naming no rule reads none. */
	let cap = Number.POSITIVE_INFINITY;
	try {
		if (decision.injectRules.length > 0) cap = readRuleCap();
		for (const id of decision.injectRules)
			texts.set(bare(id), readRuleText(id));
	} catch (e) {
		const msg = caught(e).message;
		log(`rule fragment unreadable — refusing: ${msg}`);
		return { deny: refusal(`${name}: ${msg}`, prelude), latches: [] };
	}
	const skipped = new Set((decision.skip ?? []).map(bare));
	const want = [...texts].filter(
		([id]) => !skipped.has(id) && !fs.existsSync(latchPath(root, id, key)),
	);
	if (want.length === 0 && !prelude) return { latches: [] };
	const fit = fitCap(
		prelude,
		want,
		cap,
		room ? room() : Number.POSITIVE_INFINITY,
	);
	if ("deny" in fit) {
		log(`rule fragment over the emission ceiling — refusing: ${fit.id}`);
		return {
			deny: refusal(
				`${name}: the fragment for rule id "${fit.id}" is ${fit.bytes} bytes, over the ${cap}-byte emission ceiling, so it can never be injected. Split the rule or shorten the fragment.`,
				prelude,
			),
			latches: [],
		};
	}
	return {
		...(fit.out ? { context: fit.out } : {}),
		latches: [
			...fit.emitted.map((id) => ({ name: id, text: "" })),
			...(latchAfter ? [{ name: warnId(latchAfter), text: "" }] : []),
			...latchWrites,
		],
	};
}

/**
 * The envelope: the prelude, then as many fragments as fit `cap` bytes and
 * `room` characters, highest priority first, the rest deferred. A fragment
 * that alone is over the cap can never be injected, which is a store fault;
 * one squeezed out by the prelude, a higher-priority id or the room simply
 * defers.
 * @param {string} prelude
 * @param {[string, string][]} want
 * @param {number} cap
 * @param {number} room
 * @returns {{ out: string, emitted: string[] } | { deny: true, id: string, bytes: number }}
 */
function fitCap(prelude, want, cap, room) {
	let out = prelude;
	/** @type {string[]} */
	const emitted = [];
	for (const [id, text] of want) {
		const candidate = out ? `${out}\n\n${text}` : text;
		if (Buffer.byteLength(candidate) <= cap && candidate.length <= room) {
			out = candidate;
			emitted.push(id);
			continue;
		}
		if (emitted.length === 0 && Buffer.byteLength(text) > cap)
			return { deny: true, id, bytes: Buffer.byteLength(text) };
		break;
	}
	return { out, emitted };
}

/**
 * Each latch, after the envelope. An unwritten one costs one repeated
 * injection, so it is logged, never fatal.
 * @param {PortEnv} env
 * @param {Latch[]} latches
 */
function writeLatches({ root, payload, log }, latches) {
	const key = agentKey(payload);
	if (!key) return;
	for (const { name, text } of latches) {
		try {
			fs.writeFileSync(latchPath(root, name, key), text);
		} catch {
			log(`latch ${name} unwritable — said again on the next trigger`);
		}
	}
}

/**
 * The detached start a Launch asks for: node in a session of its own, as
 * lib/detach.sh's setsid does, so no hook's process-group kill reaches it.
 * @param {Launch["launch"]} launch
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 */
function startDetached({ script, log: logName }, root, log) {
	const fd = fs.openSync(path.join(markersDir(root), logName), "a");
	try {
		const child = spawn("node", [path.join(__dirname, "..", script)], {
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		child.on("error", (e) =>
			log(`${script} did not start — ${caught(e).message}`),
		);
		child.unref();
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The tree reader a git walk judges each tree with, built on first use: a
 * command naming no git subcommand a walk asks for pays no git call.
 * @param {string} root
 */
function lazyTreeClass(root) {
	/** @type {((dir: string) => "shared" | "linked" | "other" | "unknown") | undefined} */
	let classify;
	return (/** @type {string} */ dir) => {
		classify ??= require("./git-tree.js").treeClassifier(root);
		return classify(dir);
	};
}

/**
 * The expansion scope a core resolves `$NAME` against: the environment, plus
 * the two ids bash sets itself and never exports.
 * @returns {Record<string, string>}
 */
function shellVars() {
	/** @type {Record<string, string>} */
	const vars = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined) vars[k] = v;
	if (typeof process.getuid === "function") vars.UID = String(process.getuid());
	if (typeof process.geteuid === "function")
		vars.EUID = String(process.geteuid());
	return vars;
}

/**
 * The adapters one call builds once, however many cores read them.
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {Pick<KitContext, "moduleOn" | "treeClass">}
 */
const sharedReaders = (root, log) => ({
	moduleOn: moduleReader(root, log),
	treeClass: lazyTreeClass(root),
});

/**
 * @template {Pick<KitContext, "moduleOn" | "treeClass">} R
 * @param {PortEnv} env
 * @param {R} readers
 * @returns {KitContext & R}
 */
function kitContext({ root, payload, log }, readers) {
	const key = agentKey(payload);
	/** @param {string} name */
	const latch = (name) => (key ? latchPath(root, name, key) : null);
	const input = payload.tool_input;
	return {
		input:
			input && typeof input === "object"
				? /** @type {Record<string, unknown>} */ (input)
				: {},
		tool: typeof payload.tool_name === "string" ? payload.tool_name : undefined,
		response: payload.tool_response,
		key,
		agent: agentId(payload),
		agentLabel: agentId(payload) ? `a${segment(agentId(payload))}` : "main",
		permissionMode:
			typeof payload.permission_mode === "string"
				? payload.permission_mode
				: undefined,
		cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
		fallbackCwd: process.cwd(),
		vars: shellVars(),
		isDir: (p) =>
			fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
		/* Loaded on a hit only: it is most of a silent call's cost (#2799). */
		ruleText: (id) => require("./rule-text.js").readRuleText(id),
		corePaths: (text) => require("./script-path.js").resolveScriptPaths(text),
		scriptPath: (name) => require("./script-path.js").scriptPath(name),
		docPath: (name) => require("./script-path.js").docPath(name),
		...readers,
		log,
		/* Fails towards telling: no key is not told, logged. */
		told: (id) => {
			const p = latch(warnId(id));
			if (p === null) {
				log(`no session key — rule ${id} unlatchable, delivered again`);
				return false;
			}
			return fs.existsSync(p);
		},
		readLatch: (name) => {
			const p = latch(name);
			if (p === null) return null;
			try {
				return fs.readFileSync(p, "utf8");
			} catch {
				return null;
			}
		},
	};
}

/**
 * The field a guard judges: the first of `field` that is a non-empty string,
 * as a jq `a // b` path reads, in the payload's `tool_input` or, with `top`,
 * in the payload itself; null where none is.
 * @param {Record<string, unknown>} payload
 * @param {{ field: string | string[], top?: boolean }} where
 */
function subjectFor(payload, { field, top }) {
	const record = /** @type {Record<string, unknown> | undefined} */ (
		top ? payload : payload.tool_input
	);
	for (const f of [field].flat()) {
		const v = record?.[f];
		if (typeof v === "string" && v) return v;
	}
	return null;
}

/**
 * Run one guard.
 * @template {object} P
 * @param {{ field: string, noun: string, event?: HookEvent,
 *   top?: boolean, name?: string, onThrow?: "refuse",
 *   decide: (subject: string, ctx: KitContext & P) => Decision,
 *   ports?: (env: PortEnv) => P }} spec
 *   `field` is the `tool_input` key judged, or with `top` the payload's own;
 *   `noun` names what goes unchecked in a fail-open record; `name` is what `disabled` lists, the entry's file unless a
 *   dispatcher core shares it; `onThrow: "refuse"`, for an enforcing guard,
 *   applies lib/refuse-on-throw.js; `ports` builds the entry's own
 */
function run({
	field,
	noun,
	event = "PreToolUse",
	top,
	name,
	onThrow,
	decide,
	ports,
}) {
	let entryLog = logger(guardFile());
	try {
		/* `disabled` lists `name`; a refusal names the file. */
		const file = guardFile();
		const root = hostRoot(process.cwd(), { timeoutMs: HOOK_GIT_TIMEOUT_MS });
		/* Records file under this root: a second read of it would re-run a hung
		 * git unbounded (#3038). */
		entryLog = logger(file, root);
		if (guardDisabled(name ?? file, { root })) return;
		const payload = readPayload(noun, entryLog);
		if (!payload) return;
		const subject = subjectFor(payload, { field, top });
		if (subject === null)
			return entryLog(`no ${field} in payload — ${noun} allowed unchecked`);
		/** @type {PortEnv} */
		const env = { root, payload, log: entryLog };
		const own = ports ? ports(env) : /** @type {P} */ ({});
		const ctx = kitContext(env, sharedReaders(root, entryLog));
		const judge =
			onThrow === "refuse"
				? require("./refuse-on-throw.js").refuseOnThrow(file, decide)
				: decide;
		const decision = judge(subject, { ...ctx, ...own });
		if (!decision) return;
		if (
			event !== "PreToolUse" &&
			("deny" in decision || "injectRules" in decision)
		)
			return entryLog(
				`a ${event} guard answered a PreToolUse decision — dropped`,
			);
		const out = render(decision, {
			...env,
			name: file,
			corePaths: ctx.corePaths,
		});
		if (out.launch) return startDetached(out.launch, root, entryLog);
		if (out.deny)
			emit(event, {
				permissionDecision: "deny",
				permissionDecisionReason: out.deny,
			});
		else if (out.context)
			emit(contextEvent(payload.hook_event_name, event), {
				additionalContext: out.context,
			});
		writeLatches(env, out.latches);
	} catch (e) {
		entryLog(`guard threw — allowed unchecked: ${caught(e).message}`);
	}
}

module.exports = {
	emit,
	guardFile,
	kitContext,
	makeDir,
	render,
	run,
	scratchDir,
	sharedReaders,
	subjectFor,
	tabRecords,
	textOf,
	writeLatches,
};
