#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const { readCommit } = require("../../../../scripts/lib/commit-sha.js");
const { execGit, gitReader } = require("../../../../scripts/lib/git.js");
const { shellQuote } = require("../../../../scripts/lib/sh-quote.js");

// guess, lucmoseley/mantahostels#1147
const FLOOR = 150;

const MAX_BUFFER = 64e6;

// measured 13.7 B per changed word, #573
const DIFF_CAP = 24_000;

const UNTRACKED = "untracked, counted whole";

/** @param {string} s */
const out = (s) => writeFd(1, s);

/**
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function run(args) {
	try {
		return {
			status: 0,
			stdout: execGit(args, {
				encoding: "utf8",
				maxBuffer: MAX_BUFFER,
				stdio: ["ignore", "pipe", "pipe"],
			}),
			stderr: "",
		};
	} catch (err) {
		const e =
			/** @type {{ status?: unknown, stdout?: unknown, stderr?: unknown, message?: unknown }} */ (
				err
			);
		return {
			status: typeof e.status === "number" ? e.status : null,
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr:
				(typeof e.stderr === "string" && e.stderr) || String(e.message ?? err),
		};
	}
}

/** @param {string} s */
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/**
 * @param {string} diff
 */
function netFromDiff(diff) {
	let added = 0;
	let removed = 0;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("+")) added += words(line.slice(1));
		else if (line.startsWith("-")) removed += words(line.slice(1));
	}
	return { added, removed, net: added - removed };
}

/**
 * @typedef {{ state: "ok", added: number, removed: number, net: number, origin: string, diff?: string }} Counted
 * @typedef {{ state: "unresolved", why: string }} Unresolved
 */

/**
 * @param {string} fixedPoint @param {string} target
 * @returns {Counted | Unresolved} */
function measure(fixedPoint, target) {
	const diff = run(["diff", fixedPoint, "--", target]);
	if (diff.status !== 0) {
		return {
			state: "unresolved",
			why: `git diff failed: ${diff.stderr.trim()}`,
		};
	}
	if (diff.stdout.trim() !== "") {
		return {
			state: "ok",
			...netFromDiff(diff.stdout),
			origin: "diff",
			diff: diff.stdout,
		};
	}
	const tracked =
		run(["ls-files", "--error-unmatch", "--", target]).status === 0;
	if (tracked)
		return { state: "ok", added: 0, removed: 0, net: 0, origin: "unchanged" };
	let body;
	try {
		body = fs.readFileSync(target, "utf8");
	} catch {
		return {
			state: "unresolved",
			why: `not in the diff against ${fixedPoint}, not tracked, and not on disk — check the path`,
		};
	}
	const n = words(body);
	return {
		state: "ok",
		added: n,
		removed: 0,
		net: n,
		origin: UNTRACKED,
	};
}

/**
 * @param {string} fixedPoint
 * @param {Array<{ target: string } & (Counted | Unresolved)>} rows
 */
function printDiffs(fixedPoint, rows) {
	/** @type {Array<{ target: string, diff: string }>} */
	const diffed = [];
	for (const r of rows) {
		if (r.state !== "ok") continue;
		if (r.diff) diffed.push({ target: r.target, diff: r.diff });
		else if (r.origin === UNTRACKED)
			out(`\n  untracked, read the file whole: ${r.target}\n`);
	}
	if (diffed.length === 0) return;
	const bytes = diffed.reduce((n, d) => n + Buffer.byteLength(d.diff), 0);
	if (bytes > DIFF_CAP) {
		out(
			`\n  Diff withheld: ${bytes} bytes across ${diffed.length} file(s), over the ${DIFF_CAP}-byte cap.\n` +
				diffed.map((d) => `    ${d.target}\n`).join("") +
				`  Read it with: git diff ${shellQuote(fixedPoint)} -- ${diffed.map((d) => shellQuote(d.target)).join(" ")}\n`,
		);
		return;
	}
	out(`\n  Diff against ${fixedPoint} (${bytes} bytes):\n\n`);
	for (const d of diffed) out(d.diff);
}

/** @param {string[]} argv */
function main(argv) {
	const [fixedPoint, ...targets] = argv;
	if (!fixedPoint || targets.length === 0) {
		out(
			"usage: concision-scope.js <fixed-point> <path>...\n" +
				"  Name the paths this session wrote; a repo-wide figure would count a\n" +
				"  parallel session's files.\n",
		);
		return 1;
	}
	const point = readCommit(gitReader(), fixedPoint);
	if (!point.ok) {
		out(`git would not resolve ${fixedPoint}: ${point.why}\n`);
		return 1;
	}
	if (point.sha === null) {
		out(
			`${fixedPoint} is not a commit this repository can resolve.\n` +
				"  A baseline FILE is a legal fixed point for the pass but not for this\n" +
				"  script — diff it yourself and count.\n",
		);
		return 1;
	}

	const rows = targets.map((t) => ({ target: t, ...measure(fixedPoint, t) }));
	const width = Math.max(...rows.map((r) => r.target.length));
	let total = 0;
	let overFloor = 0;
	for (const r of rows) {
		if (r.state === "unresolved") {
			out(`  UNRESOLVED  ${r.target.padEnd(width)}  ${r.why}\n`);
			continue;
		}
		total += r.net;
		const verdict =
			r.net >= FLOOR
				? `at or over ${FLOOR} → step 3: send this file to a fresh reader`
				: `under ${FLOOR} → step 2: read the additions yourself, then step 5`;
		if (r.net >= FLOOR) overFloor += 1;
		out(
			`  ${String(r.net).padStart(6)}  ${r.target.padEnd(width)}  ` +
				`(+${r.added} −${r.removed}, ${r.origin})  ${verdict}\n`,
		);
	}
	out(
		`\n  ${String(total).padStart(6)}  net words added across ${rows.length} path(s) ` +
			`against ${fixedPoint}; ${overFloor} at or over the ${FLOOR} floor\n`,
	);

	printDiffs(fixedPoint, rows);

	return rows.some((r) => r.state === "unresolved") ? 3 : 0;
}

process.exit(main(process.argv.slice(2)));
