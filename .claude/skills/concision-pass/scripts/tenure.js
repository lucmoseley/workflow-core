#!/usr/bin/env node
/**
 * tenure.js — gathers the evidence the concision-pass tenure check reads (mantahostels#1147).
 *
 *   node .claude/skills/concision-pass/scripts/tenure.js '<phrase>' <path>
 *
 * IT RENDERS NO VERDICT (mantahostels#1114, the bar): whether the commit message speaks to
 * this sentence's own content is a reading of prose, and stays with the model.
 *
 * IT FAILS CLOSED. A phrase it cannot locate in <path> exits 3 and prints no
 * lookup results at all, because a miss printed as "no commit found" reads as
 * proof of absence (mantahostels#1114, mantahostels#587).
 *
 * Exit 0 — every lookup ran, whether or not it found anything.
 * Exit 3 — something is unresolved; the step goes back to the agent.
 * Exit 1 — usage or IO error. A reader closing the pipe early is neither:
 *          output stops and the code above stands (workflow-core#1238).
 *
 * Two departures from docs/code-standards-base.md, both because the reader is an
 * agent reading one Bash call's output: exit 3 is not §N4's alphabet, which has
 * no code for "not established"; and all output is on stdout, where §N6 puts
 * human text on stderr.
 */

const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const { execFileSync } = require("node:child_process");
const { execGit } = require("../../../../scripts/lib/git.js");
const { requiredGroup } = require("../../../../scripts/lib/regex-group.js");
const { caught } = require("../../../../scripts/lib/caught.js");

/**
 * Display caps. mantahostels#1114's bar: output that scales with a backlog carries a hard
 * cap, and this runs once per finding with findings running to double digits.
 * Every figure here is a first guess, set where the output still reads in one
 * screen.
 */
const MAX_COMMITS = 3;
const MAX_ISSUES = 5;
const MAX_GREP_HITS = 10;
const MAX_LINE_CHARS = 200;
const MAX_ECHO_CHARS = 160;
/** A commit body here is a lay-readable reason and runs a short paragraph; 600
 * chars holds whole the ones sampled across mantahostels#603's tenure findings. */
const MAX_BODY_CHARS = 600;
/** Below this a needle stops being distinctive and `-S` starts matching commits
 * that never touched this sentence. A first guess, not measured. */
const MIN_NEEDLE_CHARS = 12;
/** Above this many repo-wide commit-message matches, an identifier's words
 * are too common to trust as a same-identifier ruling — the actual
 * distinctiveness signal `identifierMessageRegex` is built to test, in place
 * of the identifier's raw character length, which does not track it. Set
 * from the counts mantahostels#3155 measured, which separate distinctive
 * identifiers from bare common words. Fixed as an absolute count against this
 * repository's 5440-commit history, not a rate, because the gap is wide enough
 * that the exact number barely matters; it would need recalibrating only if
 * that commit count changed by an order of magnitude. */
const MAX_IDENTIFIER_COMMIT_MATCHES = 20;
/** `scripts/lib/gh.js`'s figure before mantahostels#2466 raised it there. The
 * largest read here is the repo-wide, no-pathspec `git log` the frequency axis
 * added (mantahostels#3155) — orders below this figure, and an overflow lands
 * as `status: null`, so the lookup fails closed rather than silently
 * truncating. */
const MAX_BUFFER = 64e6;

const GH = process.env.WFC_GH || "gh";
const GREP_TARGETS = ["scripts", "docs/doc-map.md"];

let readerGone = false;
/**
 * A reader that closes early (`| head -1`) makes the next write throw EPIPE.
 * Output stops there, but the exit code stays `main`'s own, so a `pipefail`
 * caller still sees 3 for an unresolved lookup (workflow-core#1238).
 *
 * @param {string} s
 */
const out = (s) => {
	if (readerGone) return;
	try {
		writeFd(1, s);
	} catch (err) {
		if (caught(err).code !== "EPIPE") throw err;
		readerGone = true;
	}
};

/** @type {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} */
const READ_OPTS = {
	encoding: "utf8",
	maxBuffer: MAX_BUFFER,
	stdio: ["ignore", "pipe", "pipe"],
};

/**
 * @param {string} bin
 * @param {string[]} args
 */
const run = (bin, args) => settle(() => execFileSync(bin, args, READ_OPTS));

/** @param {string[]} args */
const runGit = (args) => settle(() => execGit(args, READ_OPTS));

/**
 * A read that never throws. A non-zero exit is data here — `grep` says
 * "no match" with 1 and `git log` says "no such path" with 128, and the two
 * mean opposite things.
 *
 * @param {() => string} read
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function settle(read) {
	try {
		return { status: 0, stdout: read(), stderr: "" };
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
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** @param {string} s */
const toOneLine = (s) => clip(s.replace(/\s+/g, " ").trim(), MAX_LINE_CHARS);

/**
 * Whether `needle` occurs in `haystack`, tolerating a re-wrap — a run of
 * whitespace in the needle (a line break included) matches, in the haystack,
 * the same run of whitespace optionally carrying one `*` (commit bodies wrap
 * at ~72-80 columns; the reviewed phrase in a file does not wrap the same
 * way), so a needle wrapped one way is still found in text wrapped another
 * (mantahostels#3169). The `*` is optional and single, not `[\s*]+`, so a run of
 * asterisks with no whitespace on either side — Markdown `**bold**`, or two
 * words run together as `word*word` — is not swallowed as one gap; the same
 * leniency also reaches `bodyForDisplay`'s commit-body caller, where a `* `
 * Markdown bullet reads as a gap too.
 *
 * @param {string} haystack @param {string} needle
 * @returns {{ start: number, end: number } | null}
 */
function findAcrossWraps(haystack, needle) {
	const exact = haystack.indexOf(needle);
	if (exact >= 0) return { start: exact, end: exact + needle.length };
	const tokens = needle.trim().split(/\s+/).filter(Boolean).map(escapeRe);
	if (tokens.length === 0) return null;
	const m = new RegExp(tokens.join("\\s+\\*?\\s*")).exec(haystack);
	return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/**
 * Find the phrase in the file's text, tolerating a re-wrap.
 *
 * A finding is quoted by a fresh reader that saw the text reflowed, so the
 * quotation's own line breaks and runs of spaces are not the file's.
 *
 * @param {string} text @param {string} phrase
 * @returns {{ start: number, end: number } | null}
 */
function locate(text, phrase) {
	return findAcrossWraps(text, phrase);
}

/**
 * `git log -S` matches LITERALLY against the blob, so a needle carrying the
 * file's current line breaks finds only commits that wrote that exact wrap —
 * which, for a sentence reflowed since it landed, is the reflow and not the
 * introduction (mantahostels#1147). So the longest line-internal fragment is the only
 * needle tried. A leading `* ` comment-continuation marker is stripped from
 * each line first — left in, a fragment starting `* ` becomes a `git log -S`
 * needle that matches nothing a comment-unaware commit ever wrote, reading as
 * a false "none" (mantahostels#3169).
 *
 * @param {string} span
 * @returns {{ needle: string, multiline: boolean }}
 */
function needleFor(span) {
	const fragments = span
		.split("\n")
		.map((l) => l.trim().replace(/^\*\s*/, ""))
		.filter(Boolean);
	return {
		needle: fragments.reduce((a, b) => (b.length > a.length ? b : a), ""),
		multiline: fragments.length > 1,
	};
}

const RS = "\x1e";
const FS = "\x1f";
const PRETTY = `--pretty=format:%H${FS}%ad${FS}%s${FS}%b${RS}`;

/**
 * @typedef {{ sha: string, date: string, subject: string, body: string }} Commit
 */

/** A `git log` record short of the fields `PRETTY` asks for (workflow-core#1341). */
class LogRecordShortError extends Error {
	/** @param {string} record */
	constructor(record) {
		super(
			`git log record short of a sha, date or subject: ${JSON.stringify(record)}`,
		);
		this.name = "LogRecordShortError";
		this.record = record;
	}
}

/**
 * Splits `PRETTY`-formatted `git log` stdout into commits. Shared by every
 * axis that reads commit messages, so a parsing fix lands once (mantahostels#3134).
 *
 * A record short of a subject throws (workflow-core#1341). This program sets the format,
 * so only a commit message carrying the record separator produces one.
 *
 * @param {string} stdout
 * @returns {Commit[]}
 * @throws {LogRecordShortError}
 */
function parseLog(stdout) {
	return stdout
		.split(RS)
		.map((r) => r.trim())
		.filter(Boolean)
		.map((r) => {
			const [sha, date, subject, body] = r.split(FS);
			if (sha === undefined || date === undefined || subject === undefined) {
				throw new LogRecordShortError(r);
			}
			return { sha, date, subject, body: (body || "").trim() };
		});
}

/**
 * One `git log` run over `args`, parsed, OLDEST FIRST.
 *
 * The lookup is labelled "introducing commit", and git's default newest-first
 * order puts the introduction last — so without `--reverse` a sentence edited a
 * few times has its introduction fall off the cap, and the newest revision is
 * presented in its place (mantahostels#1147, the review that caught it).
 *
 * @param {string[]} args
 * @returns {{ ok: true, commits: Commit[] } | { ok: false, why: string }}
 */
function logOldestFirst(args) {
	const res = runGit(["log", "--reverse", PRETTY, "--date=short", ...args]);
	if (res.status !== 0) {
		return { ok: false, why: `git log failed: ${toOneLine(res.stderr)}` };
	}
	return { ok: true, commits: parseLog(res.stdout) };
}

/** @param {string} needle @param {string | null} pathspec */
function pickaxe(needle, pathspec) {
	return logOldestFirst(
		pathspec ? [`-S${needle}`, "--", pathspec] : [`-S${needle}`],
	);
}

/** 1-indexed line holding `offset`. @param {string} text @param {number} offset */
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/**
 * Every commit that touched the phrase's lines. `-S` on the current wording
 * stops at the last rewording and shows it as the introduction; `git log -L`
 * follows the lines through it to the commit that wrote them (workflow-core#763). The
 * lines are located in HEAD's copy, because `-L` numbers HEAD's lines and the
 * working tree may have shifted them.
 *
 * @param {string} target @param {string} phrase
 * @returns {{ state: "found", commits: Commit[] } | { state: "skipped" | "unresolved", why: string }}
 */
function lineHistory(target, phrase) {
	const full = runGit(["ls-files", "--full-name", "--", target]);
	if (full.status !== 0 || !full.stdout.trim()) {
		return {
			state: "unresolved",
			why: `git ls-files could not name ${target}`,
		};
	}
	const blob = `HEAD:${full.stdout.trim()}`;
	const skipped = {
		state: /** @type {const} */ ("skipped"),
		why: `the phrase is not in HEAD's copy of ${target} — uncommitted text has no line history`,
	};
	if (runGit(["cat-file", "-e", blob]).status !== 0) return skipped;
	const head = runGit(["show", blob]);
	if (head.status !== 0) {
		return {
			state: "unresolved",
			why: `git show failed: ${toOneLine(head.stderr)}`,
		};
	}
	const span = locate(head.stdout, phrase);
	if (!span) return skipped;
	const start = lineOf(head.stdout, span.start);
	const end = lineOf(head.stdout, span.end);
	// `-s`: `-L` prints each commit's patch by default, which would land
	// inside parseLog's records.
	const res = logOldestFirst(["-s", `-L${start},${end}:${target}`]);
	if (!res.ok) return { state: "unresolved", why: res.why };
	return { state: "found", commits: res.commits };
}

/**
 * Both rungs, always — never the first that hits.
 *
 * A rename breaks the pathspec rung without emptying it: `git log -S… -- <new
 * path>` names the RENAME commit, whose message describes the move and so
 * clears tenure under step 4's bulk-rewrite rule, while the commit that settled
 * the rule is invisible (mantahostels#1147). Anything only the pathspec-less
 * rung can see is printed beside the pathspec rung's hits.
 *
 * @param {string} needlePath @param {string} needle
 */
function gitAxis(needlePath, needle) {
	if (runGit(["rev-parse", "--git-dir"]).status !== 0) {
		return { state: "unresolved", why: "not inside a git repository" };
	}
	if (runGit(["ls-files", "--error-unmatch", "--", needlePath]).status !== 0) {
		return {
			state: "unresolved",
			why: `${needlePath} is untracked, so git holds no history for it — the text has no tenure to clear yet`,
		};
	}
	const inPath = pickaxe(needle, needlePath);
	if (!inPath.ok) return { state: "unresolved", why: inPath.why };
	const anywhere = pickaxe(needle, null);
	if (!anywhere.ok) return { state: "unresolved", why: anywhere.why };

	const seen = new Set(inPath.commits.map((c) => c.sha));
	const elsewhere = anywhere.commits.filter((c) => !seen.has(c.sha));
	const state =
		inPath.commits.length === 0 && elsewhere.length === 0 ? "none" : "found";
	return { state, inPath: inPath.commits, elsewhere };
}

/**
 * Six declaration shapes, captured group is the identifier: Python `def`;
 * JS/TS `function` (async/generator/default/export); a `class` (either
 * language); a JS `const`/`let`/`var` binding; a `CONSTANT_CASE` assignment
 * (Python or JS); a quoted or bare dict/object key. The last two require a
 * code-shaped name (underscore, digit or internal capital) — plain-English
 * prose lines that happen to start `Word:` (a Markdown "Scope:", "Note:") are
 * not declarations and must not shadow a real one (mantahostels#3134).
 */
const CODE_SHAPED = /[_0-9]|[a-z][A-Z]/;
const DECL_PATTERNS = [
	/^\s*def\s+(\w+)\s*\(/,
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(/,
	/^\s*(?:export\s+)?class\s+(\w+)\b/,
	/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/,
	/^\s*([A-Z_][A-Z0-9_]*)\s*[:=]/,
	/^\s*(?:["'])?([A-Za-z_][A-Za-z0-9_]*)(?:["'])?\s*:/,
];
/** A guess, not measured: far enough to reach a comment sitting a few lines
 * above the declaration it documents, the shape mantahostels#3134 was filed over. */
const IDENTIFIER_WINDOW = 80;

/**
 * The enclosing function, class or constant name, if the phrase sits inside
 * or beside one — nearest declaration wins, searched outward by line
 * distance so a comment sitting a few lines above its declaration (the usual
 * shape) is still caught (mantahostels#3134).
 *
 * @param {string} text @param {number} line 1-indexed line the phrase starts on
 * @returns {string | null}
 */
function findEnclosingIdentifier(text, line) {
	const lines = text.split("\n");
	const idx = line - 1;
	for (let d = 0; d <= IDENTIFIER_WINDOW; d++) {
		const candidates = d === 0 ? [idx] : [idx - d, idx + d];
		for (const cand of candidates) {
			const candLine = lines[cand];
			if (candLine === undefined) continue;
			const name = declaredName(candLine);
			if (name !== null) return name;
		}
	}
	return null;
}

/**
 * The identifier the first matching DECL_PATTERNS entry declares on this line,
 * or null where none does.
 * @param {string} candLine
 * @returns {string | null}
 */
function declaredName(candLine) {
	for (const [i, re] of DECL_PATTERNS.entries()) {
		const m = re.exec(candLine);
		if (!m) continue;
		const name = requiredGroup(m, 1, re);
		if (i >= 4 && !CODE_SHAPED.test(name)) continue;
		return name;
	}
	return null;
}

/**
 * Splits an identifier into lowercase words, tolerating snake_case,
 * CONSTANT_CASE and camelCase alike.
 * @param {string} ident
 */
function identifierWords(ident) {
	return ident
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
}

/**
 * A commit message may name this identifier in plain English rather than
 * literally — "the reply markers" for `REPLY_MARKERS` — so the search tolerates
 * any separator between words and an optional trailing "s" on each, rather than
 * matching the identifier's exact spelling (mantahostels#3134). Word-bounded so a
 * short identifier (`res`) does not match inside an unrelated longer word
 * (`results`, `reserve`).
 * @param {string} ident
 * @returns {RegExp | null}
 */
function identifierMessageRegex(ident) {
	const words = identifierWords(ident);
	if (words.length === 0) return null;
	const pattern = words.map((w) => `${escapeRe(w)}s?`).join("[\\s_-]*");
	return new RegExp(`\\b${pattern}\\b`, "i");
}

/**
 * A later commit can rule a line KEPT without ever touching its text — a
 * neighbouring cut's message says so instead — so `-S` on this phrase (which
 * only finds commits that changed it) cannot see that ruling. This scans every
 * commit message touching the file for the enclosing identifier's name instead
 * (mantahostels#3134).
 *
 * @param {string} pathspec @param {string | null} identifier
 */
function identifierRulingAxis(pathspec, identifier) {
	if (!identifier) {
		return {
			state: "none",
			why: `no enclosing function, class or constant name found within ${IDENTIFIER_WINDOW} lines of the phrase`,
		};
	}
	const re = identifierMessageRegex(identifier);
	if (!re) {
		return {
			state: "unresolved",
			why: `"${identifier}" holds no word characters to search a commit message for`,
			identifier,
		};
	}
	const res = runGit([
		"log",
		"--reverse",
		PRETTY,
		"--date=short",
		"--",
		pathspec,
	]);
	if (res.status !== 0) {
		return {
			state: "unresolved",
			why: `git log failed: ${toOneLine(res.stderr)}`,
			identifier,
		};
	}
	// Repo-wide, no pathspec: the same shape, read for volume rather than for
	// which commits matched — the distinctiveness signal in place of length
	// (mantahostels#3155). A failure here fails the whole axis closed, same as the lookup
	// above: a silently-skipped frequency check would read as "distinctive
	// enough".
	const freq = runGit(["log", "--reverse", PRETTY, "--date=short"]);
	if (freq.status !== 0) {
		return {
			state: "unresolved",
			why: `git log (repo-wide frequency) failed: ${toOneLine(freq.stderr)}`,
			identifier,
		};
	}
	const commits = parseLog(res.stdout).filter((c) =>
		re.test(`${c.subject}\n${c.body}`),
	);
	const frequency = parseLog(freq.stdout).filter((c) =>
		re.test(`${c.subject}\n${c.body}`),
	).length;
	if (commits.length === 0) {
		return { state: "none", identifier, messageRegex: re, frequency };
	}
	return { state: "found", identifier, commits, messageRegex: re, frequency };
}

/** An earlier pass may already have ruled on this passage. @param {string} needle */
function ghAxis(needle) {
	const term = `"${needle.replace(/"/g, " ")}"`;
	const res = run(GH, [
		"issue",
		"list",
		"--state",
		"all",
		"--search",
		term,
		"--limit",
		String(MAX_ISSUES),
		"--json",
		"number,state,title",
	]);
	if (res.status !== 0) {
		return {
			state: "unresolved",
			why: `gh issue list failed: ${toOneLine(res.stderr)}`,
			term,
		};
	}
	let rows;
	try {
		rows = JSON.parse(res.stdout || "[]");
	} catch {
		return {
			state: "unresolved",
			why: `gh returned output that is not JSON: ${toOneLine(res.stdout)}`,
			term,
		};
	}
	if (!Array.isArray(rows) || rows.length === 0) return { state: "none", term };
	return { state: "found", rows: rows.slice(0, MAX_ISSUES), term };
}

/**
 * A test asserting the string makes the sentence load-bearing whatever it reads
 * like. A §B `Restated in:` locator does not — the skill owns that reading
 * (mantahostels#722).
 *
 * @param {string} needle
 */
function grepAxis(needle) {
	const targets = GREP_TARGETS.filter((t) => fs.existsSync(t));
	if (targets.length === 0) {
		return {
			state: "unresolved",
			why: `none of ${GREP_TARGETS.join(", ")} exists here — run this from the repository root`,
		};
	}
	const res = run("grep", ["-rnF", "--", needle, ...targets]);
	if (res.status === 1) return { state: "none", targets };
	if (res.status !== 0) {
		return {
			state: "unresolved",
			why: `grep failed: ${toOneLine(res.stderr)}`,
		};
	}
	return { state: "found", hits: res.stdout.split("\n").filter(Boolean) };
}

/**
 * A body under the cap prints whole. Over the cap, the cut can only ever make
 * tenure look weaker than it is (mantahostels#2510) — so before clipping, the whole body
 * (not just the part a clip would keep) is searched for the needle, tolerating
 * a re-wrap (`findAcrossWraps`). Found anywhere, the body prints in
 * full instead of being cut; absent, the clip stands and says so, because a
 * silent clip reads as "there was nothing more to see" when it may just be
 * unsearched.
 *
 * `matcher` is a literal needle, or the same regex that decided whether this
 * commit was admitted in the first place — passing the literal identifier
 * instead disagreed with the tolerant match that admitted the commit, so an
 * over-cap body matched only in its plain-English form printed a false
 * "does not occur past the cut" (mantahostels#3134).
 *
 * @param {string} body @param {string | RegExp} matcher
 */
function bodyForDisplay(body, matcher) {
	if (body.length <= MAX_BODY_CHARS) return { text: body, note: null };
	const hit =
		typeof matcher === "string"
			? Boolean(findAcrossWraps(body, matcher))
			: matcher.test(body);
	if (hit) {
		return {
			text: body,
			note: "over the display cap, but holds the needle — printed in full",
		};
	}
	return {
		text: clip(body, MAX_BODY_CHARS),
		note: "clipped at the display cap — the needle does not occur past the cut",
	};
}

/**
 * `commits` is always oldest-first. Step 1 wants the introducing commit, which
 * sits at the start, so the cap withholds the newest. Step 1b wants a LATER
 * ruling, which by definition sits at the end — withholding the newest there
 * would hide the one commit this lookup exists to surface (mantahostels#3134), so it shows
 * the newest instead and withholds the oldest.
 *
 * A sha already in `printed` prints its subject alone, so a commit two rungs
 * both found costs one body.
 *
 * @param {Commit[]} commits @param {string} heading @param {string | RegExp} needle
 * @param {{ newestFirst?: boolean, printed?: Set<string> }} [opts] accumulator: printed collects the shas shown; newestFirst is read
 */
function printCommits(commits, heading, needle, opts = {}) {
	const ordered = opts.newestFirst ? [...commits].reverse() : commits;
	out(`   ${heading}\n`);
	for (const c of ordered.slice(0, MAX_COMMITS)) {
		out(`   COMMIT ${c.sha.slice(0, 12)} ${c.date} ${toOneLine(c.subject)}\n`);
		if (opts.printed?.has(c.sha)) {
			out("     (body above)\n");
			continue;
		}
		opts.printed?.add(c.sha);
		if (!c.body) {
			out("     (no body)\n");
			continue;
		}
		const { text, note } = bodyForDisplay(c.body, needle);
		if (note) out(`     (${note})\n`);
		for (const l of text.split("\n")) {
			out(`     ${clip(l, MAX_LINE_CHARS)}\n`);
		}
	}
	if (ordered.length > MAX_COMMITS) {
		const hiddenWord = opts.newestFirst ? "older" : "newer";
		out(`   (+${ordered.length - MAX_COMMITS} ${hiddenWord}, not shown)\n`);
	}
}

/**
 * The target's text, or null after printing why it could not be read.
 * @param {string} target
 * @returns {string | null}
 */
function readTarget(target) {
	try {
		return fs.readFileSync(target, "utf8");
	} catch (err) {
		out(`cannot read ${target}: ${caught(err).message}\n`);
		return null;
	}
}

/**
 * Step 1's pickaxe half: commits in the target, then elsewhere in the repo.
 * @param {{ git: ReturnType<typeof gitAxis>, target: string, needle: string, printed: Set<string> }} ctx
 */
function printPickaxeAxis({ git, target, needle, printed }) {
	if (git.state === "unresolved") {
		out(`   UNRESOLVED: ${git.why}\n`);
		return;
	}
	if (git.state === "none") {
		out(
			"   none, with and without the pathspec — no commit in this history ever\n" +
				"   added or removed this string.\n",
		);
		return;
	}
	if (git.inPath && git.inPath.length > 0) {
		printCommits(git.inPath, `${git.inPath.length} in ${target}:`, needle, {
			printed,
		});
	} else {
		out(`   none in ${target} itself.\n`);
	}
	if (git.elsewhere && git.elsewhere.length > 0) {
		printCommits(
			git.elsewhere,
			`${git.elsewhere.length} elsewhere in the repo, which ${target}'s own history cannot see (a rename or a move):`,
			needle,
			{ printed },
		);
	}
}

/**
 * Step 1's `git log -L` half; prints nothing where the pickaxe was unresolved.
 * @param {ReturnType<typeof lineHistory> | null} lines @param {string} needle @param {Set<string>} printed
 */
function printLineHistoryAxis(lines, needle, printed) {
	if (lines?.state === "found") {
		printCommits(
			lines.commits,
			`${lines.commits.length} touching these lines (git log -L), followed past any rewording — the oldest may have written a different line here:`,
			needle,
			{ printed },
		);
	} else if (lines) {
		out(`   git log -L ${lines.state.toUpperCase()}: ${lines.why}\n`);
	}
}

/**
 * @param {ReturnType<typeof identifierRulingAxis>} laterRuling @param {string} target
 */
function printLaterRulingAxis(laterRuling, target) {
	if (
		laterRuling.state !== "unresolved" &&
		laterRuling.identifier &&
		typeof laterRuling.frequency === "number" &&
		laterRuling.frequency > MAX_IDENTIFIER_COMMIT_MATCHES
	) {
		out(
			`   ⚠ identifier "${laterRuling.identifier}" matches ${laterRuling.frequency} commit messages repo-wide — too common to trust as a ruling on this specific line, so read what follows as candidates rather than rulings.\n`,
		);
	}
	if (laterRuling.state === "unresolved") {
		out(`   UNRESOLVED: ${laterRuling.why}\n`);
	} else if (laterRuling.state === "none" && !laterRuling.identifier) {
		out(`   ${laterRuling.why}\n`);
	} else if (laterRuling.state === "none") {
		out(
			`   none mentioning "${laterRuling.identifier}" — a commit touching ${target}\n` +
				"   may still rule this line kept without naming it this way.\n",
		);
	} else {
		const rulingCommits = laterRuling.commits || [];
		out(`   enclosing identifier: ${laterRuling.identifier}\n`);
		printCommits(
			rulingCommits,
			`${rulingCommits.length} commit message${rulingCommits.length === 1 ? "" : "s"} naming it:`,
			laterRuling.messageRegex || laterRuling.identifier || "",
			{ newestFirst: true },
		);
	}
}

/** @param {ReturnType<typeof ghAxis>} gh */
function printGhAxis(gh) {
	if (gh.state === "unresolved") {
		out(`   UNRESOLVED: ${gh.why}\n`);
	} else if (gh.state === "none") {
		out(`   none matching ${gh.term}\n`);
	} else {
		for (const r of gh.rows || []) {
			out(
				`   #${r.number} ${String(r.state).toUpperCase()} ${toOneLine(r.title)}\n`,
			);
		}
	}
}

/** @param {ReturnType<typeof grepAxis>} grep */
function printGrepAxis(grep) {
	if (grep.state === "unresolved") {
		out(`   UNRESOLVED: ${grep.why}\n`);
	} else if (grep.state === "none") {
		out("   none\n");
	} else {
		const hits = grep.hits || [];
		for (const h of hits.slice(0, MAX_GREP_HITS)) out(`   ${toOneLine(h)}\n`);
		if (hits.length > MAX_GREP_HITS) {
			out(`   (+${hits.length - MAX_GREP_HITS} more)\n`);
		}
	}
}

/** @param {string[]} argv */
function main(argv) {
	const [phrase, target] = argv;
	if (!phrase || !target) {
		out("usage: tenure.js '<phrase>' <path>\n");
		return 1;
	}
	const text = readTarget(target);
	if (text === null) return 1;

	const span = locate(text, phrase);
	if (!span) {
		out(
			`UNRESOLVED: that phrase is not in ${target}.\n` +
				`  Looked for: ${clip(phrase, MAX_ECHO_CHARS)}\n` +
				"  Whitespace, and a comment-continuation `*`, are already ignored, so the\n" +
				"  text itself differs. Re-quote the sentence from the file, or name the\n" +
				"  file that holds it. Nothing about tenure has been established either way.\n",
		);
		return 3;
	}

	const located = text.slice(span.start, span.end);
	const line = lineOf(text, span.start);
	const { needle, multiline } = needleFor(located);
	const git = gitAxis(target, needle);
	const lines = git.state === "unresolved" ? null : lineHistory(target, phrase);
	const identifier = findEnclosingIdentifier(text, line);
	const laterRuling = identifierRulingAxis(target, identifier);
	const gh = ghAxis(needle);
	const grep = grepAxis(needle);

	out(`phrase at ${target}:${line}\n`);
	out(
		`needle: ${clip(needle, MAX_ECHO_CHARS)}` +
			`${multiline ? "  (longest fragment that cannot span a line break)" : ""}\n`,
	);
	if (needle.length < MIN_NEEDLE_CHARS) {
		out(
			`  ⚠ ${needle.length} chars — short enough to match commits that never touched this sentence.\n`,
		);
	}

	out("\n1. introducing commit — git log -S, then git log -L, oldest first\n");
	const printed = new Set();
	printPickaxeAxis({ git, target, needle, printed });
	printLineHistoryAxis(lines, needle, printed);

	out(
		"\n1b. later ruling on this identifier — commit messages touching this file\n",
	);
	printLaterRulingAxis(laterRuling, target);

	out("\n2. earlier ruling — gh issue list --state all\n");
	printGhAxis(gh);

	out(`\n3. asserted elsewhere — grep ${GREP_TARGETS.join(" ")}\n`);
	printGrepAxis(grep);

	const lookups = [git, lines, laterRuling, gh, grep].filter((a) => a !== null);
	const unresolved = lookups.filter((a) => a.state === "unresolved");
	if (unresolved.length > 0) {
		out(
			`\n${unresolved.length} of ${lookups.length} lookups unresolved — that is not evidence of absence.\n` +
				"Settle them by hand before treating tenure as cleared.\n",
		);
		return 3;
	}
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
