/*
 * wide-read.js — the core that warns where a call reads a whole file, a wide
 * slice or an uncounted glob back into the context window
 * (mantahostels#1562), run as the PreToolUse dispatcher's `guard-wide-read`
 * core over Bash and `Read` (#3227). Its production ports are
 * lib/wide-read-host.js.
 *
 * WHY. Tool output is the largest single share of a long session's context
 * here, and mantahostels#1553 declined every capping setting the CLI offers —
 * the figures, and what each setting would have cost, are on
 * mantahostels#1553 and in
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tool-output-profile.md.
 * That leaves reducing the output at source, which is what this guard nudges.
 *
 * WARN, NEVER DENY — the decision at mantahostels#1562, not a first step
 * toward denying. A session often has a real reason to read widely, and
 * mantahostels#103's rule splits on the signal: deny on a structured fact where
 * the action has no legitimate use, warn where the guard is inferring. Reading
 * a whole file is always legitimate; only the caller knows whether it needed
 * the whole of it.
 *
 * The four shapes it matches, and what to do instead of each, are owned by
 * docs/agents/tool-output.md; each limb below states its own. Three are Bash
 * commands; the fourth is a `Read` tool call (mantahostels#2595).
 *
 * BOUNDED MEANS THE OUTPUT GOES SOMEWHERE ELSE. A command carrying a pipe or a
 * redirect anywhere in it is left alone: `cat x | head`, `sed -n … > out.txt`
 * and `grep … | wc -l` are the cheaper forms this guard is asking for, and
 * warning on them would be warning on the fix.
 *
 * THE THRESHOLDS are overridable through WFC_WIDE_READ_BYTES, _LINES,
 * _MATCHES, _TOOL_BYTES and _CUT_BYTES, so a test can fire the limbs on
 * fixtures small enough to write.
 *
 * LIMITS
 *  - The Bash narrowings are unanchored, so a `cat` in a later segment
 *    reaches the core, and one behind a launcher is judged as a bare one —
 *    past every wrapper lib/shell-words.js's unwrap strips (`timeout`, `env`,
 *    `nohup`, `sudo` and the rest), and no further: `sh -c "cat …"`, and a
 *    wrapper flag unwrap does not know, leave the dumper unjudged (#3519). A
 *    command holding `cat`, `sed` or `awk` with no space after it never
 *    reaches the core.
 *  - The bounded test reads the RAW command string for `|` and `>`, so one
 *    inside a quoted span silences the guard. Fail-silent, which is the right
 *    direction for a warn: a missed nudge costs bytes, a wrong one costs trust.
 *  - It reads the PARSED command form for everything else, so a `cat`
 *    mentioned in an echo, a grep pattern or a heredoc body is not a read
 *    (lib/shell-parse.js).
 *  - Relative paths resolve against the first directory the walk hands the
 *    dumper's run — the payload's cwd, moved by any `cd` before it and by
 *    each directory its launchers move to (`env -C dir`, a `flock -c`
 *    string's `cd`). Residual: that directory takes every move as made, so a
 *    `cd` that failed has a relative path measured where it would have led;
 *    the run's other directories are not measured (#4980). Where that cwd is
 *    unknown a relative path is not measured. The file must EXIST to be
 *    measured, which makes a wrong cwd a silent failure rather than a false
 *    warning.
 *  - `sed` is judged on its LINE span, never on the bytes those lines hold, so
 *    a 150-line slice of a minified file passes.
 *  - A word literal cannot fully read — `cat "$doc"`, a command substitution —
 *    is DROPPED, not judged on its visible part. A partial path cannot be
 *    measured on disk.
 *  - Only `cat`, `sed` and `awk` are judged at all. `grep`, `rg`, `head` and
 *    `tail` bound their output in LINES — by pattern or by line count — so
 *    warning on a glob they were given would warn on `grep -n '<pattern>'
 *    <glob>`, the very cheaper form limb 1 recommends. `grep` therefore goes
 *    unwarned whatever it reads, though it is the corpus's second-largest
 *    bucket. Lines are not bytes: one matching single-line file returns whole
 *    (#1026).
 *  - It is DELIBERATELY ABSENT from lib/shell-parse.js's guarded-head list.
 *    That list decides when the multi-line join abandons, and widening it to
 *    `cat`/`sed`/`grep` would make the deny guards read a mis-paired
 *    multi-line string as commands — a wrong DENY, to spare this guard a
 *    missed WARN (mantahostels#2346).
 *  - The Read limb judges only a call carrying NO `limit`. A `limit` bounds
 *    the output the way a pipe bounds a Bash read, and warning on one would be
 *    warning on the fix. It costs coverage: a call bounded by a `limit` and
 *    wide anyway goes unwarned (mantahostels#2595).
 *  - The Read limb measures the lines the call will RETURN, not the file:
 *    `Read` stops at 2,000 lines, so a 200,000-line file returns a small
 *    fraction of itself and measuring the file would warn on almost every long
 *    file wrongly. An image, a PDF and a notebook are skipped by extension —
 *    `Read` renders those rather than returning their bytes, so a byte count
 *    says nothing.
 *  - The Read limb warns once per (agent, session, file), latched as
 *    `ctx.told` latches, so a compaction — which clears those latches — lets
 *    it warn again (#1034). The Bash limbs are not latched.
 *  - Limbs 1 and 3 compare BYTES with the 30,000-character cap, so a file of
 *    multibyte text just over 30 KB can draw the cut-off sentence while under
 *    the cap — hence "may be cut", never "will be".
 *  - The 2,000-line cap is the only one it models. A separate token cap can
 *    page a large result
 *    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/microcompact-and-tool-result-caps.md),
 *    so the figure the warning names is an upper bound on what the window
 *    actually takes, not a measurement of it.
 *  - It FAILS OPEN throughout, house style (mantahostels#103 §6), recording
 *    through the guard-error log (mantahostels#147).
 */

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
