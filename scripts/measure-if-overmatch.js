#!/usr/bin/env node
/*
 * measure-if-overmatch.js — what each candidate `if` rule in
 * `self-plugin/hooks/hooks.json` costs in wasted guard execs, read off the Bash
 * commands already in the transcripts on disk.
 *
 *   node scripts/measure-if-overmatch.js [--dir <path>] [--json] [--limit <n>]
 *
 * Built at mantahostels#2127, which found `Bash(*gh*)` — a two-letter unanchored substring
 * — matching ordinary English prose (`through`, `neighbour`, `ghost`) and so
 * firing seven guards on calls none of them can act on.
 *
 * WHAT IS COUNTED. Every `tool_use` record naming the `Bash` tool, one per
 * command string, deduped by tool-use id so a resumed or forked transcript
 * replaying the same call counts once. Both tiers: a main session's file and
 * every subagent's.
 *
 * THE THREE POPULATIONS, per tool word (`git`, `gh`):
 *  - `matched`  — the rule fires, so the guard is exec'd. Under an unanchored
 *    `Bash(*x*)` this is a plain substring test against the whole command,
 *    quoted argument text included.
 *  - `invoked`  — the command actually runs the tool, in one of four
 *    spellings: a segment whose first word is the tool; one whose first word
 *    is a no-argument wrapper (`timeout`, `env`, …) that walks to it; one
 *    spelled by path (`/usr/bin/gh`), which ten of the eleven guards resolve
 *    through `basename`; and one only inside a quoted `sh -c` body.
 *  - `wasted`   — `matched` minus `invoked`. A wasted exec costs a fork and
 *    reaches no verdict.
 *
 * SEGMENTATION follows what mantahostels#2159 §5 measured of the matcher, not
 * `hooks.md:436-446`'s table, which omits `;` and `|`: separators are `;`,
 * newline, `&&`, `||`, `|` and `&`, at any nesting depth outside quotes, and
 * `$( … )`, backticks and `( … )` are descended into. Leading `VAR=value`
 * assignments are stripped before the first word is read.
 *
 * ANCHORED `Bash(x *)` MISSES FOUR SPELLINGS — a wrapper prefix
 * (`timeout 5 gh …`), a path (`/usr/bin/gh …`), a quoted body
 * (`sh -c "gh …"`) and the argument-less tool word (`gh` alone) — so its
 * wasted count is zero by construction and its cost is the `invoked` calls it
 * filters out. Whether that is a real loss depends on whether any guard acts
 * on those shapes, which is a guard-layer question this script does not
 * answer.
 *
 * IN NO §N3 FAMILY, DELIBERATELY. It gates nothing, runs from a prompt, writes
 * no file and files no issue; the two `process.exit(1)` paths are an
 * unreadable transcript directory and an unhandled throw, both of which must
 * not read as a zero count.
 *
 * KNOWN BOUNDS:
 *  - Shell keywords are not stripped, so a `then gh issue view …` inside a
 *    conditional reads as a segment led by `then` and scores as waste. Zero
 *    occurrences in a 1,906-call sample.
 *  - A command whose quoting the shell itself would reject (an unbalanced
 *    quote) leaves this walker inside a quote to end-of-string, folding the
 *    rest into one segment.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const readline = require("node:readline");
const { transcriptDir, readTranscriptFiles } = require("./lib/guard-fires");
const { flagValue, parseOrExit } = require("./lib/cli-args");

const { unwrapped } = require("./lib/issue-phase-scope");

/** @param {string} word */
const basename = (word) => word.slice(word.lastIndexOf("/") + 1);

/** A leading `VAR=value` assignment, the one prefix the matcher strips. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * A heredoc body is DATA, not commands — a `cat > f <<'EOF'` whose body holds
 * `gh issue create` runs no `gh` at all, and a body line leading with the tool
 * word would otherwise score as a bare invocation. Bodies are dropped before
 * segmentation; the redirection word itself stays, because it is part of the
 * command line the matcher tests.
 *
 * Both `<<DELIM` and `<<-DELIM` are handled, quoted delimiters included. An
 * UNTERMINATED heredoc — no closing delimiter in the string — drops everything
 * after it.
 * @param {string} cmd
 * @returns {string}
 */
function stripHeredocs(cmd) {
	/* One iterator, so the inner loop's lines — body and delimiter — are spent
	 * before the outer loop reads on. */
	const lines = cmd.split("\n").values();
	/** @type {string[]} */
	const out = [];
	for (const line of lines) {
		out.push(line);
		const m = line.match(
			/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/,
		);
		if (!m) continue;
		const delim = m[1] ?? m[2] ?? m[3];
		if (delim === undefined)
			throw new Error(
				`a heredoc match took no delimiter group: ${JSON.stringify(m[0])}`,
			);
		for (const body of lines) if (body.trim() === delim) break;
	}
	return out.join("\n");
}

/**
 * Split a command into the segments the matcher and the guards each read
 * independently. Quotes suppress separators; `$( )`, backticks and `( )` are
 * descended into rather than skipped, so their contents are segments too.
 * Heredoc bodies are dropped first — see stripHeredocs.
 * @param {string} rawCmd
 * @returns {string[]}
 */
function segments(rawCmd) {
	/** @type {Walk} */
	const w = { cmd: stripHeredocs(rawCmd), i: 0, cur: "", quote: "", out: [] };
	for (; w.i < w.cmd.length; w.i++) {
		const c = w.cmd.charAt(w.i);
		if (w.quote) segmentInQuote(w, c);
		else segmentOutside(w, c);
	}
	w.out.push(w.cur);
	return w.out;
}

/**
 * A character-at-a-time walk over a command: the string, the index, the text
 * gathered so far, the open quote (empty outside one) and what was emitted.
 * @typedef {{ cmd: string, i: number, cur: string, quote: string, out: string[] }} Walk
 */

/** Characters that end a segment outside quotes, and nothing more. */
const SEGMENT_BREAKS = new Set(["(", ")", "`", "{", "}", ";", "\n"]);

/**
 * One character inside a quote: a double-quoted backslash keeps itself and
 * the character it escapes; the closing quote is dropped.
 * @param {Walk} w accumulator: the walk's state, advanced one character
 * @param {string} c
 */
function segmentInQuote(w, c) {
	if (c === "\\" && w.quote === '"') {
		w.cur += c + (w.cmd[w.i + 1] ?? "");
		w.i++;
		return;
	}
	if (c === w.quote) {
		w.quote = "";
		return;
	}
	w.cur += c;
}

/**
 * @param {Walk} w accumulator: the gathered segment is pushed to out and cur emptied
 */
function cutSegment(w) {
	w.out.push(w.cur);
	w.cur = "";
}

/**
 * One character outside any quote.
 * @param {Walk} w accumulator: the walk's state, advanced one character
 * @param {string} c
 */
function segmentOutside(w, c) {
	if (c === "'" || c === '"') {
		w.quote = c;
		return;
	}
	if (c === "\\") {
		w.i++;
		return;
	}
	if (c === "$" && w.cmd[w.i + 1] === "(") {
		cutSegment(w);
		w.i++;
		return;
	}
	if (SEGMENT_BREAKS.has(c)) {
		cutSegment(w);
		return;
	}
	if (c === "&" || c === "|") {
		cutSegment(w);
		if (w.cmd[w.i + 1] === c) w.i++;
		return;
	}
	w.cur += c;
}

/**
 * The words of a segment, with leading `VAR=value` assignments stripped.
 * @param {string} seg
 * @returns {string[]} every word of the segment, assignments removed
 */
function words(seg) {
	const parts = seg.trim().split(/\s+/).filter(Boolean);
	let i = 0;
	for (const part of parts) {
		if (!ASSIGNMENT.test(part)) break;
		i++;
	}
	return parts.slice(i);
}

/**
 * Does an anchored `Bash(<tool> *)` fire — is `tool` the first word of some
 * segment, with an argument after it?
 * @param {string} cmd
 * @param {string} tool
 */
function anchoredFires(cmd, tool) {
	for (const seg of segments(cmd)) {
		const w = words(seg);
		if (w[0] === tool && w.length > 1) return true;
	}
	return false;
}

/**
 * Every quoted span in a command, contents only — where a `sh -c "gh …"` body
 * hides from `segments`, which folds a quoted span into its enclosing segment.
 * Heredoc bodies are dropped first, as in `segments`.
 * @param {string} rawCmd
 * @returns {string[]}
 */
function quotedSpans(rawCmd) {
	/** @type {Walk} */
	const w = { cmd: stripHeredocs(rawCmd), i: 0, cur: "", quote: "", out: [] };
	for (; w.i < w.cmd.length; w.i++) {
		const c = w.cmd.charAt(w.i);
		if (w.quote) spanInQuote(w, c);
		// The same escape rule `segments` applies outside a quote, so the two
		// walkers cannot disagree about where a quoted span begins.
		else if (c === "\\") w.i++;
		else if (c === "'" || c === '"') w.quote = c;
	}
	return w.out;
}

/**
 * One character inside a quote: a double-quoted backslash keeps only the
 * character it escapes; the closing quote emits the span.
 * @param {Walk} w accumulator: the walk's state, advanced one character
 * @param {string} c
 */
function spanInQuote(w, c) {
	if (c === "\\" && w.quote === '"') {
		w.cur += w.cmd[w.i + 1] ?? "";
		w.i++;
		return;
	}
	if (c === w.quote) {
		w.out.push(w.cur);
		w.cur = "";
		w.quote = "";
		return;
	}
	w.cur += c;
}

/**
 * The index of the first word past any leading wrappers — 0 where the segment
 * leads with none: the walk guard-issue-phase-scope.js's core performs.
 * @param {string[]} w the segment's words
 * @returns {number}
 */
const wrapperEnd = (w) => w.length - unwrapped(w).length;

/**
 * How a segment that does not lead with `tool` still reaches it: by path,
 * behind wrappers, or not at all.
 * @param {string[]} w the segment's words
 * @param {string} tool
 * @returns {"pathspelled" | "wrapped" | null}
 */
function indirectReach(w, tool) {
	const [head] = w;
	// Ten of the eleven guards resolve their command word through
	// `basename` — the six gh guards (lib/issue-phase-scope.js's judge and
	// five siblings) and the four git guards (`lib/shell-words.js`'s
	// `gitWords`) — so a path-spelled `/usr/bin/gh` or
	// `/usr/bin/git` IS judged by them, while the anchored `if` matches it
	// in neither spelling. The eleventh, `place-new-issue.sh`, matches a
	// bare `gh issue create` at the start of the command or after a
	// separator, so it skips a path-spelled call whatever its `if`.
	if (head !== undefined && basename(head) === tool) return "pathspelled";
	const i = wrapperEnd(w);
	if (i > 0 && basename(w[i] ?? "") === tool) return "wrapped";
	return null;
}

/**
 * How the command reaches `tool`, if it does: `"bare"` (a segment's own first
 * word), `"wrapped"` (behind `timeout`/`env`/…), `"quoted"` (only as the first
 * word inside a quoted body, e.g. `sh -c "gh …"`), or `null` — the tool word
 * appears nowhere as a command, so every exec on it is wasted.
 *
 * `"quoted"` is deliberately narrow: a bare mention in prose (`the gh guard`)
 * is NOT an invocation.
 * @param {string} cmd
 * @param {string} tool
 * @returns {"bare" | "wrapped" | "pathspelled" | "quoted" | null}
 */
function invocation(cmd, tool) {
	/** @type {"bare" | "wrapped" | "pathspelled" | "quoted" | null} */
	let best = null;
	/**
	 * @param {string[]} segs
	 * @param {"bare" | "quoted"} kind
	 * @returns {"bare" | "quoted" | null}
	 */
	const consider = (segs, kind) => {
		for (const seg of segs) {
			const w = words(seg);
			if (w[0] === tool) return kind;
			const reach = indirectReach(w, tool);
			if (reach) best = best || reach;
		}
		return null;
	};
	if (consider(segments(cmd), "bare") === "bare") return "bare";
	for (const span of quotedSpans(cmd)) {
		if (consider(segments(span), "quoted") === "quoted")
			return best || "quoted";
	}
	return best;
}

/**
 * @param {string} file
 * @param {(cmd: string, id: string) => void} onCommand
 */
async function scan(file, onCommand) {
	const rl = readline.createInterface({
		input: fs.createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) scanLine(line, file, onCommand);
}

/**
 * Hand every Bash command on one transcript line to `onCommand`.
 * @param {string} line
 * @param {string} file
 * @param {(cmd: string, id: string) => void} onCommand
 */
function scanLine(line, file, onCommand) {
	// Cheap pre-filter, and the whole runtime without it.
	if (!line.includes('"Bash"')) return;
	let rec;
	try {
		rec = JSON.parse(line);
	} catch {
		// A transcript line that will not parse is skipped and NOT counted.
		// Deliberate: the corpus carries truncated tail lines from sessions
		// killed mid-write, and counting those as calls would inflate the
		// denominator every share here is taken over. A whole file that
		// will not read IS counted, in `unreadable`.
		return;
	}
	const content = rec?.message?.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block?.type !== "tool_use" || block?.name !== "Bash") continue;
		const cmd = block?.input?.command;
		if (typeof cmd !== "string" || !cmd) continue;
		onCommand(cmd, block.id || `${file}:${cmd.length}:${cmd.slice(0, 40)}`);
	}
}

/** @param {string} text */
const write = (text) => writeFd(1, text);

/**
 * @returns {{ asJson: boolean, dump: string | null, dir: string, limit: number }}
 */
function readFlags() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage:
			"usage: node scripts/measure-if-overmatch.js [--dir <path>] [--json] [--limit <n>] [--dump wrapped|quoted]",
		flags: {
			"--dir": "value",
			"--json": "boolean",
			"--limit": "value",
			"--dump": "value",
		},
	});
	const asJson = flags["--json"] === true;
	const dump = flagValue(flags, "--dump") ?? null;
	const dir = flagValue(flags, "--dir") ?? transcriptDir(process.cwd());
	const limitArg = flagValue(flags, "--limit");
	const limit = limitArg === undefined ? Number.NaN : Number(limitArg);
	return { asJson, dump, dir, limit };
}

/**
 * The transcripts to read: all of them, or the `limit` most recently modified.
 * @template {{ file: string }} F
 * @param {F[]} files
 * @param {number} limit
 * @returns {F[]}
 */
function chooseFiles(files, limit) {
	if (!Number.isFinite(limit)) return files;
	return files
		.map((f) => ({ ...f, mtime: fs.statSync(f.file).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit);
}

/**
 * One tool's counters. `invoked` holds one count per invocation kind, keyed
 * by the kind `invocation` returns.
 * @typedef {object} ToolStats
 * @property {number} matchedUnanchored
 * @property {number} matchedAnchored
 * @property {number} matchedSpaced
 * @property {{bare: number, wrapped: number, pathspelled: number, quoted: number}} invoked
 * @property {number} wrappedMatchedSpaced
 * @property {number} wastedUnanchored
 * @property {number} wastedSpaced
 * @property {Map<string, number>} wasteWords
 */

/**
 * The running totals the file loop builds.
 * @typedef {object} Counts
 * @property {string[]} tools
 * @property {Set<string>} seen
 * @property {Record<string, ToolStats>} stats one per tool
 * @property {number} calls
 * @property {Map<string, number>} dumped
 * @property {string | null} dump
 */

/**
 * @param {string[]} tools
 * @param {string | null} dump
 * @returns {Counts}
 */
function newCounts(tools, dump) {
	/** @type {Record<string, ToolStats>} */
	const stats = {};
	for (const tool of tools) {
		stats[tool] = {
			matchedUnanchored: 0,
			matchedAnchored: 0,
			matchedSpaced: 0,
			invoked: { bare: 0, wrapped: 0, pathspelled: 0, quoted: 0 },
			wrappedMatchedSpaced: 0,
			wastedUnanchored: 0,
			wastedSpaced: 0,
			/** @type {Map<string, number>} */
			wasteWords: new Map(),
		};
	}
	return { tools, seen: new Set(), stats, calls: 0, dumped: new Map(), dump };
}

/**
 * Count one Bash call, once per tool-use id.
 * @param {Counts} acc accumulator: the id is marked seen and the call counted
 * @param {string} cmd
 * @param {string} id
 */
function countCommand(acc, cmd, id) {
	if (acc.seen.has(id)) return;
	acc.seen.add(id);
	acc.calls++;
	for (const tool of acc.tools) countTool(acc, cmd, tool);
}

/**
 * Count one Bash call against one tool's rules.
 * @param {Counts} acc accumulator: the tool's stats and the dump are counted
 * @param {string} cmd
 * @param {string} tool
 */
function countTool(acc, cmd, tool) {
	const s = /** @type {ToolStats} */ (acc.stats[tool]);
	const substring = cmd.includes(tool);
	const spaced = cmd.includes(`${tool} `);
	const inv = invocation(cmd, tool);
	if (substring) s.matchedUnanchored++;
	if (spaced) s.matchedSpaced++;
	if (anchoredFires(cmd, tool)) s.matchedAnchored++;
	if (inv !== null) s.invoked[inv]++;
	if (inv === "wrapped" && spaced) s.wrappedMatchedSpaced++;
	if (acc.dump && inv === acc.dump) {
		const key = `${tool}\t${cmd}`;
		acc.dumped.set(key, (acc.dumped.get(key) || 0) + 1);
	}
	if (substring && inv === null) {
		s.wastedUnanchored++;
		countWasteWords(s.wasteWords, cmd, tool);
	}
	if (spaced && inv === null) s.wastedSpaced++;
}

/**
 * Tally each word carrying the tool word in a wasted call — what the
 * unanchored rule matched instead.
 * @param {Map<string, number>} wasteWords accumulator: each wasted word is counted
 * @param {string} cmd
 * @param {string} tool
 */
function countWasteWords(wasteWords, cmd, tool) {
	for (const m of cmd.matchAll(
		new RegExp(`[A-Za-z._/-]*${tool}[A-Za-z._/-]*`, "g"),
	)) {
		wasteWords.set(m[0], (wasteWords.get(m[0]) || 0) + 1);
	}
}

/**
 * One tool's report figures, off its counters.
 * @param {ToolStats} s
 */
function buildToolReport(s) {
	const top = [...s.wasteWords.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8);
	return {
		matchedUnanchored: s.matchedUnanchored,
		matchedSpaced: s.matchedSpaced,
		matchedAnchored: s.matchedAnchored,
		invoked:
			s.invoked.bare +
			s.invoked.wrapped +
			s.invoked.pathspelled +
			s.invoked.quoted,
		invokedBare: s.invoked.bare,
		invokedWrapped: s.invoked.wrapped,
		invokedPathspelled: s.invoked.pathspelled,
		wrappedMatchedSpaced: s.wrappedMatchedSpaced,
		invokedQuoted: s.invoked.quoted,
		wastedUnanchored: s.wastedUnanchored,
		wastedSpaced: s.wastedSpaced,
		wasteShareUnanchored: s.matchedUnanchored
			? s.wastedUnanchored / s.matchedUnanchored
			: 0,
		wasteShareSpaced: s.matchedSpaced ? s.wastedSpaced / s.matchedSpaced : 0,
		topWasteWords: top,
	};
}

/**
 * `--dump`: the commands behind one invocation count, most frequent first.
 * @param {Map<string, number>} dumped
 * @param {string} dump
 */
function writeDump(dumped, dump) {
	for (const [key, n] of [...dumped.entries()].sort((a, b) => b[1] - a[1])) {
		const [tool, cmd] = key.split("\t");
		if (cmd === undefined) throw new Error(`dump key ${key} has no tab`);
		write(`${n}\t${tool}\t${cmd.replace(/\n/g, " ⏎ ").slice(0, 200)}\n`);
	}
	write(`-- ${dumped.size} distinct ${dump} command(s)\n`);
}

/**
 * The run's report: the corpus figures, plus one `buildToolReport` per tool keyed
 * by the tool's name. `any` because the two kinds of value share one object,
 * which `--json` prints whole.
 * @typedef {Record<string, any>} Report
 */

/**
 * @param {Report} out
 * @param {string[]} tools
 */
function writeText(out, tools) {
	write(`corpus: ${out.transcripts} transcripts, ${out.bashCalls} Bash calls`);
	write(out.unreadable ? `, ${out.unreadable} unreadable\n` : "\n");
	for (const tool of tools) {
		const s = out[tool];
		/** @param {number} n */
		const pct = (n) => `${(n * 100).toFixed(1)}%`;
		write(`\n[${tool}]\n`);
		write(
			`  Bash(*${tool}*)  matched ${s.matchedUnanchored}  wasted ${s.wastedUnanchored} (${pct(s.wasteShareUnanchored)})\n`,
		);
		write(
			`  Bash(*${tool} *) matched ${s.matchedSpaced}  wasted ${s.wastedSpaced} (${pct(s.wasteShareSpaced)})\n`,
		);
		write(`  Bash(${tool} *)  matched ${s.matchedAnchored}  wasted 0\n`);
		write(
			`  invoked ${s.invoked} = bare ${s.invokedBare} + wrapped ${s.invokedWrapped}` +
				` + path-spelled ${s.invokedPathspelled} + quoted ${s.invokedQuoted}\n`,
		);
		write(
			`  anchored misses ${s.invoked - s.matchedAnchored} invoking call(s)\n`,
		);
		write(
			`  Bash(*${tool} *) reaches ${s.wrappedMatchedSpaced} of ${s.invokedWrapped} wrapped call(s)\n`,
		);
		write(
			`  top waste words: ${s.topWasteWords
				.map(
					/** @param {[string, number]} pair */ ([word, n]) => `${word} ${n}`,
				)
				.join(", ")}\n`,
		);
	}
}

async function main() {
	const { asJson, dump, dir, limit } = readFlags();

	const files = readTranscriptFiles(dir);
	if (!files) {
		write(`measure-if-overmatch: cannot read ${dir}\n`);
		process.exit(1);
	}
	const chosen = chooseFiles(files, limit);

	const tools = ["git", "gh"];
	const acc = newCounts(tools, dump);
	let unreadable = 0;

	for (const { file } of chosen) {
		try {
			await scan(file, (cmd, id) => countCommand(acc, cmd, id));
		} catch {
			unreadable++;
		}
	}

	/** @type {Report} */
	const out = {
		dir,
		transcripts: chosen.length,
		unreadable,
		bashCalls: acc.calls,
	};
	for (const tool of tools)
		out[tool] = buildToolReport(/** @type {ToolStats} */ (acc.stats[tool]));

	if (dump) {
		writeDump(acc.dumped, dump);
		return;
	}
	if (asJson) {
		write(`${JSON.stringify(out, null, 2)}\n`);
		return;
	}
	writeText(out, tools);
}

/* The scan is a several-minute walk over every transcript on disk, so it runs
 * only when this file is the entry point — loading it for `main`, as
 * lib/run-in-process.js's `runInProcessAsync` does, must not launch one. */
if (require.main === module) {
	main().catch((e) => {
		write(`measure-if-overmatch: ${e.stack || e}\n`);
		process.exit(1);
	});
}

module.exports = { main };
