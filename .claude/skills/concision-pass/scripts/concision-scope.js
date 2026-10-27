#!/usr/bin/env node
/**
 * concision-scope.js — per-file net words added, and the 150-word floor.
 *
 *   node .claude/skills/concision-pass/scripts/concision-scope.js <fixed-point> <path>...
 *
 * Steps 1 and 2 of the concision-pass skill: what this change added to each
 * file, and whether that file goes to a fresh reader (step 3) or is judged in
 * this session (mantahostels#1147).
 *
 * NOT the same number as scripts/concision-backstop.sh's, deliberately. That
 * one is session-wide across a REPO-GLOBAL working tree, so it counts a
 * neighbour's uncommitted files; this one counts only the paths named, which
 * are the paths this session wrote.
 *
 * FAILS CLOSED, per mantahostels#1114's third limb, the bar this script was built against.
 * A fixed point git cannot resolve, or a path that is neither in the diff nor
 * on disk, is reported as unresolved and exits 3 — never as a quiet zero, which
 * would read as "nothing added" and skip the pass. ONE ROUTE TO A ZERO REMAINS:
 * a mistyped path that happens to name a tracked, unchanged file is
 * indistinguishable from the real thing, and is reported `unchanged` rather
 * than refused.
 *
 * After the table and total it prints the diff it counted from, so the session
 * reads the additions in the same call (workflow-core#582) — or, over DIFF_CAP, withholds
 * all of it and names the `git diff` to run: all-or-names, never a partial diff
 * that leaves the session unsure which files it has read (workflow-core#481 Q6).
 *
 * Exit 0 — every path counted. Exit 3 — a path unresolved. Exit 1 — usage or a
 * fixed point that is not a git revision.
 *
 * Two departures from docs/code-standards-base.md, both because the reader is an
 * agent reading one Bash call's output: exit 3 is not §N4's alphabet, which has
 * no code for "not established"; and all output is on stdout, where §N6 puts
 * human text on stderr.
 */

const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const { execGit } = require("../../../../scripts/lib/git.js");

/**
 * The floor that decides whether step 3 spawns a fresh reader agent, per file.
 * NEVER MEASURED — "the pass is cheap on small changes" is the only rationale
 * on record, and it is not the backstop's session-wide 50 (concision-pass
 * SKILL.md, §Figures behind this loop).
 */
const FLOOR = 150;

/** No longer shared with `scripts/lib/gh.js`, which went to 256e6 on a
 * re-measurement of the tracker (mantahostels#2466). A whole-file diff of the roadmap is
 * the largest read here, so this one is sized on its own. */
const MAX_BUFFER = 64e6;

/**
 * Total bytes of diff printed inline, across all paths. Measured at workflow-core#573: the
 * Bash result limit is 30,000 characters (docs/agents/tool-output.md) and diffs
 * here run a median 13.7 B per changed word, so the cap is ≈ 1,750
 * changed words — about 70% of real runs — leaving 6,000 B for the table.
 */
const DIFF_CAP = 24_000;

/** The origin of a path with no diff to print, so it is read whole. */
const UNTRACKED = "untracked, counted whole";

/** @param {string} s */
const out = (s) => writeFd(1, s);

/**
 * Run without throwing.
 *
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

/** Whitespace-separated tokens — `wc -w`'s definition. @param {string} s */
const words = (s) => s.split(/\s+/).filter(Boolean).length;

/**
 * Net words a diff added: words on added lines minus words on removed lines.
 * The leading +/- is stripped first, so a blank added line scores zero.
 *
 * COUNTING STARTS AT THE FIRST `@@`. Reading the file headers off a `+++`/`---`
 * prefix instead drops any content line beginning `--` or `++` — a removed
 * markdown rule, say (mantahostels#1147, the review that caught it).
 *
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

/** One path's figure, or why it has none.
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
	// No diff.
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

/** Shell-quotes a path only where it needs it — scripts/lib/dispatch-rewrite.js's
 * unexported shellQuote. @param {string} p */
const shellQuote = (p) =>
	/^[\w./@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;

/**
 * An untracked path has no diff and costs the cap nothing; an unresolved or unchanged one prints nothing.
 *
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
	if (
		run(["rev-parse", "--verify", "--quiet", `${fixedPoint}^{commit}`])
			.status !== 0
	) {
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
