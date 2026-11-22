#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const readline = require("node:readline");
const { parseJsonlRow } = require("./lib/jsonl.js");
const { transcriptDirs, readTranscriptCorpus } = require("./lib/guard-fires");
const { flagValue, parseOrExit } = require("./lib/cli-args");

const { unwrapped } = require("./lib/issue-phase-scope");

/** @typedef {import("./lib/transcript.js").TranscriptRecord} TranscriptRecord */

/** @param {string} word */
const basename = (word) => word.slice(word.lastIndexOf("/") + 1);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * @param {string} cmd
 * @returns {string}
 */
function stripHeredocs(cmd) {
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

/** @typedef {{ cmd: string, i: number, cur: string, quote: string, out: string[] }} Walk */

const SEGMENT_BREAKS = new Set(["(", ")", "`", "{", "}", ";", "\n"]);

/**
 * @param {Walk} w
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

/** @param {Walk} w */
function cutSegment(w) {
	w.out.push(w.cur);
	w.cur = "";
}

/**
 * @param {Walk} w
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
 * @param {string} seg
 * @returns {string[]}
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
 * @param {string} rawCmd
 * @returns {string[]}
 */
function quotedSpans(rawCmd) {
	/** @type {Walk} */
	const w = { cmd: stripHeredocs(rawCmd), i: 0, cur: "", quote: "", out: [] };
	for (; w.i < w.cmd.length; w.i++) {
		const c = w.cmd.charAt(w.i);
		if (w.quote) spanInQuote(w, c);
		else if (c === "\\") w.i++;
		else if (c === "'" || c === '"') w.quote = c;
	}
	return w.out;
}

/**
 * @param {Walk} w
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
 * @param {string[]} w
 * @returns {number}
 */
const wrapperEnd = (w) => w.length - unwrapped(w).length;

/**
 * @param {string[]} w
 * @param {string} tool
 * @returns {"pathspelled" | "wrapped" | null}
 */
function indirectReach(w, tool) {
	const [head] = w;
	if (head !== undefined && basename(head) === tool) return "pathspelled";
	const i = wrapperEnd(w);
	if (i > 0 && basename(w[i] ?? "") === tool) return "wrapped";
	return null;
}

/**
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
 * @param {string} line
 * @param {string} file
 * @param {(cmd: string, id: string) => void} onCommand
 */
function scanLine(line, file, onCommand) {
	if (!line.includes('"Bash"')) return;
	const rec = /** @type {TranscriptRecord | null | undefined} */ (
		parseJsonlRow(line)
	);
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
 * @returns {{ asJson: boolean, dump: string | null, dirs: string[], limit: number }}
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
	const given = flagValue(flags, "--dir");
	const dirs = given ? [given] : transcriptDirs();
	const limitArg = flagValue(flags, "--limit");
	const limit = limitArg === undefined ? Number.NaN : Number(limitArg);
	return { asJson, dump, dirs, limit };
}

/**
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
 * @typedef {object} Counts
 * @property {string[]} tools
 * @property {Set<string>} seen
 * @property {Record<string, ToolStats>} stats
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
 * @param {Counts} acc
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
 * @param {Counts} acc
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
 * @param {Map<string, number>} wasteWords
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

/** @param {ToolStats} s */
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

/** @typedef {Record<string, any>} Report */

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
	const { asJson, dump, dirs, limit } = readFlags();

	const { files, unreadable: unlisted } = readTranscriptCorpus(dirs);
	if (unlisted.length > 0) {
		write(`measure-if-overmatch: cannot read ${unlisted.join(", ")}\n`);
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
		dirs,
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

if (require.main === module) {
	main().catch((e) => {
		write(`measure-if-overmatch: ${e.stack || e}\n`);
		process.exit(1);
	});
}

module.exports = { main };
