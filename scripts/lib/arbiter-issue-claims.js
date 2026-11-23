const fs = require("node:fs");
const path = require("node:path");
const { isListedLive } = require("./agent-liveness.js");
const core = require("./arbiter-core.js");
const {
	readCurrentBootId,
	holderAlive,
	readProcStartOf,
} = require("./arbiter-proc.js");
const { isIssueClaimRecord, isMutexRecord } = require("./arbiter-records.js");
const { sleepSync } = require("./sleep-sync.js");
const { caught, ignoreFailure } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").IssueClaimRecord} IssueClaimRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */
/** @typedef {import("./arbiter-records.js").MutexRecord} MutexRecord */

// guess, origin untraced, #5621
const ISSUE_CLAIM_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** @param {number|string|null} issue */
function issueNumber(issue) {
	const n = Number(issue);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * @param {string} file
 * @param {string} where
 * @returns {IssueClaimRecord|null}
 */
function readIssueClaimOrLog(file, where) {
	const record = core.readRecordOrLog(file, where);
	return isIssueClaimRecord(record) ? record : null;
}

/**
 * @param {{issue: number} & Partial<IssueClaimRecord>} spec
 * @returns {IssueClaimRecord}
 */
function newIssueClaim({
	issue,
	sessionId = null,
	claimedAt = new Date().toISOString(),
}) {
	return { issue, sessionId, claimedAt };
}

/**
 * @param {number} n
 * @returns {{file: string, record: IssueClaimRecord|null}[]}
 */
function scanIssueClaims(n) {
	let files;
	try {
		files = fs.readdirSync(core.paths.issueClaimsDir());
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw e;
	}
	return files
		.filter((f) => f.startsWith(`${n}-`) && f.endsWith(".json"))
		.map((f) => {
			const file = path.join(core.paths.issueClaimsDir(), f);
			return { file, record: readIssueClaimOrLog(file, `issue-claims ${n}`) };
		});
}

/**
 * @param {number|string} issue
 * @returns {{file: string, record: IssueClaimRecord}[]}
 */
function readIssueClaims(issue) {
	const n = issueNumber(issue);
	if (n === null) return [];
	return scanIssueClaims(n).flatMap(({ file, record }) =>
		record ? [{ file, record }] : [],
	);
}

// #5529
/**
 * @param {number|string} issue
 * @param {{sessionId: string|null}} me
 */
function claimIssue(issue, me) {
	const n = issueNumber(issue);
	if (n === null) return { status: "invalid" };
	if (!me?.sessionId) return { status: "unidentified" };
	try {
		fs.mkdirSync(core.paths.issueClaimsDir(), { recursive: true });
		const file = core.paths.issueClaim(n, me.sessionId);
		const existing = core.readRecord(file);
		const record = newIssueClaim({
			issue: n,
			sessionId: me.sessionId,
			claimedAt: isIssueClaimRecord(existing) ? existing.claimedAt : undefined,
		});
		core.writeRecord(file, record);
		return { status: "claimed", record };
	} catch (e) {
		core.logError(`claim-issue ${n}`, e);
		return { status: "failed", error: e };
	}
}

/**
 * @param {number|string} issue
 * @param {{sessionId: string|null}} me
 */
function releaseIssue(issue, me) {
	const n = issueNumber(issue);
	if (n === null) return { status: "invalid" };
	if (!me?.sessionId) return { status: "unidentified" };
	try {
		fs.unlinkSync(core.paths.issueClaim(n, me.sessionId));
		return { status: "released" };
	} catch (e) {
		if (caught(e).code === "ENOENT") return { status: "none" };
		core.logError(`release-issue ${n}`, e);
		return { status: "failed", error: e };
	}
}

// guess, #5529
const mutexWaitMs = () => Number(process.env.WFC_CLAIM_WAIT_MS) || 5000;
const MUTEX_POLL_MS = 10;

/**
 * @param {string} file
 * @param {MutexRecord|null} held
 */
function breakStaleMutex(file, held) {
	const aside = `${file}.stale-${process.pid}`;
	ignoreFailure(() => {
		fs.renameSync(file, aside);
		const read = core.readRecord(aside);
		const moved = isMutexRecord(read) ? read : null;
		if (moved?.pid !== held?.pid || moved?.procStart !== held?.procStart)
			fs.linkSync(aside, file);
	});
	fs.rmSync(aside, { force: true });
}

/**
 * @param {number} n
 * @param {(stillMine: () => boolean) => ExclusiveClaim} fn
 * @returns {ExclusiveClaim}
 */
function withIssueMutex(n, fn) {
	const dir = core.paths.issueClaimsDir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `.mutex-${n}`);
	const body = {
		pid: process.pid,
		procStart: readProcStartOf(process.pid),
		bootId: readCurrentBootId() || undefined,
	};
	const stillMine = () => {
		const now = core.readRecord(file);
		return (
			isMutexRecord(now) &&
			now.pid === body.pid &&
			now.procStart === body.procStart
		);
	};
	const deadline = Date.now() + mutexWaitMs();
	while (!core.createOnce(file, body)) {
		if (Date.now() > deadline) return { status: "busy" };
		const read = core.readRecord(file);
		const held = isMutexRecord(read) ? read : null;
		if (held && holderAlive(held)) {
			sleepSync(MUTEX_POLL_MS);
			continue;
		}
		if (!held && !fs.existsSync(file)) continue;
		breakStaleMutex(file, held);
	}
	try {
		return fn(stillMine);
	} finally {
		if (stillMine()) fs.rmSync(file, { force: true });
	}
}

/**
 * @typedef {{status: "invalid"|"unidentified"|"busy"}
 *   | {status: "unreadable", why: string}
 *   | {status: "held", holder: IssueClaimRecord}
 *   | {status: "claimed"|"reclaimed", record: IssueClaimRecord}} ExclusiveClaim
 * @param {number|string} issue
 * @param {{sessionId: string|null}} me
 * @param {{ids?: Set<string>|null, terminal?: Set<string>, why?: string|null}} listed
 * @param {number} listedAt
 * @returns {ExclusiveClaim}
 */
function claimIssueExclusive(issue, me, listed, listedAt) {
	const n = issueNumber(issue);
	if (n === null) return { status: "invalid" };
	const sessionId = me?.sessionId;
	if (!sessionId) return { status: "unidentified" };
	const live = listed?.ids;
	const terminal = listed?.terminal;
	if (!live)
		return {
			status: "unreadable",
			why: `session liveness could not be read: ${listed?.why || "no answer"}`,
		};
	const dir = core.paths.issueClaimsDir();
	try {
		return withIssueMutex(n, (stillMine) => {
			const records = [];
			for (const { file, record } of scanIssueClaims(n)) {
				if (!record)
					return {
						status: "unreadable",
						why: `the issue-claim record ${file} could not be read`,
					};
				records.push(record);
			}
			const holdMs = Number(process.env.WFC_CLAIM_HOLD_MS);
			if (holdMs > 0) sleepSync(holdMs);
			const holder = records
				.filter(
					(r) =>
						r.sessionId !== sessionId &&
						(isListedLive(r.sessionId, live, terminal) ||
							Date.parse(r.claimedAt) >= listedAt),
				)
				.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt))[0];
			if (holder) return { status: "held", holder };
			const own = records.find((r) => r.sessionId === sessionId);
			if (own) return { status: "reclaimed", record: own };
			const record = newIssueClaim({ issue: n, sessionId });
			const file = core.paths.issueClaim(n, sessionId);
			core.writeRecord(file, record);
			if (stillMine()) return { status: "claimed", record };
			fs.rmSync(file, { force: true });
			return { status: "busy" };
		});
	} catch (e) {
		const { code, message } = caught(e);
		core.logError(`claim-issue ${n}`, e);
		return {
			status: "unreadable",
			why: `the issue-claim store at ${dir} could not be read or written (${code || message})`,
		};
	}
}

/**
 * @param {string} [root]
 * @returns {{claims: IssueClaimRecord[], why: string|null}|null}
 */
function listIssueClaims(root) {
	const dir = core.paths.issueClaimsDir(root);
	let files;
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return { claims: [], why: null };
		core.logError("issue-claims list", e);
		return null;
	}
	const records = files.map((f) =>
		readIssueClaimOrLog(path.join(dir, f), "issue-claims list"),
	);
	const claims = records.flatMap((r) => (r ? [r] : []));
	const dropped = records.length - claims.length;
	return {
		claims,
		why: dropped
			? `${dropped} issue-claim record${dropped === 1 ? "" : "s"} could not be read and ${dropped === 1 ? "was" : "were"} dropped, so what is claimed may be incomplete`
			: null,
	};
}

/**
 * @param {string} sid
 * @returns {number[]}
 */
function readClaimedIssues(sid) {
	const listed = listIssueClaims();
	if (!listed || listed.why) return [];
	return listed.claims
		.filter((c) => c.sessionId === sid)
		.sort((a, b) => b.claimedAt.localeCompare(a.claimedAt))
		.map((c) => c.issue);
}

/**
 * @param {NonNullable<ReturnType<typeof listIssueClaims>>["claims"]} claims
 * @param {Set<string>|null} live
 * @param {Set<string>|undefined} terminal
 */
function standingClaims(claims, live, terminal) {
	const held = new Map();
	for (const c of claims) {
		if (live !== null && !isListedLive(c.sessionId, live, terminal)) continue;
		if (!held.has(c.issue)) held.set(c.issue, c.sessionId);
	}
	return held;
}

/**
 * @param {{ids?: Set<string>|null, terminal?: Set<string>, why?: string|null}|null|undefined} listed
 * @param {string} [root]
 */
function heldIssues(listed, root) {
	const listedClaims = listIssueClaims(root);
	if (listedClaims === null)
		return {
			held: new Map(),
			kept: false,
			why: "the issue-claim store could not be read, so no assignment was checked against it",
		};
	const { claims, why: claimsWhy } = listedClaims;
	const live = listed?.ids ?? null;
	const terminal = listed?.terminal;
	const held = standingClaims(claims, live, terminal);
	if (claimsWhy) {
		const liveWhy =
			live === null ? listed?.why || "liveness was not read at all" : null;
		return {
			held,
			kept: false,
			why: liveWhy ? `${claimsWhy}; also, ${liveWhy}` : claimsWhy,
		};
	}
	return {
		held,
		kept: live === null,
		why: live === null ? listed?.why || "liveness was not read at all" : null,
	};
}

/** @param {LivenessOracle|undefined} liveness */
function pruneIssueClaims(liveness) {
	const live = core.readLiveOrLog("pruneIssueClaims");
	if (live === null) return;
	const byRegistry = (/** @type {string} */ f) =>
		[...live].some((id) => f.endsWith(core.pairSuffix(id)));

	if (
		!core.agedUnspared(
			core.paths.issueClaimsDir(),
			ISSUE_CLAIM_AGE_MS,
			byRegistry,
		)
	)
		return;

	const listed = typeof liveness === "function" ? liveness() : {};
	if (!listed?.ids) {
		core.logError(
			"pruneIssueClaims",
			new Error(listed?.why || "no liveness oracle was passed"),
		);
		return;
	}
	const spared = new Set(
		[...live, ...listed.ids].map((id) => core.pairSuffix(id)),
	);
	core.sweepAged(core.paths.issueClaimsDir(), ISSUE_CLAIM_AGE_MS, (f) =>
		[...spared].some((s) => f.endsWith(s)),
	);
}

module.exports = {
	claimIssue,
	claimIssueExclusive,
	readClaimedIssues,
	heldIssues,
	listIssueClaims,
	pruneIssueClaims,
	readIssueClaims,
	releaseIssue,
};
