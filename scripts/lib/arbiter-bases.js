/*
 * arbiter-bases.js — what HEAD held for a path when this session first wrote it (#110).
 *
 * The base a commit is judged against by #100's stale-write-back gate: a
 * session whose staged bytes sit nearer its base than HEAD is writing back a
 * version a neighbour has since replaced. scripts/stale-write-back-gate.sh
 * is that gate (#113).
 *
 * TWO RECORDS. A per-(session, path) base, minted at the session's FIRST write
 * to the path and rewritten only by acceptHead and advanceBases; and one per-session fallback, HEAD at
 * SessionStart, for a path with no per-path base — never written, outside the
 * watched tiers, minted before this family existed, or a record that will not
 * read (#100 stories 11, 15 and 25).
 *
 * FIRST WRITE WINS. The per-path record is created once (core.createOnce), so a
 * later write, or a second route reaching the same path, leaves the first base
 * standing. On the Write/Edit route "first write" is the first CLAIM, taken at
 * PreToolUse: a claim whose write never lands still mints, which only makes the
 * base earlier than the write it stood for. The two rewrites are acceptHead's
 * and post-commit's advanceBases (#114).
 *
 * FAILS OPEN (mantahostels#103 §6): a mint that cannot write logs and records nothing,
 * which reads as "no base" and falls back to the session's.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795). This family requires core alone, so no cycle reaches it.
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const core = require("./arbiter-core.js");
const { caught } = require("./caught.js");
const { GIT_MODE } = require("./git-mode.js");

/** @typedef {import("./arbiter-records.js").Base} Base */

/**
 * How long a base is kept. A week, as observations and the write ledger are.
 *
 * mtime is the FIRST write's, refreshed by acceptHead and advanceBases, so the sweep spares a live
 * session's records whatever their age: a lost per-path base would fall back
 * to the session base, an earlier HEAD.
 */
const BASE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** HEAD's sha, or null on an unborn branch or a git that will not answer. */
const readHeadSha = () => core.git(["rev-parse", "--verify", "-q", "HEAD"]);

/**
 * `rel`'s blob at `head`, or null where the path is absent there — an addition,
 * which the gate skips.
 * @param {string} head
 * @param {string} rel
 */
const readBlobAt = (head, rel) =>
	core.git(["rev-parse", "--verify", "-q", `${head}:${rel}`]);

/**
 * readBlobAt, telling an absent path (null) from a git that would not answer
 * (undefined): the gate passes the first and must report the second.
 * @param {string} head
 * @param {string} rel
 */
function readBlobOrFault(head, rel) {
	const blob = readBlobAt(head, rel);
	if (blob) return blob;
	const listed = core.git(["ls-tree", "--name-only", head, "--", rel]);
	return listed === "" ? null : undefined;
}

/**
 * Record HEAD's blob for `rel` as `sessionId`'s base, unless one stands already.
 * Returns the record now on disk for this pair, or null where none could be
 * minted — no session, no HEAD, a store that will not write.
 *
 * WHOLE-FILE, on a regioned path as on any other: a commit stages files, never
 * regions.
 * @param {string} rel
 * @param {string|null} sessionId
 */
function mintBase(rel, sessionId) {
	if (!sessionId) return null;
	rel = core.subjectPath(rel);
	const file = core.paths.base(rel, sessionId);
	try {
		// The common case — every write after the first — costs one stat and no git.
		if (fs.existsSync(file)) return core.readRecord(file);
		const head = readHeadSha();
		if (!head) return null;
		const record = {
			path: rel,
			sessionId,
			head,
			blob: readBlobAt(head, rel),
			at: new Date().toISOString(),
		};
		fs.mkdirSync(core.paths.basesDir(), { recursive: true });
		return core.createOnce(file, record) ? record : core.readRecord(file);
	} catch (e) {
		core.logError(`base ${rel}`, e);
		return null;
	}
}

/**
 * Record HEAD as `sessionId`'s fallback base, once per session: SessionStart
 * fires again on resume, clear and compact, and those keep the first.
 * @param {string|null} sessionId
 */
function mintSessionBase(sessionId) {
	if (!sessionId) return null;
	const file = core.paths.sessionBase(sessionId);
	try {
		if (fs.existsSync(file)) return core.readRecord(file);
		const head = readHeadSha();
		if (!head) return null;
		const record = { sessionId, head, at: new Date().toISOString() };
		fs.mkdirSync(core.paths.sessionBasesDir(), { recursive: true });
		return core.createOnce(file, record) ? record : core.readRecord(file);
	} catch (e) {
		core.logError(`session base ${sessionId}`, e);
		return null;
	}
}

const noPause = () => {
	/* a base is linked into place whole, never torn, so no probe waits */
};

/**
 * The base `rel` is judged against for `sessionId` — null where the session
 * has neither record — with the fault that left it null, where one did, or
 * that sent it to the session base, the per-path record not reading.
 *
 * A per-path record that is absent, torn or unreadable falls through to the
 * session base rather than being skipped: a damaged record must not become a
 * hole (#100 story 25).
 * @param {string} rel
 * @param {string} sessionId
 * @returns {{base: Base|null, fault: string|null}}
 */
function resolveBase(rel, sessionId) {
	const read = (/** @type {string} */ file, /** @type {string} */ where) =>
		core.readRecordOrFlag(file, where, noPause);
	const own = read(core.paths.base(rel, sessionId), `base ${rel}`);
	if (
		!own.unreadable &&
		typeof own.record?.head === "string" &&
		own.record.head
	)
		return {
			base: {
				source: /** @type {const} */ ("path"),
				head: own.record.head,
				blob: own.record.blob ?? null,
			},
			fault: null,
		};
	const session = read(
		core.paths.sessionBase(sessionId),
		`session base ${sessionId}`,
	);
	const head = session.unreadable ? null : session.record?.head;
	if (typeof head !== "string" || !head) {
		let bad = null;
		if (session.unreadable) bad = session;
		else if (own.unreadable) bad = own;
		return { base: null, fault: bad ? `${bad.reason}: ${bad.file}` : null };
	}
	const blob = readBlobOrFault(head, rel);
	if (blob === undefined)
		return { base: null, fault: `git could not read ${rel} at ${head}` };
	return {
		base: { source: /** @type {const} */ ("session"), head, blob },
		fault: own.unreadable ? `${own.reason}: ${own.file}` : null,
	};
}

/**
 * Lines changed between two blobs, `git diff --numstat`'s added + removed; null
 * for a binary pair, which has no line count, and undefined where git could not
 * answer.
 * @param {string} a
 * @param {string} b
 */
function distance(a, b) {
	const out = core.git(["diff", "--numstat", a, b]);
	if (out === null) return;
	if (out === "") return 0;
	const [added, removed] = out.split("\t");
	if (added === "-") return null;
	return Number(added) + Number(removed);
}

/**
 * #100's stale-write-back rule for one staged path (#111). With B the base
 * blob, H HEAD's and S the staged one:
 *
 *   B = H, or S = H                       pass
 *   S nearer B than H, in changed lines   refuse
 *
 * A path absent at the base or at HEAD, and a binary one, pass. Returns
 * `{verdict: "pass"}`; `{verdict: "refuse", base, commits}`, `commits` being
 * the `<short sha> <subject>` lines that touched the path since the base, null
 * where git would not list them; or
 * `{verdict: "unknown", fault}`, which the caller lets through and reports.
 * @param {string} rel
 * @param {string} sessionId
 * @param {string} staged the staged blob, any spelling git resolves
 * @returns {{verdict: "pass"}
 *   | {verdict: "refuse", base: Base, commits: string[]|null}
 *   | {verdict: "unknown", fault: string}}
 */
function judgeStaged(rel, sessionId, staged) {
	rel = core.subjectPath(rel);
	const { base, fault } = resolveBase(rel, sessionId);
	if (!base) return fault ? { verdict: "unknown", fault } : PASS;
	const head = readHeadSha();
	if (!head) return { verdict: "unknown", fault: "git could not read HEAD" };
	const headBlob = readBlobOrFault(head, rel);
	if (headBlob === undefined)
		return { verdict: "unknown", fault: `git could not read ${rel} at HEAD` };
	if (!base.blob || !headBlob || base.blob === headBlob) return PASS;
	const stagedBlob = core.git([
		"rev-parse",
		"--verify",
		"-q",
		`${staged}^{blob}`,
	]);
	if (!stagedBlob) return { verdict: "unknown", fault: `no blob ${staged}` };
	if (stagedBlob === headBlob) return PASS;
	const toBase = distance(stagedBlob, base.blob);
	const toHead = distance(stagedBlob, headBlob);
	if (toBase === undefined || toHead === undefined)
		return { verdict: "unknown", fault: "git could not diff the blobs" };
	if (toBase === null || toHead === null || toBase >= toHead) return PASS;
	return {
		verdict: "refuse",
		base,
		commits: readCommitsSince(base, head, rel),
	};
}

/**
 * The `<short sha> <subject>` lines that touched `rel` between the base's HEAD
 * and `head`, null where git would not list them.
 * @param {Base} base
 * @param {string} head
 * @param {string} rel
 * @returns {string[]|null}
 */
function readCommitsSince(base, head, rel) {
	const log = core.git([
		"log",
		"--format=%h %s",
		`${base.head}..${head}`,
		"--",
		rel,
	]);
	if (log === null) return null;
	return log ? log.split("\n") : [];
}

/**
 * The paths this commit MODIFIES, each with its staged blob — the set the
 * pre-commit gate judges (#113). Additions, deletions and gitlinks are left
 * out, and a rename reads as one of each. Read from whatever index
 * GIT_INDEX_FILE names, which git sets for a hook and which reaches here through
 * the environment: a pathspec commit's temporary index, or a private one
 * (mantahostels#2557).
 *
 * `[]` on an unborn branch, where nothing can be modified; null where git
 * would not list them. Throws on a raw-diff record git printed short (#1344).
 * @returns {{rel: string, blob: string}[] | null}
 */
function readStagedModifications() {
	const head = readHeadSha();
	// No HEAD in a repo git can read is an unborn branch; anything else is a fault.
	if (!head) return core.git(["rev-parse", "--git-dir"]) === null ? null : [];
	// Untrimmed: -z output may end in a path that itself ends in whitespace.
	const out = core.gitRaw([
		"diff-index",
		"--cached",
		"--no-renames",
		"--diff-filter=M",
		"-z",
		head,
	]);
	if (out === null) return null;
	return rawRecords(out)
		.filter((r) => r.newMode !== GIT_MODE.gitlink)
		.map((r) => ({ rel: r.rel, blob: r.newSha }));
}

/**
 * The records a `-z` raw diff prints: each `:<mode> <mode> <sha> <sha> <status>`
 * header and the path after it, as two NUL-ended fields.
 * @param {string} out
 * @returns {{newMode: string, newSha: string, status: string, rel: string}[]}
 * @throws {Error} on a header short of its five fields
 */
function rawRecords(out) {
	const fields = out.split("\0");
	const records = [];
	for (let i = 0; ; i += 2) {
		const header = fields[i];
		const rel = fields[i + 1];
		if (header === undefined || rel === undefined) return records;
		const [, newMode, , newSha, status] = header.split(" ");
		if (newMode === undefined || newSha === undefined || status === undefined)
			throw new Error(
				`git printed a raw diff header short of five fields: ${header}`,
			);
		records.push({ newMode, newSha, status, rel });
	}
}

/**
 * judgeStaged over readStagedModifications' list, each entry gaining its verdict.
 *
 * A path its base's tree agrees with HEAD on passes unjudged, off one
 * `git diff --name-only` per distinct base commit, which keeps a wide
 * regeneration inside the gate's timeout (#113). The head is resolveBase's own choice, read without git; where there
 * is none, or the diff fails, the path is judged in full.
 * @param {{rel: string, blob: string}[]} entries
 * @param {string} sessionId
 */
function judgeStagedAll(entries, sessionId) {
	/** @type {Map<string, Set<string>|null>} */
	const changed = new Map();
	const readChangedSince = (/** @type {string} */ head) => {
		if (!changed.has(head)) {
			const out = core.gitRaw([
				"diff",
				"--name-only",
				"--no-renames",
				"-z",
				head,
				"HEAD",
			]);
			changed.set(
				head,
				out === null ? null : new Set(out.split("\0").filter(Boolean)),
			);
		}
		return changed.get(head);
	};
	return entries.map(({ rel, blob }) => {
		const head = readRecordedHead(core.subjectPath(rel), sessionId);
		const moved = head ? readChangedSince(head) : null;
		const verdict =
			moved && !moved.has(rel) ? PASS : judgeStaged(rel, sessionId, blob);
		return { rel, verdict };
	});
}

/**
 * The commit resolveBase would take `rel`'s base from, read off the records
 * alone; null where neither names one.
 * @param {string} rel
 * @param {string} sessionId
 */
function readRecordedHead(rel, sessionId) {
	for (const file of [
		core.paths.base(rel, sessionId),
		core.paths.sessionBase(sessionId),
	]) {
		const read = core.readRecordOrFlag(file, rel, noPause);
		const head = read.unreadable ? null : read.record?.head;
		if (typeof head === "string" && head) return head;
	}
	return null;
}

/**
 * `accept-head` (#112): make HEAD's current blob `sessionId`'s base for `rel`,
 * the escape judgeStaged's refusal names for a revert that is meant. Reads git,
 * never writes it — the working tree and the index are untouched.
 *
 * The new record is written aside, the log entry appended from writeFileAtomic's
 * beforeRename, and only then is the record renamed into place: a log that will
 * not take refuses the accept, so no base moves unrecorded. Whether the append
 * landed tells the two faults apart, each with a fault string of its own. The
 * log is one JSON line per accept in the session's own file
 * (core.paths.acceptedHeads).
 *
 * Returns `{entry}`, the line logged, or `{fault}` where nothing was moved. A
 * rename failing after the append appends a second line retracting the first.
 * @param {string} rel
 * @param {string} sessionId
 * @returns {{entry: AcceptedHead} | {fault: string}}
 */
function acceptHead(rel, sessionId) {
	rel = core.subjectPath(rel);
	const head = readHeadSha();
	if (!head) return { fault: "git could not read HEAD" };
	const blob = readBlobOrFault(head, rel);
	if (blob === undefined) return { fault: `git could not read ${rel} at HEAD` };
	const { base: old, fault } = resolveBase(rel, sessionId);
	/** @type {AcceptedHead} */
	const entry = {
		sessionId,
		path: rel,
		oldBase: old,
		// A per-path base that would not read is logged as such, not as none.
		...(fault ? { oldBaseFault: fault } : {}),
		newBase: { head, blob },
		at: new Date().toISOString(),
	};
	const file = core.paths.base(rel, sessionId);
	let logged = false;
	try {
		writeFileAtomic(
			file,
			core.buildRecordText({ path: rel, sessionId, head, blob, at: entry.at }),
			{
				mkdir: true,
				beforeRename: () => {
					fs.mkdirSync(core.paths.acceptedHeadsDir(), { recursive: true });
					fs.appendFileSync(
						core.paths.acceptedHeads(sessionId),
						`${JSON.stringify(entry)}\n`,
					);
					logged = true;
				},
			},
		);
	} catch (e) {
		const { code, message } = caught(e);
		core.logError(`accept-head ${rel}`, e);
		if (!logged)
			return {
				fault: `the accept could not be recorded (${code || message})`,
			};
		const why = `the base would not move (${code || message})`;
		try {
			fs.appendFileSync(
				core.paths.acceptedHeads(sessionId),
				`${JSON.stringify({ retracts: entry.at, path: rel, why })}\n`,
			);
			return { fault: `${why}; the log entry is retracted` };
		} catch {
			return { fault: `${why}, and the log entry says it did` };
		}
	}
	return { entry };
}

/**
 * Post-commit's advance (#114): every path `commit` landed takes that commit's
 * blob as `sessionId`'s base, so the gate judges the session's next edit
 * against its own last commit rather than against a base that predates it. A
 * deleted path's blob is null, which the gate passes as it passes an addition.
 * Gitlinks are left out, as readStagedModifications leaves them, and a merge
 * advances nothing: `diff-tree` lists no paths for one.
 *
 * Unlogged, unlike acceptHead: it records the session's own commit, never a
 * revert the founder must audit.
 *
 * Returns the count advanced, and a fault where git would not list the commit
 * or a record would not write — the rest still advance. Throws on a raw-diff
 * record git printed short (#1344), a broken invariant rather than a fault.
 * @param {string} commit a commit sha
 * @param {string} sessionId
 * @returns {{advanced: number, fault: string|null}}
 */
function advanceBases(commit, sessionId) {
	const out = core.gitRaw([
		"diff-tree",
		"-r",
		"-z",
		"--root",
		"--no-commit-id",
		"--no-renames",
		commit,
	]);
	if (out === null) {
		const fault = `git could not list ${commit}'s paths`;
		core.logError("advance bases", new Error(fault));
		return { advanced: 0, fault };
	}
	const at = new Date().toISOString();
	let advanced = 0;
	let fault = null;
	for (const { newMode, newSha, status, rel: raw } of rawRecords(out)) {
		if (newMode === GIT_MODE.gitlink) continue;
		const rel = core.subjectPath(raw);
		const blob = status === "D" ? null : newSha;
		try {
			writeFileAtomic(
				core.paths.base(rel, sessionId),
				core.buildRecordText({ path: rel, sessionId, head: commit, blob, at }),
				{ mkdir: true },
			);
			advanced++;
		} catch (e) {
			const { code, message } = caught(e);
			core.logError(`advance base ${rel}`, e);
			fault ??= `${rel}'s base would not write (${code || message})`;
		}
	}
	return { advanced, fault };
}

/**
 * @typedef {{sessionId: string, path: string, oldBase: Base|null,
 *   oldBaseFault?: string, newBase: {head: string, blob: string|null},
 *   at: string}} AcceptedHead
 */

const PASS = /** @type {{verdict: "pass"}} */ (
	Object.freeze({ verdict: "pass" })
);

module.exports = {
	acceptHead,
	advanceBases,
	BASE_AGE_MS,
	judgeStaged,
	judgeStagedAll,
	mintBase,
	mintSessionBase,
	readStagedModifications,
};
