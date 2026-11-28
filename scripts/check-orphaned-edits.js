#!/usr/bin/env node
// #5866

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
const { gitCommonDir, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { adoptHostRoot } = require("./lib/host-root.js");
const { worktreeLabel, worktreeOwners } = require("./lib/session-worktrees.js");
const { readLinkedWorktrees } = require("./lib/worktree-paths.js");
const { readDistinctFromHint } = require("./lib/similar-titles.js");
const {
	readLanded,
	readLevelClear,
	countUnlandedCommits,
} = require("./lib/landed-edit.js");
const {
	FILED_DIR,
	buildWaysOut,
	markerName,
	readWorktreeEdits,
	readWorktreeFiling,
	stateTag,
} = require("./lib/orphan-filings.js");
const { isListedLive } = require("./lib/agent-liveness");
const { ownedKey, readOwnedByLive } = require("./lib/orphan-owners.js");
const { capMs } = require("./lib/cap-ms.js");
const store = require("./lib/arbiter-store");
const { caught, orFallback } = require("./lib/caught.js");
const { isCutOver } = require("./lib/cutover.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { takesLabel } = require("./lib/takes-label.js");

const ORPHAN_LABEL = takesLabel("triage");

// guess, #794
const ORPHAN_AFTER_HOURS = 24;

// measured 11-16 s a filing at load 12-25, #4542
const MAX_FILED_PER_RUN = 2;

// measured 16 s slowest filing, #4542
const FILER_TIMEOUT_MS = 20_000;

const HOOK_TIMEOUT_MS = 60_000;
const hookTimeoutMs = () =>
	capMs("WFC_ORPHAN_HOOK_TIMEOUT_MS", HOOK_TIMEOUT_MS);
const EXIT_MARGIN_MS = 2000;

const hasFilingTime = () =>
	hookTimeoutMs() - EXIT_MARGIN_MS - process.uptime() * 1000 >=
	FILER_TIMEOUT_MS;

const WALK_DIR = "orphaned-edits-walked";
// guess, #4367
const WALK_EVERY_MS = 3_600_000;

// guess: enough to tell a reader's issues apart, #4439
const BLOB_TAG_HEX = 10;

/**
 * @typedef {object} Orphan
 * @property {string} path
 * @property {string|null} worktree
 * @property {string} tree
 * @property {number} ageHours
 * @property {string} writer
 * @property {string} blob
 * @property {string} filed
 * @property {"blob"|"lines"|null} [landed]
 */

/**
 * @typedef {object} Filing
 * @property {string|null} worktree
 * @property {string} tree
 * @property {Orphan[]} orphans
 * @property {string} state
 * @property {string[]} dirt
 * @property {number} others
 * @property {number|null} unlanded
 * @property {string|null} held
 */

const filerPath = () =>
	process.env.WFC_ORPHAN_FILER || path.join(__dirname, "file-issue.js");

/** @param {number} ms */
const ageText = (ms) => describeAgeText(ms, { minutesUnder: NEVER });
/** @param {number} hours */
const describeAge = (hours) => ageText(hours * HOUR_MS);

/**
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
	const ref = orFallback(
		() => JSON.parse(fs.readFileSync(marker, "utf8")).ref ?? "",
		"",
	);
	return ref
		? `already filed: ${ref}`
		: "filing in progress or interrupted — search the tracker before filing by hand";
}

/**
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
			filed = whyLandedUnfiled(f) ?? "not filed: `--write` files it";
		}
		for (const o of f.orphans) out.push({ ...o, filed });
	}
	return out;
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
 * @param {Filing} f
 */
function buildFileIssue(f) {
	const [o] = f.orphans;
	if (!o) throw new Error("a main-checkout filing holds no orphan");
	const c = buildCommands(o);
	const body = [
		"## What",
		"",
		`\`${o.path}\` has uncommitted changes that no live session owns, unchanged for ${describeAge(o.ageHours)} (an **Orphaned edit**, \`.claude/workflow-core.glossary.md\`). Reported by \`scripts/check-orphaned-edits.js\` at session start (#813).`,
		"",
		`- Last known writer: ${o.writer}`,
		`- Working-copy blob: \`${o.blob}\``,
		`- On \`${LANDED_REF}\`: ${describeLanded(o.landed)}`,
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
	lines: "yes, its change in place",
};

/** @param {"blob"|"lines"|null|undefined} landed */
const describeLanded = (landed) => {
	if (landed === undefined)
		return "unread — read only for an edit about to be filed";
	return landed ? LANDED_AS[landed] : "no";
};

/**
 * @param {Filing} f
 */
const isRemovable = (f) =>
	f.worktree !== null &&
	f.unlanded === 0 &&
	f.others === 0 &&
	f.orphans.every((o) => o.landed);

/**
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
				out.removeLanded,
				"```",
				"",
				"It re-checks all of that before removing anything, and closes this issue once the worktree is gone.",
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
		`The worktree \`${f.worktree}\` holds ${String(f.orphans.length)} uncommitted file(s) no live session owns (each an **Orphaned edit**, \`.claude/workflow-core.glossary.md\`). Reported by \`scripts/check-orphaned-edits.js\` at session start (#813, #4439).`,
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
 * @param {Filing} f
 * @param {string} root
 * @param {string|null} supersedes
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
	return { ref: null, error: why, mayHaveFiled: res.status === null };
}

/**
 * @typedef {{path: string, ageHours: number, tree: string,
 *   worktree: string|null}} OldEdit
 * @typedef {{root: string, worktree: string|null}} Tree
 */

/**
 * @param {Tree} tree
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
 * @param {string} tree
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
	if (!live.owned)
		ctx.skip(
			`${String(old.length)} uncommitted file(s) are old enough to judge, but ${live.why}, so whether a live session owns them is unknown.`,
		);
	const { owned, names, listed } =
		/** @type {{owned: Set<string>, names: Map<string, string>, listed: import("./lib/orphan-owners.js").SweepRead}} */ (
			live
		);
	const trees = [...new Set(old.flatMap((o) => (o.worktree ? o.tree : [])))];
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
 * @param {OldEdit} o
 * @param {{owners: Map<string, import("./lib/session-worktrees.js").Owner>,
 *   owned: Set<string>, names: Map<string, string>, listed: import("./lib/orphan-owners.js").SweepRead, now: number}} ctx
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
 * @param {Map<string, Filing>} byTree
 * @param {Filing[]} filings
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
 * @param {Orphan[]} orphans
 * @param {{youngIn: Map<string, number>, hours: number}} opts
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
 * @param {Filing} f
 * @param {string} root
 */
async function judgeLanded(f, root) {
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
 * @param {Filing} f
 * @returns {string|null}
 */
function whyLandedUnfiled(f) {
	const [o] = f.orphans;
	return f.worktree === null &&
		o?.landed === "blob" &&
		isCutOver(f.tree) &&
		readLevelClear(f.tree, o.path, LANDED_REF) !== null
		? `not filed: landed byte for byte on ${LANDED_REF}; clears at the next level`
		: null;
}

/**
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
 * @returns {string}
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
		return `${res.ref} (issue reference not recorded: ${caught(e).message})`;
	}
	return res.ref;
}

/**
 * @param {Filing} f
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function whyNotFiledNow(f, root) {
	if (hasFilingTime()) await judgeLanded(f, root);
	if (!hasFilingTime()) return "not filed yet: this run's time is spent";
	return whyLandedUnfiled(f);
}

/**
 * @param {Filing[]} filings
 * @param {{root: string, now: number}} opts
 * @returns {Promise<{filings: number, orphans: Orphan[]}>}
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
		const skip = await whyNotFiledNow(f, root);
		if (skip !== null) {
			record(f, skip);
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
				`\n    on ${LANDED_REF}: ${describeLanded(o.landed)}`,
		);
	}
	ctx.say(
		"\n  Nothing was reverted. Each voids the certificates whose read closure it\n" +
			"  touches until it is committed or reverted. Read the diff first: the\n" +
			"  revert destroys the edit.\n",
	);
}

/**
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

// guess, #4542
const STATUS_CONCURRENCY = 4;

/**
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

/** @param {import("./lib/check").Ctx} ctx */
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
	if (dirty === null)
		throw brokenError(
			"git status would not answer, so what is uncommitted is unknown.",
		);

	const cutOver = isCutOver(root);
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
