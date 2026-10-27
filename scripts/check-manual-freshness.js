#!/usr/bin/env node
/*
 * check-manual-freshness.js — CI guard that the operating manual is still being
 * maintained against the roadmap.
 *
 * Usage:
 *   node check-manual-freshness.js [<manual.md> <roadmap.html>]
 *                                  [--allowlist <file>] [--notify]
 *   (defaults: docs/operating-manual.md docs/reference-roadmap.html
 *              scripts/manual-path-allowlist.json)
 *
 * --notify is the quiet path, wired to no live route: silent unless something
 * is actually drifting. It exists because
 * the 5-9 MINOR band is a WARN, and a WARN exits 0 — so
 * report-manual-staleness.js, which reads the exit code, files nothing for it.
 * Ruled at mantahostels#391; the issue still files at FAIL only.
 *
 * The manual (docs/operating-manual.md) is refreshed by the manual-sync skill
 * when it falls >=5 roadmap MINOR versions behind, on any roadmap MAJOR bump, or
 * at a phase transition — whichever comes first. Only the two mechanical
 * conditions are checked here; the phase-transition trigger is a human
 * judgement the script cannot see.
 *
 * Five assertions. The first four read the manual's two-anchor provenance stamp
 * and the corrections log directly beneath it; the fifth reads the whole file:
 *   1. Stamp shape — the line carries BOTH anchors (roadmap commit + reviewed-
 *      against repo SHA); both resolve to real commits; the roadmap commit
 *      actually touches the roadmap HTML.
 *      Both anchors, and the vX.Y beside the roadmap one, record what the last
 *      sync REVIEWED THROUGH, not what its prose was synthesised from — so a
 *      full roadmap-diff review that correctly makes no edit still advances
 *      them, and assertion 2 below is closeable by such a run. A clean run never
 *      freezes the roadmap anchor (mantahostels#1645), which would leave
 *      assertion 2 permanently unsatisfiable.
 *   2. Roadmap distance — WARN at >=5 MINOR behind, FAIL at >=10. Any MAJOR bump
 *      behind is a FAIL.
 *   3. Review latency — WARN if the reviewed-against commit is >14 days old,
 *      FAIL at >30.
 *   4. Corrections log — the "Corrections since last sync:" line exists; every
 *      entry on it cites a source; and no entry's recorded repo anchor has been
 *      left behind by an advanced stamp. A targeted correction (manual-sync's
 *      targeted-correction mode, settled at mantahostels#82) advances neither anchor, so a
 *      recorded anchor that no longer matches the stamp means a full sync ran
 *      and failed to clear the log.
 *   5. Cited paths — every path-like token in a code span resolves on disk
 *      (mantahostels#1149, which moved this off the manual-sync skill's hand grep).
 *      Findings are WARN: only a FAIL files an issue (mantahostels#391). A path the manual
 *      cites by basename needs an allowlist entry naming the file it stands
 *      for; without one it reports as a miss.
 *
 * WARN findings never gate — a manual drifting toward its refresh window must
 * not fail CI on every push touching docs/ (mantahostels#155 — the checker family's
 * exit-code and severity model — consequence 5). An absent manual is a SKIP;
 * any other file that will not read is BROKEN, not a finding.
 * Requires full git history (CI: actions/checkout with fetch-depth: 0).
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), compares docs/operating-manual.md against the roadmap and reports a drift line.
 * JUSTIFIED: fail-safe — nothing refreshes the manual on any trigger, so it stays stale until a session is told it has drifted.
 * DEFEAT:    none; --notify is silent while the manual is current, and
 *            reachable only by a hand run passing the flag, never by a live
 *            route.
 */

const fs = require("node:fs");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group");
const { caught } = require("./lib/caught.js");
const { isCommit } = require("./lib/commit-sha.js");
const { execGit } = require("./lib/git.js");

/** Also read by report-manual-staleness.js, which skips on its absence too. */
const MANUAL = "docs/operating-manual.md";

const WARN_MINOR = 5;
const FAIL_MINOR = 10;
const WARN_DAYS = 14;
const FAIL_DAYS = 30;

/**
 * @param {string} sha
 * @param {string} path
 */
function touches(sha, path) {
	try {
		const out = execGit(
			["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
			{ encoding: "utf8" },
		);
		return out
			.split("\n")
			.map((s) => s.trim())
			.includes(path);
	} catch {
		return false;
	}
}

/**
 * @param {string} sha
 * @returns {number|null}
 */
function commitUnixDate(sha) {
	try {
		return Number.parseInt(
			execGit(["show", "-s", "--format=%ct", sha], {
				encoding: "utf8",
			}).trim(),
			10,
		);
	} catch {
		return null;
	}
}

// The corrections log sits directly under the provenance stamp. A targeted
// correction lands one already-settled fact between full syncs, and each entry
// records the repo anchor it was made against — which is what makes "a full sync
// ran and did not clear the log" visible from the file alone.
const LABEL = "**Corrections since last sync:**";
const ENTRY =
	/^- (?<date>\d{4}-\d{2}-\d{2}) · repo (?<anchor>[0-9a-f]{7,40}) · source (?<source>\S[^—]*?) — (?<what>\S.*)$/;
// Bounding the search to the lines just after the stamp stops a later quotation
// of the label — in a section explaining the mechanism, say — from being parsed
// as the log itself.
const LOG_WINDOW = 6;

/* Assertion 5's allowlist, hand-written, in the shape
 * check-superseded-values.js's allowlists use. A missing file is an empty
 * allowlist rather than BROKEN: losing it can only ADD findings. A malformed
 * one is BROKEN.
 *
 * It sits beside this script rather than beside the manual because everything
 * under docs/ owes a doc-map Section A register entry, and this is one
 * checker's configuration, not a mapped document.
 */
const ALLOWLIST_FILE = "scripts/manual-path-allowlist.json";
/* Extensions the manual actually writes, plus the ones a citation of this repo
 * plausibly reaches for. */
const EXT =
	/\.(md|js|mjs|cjs|ts|tsx|jsx|json|html|css|sh|py|yml|yaml|txt|sql|toml|lock)$/;
/* Path characters only, never leading with `-` or `/`. */
const TOKEN = /^[A-Za-z0-9_@.][A-Za-z0-9_@.+-]*(\/[A-Za-z0-9_@.+-]+)*\/?$/;
const INLINE_CODE = /`([^`\n]+)`/g;

/* The manual's provenance stamp, and the roadmap's own version line. */
const MANUAL_VERSION = /roadmap v(\d+)\.(\d+)/;
const ROADMAP_SHA = /roadmap commit ([0-9a-f]{7,40})/;
const REPO_SHA = /reviewed against repo at ([0-9a-f]{7,40})/;
const ROADMAP_VERSION = /v(\d+)\.(\d+) · updated/;
/* A mass rename must not paste an unbounded list into one report.
 * 5 is a first guess: no run has ever reported more than one miss. */
const MAX_MISSES = 5;

/* Only code spans are scanned: prose carries slashes that are not paths at all
 * — "product/market fit", "Chat / Code / Design" — and the manual writes every
 * real path in backticks.
 *
 * Every skip is a false negative, which is the safe direction on a hook that is
 * silent when the manual is current. Deliberately skipped: prose, fenced code
 * blocks, and a token carrying a character no path of this repo uses — a glob
 * (`docs/adr/*.md`), a route group (`app/(marketing)/page.tsx`), a `file.js:41`
 * line reference. */
/**
 * @param {string} text
 * @returns {string[]}
 */
function citedTokens(text) {
	/** @type {string[]} */
	const out = [];
	for (const m of text.matchAll(INLINE_CODE))
		for (const raw of requiredGroup(m, 1, INLINE_CODE).split(/\s+/)) {
			const t = raw.replace(/^[("'`]+/, "").replace(/["'`).,;:!?]+$/, "");
			if (t && TOKEN.test(t) && !out.includes(t)) out.push(t);
		}
	return out;
}

/* Path-like on two tests only: a known extension, or a trailing slash. A
 * bare `docs/agents/verification` is therefore skipped, and so is `and/or` —
 * a third test, "the first segment names a real directory", would also report
 * every conceptual slash-term whose head collides with a top-level directory
 * (`data/analytics`), and a false positive here is noise in every report. */
/** @param {string} t */
const pathLike = (t) => EXT.test(t) || t.endsWith("/");

/**
 * @typedef {{
 *   line: (label: string, msg: string) => void,
 *   fail: (label: string, msg: string) => void,
 *   warn: (label: string, msg: string) => void,
 *   ok: (label: string, msg: string) => void,
 * }} Detail
 */

/**
 * @param {Ctx} ctx
 * @returns {Detail}
 */
function detailWriters(ctx) {
	/* Detail lines carry no severity prefix: check.js owns the one `SEVERITY:`
	 * line a run emits. These four are per-ASSERTION state, and prefixing them
	 * printed `OK: stamp shape valid` inside a run whose outcome was FAIL — the
	 * outcome vocabulary saying two different things in one stream. The label
	 * says which assertion; the summary line says how the run ended. */
	/**
	 * @param {string} label
	 * @param {string} msg
	 */
	const line = (label, msg) => ctx.say(`  ${`${label}:`.padEnd(18)}${msg}`);
	/**
	 * @param {string} label
	 * @param {string} msg
	 */
	const fail = (label, msg) => {
		ctx.fail("FRESHNESS", msg);
		line(label, msg);
	};
	/**
	 * @param {string} label
	 * @param {string} msg
	 */
	const warn = (label, msg) => {
		ctx.warn("FRESHNESS", msg);
		line(label, msg);
	};
	/* ctx.notify is false on both live routes — `npm run status`
	 * (scripts/status-report.js's manual-freshness row) and
	 * report-manual-staleness.js's in-process call — so these OK detail lines
	 * always print there. */
	/** @type {(label: string, msg: string) => void} */
	const ok = ctx.notify
		? () => {
				/* a pass is withheld under --notify */
			}
		: line;
	return { line, fail, warn, ok };
}

/**
 * @param {Ctx} ctx
 * @param {string} p
 * @param {string} label
 * @returns {string}
 */
const readOrBroken = (ctx, p, label) => {
	try {
		return fs.readFileSync(p, "utf8");
	} catch (e) {
		// Both files are tracked in the repo, so an unreadable one is BROKEN:
		// no assertion below can be evaluated at all.
		ctx.broken(`cannot read ${label} at ${p} — ${caught(e).message}`);
	}
};

/**
 * Assertion 1: stamp shape. Returns what the stamp parsed to, each field
 * undefined where the stamp is not in the two-anchor format.
 * @param {Ctx} ctx
 * @param {Detail} detail
 * @param {string} manual
 * @param {string} roadmapPath
 * @returns {{ mMajor?: number, mMinor?: number, repoSha?: string }}
 */
function assertStampShape(ctx, detail, manual, roadmapPath) {
	const verM = manual.match(MANUAL_VERSION);
	const rSha = manual.match(ROADMAP_SHA);
	const pSha = manual.match(REPO_SHA);
	if (!verM || !rSha || !pSha) {
		detail.fail(
			"stamp shape",
			"manual provenance line is not in the two-anchor format " +
				"(`… roadmap vX.Y (…), roadmap commit <sha> · reviewed against repo at <sha>.`)",
		);
		return {};
	}
	const mMajor = +requiredGroup(verM, 1, MANUAL_VERSION);
	const mMinor = +requiredGroup(verM, 2, MANUAL_VERSION);
	const roadmapSha = requiredGroup(rSha, 1, ROADMAP_SHA);
	const repoSha = requiredGroup(pSha, 1, REPO_SHA);
	const rOk = isCommit(process.cwd(), roadmapSha);
	const pOk = isCommit(process.cwd(), repoSha);
	if (!rOk)
		detail.fail(
			"stamp shape",
			`roadmap commit ${roadmapSha} does not resolve to a real commit`,
		);
	if (!pOk)
		detail.fail(
			"stamp shape",
			`reviewed-against repo commit ${repoSha} does not resolve to a real commit`,
		);
	if (rOk && !touches(roadmapSha, roadmapPath))
		detail.fail(
			"stamp shape",
			`roadmap commit ${roadmapSha} does not touch ${roadmapPath} — wrong anchor`,
		);
	// Local, not the whole run's state: a later assertion's failure must not
	// retract this one's clean line, nor this one's swallow a later one.
	if (ctx.findings.length === 0)
		detail.ok("stamp shape", `valid — roadmap ${roadmapSha}, repo ${repoSha}`);
	return { mMajor, mMinor, repoSha };
}

/**
 * Assertion 2: roadmap distance.
 * @param {Detail} detail
 * @param {string} roadmap
 * @param {string} roadmapPath
 * @param {{ mMajor: number, mMinor: number }} manualVersion
 */
function assertRoadmapDistance(detail, roadmap, roadmapPath, manualVersion) {
	const { mMajor, mMinor } = manualVersion;
	const rv = roadmap.match(ROADMAP_VERSION);
	if (!rv) {
		detail.fail(
			"roadmap distance",
			`no version line found in roadmap HTML (${roadmapPath})`,
		);
		return;
	}
	const rMajor = +requiredGroup(rv, 1, ROADMAP_VERSION);
	const rMinor = +requiredGroup(rv, 2, ROADMAP_VERSION);
	const at = `v${mMajor}.${mMinor} vs v${rMajor}.${rMinor}`;
	if (rMajor > mMajor) {
		detail.fail(
			"roadmap distance",
			`roadmap MAJOR moved (${at}); a structural roadmap change always warrants a manual refresh`,
		);
	} else if (rMajor === mMajor) {
		const behind = rMinor - mMinor;
		if (behind >= FAIL_MINOR)
			detail.fail(
				"roadmap distance",
				`manual is ${behind} roadmap MINOR versions behind (${at}); refresh overdue`,
			);
		else if (behind >= WARN_MINOR)
			detail.warn(
				"roadmap distance",
				`manual is ${behind} roadmap MINOR versions behind (${at}); refresh due soon`,
			);
		else detail.ok("roadmap distance", `${behind} MINOR (${at})`);
	} else {
		detail.ok("roadmap distance", `not behind the HTML (${at})`);
	}
}

/**
 * Assertion 3: review latency, for a stamp whose repo commit resolves.
 * @param {Detail} detail
 * @param {string} repoSha
 */
function assertReviewLatency(detail, repoSha) {
	const ct = commitUnixDate(repoSha);
	if (ct === null) {
		detail.fail(
			"review latency",
			`cannot read commit date for reviewed-against repo commit ${repoSha}`,
		);
		return;
	}
	const ageDays = (Date.now() / 1000 - ct) / 86_400;
	const d = ageDays.toFixed(1);
	if (ageDays > FAIL_DAYS)
		detail.fail(
			"review latency",
			`manual last reviewed against repo ${d} days ago (>${FAIL_DAYS}); the sync routine has stalled`,
		);
	else if (ageDays > WARN_DAYS)
		detail.warn(
			"review latency",
			`manual last reviewed against repo ${d} days ago (>${WARN_DAYS})`,
		);
	else detail.ok("review latency", `${d} days`);
}

/**
 * The index of the corrections-log label line, searched for in the window
 * just under the provenance stamp; -1 where it is absent.
 * @param {string[]} lines
 */
function correctionsLabelIndex(lines) {
	const stamp = lines.findIndex((l) => l.includes("reviewed against repo at "));
	const from = stamp === -1 ? 0 : stamp + 1;
	const found = lines
		.slice(from, from + LOG_WINDOW)
		.findIndex((l) => l.trimStart().startsWith(LABEL));
	return found === -1 ? -1 : from + found;
}

/**
 * The `- ` entry lines under the label at `at`.
 * @param {string[]} lines
 * @param {number} at
 */
function correctionsEntries(lines, at) {
	// A blank line between a bold lead-in and its list is ordinary Markdown,
	// so skip blanks rather than reading them as "the list ended".
	const entries = [];
	for (const raw of lines.slice(at + 1)) {
		const line = raw.trim();
		if (line === "" && entries.length === 0) continue;
		if (!line.startsWith("- ")) break;
		entries.push(line);
	}
	return entries;
}

/**
 * @param {string} head
 * @param {string[]} entries
 * @returns {string | null}
 */
function correctionsHeadFault(head, entries) {
	if (head === "none.") {
		if (entries.length > 0)
			return `corrections log reads "none." but ${entries.length} entry line(s) follow it`;
	} else if (head !== "") {
		return (
			`corrections log header is malformed — expected "${LABEL} none." or ` +
			`"${LABEL}" followed by entry lines, got "${head}"`
		);
	} else if (entries.length === 0) {
		return 'corrections log opens a list but carries no entries — use "none."';
	}
	return null;
}

/**
 * @param {string} line
 * @param {string | undefined} repoSha
 * @returns {string | null}
 */
function correctionsEntryFault(line, repoSha) {
	const m = line.match(ENTRY);
	if (!m) {
		if (!line.includes(" · source "))
			return `corrections entry cites no source: ${line}`;
		return (
			"corrections entry is malformed — expected " +
			"`- <YYYY-MM-DD> · repo <sha> · source <where settled> — <what changed>`: " +
			line
		);
	}
	/* The pattern above names this group, so a match always carries it. */
	const recorded = /** @type {string} */ (m.groups?.anchor);
	if (repoSha && !recorded.startsWith(repoSha) && !repoSha.startsWith(recorded))
		return (
			`corrections entry records repo anchor ${recorded} but the stamp reads ${repoSha} — ` +
			"a full sync advanced the anchor without clearing the log: " +
			line
		);
	return null;
}

/**
 * Assertion 4: corrections log.
 * @param {Detail} detail
 * @param {string} manual
 * @param {string | undefined} repoSha
 */
function assertCorrectionsLog(detail, manual, repoSha) {
	const lines = manual.split("\n");
	const at = correctionsLabelIndex(lines);
	const labelLine = lines[at];
	if (labelLine === undefined) {
		detail.fail(
			"corrections log",
			`manual carries no "${LABEL}" line — it sits under the provenance stamp ` +
				'and reads "none." when nothing is outstanding ' +
				"(.claude/skills/manual-sync/SKILL.md, Targeted-correction mode)",
		);
		return;
	}
	// Local, not the run's whole finding list: an earlier assertion's failure
	// must not swallow this one's clean line.
	let clean = true;
	/** @param {string | null} msg */
	const bad = (msg) => {
		if (msg === null) return;
		clean = false;
		detail.fail("corrections log", msg);
	};

	const head = labelLine.trim().slice(LABEL.length).trim();
	const entries = correctionsEntries(lines, at);
	bad(correctionsHeadFault(head, entries));
	for (const line of entries) bad(correctionsEntryFault(line, repoSha));

	if (clean)
		detail.ok(
			"corrections log",
			entries.length > 0
				? `${entries.length} entry line(s), all sourced and at the current anchor`
				: "none outstanding",
		);
}

/**
 * Assertion 5's allowlist, token → the path it stands for.
 * @param {Ctx} ctx
 * @param {string} allowPath
 * @returns {Map<string, string | undefined>}
 */
function loadAllowlist(ctx, allowPath) {
	const allow = new Map();
	if (!fs.existsSync(allowPath)) return allow;
	let data;
	try {
		data = JSON.parse(fs.readFileSync(allowPath, "utf8"));
	} catch (e) {
		ctx.broken(`cannot parse ${allowPath} — ${caught(e).message}`);
	}
	if (!data || !Array.isArray(data.allowlist))
		ctx.broken(`${allowPath} has no "allowlist" array`);
	for (const e of data.allowlist) {
		if (!e || typeof e.token !== "string" || typeof e.reason !== "string")
			ctx.broken(
				`${allowPath} entry needs a string "token" and "reason": ${JSON.stringify(e)}`,
			);
		if (e.path !== undefined && typeof e.path !== "string")
			ctx.broken(`${allowPath} entry "${e.token}" has a non-string "path"`);
		allow.set(e.token, e.path);
	}
	return allow;
}

/**
 * The manual's cited paths that do not exist, how many were checked, and
 * which allowlist tokens the manual still cites.
 * @param {string} manual
 * @param {Map<string, string | undefined>} allow
 */
function resolveCitedPaths(manual, allow) {
	const allowUsed = new Set();
	const misses = [];
	let checked = 0;
	for (const t of citedTokens(manual)) {
		const allowed = allow.has(t);
		if (allowed) allowUsed.add(t);
		// An allowlisted token may still name a real file loosely — a basename,
		// say. Checking the path it stands for is what keeps a rename visible
		// rather than suppressed along with the token.
		const target = allowed ? allow.get(t) : t;
		if (target === undefined) continue;
		if (!allowed && !pathLike(t)) continue;
		checked++;
		if (!fs.existsSync(target))
			misses.push(t === target ? t : `${t} (stands for ${target})`);
	}
	return { misses, checked, allowUsed };
}

/**
 * Assertion 5: cited paths.
 * @param {Ctx} ctx
 * @param {Detail} detail
 * @param {string} manual
 */
function assertCitedPaths(ctx, detail, manual) {
	const allowPath = ctx.value("--allowlist", ALLOWLIST_FILE);
	const allow = loadAllowlist(ctx, allowPath);
	const { misses, checked, allowUsed } = resolveCitedPaths(manual, allow);

	// A suppression that has stopped covering anything is named, not left to rot.
	for (const t of allow.keys())
		if (!allowUsed.has(t)) {
			const msg = `${allowPath} allowlists "${t}", which the manual no longer cites`;
			ctx.warn("CITED-PATH", msg);
			detail.line("cited paths", msg);
		}

	if (misses.length === 0) {
		detail.ok("cited paths", `${checked} cited path(s) resolve`);
		return;
	}
	const shown = misses.slice(0, MAX_MISSES);
	const more =
		misses.length > shown.length
			? ` (+${misses.length - shown.length} more)`
			: "";
	ctx.warn(
		"CITED-PATH",
		`manual cites ${misses.length} path(s) that do not exist: ${shown.join(", ")}${more}`,
	);
	detail.line(
		"cited paths",
		`${misses.length} miss(es): ${shown.join(", ")}${more}`,
	);
}

/*
 * Exported so report-manual-staleness.js's freshness() can call this SPEC's
 * run() directly, in-process, instead of shelling out to a second `node`
 * (mantahostels#2062) — the guard below is what makes requiring this file for that safe:
 * without it, every require would re-run runCheck and exit the caller.
 */
const SPEC = {
	name: "manual-freshness",
	module: require("./lib/workflow-core-config.js").MANUAL_HALF,
	usage:
		"node check-manual-freshness.js [<manual.md> <roadmap.html>] [--allowlist <file>] [--notify]",
	valueFlags: ["--allowlist"],
	run(/** @type {Ctx} */ ctx) {
		const manualPath = ctx.args[0] || MANUAL;
		const roadmapPath = ctx.args[1] || "docs/reference-roadmap.html";

		const detail = detailWriters(ctx);

		// An adopter's manual does not exist until its first manual-sync (#395 Q1).
		/* The default path only: a path passed by hand that does not read is a
		 * bad invocation, and stays BROKEN below. */
		if (!ctx.args[0] && !fs.existsSync(manualPath))
			ctx.skip(
				`no operating manual at ${manualPath} yet — the first manual-sync writes it`,
			);
		const manual = readOrBroken(ctx, manualPath, "operating manual");
		const roadmap = readOrBroken(ctx, roadmapPath, "roadmap HTML");

		const { mMajor, mMinor, repoSha } = assertStampShape(
			ctx,
			detail,
			manual,
			roadmapPath,
		);

		if (mMajor !== undefined && mMinor !== undefined)
			assertRoadmapDistance(detail, roadmap, roadmapPath, { mMajor, mMinor });

		if (repoSha && isCommit(process.cwd(), repoSha))
			assertReviewLatency(detail, repoSha);

		assertCorrectionsLog(detail, manual, repoSha);

		assertCitedPaths(ctx, detail, manual);

		if (!ctx.notify) ctx.say("");
		return {
			okLine: "the manual is current.",
			noun: "manual-freshness assertion(s) failing",
		};
	},
};

if (require.main === module) runCheck(SPEC);

module.exports = { SPEC, MANUAL };
