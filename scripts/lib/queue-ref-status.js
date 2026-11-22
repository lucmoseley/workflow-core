const fs = require("node:fs");
const path = require("node:path");
const { parseErrorText } = require("./caught.js");
const { buildDropEvidence } = require("./drop-evidence.js");
const { execGit } = require("./git.js");
const { fileLedger, queueLanderFiles } = require("./lander-files.js");
const { isAncestor, parseRefusal, short } = require("./lander-git.js");
const {
	droppedRefsOf,
	ownQueueName,
	queueBranch,
	queueHead,
} = require("./landing-refs.js");
const { pipelineRecord, readDropFile } = require("./lander-records.js");
const { batchesOf, retakesMoved } = require("./queue-lander.js");

/**
 * @template T
 * @typedef {import("./lander-records.js").RecordRead<T>} RecordRead
 */
/**
 * @typedef {import("./queue-lander.js").Batch} Batch
 * @typedef {import("./queue-lander.js").Pipeline} Pipeline
 * @typedef {import("./queue-lander.js").Drop} Drop
 * @typedef {import("./queue-lander.js").DroppedRef} DroppedRef
 * @typedef {import("./queue-log.js").LoggedRow} LoggedRow
 * @typedef {{fault: string}} Unwalked
 * @typedef {object} RefReading
 * @property {string} name
 * @property {number} since
 * @property {{sha: string}|null} waiting
 * @property {readonly LoggedRow[]} rows
 * @property {RecordRead<Pipeline>} pipeline
 * @property {RecordRead<readonly Drop[]>} drops
 * @property {readonly DroppedRef[]} dropped
 * @property {string|null} main
 * @property {(sha: string) => boolean|Unwalked} mainHolds
 * @property {(sha: string) => string|null|Unwalked} mainReached
 * @typedef {{state: "queued", name: string, sha: string,
 *     snapshot: string|null, retaken?: boolean}
 *   | {state: "testing", name: string, sha: string}
 *   | {state: "unread", name: string, sha: string, why: "torn"|"absent"}
 *   | {state: "unwalked", name: string, sha: string, fault: string}
 *   | {state: "landed", name: string, sha: string,
 *     main: string|null|Unwalked}
 *   | {state: "dropped", name: string, sha: string, ref: string|null,
 *     record: "torn"|"no-entry"}
 *   | {state: "dropped", name: string, sha: string, ref: string|null,
 *     record: "read", drop: Drop, held: boolean}} RefState
 */

/**
 * @param {Batch} b
 * @param {string} name
 */
const memberOf = (b, name) =>
	b.deferred.includes(name) || b.dropped.includes(name)
		? undefined
		: b.members.find((m) => m.name === name);

/**
 * @param {Pipeline} p
 * @param {string} name
 * @param {boolean} landed
 */
const holderOf = (p, name, landed) =>
	batchesOf(p).find(
		(b) => (b.phase === "landed") === landed && memberOf(b, name),
	);

/**
 * @param {RefReading} r
 * @param {string} sha
 * @returns {RefState}
 */
function landedState(r, sha) {
	const b =
		r.pipeline.kind === "read"
			? holderOf(r.pipeline.value, r.name, true)
			: null;
	const main = b && memberOf(b, r.name)?.sha === sha ? b.integration : null;
	return {
		state: "landed",
		name: r.name,
		sha,
		main: main ?? r.mainReached(sha),
	};
}

/**
 * @param {RefReading} r
 * @returns {Drop[]}
 */
const ownDrops = (r) =>
	r.drops.kind === "read"
		? r.drops.value.filter((d) => d.name === r.name && d.at >= r.since)
		: [];

/**
 * @param {RefReading} r
 * @param {string} sha
 * @returns {RefState}
 */
function droppedState(r, sha) {
	const names = droppedRefsOf(r.name, sha);
	const onRemote = r.dropped.find(
		(d) => d.sha === sha && names.includes(d.ref),
	)?.ref;
	const dropped = {
		state: /** @type {const} */ ("dropped"),
		name: r.name,
		sha,
	};
	const unread = { ...dropped, ref: onRemote ?? null };
	if (r.drops.kind === "torn") return { ...unread, record: "torn" };
	const entry = ownDrops(r).find((d) => d.sha === sha);
	if (!entry) return { ...unread, record: "no-entry" };
	return {
		...dropped,
		ref: entry.reapedAt === undefined ? entry.ref : null,
		record: "read",
		drop: entry,
		held: r.waiting !== null,
	};
}

/**
 * @param {RefReading} r
 * @param {string} sha
 * @param {readonly LoggedRow[]} mine
 * @returns {RefState}
 */
function waitingState(r, sha, mine) {
	const { name } = r;
	if (r.pipeline.kind === "torn")
		return { state: "unread", name, sha, why: "torn" };
	if (r.pipeline.kind === "absent")
		return mine.findLast((x) => x.sha === sha)?.event === "take"
			? { state: "unread", name, sha, why: "absent" }
			: { state: "queued", name, sha, snapshot: null };
	const b = holderOf(r.pipeline.value, name, false);
	const m = b && memberOf(b, name);
	if (!b || m?.sha !== sha)
		return {
			state: "queued",
			name,
			sha,
			snapshot: m?.sha ?? null,
			retaken: Boolean(b && m && retakesMoved(b)),
		};
	const held = r.mainHolds(sha);
	if (typeof held === "object")
		return { state: "unwalked", name, sha, fault: held.fault };
	return held
		? { state: "landed", name, sha, main: b.integration ?? r.main }
		: { state: "testing", name, sha };
}

/**
 * @param {RefReading} r
 * @returns {RefState[]}
 */
function queueRefStates(r) {
	const ref = queueHead(r.name);
	const mine = r.rows.filter((x) => x.ref === ref && x.at >= r.since);
	/** @type {Map<string, RefState>} */
	const left = new Map();
	for (const x of mine) {
		if (left.has(x.sha)) continue;
		if (x.event === "land") left.set(x.sha, landedState(r, x.sha));
		if (x.event === "drop") left.set(x.sha, droppedState(r, x.sha));
	}
	for (const d of ownDrops(r))
		if (!left.has(d.sha)) left.set(d.sha, droppedState(r, d.sha));
	const states = [...left.values()];
	if (r.waiting && !left.has(r.waiting.sha))
		states.push(waitingState(r, r.waiting.sha, mine));
	return states;
}

/**
 * @param {Drop} d
 * @param {boolean} held
 */
function standingOf(d, held) {
	if (d.state === "settled")
		return d.settledOn === undefined
			? "settled"
			: `settled at ${short(d.settledOn)}`;
	if (d.ticket !== null) return `fix ticket #${d.ticket}`;
	if (held) return "held: a newer push waits";
	return d.filingRefused === undefined
		? "returned to this session; no ticket while it works"
		: `no fix ticket, its filing refused for good: ${d.filingRefused}`;
}

/** @param {Extract<RefState, {state: "dropped"}>} s */
function dropText(s) {
	const kept = s.ref ? `kept as ${s.ref}` : "no dropped ref holds it";
	if (s.record !== "read")
		return `${kept}; the drop record ${s.record === "torn" ? "is torn" : "holds no entry for it"}, so its cause and fix ticket are unknown`;
	const { drop } = s;
	const standing = standingOf(drop, s.held);
	if (drop.reapedAt !== undefined)
		return drop.state === "settled"
			? standing
			: `${standing} (closed), dropped ref reaped`;
	return `${standing}; ${kept}\n  dropped because, ${buildDropEvidence(drop)}`;
}

/**
 * @param {RefState} s
 * @returns {string}
 */
function buildQueueRefLine(s) {
	const at = `${queueBranch(s.name)} at ${short(s.sha)}`;
	switch (s.state) {
		case "queued":
			if (s.snapshot === null)
				return `queued: ${at} — waiting for the lander's next batch`;
			return s.retaken
				? `queued: ${at} — moved past its snapshot ${short(s.snapshot)} in a batch not yet merged, which takes it at this sha`
				: `queued: ${at} — moved past its snapshot ${short(s.snapshot)} in the batch under test, so it waits for the next batch`;
		case "testing":
			return `testing: ${at} — in the lander's batch under test`;
		case "unread":
			return s.why === "torn"
				? `queued or testing: ${at} — the batch record is torn, so whether the batch under test holds it is unknown`
				: `queued or testing: ${at} — the queue log has it taken, but there is no batch record to say whether the batch under test holds it`;
		case "unwalked":
			return `testing or landed: ${at} — could not walk main: ${s.fault}`;
		case "landed":
			if (s.main === null)
				return `landed: ${at} — on main, but neither the batch record nor the green ledger names the main sha it reached`;
			return typeof s.main === "object"
				? `landed: ${at} — on main, but could not walk main: ${s.main.fault}`
				: `landed: ${at} — on main at ${short(s.main)}`;
		case "dropped":
			return `dropped: ${at} — ${dropText(s)}`;
	}
}

/**
 * @template T
 * @param {() => T} walk
 * @returns {T|Unwalked}
 */
function walked(walk) {
	try {
		return walk();
	} catch (err) {
		return { fault: parseRefusal(parseErrorText(err)) };
	}
}

/**
 * @param {string} root
 * @param {string|null} main
 * @param {ReadonlySet<string>} green
 * @returns {RefReading["mainReached"]}
 */
const ledgerMainReached = (root, main, green) => (sha) => {
	if (green.has(sha)) return sha;
	if (main === null) return null;
	return walked(
		() =>
			execGit(
				["rev-list", "--first-parent", "--ancestry-path", `${sha}..${main}`],
				{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			)
				.split("\n")
				.filter(Boolean)
				.reverse()
				.find((s) => green.has(s)) ?? null,
	);
};

/**
 * @param {string} root
 * @param {{name: string, since: number}} stay
 * @param {import("./queue-lander.js").QueueRefs} refs
 * @param {readonly LoggedRow[]} rows
 * @returns {RefState[]}
 */
function readQueueStays(root, { name, since }, refs, rows) {
	const files = queueLanderFiles(root);
	const green = new Set(fileLedger(files.ledger).readShas());
	const held = refs.queue.find((q) => q.name === name);
	const { main } = refs;
	return queueRefStates({
		name,
		since,
		waiting: held ? { sha: held.sha } : null,
		rows,
		pipeline: pipelineRecord(files.batch).read(),
		drops: readDropFile(files.drops),
		dropped: refs.dropped,
		main,
		mainHolds: (sha) =>
			main === null ? false : walked(() => isAncestor(root, sha, main)),
		mainReached: ledgerMainReached(root, main, green),
	});
}

/**
 * @param {string} root
 * @param {string|null|undefined} tree
 * @param {import("./queue-lander.js").QueueRefs} refs
 * @param {readonly LoggedRow[]} rows
 * @returns {RefState[]}
 */
function readQueueRefStates(root, tree, refs, rows) {
	const name = ownQueueName(tree, root);
	if (name === null || !tree) return [];
	const since = fs.statSync(path.join(tree, ".git")).mtimeMs;
	return readQueueStays(root, { name, since }, refs, rows);
}

module.exports = {
	buildQueueRefLine,
	readQueueRefStates,
	readQueueStays,
};
