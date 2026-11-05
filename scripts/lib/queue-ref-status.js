/*
 * queue-ref-status.js — what became of a session's queue ref (#4485, spec
 * #4458): each stay of `queue/<name>` the queue log, the drop record or the
 * remote shows, read as one of
 *
 *   - queued: the ref waits and the live batch does not hold it at the sha
 *     it holds now, as where it moved after its snapshot;
 *   - testing: the live batch holds it at its snapshot sha;
 *   - landed: a land row names it, with the `main` sha it reached, off the
 *     landed batch record, else the oldest green-ledger sha on `main`'s
 *     first-parent path from it;
 *   - dropped: a drop row or the drop record names it, with its fix ticket
 *     off the drop record and the `dropped/<name>[-sha9]` ref holding it.
 *
 * Where the record that would answer is missing or torn, the line says so
 * and claims no state it cannot read. Stays read oldest first, the ref's
 * waiting sha last.
 */

const { execGit } = require("./git.js");
const { fileLedger, landerFiles, short } = require("./lander.js");
const { DROPPED_PREFIX, QUEUE_PREFIX } = require("./landing-refs.js");
const {
	queueLanderFiles,
	readBatchFile,
	readDropFile,
} = require("./queue-lander-adapters.js");

/**
 * @template T
 * @typedef {import("./queue-lander-adapters.js").RecordRead<T>} RecordRead
 */
/**
 * @typedef {import("./queue-lander.js").Batch} Batch
 * @typedef {import("./queue-lander.js").Drop} Drop
 * @typedef {import("./queue-lander.js").DroppedRef} DroppedRef
 * @typedef {import("./queue-log.js").LoggedRow} LoggedRow
 * @typedef {object} RefReading
 * @property {string} name after `queue/`
 * @property {{sha: string}|null} waiting the remote's `queue/<name>`
 * @property {readonly LoggedRow[]} rows the queue log's, oldest first
 * @property {RecordRead<Batch>} batch
 * @property {RecordRead<readonly Drop[]>} drops
 * @property {readonly DroppedRef[]} dropped the remote's `dropped/*` refs
 * @property {(sha: string) => string|null} mainReached the green ledger's
 *   `main` sha that first held `sha`, null where it names none
 * @typedef {{state: "queued", name: string, sha: string,
 *     snapshot: string|null}
 *   | {state: "testing", name: string, sha: string}
 *   | {state: "unread", name: string, sha: string, why: "torn"|"absent"}
 *   | {state: "landed", name: string, sha: string, main: string|null}
 *   | {state: "dropped", name: string, sha: string, ref: string|null,
 *     ticket: number|null, record: "read"|"torn"|"no-entry"}} RefState
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
 * @param {RefReading} r
 * @param {string} sha
 * @returns {RefState}
 */
function landedState(r, sha) {
	const b = r.batch.kind === "read" ? r.batch.value : null;
	const main =
		b?.phase === "landed" && memberOf(b, r.name)?.sha === sha
			? b.integration
			: null;
	return {
		state: "landed",
		name: r.name,
		sha,
		main: main ?? r.mainReached(sha),
	};
}

/**
 * @param {RefReading} r
 * @param {string} sha
 * @returns {RefState}
 */
function droppedState(r, sha) {
	const plain = `${DROPPED_PREFIX}${r.name}`;
	const onRemote = r.dropped.find(
		(d) => d.sha === sha && (d.ref === plain || d.ref.startsWith(`${plain}-`)),
	)?.ref;
	if (r.drops.kind === "torn")
		return {
			state: "dropped",
			name: r.name,
			sha,
			ref: onRemote ?? null,
			ticket: null,
			record: "torn",
		};
	const entry = (r.drops.kind === "read" ? r.drops.value : []).find(
		(d) => d.name === r.name && d.sha === sha,
	);
	return {
		state: "dropped",
		name: r.name,
		sha,
		ref: entry?.ref ?? onRemote ?? null,
		ticket: entry?.ticket ?? null,
		record: entry ? "read" : "no-entry",
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
	if (r.batch.kind === "torn")
		return { state: "unread", name, sha, why: "torn" };
	if (r.batch.kind === "absent")
		return mine.findLast((x) => x.sha === sha)?.event === "take"
			? { state: "unread", name, sha, why: "absent" }
			: { state: "queued", name, sha, snapshot: null };
	const b = r.batch.value;
	const m = b.phase === "landed" ? undefined : memberOf(b, name);
	if (m?.sha === sha) return { state: "testing", name, sha };
	return { state: "queued", name, sha, snapshot: m?.sha ?? null };
}

/**
 * @param {RefReading} r
 * @returns {RefState[]}
 */
function queueRefStates(r) {
	const ref = `refs/heads/${QUEUE_PREFIX}${r.name}`;
	const mine = r.rows.filter((x) => x.ref === ref);
	/** @type {Map<string, RefState>} */
	const left = new Map();
	for (const x of mine) {
		if (left.has(x.sha)) continue;
		if (x.event === "land") left.set(x.sha, landedState(r, x.sha));
		if (x.event === "drop") left.set(x.sha, droppedState(r, x.sha));
	}
	for (const d of r.drops.kind === "read" ? r.drops.value : [])
		if (d.name === r.name && !left.has(d.sha))
			left.set(d.sha, droppedState(r, d.sha));
	const states = [...left.values()];
	if (r.waiting && !left.has(r.waiting.sha))
		states.push(waitingState(r, r.waiting.sha, mine));
	return states;
}

/** @param {Extract<RefState, {state: "dropped"}>} s */
function dropText(s) {
	const kept = s.ref ? `kept as ${s.ref}` : "no dropped ref holds it";
	if (s.record === "torn")
		return `${kept}; the drop record is torn, so its fix ticket is unknown`;
	if (s.record === "no-entry")
		return `${kept}; the drop record holds no entry for it, so its fix ticket is unknown`;
	return `${kept}, ${s.ticket === null ? "its fix ticket not yet filed" : `fix ticket #${s.ticket}`}`;
}

/**
 * @param {RefState} s
 * @returns {string}
 */
function buildQueueRefLine(s) {
	const at = `${QUEUE_PREFIX}${s.name} at ${short(s.sha)}`;
	switch (s.state) {
		case "queued":
			return s.snapshot === null
				? `queued: ${at} — waiting for the lander's next batch`
				: `queued: ${at} — moved past its snapshot ${short(s.snapshot)} in the batch under test, so it waits for the next batch`;
		case "testing":
			return `testing: ${at} — in the lander's batch under test`;
		case "unread":
			return s.why === "torn"
				? `queued or testing: ${at} — the batch record is torn, so whether the batch under test holds it is unknown`
				: `queued or testing: ${at} — the queue log has it taken, but there is no batch record to say whether the batch under test holds it`;
		case "landed":
			return s.main === null
				? `landed: ${at} — on main, but neither the batch record nor the green ledger names the main sha it reached`
				: `landed: ${at} — on main at ${short(s.main)}`;
		case "dropped":
			return `dropped: ${at} — ${dropText(s)}`;
	}
}

/**
 * The green ledger's sha that first held `sha` on `main`'s first-parent
 * path, as `main` moves only to a ledgered sha; null where the ledger names
 * none, or git cannot walk it.
 * @param {string} root
 * @param {string|null} main
 * @returns {(sha: string) => string|null}
 */
const ledgerMainReached = (root, main) => (sha) => {
	const green = new Set(fileLedger(landerFiles(root).ledger).readShas());
	if (green.has(sha)) return sha;
	if (main === null) return null;
	let path;
	try {
		path = execGit(
			["rev-list", "--first-parent", "--ancestry-path", `${sha}..${main}`],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
	} catch {
		return null;
	}
	return (
		path
			.split("\n")
			.filter(Boolean)
			.reverse()
			.find((s) => green.has(s)) ?? null
	);
};

/**
 * Each stay of `queue/<name>`, off `root`'s records and the remote's refs
 * and queue log already read.
 * @param {string} root the canonical checkout's root
 * @param {string} name after `queue/`
 * @param {import("./queue-lander.js").QueueRefs} refs
 * @param {readonly LoggedRow[]} rows
 * @returns {RefState[]}
 */
function readQueueRefStates(root, name, refs, rows) {
	const files = queueLanderFiles(root);
	const held = refs.queue.find((q) => q.name === name);
	return queueRefStates({
		name,
		waiting: held ? { sha: held.sha } : null,
		rows,
		batch: readBatchFile(files.batch),
		drops: readDropFile(files.drops),
		dropped: refs.dropped,
		mainReached: ledgerMainReached(root, refs.main),
	});
}

module.exports = { buildQueueRefLine, queueRefStates, readQueueRefStates };
