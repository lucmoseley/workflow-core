const fs = require("node:fs");
const path = require("node:path");
const core = require("./arbiter-core.js");
const { ACT_LINE, buildCommitAct } = require("./act-line.js");
const { caught } = require("./caught.js");
const { mainCheckout } = require("./main-checkout.js");

// guess, lucmoseley/mantahostels#114
const LEDGER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function pruneLedgers() {
	core.sweepSparingLive(
		"pruneLedgers",
		core.paths.writesDir(),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.ledger(id)),
	);
}

/**
 * @param {string} filePath
 * @param {string} sessionId
 */
function recordWrite(filePath, sessionId) {
	if (!sessionId) return null;
	const subject = core.claimKey(filePath);
	if (subject === null) return null;
	const rel = core.subjectPath(subject);
	fs.mkdirSync(core.paths.writesDir(), { recursive: true });
	const ledger = core.paths.ledger(sessionId);
	if (!fs.existsSync(ledger)) pruneLedgers();
	const tree = core.writerTree();
	fs.appendFileSync(ledger, tree ? `${rel}\t${tree}\n` : `${rel}\n`);
	noteLandedRewrite(rel, sessionId);
	return rel;
}

/**
 * @param {string} line
 * @param {string} host
 */
function parseWriteEntry(line, host) {
	const tab = line.indexOf("\t");
	return tab === -1
		? { rel: line, tree: host }
		: { rel: line.slice(0, tab), tree: line.slice(tab + 1) };
}

/**
 * @param {string} file
 * @param {string} what
 * @param {string} tree
 * @param {string} host
 */
function readWritesIn(file, what, tree, host) {
	const lines = readLines(file, what);
	if (lines === null) return null;
	const rels = new Set();
	for (const line of lines) {
		const entry = parseWriteEntry(line, host);
		if (entry.tree === tree) rels.add(entry.rel);
	}
	return [...rels];
}

/**
 * @param {string} sessionId
 * @returns {{rel: string, tree: string}[]|null}
 */
function readWriteEntriesBy(sessionId) {
	if (!sessionId) return null;
	const host = core.repoRoot();
	const lines = readLines(core.paths.ledger(sessionId), `writes ${sessionId}`);
	if (lines === null) return null;
	return lines.map((line) => parseWriteEntry(line, host));
}

/**
 * @param {string} sessionId
 * @param {string} [tree]
 */
function readWritesBy(sessionId, tree = core.treeRoot()) {
	if (!sessionId) return null;
	return readWritesIn(
		core.paths.ledger(sessionId),
		`writes ${sessionId}`,
		tree,
		core.repoRoot(),
	);
}

function pruneSelectLedgers() {
	core.sweepSparingLive(
		"pruneSelectLedgers",
		core.paths.selectsDir(),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.selectLedger(id)),
	);
}

/**
 * @param {string} rel
 * @param {string} sessionId
 * @param {number} [at]
 */
function recordSelect(rel, sessionId, at = Date.now()) {
	if (!sessionId || !rel) return null;
	fs.mkdirSync(core.paths.selectsDir(), { recursive: true });
	const ledger = core.paths.selectLedger(sessionId);
	if (!fs.existsSync(ledger)) pruneSelectLedgers();
	fs.appendFileSync(ledger, `${rel}\t${String(at)}\n`);
	return rel;
}

/**
 * @param {string} sessionId
 * @returns {{ path: string, at: number }[]|null}
 */
function readSelectsBy(sessionId) {
	if (!sessionId) return null;
	const lines = readLedger(
		core.paths.selectLedger(sessionId),
		`selects ${sessionId}`,
	);
	if (lines === null) return null;
	/** @type {Map<string, number>} */
	const newest = new Map();
	for (const line of lines) {
		const tab = line.lastIndexOf("\t");
		const rel = tab < 0 ? line : line.slice(0, tab);
		const at = tab < 0 ? 0 : Number(line.slice(tab + 1)) || 0;
		newest.set(rel, Math.max(newest.get(rel) ?? 0, at));
	}
	return [...newest].map(([rel, at]) => ({ path: rel, at }));
}

function pruneLandedLedgers() {
	core.sweepSparingLive(
		"pruneLandedLedgers",
		core.paths.landedDir(),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.landedLedger(id)),
	);
}

/**
 * @param {string} rel
 * @param {string} sessionId
 */
function recordLanded(rel, sessionId) {
	if (!sessionId || !rel) return null;
	fs.mkdirSync(core.paths.landedDir(), { recursive: true });
	const ledger = core.paths.landedLedger(sessionId);
	if (!fs.existsSync(ledger)) pruneLandedLedgers();
	fs.appendFileSync(ledger, `released\t${rel}\n`);
	return rel;
}

/**
 * @param {string} rel
 * @param {string} sessionId
 */
function noteLandedRewrite(rel, sessionId) {
	const ledger = core.paths.landedLedger(sessionId);
	if (fs.existsSync(ledger)) fs.appendFileSync(ledger, `wrote\t${rel}\n`);
}

/**
 * @param {string} sessionId
 * @returns {Set<string>|null}
 */
function readLandedBy(sessionId) {
	if (!sessionId) return null;
	const lines = readLines(
		core.paths.landedLedger(sessionId),
		`landed ${sessionId}`,
	);
	if (lines === null) return null;
	/** @type {Map<string, string>} */
	const last = new Map();
	for (const line of lines) {
		const tab = line.indexOf("\t");
		last.set(line.slice(tab + 1), line.slice(0, tab));
	}
	return new Set([...last].filter(([, e]) => e === "released").map(([p]) => p));
}

/**
 * @param {string} file
 * @param {string} what
 * @returns {string[]|null}
 */
function readLedger(file, what) {
	const lines = readLines(file, what);
	return lines && [...new Set(lines)];
}

/**
 * @param {string} file
 * @param {string} what
 * @returns {string[]|null}
 */
function readLines(file, what) {
	try {
		return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		core.logError(what, e);
		return null;
	}
}

/**
 * @param {string} rel
 * @param {{root?: string, tree?: string}} [where]
 * @returns {{sessionId: string, at: number}|null}
 */
function readLastWriterOf(rel, { root, tree } = {}) {
	const host = root ?? core.repoRoot();
	const dir = core.paths.writesDir(root);
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	/** @type {{sessionId: string, at: number}|null} */
	let best = null;
	for (const name of entries) {
		if (!name.endsWith(".txt")) continue;
		const file = path.join(dir, name);
		const rels = readWritesIn(file, `writes ${name}`, tree ?? host, host);
		if (!rels?.includes(rel)) continue;
		let at;
		try {
			at = fs.statSync(file).mtimeMs;
		} catch {
			continue;
		}
		if (!best || at > best.at) best = { sessionId: name.slice(0, -4), at };
	}
	return best;
}

/**
 * @param {string} commit
 * @param {string} sessionId
 * @returns {boolean}
 */
function recordCommit(commit, sessionId) {
	if (!sessionId || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
	fs.mkdirSync(core.paths.commitsDir(), { recursive: true });
	const ledger = core.paths.commitLedger(sessionId);
	if (!fs.existsSync(ledger)) pruneCommitAndActLedgers();
	fs.appendFileSync(ledger, `${commit}\n`);
	return true;
}

/** @param {string} [root] */
function pruneCommitAndActLedgers(root) {
	core.sweepSparingLive(
		"pruneCommitAndActLedgers",
		core.paths.commitsDir(root),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.commitLedger(id, root)),
	);
	core.sweepSparingLive(
		"pruneCommitAndActLedgers",
		core.paths.actsDir(root),
		LEDGER_AGE_MS,
		(id) => path.basename(core.paths.actLedger(id, root)),
	);
}

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {string[]|null}
 */
function readCommitsBy(sessionId, root) {
	if (!sessionId) return null;
	return readLedger(
		core.paths.commitLedger(sessionId, root),
		`commits ${sessionId}`,
	);
}

/**
 * @param {string} sessionId
 * @returns {string[]|null}
 */
function readCommittedPathsBy(sessionId) {
	const commits = readCommitsBy(sessionId, ledgerRoot() ?? undefined);
	if (commits === null) return null;
	if (commits.length === 0) return [];
	const out = core.gitIn(
		[
			"-c",
			"core.quotePath=false",
			"diff-tree",
			"--stdin",
			"--root",
			"-r",
			"--cc",
			"--name-only",
			"--no-commit-id",
		],
		`${commits.join("\n")}\n`,
	);
	if (out === null) return null;
	return [...new Set(out.split("\n").filter(Boolean))];
}

/**
 * @param {string} sessionId
 * @param {string} what
 * @param {string} [tree]
 * @returns {string[]|null}
 */
function readBilledPathsBy(sessionId, what, tree) {
	const written = readWritesBy(sessionId, tree);
	if (written === null) return null;
	const fromCommits = readCommittedPathsBy(sessionId);
	if (fromCommits === null)
		core.logError(
			what,
			new Error(`commit ledger or git unreadable for ${sessionId}`),
		);
	return [...new Set([...written, ...(fromCommits ?? [])])];
}

/**
 * @param {string} act
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {boolean}
 */
function recordAct(act, sessionId, root = ledgerRoot() ?? undefined) {
	if (!sessionId || !ACT_LINE.test(act)) return false;
	fs.mkdirSync(core.paths.actsDir(root), { recursive: true });
	const ledger = core.paths.actLedger(sessionId, root);
	if (!fs.existsSync(ledger)) pruneCommitAndActLedgers(root);
	fs.appendFileSync(ledger, `${act}\n`);
	return true;
}

/**
 * @param {string} sessionId
 * @param {string[]} roots
 * @returns {{acts: string[], unreadable: string[]}}
 */
function readActsBy(sessionId, roots) {
	if (!sessionId) return { acts: [], unreadable: [...roots] };
	/** @type {string[]} */
	const acts = [];
	/** @type {string[]} */
	const unreadable = [];
	for (const root of roots) {
		const done = readLines(
			core.paths.actLedger(sessionId, root),
			`acts ${sessionId}`,
		);
		const commits = readCommitsBy(sessionId, root);
		if (done === null || commits === null) unreadable.push(root);
		acts.push(...(done ?? []), ...(commits ?? []).map(buildCommitAct));
	}
	return { acts, unreadable };
}

/**
 * @param {string} sessionId
 * @param {string[]} roots
 * @returns {{at: number|null, unreadable: string[]}}
 */
function readLastActAt(sessionId, roots) {
	/** @type {number|null} */
	let at = null;
	/** @type {string[]} */
	const unreadable = [];
	for (const root of roots)
		for (const file of [
			core.paths.actLedger(sessionId, root),
			core.paths.commitLedger(sessionId, root),
		])
			try {
				at = Math.max(at ?? 0, fs.statSync(file).mtimeMs);
			} catch (e) {
				if (caught(e).code === "ENOENT") continue;
				core.logError(`act time ${sessionId}`, e);
				if (!unreadable.includes(root)) unreadable.push(root);
			}
	return { at, unreadable };
}

/** @returns {string|null} */
function ledgerRoot() {
	return mainCheckout(core.repoRoot());
}

/**
 * @param {string[]} commits
 * @param {string} [root]
 * @returns {Map<string, string>|null}
 */
function readOwnersOf(commits, root) {
	const dir = core.paths.commitsDir(root);
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch (e) {
		if (caught(e).code === "ENOENT") return new Map();
		core.logError("readOwnersOf", e);
		return null;
	}
	const wanted = new Set(commits);
	/** @type {Map<string, string>} */
	const owners = new Map();
	for (const name of entries) {
		if (!name.endsWith(".txt")) continue;
		const shas = readLedger(path.join(dir, name), `commits ${name}`);
		for (const sha of shas ?? [])
			if (wanted.has(sha) && !owners.has(sha))
				owners.set(sha, name.slice(0, -4));
	}
	return owners;
}

module.exports = {
	readActsBy,
	readLastActAt,
	readBilledPathsBy,
	readCommitsBy,
	readLandedBy,
	ledgerRoot,
	readOwnersOf,
	readLastWriterOf,
	recordAct,
	recordCommit,
	recordLanded,
	recordSelect,
	recordWrite,
	readSelectsBy,
	readWritesBy,
	readWriteEntriesBy,
};
