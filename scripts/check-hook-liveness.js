#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { configDirs, stateDir } = require("./lib/arbiter-store");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { byCodeUnit } = require("./lib/by-code-unit.js");
const detachedRun = require("./lib/detached-run.js");
const { REAP_LIVE_DEATHS_TO_REPORT } = require("./reap-finished-sessions.js");
const { runCheck } = require("./lib/check");
const { projectSlug: slugFor } = require("./lib/project-slug.js");
const { projectDirs } = require("./lib/project-dirs.js");
const {
	readSessionStartRoster,
	KEY_OVERRIDES: ROSTER_KEY_OVERRIDES,
} = require("./lib/session-start-roster.js");
const { pinnedOrFirstUsable } = require("./lib/can-hold-state.js");
const deliveryStamp = require("./lib/delivery-stamp");
const { hostRoot } = require("./lib/host-root.js");
const { resolveMarketplace } = require("./lib/plugin-state.js");
const { caught, ignoreFailure, orFallback } = require("./lib/caught.js");
const { readText } = require("./lib/file-read.js");
const { parseJsonlRow } = require("./lib/jsonl.js");
const {
	flattenHooks,
	readOwnHookSources,
	toScriptsRel,
} = require("./lib/core-hooks.js");
const { selfPluginRoot } = require("./lib/hook-env.js");
const { spawnGitSync } = require("./lib/git.js");
const { scriptPath } = require("./lib/script-path.js");

let stateBaseMemo = "";

/** @param {string} name */
function statePath(name) {
	if (!stateBaseMemo) {
		stateBaseMemo = pinnedOrFirstUsable(
			stateDir(),
			configDirs().map((cfg) => path.join(cfg, "projects", projectSlug())),
		);
	}
	return path.join(stateBaseMemo, name);
}

const repoRoot = () => hostRoot();

const projectSlug = () => slugFor(repoRoot());

const MIN_FAILURES = 5;
const ZERO_SUCCESS_SESSION_RATE = 0.005;

const CACHE_RETENTION_DAYS = 7;

const DEFAULT_BUDGET_MS = 8000;

const BUDGET_AFTER_ENV = "WFC_CENSUS_BUDGET_AFTER";

/**
 * @param {number} budgetMs
 * @returns {(filesRead: number) => boolean}
 */
function budgetSpender(budgetMs) {
	const deadline = Date.now() + budgetMs;
	const raw = process.env[BUDGET_AFTER_ENV];
	if (!raw) return () => Date.now() >= deadline;
	const after = Number(raw);
	return (filesRead) => filesRead >= after || Date.now() >= deadline;
}

const DEFAULT_DAYS = 2;

const FAILURE_TYPES = new Set(["hook_cancelled", "hook_non_blocking_error"]);

const NEEDLE = Buffer.from('{"type":"hook_');

/**
 * @typedef {{ ok: number, bad: number, failSessions: number }} Tally
 * @typedef {{ scanned: number, days: Record<string, Record<string, [number, number]>>, bare: Record<string, number> }} FileEntry
 * @typedef {{ version: number, files: Record<string, FileEntry> }} Cache
 */

const CACHE_VERSION = 2;

/** @param {string} file */
function readCache(file) {
	const c = orFallback(() => JSON.parse(fs.readFileSync(file, "utf8")), null);
	if (c && c.version === CACHE_VERSION && c.files) return c;
	return { version: CACHE_VERSION, files: {} };
}

/**
 * @param {Buffer} buf
 * @param {number} from
 * @param {Record<string, Record<string, [number, number]>>} days
 * @param {Record<string, number>} bare
 * @returns {number}
 */
function countInto(buf, from, days, bare) {
	const end = buf.lastIndexOf(0x0a, buf.length - 1) + 1;
	if (end <= from) return from;
	let p = from;
	for (;;) {
		const i = buf.indexOf(NEEDLE, p);
		if (i < 0 || i >= end) break;
		const lineStart = buf.lastIndexOf(0x0a, i) + 1;
		let lineEnd = buf.indexOf(0x0a, i);
		if (lineEnd < 0 || lineEnd > end) lineEnd = end;
		p = lineEnd + 1;
		const rec = parseJsonlRow(
			buf.subarray(lineStart, lineEnd).toString("utf8"),
		);
		if (rec) tallyRecord(rec, days, bare);
	}
	return end;
}

/**
 * @param {any} rec
 * @param {Record<string, Record<string, [number, number]>>} days
 * @param {Record<string, number>} bare
 */
function tallyRecord(rec, days, bare) {
	const a = rec?.attachment;
	if (!a || typeof a.type !== "string") return;
	const success = a.type === "hook_success";
	if (!success && !FAILURE_TYPES.has(a.type)) return;
	const day =
		typeof rec.timestamp === "string" ? rec.timestamp.slice(0, 10) : "unknown";
	if (typeof a.command !== "string" || !a.command) {
		if (!success) bare[day] = (bare[day] || 0) + 1;
		return;
	}
	bumpTally(days, day, a.command, success);
}

/**
 * @param {Record<string, Record<string, [number, number]>>} days
 * @param {string} day
 * @param {string} command
 * @param {boolean} success
 */
function bumpTally(days, day, command, success) {
	if (!days[day]) days[day] = {};
	const bucket = days[day];
	let t = bucket[command];
	if (!t) {
		t = [0, 0];
		bucket[command] = t;
	}
	if (success) t[0]++;
	else t[1]++;
}

/** @param {string} which */
const stampName = (which) => `hook-liveness-${which}`;

/** @type {Map<string, string>} */
const pendingStamps = new Map();

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} which
 * @param {string} key
 * @returns {boolean}
 */
function saidBeforeElseQueue(ctx, which, key) {
	const checker = stampName(which);
	if (!key) {
		clearSaid(which);
		return false;
	}
	if (deliveryStamp.alreadyDelivered(ctx, checker, key)) return true;
	pendingStamps.set(checker, key);
	return false;
}

/** @param {string} which */
function clearSaid(which) {
	deliveryStamp.clearDelivery(stampName(which));
}

/** @param {import("./lib/check").Ctx} ctx */
function flushStamps(ctx) {
	for (const [checker, key] of pendingStamps)
		deliveryStamp.markDelivered(ctx, checker, key);
	pendingStamps.clear();
}

/**
 * @param {number} cutoff
 * @returns {{ files: Array<{file: string, mtimeMs: number, size: number, id: string}>, dirs: string[], unreadable: string[] }}
 */
function readCorpusFiles(cutoff) {
	/** @type {TranscriptsByRel} */
	const byRel = new Map();
	const dirs = [];
	const unreadable = [];

	for (const dir of projectDirs()) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			const { code } = caught(e);
			if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(dir);
			continue;
		}
		dirs.push(dir);
		takeProjectDir(byRel, cutoff, dir, entries);
	}
	const files = [...byRel.values()];
	files.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return { files, dirs, unreadable };
}

/**
 * @typedef {Map<string, {file: string, mtimeMs: number, size: number, id: string}>} TranscriptsByRel
 */

/**
 * @param {TranscriptsByRel} byRel
 * @param {number} cutoff
 * @param {string} dir
 * @param {string} at
 * @returns {boolean}
 */
function takeTranscript(byRel, cutoff, dir, at) {
	try {
		const st = fs.statSync(at);
		const rel = path.relative(dir, at);
		const held = byRel.get(rel);
		if (st.isFile() && st.mtimeMs >= cutoff && (!held || st.size > held.size))
			byRel.set(rel, {
				file: at,
				mtimeMs: st.mtimeMs,
				size: st.size,
				id: `${st.dev}:${st.ino}`,
			});
		return st.mtimeMs >= cutoff;
	} catch {
		return false;
	}
}

/**
 * @param {TranscriptsByRel} byRel
 * @param {number} cutoff
 * @param {string} dir
 * @param {fs.Dirent[]} entries
 */
function takeProjectDir(byRel, cutoff, dir, entries) {
	const live = new Set();
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
		if (takeTranscript(byRel, cutoff, dir, path.join(dir, e.name)))
			live.add(e.name.replace(/\.jsonl$/, ""));
	}
	for (const e of entries) {
		if (!e.isDirectory() || !live.has(e.name)) continue;
		takeSubagents(byRel, cutoff, dir, path.join(dir, e.name, "subagents"));
	}
}

/**
 * @param {TranscriptsByRel} byRel
 * @param {number} cutoff
 * @param {string} dir
 * @param {string} subDir
 */
function takeSubagents(byRel, cutoff, dir, subDir) {
	let subs;
	try {
		subs = fs.readdirSync(subDir);
	} catch {
		return;
	}
	for (const f of subs)
		if (f.endsWith(".jsonl"))
			takeTranscript(byRel, cutoff, dir, path.join(subDir, f));
}

/**
 * @param {string} day
 * @param {number} cutoff
 */
function inWindow(day, cutoff) {
	if (day === "unknown") return true;
	const dayEnd = Date.parse(`${day}T23:59:59.999Z`);
	return !(Number.isFinite(dayEnd) && dayEnd < cutoff);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {number} days
 * @param {number} budgetMs
 * @returns {{ reported: string[], scanned: number, bytes: number, covered: number, total: number, bare: number, asyncBlind: number } | { unavailable: string }}
 */
function censusAssertion(ctx, days, budgetMs) {
	const budgetSpent = budgetSpender(budgetMs);
	const retainCutoff = Date.now() - CACHE_RETENTION_DAYS * 86_400_000;
	const { files, dirs, unreadable } = readCorpusFiles(retainCutoff);
	const saidDirs = saidBeforeElseQueue(
		ctx,
		"corpus",
		[...unreadable].sort().join("\n"),
	);
	const mayClear = unreadable.length === 0;
	for (const dir of unreadable) {
		const line = `${dir} could not be listed, so any hook failing only in those sessions is invisible here`;
		ctx.warn("CORPUS-UNREADABLE", line, { dir });
		if (!saidDirs && !ctx.inActions) ctx.say(line);
	}
	if (dirs.length === 0) {
		if (mayClear) clearSaid("census");
		return { unavailable: buildNoCorpusReason(unreadable) };
	}

	const cacheFile = statePath("hook-liveness-census.json");
	const cache = readCache(cacheFile);
	const windowCutoff = Date.now() - days * 86_400_000;
	const scan = scanCorpus(files, cache, budgetSpent, windowCutoff);
	writeCensusCache(cacheFile, scan.next);

	const total = files.length;
	const bad = [...scan.totals]
		.filter(([, t]) => isFailingHook(t, scan.windowSessions))
		.sort((a, b) => b[1].bad - a[1].bad);

	sayBareRecords(ctx, scan.bareTotal, days, mayClear);
	const blindRoster = sayAsyncBlindRoster(ctx, mayClear);

	/** @param {string[]} reported */
	const result = (reported) => ({
		reported,
		scanned: scan.scanned,
		bytes: scan.bytes,
		covered: scan.covered,
		total,
		bare: scan.bareTotal,
		asyncBlind: blindRoster.length,
	});
	const key = bad
		.map(([cmd]) => cmd)
		.sort()
		.join("\n");
	if (bad.length === 0) {
		if (mayClear) clearSaid("census");
		return result([]);
	}
	if (saidBeforeElseQueue(ctx, "census", key)) return result([]);

	reportFailingHooks(ctx, bad, days, {
		windowSessions: scan.windowSessions,
		covered: scan.covered,
		dirs,
		total,
	});
	return result(bad.map(([cmd]) => cmd));
}

/** @param {string[]} unreadable */
function buildNoCorpusReason(unreadable) {
	return unreadable.length > 0
		? `every config dir that could hold transcripts for ${repoRoot()} refused to be listed`
		: `no retained transcripts for ${repoRoot()} under any config dir on this machine`;
}

/**
 * @typedef {{
 *   next: Cache,
 *   totals: Map<string, Tally>,
 *   scanned: number,
 *   bytes: number,
 *   covered: number,
 *   windowSessions: number,
 *   bareTotal: number,
 * }} CensusScan
 */

/**
 * @param {Array<{file: string, mtimeMs: number, size: number, id: string}>} files
 * @param {Cache} cache
 * @param {(filesRead: number) => boolean} budgetSpent
 * @param {number} windowCutoff
 * @returns {CensusScan}
 */
function scanCorpus(files, cache, budgetSpent, windowCutoff) {
	/** @type {CensusScan} */
	const scan = {
		next: { version: CACHE_VERSION, files: {} },
		totals: new Map(),
		scanned: 0,
		bytes: 0,
		covered: 0,
		windowSessions: 0,
		bareTotal: 0,
	};

	const countedBare = new Set();
	for (const { file, size, mtimeMs, id } of files) {
		const { entry, spent } = refreshEntry(
			scan,
			cache.files[file],
			{ file, size },
			budgetSpent,
		);
		scan.next.files[file] = entry;
		if (!spent) scan.covered++;

		if (mtimeMs < windowCutoff) continue;
		scan.windowSessions++;
		if (!countedBare.has(id)) {
			countedBare.add(id);
			addBareInWindow(scan, entry.bare, windowCutoff);
		}
		addFileTotals(scan.totals, entry.days, windowCutoff);
	}
	return scan;
}

/**
 * @param {CensusScan} scan
 * @param {FileEntry | undefined} prev
 * @param {{ file: string, size: number }} transcript
 * @param {(filesRead: number) => boolean} budgetSpent
 * @returns {{ entry: FileEntry, spent: boolean }}
 */
function refreshEntry(scan, prev, transcript, budgetSpent) {
	const { file, size } = transcript;
	const from = prev && prev.scanned <= size ? prev.scanned : 0;
	/** @type {FileEntry} */
	const entry =
		from && prev
			? { scanned: from, days: prev.days, bare: prev.bare }
			: { scanned: 0, days: {}, bare: {} };
	const spent = from < size && budgetSpent(scan.scanned);
	if (from < size && !spent) {
		const { buf, got } = readFrom(file, from, size);
		scan.bytes += got;
		scan.scanned++;
		const days = structuredClone(entry.days);
		const bare = { ...entry.bare };
		const scanned = from + countInto(buf.subarray(0, got), 0, days, bare);
		return { entry: { scanned, days, bare }, spent };
	}
	return { entry, spent };
}

/**
 * @param {string} file
 * @param {number} from
 * @param {number} size
 * @returns {{ buf: Buffer, got: number }}
 */
function readFrom(file, from, size) {
	const len = size - from;
	const buf = Buffer.allocUnsafe(len);
	const fd = fs.openSync(file, "r");
	let got = 0;
	try {
		got = fs.readSync(fd, buf, 0, len, from);
	} finally {
		fs.closeSync(fd);
	}
	return { buf, got };
}

/**
 * @param {CensusScan} scan
 * @param {Record<string, number>} bare
 * @param {number} windowCutoff
 */
function addBareInWindow(scan, bare, windowCutoff) {
	for (const [day, n] of Object.entries(bare)) {
		if (!inWindow(day, windowCutoff)) continue;
		scan.bareTotal += n;
	}
}

/**
 * @param {Map<string, Tally>} totals
 * @param {Record<string, Record<string, [number, number]>>} days
 * @param {number} windowCutoff
 */
function addFileTotals(totals, days, windowCutoff) {
	const failedHere = new Set();
	for (const [day, cmds] of Object.entries(days)) {
		if (!inWindow(day, windowCutoff)) continue;
		for (const [cmd, [ok, bad]] of Object.entries(cmds)) {
			const t = totals.get(cmd) || { ok: 0, bad: 0, failSessions: 0 };
			t.ok += ok;
			t.bad += bad;
			if (bad > 0 && !failedHere.has(cmd)) {
				failedHere.add(cmd);
				t.failSessions++;
			}
			totals.set(cmd, t);
		}
	}
}

/**
 * @param {string} cacheFile
 * @param {Cache} next
 */
function writeCensusCache(cacheFile, next) {
	ignoreFailure(() => {
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(cacheFile, JSON.stringify(next));
	});
}

/**
 * @param {Tally} t
 * @param {number} windowSessions
 */
function isFailingHook(t, windowSessions) {
	return (
		t.bad >= MIN_FAILURES &&
		(t.ok > 0
			? t.bad > t.ok
			: t.failSessions / Math.max(windowSessions, 1) >=
				ZERO_SUCCESS_SESSION_RATE)
	);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {number} bareTotal
 * @param {number} days
 * @param {boolean} mayClear
 */
function sayBareRecords(ctx, bareTotal, days, mayClear) {
	if (bareTotal) {
		if (!saidBeforeElseQueue(ctx, "census-bare", "some"))
			ctx.say(
				`${bareTotal} failure record(s) in the last ${days} days named no hook command, so this census\n` +
					"could attribute them to nothing. Every PostToolUse cancellation lands here, by construction.",
			);
	} else if (mayClear) clearSaid("census-bare");
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {boolean} mayClear
 */
function sayAsyncBlindRoster(ctx, mayClear) {
	const blindRoster = readSessionStartRoster(repoRoot(), {
		keyOverrides: ROSTER_KEY_OVERRIDES,
	});
	if (blindRoster.length > 0) {
		const sorted = [...blindRoster].sort((a, b) => byCodeUnit(a.key, b.key));
		if (
			!saidBeforeElseQueue(
				ctx,
				"census-async-blind",
				sorted.map((r) => r.key).join("\n"),
			)
		)
			ctx.say(
				`${sorted.length} SessionStart producer(s) persist their own report and write no transcript\n` +
					`record at all, so this census cannot see them: ${sorted.map((r) => `${r.key} (${r.script})`).join(", ")}.\n` +
					"scripts/replay-notify-reports.js reads their persisted run/report files instead, reap-finished-sessions's\n" +
					"own next-run line covering its cancellation there.",
			);
	} else if (mayClear) clearSaid("census-async-blind");
	return blindRoster;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<[string, Tally]>} bad
 * @param {number} days
 * @param {{ windowSessions: number, covered: number, dirs: string[], total: number }} corpus
 */
function reportFailingHooks(ctx, bad, days, corpus) {
	const { windowSessions, covered, dirs, total } = corpus;
	for (const [cmd, t] of bad)
		ctx.fail(
			"HOOK-FAILING",
			`${t.bad} failure record(s) against ${t.ok} success(es) in the last ${days} days, across ${t.failSessions} of ${windowSessions} session(s) — ${cmd}`,
			{
				command: cmd,
				failures: t.bad,
				successes: t.ok,
				failSessions: t.failSessions,
				sessions: windowSessions,
				days,
			},
		);

	ctx.say(
		`${bad.length} wired hook(s) whose failure records outnumber their successes over the last ${days} days.\n` +
			"Each of these is configured, reached and did not complete, so whatever it checks or injects did not happen.\n",
	);
	for (const [cmd, t] of bad)
		ctx.say(
			`  ${t.bad} failed / ${t.ok} succeeded, in ${t.failSessions} of ${windowSessions} session(s)\n    ${cmd}`,
		);
	ctx.say(
		"\nA hook that prints nothing when it passes records no success, so a zero on the right\n" +
			"is not a claim that it never worked. Run each command above by hand to see what it does\n" +
			`with no timeout on it. Transcripts read: ${dirs.join(", ")}`,
	);
	if (covered < total)
		ctx.say(
			`Budget spent at ${covered} of ${total} transcript file(s); the rest are read on the next run.`,
		);
}

/**
 * @param {string} marketplaceDir
 * @param {string} name
 * @returns {{ rel: string } | { unverifiable: string, unreadable?: boolean }}
 */
function readPluginSource(marketplaceDir, name) {
	const at = path.join(marketplaceDir, ".claude-plugin", "marketplace.json");
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(at, "utf8"));
	} catch (e) {
		return {
			unverifiable: `${at} could not be read: ${caught(e).message}`,
			unreadable: true,
		};
	}
	const entry = (doc.plugins || []).find(
		(/** @type {any} */ p) => p && p.name === name,
	);
	if (!entry) return { unverifiable: `${name} is not listed in ${at}` };
	if (typeof entry.source !== "string")
		return {
			unverifiable: `${name} is sourced from another repository, which this machine does not hold`,
		};
	return { rel: entry.source.replace(/^\.\/?/, "") };
}

/**
 * @param {string | null} a
 * @param {string | null} b
 */
function isSameManifest(a, b) {
	if (a === null || b === null) return a === b;
	const canon = (/** @type {string} */ s) => {
		try {
			return JSON.stringify(JSON.parse(s));
		} catch {
			return s;
		}
	};
	return canon(a) === canon(b);
}

/**
 * @param {string} marketplaceDir
 * @param {string} rel
 * @param {string | undefined} sha
 * @returns {{ text: string | null, basis: string }
 *   | { unverifiable: string, unreadable?: boolean }}
 */
function readUpstreamManifest(marketplaceDir, rel, sha) {
	const relFile = path.posix.join(rel, "hooks/hooks.json");
	if (sha && fs.existsSync(path.join(marketplaceDir, ".git"))) {
		const commitPresent = spawnGitSync(
			["-C", marketplaceDir, "cat-file", "-e", `${sha}^{commit}`],
			{ encoding: "utf8" },
		);
		if (commitPresent.status !== 0)
			return {
				unverifiable: `commit ${sha.slice(0, 8)} is not in ${marketplaceDir}, which sits on another version than the install`,
				unreadable: true,
			};
		const r = spawnGitSync(
			["-C", marketplaceDir, "show", `${sha}:${relFile}`],
			{
				encoding: "utf8",
			},
		);
		if (r.status === 0)
			return { text: r.stdout, basis: `${sha.slice(0, 8)}:${relFile}` };
		const err = (r.stderr || r.error?.message || "").trim();
		if (/does not exist in|exists on disk, but not in/.test(err))
			return { text: null, basis: `${sha.slice(0, 8)} (no hooks/hooks.json)` };
		return {
			unverifiable: `git show ${sha.slice(0, 8)}:${relFile} failed: ${err.slice(0, 120)}`,
			unreadable: true,
		};
	}
	const at = path.join(marketplaceDir, relFile);
	const read = readText(at);
	if (read.state === "unreadable") return buildUnreadable(at, read.message);
	return {
		text: read.state === "read" ? read.data : null,
		basis: `${at} (the checkout as it stands, not a pinned commit)`,
	};
}

/**
 * @param {string} pluginsDir
 * @param {string} marketplace
 * @returns {string}
 */
function resolveMarketplaceDir(pluginsDir, marketplace) {
	const { dir } = resolveMarketplace(pluginsDir, marketplace);
	return dir ?? path.join(pluginsDir, "marketplaces", marketplace);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} cfg
 * @param {Set<string>} warned
 * @returns {Record<string, unknown>}
 */
function readEnabledPluginsFor(ctx, cfg, warned) {
	/** @type {Record<string, unknown>} */
	const merged = {};
	for (const at of [
		path.join(cfg, "settings.json"),
		path.join(repoRoot(), ".claude", "settings.json"),
		path.join(repoRoot(), ".claude", "settings.local.json"),
	]) {
		let doc;
		try {
			doc = JSON.parse(fs.readFileSync(at, "utf8"));
		} catch (e) {
			const { code, message } = caught(e);
			if (code === "ENOENT" || warned.has(at)) continue;
			warned.add(at);
			const line = `${at} does not parse, so no plugin it enables is audited: ${message}`;
			ctx.warn("SETTINGS-UNPARSEABLE", line, { path: at }, at);
			if (!ctx.inActions) ctx.say(line);
			continue;
		}
		const ep = doc?.enabledPlugins;
		if (ep && typeof ep === "object") Object.assign(merged, ep);
	}
	return merged;
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function hookTuples(text) {
	/** @type {Set<string>} */
	const out = new Set();
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return out;
	}
	for (const { event, matcher, hook } of wiredHooks(doc))
		out.add(`${event}\t${matcher?.matcher ?? ""}\t${hook.command}`);
	return out;
}

/**
 * @param {any} doc
 * @returns {Array<{ event: string, matcher: any, hook: any }>}
 */
function wiredHooks(doc) {
	/** @type {Array<{ event: string, matcher: any, hook: any }>} */
	const out = [];
	for (const [event, matchers] of Object.entries(doc?.hooks || {}))
		for (const matcher of Array.isArray(matchers) ? matchers : [])
			for (const hook of /** @type {any[]} */ (matcher?.hooks || []))
				if (typeof hook?.command === "string")
					out.push({ event, matcher, hook });
	return out;
}

/**
 * @param {string|null} cached
 * @param {string|null} upstream
 * @returns {string}
 */
function divergenceShape(cached, upstream) {
	if (cached === null) return "the cache holds no hooks/hooks.json at all";
	if (upstream === null)
		return "the marketplace ships none, so the cache wires hooks the plugin does not declare";
	return `cached ${cached.length} B against ${upstream.length} B upstream`;
}

/**
 * @typedef {{
 *   compared: number,
 *   manifests: number,
 *   unverifiable: string[],
 *   unreadable: number,
 *   diverged: Array<{key: string, cachedAt: string, basis: string, installPath: string, cachedBytes: number | null, upstreamBytes: number | null, shape: string}>,
 *   droppedHooks: Array<{key: string, event: string, command: string, cachedAt: string, basis: string}>,
 *   brokenPluginPaths: Array<{key: string, event: string, rel: string, full: string, reason: HookPathFault}>,
 * }} ManifestAudit
 * @typedef {"missing" | "not-a-file" | "not-executable"} HookPathFault
 */

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ compared: number, unverifiable: string[], droppedHooks: number, brokenPluginPaths: number } | { unavailable: string }}
 */
function manifestAssertion(ctx) {
	const root = repoRoot();
	/** @type {ManifestAudit} */
	const audit = {
		compared: 0,
		manifests: 0,
		unverifiable: [],
		unreadable: 0,
		diverged: [],
		droppedHooks: [],
		brokenPluginPaths: [],
	};
	/** @type {Set<string>} */
	const warnedSettings = new Set();

	for (const cfg of configDirs())
		auditConfigDir(ctx, audit, cfg, { root, warnedSettings });

	const divergedKey = audit.diverged
		.map((d) => d.key)
		.sort()
		.join("\n");
	const saidDiverged =
		divergedKey || !audit.unreadable
			? saidBeforeElseQueue(ctx, "manifest", divergedKey)
			: false;

	if (!audit.manifests)
		return {
			unavailable: "no plugin manifest under any config dir on this machine",
		};

	if (!saidDiverged) reportDiverged(ctx, audit.diverged);

	reportDroppedHooks(ctx, audit.droppedHooks);
	reportBrokenPluginPaths(ctx, audit.brokenPluginPaths);

	const { unverifiable } = audit;
	if (unverifiable.length > 0 && !ctx.notify)
		ctx.say(
			`${unverifiable.length} plugin(s) could not be compared:\n` +
				unverifiable.map((u) => `  ${u}`).join("\n"),
		);
	return {
		compared: audit.compared,
		unverifiable,
		droppedHooks: audit.droppedHooks.length,
		brokenPluginPaths: audit.brokenPluginPaths.length,
	};
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit} audit
 * @param {string} cfg
 * @param {{ root: string, warnedSettings: Set<string> }} scope
 */
function auditConfigDir(ctx, audit, cfg, scope) {
	const { root, warnedSettings } = scope;
	const pluginsDir = path.join(cfg, "plugins");
	const installed = path.join(pluginsDir, "installed_plugins.json");
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(installed, "utf8"));
	} catch {
		return;
	}
	audit.manifests++;
	const enabledPlugins = readEnabledPluginsFor(ctx, cfg, warnedSettings);
	for (const [key, entries] of Object.entries(doc.plugins || {})) {
		const at = key.lastIndexOf("@");
		if (at <= 0) continue;
		const name = key.slice(0, at);
		const marketplace = key.slice(at + 1);
		const marketplaceDir = resolveMarketplaceDir(pluginsDir, marketplace);
		for (const entry of /** @type {any[]} */ (entries))
			auditInstall(audit, { key, name, marketplaceDir }, entry, {
				root,
				enabledPlugins,
			});
	}
}

/**
 * @param {ManifestAudit} audit
 * @param {{ key: string, name: string, marketplaceDir: string }} plugin
 * @param {any} entry
 * @param {{ root: string, enabledPlugins: Record<string, unknown> }} scope
 */
function auditInstall(audit, plugin, entry, scope) {
	const { key, name, marketplaceDir } = plugin;
	const { root, enabledPlugins } = scope;
	if (entry.scope === "project" && entry.projectPath !== root) return;
	const src = readPluginSource(marketplaceDir, name);
	if ("unverifiable" in src) {
		noteUnverifiable(audit, key, src);
		return;
	}
	const up = readUpstreamManifest(marketplaceDir, src.rel, entry.gitCommitSha);
	if ("unverifiable" in up) {
		noteUnverifiable(audit, key, up);
		return;
	}
	const cachedAt = path.join(entry.installPath, "hooks/hooks.json");
	const read = readText(cachedAt);
	if (read.state === "unreadable") {
		noteUnverifiable(audit, key, buildUnreadable(cachedAt, read.message));
		return;
	}
	const cached = read.state === "read" ? read.data : null;
	audit.compared++;
	if (enabledPlugins[key] === true) {
		collectDroppedHooks(audit.droppedHooks, key, up, {
			text: cached,
			at: cachedAt,
		});
		collectBrokenPluginPaths(
			audit.brokenPluginPaths,
			key,
			entry.installPath,
			cached,
		);
	}
	if (isSameManifest(cached, up.text)) return;
	audit.diverged.push({
		key,
		cachedAt,
		basis: up.basis,
		installPath: entry.installPath,
		cachedBytes: cached === null ? null : cached.length,
		upstreamBytes: up.text === null ? null : up.text.length,
		shape: divergenceShape(cached, up.text),
	});
}

/** @param {string} at @param {string} message */
const buildUnreadable = (at, message) => ({
	unverifiable: `${at} will not read: ${message}`,
	unreadable: /** @type {const} */ (true),
});

/**
 * @param {ManifestAudit} audit
 * @param {string} key
 * @param {{ unverifiable: string, unreadable?: boolean }} why
 */
function noteUnverifiable(audit, key, why) {
	audit.unverifiable.push(`${key} — ${why.unverifiable}`);
	if (why.unreadable) audit.unreadable++;
}

/**
 * @param {ManifestAudit["droppedHooks"]} out
 * @param {string} key
 * @param {{ text: string | null, basis: string }} up
 * @param {{ text: string | null, at: string }} cache
 */
function collectDroppedHooks(out, key, up, cache) {
	const { text: cached, at: cachedAt } = cache;
	const upTuples = up.text === null ? new Set() : hookTuples(up.text);
	const cachedTuples = cached === null ? new Set() : hookTuples(cached);
	for (const t of upTuples) {
		if (cachedTuples.has(t)) continue;
		const [event, , command] = t.split("\t");
		out.push({
			key,
			event,
			command,
			cachedAt,
			basis: up.basis,
		});
	}
}

/**
 * @param {ManifestAudit["brokenPluginPaths"]} out
 * @param {string} key
 * @param {string} installPath
 * @param {string | null} cached
 */
function collectBrokenPluginPaths(out, key, installPath, cached) {
	const cachedDoc =
		cached === null ? null : orFallback(() => JSON.parse(cached), null);
	for (const { event, hook } of wiredHooks(cachedDoc))
		for (const { rel, direct } of hookPaths(
			hook.command,
			hook.args,
			"CLAUDE_PLUGIN_ROOT",
		)) {
			const full = path.join(installPath, rel);
			const reason = hookPathFault(full, direct);
			if (reason)
				out.push({
					key,
					event,
					rel,
					full,
					reason,
				});
		}
}

/**
 * @param {string} full
 * @param {boolean} direct
 * @returns {HookPathFault | null}
 */
function hookPathFault(full, direct) {
	let st;
	try {
		st = fs.statSync(full);
	} catch {
		return "missing";
	}
	if (!st.isFile()) return "not-a-file";
	if (!direct) return null;
	try {
		fs.accessSync(full, fs.constants.X_OK);
	} catch {
		return "not-executable";
	}
	return null;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit["diverged"]} diverged
 */
function reportDiverged(ctx, diverged) {
	for (const d of diverged) {
		ctx.fail(
			"MANIFEST-DIVERGED",
			`${d.key} — ${d.shape}. The runtime reads the cache copy, so what the marketplace declares is not what runs.`,
			{
				plugin: d.key,
				installPath: d.installPath,
				basis: d.basis,
				cachedBytes: d.cachedBytes,
				upstreamBytes: d.upstreamBytes,
			},
		);
		ctx.say(
			`${d.key}: ${d.shape}\n` +
				`  cache:       ${d.cachedAt}\n` +
				`  marketplace: ${d.basis}\n` +
				"  The runtime wires the cache copy; an empty `hooks` object there is not an error path.\n" +
				`  Repair by reinstalling the plugin, or copy the marketplace file over ${d.cachedAt}.\n`,
		);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit["droppedHooks"]} droppedHooks
 */
function reportDroppedHooks(ctx, droppedHooks) {
	const dropKey = droppedHooks
		.map((d) => `${d.key}\t${d.event}\t${d.command}`)
		.sort()
		.join("\n");
	const saidDrop = saidBeforeElseQueue(ctx, "plugin-hook-drop", dropKey);
	if (saidDrop) return;
	for (const d of droppedHooks) {
		ctx.fail(
			"HOOK-DROPPED-IN-PACKAGING",
			`${d.key} ${d.event}: ${d.command} is wired in the marketplace's manifest (${d.basis}) but is absent from the installed manifest — dropped in packaging`,
			{
				plugin: d.key,
				event: d.event,
				command: d.command,
				cachedAt: d.cachedAt,
				basis: d.basis,
			},
		);
		ctx.say(
			`${d.key} ${d.event}: ${d.command} is dropped in packaging —\n` +
				`  wired upstream: ${d.basis}\n` +
				`  absent from:    ${d.cachedAt}\n` +
				"  This core expects that hook; nothing carried it into the installed manifest.\n",
		);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {ManifestAudit["brokenPluginPaths"]} brokenPluginPaths
 */
function reportBrokenPluginPaths(ctx, brokenPluginPaths) {
	const pathKey = brokenPluginPaths
		.map((b) => `${b.key}\t${b.event}\t${b.rel}\t${b.reason}`)
		.sort()
		.join("\n");
	const saidPath = saidBeforeElseQueue(ctx, "plugin-hook-path", pathKey);
	if (saidPath) return;
	for (const b of brokenPluginPaths) {
		const tag =
			b.reason === "not-executable"
				? "PLUGIN-HOOK-NOT-EXECUTABLE"
				: "PLUGIN-HOOK-PATH-MISSING";
		const message = buildBrokenPluginPathMessage(b);
		ctx.fail(tag, message, {
			plugin: b.key,
			event: b.event,
			path: b.rel,
			resolved: b.full,
		});
		ctx.say(`${message}\n  resolved: ${b.full}\n`);
	}
}

/**
 * @param {ManifestAudit["brokenPluginPaths"][number]} b
 * @returns {string}
 */
function buildBrokenPluginPathMessage(b) {
	if (b.reason === "not-executable")
		return `${b.key} ${b.event}: ${b.rel} is not executable under the plugin root, and the command runs it directly`;
	if (b.reason === "not-a-file")
		return `${b.key} ${b.event}: ${b.rel} is not a file under the plugin root`;
	return `${b.key} ${b.event}: ${b.rel} does not exist under the plugin root, so this plugin-hosted hook never runs`;
}

const INTERPRETER_RE = /^(node|sh|bash|dash|zsh|python(\d+(\.\d+)?)?)$/;

/**
 * @param {string} command
 * @param {string[] | string} [args]
 * @param {string} [rootVar]
 * @returns {Array<{ rel: string, direct: boolean }>}
 */
function hookPaths(command, args, rootVar = "CLAUDE_PROJECT_DIR") {
	/** @type {string[]} */
	let argv = [];
	if (typeof args === "string") argv = [args];
	else if (Array.isArray(args)) argv = args;
	const tokens = [...command.split(/\s+/), ...argv].filter(Boolean);
	/** @type {Array<{ rel: string, direct: boolean }>} */
	const out = [];
	let lastPathAt = -1;
	for (const [i, token] of tokens.entries()) {
		const rel = scriptRel(token, rootVar);
		if (!rel) continue;
		const j = precedingNonFlag(tokens, i);
		const prev = (tokens[j] || "").replace(/["']/g, "");
		const wrapped = j >= 0 && j === lastPathAt;
		lastPathAt = i;
		out.push({
			rel,
			direct: !wrapped && !INTERPRETER_RE.test(path.basename(prev)),
		});
	}
	return out;
}

/**
 * @param {string} token
 * @param {string} rootVar
 * @returns {string}
 */
function scriptRel(token, rootVar) {
	const bare = token.replace(/["']/g, "");
	const bareScripts =
		rootVar === "CLAUDE_PROJECT_DIR" && bare.startsWith("scripts/");
	if (!bare.includes(rootVar) && !bareScripts) return "";
	const rel = bare
		.replace(new RegExp(`^\\$\\{?${rootVar}\\}?/?`), "")
		.replace(/^\/+/, "");
	if (!rel || rel === "." || rel.includes("$")) return "";
	return rel;
}

/**
 * @param {string[]} tokens
 * @param {number} i
 * @returns {number}
 */
function precedingNonFlag(tokens, i) {
	let j = i - 1;
	let prevToken = tokens[j];
	while (prevToken !== undefined) {
		if (!prevToken.replace(/["']/g, "").startsWith("-")) break;
		prevToken = tokens[--j];
	}
	return j;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ checked: number, files: string[] }}
 */
function ownHooksAssertion(ctx) {
	let sources;
	try {
		sources = readOwnHookSources(repoRoot());
	} catch (e) {
		return ctx.broken(caught(e).message);
	}
	const named = sources.map((s) => ({
		file: path.relative(repoRoot(), s.file),
		hooks: s.settings?.hooks ?? {},
	}));
	let checked = 0;
	for (const { file, hooks } of named)
		for (const { event, ...hook } of flattenHooks(hooks))
			checked += checkOwnHook(ctx, { event, hook, file });
	return { checked, files: named.map((n) => n.file) };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ event: string, hook: import("./lib/core-hooks.js").Hook, file: string }} registered
 * @returns {number}
 */
function checkOwnHook(ctx, { event, hook, file }) {
	if (typeof hook.command !== "string") return 0;
	const args =
		typeof hook.args === "string" || Array.isArray(hook.args)
			? hook.args
			: undefined;
	let checked = 0;
	const command = toScriptsRel(hook.command);
	const named = [
		...hookPaths(command, args).map((p) => ({ ...p, root: repoRoot() })),
		...hookPaths(command, args, "CLAUDE_PLUGIN_ROOT").map((p) => ({
			...p,
			root: selfPluginRoot(repoRoot()),
		})),
	];
	for (const { rel, direct, root } of named) {
		checked++;
		const fault = hookPathFault(path.join(root, rel), direct);
		if (fault)
			reportOwnPathFault(
				ctx,
				{ event, rel, command: hook.command, file },
				fault,
			);
	}
	return checked;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ event: string, rel: string, command: string, file: string }} hookPath
 * @param {HookPathFault} fault
 */
function reportOwnPathFault(ctx, hookPath, fault) {
	const { event, rel, command, file } = hookPath;
	if (fault === "missing") {
		ctx.fail(
			"HOOK-PATH-MISSING",
			`${event}: ${rel} does not exist, so this hook never runs`,
			{ event, path: rel, command },
		);
		ctx.say(
			`${event}: ${rel} does not exist — the hook is wired to nothing.\n` +
				`  Restore the file, or drop its entry from ${file}.`,
		);
		return;
	}
	if (fault === "not-a-file") {
		ctx.fail("HOOK-PATH-MISSING", `${event}: ${rel} is not a file`, {
			event,
			path: rel,
			command,
		});
		ctx.say(`${event}: ${rel} is not a file.`);
		return;
	}
	ctx.fail(
		"HOOK-NOT-EXECUTABLE",
		`${event}: ${rel} is not executable, and the command runs it directly`,
		{ event, path: rel, command },
	);
	ctx.say(`${event}: ${rel} is not executable — fix with  chmod +x ${rel}`);
}

const REAP_RUN_FILE = "wfc-reap-run.json";

// guess, #5622: room over the reaper's 10 × 15 s stop cap
const REAP_INFLIGHT_MS = 300_000;

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ checked: number, unfinished: number, chronic: number } | { unavailable: string }}
 */
function reapAssertion(ctx) {
	/** @type {Array<{at: string, mode: string, startedAt: string, ageMs: number}>} */
	const open = [];
	/** @type {Array<{at: string, mode: string, deaths: number, startedAt: string}>} */
	const chronic = [];
	const read = [];
	/** @type {UnreadableRecord[]} */
	const unreadable = [];

	for (const cfg of configDirs()) {
		const at = path.join(cfg, REAP_RUN_FILE);
		const { doc, unreadable: skipped } = readRunRecord(at, "mode");
		if (skipped) unreadable.push(skipped);
		if (!doc) continue;
		read.push(at);
		for (const [mode, row] of Object.entries(doc)) {
			const sorted = classifyReapRow(at, mode, row);
			if (sorted.chronic) chronic.push(sorted.chronic);
			if (sorted.open) open.push(sorted.open);
		}
	}

	reportUnreadableRecords(
		ctx,
		{
			which: "reap-record",
			tag: "REAP-RECORD-UNREADABLE",
			consequence: "so a reap that died mid-run cannot be seen here",
		},
		unreadable,
	);

	const openKey = open
		.map((o) => `${o.at}\t${o.mode}`)
		.sort()
		.join("\n");
	const said = saidBeforeElseQueueUnlessUnread(
		ctx,
		"reap",
		openKey,
		unreadable,
	);

	const chronicKey = chronic
		.map((c) => `${c.at}\t${c.mode}`)
		.sort()
		.join("\n");
	const saidChronic = saidBeforeElseQueueUnlessUnread(
		ctx,
		"reap-chronic",
		chronicKey,
		unreadable,
	);

	if (read.length === 0 && unreadable.length === 0)
		return {
			unavailable: `no ${REAP_RUN_FILE} under any config dir on this machine`,
		};

	reportUnfinishedReaps(ctx, open, said);
	reportChronicReaps(ctx, chronic, saidChronic);

	return {
		checked: read.length,
		unfinished: open.length,
		chronic: chronic.length,
	};
}

/**
 * @typedef {{at: string, why: string, unread: boolean}} UnreadableRecord
 */

/**
 * @param {string} at
 * @param {string} keyedBy
 * @returns {{ doc: Record<string, any> | null, unreadable: UnreadableRecord | null }}
 */
function readRunRecord(at, keyedBy) {
	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(at, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT" && code !== "ENOTDIR")
			return {
				doc: null,
				unreadable: { at, why: message, unread: true },
			};
		return { doc: null, unreadable: null };
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc))
		return {
			doc: null,
			unreadable: {
				at,
				why: `it parsed to ${Array.isArray(doc) ? "an array" : typeof doc}, not an object keyed by ${keyedBy}`,
				unread: false,
			},
		};
	return { doc, unreadable: null };
}

/**
 * @param {string} at
 * @param {string} mode
 * @param {any} row
 * @returns {{ open: {at: string, mode: string, startedAt: string, ageMs: number} | null, chronic: {at: string, mode: string, deaths: number, startedAt: string} | null }}
 */
function classifyReapRow(at, mode, row) {
	const neither = { open: null, chronic: null };
	if (!row) return neither;
	if (row.finishedAt) return neither;
	if (typeof row.startedAt !== "string") return neither;
	const chronic =
		mode === "live" &&
		Number.isFinite(row.deaths) &&
		row.deaths >= REAP_LIVE_DEATHS_TO_REPORT
			? { at, mode, deaths: row.deaths, startedAt: row.startedAt }
			: null;
	const startedMs = Date.parse(row.startedAt);
	if (!Number.isFinite(startedMs)) return { open: null, chronic };
	const ageMs = Date.now() - startedMs;
	if (ageMs < REAP_INFLIGHT_MS) return { open: null, chronic };
	return { open: { at, mode, startedAt: row.startedAt, ageMs }, chronic };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ which: string, tag: string, consequence: string }} kind
 * @param {UnreadableRecord[]} unreadable
 */
function reportUnreadableRecords(ctx, kind, unreadable) {
	const { which, tag, consequence } = kind;
	const saidUnreadable = saidBeforeElseQueue(
		ctx,
		which,
		unreadable
			.map((u) => u.at)
			.sort()
			.join("\n"),
	);
	for (const u of unreadable) {
		const message = `${u.at} could not be read — ${u.why}, ${consequence}`;
		ctx.warn(tag, message, { file: u.at });
		if (!saidUnreadable && !ctx.inActions) ctx.say(message);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} which
 * @param {string} key
 * @param {UnreadableRecord[]} unreadable
 */
function saidBeforeElseQueueUnlessUnread(ctx, which, key, unreadable) {
	return key || !unreadable.some((u) => u.unread)
		? saidBeforeElseQueue(ctx, which, key)
		: false;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<{at: string, mode: string, startedAt: string, ageMs: number}>} open
 * @param {boolean} said
 */
function reportUnfinishedReaps(ctx, open, said) {
	for (const o of open) {
		const mins = Math.round(o.ageMs / 60_000);
		const message = `the ${o.mode} reap recorded in ${o.at} started ${o.startedAt} (${mins} min ago) and never finished`;
		ctx.warn("REAP-UNFINISHED", message, {
			file: o.at,
			mode: o.mode,
			startedAt: o.startedAt,
		});
		if (!said && !ctx.inActions)
			ctx.say(
				`${message} —\n` +
					"  it was cancelled or died mid-run, so any session it should have stopped is still resident\n" +
					"  and pick-next is admitting against memory that is not really spent.\n" +
					`  Run it by hand with no timeout on it:  node ${scriptPath("reap-finished-sessions.js")}${o.mode === "dry" ? " --dry-run" : ""}`,
			);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<{at: string, mode: string, deaths: number, startedAt: string}>} chronic
 * @param {boolean} saidChronic
 */
function reportChronicReaps(ctx, chronic, saidChronic) {
	for (const c of chronic) {
		const message = `the ${c.mode} reap recorded in ${c.at} has opened a record and failed to close it on ${c.deaths} consecutive session starts (most recently ${c.startedAt})`;
		ctx.warn("REAP-LIVE-CANCELLED", message, {
			file: c.at,
			mode: c.mode,
			deaths: c.deaths,
			startedAt: c.startedAt,
		});
		if (!saidChronic && !ctx.inActions)
			ctx.say(
				`${message} —\n` +
					"  every session start reopens it before this checker can read the age of the one it\n" +
					"  cancelled, so a single row never ages into the check above; this counts the reopens\n" +
					"  instead. Any session it should have stopped is still resident, and pick-next is\n" +
					"  admitting against memory that is not really spent.\n" +
					`  Run it by hand with no timeout on it:  node ${scriptPath("reap-finished-sessions.js")}`,
			);
	}
}

const {
	DEATHS_TO_REPORT,
	RUN_FILE: DETACHED_RUN_FILE,
	JOB_PRUNE_MARKERS,
	JOB_RETIRE_STALE_CONTAINERS,
} = detachedRun;

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {{ checked: number, dead: number } | { unavailable: string }}
 */
function detachedAssertion(ctx) {
	/** @type {Array<{at: string, job: string, deaths: number, lastFinishedAt: string}>} */
	const dead = [];
	const read = [];
	/** @type {UnreadableRecord[]} */
	const unreadable = [];

	for (const cfg of configDirs()) {
		const at = path.join(cfg, DETACHED_RUN_FILE);
		const { doc, unreadable: skipped } = readRunRecord(at, "job");
		if (skipped) unreadable.push(skipped);
		if (!doc) continue;
		read.push(at);
		collectDeadJobs(at, doc, dead);
	}

	reportUnreadableRecords(
		ctx,
		{
			which: "detached-record",
			tag: "DETACHED-RECORD-UNREADABLE",
			consequence:
				"so a detached session-start child that died cannot be seen here",
		},
		unreadable,
	);

	const deadKey = dead
		.map((d) => `${d.at}\t${d.job}`)
		.sort()
		.join("\n");
	const said = saidBeforeElseQueueUnlessUnread(
		ctx,
		"detached",
		deadKey,
		unreadable,
	);

	if (read.length === 0 && unreadable.length === 0)
		return {
			unavailable: `no ${DETACHED_RUN_FILE} under any config dir on this machine`,
		};

	reportDeadJobs(ctx, dead, said);

	return { checked: read.length, dead: dead.length };
}

/**
 * @param {string} at
 * @param {Record<string, any>} doc
 * @param {Array<{at: string, job: string, deaths: number, lastFinishedAt: string}>} dead
 */
function collectDeadJobs(at, doc, dead) {
	for (const [job, row] of Object.entries(doc)) {
		if (!row) continue;
		const deaths = Number(row.deaths);
		if (!Number.isFinite(deaths) || deaths < DEATHS_TO_REPORT) continue;
		dead.push({
			at,
			job,
			deaths,
			lastFinishedAt:
				typeof row.lastFinishedAt === "string"
					? row.lastFinishedAt
					: "never recorded",
		});
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Array<{at: string, job: string, deaths: number, lastFinishedAt: string}>} dead
 * @param {boolean} said
 */
function reportDeadJobs(ctx, dead, said) {
	for (const d of dead) {
		const message = `the detached ${d.job} recorded in ${d.at} has opened a record and failed to return on ${d.deaths} consecutive session starts (last completed: ${d.lastFinishedAt})`;
		ctx.warn("DETACHED-DEAD", message, {
			file: d.at,
			job: d.job,
			deaths: d.deaths,
		});
		if (!said && !ctx.inActions)
			ctx.say(
				`${message} —\n` +
					"  it is spawned detached and its launching hook returns 0 whatever it does, so nothing else reports this.\n" +
					"  Run it in the foreground, where its error is on the page:\n" +
					`  ${
						DETACHED_HOW[/** @type {keyof typeof DETACHED_HOW} */ (d.job)] ||
						"(unknown job — check scripts/lib/detached-run.js's JOBS)"
					}\n` +
					"  RUNNING IT CLOSES THE ROW, AND THE NEXT SESSION START WILL READ deaths AS 0\n" +
					"  REGARDLESS OF WHAT IT PRINTS (scripts/lib/detached-run.js's openRun) — read\n" +
					"  what it prints before deciding anything is fixed, because doing this\n" +
					"  silences the finding either way.",
			);
	}
}

/** @type {Record<(typeof detachedRun.JOBS)[number], string>} */
const DETACHED_HOW = {
	[JOB_PRUNE_MARKERS]: buildArbiterCommand`prune-markers`,
	[JOB_RETIRE_STALE_CONTAINERS]: `node ${scriptPath("retire-stale-containers.js")} --dry-run`,
};

/**
 * @typedef {{ name: string, run: (ctx: import("./lib/check").Ctx, days: number, budgetMs: number) => any, part: (r: any) => string }} Assertion
 */

/**
 * @type {Assertion}
 */
const OWN_HOOKS_ASSERTION = {
	name: "self-plugin",
	run: (ctx) => ownHooksAssertion(ctx),
	part: (r) => `${r.checked} ${r.files.join(" and ")} hook path(s) resolved`,
};

/** @type {Map<string, Assertion>} */
const ASSERTIONS = new Map(
	/** @type {Assertion[]} */ ([
		{
			name: "census",
			run: (ctx, days, budgetMs) => censusAssertion(ctx, days, budgetMs),
			part: (r) =>
				`${r.covered} of ${r.total} transcript file(s) accounted for (${r.scanned} read this run)`,
		},
		{
			name: "manifest",
			run: (ctx) => manifestAssertion(ctx),
			part: (r) => `${r.compared} plugin manifest(s) compared`,
		},
		{
			name: "reap",
			run: (ctx) => reapAssertion(ctx),
			part: (r) => `${r.checked} reap run record(s) read`,
		},
		{
			name: "detached",
			run: (ctx) => detachedAssertion(ctx),
			part: (r) => `${r.checked} detached run record(s) read`,
		},
		OWN_HOOKS_ASSERTION,
	]).map((a) => [a.name, a]),
);

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {string[]}
 */
function wantedAssertions(ctx) {
	const only = ctx.value("--only", "");
	if (
		only &&
		!["census", "manifest", "self-plugin", "reap", "detached"].includes(only)
	)
		ctx.usageError(
			`--only takes census, manifest, self-plugin, reap or detached, not ${only}.`,
		);
	if (only) return [only];
	if (ctx.notify) return ["census", "manifest", "reap", "detached"];
	return ["census", "manifest", "reap", "detached", "self-plugin"];
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} which
 * @param {{ days: number, budgetMs: number, data: Record<string, unknown>, parts: string[], unavailable: string[] }} run
 */
function runAssertion(ctx, which, run) {
	const assertion = ASSERTIONS.get(which) ?? OWN_HOOKS_ASSERTION;
	const r = assertion.run(ctx, run.days, run.budgetMs);
	run.data[assertion.name] = r;
	if ("unavailable" in r)
		run.unavailable.push(`${assertion.name} — ${r.unavailable}`);
	else run.parts.push(assertion.part(r));
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {string}
 */
function findingNoun(ctx) {
	const tags = new Set(ctx.findings.map((f) => f.tag));
	if (tags.size === 1)
		for (const [tag, noun] of ONLY_TAG_NOUNS) if (tags.has(tag)) return noun;
	return "hook that is wired and not running";
}

/**
 * @type {Array<[string, string]>}
 */
const ONLY_TAG_NOUNS = [
	["CORPUS-UNREADABLE", "config dir the census could not read"],
	["REAP-RECORD-UNREADABLE", "reap run record that could not be read"],
	["DETACHED-RECORD-UNREADABLE", "detached run record that could not be read"],
	[
		"DETACHED-DEAD",
		"detached session-start child that has stopped coming back",
	],
];

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "hook-liveness",
	usage:
		"node check-hook-liveness.js [--days <n>] [--budget-ms <n>] [--only <census|manifest|self-plugin|reap|detached>] [--notify]",
	valueFlags: ["--days", "--only", "--budget-ms"],
	run(ctx) {
		const days = ctx.numberValue("--days", DEFAULT_DAYS, "positive");
		const budgetMs = ctx.numberValue(
			"--budget-ms",
			DEFAULT_BUDGET_MS,
			"positive",
		);

		const budgetAfter = process.env[BUDGET_AFTER_ENV];
		if (budgetAfter && !/^\d+$/.test(budgetAfter))
			ctx.usageError(
				`${BUDGET_AFTER_ENV} must be a whole number of files, not ${budgetAfter}.`,
			);

		const want = wantedAssertions(ctx);

		/** @type {string[]} */
		const parts = [];
		/** @type {Record<string, unknown>} */
		const data = {};
		try {
			/** @type {string[]} */
			const unavailable = [];
			for (const which of want)
				runAssertion(ctx, which, { days, budgetMs, data, parts, unavailable });

			for (const u of unavailable)
				if (!ctx.notify) ctx.say(`assertion not run: ${u}`);

			if (parts.length === 0)
				ctx.skip(unavailable.join("; ") || "nothing to check.");

			const noun = findingNoun(ctx);
			const stamps = Object.fromEntries(pendingStamps);
			return {
				okLine: `every wired hook accounted for — ${parts.join(", ")}.`,
				noun,
				data: { ...data, unavailable },
				stamps,
			};
		} finally {
			flushStamps(ctx);
		}
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
