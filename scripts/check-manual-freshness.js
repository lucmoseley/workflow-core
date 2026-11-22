#!/usr/bin/env node

const fs = require("node:fs");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");
const { readCommitOrBroken } = require("./lib/commit-sha.js");
const { requiredGroup } = require("./lib/regex-group");
const { caught } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");
const { execGit } = require("./lib/git.js");
const { trimEndRun } = require("./lib/trim-run.js");

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

const LABEL = "**Corrections since last sync:**";
const ENTRY =
	/^- (?<date>\d{4}-\d{2}-\d{2}) · repo (?<anchor>[0-9a-f]{7,40}) · source (?<source>\S[^—]*?) — (?<what>\S.*)$/;
const LOG_WINDOW = 6;

const ALLOWLIST_FILE = "scripts/manual-path-allowlist.json";
const EXT =
	/\.(md|js|mjs|cjs|ts|tsx|jsx|json|html|css|sh|py|yml|yaml|txt|sql|toml|lock)$/;
const TOKEN = /^[A-Za-z0-9_@.][A-Za-z0-9_@.+-]*(\/[A-Za-z0-9_@.+-]+)*\/?$/;
const INLINE_CODE = /`([^`\n]+)`/g;

const MANUAL_VERSION = /roadmap v(\d+)\.(\d+)/;
const ROADMAP_SHA = /roadmap commit ([0-9a-f]{7,40})/;
const REPO_SHA = /reviewed against repo at ([0-9a-f]{7,40})/;
const ROADMAP_VERSION = /v(\d+)\.(\d+) · updated/;
const MAX_MISSES = 5;

/**
 * @param {string} text
 * @returns {string[]}
 */
function citedTokens(text) {
	/** @type {string[]} */
	const out = [];
	for (const m of text.matchAll(INLINE_CODE))
		for (const raw of requiredGroup(m, 1, INLINE_CODE).split(/\s+/)) {
			const t = trimEndRun(raw.replace(/^[("'`]+/, ""), "\"'`).,;:!?");
			if (t && TOKEN.test(t) && !out.includes(t)) out.push(t);
		}
	return out;
}

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
	/** @type {(label: string, msg: string) => void} */
	const ok = ctx.notify ? noop : line;
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
		ctx.broken(`cannot read ${label} at ${p} — ${caught(e).message}`);
	}
};

/**
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
	const rOk = readCommitOrBroken(roadmapSha) !== null;
	const pOk = readCommitOrBroken(repoSha) !== null;
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
	if (ctx.findings.length === 0)
		detail.ok("stamp shape", `valid — roadmap ${roadmapSha}, repo ${repoSha}`);
	return { mMajor, mMinor, repoSha };
}

/**
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
 * @param {string[]} lines
 * @param {number} at
 */
function correctionsEntries(lines, at) {
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
 * @param {Ctx} ctx
 * @param {Detail} detail
 * @param {string} manual
 */
function assertCitedPaths(ctx, detail, manual) {
	const allowPath = ctx.value("--allowlist", ALLOWLIST_FILE);
	const allow = loadAllowlist(ctx, allowPath);
	const { misses, checked, allowUsed } = resolveCitedPaths(manual, allow);

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

		if (repoSha && readCommitOrBroken(repoSha) !== null)
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
