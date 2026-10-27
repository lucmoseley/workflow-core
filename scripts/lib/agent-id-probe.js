/*
 * agent-id-probe.js — does the installed Claude Code send `agent_id` on a
 * subagent's `PreCompact` and `SessionStart` payloads? #1837 waits on it
 * (#2819).
 *
 * STATIC, from the binary. On 2.1.310 each event builds its payload as `{...Vu(e,Cg()),hook_event_name:
 * "PreCompact",…}`, where `Vu(e,n,r,s)` reads `agent_id` off its fourth,
 * context parameter, so a two-argument call sends none. Minified names change
 * every release, so the probe anchors on the `hook_event_name:"<event>"`
 * literal, reads the builder call in the object literal around it, then reads
 * that builder's definition for the parameter `agent_id` comes from.
 *   fixed      either event's builder call reaches that parameter, or its
 *              literal names `agent_id` itself
 *   not fixed  both builder calls stop short of it and neither names it
 *   unprobed   an unreadable binary, an absent anchor, or a literal or
 *              definition whose shape the probe does not know — never
 *              "fixed"
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

const EVENTS = ["PreCompact", "SessionStart"];

/** Either side of an anchor. Both 2.1.310 literals fit in 400 bytes, and
 * `Vu`'s `agent_id` sits 400 bytes into its body; a guess. */
const WINDOW = 4096;

/** The binary is read in pieces, as 2.1.310's is 291 MB; the size is a guess. */
const CHUNK = 16 * 1024 * 1024;

/**
 * @typedef {{ verdict: "fixed" | "not fixed" | "unprobed", reasons: string[] }} Finding
 * @typedef {{ builder?: string, args?: number, agentId: boolean }} Site
 */

/**
 * The file `bin` runs, as `readlink -f $(which <bin>)` gives it; null where
 * none is found.
 * @param {string} bin
 */
function binaryOf(bin) {
	const dirs = bin.includes("/")
		? [""]
		: (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const d of dirs) {
		try {
			return fs.realpathSync(d ? path.join(d, bin) : bin);
		} catch {
			/* Not in this PATH entry. */
		}
	}
	return null;
}

/**
 * The text around each occurrence of `needle` in the file, with the
 * needle's offset in it.
 * @param {string} file
 * @param {string} needle
 * @returns {{ text: string, at: number }[]}
 */
function readWindowsOf(file, needle) {
	const want = Buffer.from(needle, "latin1");
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const buf = Buffer.alloc(CHUNK + want.length - 1);
		/** @type {number[]} */
		const hits = [];
		for (let off = 0; off < size; off += CHUNK) {
			const n = fs.readSync(fd, buf, 0, buf.length, off);
			const view = buf.subarray(0, n);
			/* A hit starting in the overlap is the next chunk's to find. */
			let i = view.indexOf(want);
			while (i !== -1 && i < CHUNK) {
				hits.push(off + i);
				i = view.indexOf(want, i + 1);
			}
		}
		return hits.map((hit) => {
			const start = Math.max(0, hit - WINDOW);
			const out = Buffer.alloc(Math.min(size, hit + WINDOW) - start);
			fs.readSync(fd, out, 0, out.length, start);
			return { text: out.toString("latin1"), at: hit - start };
		});
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Where the bracket opened at `open` closes, or -1 within the text.
 * @param {string} text
 * @param {number} open
 */
function closeOf(text, open) {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if ("([{".includes(text[i] ?? "")) depth++;
		else if (")]}".includes(text[i] ?? "") && --depth === 0) return i;
	}
	return -1;
}

/**
 * Where the object literal enclosing `at` opens, or -1 within the text.
 * @param {string} text
 * @param {number} at
 */
function openOf(text, at) {
	for (let i = at - 1, depth = 0; i >= 0; i--) {
		if (text[i] === "}") depth++;
		else if (text[i] === "{" && depth-- === 0) return i;
	}
	return -1;
}

/**
 * How many top-level arguments a call's inside carries.
 * @param {string} inner
 */
function argCount(inner) {
	let args = inner.trim() === "" ? 0 : 1;
	for (let i = 0, depth = 0; i < inner.length; i++) {
		if ("([{".includes(inner[i] ?? "")) depth++;
		else if (")]}".includes(inner[i] ?? "")) depth--;
		else if (inner[i] === "," && depth === 0) args++;
	}
	return args;
}

/**
 * What the object literal holding the anchor at `at` builds its payload
 * from; null where no enclosing literal is found.
 * @param {string} text
 * @param {number} at
 * @returns {Site | null}
 */
function siteOf(text, at) {
	const open = openOf(text, at);
	const close = open === -1 ? -1 : closeOf(text, open);
	if (close === -1) return null;
	const literal = text.slice(open, close + 1);
	const agentId = /\bagent_id\b/.test(literal);
	const spread = /^\{\.\.\.([\w$]+)\(/.exec(literal);
	if (!spread) return { agentId };
	const inner = literal.slice(
		spread[0].length,
		closeOf(literal, spread[0].length - 1),
	);
	return { builder: spread[1], args: argCount(inner), agentId };
}

/**
 * Which parameter of `builder` its `agent_id` is read from — the `s` of
 * 2.1.310's `agent_id:s?.agentId` — or null where no definition of it reads
 * one off a parameter. Minified names repeat across modules, so the first
 * definition that does is taken.
 * @param {string} file
 * @param {string} builder
 */
function readContextIndexOf(file, builder) {
	for (const w of readWindowsOf(file, `function ${builder}(`)) {
		const def = w.text.slice(w.at);
		const params = /^function [\w$]+\(([^)]*)\)/.exec(def)?.[1];
		const from = /agent_id:([\w$]+)\??\.agentId/.exec(def)?.[1];
		const at = params?.split(",").indexOf(from ?? "") ?? -1;
		if (at !== -1) return at;
	}
	return null;
}

/**
 * One event's finding, from the windows around its anchor.
 * @param {string} event
 * @param {{ text: string, at: number }[]} windows
 * @param {(builder: string) => number | null} contextIndex
 * @returns {Finding}
 */
function judgeEvent(event, windows, contextIndex) {
	const anchor = `hook_event_name:"${event}"`;
	if (windows.length === 0)
		return { verdict: "unprobed", reasons: [`${anchor} is not in the binary`] };
	const sites = windows.map((w) => siteOf(w.text, w.at));
	if (sites.some((s) => s?.agentId))
		return {
			verdict: "fixed",
			reasons: [`the ${event} payload literal names agent_id itself`],
		};
	const known = sites.flatMap((s) => (s?.builder === undefined ? [] : [s]));
	if (known.length < sites.length)
		return {
			verdict: "unprobed",
			reasons: [
				`the literal around ${anchor} has no builder spread the probe knows`,
			],
		};
	const reasons = [];
	for (const s of known) {
		const builder = s.builder ?? "";
		const at = contextIndex(builder);
		if (at === null)
			return {
				verdict: "unprobed",
				reasons: [
					`no definition of the ${event} builder ${builder} reads agent_id off a parameter`,
				],
			};
		const args = s.args ?? 0;
		if (args > at)
			return {
				verdict: "fixed",
				reasons: [
					`the ${event} builder ${builder} now gets ${args} arguments, reaching parameter ${at + 1}, which carries agent_id`,
				],
			};
		reasons.push(
			`the ${event} builder ${builder} gets ${args} arguments, short of parameter ${at + 1}, which carries agent_id`,
		);
	}
	return { verdict: "not fixed", reasons };
}

/**
 * The probe's finding on the binary `bin` runs.
 * @param {string} bin
 * @returns {Finding}
 */
function probeAgentId(bin) {
	const file = binaryOf(bin);
	if (!file)
		return { verdict: "unprobed", reasons: [`no \`${bin}\` binary was found`] };
	/** @type {Finding[]} */
	let found;
	/** @type {Map<string, number | null>} */
	const indices = new Map();
	const readContextIndex = (/** @type {string} */ builder) => {
		if (!indices.has(builder))
			indices.set(builder, readContextIndexOf(file, builder));
		return indices.get(builder) ?? null;
	};
	try {
		found = EVENTS.map((e) =>
			judgeEvent(
				e,
				readWindowsOf(file, `hook_event_name:"${e}"`),
				readContextIndex,
			),
		);
	} catch (e) {
		return {
			verdict: "unprobed",
			reasons: [`${file} could not be read: ${caught(e).message}`],
		};
	}
	const reasons = found.flatMap((f) => f.reasons);
	if (found.some((f) => f.verdict === "fixed"))
		return {
			verdict: "fixed",
			reasons: found
				.filter((f) => f.verdict === "fixed")
				.flatMap((f) => f.reasons),
		};
	if (found.some((f) => f.verdict === "unprobed"))
		return { verdict: "unprobed", reasons };
	return { verdict: "not fixed", reasons };
}

module.exports = { probeAgentId };
