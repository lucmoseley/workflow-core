#!/usr/bin/env node
/*
 * gen-roadmap-digest.js — derive the slim roadmap map for Claude Code.
 *
 * Usage:  node gen-roadmap-digest.js <roadmap.html> (--out <digest.md> | --stdout)
 *
 * An output destination is REQUIRED. This used to default to stdout, so a
 * forgotten --out printed 26k of digest, exited 0, and wrote nothing — the
 * roadmap HTML then shipped with a stale digest and only CI caught it. Wanting
 * stdout is now something you say out loud, with --stdout.
 *
 * Reads the canonical roadmap HTML, extracts ITEMS/PHASES and the docmeta
 * version line WITHOUT executing the page, and emits a compact markdown map:
 * one line per card (id, state, title, needs, m-code, model-note), grouped by
 * phase. Card BODY text (b / done-when / callouts) is deliberately omitted —
 * the digest is a map, not the territory. Paste the full card when building it.
 *
 * The `mn` (model-note) IS included: it carries the execution surface a build
 * session needs to route itself (Research run, Supabase MCP, Frontend Design,
 * PostHog/Sentry MCP, plugin defaults), which is exactly the cross-card
 * context this file exists to provide.
 *
 * This script is the ONLY thing that writes the digest. The digest is a build
 * artifact — never hand-edited. It runs as a step of the roadmap-edit loop,
 * right after validate.js passes, so the digest and the HTML are generated
 * from the same bytes and carry the same version stamp.
 */

const fs = require("node:fs");
const path = require("node:path");
/* Relative to this file, as claimOrAbort's arbiter is. The one caller that
 * runs a COPY of this file is scripts/check-digest-render.js, from the staged
 * copy pre-commit writes to a temp dir where no sibling scripts/ exists; it
 * names its own scripts dir in WFC_CORE_SCRIPTS_DIR for this fallback (workflow-core#3). */
const { requireKey } = (() => {
	try {
		return require("../../../../scripts/lib/workflow-core-config");
	} catch (e) {
		const dir = process.env.WFC_CORE_SCRIPTS_DIR;
		// Residual: a missing require INSIDE the config reader also raises
		// MODULE_NOT_FOUND, and with the env var set reads as a path miss.
		// Narrowed in place, not through scripts/lib/caught.js: the copy
		// check-digest-render.js runs has no scripts/lib/ beside it.
		const code = e instanceof Error && "code" in e ? e.code : undefined;
		if (code !== "MODULE_NOT_FOUND" || !dir) throw e;
		return require(path.join(dir, "lib/workflow-core-config"));
	}
})();

/**
 * @typedef {{id: string, state: string, t: string, p: number, needs?: string[],
 *   m?: string|[string, string][]|null, mn?: string}} Item
 * @typedef {{n: number, title: string}} Phase
 */

/**
 * Take the file-claim on `target`, or stop. Failing open on every internal
 * error is the arbiter's own rule (mantahostels#103 §6) and is repeated here: a missing or
 * broken arbiter must not stop the digest being generated, only a live holder
 * must.
 * @param {string} target
 */
function claimOrAbort(target) {
	// Resolved relative to this file, NOT from CLAUDE_PROJECT_DIR: that names the
	// repo the *session* is working on, which need not be the checkout this skill
	// lives in, and pointing at the wrong root makes the arbiter look missing and
	// the claim silently skip. The arbiter is a sibling of this skill, so walking
	// up from __dirname is the only resolution that is right by construction.
	const arbiter = path.resolve(
		__dirname,
		"../../../../scripts/session-arbiter.js",
	);
	if (!fs.existsSync(arbiter)) return;
	const r = require("node:child_process").spawnSync(
		process.execPath,
		[arbiter, "claim", target],
		{ encoding: "utf8" },
	);
	if (r.status === 1) {
		console.error(r.stderr.trim());
		console.error(
			"\nAborting before writing the digest. Re-run once the holder has finished;" +
				"\nthe roadmap HTML you already edited is untouched and still needs one.",
		);
		process.exit(1);
	}
}

/**
 * @param {string} [problem]
 * @returns {never}
 */
function usage(problem) {
	if (problem) console.error(`ERROR: ${problem}`);
	console.error(
		"usage: node gen-roadmap-digest.js <roadmap.html> (--out <path> | --stdout)",
	);
	console.error(
		"  <roadmap.html>  required, positional, must come first — not a flag.",
	);
	console.error("  --out <path>    write the digest there. Normal use:");
	console.error("                  --out docs/roadmap-digest.md");
	console.error(
		"  --stdout        print instead of writing. Never the default: a",
	);
	console.error(
		"                  missing destination must not be a silent no-op.",
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

// --- extract a `const NAME = [...]` literal and eval only that slice --------
/**
 * `any[]`: the value comes out of `new Function(...)()` over a slice of the
 * roadmap HTML, and nothing here statically knows its shape — the caller
 * pins it to a real typedef immediately after.
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

// --- version line from docmeta ---------------------------------------------
const vm = html.match(/<p class="docmeta">([^<]+)<\/p>/);
let version = "version unknown";
if (vm) {
	const line = vm[1];
	if (line === undefined) throw new Error("docmeta matched without its text");
	version = line.trim();
}

// --- helpers ----------------------------------------------------------------
// strip inline HTML tags and decode the handful of entities used in the fields
/** @param {unknown} s @returns {string} */
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

// m marks only a departure from the Opus 5.5 · medium default (mantahostels#831): absent
// entirely (most cards, the default itself — no segment printed), "max" (a
// one-way call), "—" (no Claude session works this card), or leg-scoped
// [["step","max"]] pairs. Returns null for "print nothing" so the caller can
// omit the segment rather than rendering an empty one.
/** @param {Item["m"]} m @returns {string|null} */
function effort(m) {
	if (!m) return null;
	if (typeof m === "string") return m;
	if (Array.isArray(m)) return m.map((p) => `${p[0]}:${p[1]}`).join("+");
	return null;
}

/** @param {Item} it @returns {string} */
function needsOf(it) {
	return it.needs && it.needs.length > 0 ? it.needs.join(", ") : "—";
}

// --- build markdown ---------------------------------------------------------
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
// The guide lives in the core, not the host: an adopter has no docs/effort-guide.md
// of its own, so a bare host-relative path names a missing file there (workflow-core#676).
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
	process.stdout.write(md);
} else {
	// The file-claim guard watches Write/Edit/NotebookEdit and is blind to a file
	// written by a script, so a script that writes a tracked doc claims it for
	// itself (mantahostels#99's signal 3). mantahostels#103 ruled the helper must ABORT rather than merely
	// record, or the digest is protected for everyone and from nobody (mantahostels#64, an
	// incident struck while it was worked, recorded on mantahostels#96 — its title names
	// other work).
	// Provably unreachable: usage() above exits the process whenever !toStdout
	// and !outPath both hold, and this branch is reached only when !toStdout —
	// the checker just cannot see across the two separate `if`s.
	if (!outPath)
		throw new Error(
			"gen-roadmap-digest.js: outPath is unset outside --stdout — usage() " +
				"should have exited before reaching here; check the argv parsing above.",
		);
	claimOrAbort(outPath);
	fs.writeFileSync(outPath, md);
	console.error(
		`wrote ${outPath} — ${md.length} chars, ${ITEMS.length} cards, ${version}`,
	);
}
