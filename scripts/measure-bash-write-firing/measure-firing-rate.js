#!/usr/bin/env node
/*
 * measure-bash-write-firing/measure-firing-rate.js — how often the
 * inline-interpreter arm fires, and how many distinct tier-1 candidates a
 * firing session produces (mantahostels#2854; the 2,000 B session budget rests on the
 * second figure).
 *
 *   node <this file> <corpus.jsonl> <fires.jsonl>
 *
 * `corpus.jsonl` comes from extract-bash-commands.js. `fires.jsonl` is written
 * out for classify-false-warns.js and measure-claimable-share.js.
 *
 * IT RE-SPELLS THE GUARD'S TWO LIMBS RATHER THAN CALLING IT, and does not share
 * lib.js's token scan for the same reason: this file IS the drift check. Run
 * the guard over the sample it writes and a divergence shows up as a guard that
 * fires on commands this script says it should fire on. Sharing an
 * implementation would make the check check itself.
 *
 * SO IT MUST BE KEPT IN STEP BY HAND. `hasInlineArgs` below tracks
 * lib/shell-words.js's `programSource`, which stops the scan at the script,
 * reads bundled python short options and skips a valued flag's value.
 * mantahostels#2854's published 137/206 firings and 33%/46% false
 * warns were measured BEFORE that narrowing, so they over-count: this script
 * now reports fewer firings than those figures did, and re-deriving them means
 * re-running the whole pipeline rather than reusing the numbers.
 */
const fs = require("node:fs");
const { writeFd } = require("../lib/write-fd.js");
const readline = require("node:readline");
const { parseJsonlRow } = require("../lib/jsonl.js");

/** @param {string} p */
const TIER1 = (p) =>
	/^(docs\/|\.claude\/)/.test(p) || p === "CLAUDE.md" || p === "AGENTS.md";

/** Every quoted whitespace-free token, three passes, one per quote kind. */
function quotedTokens(/** @type {string} */ text) {
	const out = new Set();
	for (const q of ["'", '"', "`"]) {
		const re = new RegExp(`${q}[^${q}\\s]+${q}`, "g");
		for (const m of text.match(re) ?? []) out.add(m.slice(1, -1));
	}
	return [...out];
}

/** How many leading words are `NAME=value` environment assignments. */
function assignmentCount(/** @type {string[]} */ words) {
	let i = 0;
	for (const w of words) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) break;
		i++;
	}
	return i;
}

/**
 * The guard's flag table, as patterns: node's options do not bundle; a python
 * bundle reads left to right, `c` inline, `m` a module, and `W` or `X` taking
 * the rest of the word or, ending it, the next word.
 * @param {boolean} node
 */
const flagPatterns = (node) =>
	node
		? {
				inline: /^(-e|--eval|-p|--print|-pe)(=|$)/,
				valued:
					/^(-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--input-type|--env-file|--title)$/,
				module: /^$/,
			}
		: {
				inline: /^-[^-WXcm]*c/,
				valued: /^-[^-cm]*[WX]$|^--check-hash-based-pycs$/,
				module: /^-[^-WXc]*m/,
			};

/**
 * Does an interpreter's argument list carry a heredoc or an inline-code flag
 * before its script?
 * @param {string} base
 * @param {string[]} args
 */
function hasInlineArgs(base, args) {
	const flag = flagPatterns(/^node/.test(base));
	for (let i = 0; i < args.length; i++) {
		const w = args[i];
		if (w === undefined) break;
		// A bare `-` reads the program from stdin, which only a heredoc feeds.
		if (w === "-") return args.some((a) => a.startsWith("<<"));
		if (w.startsWith("<<") || flag.inline.test(w)) return true;
		// THE SCAN STOPS AT THE SCRIPT, as the guard's has since `3aeedfb25`:
		// a flag past the module or file name belongs to the PROGRAM.
		if (!w.startsWith("-") || flag.module.test(w)) break;
		if (flag.valued.test(w)) i++;
	}
	return false;
}

/** Does a segment run an inline interpreter? Segments split at shell operators. */
function inlineInterp(/** @type {string} */ cmd) {
	for (const seg of cmd.split(/&&|\|\||[;|&()]/)) {
		const words = seg.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;
		const i = assignmentCount(words);
		const base = (words[i] ?? "").split("/").pop() ?? "";
		if (!/^(python[0-9.]*|node|nodejs)$/.test(base)) continue;
		if (hasInlineArgs(base, words.slice(i + 1))) return true;
	}
	return false;
}

/**
 * Whether a stretch of `cmd` between `|` and `;` runs `tool` followed by a
 * blank and, later in that stretch, carries `-i`. The first `tool` in a
 * stretch leaves the most room after it, so it alone is read; as one regex,
 * every `tool` is a fresh start that rereads the stretch.
 * @param {string} cmd
 * @param {RegExp} tool the tool's name and the blank after it
 */
const editsInPlace = (cmd, tool) =>
	cmd.split(/[|;]/).some((stretch) => {
		const at = tool.exec(stretch);
		return at !== null && stretch.includes("-i", at.index + at[0].length);
	});

/** The nine spellings already read, approximated for a RATIO only. */
function oldRoute(/** @type {string} */ cmd) {
	return (
		/(^|[\s;|&(])(cp|mv|tee|truncate)\s|git\s+restore\s|git\s+checkout\s+--\s|[0-9]?>>?\s*[^\s&|]/.test(
			cmd,
		) ||
		editsInPlace(cmd, /sed\s/) ||
		editsInPlace(cmd, /perl\s/)
	);
}

const [, , corpusPath, firesPath] = process.argv;
if (!corpusPath || !firesPath) {
	writeFd(2, "usage: measure-firing-rate.js <corpus.jsonl> <fires.jsonl>\n");
	process.exit(2);
}

const bySession = new Map();
let total = 0;
// Counted and printed rather than dropped: every figure below is a rate, and a
// silently shrunken denominator is a wrong rate that looks right (mantahostels#2865 review).
let unparsed = 0;
/** @type {{ s: string; c: string; cands: string[] }[]} */
const samples = [];

const rl = readline.createInterface({
	input: fs.createReadStream(corpusPath),
	crlfDelay: Number.POSITIVE_INFINITY,
});
rl.on("line", (line) => {
	const r = parseJsonlRow(line);
	if (r === null) return;
	if (r === undefined || typeof r.s !== "string" || typeof r.c !== "string") {
		unparsed++;
		return;
	}
	total++;
	const cands = quotedTokens(r.c).filter(TIER1);
	const fires = cands.length > 0 && inlineInterp(r.c);
	const old =
		oldRoute(r.c) && quotedTokens(r.c).concat(r.c.split(/\s+/)).some(TIER1);
	const s = bySession.get(r.s) ?? {
		newFire: 0,
		oldFire: 0,
		newTargets: new Set(),
		oldish: new Set(),
	};
	if (fires) {
		s.newFire++;
		for (const c of cands) s.newTargets.add(c);
		samples.push({ s: r.s, c: r.c, cands });
	}
	if (old) s.oldFire++;
	bySession.set(r.s, s);
});
rl.on("close", () => {
	const sess = [...bySession.values()];
	const withNew = sess.filter((s) => s.newFire > 0);
	const nf = sess.reduce((a, s) => a + s.newFire, 0);
	const of_ = sess.reduce((a, s) => a + s.oldFire, 0);
	const dist = withNew.map((s) => s.newTargets.size).sort((a, b) => a - b);
	/**
	 * @param {number[]} arr
	 * @param {number} p
	 */
	const pct = (arr, p) =>
		arr[Math.min(arr.length - 1, Math.floor((arr.length * p) / 100))];
	writeFd(
		1,
		`${JSON.stringify(
			{
				commands: total,
				unparsedLines: unparsed,
				sessions: sess.length,
				newArmFirings: nf,
				oldRouteFirings: of_,
				ratio: +(nf / Math.max(1, of_)).toFixed(2),
				sessionsWithNewFiring: withNew.length,
				distinctTier1PathsPerFiringSession: {
					median: pct(dist, 50),
					p75: pct(dist, 75),
					p90: pct(dist, 90),
					p99: pct(dist, 99),
					max: dist.at(-1),
				},
				firingsPerFiringSession: {
					median: pct(
						withNew.map((s) => s.newFire).sort((a, b) => a - b),
						50,
					),
					p90: pct(
						withNew.map((s) => s.newFire).sort((a, b) => a - b),
						90,
					),
				},
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(firesPath, samples.map((x) => JSON.stringify(x)).join("\n"));
	writeFd(2, `samples=${samples.length}\n`);
});
