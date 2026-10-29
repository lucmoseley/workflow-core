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
 * The row's three Bash clauses, `Bash(*cat *)`, `Bash(*sed *)` and
 * `Bash(*awk *)`, name the only three commands `DUMPERS` holds across
 * limbs 1-3 (mantahostels#2811). A clause naming Bash never narrows the Read
 * limb (lib/if-clause.js's clausesAdmit).
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
 *  - Relative paths resolve against the hook's own directory, so a `cd
 *    elsewhere && cat big` resolves to nothing and passes unwarned. The file
 *    must EXIST to be measured, which is what makes that failure silent rather
 *    than a false warning.
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
const { isGlobPattern, literal, unwrap } = require("./shell-words.js");

/**
 * @typedef {object} WideReadPorts
 * @property {(p: string) => number | null} fileBytes bytes on disk for a
 *   readable regular file; null for anything else
 * @property {(p: string, first: number, last: number) => number | null} windowBytes
 *   the bytes lines `first` to `last` hold, newlines counted; null where the
 *   file cannot be read
 * @property {(lit: string, cwd: string) => string[]} glob an unquoted word's
 *   expansion under nullglob, absolute
 * @typedef {import("./kit-context.js").KitContext
 *   & Pick<import("./guard-dispatch.js").CorePorts, "env">
 *   & WideReadPorts} WideReadContext
 * @typedef {{ bytes: number, lines: number, matches: number, readBytes: number,
 *   cutBytes: number }} Thresholds
 */

/**
 * The commands whose whole job is to put file text on stdout, unbounded. A
 * command that bounds its own output — grep by pattern, head and tail by line
 * count, wc by summarising — is deliberately absent; see LIMITS.
 */
const DUMPERS = ["cat", "sed", "awk"];

/**
 * The limb a dumper has of its own, beside the glob limb every one gets.
 * @type {Record<string, (lits: string[], ctx: WideReadContext, t: Thresholds) => string | null>}
 */
const OWN_LIMB = {
	cat: (lits, ctx, t) => judgeCat(lits, ctx, t),
	sed: (lits, _ctx, t) => judgeSed(lits, t),
};

/** What `Read` itself stops at. Measuring past it would warn on a long file
 * for lines the call was never going to return. */
const READ_LINE_CAP = 2000;

/** Rendered rather than returned as bytes, so a byte count measures nothing a
 * session pays for. */
const RENDERED = /\.(?:png|jpg|jpeg|gif|webp|bmp|svg|pdf|ipynb)$/;

const FOOTER =
	"Why this fires and what the convention asks for: docs/agents/tool-output.md. It only ever warns.";

/**
 * The thresholds, each an override where its variable holds digits.
 *
 * 20,000 characters is the break-even between what a wide read carries and
 * what the remedy in limb 1 costs — grep-then-sed, TWO extra tool calls, each
 * a turn at full context (mantahostels#2571, which carries the derivation).
 * The figure is a rough centre, NOT a bound in either direction:
 * mantahostels#2571 carries the terms the model leaves out and which way each
 * pushes — re-tune from there, not from this comment.
 *
 * The line and match figures are the same judgement in units the corpus does
 * not measure — UNMEASURED, chosen wide enough that an ordinary targeted read
 * passes untouched, and the first to move if this warns too often.
 *
 * The Read figure is HALF the byte one, by construction rather than by a
 * second measurement: the model is the same and only the remedy's call count
 * differs — two for grep-then-sed, one for a `Read` carrying `offset`/`limit`.
 * Derivation, the turns-remaining check behind it and what it costs in firing
 * rate: mantahostels#2595. Re-tune from there, not from this comment.
 *
 * The cut figure is the CLI's default BASH_MAX_OUTPUT_LENGTH. Past it a Bash
 * result has two fates and nothing found predicts which (#1029): saved to a
 * file behind a 2 KB preview, or cut at ~30,000 with no notice.
 * @param {Record<string, string | undefined>} env
 * @returns {Thresholds}
 */
function thresholds(env) {
	const read = (/** @type {string} */ name, /** @type {number} */ dflt) => {
		const v = env[name];
		return v && /^[0-9]+$/.test(v) ? Number(v) : dflt;
	};
	return {
		bytes: read("WFC_WIDE_READ_BYTES", 20_000),
		lines: read("WFC_WIDE_READ_LINES", 200),
		matches: read("WFC_WIDE_READ_MATCHES", 5),
		readBytes: read("WFC_WIDE_READ_TOOL_BYTES", 10_000),
		cutBytes: read("WFC_WIDE_READ_CUT_BYTES", 30_000),
	};
}

/**
 * @param {string} subject the command, or the `Read` call's file
 * @param {WideReadContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(subject, ctx) {
	const t = thresholds(ctx.env);
	if (ctx.tool === "Read") return judgeRead(subject, ctx, t);
	/* BOUNDED, read off the raw subject: see LIMITS for what that costs. */
	if (subject.includes("|") || subject.includes(">")) return null;
	const parsed = parseCommand(subject);
	/** @type {string[]} */
	const findings = [];
	walkCommands(
		parsed,
		({ words }) => findings.push(...judge(words, parsed.spans, ctx, t)),
		ctx,
	);
	return findings.length > 0
		? { context: ctx.corePaths(`${findings.join("\n\n")}\n\n${FOOTER}`) }
		: null;
}

/**
 * One command's findings, one per matched shape, in the order matched.
 * @param {string[]} words its own words, launchers and all
 * @param {string[]} spans
 * @param {WideReadContext} ctx
 * @param {Thresholds} t
 * @returns {string[]}
 */
function judge(words, spans, ctx, t) {
	const [head, ...args] = unwrap(words, spans).words;
	if (head === undefined) return [];
	const base = literal(head, spans);
	if (!base.known) return [];
	const name = base.text.slice(base.text.lastIndexOf("/") + 1);
	if (!DUMPERS.includes(name)) return [];
	/* Each argument as literal reads it; one it cannot fully read is dropped. */
	const lits = args.flatMap((w) => {
		const l = literal(w, spans);
		return l.known ? [l.text] : [];
	});
	/** @type {string[]} */
	const out = [];
	const own = OWN_LIMB[name]?.(lits, ctx, t);
	if (own) out.push(own);
	const globbed = judgeGlob(lits, ctx, t);
	if (globbed) out.push(globbed);
	return out;
}

/**
 * The sentence limbs 1 and 3 add at or past the cut figure, or "" under it.
 * @param {number} bytes
 * @param {Thresholds} t
 */
const cutNote = (bytes, t) =>
	bytes >= t.cutBytes
		? ` Past ~${t.cutBytes} characters Bash may cut this off with no notice, or save it to a file behind a 2 KB preview, so the tail may never be seen (#1029) — use \`Read\` with \`offset\` and \`limit\`, or redirect to a file and slice it.`
		: "";

/**
 * @param {string} lit
 * @param {WideReadContext} ctx
 */
const bytesOf = (lit, ctx) => ctx.fileBytes(path.resolve(ctx.fallbackCwd, lit));

/**
 * LIMB 1 — a `cat` whose file arguments are large. Only bare words that name
 * an existing file count, so `cat` on stdin, on a flag, or on a path that will
 * not resolve produces nothing.
 * @param {string[]} lits
 * @param {WideReadContext} ctx
 * @param {Thresholds} t
 * @returns {string | null}
 */
function judgeCat(lits, ctx, t) {
	let total = 0;
	/** @type {string[]} */
	const named = [];
	for (const lit of lits) {
		if (!lit || lit.startsWith("-")) continue;
		const bytes = bytesOf(lit, ctx);
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

/** A word shaped like a `sed -n` range. */
const RANGE = /^([0-9]+),([0-9]+|\$)p/;

/**
 * LIMB 2 — a wide `sed -n '<a>,<b>p'`. The range is read from any word shaped
 * like one; `-n` is required, because without it sed prints everything anyway
 * and the range is not what makes the output large.
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
 * LIMB 3 — a glob argument to a reading command. The count is known to this
 * guard and not to the session. Each glob's count stops the moment a
 * threshold is crossed, so a glob over node_modules costs no more than that
 * inside a hook the session waits on; the count reported is the count reached.
 * @param {string[]} lits
 * @param {WideReadContext} ctx
 * @param {Thresholds} t
 * @returns {string | null}
 */
function judgeGlob(lits, ctx, t) {
	for (const lit of lits) {
		if (!lit || lit.startsWith("-") || !isGlobPattern(lit)) continue;
		const { n, total } = countGlob(lit, ctx, t);
		if (n >= t.matches || total >= t.bytes)
			return `This glob's match count is unknown to you but not to the shell: \`${lit}\` matches at least ${n} files, ${total} characters or more — the count stops at the threshold rather than walking the whole expansion.${cutNote(total, t)} Count first (\`ls ${lit} | wc -l\`), narrow the pattern, or send the output to a file and read the slice that matters.`;
	}
	return null;
}

/**
 * The readable files a glob matches and their bytes, counted until either
 * threshold is crossed.
 * @param {string} lit
 * @param {WideReadContext} ctx
 * @param {Thresholds} t
 */
function countGlob(lit, ctx, t) {
	let total = 0;
	let n = 0;
	for (const match of ctx.glob(lit, ctx.fallbackCwd)) {
		const bytes = ctx.fileBytes(match);
		if (bytes === null) continue;
		total += bytes;
		n++;
		if (n >= t.matches || total >= t.bytes) break;
	}
	return { n, total };
}

/**
 * A payload field as `jq -j '<f> // ""'` prints it: "" for absent, null and
 * false.
 * @param {unknown} v
 */
function fieldText(v) {
	if (v === undefined || v === null || v === false) return "";
	if (typeof v === "string") return v;
	return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * The bytes a `Read` of `file` returns; null where it is no readable regular
 * file, is rendered rather than returned, or could not be measured, logged.
 * @param {string} file
 * @param {WideReadContext} ctx
 * @returns {number | null}
 */
function returnedBytes(file, ctx) {
	const abs = path.resolve(ctx.fallbackCwd, file);
	if (ctx.fileBytes(abs) === null) return null;
	if (RENDERED.test(file.toLowerCase())) return null;
	/* No leading zero, and narrow enough that first + READ_LINE_CAP stays a
	 * plain line number. */
	const offset = fieldText(ctx.input.offset);
	const first = /^[1-9][0-9]{0,8}$/.test(offset) ? Number(offset) : 1;
	const bytes = ctx.windowBytes(abs, first, first + READ_LINE_CAP - 1);
	/* A measure that failed is not a finding (mantahostels#147). */
	if (bytes === null)
		ctx.log(
			`could not measure ${file} for the Read limb — this call judged unchecked`,
		);
	return bytes;
}

/**
 * LIMB 4 — a `Read` tool call with no `limit`, whose returned lines are large,
 * measured on what the call RETURNS: from `offset` (1-based, defaulting to the
 * first line) for at most READ_LINE_CAP lines. Once per agent and file
 * (#1034): a second warning on a file the agent chose to read whole a first
 * time changes nothing.
 * @param {string} file
 * @param {WideReadContext} ctx
 * @param {Thresholds} t
 * @returns {import("./guard-entry.js").Decision}
 */
function judgeRead(file, ctx, t) {
	/* A `limit` is this tool's pipe: the caller has already bounded the output.
	 * `offset` alone does not bound anything — it moves the window, and the
	 * window still runs to the 2,000-line cap. */
	if (fieldText(ctx.input.limit) !== "") return null;
	const bytes = returnedBytes(file, ctx);
	if (bytes === null || bytes < t.readBytes) return null;
	/* The latch is keyed on (agent, session), so a subagent's first wide read
	 * of a file the parent already read still warns. The path is hashed
	 * because the latch name maps `/` to `_`, which would let `a/b.md` and
	 * `a_b.md` share a latch, and a long path outgrow a filename. Sixteen hex
	 * digits are 64 bits: by the birthday bound, n paths in one session share
	 * a key with odds near n²/2⁶⁵, nil for the hundreds a session reads.
	 * Required here, not at load: node:crypto costs ~6 ms, which every Bash
	 * `cat`, `sed` or `awk` would pay serially in the dispatcher (#3227). */
	const crypto = require("node:crypto");
	const latch = `wide-read.${crypto.createHash("sha1").update(file).digest("hex").slice(0, 16)}`;
	if (ctx.told(latch)) return null;
	/* Deliberately NOT limb 1's opening words. scripts/guard-fire-needles.json
	 * attributes a fire by matching the text, and a shared opening would count
	 * every Read fire as a `cat` one. */
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
