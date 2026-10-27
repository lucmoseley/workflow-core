#!/usr/bin/env node
/*
 * check-orphaned-edits.js — report an ORPHANED EDIT (GLOSSARY.md): a tracked
 * file with uncommitted changes that no live session claims, observes or has
 * in its write ledger, unchanged for at least 24 hours — and file each one
 * once as a `takes:triage` issue.
 *
 * Usage:  npm run check:orphaned-edits  [--hours <n>] [--notify] [--json]
 *
 * WHY (#810, the spec; #794 Q2, Q5–Q7, the rulings). An uncommitted edit in the
 * shared tree enters every suite run that reads the shared tree rather than a
 * worktree at HEAD (#812), and voids every certificate whose read closure it
 * touches (#787).
 *
 * TWO RUNS (#813, #2038): at SessionStart it files and prints nothing, and
 * `npm run status` runs it by hand for the report.
 *
 * LIVE MEANS LISTED BY THE ORACLE AND NOT TERMINAL (`isListedLive`): a finished
 * background session never commits its edit, so its ledger holds nothing back.
 * `sweepSessionIds`, not `listedSessionIds`, because at SessionStart the
 * starting session is not yet listed and the strict reader would refuse.
 * The oracle runs only once some dirty file is old enough to judge.
 *
 * WHERE OWNERSHIP CANNOT BE READ — an oracle that will not vouch, a lock or
 * observation store that will not open, a live session's ledger that will not
 * read — NOTHING IS REPORTED: SKIP. RESIDUAL: one lock
 * FILE that will not parse names no path, so it is passed over, as
 * `lib/neighbour-dirt.js`'s `readClaimedElsewhere` passes it; the holder's ledger
 * still excludes the file.
 *
 * FILED ONCE PER PATH AND BLOB. The blob is `git hash-object` of the working
 * copy. Each filing first creates its own marker, exclusively, under
 * `orphaned-edits-filed/` in the git common dir, which every worktree shares —
 * so two sessions starting together cannot both file one orphan. A failed
 * filing deletes its marker and is retried at the next run. A filing that
 * timed out, or a run killed mid-filing, leaves its marker empty: reported as
 * interrupted and never retried, because it may have filed. RESIDUAL: the markers are per machine,
 * so a second machine sharing the tracker files its own copy.
 *
 * IT FILES ISSUES THOUGH IT IS A `check-*`, departing from the family split
 * (`docs/code-standards-base.md` §N3, where filing is `report-*`'s): #813 rules one
 * checker that reports and files, and filing never moves its outcome off WARN.
 *
 * WFC_ORPHAN_FILER replaces `file-issue.js` — the test seam.
 *
 * A DELETED FILE IS NOT JUDGED: it has no mtime, so "unchanged for 24 hours"
 * cannot be read. Counted in `deleted`.
 *
 * IMPLICIT:  at every session start, files each uncommitted tracked file no live session owns and nobody has touched for 24 hours once as a takes:triage issue, printing nothing. It never reverts or writes the file.
 * JUSTIFIED: fail-safe — an orphan voids certificates for days unseen, and any ownership signal that cannot be read silences the report rather than calling a live session's edit orphaned.
 * DEFEAT:    none at the hook; --hours <n> moves the threshold on a hand run.
 */

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { brokenError, runCheck } = require("./lib/check");
const { readDirtyTracked, gitRead, shellWord } = require("./lib/dirty-tree.js");
const { gitCommonDir, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { readDistinctFromHint } = require("./lib/similar-titles.js");
const { isListedLive, sweepSessionIds } = require("./lib/agent-liveness");
const proc = require("./lib/arbiter-proc");
const store = require("./lib/arbiter-store");
const { caught } = require("./lib/caught.js");
const { takesLabel } = require("./lib/takes-label.js");

const ORPHAN_LABEL = takesLabel("triage");

/* The threshold #794's rulings set. */
const ORPHAN_AFTER_HOURS = 24;

/* How many new filings one run makes, each a few `gh` calls inside a
 * SessionStart hook's timeout. A guess, not a measurement; the rest are filed
 * at the next run. */
const MAX_FILED_PER_RUN = 2;

/* Two filings at this ceiling stay inside the hook's 60-second timeout. */
const FILER_TIMEOUT_MS = 25_000;

const FILED_DIR = "orphaned-edits-filed";

/**
 * @typedef {object} Orphan
 * @property {string} path
 * @property {number} ageHours
 * @property {string} writer  the last known writer, as printed
 * @property {string} blob    the working copy's blob id, or "unknown"
 * @property {string} filed   what became of its triage issue, as printed
 */

const filerPath = () =>
	process.env.WFC_ORPHAN_FILER || path.join(__dirname, "file-issue.js");

/** @param {number} hours */
function describeAge(hours) {
	if (hours < 48) return `${Math.floor(hours)}h`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * The marker directory, made if missing — or null where git names no common
 * dir or it will not be made, and then nothing is filed: a filing with no
 * marker could repeat at every session start.
 * @param {string} root
 */
function filedDir(root) {
	const common = gitCommonDir(root, { timeout: GIT_TIMEOUT_MS });
	if (!common) return null;
	const dir = path.join(common, FILED_DIR);
	try {
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return null;
	}
}

/**
 * Take the filing of `o` by creating its marker exclusively. "taken" means
 * this run files it; otherwise the marker's state, as printed.
 * @param {string} dir
 * @param {Orphan} o
 * @returns {{taken: string|null, status: string}}
 */
function takeFiling(dir, o) {
	const key = createHash("sha256")
		.update(`${o.path}\0${o.blob}`)
		.digest("hex")
		.slice(0, 32);
	const marker = path.join(dir, `${key}.json`);
	try {
		fs.closeSync(fs.openSync(marker, "wx"));
		return { taken: marker, status: "" };
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "EEXIST")
			return { taken: null, status: `not filed: ${message}` };
	}
	let ref = "";
	try {
		ref = JSON.parse(fs.readFileSync(marker, "utf8")).ref ?? "";
	} catch {
		// Empty or torn: the filing that made it is running or was killed.
	}
	return {
		taken: null,
		status: ref
			? `already filed: ${ref}`
			: "filing in progress or interrupted — search the tracker before filing by hand",
	};
}

/**
 * Every path a live session owns by claim, observation or ledger — or a
 * sentence saying why that cannot be read.
 * @returns {{owned: Set<string>, why?: undefined, names: Map<string, string>} | {why: string, owned?: undefined, names?: undefined}}
 */
function readOwnedByLive() {
	const locks = store.readLocks();
	if (locks === null) return { why: "the arbiter's lock store would not read" };
	const held = heldLockPaths(locks);

	const listed = sweepSessionIds();
	if (!listed.ids) return { why: listed.why };
	const live = readLiveSessionPaths(listed);
	if (live.paths === undefined) return { why: live.why };
	const owned = new Set([...held, ...live.paths]);
	return { owned, names: listed.names };
}

/**
 * @param {any[]} locks
 * @returns {string[]} the path of every lock a live holder has
 */
function heldLockPaths(locks) {
	/** @type {string[]} */
	const paths = [];
	for (const lock of locks) {
		if (!lock || lock.unreadable) continue;
		if (proc.holderAlive(lock)) paths.push(store.subjectPath(lock.path));
	}
	return paths;
}

/**
 * Every path a live listed session observes or has in its ledger — or why
 * one of those stores would not read.
 * @param {any} listed
 * @returns {{paths: string[], why?: undefined} | {why: string, paths?: undefined}}
 */
function readLiveSessionPaths(listed) {
	/** @type {string[]} */
	const paths = [];
	for (const id of listed.ids) {
		if (!isListedLive(id, listed.ids, listed.terminal)) continue;
		const observed = store.readObservedBy(id);
		if (observed === null)
			return { why: "the arbiter's observation store would not read" };
		for (const rel of observed) paths.push(store.subjectPath(rel));
		const written = store.readWritesBy(id);
		if (written === null)
			return { why: `session ${id}'s write ledger would not read` };
		for (const rel of written) paths.push(rel);
	}
	return { paths };
}

/** @param {Orphan} o */
function buildCommands(o) {
	const p = shellWord(o.path);
	return {
		inspect: `git diff HEAD -- ${p}`,
		commit: `git commit -m "<why, in plain language>" -- ${p}`,
		revert: `git restore --source=HEAD --staged --worktree -- ${p}`,
	};
}

/**
 * File one orphan through the filer. Returns the filer's last stdout line on
 * success, or null with the failure in `error` and, in `mayHaveFiled`,
 * whether the filer died before it could say.
 * @param {Orphan} o
 * @param {string} root
 */
function fileOne(o, root) {
	const c = buildCommands(o);
	const body = [
		"## What",
		"",
		`\`${o.path}\` has uncommitted changes that no live session claims, observes or has in its write ledger, unchanged for ${describeAge(o.ageHours)} (an **Orphaned edit**, \`GLOSSARY.md\`). Reported by \`scripts/check-orphaned-edits.js\` at session start (#813).`,
		"",
		`- Last known writer: ${o.writer}`,
		`- Working-copy blob: \`${o.blob}\``,
		"",
		"It enters every suite run that reads the shared tree, rather than a worktree at HEAD, and voids each certificate whose read closure it touches (#810). Nothing has been reverted.",
		"",
		"## Decide",
		"",
		"Read the diff, then commit it or revert it:",
		"",
		"```",
		`${c.inspect}`,
		`${c.commit}`,
		`${c.revert}`,
		"```",
		"",
		"The revert destroys the edit — run it only after reading the diff.",
	].join("\n");
	const args = [
		filerPath(),
		"--title",
		`Orphaned edit: ${o.path} (blob ${o.blob.slice(0, 10)})`,
		"--label",
		ORPHAN_LABEL,
		"--standalone",
		"cross-cutting: an orphaned edit has no single originating issue (#813)",
		"--body-file",
		"-",
	];
	const spawnFiler = (/** @type {string[]} */ a) =>
		spawnSync(process.execPath, a, {
			cwd: root,
			input: body,
			encoding: "utf8",
			timeout: FILER_TIMEOUT_MS,
		});
	let res = spawnFiler(args);
	/* The marker, per path and blob, is this filer's duplicate check, so it
	 * names every similar title file-issue.js lists as distinct (#1073). */
	const hint = res.status === 2 ? readDistinctFromHint(res.stderr || "") : null;
	if (hint) res = spawnFiler([...args, "--distinct-from", hint]);
	if (res.status === 0)
		return {
			ref: (res.stdout || "").trim().split("\n").pop() || "filed",
			error: null,
			mayHaveFiled: true,
		};
	const why =
		res.error?.message ||
		(res.stderr || "").trim().split("\n").pop() ||
		`exit ${String(res.status)}`;
	/* Killed by the timeout or a signal, the create may have landed. */
	return { ref: null, error: why, mayHaveFiled: res.status === null };
}

/**
 * Sort the dirty files by age: those at least `hours` old, the count younger,
 * and the count deleted.
 * @param {string} root
 * @param {string[]} dirty
 * @param {{hours: number, now: number}} opts
 */
function sortByAge(root, dirty, { hours, now }) {
	const old = [];
	let young = 0;
	let deleted = 0;
	for (const rel of dirty) {
		let mtimeMs;
		try {
			mtimeMs = fs.statSync(path.join(root, rel)).mtimeMs;
		} catch {
			deleted++;
			continue;
		}
		const ageHours = (now - mtimeMs) / 3_600_000;
		if (ageHours < hours) young++;
		else old.push({ path: rel, ageHours });
	}
	return { old, young, deleted };
}

/**
 * @param {string} rel
 * @param {Map<string, string>} names
 * @param {number} now
 */
function describeWriter(rel, names, now) {
	const w = store.readLastWriterOf(rel);
	if (!w) return "unknown — no surviving write ledger names it";
	const name = names.get(w.sessionId);
	return `session ${w.sessionId}${name ? ` (${name})` : ""}, ledger last written ${describeAge((now - w.at) / 3_600_000)} ago`;
}

/**
 * The old files no live session owns, each with its writer and blob — or a
 * SKIP where ownership cannot be read.
 * @param {any} ctx
 * @param {{path: string, ageHours: number}[]} old
 * @param {{root: string, hours: number, now: number}} opts
 * @returns {Orphan[]}
 */
function findOrphans(ctx, old, { root, hours, now }) {
	/** @type {Orphan[]} */
	const orphans = [];
	if (old.length === 0) return orphans;
	const live = readOwnedByLive();
	// Who owns a file is the subject asked about, not the apparatus: SKIP (§N4, #1240).
	if (!live.owned)
		ctx.skip(
			`${String(old.length)} uncommitted file(s) are over ${String(hours)}h old, but ${live.why}, so whether a live session owns them is unknown.`,
		);
	const { owned, names } =
		/** @type {{owned: Set<string>, names: Map<string, string>}} */ (live);
	for (const o of old) {
		if (owned.has(o.path)) continue;
		const writer = describeWriter(o.path, names, now);
		const blob =
			gitRead(["hash-object", "--", o.path], root)?.trim() || "unknown";
		orphans.push({ ...o, writer, blob, filed: "" });
	}
	return orphans;
}

/**
 * Take the marker for `o`, or say why it cannot be filed.
 * @param {Orphan} o
 * @param {string|null} dir
 * @returns {{taken: string} | {taken: null, filed: string}}
 */
function takeOrphanMarker(o, dir) {
	if (o.blob === "unknown")
		return { taken: null, filed: "not filed: its blob could not be read" };
	if (dir === null)
		return {
			taken: null,
			filed:
				"not filed: no marker directory in the git common dir, so a filing could repeat",
		};
	const { taken, status } = takeFiling(dir, o);
	return taken === null ? { taken, filed: status } : { taken };
}

/**
 * @param {Orphan} o
 * @param {string} taken
 * @param {{root: string, now: number}} opts
 * @returns {string} the outcome, for `o.filed`
 */
function fileUnderMarker(o, taken, { root, now }) {
	const res = fileOne(o, root);
	if (res.ref === null && res.mayHaveFiled)
		return `filing interrupted, not retried — search the tracker: ${res.error}`;
	if (res.ref === null) {
		fs.rmSync(taken, { force: true });
		return `filing failed, retried next run: ${res.error}`;
	}
	try {
		fs.writeFileSync(
			taken,
			`${JSON.stringify({ path: o.path, blob: o.blob, ref: res.ref, at: now })}\n`,
		);
	} catch (e) {
		// Its marker exists, so it is still never filed twice (#813).
		return `${res.ref} (issue reference not recorded: ${caught(e).message})`;
	}
	return res.ref;
}

/**
 * File each orphan once, up to this run's cap.
 * @param {Orphan[]} orphans
 * @param {{root: string, now: number}} opts
 * @returns {{filings: number, orphans: Orphan[]}} how many filings ran, and
 *   each orphan with its `filed` outcome
 */
function fileOrphans(orphans, { root, now }) {
	const dir = orphans.length > 0 ? filedDir(root) : null;
	let filings = 0;
	/** @type {Orphan[]} */
	const triaged = [];
	for (const o of orphans) {
		const marker = takeOrphanMarker(o, dir);
		if (marker.taken === null) {
			triaged.push({ ...o, filed: marker.filed });
			continue;
		}
		const { taken } = marker;
		if (filings >= MAX_FILED_PER_RUN) {
			fs.rmSync(taken, { force: true });
			triaged.push({
				...o,
				filed: "not filed yet: this run's filing cap is spent",
			});
			continue;
		}
		filings++;
		triaged.push({ ...o, filed: fileUnderMarker(o, taken, { root, now }) });
	}
	return { filings, orphans: triaged };
}

/**
 * @param {any} ctx
 * @param {Orphan[]} orphans
 * @param {number} hours
 */
function reportOrphans(ctx, orphans, hours) {
	for (const o of orphans)
		ctx.warn(
			"ORPHANED-EDIT",
			`${o.path} — uncommitted, unchanged ${describeAge(o.ageHours)}, no live session owns it`,
			{ ...o, ...buildCommands(o) },
		);

	if (orphans.length === 0) return;
	ctx.say(
		`ORPHANED-EDIT (${String(orphans.length)}) — uncommitted, unchanged over ${String(hours)}h, owned by no live session:`,
	);
	for (const o of orphans) {
		const c = buildCommands(o);
		ctx.say(
			`  ${o.path} — unchanged ${describeAge(o.ageHours)}\n` +
				`    last known writer: ${o.writer}\n` +
				`    inspect: ${c.inspect}\n` +
				`    commit:  ${c.commit}\n` +
				`    revert:  ${c.revert}\n` +
				`    triage:  ${o.filed}`,
		);
	}
	ctx.say(
		"\n  Nothing was reverted. Each voids the certificates whose read closure it\n" +
			"  touches until it is committed or reverted. Read the diff first: the\n" +
			"  revert destroys the edit.\n",
	);
}

runCheck({
	name: "orphaned-edits",
	usage: "node check-orphaned-edits.js [--hours <n>] [--notify] [--json]",
	valueFlags: ["--hours"],
	run(ctx) {
		const hours = ctx.numberValue(
			"--hours",
			ORPHAN_AFTER_HOURS,
			"non-negative",
		);

		const root = hostRoot();
		const dirty = readDirtyTracked(root);
		// git is the apparatus here, not the subject: BROKEN (§N4).
		if (dirty === null)
			throw brokenError(
				"git status would not answer, so what is uncommitted is unknown.",
			);
		const now = Date.now();

		const { old, young, deleted } = sortByAge(
			root,
			/** @type {string[]} */ (dirty),
			{ hours, now },
		);

		const found = findOrphans(ctx, old, { root, hours, now });

		found.sort((a, b) => b.ageHours - a.ageHours);

		const { filings, orphans } = fileOrphans(found, { root, now });

		if (!ctx.notify) reportOrphans(ctx, orphans, hours);

		return {
			okLine: `no orphaned edit over ${String(hours)}h among ${String(/** @type {string[]} */ (dirty).length)} uncommitted file(s).`,
			noun: "orphaned edit(s)",
			data: {
				orphans,
				orphanCount: orphans.length,
				young,
				deleted,
				filings,
				thresholdHours: hours,
			},
		};
	},
});
