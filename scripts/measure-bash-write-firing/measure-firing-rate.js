#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("../lib/write-fd.js");
const readline = require("node:readline");
const { isZeroed, parseJsonlRow } = require("../lib/jsonl.js");

/** @param {string} p */
const TIER1 = (p) =>
	/^(docs\/|\.claude\/)/.test(p) || p === "CLAUDE.md" || p === "AGENTS.md";

function quotedTokens(/** @type {string} */ text) {
	const out = new Set();
	for (const q of ["'", '"', "`"]) {
		const re = new RegExp(`${q}[^${q}\\s]+${q}`, "g");
		for (const m of text.match(re) ?? []) out.add(m.slice(1, -1));
	}
	return [...out];
}

function assignmentCount(/** @type {string[]} */ words) {
	let i = 0;
	for (const w of words) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) break;
		i++;
	}
	return i;
}

/**
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
 * @param {string} base
 * @param {string[]} args
 */
function hasInlineArgs(base, args) {
	const flag = flagPatterns(/^node/.test(base));
	for (let i = 0; i < args.length; i++) {
		const w = args[i];
		if (w === undefined) break;
		if (w === "-") return args.some((a) => a.startsWith("<<"));
		if (w.startsWith("<<") || flag.inline.test(w)) return true;
		if (!w.startsWith("-") || flag.module.test(w)) break;
		if (flag.valued.test(w)) i++;
	}
	return false;
}

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
 * @param {string} cmd
 * @param {RegExp} tool
 */
const editsInPlace = (cmd, tool) =>
	cmd.split(/[|;]/).some((stretch) => {
		const at = tool.exec(stretch);
		return at !== null && stretch.includes("-i", at.index + at[0].length);
	});

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
let unparsed = 0;
let zeroed = 0;
/** @type {{ s: string; c: string; cands: string[] }[]} */
const samples = [];

const rl = readline.createInterface({
	input: fs.createReadStream(corpusPath),
	crlfDelay: Number.POSITIVE_INFINITY,
});
rl.on("line", (line) => {
	if (isZeroed(line)) zeroed++;
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
				zeroedRecords: zeroed,
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
