const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const { guardDisabled } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { logger, readPayload } = require("./entry-input.js");
const { trimEndRun } = require("./trim-run.js");
const { writeFd } = require("./write-fd.js");
const { AFTER_EVENTS } = require("./hook-events.js");
const {
	agentKey,
	bare,
	kitContext,
	latchPath,
	sharedReaders,
	warnId,
} = require("./kit-context.js");

/**
 * @typedef {"PreToolUse" | (typeof AFTER_EVENTS)[number] | "UserPromptSubmit"} HookEvent
 * @typedef {object} Injection
 * @property {string[]} injectRules
 * @property {string[]} [skip]
 * @property {string} [prelude]
 * @property {string} [latchAfter]
 * @property {{ name: string, text: string }[]} [latchWrites]
 * @typedef {{ launch: { script: string, log: string } }} Launch
 * @typedef {{ context: string, latchWrites?: { name: string, text: string }[] }} Context
 * @typedef {{ deny: string, latchWrites?: { name: string, text: string }[] }} Deny
 * @typedef {Injection | Deny | Launch | Context | null} Decision
 * @typedef {import("./kit-context.js").KitContext} KitContext
 * @typedef {import("./kit-context.js").PortEnv} PortEnv
 */

function guardFile() {
	return path.basename(process.argv[1] || "guard");
}

/**
 * @param {unknown} named
 * @param {HookEvent} declared
 * @returns {HookEvent}
 */
const contextEvent = (named, declared) =>
	typeof named === "string" &&
	/** @type {readonly string[]} */ (AFTER_EVENTS).includes(named)
		? /** @type {HookEvent} */ (named)
		: declared;

/**
 * @param {HookEvent} event
 * @param {Record<string, unknown>} output
 */
function emit(event, output) {
	writeFd(
		1,
		JSON.stringify(require("./hook-envelope.js").envelope(event, output)),
	);
}

/**
 * @param {string} reason
 * @param {string} [prelude]
 */
const refusal = (reason, prelude) =>
	prelude ? `${reason}\n\nThe guard also had this to say:\n${prelude}` : reason;

/**
 * @param {unknown} v
 */
const textOf = (v) => (typeof v === "string" ? v : "");

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
const scratchDir = (env, name) => `${env.TMPDIR || "/tmp"}/wfc-${name}`;

/**
 * @param {string} dir
 */
function makeDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

/**
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
			let rest = trimEndRun(line.replace(/^\t+/, ""), "\t");
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
 * @typedef {{ name: string, text: string }} Latch
 * @typedef {{ deny?: string, context?: string, launch?: Launch["launch"],
 *   latches: Latch[], overRoom?: boolean }} Rendered
 * @typedef {PortEnv & { name: string, room?: () => number,
 *   corePaths?: (text: string) => string }} RenderAt
 */

/**
 * @param {NonNullable<Decision>} decision
 * @param {RenderAt} at
 * @returns {Rendered}
 */
function render(decision, at) {
	if ("launch" in decision) return { launch: decision.launch, latches: [] };
	if ("deny" in decision)
		return { deny: decision.deny, latches: decision.latchWrites ?? [] };
	if (!("context" in decision)) return renderInjection(decision, at);
	const context = respelled(decision.context, at.corePaths);
	if (!at.room || context.length <= at.room())
		return { context, latches: decision.latchWrites ?? [] };
	at.log("a core's context overran the persist room — dropped");
	return { latches: [], overRoom: true };
}

/**
 * @param {NonNullable<Decision>} decision
 */
const hasOwnText = (decision) =>
	"context" in decision || ("injectRules" in decision && !!decision.prelude);

/**
 * @param {Injection} decision
 * @param {RenderAt} at
 * @returns {Rendered}
 */
function renderInjection(
	decision,
	{ payload, root, name, log, room, corePaths },
) {
	const { prelude: written = "" } = decision;
	const prelude = respelled(written, corePaths);
	const overRoom = !!prelude && !!room && prelude.length > room();
	if (overRoom) log("a core's prelude overran the persist room");
	const kept = overRoom ? "" : prelude;
	const flagged = overRoom ? { overRoom } : {};
	const key = agentKey(payload);
	if (!key) {
		log("no session_id in payload — rule injection skipped");
		return { ...(kept ? { context: kept } : {}), latches: [], ...flagged };
	}
	/** @type {{ cap: number, texts: Map<string, string> }} */
	let rules;
	try {
		rules = readRules(decision.injectRules, root);
	} catch (e) {
		return refuseUnreadable(e, { name, log, prelude });
	}
	const { cap, texts } = rules;
	const skipped = new Set((decision.skip ?? []).map(bare));
	const want = [...texts].filter(
		([id]) => !skipped.has(id) && !fs.existsSync(latchPath(root, id, key)),
	);
	if (want.length === 0 && !kept) return { latches: [], ...flagged };
	const fit = fitCap(kept, want, cap, room ? room() : Number.POSITIVE_INFINITY);
	if ("deny" in fit) {
		log(`rule fragment over the emission ceiling — refusing: ${fit.id}`);
		return {
			deny: refusal(overCapReason({ name, cap, root, ...fit }), prelude),
			latches: [],
		};
	}
	return {
		...(fit.out ? { context: fit.out } : {}),
		latches: [
			...fit.emitted.map((id) => ({ name: id, text: "" })),
			...(overRoom ? [] : ownLatches(decision)),
		],
		...flagged,
	};
}

/**
 * @param {{ name: string, id: string, bytes: number, cap: number, root: string }} over
 */
function overCapReason({ name, id, bytes, cap, root }) {
	const file = require("./rule-text.js").fragmentPath(id, root);
	const own = Buffer.byteLength(
		trimEndRun(fs.readFileSync(file, "utf8"), "\n"),
	);
	const madeOf =
		bytes > own
			? `${own} of them ${file}'s own and ${bytes - own} added by its {rule:} includes, plugin-root script paths and qualified citations`
			: `from ${own} in ${file}`;
	return `${name}: rule id "${id}" resolves to ${bytes} bytes, ${madeOf}, over the ${cap}-byte emission ceiling, so it can never be injected. Shorten the fragment or what it includes, or split the rule.`;
}

/**
 * @param {string} text
 * @param {((text: string) => string) | undefined} corePaths
 */
const respelled = (text, corePaths) =>
	text && corePaths ? corePaths(text) : text;

/**
 * @param {string[]} ids
 * @param {string} root
 */
function readRules(ids, root) {
	const { readRuleText } = require("./rule-text.js");
	const { readRuleCap } = require("./rule-emission.js");
	return {
		cap: ids.length > 0 ? readRuleCap() : Number.POSITIVE_INFINITY,
		texts: new Map(ids.map((id) => [bare(id), readRuleText(id, root)])),
	};
}

/**
 * @param {Injection} decision
 * @returns {Latch[]}
 */
const ownLatches = ({ latchAfter, latchWrites = [] }) => [
	...(latchAfter ? [{ name: warnId(latchAfter), text: "" }] : []),
	...latchWrites,
];

/**
 * @param {unknown} e
 * @param {{ name: string, log: (what: string) => void, prelude: string }} at
 * @returns {Rendered}
 */
function refuseUnreadable(e, { name, log, prelude }) {
	const msg = caught(e).message;
	const { RuleMissing } = require("./rule-text.js");
	log(`rule fragment unreadable — refusing: ${msg}`);
	return {
		deny: refusal(
			e instanceof RuleMissing
				? `${name}: ${e.brief} This refusal holds whatever the guard's failure policy, until the fragment is restored from origin/main, or the change that removed it is reverted (mantahostels#1762).`
				: `${name}: ${msg}`,
			prelude,
		),
		latches: [],
	};
}

/**
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
 * @param {Launch["launch"]} launch
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 */
function startDetached({ script, log: logName }, root, log) {
	if (!path.isAbsolute(script))
		throw new Error(`launch script ${script} is no absolute path`);
	const fd = fs.openSync(path.join(markersDir(root), logName), "a");
	try {
		const child = spawn("node", [script], {
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
 * @param {HookEvent} event
 * @param {string} [byHand]
 */
function refuseIfRunByHand(event, byHand) {
	if (process.argv.length <= 2) return false;
	const instead = byHand
		? `; run ${require("./script-path.js").resolveScriptPaths(byHand)}`
		: "";
	writeFd(
		2,
		`${guardFile()}: a ${event} hook, which reads its payload on stdin and takes no arguments — refused before reading stdin, nothing done${instead}\n`,
	);
	process.exitCode = 1;
	return true;
}

/**
 * @template {object} P
 * @param {{ field: string, noun: string, event?: HookEvent,
 *   top?: boolean, name?: string, onThrow?: "refuse", byHand?: string,
 *   decide: (subject: string, ctx: KitContext & P) => Decision,
 *   ports?: (env: PortEnv) => P }} spec
 */
function run({
	field,
	noun,
	event = "PreToolUse",
	top,
	name,
	onThrow,
	byHand,
	decide,
	ports,
}) {
	if (refuseIfRunByHand(event, byHand)) return;
	let entryLog = logger(guardFile());
	try {
		const file = guardFile();
		const root = hostRoot(process.cwd(), { timeoutMs: HOOK_GIT_TIMEOUT_MS });
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
	hasOwnText,
	makeDir,
	render,
	run,
	scratchDir,
	subjectFor,
	tabRecords,
	textOf,
	writeLatches,
};
