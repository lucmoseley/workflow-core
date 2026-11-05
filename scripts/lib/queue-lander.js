/*
 * queue-lander.js — the landing queue's lander: tests
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
 * - **Drop and defer.** A member that does not merge onto the batch so far is
 *   merged alone onto `main`. Where that fails too, as a conflict or a merge
 *   a commit gate refused, it is dropped: the batch record leaves it out and
 *   the drop record holds it, then `dropped/<name>` is created at its
 *   snapshot and `queue/<name>` is compare-and-deleted against it, a moved
 *   one kept queued. A drop record row whose dropped ref is missing is
 *   dropped again, as a crash cut its drop short. A `dropped/<name>` already
 *   holding another sha leaves it to its own fix ticket, and the drop takes
 *   `dropped/<name>-<sha>`. Its fix ticket is filed next, through the
 *   injected tracker; one that will not file is filed again by the next run,
 *   and one the tracker refuses for good stops the run. Where it merges
 *   alone, it conflicts only with an earlier member, and it is deferred: left
 *   out of this batch, and taken again by the next. A later member still
 *   merges into this one.
 * - **Green.** The integration sha is written to the green ledger, then `main`
 *   moves to it by a plain push. Each member merged into it whose ref still
 *   holds its snapshot is then deleted, compare-and-delete against that sha;
 *   a moved one is kept and joins the next batch.
 * - **Reap.** With no batch in flight, each `dropped/<name>` whose fix ticket
 *   the run read closed at its start is compare-and-deleted, and its drop
 *   record entry marked reaped, so landing-status still names the ticket. An
 *   entry reaped longer ago than the queue log keeps its rows is pruned at a
 *   run's start.
 * - **Queue log.** A take row for each member a batch takes, a land row for
 *   each member `main` moves past, and a drop row for each dropped member,
 *   through the injected `logQueue`. A batch `main` holds with its land rows
 *   unrecorded, as a crash after the push leaves it, logs them on restart.
 * - **Verdicts.** A green or red reached at a sha is ledgered and survives a
 *   restart. An unknown verdict is no verdict: it lands nothing and is never
 *   ledgered, so the next run asks again.
 * - **Faults.** A step that throws a transient fault (a network blip, a spawn
 *   fault, a broken git object, a merge timing out, a tester's `transient` no
 *   verdict, as its suite slot staying shut) is retried with backoff and the
 *   run's state kept; any other throw, or one outlasting the tries, exits
 *   naming it.
 * - A red integration verdict exits naming the red path.
 *
 * Unbuilt caller: the cutover's launcher, which starts scripts/queue-lander.js
 * on a queue push (#4485)
 */

const { caught, parseErrorText } = require("./caught.js");
const { FilingRefusedError } = require("./filing-refused.js");
const { parseRefusal, remote, short, verdictAt } = require("./lander.js");
const { QUEUE_PREFIX, droppedRefsOf } = require("./landing-refs.js");
const { QUEUE_LOG_RETAIN_MS } = require("./queue-log.js");
const { isNetworkFault } = require("./network-fault.js");

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
 * @property {readonly string[]} deferred the names of members left out, to
 *   be taken by the next batch
 * @property {readonly string[]} dropped
 * @property {string} onto `main` when its members were taken or merged
 * @property {string|null} integration the commit under test, null while
 *   merging
 * @property {Phase} phase
 * @typedef {{readonly ref: string, readonly sha: string}} DroppedRef a
 *   `dropped/*` ref on the remote, `ref` after `refs/heads/`
 * @typedef {{readonly main: string|null, readonly queue: readonly QueueRef[],
 *   readonly dropped: readonly DroppedRef[]}} QueueRefs the remote's `main`,
 *   queue refs and dropped refs, each queue commit present locally
 * @typedef {object} Drop a dropped member, as the drop record holds it
 * @property {string} name after `queue/`
 * @property {string} sha
 * @property {string} ref the dropped ref holding it, after `refs/heads/`
 * @property {string} onto the `main` it would not merge onto alone
 * @property {Unmerged} cause that merge's conflict or refusal
 * @property {number|null} ticket its fix ticket, null until filed
 * @property {number} at when it was dropped, in ms
 * @property {number} [reapedAt] when its dropped ref was deleted, in ms
 * @typedef {{readonly kind: "merged", readonly sha: string}
 *   | {readonly kind: "conflict", readonly name: string,
 *     readonly files: readonly string[]}
 *   | {readonly kind: "refused", readonly name: string,
 *     readonly reason: string}} MergeResult the integration commit, or the
 *   first member that would not merge: conflicting in `files`, or its merge
 *   refused, as by a commit gate
 * @typedef {Exclude<MergeResult, {kind: "merged"}>} Unmerged
 * @typedef {{readonly onto: string, readonly result: MergeResult}} Merge
 * @typedef {{readonly kind: "take-batch", readonly batch: Batch}
 *   | {readonly kind: "merge-members", readonly onto: string,
 *     readonly members: readonly Member[]}
 *   | {readonly kind: "merge-alone", readonly onto: string,
 *     readonly member: Member}
 *   | {readonly kind: "defer-member", readonly name: string}
 *   | {readonly kind: "drop-member", readonly drop: Drop}
 *   | {readonly kind: "file-fix-ticket", readonly drop: Drop}
 *   | {readonly kind: "delete-dropped-ref", readonly ref: string,
 *     readonly sha: string}
 *   | {readonly kind: "test-sha", readonly sha: string}
 *   | {readonly kind: "fast-forward-main", readonly sha: string}
 *   | {readonly kind: "record-landed", readonly sha: string}
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
 * @property {readonly DroppedRef[]} dropped
 * @property {readonly Drop[]} drops
 * @property {number} now the step's clock, in ms
 * @property {(ticket: number) => boolean} isClosed whether this run read the
 *   ticket closed at its start
 * @property {{readonly onto: string, readonly result: Unmerged}|null}
 *   unmerged the batch merge this run could not make
 * @property {(Merge & {readonly name: string})|null} alone the merge of the
 *   member `name` alone this run made
 * @property {readonly string[]} kept members whose compare-and-delete this run
 *   found moved
 * @property {readonly string[]} unfiled dropped refs whose fix ticket this
 *   run could not file
 */

/** @param {string} reason @returns {QueueEnd} */
const exit = (reason) => ({ kind: "exit", reason });

/**
 * @param {Member} a
 * @param {Member} b
 */
const byPushOrder = (a, b) =>
	a.pushedAt - b.pushedAt || Number(a.name > b.name) - Number(a.name < b.name);

/** @param {Batch} b */
const included = (b) =>
	b.members.filter(
		(m) => !b.deferred.includes(m.name) && !b.dropped.includes(m.name),
	);

/**
 * Whether the batch is done: `main` holds it, pushed there by this lander or
 * already at its integration commit, as a crash after the push leaves it.
 * @param {Batch} b
 * @param {string} main
 */
const isDone = (b, main) =>
	b.phase === "landed" || b.integration === main || included(b).length === 0;

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
		batch: {
			members,
			deferred: [],
			dropped: [],
			onto: main,
			integration: null,
			phase: "merging",
		},
	};
}

/**
 * @param {Member} m
 * @param {readonly DroppedRef[]} dropped
 */
function droppedRefFor(m, dropped) {
	const [plain, keyed] = droppedRefsOf(m.name, m.sha);
	const held = dropped.find((d) => d.ref === plain)?.sha;
	return held === undefined || held === m.sha ? plain : keyed;
}

/**
 * Drop or defer the member the batch merge stopped at.
 * @param {readonly Member[]} members the batch's, still in it
 * @param {QueueState} s
 * @param {{onto: string, result: Unmerged}} u
 * @returns {QueueAction}
 */
function unmergedAction(members, s, u) {
	const { name } = u.result;
	const m = members.find((x) => x.name === name);
	if (!m) return exit(`queue/${name} did not merge, but is no batch member`);
	/** @param {Unmerged} cause @returns {QueueAction} */
	const drop = (cause) => ({
		kind: "drop-member",
		drop: {
			name,
			sha: m.sha,
			ref: droppedRefFor(m, s.dropped),
			onto: u.onto,
			cause,
			ticket: null,
			at: s.now,
		},
	});
	if (members[0] === m) return drop(u.result);
	const alone = s.alone;
	if (alone?.name !== name || alone.onto !== u.onto)
		return { kind: "merge-alone", onto: u.onto, member: m };
	if (alone.result.kind === "merged") return { kind: "defer-member", name };
	return drop(alone.result);
}

/**
 * The next step of a batch not yet done.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function batchAction(b, s, main) {
	const members = included(b);
	if (s.unmerged?.onto === main) return unmergedAction(members, s, s.unmerged);
	/* A batch merged onto a `main` that has since moved is merged again onto
	 * the new tip, so `main` only ever fast-forwards. */
	if (b.phase === "merging" || b.onto !== main || b.integration === null)
		return { kind: "merge-members", onto: main, members };
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
	const cut = s.drops.find(
		(d) =>
			d.reapedAt === undefined &&
			!s.dropped.some((r) => r.ref === d.ref && r.sha === d.sha) &&
			!(d.ticket !== null && s.isClosed(d.ticket)),
	);
	if (cut) return { kind: "drop-member", drop: cut };
	const owed = s.drops.find(
		(d) => d.ticket === null && !s.unfiled.includes(d.ref),
	);
	if (owed) return { kind: "file-fix-ticket", drop: owed };
	if (batch && batch.phase !== "landed" && batch.integration === main)
		return { kind: "record-landed", sha: main };
	if (batch && !isDone(batch, main)) return batchAction(batch, s, main);
	const merged = batch ? included(batch) : [];
	const landed = merged.find(
		(m) =>
			!s.kept.includes(m.name) &&
			s.queue.some((r) => r.name === m.name && r.sha === m.sha),
	);
	if (landed)
		return { kind: "delete-landed-ref", name: landed.name, sha: landed.sha };
	const reaped = s.drops.find(
		(d) =>
			d.reapedAt === undefined && d.ticket !== null && s.isClosed(d.ticket),
	);
	if (reaped)
		return { kind: "delete-dropped-ref", ref: reaped.ref, sha: reaped.sha };
	/* A landed batch's member still waiting moved after its snapshot. */
	const waiting = s.queue.filter(
		(r) => !merged.some((m) => m.name === r.name && m.sha === r.sha),
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
 * @property {(branch: string, sha: string) => boolean} deleteRef deletes the
 *   remote's `branch` only where it still holds `sha`, false where it moved
 * @property {(branch: string, sha: string) => void} createRef creates the
 *   remote's `branch` at `sha`, refused where it holds another sha
 * @typedef {object} QueueTracker
 * @property {(d: Drop) => string} fileDropTicket files the drop's fix ticket,
 *   returning the line naming it, as `#<n>`, and throwing a FilingRefusedError
 *   where the tracker refuses it for good
 * @property {(n: number) => "open" | "closed"} stateOf the ticket's state,
 *   throwing where it cannot be read
 * @typedef {object} DropRecord
 * @property {() => Drop[]} read
 * @property {(drops: readonly Drop[]) => void} write
 * @typedef {"take" | "land" | "drop"} LanderEvent
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
 * @property {DropRecord} drops
 * @property {QueueTracker} tracker
 * @property {(event: LanderEvent, m: Pick<Member, "name" | "sha">) => void}
 *   logQueue
 * @property {{acquire: () => boolean, release: () => void}} lock
 * @property {(batch: string|null) => void} beat writes the heartbeat,
 *   naming the sha under test
 * @property {(ms: number) => Promise<void>} [wait] the backoff between tries
 *   of a faulted call
 * @property {(action: QueueAction) => void} [log]
 * @property {() => void} [mainMoved] after each move of `main`
 * @property {() => number} now the clock, in ms
 * @property {(line: string) => void} [say] reports a fix ticket filed or
 *   left unfiled, or one whose state was not read
 * @typedef {Pick<QueueState, "batch" | "unread" | "unmerged" | "alone"
 *   | "kept" | "unfiled" | "isClosed">} QueueRun what a run carries between
 *   actions
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
 * The batch with `name` left out as `as`, to be merged again without it.
 * @param {Batch} b
 * @param {string} name
 * @param {"deferred" | "dropped"} as
 * @returns {Batch}
 */
const leaveOut = (b, name, as) => ({
	...b,
	[as]: [...b[as], name],
	integration: null,
	phase: "merging",
});

/**
 * @param {QueueRun} run
 * @returns {Batch}
 */
function batchOf(run) {
	if (run.batch === null) throw new Error("a batch action with no batch");
	return run.batch;
}

/**
 * Drops the member, each record written before the refs it names, so a rerun
 * after a crash finishes the drop and never lands the member. A step repeated
 * after a crash finds its ref already made, and keeps its filed ticket.
 * @param {QueueLanderDeps} deps
 * @param {Drop} d
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function dropMember(deps, d, run) {
	const { batch } = run;
	const member = batch?.members.some(
		(m) => m.name === d.name && m.sha === d.sha,
	);
	const left =
		batch && member && !batch.dropped.includes(d.name)
			? leaveOut(batch, d.name, "dropped")
			: batch;
	if (left && left !== batch) deps.record.write(left);
	const drops = deps.drops.read();
	const was = drops.find((x) => x.ref === d.ref && x.sha === d.sha);
	deps.drops.write([
		...drops.filter((x) => x !== was),
		{ ...d, ticket: was?.ticket ?? null },
	]);
	deps.git.createRef(d.ref, d.sha);
	deps.git.deleteRef(`${QUEUE_PREFIX}${d.name}`, d.sha);
	deps.logQueue("drop", d);
	return { ...run, batch: left, unmerged: null, alone: null };
}

/**
 * Files the drop's fix ticket and records its number. A filing that throws
 * other than transiently or for good, or prints no number, is reported and
 * left for the next run (#4485).
 * @param {QueueLanderDeps} deps
 * @param {Drop} d
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function fileFixTicket(deps, d, run) {
	const { say = () => undefined } = deps;
	/** @param {string} why */
	const unfiled = (why) => {
		say(`fix ticket for ${d.ref} not filed, left for the next run: ${why}`);
		return { ...run, unfiled: [...run.unfiled, d.ref] };
	};
	let line;
	try {
		line = deps.tracker.fileDropTicket(d);
	} catch (err) {
		if (isTransientFault(err) || err instanceof FilingRefusedError) throw err;
		return unfiled(parseRefusal(parseErrorText(err)));
	}
	const n = Number(FILED.exec(line)?.[1]);
	if (!Number.isInteger(n))
		return unfiled(`its filing printed no #<n>: ${line}`);
	deps.drops.write(
		deps.drops
			.read()
			.map((x) =>
				x.ref === d.ref && x.sha === d.sha ? { ...x, ticket: n } : x,
			),
	);
	say(line);
	return run;
}

const FILED = /#(\d+)/;

/**
 * Pushes `sha` to the batch ref and ledgers the verdict its tester reaches
 * there; a transient no verdict throws for the run to retry.
 * @param {QueueLanderDeps} deps
 * @param {string} sha
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function testSha(deps, sha, run) {
	deps.git.pushBatch(sha);
	const v = await verdictAt(deps, sha);
	if (v.kind === "unknown" && v.transient)
		throw new TransientFault(`no verdict at ${short(sha)}: ${v.reason}`);
	if (v.kind === "unknown")
		return { ...run, unread: { sha, reason: v.reason } };
	deps.verdicts.add(sha, [], v);
	return run;
}

/**
 * @param {QueueLanderDeps} deps
 * @param {string} sha
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function fastForwardMain(deps, sha, run) {
	/* Ledgered first, so the pre-push gate can tell this push from any
	 * other. */
	if (!deps.ledger.has(sha)) deps.ledger.add(sha);
	deps.git.pushMain(sha);
	const landed = recordLanded(deps, run);
	deps.mainMoved?.();
	return landed;
}

/**
 * Logs a land row for each member `main` moved past, then records the batch
 * landed; a crash between the two repeats the rows, which the log takes
 * once.
 * @param {QueueLanderDeps} deps
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function recordLanded(deps, run) {
	/** @type {Batch} */
	const batch = { ...batchOf(run), phase: "landed" };
	for (const m of included(batch)) deps.logQueue("land", m);
	deps.record.write(batch);
	return { ...run, batch };
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
			for (const m of action.batch.members) deps.logQueue("take", m);
			return {
				...run,
				batch: action.batch,
				unread: null,
				unmerged: null,
				alone: null,
				kept: [],
			};
		case "merge-members": {
			const merged = git.mergeMembers(action.onto, action.members);
			if (merged.kind !== "merged")
				return { ...run, unmerged: { onto: action.onto, result: merged } };
			/** @type {Batch} */
			const batch = {
				...batchOf(run),
				onto: action.onto,
				integration: merged.sha,
				phase: "testing",
			};
			record.write(batch);
			return { ...run, batch };
		}
		case "merge-alone": {
			const { member, onto } = action;
			const result = git.mergeMembers(onto, [member]);
			return { ...run, alone: { name: member.name, onto, result } };
		}
		case "defer-member": {
			const batch = leaveOut(batchOf(run), action.name, "deferred");
			record.write(batch);
			return { ...run, batch, unmerged: null, alone: null };
		}
		case "drop-member":
			return dropMember(deps, action.drop, run);
		case "file-fix-ticket":
			return fileFixTicket(deps, action.drop, run);
		case "test-sha":
			return testSha(deps, action.sha, run);
		case "fast-forward-main":
			return fastForwardMain(deps, action.sha, run);
		case "record-landed":
			return recordLanded(deps, run);
		case "delete-landed-ref":
			return git.deleteRef(`${QUEUE_PREFIX}${action.name}`, action.sha)
				? run
				: { ...run, kept: [...run.kept, action.name] };
		case "delete-dropped-ref":
			/* A moved ref is a later drop's, which its own row keeps. */
			git.deleteRef(action.ref, action.sha);
			deps.drops.write(
				deps.drops
					.read()
					.map((d) =>
						d.ref === action.ref && d.sha === action.sha
							? { ...d, reapedAt: deps.now() }
							: d,
					),
			);
			return run;
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
		drops: deps.drops.read(),
		now: deps.now(),
		isGreen: (sha) => deps.ledger.has(sha),
		verdictOf: (sha, files) => deps.verdicts.get(sha, files),
		requiresRun: deps.tester.requiresRun === true,
	});
	log(action);
	return action.kind === "exit" ? action : act(deps, action, run);
}

/**
 * Whether each recorded drop's fix ticket is closed, read once for the run.
 * One that cannot be read reads as open and is reported, its dropped ref
 * kept for a later run to read again (#4485).
 * @param {QueueLanderDeps} deps
 * @returns {(ticket: number) => boolean}
 */
function readClosedTickets(deps) {
	const { say = () => undefined } = deps;
	/** @type {Set<number>} */
	const closed = new Set();
	for (const { ticket, ref, reapedAt } of deps.drops.read()) {
		if (ticket === null || reapedAt !== undefined) continue;
		try {
			if (deps.tracker.stateOf(ticket) === "closed") closed.add(ticket);
		} catch (err) {
			say(
				`#${ticket}'s state not read, ${ref} kept for a later run: ${parseRefusal(parseErrorText(err))}`,
			);
		}
	}
	return (ticket) => closed.has(ticket);
}

/**
 * Drops each drop record entry reaped longer ago than the queue log keeps
 * its rows.
 * @param {QueueLanderDeps} deps
 */
function pruneReaped(deps) {
	const drops = deps.drops.read();
	const kept = drops.filter(
		(d) =>
			d.reapedAt === undefined ||
			deps.now() - d.reapedAt <= QUEUE_LOG_RETAIN_MS,
	);
	if (kept.length < drops.length) deps.drops.write(kept);
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
	pruneReaped(deps);
	/** @type {QueueRun} */
	let run = {
		batch: deps.record.read(),
		unread: null,
		unmerged: null,
		alone: null,
		kept: [],
		unfiled: [],
		isClosed: readClosedTickets(deps),
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
		case "merge-alone":
			return `merge-alone onto ${short(a.onto)}: queue/${a.member.name}`;
		case "defer-member":
			return `defer-member queue/${a.name}`;
		case "drop-member":
			return `drop-member queue/${a.drop.name}@${short(a.drop.sha)} as ${a.drop.ref}`;
		case "file-fix-ticket":
			return `file-fix-ticket ${a.drop.ref}@${short(a.drop.sha)}`;
		case "delete-landed-ref":
			return `delete-landed-ref queue/${a.name}@${short(a.sha)}`;
		case "delete-dropped-ref":
			return `delete-dropped-ref ${a.ref}@${short(a.sha)}`;
		default:
			return `${a.kind} ${a.sha}`;
	}
}

module.exports = { TransientFault, buildQueueActionLine, runQueueLander };
