const path = require("node:path");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { isGlobPattern, literal } = require("./shell-words.js");

/**
 * @typedef {object} WideReadPorts
 * @property {(p: string) => number | null} fileBytes
 * @property {(p: string, first: number, last: number) => number | null} windowBytes
 * @property {(lit: string, cwd: string) => string[]} glob
 * @typedef {import("./kit-context.js").KitContext
 *   & Pick<import("./guard-host-ports.js").CorePorts, "env">
 *   & WideReadPorts} WideReadContext
 * @typedef {{ bytes: number, lines: number, matches: number, readBytes: number,
 *   cutBytes: number }} Thresholds
 * @typedef {{ ctx: WideReadContext, cwd: string }} DumperRun
 */

const DUMPERS = ["cat", "sed", "awk"];

/** @type {Record<string, (lits: string[], run: DumperRun, t: Thresholds) => string | null>} */
const OWN_LIMB = {
	cat: (lits, run, t) => judgeCat(lits, run, t),
	sed: (lits, _run, t) => judgeSed(lits, t),
};

const READ_LINE_CAP = 2000;

const RENDERED = /\.(?:png|jpg|jpeg|gif|webp|bmp|svg|pdf|ipynb)$/;

const FOOTER =
	"Why this fires and what the convention asks for: docs/agents/tool-output.md. It only ever warns.";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Thresholds}
 */
function thresholds(env) {
	const read = (/** @type {string} */ name, /** @type {number} */ dflt) => {
		const v = env[name];
		return v && /^[0-9]+$/.test(v) ? Number(v) : dflt;
	};
	return {
		bytes: read("WFC_WIDE_READ_BYTES", 20_000), // lucmoseley/mantahostels#2571 guess
		lines: read("WFC_WIDE_READ_LINES", 200), // lucmoseley/mantahostels#2571 guess
		matches: read("WFC_WIDE_READ_MATCHES", 5), // lucmoseley/mantahostels#2571 guess
		readBytes: read("WFC_WIDE_READ_TOOL_BYTES", 10_000), // lucmoseley/mantahostels#2595 guess
		// Claude Code reads back at most 30000 characters of Bash output by default (BASH_MAX_OUTPUT_LENGTH): https://code.claude.com/docs/en/env-vars
		cutBytes: read("WFC_WIDE_READ_CUT_BYTES", 30_000),
	};
}

/**
 * @param {string} subject
 * @param {WideReadContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(subject, ctx) {
	const t = thresholds(ctx.env);
	if (ctx.tool === "Read") return judgeRead(subject, ctx, t);
	if (subject.includes("|") || subject.includes(">")) return null;
	const parsed = parseCommand(subject);
	/** @type {string[]} */
	const findings = [];
	walkCommands(
		parsed,
		(cmd) => findings.push(...judge(cmd, parsed.spans, ctx, t)),
		ctx,
	);
	return findings.length > 0
		? { context: ctx.corePaths(`${findings.join("\n\n")}\n\n${FOOTER}`) }
		: null;
}

/**
 * @param {import("./shell-parse.js").Command} cmd
 * @param {string[]} spans
 * @param {WideReadContext} ctx
 * @param {Thresholds} t
 * @returns {string[]}
 */
const judge = (cmd, spans, ctx, t) =>
	cmd
		.runs()
		.flatMap((run) =>
			judgeRun(run.words, spans, { ctx, cwd: run.dirs()[0] }, t),
		);

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @param {DumperRun} run
 * @param {Thresholds} t
 * @returns {string[]}
 */
function judgeRun(words, spans, run, t) {
	const [head, ...args] = words;
	if (head === undefined) return [];
	const base = literal(head, spans);
	if (!base.known) return [];
	const name = base.text.slice(base.text.lastIndexOf("/") + 1);
	if (!DUMPERS.includes(name)) return [];
	const lits = args.flatMap((w) => {
		const l = literal(w, spans);
		return l.known ? [l.text] : [];
	});
	/** @type {string[]} */
	const out = [];
	const own = OWN_LIMB[name]?.(lits, run, t);
	if (own) out.push(own);
	const globbed = judgeGlob(lits, run, t);
	if (globbed) out.push(globbed);
	return out;
}

/**
 * @param {number} bytes
 * @param {Thresholds} t
 */
const cutNote = (bytes, t) =>
	bytes >= t.cutBytes
		? ` Past ~${t.cutBytes} characters Bash may cut this off with no notice, or save it to a file behind a 2 KB preview, so the tail may never be seen (#1029) — use \`Read\` with \`offset\` and \`limit\`, or redirect to a file and slice it.`
		: "";

/**
 * @param {string} lit
 * @param {DumperRun} run
 */
const bytesOf = (lit, { ctx, cwd }) =>
	cwd || path.isAbsolute(lit) ? ctx.fileBytes(path.resolve(cwd, lit)) : null;

/**
 * @param {string[]} lits
 * @param {DumperRun} run
 * @param {Thresholds} t
 * @returns {string | null}
 */
function judgeCat(lits, run, t) {
	let total = 0;
	/** @type {string[]} */
	const named = [];
	for (const lit of lits) {
		if (!lit || lit.startsWith("-")) continue;
		const bytes = bytesOf(lit, run);
		if (bytes === null) continue;
		total += bytes;
		named.push(lit);
	}
	const [first] = named;
	if (first === undefined || total < t.bytes) return null;
	const name =
		named.length > 1 ? `${first} and ${named.length} files in all` : first;
	return `Reading a whole file into context: ${name} is ${total} characters, and every one of them stays in the window for the rest of the session.${cutNote(total, t)} Read the part you need instead — \`grep -n '<pattern>' ${name}\` to find it, then \`sed -n '<start>,<end>p' ${name}\` — or send the whole thing to a file (\`… > .claude/tmp/out.txt\`) and slice that.`;
}

const RANGE = /^([0-9]+),([0-9]+|\$)p/;

/**
 * @param {string[]} lits
 * @param {Thresholds} t
 * @returns {string | null}
 */
function judgeSed(lits, t) {
	const quiet = lits.some(
		(l) =>
			l === "--quiet" ||
			l === "--silent" ||
			(l.startsWith("-") && l.includes("n")),
	);
	if (!quiet) return null;
	for (const lit of lits) {
		const m = RANGE.exec(lit);
		if (!m) continue;
		const [, start = "", end = ""] = m;
		if (end === "$")
			return `This \`sed -n\` range is wide: \`${lit}\` runs open-ended to the end of the file, so its size is whatever the file's size is. Name a last line, or send the output to a file and read the slice that matters.`;
		const span = Number(end) - Number(start) + 1;
		if (span < t.lines) continue;
		return `This \`sed -n\` range is wide: \`${lit}\` prints ${span} lines. Narrow it — \`grep -n '<pattern>' <file>\` first to find the lines worth printing — or send the output to a file and read the slice that matters.`;
	}
	return null;
}

/**
 * @param {string[]} lits
 * @param {DumperRun} run
 * @param {Thresholds} t
 * @returns {string | null}
 */
function judgeGlob(lits, run, t) {
	for (const lit of lits) {
		if (!lit || lit.startsWith("-") || !isGlobPattern(lit)) continue;
		const { n, total } = countGlob(lit, run, t);
		if (n >= t.matches || total >= t.bytes)
			return `This glob's match count is unknown to you but not to the shell: \`${lit}\` matches at least ${n} files, ${total} characters or more — the count stops at the threshold rather than walking the whole expansion.${cutNote(total, t)} Count first (\`ls ${lit} | wc -l\`), narrow the pattern, or send the output to a file and read the slice that matters.`;
	}
	return null;
}

/**
 * @param {string} lit
 * @param {DumperRun} run
 * @param {Thresholds} t
 */
function countGlob(lit, { ctx, cwd }, t) {
	let total = 0;
	let n = 0;
	if (!cwd && !path.isAbsolute(lit)) return { n, total };
	for (const match of ctx.glob(lit, cwd)) {
		const bytes = ctx.fileBytes(match);
		if (bytes === null) continue;
		total += bytes;
		n++;
		if (n >= t.matches || total >= t.bytes) break;
	}
	return { n, total };
}

/** @param {unknown} v */
function fieldText(v) {
	if (v === undefined || v === null || v === false) return "";
	if (typeof v === "string") return v;
	return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * @param {string} file
 * @param {WideReadContext} ctx
 * @returns {number | null}
 */
function returnedBytes(file, ctx) {
	const abs = path.resolve(ctx.fallbackCwd, file);
	if (ctx.fileBytes(abs) === null) return null;
	if (RENDERED.test(file.toLowerCase())) return null;
	const offset = fieldText(ctx.input.offset);
	const first = /^[1-9][0-9]{0,8}$/.test(offset) ? Number(offset) : 1;
	const bytes = ctx.windowBytes(abs, first, first + READ_LINE_CAP - 1);
	if (bytes === null)
		ctx.log(
			`could not measure ${file} for the Read limb — this call judged unchecked`,
		);
	return bytes;
}

/**
 * @param {string} file
 * @param {WideReadContext} ctx
 * @param {Thresholds} t
 * @returns {import("./guard-entry.js").Decision}
 */
function judgeRead(file, ctx, t) {
	if (fieldText(ctx.input.limit) !== "") return null;
	const bytes = returnedBytes(file, ctx);
	if (bytes === null || bytes < t.readBytes) return null;
	// #3227
	const crypto = require("node:crypto");
	const latch = `wide-read.${crypto.createHash("sha1").update(file).digest("hex").slice(0, 16)}`;
	if (ctx.told(latch)) return null;
	return {
		injectRules: [],
		prelude: ctx.corePaths(
			`This \`Read\` pours a whole file into context: ${file} returns ${bytes} characters, and every one of them stays in the window for the rest of the session. Read the part you need instead — one call, \`Read\` with \`offset\` and \`limit\` — after \`grep -n '<pattern>' ${file}\` to find the line to start at.\n\n${FOOTER}`,
		),
		latchAfter: latch,
	};
}

module.exports = {
	field: ["command", "file_path"],
	noun: "read",
	decide,
};
