#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
/** @param {string} name */
function coreLib(name) {
	try {
		return require(`../../../../scripts/lib/${name}`);
	} catch (e) {
		const dir = process.env.WFC_CORE_SCRIPTS_DIR;
		const code = e instanceof Error && "code" in e ? e.code : undefined;
		if (code !== "MODULE_NOT_FOUND" || !dir) throw e;
		return require(path.join(dir, "lib", name));
	}
}
/** @type {typeof import("../../../../scripts/lib/workflow-core-config")} */
const { requireKey } = coreLib("workflow-core-config");
/** @type {typeof import("../../../../scripts/lib/write-fd.js")} */
const { writeFd } = coreLib("write-fd.js");
/** @type {typeof import("../../../../scripts/lib/script-claim.js")} */
const { claimByArbiter } = coreLib("script-claim.js");

/**
 * @typedef {{id: string, state: string, t: string, p: number, needs?: string[],
 *   m?: string|[string, string][]|null, mn?: string}} Item
 * @typedef {{n: number, title: string}} Phase
 */

/** @param {string} target */
function claimTarget(target) {
	const claim = claimByArbiter(target);
	const said = claim.claimed
		? claim.warning
		: `no claim taken on ${target}: ${claim.why}`;
	if (said) writeFd(2, `${said}\n`);
}

/**
 * @param {string} [problem]
 * @returns {never}
 */
function usage(problem) {
	if (problem) writeFd(2, `ERROR: ${problem}\n`);
	writeFd(
		2,
		"usage: node gen-roadmap-digest.js <roadmap.html> (--out <path> | --stdout)\n",
	);
	writeFd(
		2,
		"  <roadmap.html>  required, positional, must come first — not a flag.\n",
	);
	writeFd(2, "  --out <path>    write the digest there. Normal use:\n");
	writeFd(2, "                  --out docs/roadmap-digest.md\n");
	writeFd(
		2,
		"  --stdout        print instead of writing. Never the default: a\n",
	);
	writeFd(
		2,
		"                  missing destination must not be a silent no-op.\n",
	);
	process.exit(1);
}

const file = process.argv[2];
if (!file) usage("no roadmap file given");
if (file.startsWith("--")) {
	usage(`first argument must be the roadmap file path, got the flag "${file}"`);
}

const outIdx = process.argv.indexOf("--out");
let outPath = null;
if (outIdx > -1) {
	outPath = process.argv[outIdx + 1];
	if (!outPath || outPath.startsWith("--"))
		usage("--out was given without a path argument");
}
const toStdout = process.argv.includes("--stdout");
if (outPath && toStdout)
	usage("--out and --stdout are mutually exclusive — pick one");
if (!outPath && !toStdout) {
	usage(
		"no output destination: pass --out <path> to write, or --stdout to print",
	);
}

const html = fs.readFileSync(file, "utf8");

/**
 * @param {string} decl
 * @returns {any[]}
 */
function extractArray(decl) {
	const start = html.indexOf(decl);
	if (start === -1) throw new Error(`could not find "${decl}"`);
	const end = html.indexOf("\n];", start);
	if (end === -1)
		throw new Error(`could not find closing "\\n];" after "${decl}"`);
	const block = html.slice(start, end + 3);
	const name = decl.match(/const (\w+)/)?.[1];
	if (!name) throw new Error(`could not read the declared name from "${decl}"`);
	return new Function(`${block}\nreturn ${name};`)();
}

/** @type {Item[]} */
const ITEMS = extractArray("const ITEMS = [");
/** @type {Phase[]} */
const PHASES = extractArray("const PHASES = [");

const vm = html.match(/<p class="docmeta">([^<]+)<\/p>/);
let version = "version unknown";
if (vm) {
	const line = vm[1];
	if (line === undefined) throw new Error("docmeta matched without its text");
	version = line.trim();
}

/**
 * @param {unknown} s
 * @returns {string}
 */
function plain(s) {
	return String(s)
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&rarr;/g, "->")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * @param {Item["m"]} m
 * @returns {string|null}
 */
function effort(m) {
	if (!m) return null;
	if (typeof m === "string") return m;
	if (Array.isArray(m)) return m.map((p) => `${p[0]}:${p[1]}`).join("+");
	return null;
}

/**
 * @param {Item} it
 * @returns {string}
 */
function needsOf(it) {
	return it.needs && it.needs.length > 0 ? it.needs.join(", ") : "—";
}

const lines = [];
lines.push(`# ${requireKey("name")} roadmap — digest (map only)`);
lines.push("");
lines.push(`${version} · ${ITEMS.length} cards`);
lines.push("");
lines.push(
	"> DERIVED ARTIFACT — do not edit by hand. Generated from " +
		"`reference-roadmap.html` by `gen-roadmap-digest.js` as a step of " +
		"the roadmap-edit loop. Card body, done-when and callouts are NOT here: " +
		"when building a card, open the HTML and paste that card in full. This map " +
		"exists so a build session knows what every other card is — its state, " +
		"dependencies, m-code and execution surface — without loading the " +
		"whole file. The version line above must match the roadmap HTML's; CI " +
		"fails the build if they drift.",
);
lines.push("");
lines.push(
	"Legend: `id` [state] title · needs: … · [m-code] · mn: execution note. " +
		"m-code only where a card departs from the Opus 5.5 · medium default " +
		"(the workflow-core plugin's `docs/effort-guide.md`): max, —, or a " +
		"leg-scoped step:max. " +
		"States: active / open / parked / done.",
);
lines.push(
	"⚠ Any other m-code printed below (S/H, O/H, O/M) is retired (mantahostels#831) " +
		"— validate.js warns on it.",
);
lines.push("");

for (const ph of PHASES) {
	const cards = ITEMS.filter((it) => it.p === ph.n);
	if (cards.length === 0) continue;
	lines.push(`## Phase ${ph.n} — ${plain(ph.title)}`);
	lines.push("");
	for (const it of cards) {
		let line = `- \`${it.id}\` [${it.state}] ${plain(it.t)} · needs: ${needsOf(it)}`;
		const eff = effort(it.m);
		if (eff) line += ` · ${eff}`;
		if (it.mn) line += ` · mn: ${plain(it.mn)}`;
		lines.push(line);
	}
	lines.push("");
}

const md = lines.join("\n");

if (toStdout) {
	writeFd(1, md);
} else {
	if (!outPath)
		throw new Error(
			"gen-roadmap-digest.js: outPath is unset outside --stdout — usage() " +
				"should have exited before reaching here; check the argv parsing above.",
		);
	claimTarget(outPath);
	fs.writeFileSync(outPath, md);
	writeFd(
		2,
		`wrote ${outPath} — ${md.length} chars, ${ITEMS.length} cards, ${version}\n`,
	);
}
