/*
 * queue-lander.js — the landing queue's lander (#4485, spec #4458): tests
 * every waiting `queue/<name>` ref merged onto `main` in one integration
 * commit, and moves `main` to it on a green verdict at that exact sha.
 *
 * One pure state machine, `nextQueueAction`, chooses each action from the
 * remote's refs, the green and verdict ledgers, the batch record and what this
 * run has met; `runQueueLander` acts on it through injected git and tester
 * until it exits. The library does no I/O: lib/queue-lander-adapters.js holds
 * the production git and files.
 *
 * - **Batch.** Every queue ref waiting when the run frees is taken, each at the
 *   sha it then holds, in push order: the earlier push first, then the name
 *   (lib/queue-lander-adapters.js reads the push time). A push to a member's
 *   ref after that joins the next batch.
 * - **Merge.** Members merge onto `main` in that order, each a two-parent
 *   merge with the registry merge driver. A lone member that descends from
 *   `main` is the integration commit, with no merge, the adapter's
 *   `mergeMembers` telling.
 * - **Green.** The integration sha is written to the green ledger, then `main`
 *   moves to it by a plain push. Each member whose ref still holds its
 *   snapshot is then deleted, compare-and-delete against that sha; a moved one
 *   is kept and joins the next batch.
 * - **Verdicts.** A green or red reached at a sha is ledgered and survives a
 *   restart. An unknown verdict is no verdict: it lands nothing and is never
 *   ledgered, so the next run asks again.
 * - **Faults.** A step that throws a transient fault (a network blip, a spawn
 *   fault, a broken git object, a tester's `transient` no verdict, as its
 *   suite slot staying shut) is retried with backoff and the run's state
 *   kept; any other throw, or one outlasting the tries, exits naming it.
 * - A red integration verdict exits naming the red path, and a member that
 *   does not merge exits naming its drop or deferral (#4485).
 *
 * Unbuilt caller: the cutover's launcher, which starts scripts/queue-lander.js
 * on a queue push (#4485)
 */

const { caught, parseErrorText } = require("./caught.js");
const {
	isNetworkFault,
	parseRefusal,
	remote,
	short,
	verdictAt,
} = require("./lander.js");

/* Untraced, a first guess and stated as one: the codes a fork returns while
 * the machine is short of processes or memory for a moment. */
const SPAWN_FAULTS = ["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"];

/** A fault a retry can outlast that no error code names. */
class TransientFault extends Error {}

/**
 * @typedef {import("./lander.js").Verdict} Verdict
 * @typedef {import("./lander.js").QueueTester} QueueTester
 * @typedef {import("./lander.js").Ledger} Ledger
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly pushedAt: number}} QueueRef a queue ref on the remote: `name`
 *   after `queue/`, `pushedAt` its push time in ms
 * @typedef {QueueRef} Member a batch member, at its snapshot sha
 * @typedef {"merging" | "testing" | "landed"} Phase
 * @typedef {object} Batch the batch record
 * @property {readonly Member[]} members in push order
 * @property {string} onto `main` when its members were taken or merged
 * @property {string|null} integration the commit under test, null while
 *   merging
 * @property {Phase} phase
 * @typedef {{readonly main: string|null, readonly queue: readonly QueueRef[]}}
 *   QueueRefs the remote's `main` and queue refs, each commit present locally
 * @typedef {{readonly kind: "merged", readonly sha: string}
 *   | {readonly kind: "conflict", readonly name: string,
 *     readonly files: readonly string[]}
 *   | {readonly kind: "refused", readonly name: string,
 *     readonly reason: string}} MergeResult the integration commit, or the
 *   first member that would not merge: conflicting in `files`, or its merge
 *   refused, as by a commit gate
 * @typedef {Exclude<MergeResult, {kind: "merged"}>} Unmerged
 * @typedef {{readonly kind: "take-batch", readonly batch: Batch}
 *   | {readonly kind: "merge-members", readonly onto: string,
 *     readonly members: readonly Member[]}
 *   | {readonly kind: "test-sha", readonly sha: string}
 *   | {readonly kind: "fast-forward-main", readonly sha: string}
 *   | {readonly kind: "delete-landed-ref", readonly name: string,
 *     readonly sha: string}
 *   | {readonly kind: "exit", readonly reason: string}} QueueAction
 * @typedef {Extract<QueueAction, {kind: "exit"}>} QueueEnd
 * @typedef {object} QueueState what the next action is chosen from
 * @property {string|null} main
 * @property {readonly QueueRef[]} queue
 * @property {Batch|null} batch the batch record
 * @property {(sha: string) => boolean} isGreen whether the green ledger holds
 *   `sha`
 * @property {(sha: string, files: readonly string[]) => Verdict|null}
 *   verdictOf the verdict ledgered at `sha` on `files`, empty for the whole
 *   suite
 * @property {boolean} requiresRun where `main` takes only a sha a CI run
 *   passed, so only a green naming its `run` lands
 * @property {{readonly sha: string, readonly reason: string}|null} unread
 *   the sha this run's tester reached no verdict at
 * @property {Unmerged|null} unmerged the merge this run could not make
 * @property {readonly string[]} kept members whose compare-and-delete this run
 *   found moved
 */

/** @param {string} reason @returns {QueueEnd} */
const exit = (reason) => ({ kind: "exit", reason });

/**
 * @param {Member} a
 * @param {Member} b
 */
const byPushOrder = (a, b) =>
	a.pushedAt - b.pushedAt || Number(a.name > b.name) - Number(a.name < b.name);

/**
 * Whether `main` holds the batch: pushed there by this lander, or already at
 * its integration commit, as a crash after the push leaves it.
 * @param {Batch} b
 * @param {string} main
 */
const isLanded = (b, main) => b.phase === "landed" || b.integration === main;

/**
 * Every queue ref waiting, at the sha it holds now.
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function takeBatch(s, main) {
	const members = s.queue
		.map(({ name, sha, pushedAt }) => ({ name, sha, pushedAt }))
		.sort(byPushOrder);
	return {
		kind: "take-batch",
		batch: { members, onto: main, integration: null, phase: "merging" },
	};
}

/**
 * @param {Unmerged} u
 * @returns {QueueEnd}
 */
const unmergedExit = (u) =>
	exit(
		`queue/${u.name} did not merge into the batch (${u.kind === "conflict" ? `conflict in ${u.files.join(", ")}` : u.reason}): dropping or deferring a member is unbuilt (#4485)`,
	);

/**
 * The next step of a batch `main` does not yet hold.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function batchAction(b, s, main) {
	if (s.unmerged) return unmergedExit(s.unmerged);
	/* A batch merged onto a `main` that has since moved is merged again onto
	 * the new tip, so `main` only ever fast-forwards. */
	if (b.phase === "merging" || b.onto !== main || b.integration === null)
		return { kind: "merge-members", onto: main, members: b.members };
	const sha = b.integration;
	if (s.isGreen(sha)) return { kind: "fast-forward-main", sha };
	const v = s.verdictOf(sha, []);
	if (v === null)
		return s.unread?.sha === sha
			? exit(`no verdict at ${short(sha)}: ${s.unread.reason}`)
			: { kind: "test-sha", sha };
	if (v.kind === "red")
		return exit(
			`the batch ${short(sha)} is red on ${v.files.length > 0 ? v.files.join(", ") : "no named file"}: the red path is unbuilt (#4485)`,
		);
	if (v.kind === "green" && (!s.requiresRun || v.run !== undefined))
		return { kind: "fast-forward-main", sha };
	return exit(`no verdict at ${short(sha)}: its green read no CI run`);
}

/**
 * @param {QueueState} s
 * @returns {QueueAction}
 */
function nextQueueAction(s) {
	const { main, batch } = s;
	if (main === null) return exit("the remote has no main branch");
	if (batch && !isLanded(batch, main)) return batchAction(batch, s, main);
	const landed = batch?.members.find(
		(m) =>
			!s.kept.includes(m.name) &&
			s.queue.some((r) => r.name === m.name && r.sha === m.sha),
	);
	if (landed)
		return { kind: "delete-landed-ref", name: landed.name, sha: landed.sha };
	/* A landed batch's member still waiting moved after its snapshot. */
	const waiting = s.queue.filter(
		(r) => !batch?.members.some((m) => m.name === r.name && m.sha === r.sha),
	);
	if (waiting.length === 0) return exit("no queue ref waits");
	return takeBatch({ ...s, queue: waiting }, main);
}

/**
 * @typedef {object} QueueGit
 * @property {() => QueueRefs} refs
 * @property {(onto: string, members: readonly Member[]) => MergeResult}
 *   mergeMembers each member merged in order onto `onto`, in the lander's
 *   own worktree; a lone member descending from `onto` is itself the
 *   integration commit
 * @property {(sha: string) => void} pushBatch `sha` to the lander's batch
 *   ref, forced, so a tester reading that ref's runs sees it
 * @property {(sha: string) => void} pushMain a plain, non-forced push of
 *   `sha` to the remote's `main`
 * @property {(name: string, sha: string) => boolean} deleteRef deletes
 *   `queue/<name>` only where it still holds `sha`, false where it moved
 * @typedef {object} VerdictLedger
 * @property {(sha: string, files: readonly string[]) => Verdict|null} get
 * @property {(sha: string, files: readonly string[], v: Verdict) => void} add
 * @typedef {object} BatchRecord
 * @property {() => Batch|null} read
 * @property {(b: Batch) => void} write
 * @typedef {object} QueueLanderDeps
 * @property {QueueGit} git
 * @property {QueueTester} tester
 * @property {Ledger} ledger the green ledger the pre-push gate on `main` reads
 * @property {VerdictLedger} verdicts
 * @property {BatchRecord} record
 * @property {{acquire: () => boolean, release: () => void}} lock
 * @property {(batch: string|null) => void} beat writes the heartbeat,
 *   naming the sha under test
 * @property {(ms: number) => Promise<void>} [wait] the backoff between tries
 *   of a faulted call
 * @property {(action: QueueAction) => void} [log]
 * @property {() => void} [mainMoved] after each move of `main`
 * @typedef {Pick<QueueState, "batch" | "unread" | "unmerged" | "kept">}
 *   QueueRun what a run carries between actions
 */

/**
 * Whether a thrown step is a fault a retry can outlast.
 * @param {unknown} err
 */
function isTransientFault(err) {
	if (err instanceof TransientFault || isNetworkFault(err)) return true;
	const { code } = caught(err);
	return typeof code === "string" && SPAWN_FAULTS.includes(code);
}

/**
 * @param {QueueLanderDeps} deps
 * @param {Exclude<QueueAction, QueueEnd>} action
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function act(deps, action, run) {
	const { git, record } = deps;
	switch (action.kind) {
		case "take-batch":
			record.write(action.batch);
			return { batch: action.batch, unread: null, unmerged: null, kept: [] };
		case "merge-members": {
			const merged = git.mergeMembers(action.onto, action.members);
			if (merged.kind !== "merged") return { ...run, unmerged: merged };
			/** @type {Batch} */
			const batch = {
				members: action.members,
				onto: action.onto,
				integration: merged.sha,
				phase: "testing",
			};
			record.write(batch);
			return { ...run, batch };
		}
		case "test-sha": {
			git.pushBatch(action.sha);
			const v = await verdictAt(deps, action.sha);
			if (v.kind === "unknown" && v.transient)
				throw new TransientFault(
					`no verdict at ${short(action.sha)}: ${v.reason}`,
				);
			if (v.kind === "unknown")
				return { ...run, unread: { sha: action.sha, reason: v.reason } };
			deps.verdicts.add(action.sha, [], v);
			return run;
		}
		case "fast-forward-main": {
			/* Ledgered first, so the pre-push gate can tell this push from any
			 * other. */
			if (!deps.ledger.has(action.sha)) deps.ledger.add(action.sha);
			git.pushMain(action.sha);
			if (run.batch === null)
				throw new Error(`fast-forward-main ${action.sha} with no batch`);
			/** @type {Batch} */
			const batch = { ...run.batch, phase: "landed" };
			record.write(batch);
			deps.mainMoved?.();
			return { ...run, batch };
		}
		case "delete-landed-ref":
			return git.deleteRef(action.name, action.sha)
				? run
				: { ...run, kept: [...run.kept, action.name] };
	}
}

/**
 * The next action, taken; the run's end where it is an exit.
 * @param {QueueLanderDeps} deps
 * @param {QueueRun} run
 * @param {(action: QueueAction) => void} log
 * @returns {Promise<QueueRun | QueueEnd>}
 */
async function step(deps, run, log) {
	deps.beat(run.batch?.integration ?? null);
	const action = nextQueueAction({
		...deps.git.refs(),
		...run,
		isGreen: (sha) => deps.ledger.has(sha),
		verdictOf: (sha, files) => deps.verdicts.get(sha, files),
		requiresRun: deps.tester.requiresRun === true,
	});
	log(action);
	return action.kind === "exit" ? action : act(deps, action, run);
}

/**
 * One run: acts until the machine exits.
 * @param {QueueLanderDeps} deps
 * @returns {Promise<QueueEnd>}
 */
async function runQueueLander(deps) {
	const { lock, log = () => undefined } = deps;
	if (!lock.acquire()) {
		const held = exit("another lander holds the lock");
		log(held);
		return held;
	}
	/** @type {QueueRun} */
	let run = {
		batch: deps.record.read(),
		unread: null,
		unmerged: null,
		kept: [],
	};
	try {
		for (;;) {
			const from = run;
			const next = await remote(
				deps,
				() => step(deps, from, log),
				isTransientFault,
			);
			if ("kind" in next) return next;
			run = next;
		}
	} catch (err) {
		const end = exit(
			`stopped on an error: ${parseRefusal(parseErrorText(err))}`,
		);
		log(end);
		return end;
	} finally {
		lock.release();
	}
}

/**
 * @param {QueueAction} a
 * @returns {string}
 */
function buildQueueActionLine(a) {
	switch (a.kind) {
		case "exit":
			return `exit ${a.reason}`;
		case "take-batch":
			return `take-batch ${a.batch.members.map((m) => `queue/${m.name}@${short(m.sha)}`).join(", ")}`;
		case "merge-members":
			return `merge-members onto ${short(a.onto)}: ${a.members.map((m) => `queue/${m.name}`).join(", ")}`;
		case "delete-landed-ref":
			return `delete-landed-ref queue/${a.name}@${short(a.sha)}`;
		default:
			return `${a.kind} ${a.sha}`;
	}
}

module.exports = { TransientFault, buildQueueActionLine, runQueueLander };
