#!/usr/bin/env node
/*
 * check-orphaned-edits.js — report an ORPHANED EDIT (GLOSSARY.md): a tracked
 * file with uncommitted changes that no live session claims, observes or has
 * in its write ledger, unchanged for at least 24 hours — and file each one
 * once as a `takes:triage` issue.
 *
 * Usage:  npm run check:orphaned-edits  [--hours <n>] [--notify] [--json] [--write] [--hourly]
 *
 * WHY (#810, the spec; #794 Q2, Q5–Q7, the rulings). An uncommitted edit in the
 * main checkout enters every suite run that reads it rather than a
 * worktree at HEAD (#812), and voids every certificate whose read closure it
 * touches (#787).
 *
 * TWO RUNS (#813, #2038, #4449): at SessionStart, under `--write`, it files
 * and prints nothing, and `npm run status` runs it by hand for the report.
 * The SessionStart run is async and passes `--hourly` (#4367): it runs at
 * most once a clock hour across the repository's worktrees, because the walk
 * costs 9–14 s and grows with the worktree count. The throttle delays a
 * filing by an hour at most. A run without `--hourly` always runs.
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
 * FILED ONCE PER PATH AND BLOB IN THE MAIN CHECKOUT, ONCE PER WORKTREE AND
 * STATE IN A LINKED ONE (#4439): a dead worktree's files carry one decision,
 * commit or discard it, so they share one issue, keyed by every orphan's path
 * and blob together, so a change to any of them refiles once, naming the
 * issue it supersedes. It waits while any file there is under the threshold,
 * so files aging on different days still make one issue. That issue says
 * which of them are already on `origin/main` (lib/landed-edit.js), and,
 * where all are, the worktree holds nothing else uncommitted and its `HEAD`
 * no commit off it, names removing the worktree as the remedy. The blob is
 * `git hash-object` of the working copy. Each filing first creates its own
 * marker, exclusively, under `orphaned-edits-filed/` in the git common dir
 * (lib/orphan-filings.js), which every worktree shares — so two sessions
 * starting together cannot both file one orphan, and the reaper's `stranded:`
 * line names a worktree's issue rather than flagging it again. A failed
 * filing deletes its marker and is retried at the next run. A filing that
 * timed out, or a run killed mid-filing, leaves its marker empty: reported as
 * interrupted and never retried, because it may have filed. RESIDUAL: the markers are per machine,
 * so a second machine sharing the tracker files its own copy.
 *
 * IT FILES ISSUES THOUGH IT IS A `check-*`, departing from the family split
 * (`docs/code-standards-base.md` §N3, where filing is `report-*`'s): #813 rules one
 * checker that reports and files, and filing never moves its outcome off WARN.
 *
 * WFC_ORPHAN_FILER replaces `file-issue.js`, and WFC_ORPHAN_HOOK_TIMEOUT_MS
 * the hook's 60-second timeout — the test seams.
 *
 * EVERY REGISTERED WORKTREE IS WALKED (#4244). Dirt in a linked worktree
 * belongs to the session that owns it (lib/session-worktrees.js): an orphan
 * once that session is no longer listed live, named as its writer with no
 * ledger guess. A worktree no session owns is judged as the main checkout is,
 * by claim, observation and ledger at the file's path in its own tree, which
 * is how the stores key it (#4397).
 *
 * A CUT-OVER MAIN CHECKOUT'S DIRT IS JUDGED AT ONCE, AT ANY AGE (#4317, the
 * founder's ruling on #4309). With the `landing` module on and the main
 * checkout cut over (lib/cutover.js), #4248's refusal lets no session write
 * there, so the 24-hour window, kept because a live session's Bash-route
 * writes leave no ledger entry (#794 Q6), has no live work left to protect.
 * Claims, observations and ledgers still exclude a file. RESIDUAL: a write
 * the refusal does not see (its LIMITS: `dd of=`, a heredoc body, a script
 * writing for a session) leaves no ledger entry, so a live session's such
 * write there is filed at once.
 *
 * A DELETED FILE IS NOT JUDGED: it has no mtime, so "unchanged for 24 hours"
 * cannot be read. Counted in `deleted`.
 *
 * IMPLICIT:  at session start, at most once a clock hour across the repository's worktrees (its hook passes --write --hourly), files each uncommitted tracked file that no live session owns once as a takes:triage issue, a linked worktree's together as one, printing nothing: in a linked worktree, or in a main checkout not yet cut over, once nobody has touched it for 24 hours; in a cut-over main checkout, at any age. It never reverts or writes the file.
 * JUSTIFIED: fail-safe — an orphan voids certificates for days unseen, and any ownership signal that cannot be read silences the report rather than calling a live session's edit orphaned.
 * DEFEAT:    none at the hook beyond its hourly throttle; --hours <n> moves the threshold on a hand run, save in a cut-over main checkout, which has none.
 * TREE:      host — walks the main checkout, as git's common dir names it from whichever tree launched the run (#4483), and every linked worktree (#4244)
 */

const { spawnSync } = require("node:child_process");
const { buildScriptFilerArgv } = require("./lib/script-filer-argv.js");
const fs = require("node:fs");
const path = require("node:path");
const {
	describeAge: describeAgeText,
	HOUR_MS,
	NEVER,
} = require("./lib/age-text.js");
const { brokenError, now: clock, runCheck } = require("./lib/check");
const { readDirtyTracked, gitRead } = require("./lib/dirty-tree.js");
const { readDirtyTrackedAsync } = require("./lib/dirty-tree-async.js");
const { mapLimit } = require("./lib/gh.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { gitCommonDir, gitReader, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { adoptHostRoot } = require("./lib/host-root.js");
const { worktreeLabel, worktreeOwners } = require("./lib/session-worktrees.js");
const { readLinkedWorktrees } = require("./lib/worktree-paths.js");
const { readDistinctFromHint } = require("./lib/similar-titles.js");
const { readLanded, countUnlandedCommits } = require("./lib/landed-edit.js");
const {
	FILED_DIR,
	buildWaysOut,
	markerName,
	readWorktreeEdits,
	readWorktreeFiling,
	stateTag,
} = require("./lib/orphan-filings.js");
const {
	capMs,
	isListedLive,
	sweepSessionIds,
} = require("./lib/agent-liveness");
const proc = require("./lib/arbiter-proc");
const store = require("./lib/arbiter-store");
const { caught } = require("./lib/caught.js");
const { landingCutOver } = require("./lib/cutover.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { moduleOn } = require("./lib/workflow-core-config.js");
const { takesLabel } = require("./lib/takes-label.js");

const ORPHAN_LABEL = takesLabel("triage");

/* The threshold #794's rulings set. */
const ORPHAN_AFTER_HOURS = 24;

/* How many new filings one run makes; the rest are filed at the next run.
 * Measured (#4542), at load 12–25: the reads before filing 3–15 s, a large
 * file's landed history 6 s, one filing 11–16 s (consecutive issues one run
 * filed, 5 Nov). Two can overrun the hook, which hasFilingTime guards. */
const MAX_FILED_PER_RUN = 2;

/* One filing's ceiling, its --distinct-from retry included, over the 16 s
 * slowest measured. */
const FILER_TIMEOUT_MS = 20_000;

/* hooks/hooks.json's timeout for the SessionStart run, and an untraced
 * margin for the run's exit. */
const HOOK_TIMEOUT_MS = 60_000;
const hookTimeoutMs = () =>
	capMs("WFC_ORPHAN_HOOK_TIMEOUT_MS", HOOK_TIMEOUT_MS);
const EXIT_MARGIN_MS = 2000;

/* A filing starts only while its whole ceiling fits before the hook is
 * killed: one cut off mid-create may have filed, so it is never retried. */
const hasFilingTime = () =>
	hookTimeoutMs() - EXIT_MARGIN_MS - process.uptime() * 1000 >=
	FILER_TIMEOUT_MS;

/* Where `--hourly` runs claim their clock hour, in the git common dir, and
 * the hour, an untraced value (#4367). */
const WALK_DIR = "orphaned-edits-walked";
const WALK_EVERY_MS = 3_600_000;

/* Hex digits of a blob id a title or table shows: enough to tell a reader's
 * issues apart; the marker, not the title, prevents a refile. */
const BLOB_TAG_HEX = 10;

/**
 * @typedef {object} Orphan
 * @property {string} path    relative to its tree
 * @property {string|null} worktree  the linked worktree it sits in, as
 *   worktreeLabel names it; null for the main checkout
 * @property {string} tree    the checkout it sits in, absolute
 * @property {number} ageHours
 * @property {string} writer  the last known writer, as printed
 * @property {string} blob    the working copy's blob id, or "unknown"
 * @property {string} filed   what became of its triage issue, as printed
 * @property {"blob"|"lines"|null} [landed]  in a linked worktree, how its
 *   change reached `origin/main` (lib/landed-edit.js), null where it has not;
 *   unset where it was not read, its filing not about to be filed (#4542)
 */

/**
 * One triage issue: a main-checkout orphan alone, or every orphan of one
 * linked worktree (#4439).
 * @typedef {object} Filing
 * @property {string|null} worktree  as on its orphans
 * @property {string} tree
 * @property {Orphan[]} orphans
 * @property {string} state   what its marker is keyed by: each orphan's path
 *   and blob, so a change to any of them refiles once
 * @property {string[]} dirt  every path `git status` lists in its worktree,
 *   as `readWorktreeEdits` reads it; empty for a main-checkout filing
 * @property {number} others  the worktree's paths besides its orphans:
 *   untracked, deleted, owned by a live session, or of a blob unread
 * @property {number|null} unlanded  its `HEAD`'s commits off `origin/main`,
 *   null where that cannot be read
 * @property {string|null} held  why it is not filed this run, as printed;
 *   null where it is filed
 */

const filerPath = () =>
	process.env.WFC_ORPHAN_FILER || path.join(__dirname, "file-issue.js");

/** @param {number} ms */
const ageText = (ms) => describeAgeText(ms, { minutesUnder: NEVER });
/** @param {number} hours */
const describeAge = (hours) => ageText(hours * HOUR_MS);

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
 * Whether an `--hourly` run runs: the first to create this clock hour's
 * marker, exclusively, so starts landing together cannot all run, and every
 * run where git names no common dir or the marker will not be made (#4367).
 * RESIDUAL: the hour is claimed before the walk, so a run killed or broken
 * mid-walk holds the rest of the hour back, unseen behind the async hook;
 * and the clock is WFC_NOW's, so an exported WFC_NOW pins the hour.
 * @param {string} root
 * @param {number} at
 * @returns {boolean}
 */
function claimWalkHour(root, at) {
	const common = gitCommonDir(root, { timeout: GIT_TIMEOUT_MS });
	if (!common) return true;
	const dir = path.join(common, WALK_DIR);
	const hour = String(Math.floor(at / WALK_EVERY_MS));
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.closeSync(fs.openSync(path.join(dir, hour), "wx"));
	} catch (e) {
		return caught(e).code !== "EEXIST";
	}
	for (const old of fs.readdirSync(dir))
		if (old !== hour) fs.rmSync(path.join(dir, old), { force: true });
	return true;
}

/** @param {{path: string, worktree: string|null}} o */
const describeLocation = (o) =>
	o.worktree ? `${o.worktree}: ${o.path}` : o.path;

/**
 * Take filing `f` by creating its marker exclusively. "taken" means this run
 * files it; otherwise the marker's state, as printed.
 * @param {string} dir
 * @param {Filing} f
 * @returns {{taken: string|null, status: string}}
 */
function takeFiling(dir, f) {
	const marker = path.join(dir, markerName(f));
	try {
		fs.closeSync(fs.openSync(marker, "wx"));
		return { taken: marker, status: "" };
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "EEXIST")
			return { taken: null, status: `not filed: ${message}` };
	}
	return { taken: null, status: readFiledStatus(marker) };
}

/**
 * @param {string} marker
 */
function readFiledStatus(marker) {
	let ref = "";
	try {
		ref = JSON.parse(fs.readFileSync(marker, "utf8")).ref ?? "";
	} catch {
		// Empty or torn: the filing that made it is running or was killed.
	}
	return ref
		? `already filed: ${ref}`
		: "filing in progress or interrupted — search the tracker before filing by hand";
}

/**
 * What a run without --write says of each filing's orphans: why it waits, an
 * existing marker's filing, else that --write would file it, judged as it
 * would be filed.
 * @param {Filing[]} filings
 * @param {string} root
 * @returns {Promise<Orphan[]>}
 */
async function readUnfiledOrphans(filings, root) {
	const dir = filings.length > 0 ? filedDir(root) : null;
	/** @type {Orphan[]} */
	const out = [];
	for (const f of filings) {
		let filed = whyUnfileable(f, dir);
		if (filed === null) {
			await judgeLanded(f, root);
			filed = "not filed: `--write` files it";
		}
		for (const o of f.orphans) out.push({ ...o, filed });
	}
	return out;
}

/**
 * `sweepSessionIds`' answer where it vouches.
 * @typedef {Exclude<ReturnType<typeof sweepSessionIds>, {why: string}>} SweepRead
 */

/**
 * Every path a live session owns by claim, observation or ledger — or a
 * sentence saying why that cannot be read.
 * `owned` holds ownedKey()s: a record counts in the tree it names (#4457).
 * @returns {{owned: Set<string>, why?: undefined, names: Map<string, string>, listed: SweepRead} | {why: string, owned?: undefined, names?: undefined, listed?: undefined}}
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
	return { owned, names: listed.names, listed };
}

/**
 * The key an owned path is held under: its tree, then its path in that tree.
 * @param {string} tree
 * @param {string} rel
 */
const ownedKey = (tree, rel) => `${tree}\0${rel}`;

/**
 * @param {any[]} locks
 * @returns {string[]} the ownedKey of every lock a live holder has
 */
function heldLockPaths(locks) {
	/** @type {string[]} */
	const paths = [];
	for (const lock of locks) {
		if (!lock || lock.unreadable) continue;
		if (proc.holderAlive(lock))
			paths.push(
				ownedKey(store.recordTree(lock), store.subjectPath(lock.path)),
			);
	}
	return paths;
}

/**
 * The ownedKey of every path a live listed session observes or has in its
 * ledger — or why one of those stores would not read.
 * @param {any} listed
 * @returns {{paths: string[], why?: undefined} | {why: string, paths?: undefined}}
 */
function readLiveSessionPaths(listed) {
	/** @type {string[]} */
	const paths = [];
	for (const id of listed.ids) {
		if (!isListedLive(id, listed.ids, listed.terminal)) continue;
		const observed = store.readObservedEntriesBy(id);
		if (observed === null)
			return { why: "the arbiter's observation store would not read" };
		for (const o of observed)
			paths.push(ownedKey(o.tree, store.subjectPath(o.path)));
		const written = store.readWriteEntriesBy(id);
		if (written === null)
			return { why: `session ${id}'s write ledger would not read` };
		for (const w of written) paths.push(ownedKey(w.tree, w.rel));
	}
	return { paths };
}

/** @param {{path: string, worktree: string|null, tree: string}} o */
function buildCommands(o) {
	const p = shellQuote(o.path);
	const git = o.worktree ? `git -C ${shellQuote(o.tree)}` : "git";
	return {
		inspect: `${git} diff HEAD -- ${p}`,
		commit: `${git} commit -m "<why, in plain language>" -- ${p}`,
		revert: `${git} restore --source=HEAD --staged --worktree -- ${p}`,
	};
}

/**
 * A main-checkout orphan's issue title and body.
 * @param {Filing} f
 */
function buildFileIssue(f) {
	const [o] = f.orphans;
	if (!o) throw new Error("a main-checkout filing holds no orphan");
	const c = buildCommands(o);
	const body = [
		"## What",
		"",
		`\`${o.path}\` has uncommitted changes that no live session owns, unchanged for ${describeAge(o.ageHours)} (an **Orphaned edit**, \`GLOSSARY.md\`). Reported by \`scripts/check-orphaned-edits.js\` at session start (#813).`,
		"",
		`- Last known writer: ${o.writer}`,
		`- Working-copy blob: \`${o.blob}\``,
		"",
		"It enters every suite run that reads the main checkout, rather than a worktree at HEAD, and voids each certificate whose read closure it touches (#810). Nothing has been reverted.",
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
	return {
		title: `Orphaned edit: ${o.path} (blob ${o.blob.slice(0, BLOB_TAG_HEX)})`,
		body,
	};
}

const LANDED_AS = {
	blob: "yes, byte for byte",
	lines: "yes, every changed line",
};

/** @param {"blob"|"lines"|null|undefined} landed */
const describeLanded = (landed) => {
	if (landed === undefined)
		return "unread — read only for a worktree about to be filed";
	return landed ? LANDED_AS[landed] : "no";
};

/**
 * Whether removing filing `f`'s worktree loses nothing: every uncommitted
 * path in it is an orphan already on `origin/main`, and `HEAD` has no
 * commit off it.
 * @param {Filing} f
 */
const isRemovable = (f) =>
	f.worktree !== null &&
	f.unlanded === 0 &&
	f.others === 0 &&
	f.orphans.every((o) => o.landed);

/**
 * The issue body's line on `HEAD`'s commits off `origin/main`, none where
 * there are none.
 * @param {number|null} unlanded
 * @returns {string[]}
 */
function describeUnlanded(unlanded) {
	if (unlanded === null) return [`- Its commits off \`${LANDED_REF}\`: unread`];
	if (unlanded === 0) return [];
	return [
		`- ${String(unlanded)} commit(s) on its \`HEAD\` not on \`${LANDED_REF}\``,
	];
}

/**
 * A linked worktree's issue title and body.
 * @param {Filing} f
 * @param {string|null} supersedes
 */
function buildWorktreeIssue(f, supersedes) {
	const tree = shellQuote(f.tree);
	const out = buildWaysOut(f.tree);
	const rows = f.orphans.map(
		(o) =>
			`| \`${o.path}\` | ${describeAge(o.ageHours)} | \`${o.blob.slice(0, BLOB_TAG_HEX)}\` | ${describeLanded(o.landed)} |`,
	);
	const writers = [...new Set(f.orphans.map((o) => o.writer))];
	const decide = isRemovable(f)
		? [
				`Every change in it is already on \`${LANDED_REF}\` and its \`HEAD\` has no commit off it, so it holds nothing unlanded. Remove it:`,
				"",
				"```",
				out.remove,
				"```",
			]
		: [
				"Read the diff, then land it from inside the worktree, or, judged worthless, remove it:",
				"",
				"```",
				`git -C ${tree} diff HEAD`,
				out.land,
				out.remove,
				"```",
				"",
				"The remove destroys every uncommitted change in it — run it only after reading the diff.",
			];
	const body = [
		"## What",
		"",
		`The worktree \`${f.worktree}\` holds ${String(f.orphans.length)} uncommitted file(s) no live session owns (each an **Orphaned edit**, \`GLOSSARY.md\`). Reported by \`scripts/check-orphaned-edits.js\` at session start (#813, #4439).`,
		"",
		`| File | Unchanged | Blob | On \`${LANDED_REF}\` |`,
		"| --- | --- | --- | --- |",
		...rows,
		"",
		...writers.map((w) => `- Last known writer: ${w}`),
		...(f.others > 0
			? [
					`- ${String(f.others)} other path(s) in it, untracked, deleted or owned by a live session, not judged here`,
				]
			: []),
		...describeUnlanded(f.unlanded),
		...(supersedes
			? [
					`- Supersedes ${supersedes}, filed for this worktree before its dirt changed: close that one`,
				]
			: []),
		"",
		"Its session has ended, so the work lands nowhere until someone lands it. Nothing has been reverted.",
		"",
		"## Decide",
		"",
		...decide,
	].join("\n");
	return {
		title: `Orphaned edits: ${String(f.orphans.length)} file(s) in ${f.worktree} (state ${stateTag(f)})`,
		body,
	};
}

/**
 * File one filing through the filer. Returns the filer's last stdout line on
 * success, or null with the failure in `error` and, in `mayHaveFiled`,
 * whether the filer died before it could say.
 * @param {Filing} f
 * @param {string} root
 * @param {string|null} supersedes the worktree's last issue, filed for
 *   other dirt
 */
function fileOne(f, root, supersedes) {
	const { title, body } =
		f.worktree === null ? buildFileIssue(f) : buildWorktreeIssue(f, supersedes);
	const args = [
		filerPath(),
		...buildScriptFilerArgv({
			title,
			labels: [ORPHAN_LABEL],
			placement: {
				standalone:
					"cross-cutting: an orphaned edit has no single originating issue (#813)",
			},
			origin: "orphaned-edit-script",
		}),
	];
	const deadline = Date.now() + FILER_TIMEOUT_MS;
	const spawnFiler = (/** @type {string[]} */ a) =>
		spawnSync(process.execPath, a, {
			cwd: root,
			input: body,
			encoding: "utf8",
			timeout: Math.max(1, deadline - Date.now()),
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
 * @typedef {{path: string, ageHours: number, tree: string,
 *   worktree: string|null}} OldEdit
 * @typedef {{root: string, worktree: string|null}} Tree
 *   `worktree` the label, null for the main checkout
 */

/**
 * Sort one tree's dirty files by age: those at least `hours` old, the count
 * younger, and the count deleted.
 * @param {Tree} tree the checkout the paths are relative to
 * @param {string[]} dirty
 * @param {{hours: number, now: number}} opts
 */
function sortByAge(tree, dirty, { hours, now }) {
	/** @type {OldEdit[]} */
	const old = [];
	let young = 0;
	let deleted = 0;
	for (const rel of dirty) {
		let mtimeMs;
		try {
			mtimeMs = fs.statSync(path.join(tree.root, rel)).mtimeMs;
		} catch {
			deleted++;
			continue;
		}
		const ageHours = (now - mtimeMs) / 3_600_000;
		if (ageHours < hours) young++;
		else
			old.push({
				path: rel,
				ageHours,
				tree: tree.root,
				worktree: tree.worktree,
			});
	}
	return { old, young, deleted };
}

/**
 * @param {string} rel
 * @param {string} tree the tree `rel` is in
 * @param {Map<string, string>} names
 * @param {number} now
 */
function describeWriter(rel, tree, names, now) {
	const w = store.readLastWriterOf(rel, { tree });
	if (!w) return "unknown — no surviving write ledger names it";
	const name = names.get(w.sessionId);
	return `session ${w.sessionId}${name ? ` (${name})` : ""}, ledger last written ${ageText(now - w.at)} ago`;
}

/**
 * The old files no live session owns, each with its writer and blob — or a
 * SKIP where ownership cannot be read.
 * @param {any} ctx
 * @param {OldEdit[]} old
 * @param {{now: number}} opts
 * @returns {Orphan[]}
 */
function findOrphans(ctx, old, { now }) {
	/** @type {Orphan[]} */
	const orphans = [];
	if (old.length === 0) return orphans;
	const live = readOwnedByLive();
	// Who owns a file is the subject asked about, not the apparatus: SKIP (§N4, #1240).
	if (!live.owned)
		ctx.skip(
			`${String(old.length)} uncommitted file(s) are old enough to judge, but ${live.why}, so whether a live session owns them is unknown.`,
		);
	const { owned, names, listed } =
		/** @type {{owned: Set<string>, names: Map<string, string>, listed: SweepRead}} */ (
			live
		);
	const trees = [...new Set(old.flatMap((o) => (o.worktree ? o.tree : [])))];
	/* An unread job store goes unreported here: a live session owns its tree
	 * through the oracle's cwds, which no job store can hide (#4704). */
	const owners =
		trees.length > 0 ? worktreeOwners(trees, listed).owners : new Map();
	for (const o of old) {
		const verdict = judgeWriter(o, { owners, owned, names, listed, now });
		if (verdict.kind === "owned") continue;
		const { writer } = verdict;
		const blob =
			gitRead(["hash-object", "--", o.path], o.tree)?.trim() || "unknown";
		orphans.push({
			path: o.path,
			worktree: o.worktree,
			tree: o.tree,
			ageHours: o.ageHours,
			writer,
			blob,
			filed: "",
		});
	}
	return orphans;
}

/**
 * Whether a live session owns an old edit, and where none does, who last
 * wrote it, as printed.
 *
 * A live claim, observation or ledger entry at the file's path in its tree
 * owns it; the same path in another tree is other bytes (#4457). Past that,
 * a worktree's owner answers for every file in it, and a worktree no session
 * owns is named by the ledger.
 * @param {OldEdit} o
 * @param {{owners: Map<string, import("./lib/session-worktrees.js").Owner>,
 *   owned: Set<string>, names: Map<string, string>, listed: SweepRead, now: number}} ctx
 * @returns {{kind: "owned"} | {kind: "orphan", writer: string}}
 */
function judgeWriter(o, { owners, owned, names, listed, now }) {
	if (owned.has(ownedKey(o.tree, o.path))) return { kind: "owned" };
	const owner = o.worktree === null ? undefined : owners.get(o.tree);
	if (owner) {
		if (isListedLive(owner.sessionId, listed.ids, listed.terminal))
			return { kind: "owned" };
		return {
			kind: "orphan",
			writer: `session ${owner.sessionId}${owner.name ? ` (${owner.name})` : ""}, whose worktree it is — no longer listed, or listed but stopped`,
		};
	}
	return {
		kind: "orphan",
		writer: describeWriter(o.path, o.tree, names, now),
	};
}

/* Orphaned work counts as landed once it is on `main`: a queue ref the
 * lander may yet drop is not landed. */
const LANDED_REF = VERIFIED_REF;

/**
 * @param {Orphan} o
 * @returns {Filing}
 */
const buildFileFiling = (o) => ({
	worktree: null,
	tree: o.tree,
	orphans: [o],
	state: `${o.path}\0${o.blob}`,
	dirt: [],
	others: 0,
	unlanded: null,
	held: null,
});

/**
 * Why a worktree's filing waits, or null where it is filed now: its dirt
 * unread, or a file in it younger than the threshold.
 * @param {string[]|null} dirt
 * @param {number} young
 * @param {number} hours
 */
function describeHeld(dirt, young, hours) {
	if (dirt === null)
		return "not filed: git status would not list the worktree's paths";
	if (young > 0)
		return `not filed yet: ${String(young)} other file(s) in its worktree changed within ${String(hours)}h, and the worktree is filed once all have aged`;
	return null;
}

/**
 * Add worktree orphan `o` to its worktree's filing, starting one where none
 * stands.
 * @param {Map<string, Filing>} byTree accumulator: each worktree's filing
 * @param {Filing[]} filings accumulator: a started filing is pushed here
 * @param {Orphan} o
 */
function addToWorktree(byTree, filings, o) {
	const f = byTree.get(o.tree);
	if (f) {
		f.orphans.push(o);
		return;
	}
	const made = {
		worktree: o.worktree,
		tree: o.tree,
		orphans: [o],
		state: "",
		dirt: [],
		others: 0,
		unlanded: null,
		held: null,
	};
	byTree.set(o.tree, made);
	filings.push(made);
}

/**
 * The orphans grouped into filings: each main-checkout orphan alone, each
 * linked worktree's together, in the order of each filing's oldest orphan. A worktree orphan
 * whose blob will not read is filed with none, and returned apart.
 * @param {Orphan[]} orphans oldest first
 * @param {{youngIn: Map<string, number>, hours: number}} opts
 *   `youngIn` each linked worktree's count of files under the threshold
 * @returns {{filings: Filing[], unfiled: Orphan[]}}
 */
function buildFilings(orphans, { youngIn, hours }) {
	/** @type {Filing[]} */
	const filings = [];
	/** @type {Orphan[]} */
	const unfiled = [];
	/** @type {Map<string, Filing>} */
	const byTree = new Map();
	for (const o of orphans) {
		if (o.worktree === null) {
			filings.push(buildFileFiling(o));
			continue;
		}
		if (o.blob === "unknown") {
			unfiled.push({ ...o, filed: "not filed: its blob could not be read" });
			continue;
		}
		addToWorktree(byTree, filings, o);
	}
	for (const f of byTree.values()) {
		const dirt = readWorktreeEdits(f.tree);
		f.held = describeHeld(dirt, youngIn.get(f.tree) ?? 0, hours);
		f.dirt = dirt ?? [];
		f.others = f.dirt.length - f.orphans.length;
		f.state = [
			f.worktree,
			...f.orphans.map((o) => `${o.path}\0${o.blob}`).sort(),
		].join("\n");
	}
	return { filings, unfiled };
}

/**
 * Judge a worktree filing against `origin/main` where it stands, writing onto
 * `f` (an accumulator): each orphan's `landed`, and `unlanded`. Run only for a
 * filing about to be filed (#4542).
 * @param {Filing} f
 * @param {string} root
 */
async function judgeLanded(f, root) {
	if (f.worktree === null) return;
	const ref = gitRead(["rev-parse", "--verify", "-q", LANDED_REF], root)
		? LANDED_REF
		: null;
	const landed = ref
		? await readLanded(
				f.tree,
				f.orphans.map((o) => ({ rel: o.path, blob: o.blob })),
				ref,
			)
		: [];
	f.orphans.forEach((o, i) => {
		o.landed = landed[i] ?? null;
	});
	f.unlanded = ref ? countUnlandedCommits(f.tree, ref) : null;
}

/**
 * Why `f` is not filed, as printed: held, a blob unread, no marker directory,
 * or an existing marker's filing. Null where it can be filed.
 * @param {Filing} f
 * @param {string|null} dir
 * @returns {string|null}
 */
function whyUnfileable(f, dir) {
	if (f.held !== null) return f.held;
	if (f.orphans.some((o) => o.blob === "unknown"))
		return "not filed: its blob could not be read";
	if (dir === null)
		return "not filed: no marker directory in the git common dir, so a filing could repeat";
	const marker = path.join(dir, markerName(f));
	return fs.existsSync(marker) ? readFiledStatus(marker) : null;
}

/**
 * What a filing's marker records once filed: a worktree's dirt, for the
 * reaper's match, or a main-checkout file's path and blob.
 * @param {Filing} f
 * @param {string} ref
 * @param {number} now
 */
const buildMarkerRecord = (f, ref, now) =>
	f.worktree === null
		? { path: f.orphans[0]?.path, blob: f.orphans[0]?.blob, ref, at: now }
		: { worktree: f.worktree, dirt: f.dirt, ref, at: now };

/**
 * @param {Filing} f
 * @param {string} taken
 * @param {{root: string, now: number}} opts
 * @returns {string} the outcome, for each orphan's `filed`
 */
function fileUnderMarker(f, taken, { root, now }) {
	const supersedes =
		f.worktree === null
			? null
			: readWorktreeFiling(path.dirname(path.dirname(taken)), f.worktree);
	const res = fileOne(f, root, supersedes);
	if (res.ref === null && res.mayHaveFiled)
		return `filing interrupted, not retried — search the tracker: ${res.error}`;
	if (res.ref === null) {
		fs.rmSync(taken, { force: true });
		return `filing failed, retried next run: ${res.error}`;
	}
	try {
		fs.writeFileSync(
			taken,
			`${JSON.stringify(buildMarkerRecord(f, res.ref, now))}\n`,
		);
	} catch (e) {
		// Its marker exists, so it is still never filed twice (#813).
		return `${res.ref} (issue reference not recorded: ${caught(e).message})`;
	}
	return res.ref;
}

/**
 * File each filing once, up to this run's cap.
 * @param {Filing[]} filings
 * @param {{root: string, now: number}} opts
 * @returns {Promise<{filings: number, orphans: Orphan[]}>} how many filings
 *   ran, and each orphan with its filing's outcome
 */
async function fileOrphans(filings, { root, now }) {
	const dir = filings.length > 0 ? filedDir(root) : null;
	let ran = 0;
	/** @type {Orphan[]} */
	const triaged = [];
	const record = (/** @type {Filing} */ f, /** @type {string} */ filed) => {
		for (const o of f.orphans) triaged.push({ ...o, filed });
	};
	for (const f of filings) {
		const why = whyUnfileable(f, dir);
		if (why !== null || dir === null) {
			record(f, why ?? "");
			continue;
		}
		if (ran >= MAX_FILED_PER_RUN) {
			record(f, "not filed yet: this run's filing cap is spent");
			continue;
		}
		/* Judged before its marker is taken, so a run killed mid-read leaves
		 * none, and the next run files it. */
		if (hasFilingTime()) await judgeLanded(f, root);
		if (!hasFilingTime()) {
			record(f, "not filed yet: this run's time is spent");
			continue;
		}
		const { taken, status } = takeFiling(dir, f);
		if (taken === null) {
			record(f, status);
			continue;
		}
		ran++;
		record(f, fileUnderMarker(f, taken, { root, now }));
	}
	return { filings: ran, orphans: triaged };
}

/**
 * @param {number} hours
 * @param {boolean} cutOver
 */
const describeThreshold = (hours, cutOver) =>
	cutOver
		? `in the cut-over main checkout at any age, or unchanged over ${String(hours)}h in a worktree`
		: `unchanged over ${String(hours)}h`;

/**
 * @param {any} ctx
 * @param {Orphan[]} orphans
 * @param {string} threshold
 */
function reportOrphans(ctx, orphans, threshold) {
	for (const o of orphans)
		ctx.warn(
			"ORPHANED-EDIT",
			`${describeLocation(o)} — uncommitted, unchanged ${describeAge(o.ageHours)}, no live session owns it`,
			{ ...o, ...buildCommands(o) },
		);

	if (orphans.length === 0) return;
	ctx.say(
		`ORPHANED-EDIT (${String(orphans.length)}) — uncommitted, ${threshold}, owned by no live session:`,
	);
	for (const o of orphans) {
		const c = buildCommands(o);
		ctx.say(
			`  ${describeLocation(o)} — unchanged ${describeAge(o.ageHours)}\n` +
				`    last known writer: ${o.writer}\n` +
				`    inspect: ${c.inspect}\n` +
				`    commit:  ${c.commit}\n` +
				`    revert:  ${c.revert}\n` +
				`    triage:  ${o.filed}` +
				(o.worktree
					? `\n    on ${LANDED_REF}: ${describeLanded(o.landed)}`
					: ""),
		);
	}
	ctx.say(
		"\n  Nothing was reverted. Each voids the certificates whose read closure it\n" +
			"  touches until it is committed or reverted. Read the diff first: the\n" +
			"  revert destroys the edit.\n",
	);
}

/**
 * What the run could not judge, as a clause for the okLine; empty where it
 * judged everything.
 * @param {{linked: string[]|null, unread: string[]}} opts
 */
function describeUnread({ linked, unread }) {
	const parts = [];
	if (linked === null)
		parts.push(
			"git would not list the linked worktrees, so theirs went unread",
		);
	else if (unread.length > 0)
		parts.push(
			`${String(unread.length)} worktree(s) git would not read went unjudged: ${unread.join(", ")}`,
		);
	return parts.length > 0 ? ` ${parts.join("; ")}.` : "";
}

/* `git status` calls in flight across the linked worktrees (#4542). Four,
 * half the cores, is a guess that leaves the rest to the other SessionStart
 * hooks. */
const STATUS_CONCURRENCY = 4;

/**
 * Every linked worktree's dirt, sorted by age, with what could not be read.
 * @param {string} root
 * @param {{hours: number, now: number}} opts
 */
async function readLinkedDirt(root, { hours, now }) {
	const linked = readLinkedWorktrees(root);
	const dirt = await mapLimit(linked ?? [], STATUS_CONCURRENCY, (wt) =>
		readDirtyTrackedAsync(wt),
	);
	/** @type {ReturnType<typeof sortByAge>[]} */
	const sorted = [];
	let total = 0;
	/* Counted and named in the okLine, never a finding (#4244): a
	 * registration whose directory has gone is the usual cause. */
	/** @type {string[]} */
	const unread = [];
	/** @type {Map<string, number>} */
	const youngIn = new Map();
	for (const [i, wt] of (linked ?? []).entries()) {
		const wtDirty = dirt[i] ?? null;
		if (wtDirty === null) unread.push(wt);
		if (!wtDirty || wtDirty.length === 0) continue;
		total += wtDirty.length;
		const tree = { root: wt, worktree: worktreeLabel(root, wt) };
		const aged = sortByAge(tree, wtDirty, { hours, now });
		youngIn.set(wt, aged.young);
		sorted.push(aged);
	}
	return { linked, sorted, total, unread, youngIn };
}

/** @param {import("./lib/check").CheckContext} ctx */
async function run(ctx) {
	const hours = ctx.numberValue("--hours", ORPHAN_AFTER_HOURS, "non-negative");

	const root = adoptHostRoot();
	const now = clock();
	if (ctx.has("--hourly") && !claimWalkHour(root, now))
		return {
			okLine: "not run: an --hourly run already ran this clock hour.",
			noun: "orphaned edit(s)",
			data: { walked: false },
		};
	const dirty = readDirtyTracked(root);
	// git is the apparatus here, not the subject: BROKEN (§N4).
	if (dirty === null)
		throw brokenError(
			"git status would not answer, so what is uncommitted is unknown.",
		);

	const cutOver = landingCutOver(
		(m) => moduleOn(m, { root }),
		gitReader(root, GIT_TIMEOUT_MS),
	);
	const checkout = { root, worktree: null };
	const { linked, unread, youngIn, ...walked } = await readLinkedDirt(root, {
		hours,
		now,
	});
	const sorted = [
		sortByAge(checkout, dirty, { hours: cutOver ? 0 : hours, now }),
		...walked.sorted,
	];
	const total = dirty.length + walked.total;
	const old = sorted.flatMap((t) => t.old);
	const young = sorted.reduce((n, t) => n + t.young, 0);
	const deleted = sorted.reduce((n, t) => n + t.deleted, 0);

	const found = findOrphans(ctx, old, { now });

	found.sort((a, b) => b.ageHours - a.ageHours);

	const grouped = buildFilings(found, { youngIn, hours });
	const filed = ctx.has("--write")
		? await fileOrphans(grouped.filings, { root, now })
		: {
				filings: 0,
				orphans: await readUnfiledOrphans(grouped.filings, root),
			};
	const { filings } = filed;
	const orphans = [...filed.orphans, ...grouped.unfiled];

	const threshold = describeThreshold(hours, cutOver);
	if (!ctx.notify) reportOrphans(ctx, orphans, threshold);

	return {
		okLine: `no orphaned edit ${threshold} among ${String(total)} uncommitted file(s) across the main checkout and its worktrees.${describeUnread({ linked, unread })}`,
		noun: "orphaned edit(s)",
		data: {
			walked: true,
			orphans,
			orphanCount: orphans.length,
			young,
			deleted,
			unreadWorktrees: linked === null ? null : unread,
			filings,
			worktreeThresholdHours: hours,
			mainCutOver: cutOver,
		},
	};
}

const main = () =>
	runCheck({
		name: "orphaned-edits",
		usage:
			"node check-orphaned-edits.js [--hours <n>] [--notify] [--json] [--write] [--hourly]",
		valueFlags: ["--hours"],
		flags: ["--write", "--hourly"],
		run,
	});

module.exports = { main };
if (require.main === module) main();
