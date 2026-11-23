#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const { execFileSync, spawnSync } = require("node:child_process");
const { execGit } = require("../../../../scripts/lib/git.js");
const { gh: runGh, GH_TIMEOUT_MS } = require("../../../../scripts/lib/gh.js");
const { capMs } = require("../../../../scripts/lib/cap-ms.js");
const {
	escapeRe,
	requiredGroup,
} = require("../../../../scripts/lib/regex-group.js");
const { caught, ignoreFailure } = require("../../../../scripts/lib/caught.js");

// guess, lucmoseley/mantahostels#1114
const MAX_COMMITS = 3;
const MAX_ISSUES = 5;
const MAX_GREP_HITS = 10;
const MAX_LINE_CHARS = 200;
const MAX_ECHO_CHARS = 160;
// guess, lucmoseley/mantahostels#603
const MAX_BODY_CHARS = 600;
// guess, lucmoseley/mantahostels#1147
const MIN_NEEDLE_CHARS = 12;
// guess, lucmoseley/mantahostels#3155
const MAX_IDENTIFIER_COMMIT_MATCHES = 20;
// guess: orders above the repo-wide git log it reads, lucmoseley/mantahostels#3155
const MAX_BUFFER = 64e6;

const GREP_TARGETS = ["scripts", "docs/doc-map.md"];

const LOOKUP_TIMEOUT_MS = capMs("WFC_TENURE_LOOKUP_TIMEOUT_MS", GH_TIMEOUT_MS);
// guess: two slow lookups, #5311
const CEILING_MS = capMs("WFC_TENURE_CEILING_MS", 600e3);
const WORKER_ENV = "TENURE_WORKER";

let readerGone = false;
/** @param {string} s */
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
	timeout: LOOKUP_TIMEOUT_MS,
	killSignal: "SIGKILL",
};

/**
 * @param {string} bin
 * @param {string[]} args
 */
const run = (bin, args) => settle(() => execFileSync(bin, args, READ_OPTS));

/** @param {string[]} args */
const runGit = (args) => settle(() => execGit(args, READ_OPTS));

/**
 * @param {() => string} read
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function settle(read) {
	try {
		return { status: 0, stdout: read(), stderr: "" };
	} catch (err) {
		const e =
			/** @type {{ status?: unknown, stdout?: unknown, stderr?: unknown, message?: unknown, code?: unknown }} */ (
				err
			);
		if (e.code === "ETIMEDOUT") {
			return {
				status: null,
				stdout: "",
				stderr: `timed out after ${LOOKUP_TIMEOUT_MS / 1000} s and was killed`,
			};
		}
		return {
			status: typeof e.status === "number" ? e.status : null,
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr:
				(typeof e.stderr === "string" && e.stderr) || String(e.message ?? err),
		};
	}
}

/**
 * @param {string} s
 * @param {number} n
 */
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** @param {string} s */
const toOneLine = (s) => clip(s.replace(/\s+/g, " ").trim(), MAX_LINE_CHARS);

/**
 * @param {string} haystack
 * @param {string} needle
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
 * @param {string} text
 * @param {string} phrase
 * @returns {{ start: number, end: number } | null}
 */
function locate(text, phrase) {
	return findAcrossWraps(text, phrase);
}

/**
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

/** @typedef {{ sha: string, date: string, subject: string, body: string }} Commit */

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
 * @param {string} stdout
 * @returns {Commit[]}
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

/**
 * @param {string} needle
 * @param {string | null} pathspec
 */
function pickaxe(needle, pathspec) {
	return logOldestFirst(
		pathspec ? [`-S${needle}`, "--", pathspec] : [`-S${needle}`],
	);
}

/** @param {string} text @param {number} offset */
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/**
 * @param {string} target
 * @param {string} phrase
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
	const present = runGit(["cat-file", "-e", blob]);
	if (present.status === null) {
		return { state: "unresolved", why: `git cat-file ${present.stderr}` };
	}
	if (present.status !== 0) return skipped;
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
	const res = logOldestFirst(["-s", `-L${start},${end}:${target}`]);
	if (!res.ok) return { state: "unresolved", why: res.why };
	return { state: "found", commits: res.commits };
}

/**
 * @param {string} needlePath
 * @param {string} needle
 */
function gitAxis(needlePath, needle) {
	const repo = runGit(["rev-parse", "--git-dir"]);
	if (repo.status === null) {
		return { state: "unresolved", why: `git rev-parse ${repo.stderr}` };
	}
	if (repo.status !== 0) {
		return { state: "unresolved", why: "not inside a git repository" };
	}
	const tracked = runGit(["ls-files", "--error-unmatch", "--", needlePath]);
	if (tracked.status === null) {
		return { state: "unresolved", why: `git ls-files ${tracked.stderr}` };
	}
	if (tracked.status !== 0) {
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

const CODE_SHAPED = /[_0-9]|[a-z][A-Z]/;
const DECL_PATTERNS = [
	/^\s*def\s+(\w+)\s*\(/,
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(/,
	/^\s*(?:export\s+)?class\s+(\w+)\b/,
	/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/,
	/^\s*([A-Z_][A-Z0-9_]*)\s*[:=]/,
	/^\s*(?:["'])?([A-Za-z_][A-Za-z0-9_]*)(?:["'])?\s*:/,
];
// guess, lucmoseley/mantahostels#3134
const IDENTIFIER_WINDOW = 80;

/**
 * @param {string} text
 * @param {number} line
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

/** @param {string} ident */
function identifierWords(ident) {
	return ident
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w.toLowerCase());
}

/**
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
 * @param {string} pathspec
 * @param {string | null} identifier
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

/** @param {string} needle */
function ghAxis(needle) {
	const term = `"${needle.replace(/"/g, " ")}"`;
	const res = settle(() =>
		runGh(
			[
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
			],
			READ_OPTS,
		),
	);
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

/** @param {string} needle */
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
 * @param {string} body
 * @param {string | RegExp} matcher
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
 * @param {Commit[]} commits
 * @param {string} heading
 * @param {string | RegExp} needle
 * @param {{ newestFirst?: boolean, printed?: Set<string> }} [opts]
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

/** @param {{ git: ReturnType<typeof gitAxis>, target: string, needle: string, printed: Set<string> }} ctx */
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
 * @param {ReturnType<typeof lineHistory> | null} lines
 * @param {string} needle
 * @param {Set<string>} printed
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
 * @param {ReturnType<typeof identifierRulingAxis>} laterRuling
 * @param {string} target
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

/** @param {string[]} argv */
function supervise(argv) {
	const opts = /** @type {import("node:child_process").SpawnSyncOptions} */ ({
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, [WORKER_ENV]: "1" },
		timeout: CEILING_MS,
		killSignal: "SIGKILL",
		detached: true,
	});
	const r = spawnSync(process.execPath, [__filename, ...argv], opts);
	if (r.pid) ignoreFailure(() => process.kill(-r.pid, "SIGKILL"));
	if (typeof r.status === "number") return r.status;
	const why =
		caught(r.error).code === "ETIMEDOUT"
			? `ran past its ${CEILING_MS / 1000} s ceiling and was killed`
			: `ended with no exit code (${r.signal ?? caught(r.error).message})`;
	out(
		`\nUNRESOLVED: tenure.js ${why}. Whatever printed above may be incomplete;\n` +
			"nothing about tenure has been established either way.\n",
	);
	return 3;
}

if (require.main === module) {
	const argv = process.argv.slice(2);
	process.exit(process.env[WORKER_ENV] ? main(argv) : supervise(argv));
}
