/*
 * queue-lander.js — the landing queue's lander: tests
 * every waiting `queue/<name>` ref merged onto `main` in one integration
 * commit, and moves `main` to it on a green verdict at that exact sha.
 *
 * One pure state machine, `nextQueueAction`, chooses each action from the
 * remote's refs, the green and verdict ledgers, the pipeline record and what
 * this run has met; `runQueueLander` acts on it through injected git and tester
 * until it exits. The library does no I/O: lib/queue-lander-adapters.js holds
 * the production git and files.
 *
 * - **Batch.** Every queue ref waiting when the window has room is taken, each
 *   at the sha it then holds, in push order: the earlier push first, then the
 *   name (lib/queue-lander-adapters.js reads the push time). A push to a
 *   member's ref after that joins a batch taken once its own is done.
 * - **Pipeline.** Batches are tested speculatively, as Zuul's dependent
 *   pipeline does (#4556): the line holds up to `depth` batches, each merged
 *   onto the one ahead's integration commit and pushed to its own
 *   `lander/batch-<slot>` ref, so its run starts while the one ahead is under
 *   test. Only the line's head, merged onto `main`, lands, so `main` moves in
 *   queue order, each tip on its own green. Depth starts at DEPTH_START and
 *   rises by one per landing to DEPTH_CEILING; a red drops it to one. A
 *   tester that is not `parallel` runs one ask at a time, at depth one. A
 *   batch whose base moved is merged again onto it. Each merge on a slot has
 *   the tester's `cancel` stop every unfinished run on its batch ref but the
 *   one at the sha it tests, so a run GitHub listed too late for an earlier
 *   cancel, or one a crash left unrecorded, stops there (#4576).
 * - **Search.** A head red on its whole suite leaves the line as its search,
 *   and the batches behind it are cancelled and merged again onto `main`
 *   without it. One search runs at a time: a second red head waits for it, and a
 *   held or re-batched search a new one replaces leaves its members to the
 *   queue in push order. While a search lands serially the line stands still.
 *   A search's rerun green lands where `main` has not moved past its base,
 *   else its members are batched again.
 * - **Merge.** Members merge onto `main` in that order, each a two-parent
 *   merge with the registry merge driver. A lone member that descends from
 *   `main` is the integration commit, with no merge, the adapter's
 *   `mergeMembers` telling. Where the tester's run repeats the gates the
 *   batch's pass skips, the merges are pushed to the batch's ref before that
 *   pass, so the run starts alongside it, and cancelled where the pass
 *   refuses or commits edits (#4573).
 * - **Drop and defer.** A member that does not merge onto the batch so far is
 *   merged alone onto `main`. Where that fails too, as a conflict or a merge
 *   a commit gate refused, it is dropped: its batch leaves it out and
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
 * - **Red.** The failing files are rerun once at the integration sha, and
 *   where they pass the batch is green. Those still red are run anew at
 *   `main`, pushed to `lander/iso-base`: the ones red there too are base
 *   failures, blamed on no member, and the one base-red ticket is filed or
 *   refreshed for them. Where none is left the batch lands, unless the
 *   tester's `requiresRun` is set, where it is held instead and retaken once
 *   a new ref waits or `main` moves, or, where `main` too fired no run, once
 *   NO_RUN_RETAKE_MS has passed, so an Actions outage's hold ends when
 *   Actions recovers (#4572). The rest isolate: each member is merged
 *   alone onto `main`, pushed to `lander/iso-<k>` and run on those files, all
 *   at once where the tester is `parallel` (the Actions one), else one after
 *   another (the local one, under its one admission slot). A member red alone
 *   is run again, and red twice it is dropped with a fix ticket naming the
 *   files. Where any member dropped, the rest form the next batch. Where none
 *   did, the batch is a collision: its members land one at a time in push
 *   order, each step the whole suite on `main`, and the first step red twice
 *   on a blamed file drops its member, the rest forming the next batch. A
 *   step red twice elsewhere has those files run at its `main`: red only
 *   where `main` is, it is a base red as above, else the rest are batched
 *   again. A red naming no file takes the same steps on the whole suite, its
 *   runs at `main` and alone on `lander/iso-suite-*` refs, whose pushes the
 *   suite runs on; `main` shares it where `main` fails every job it does.
 * - **Refused.** A push to `main` the remote refuses, as its ruleset does, is
 *   final for that sha (#4501): it is written to the refused record, leaves
 *   the green ledger, so the pre-push gate passes no later push of it, and
 *   the batch is held naming it. No batch lands a refused sha: a member
 *   whose own sha was refused is merged as a new commit even where it
 *   descends from `main`, and a merge that makes a refused sha again is
 *   held. Residual: the refused record keeps every row for good, one per
 *   refusal, which no run prunes.
 * - **Restart.** Each decision is written to the pipeline record, which keeps
 *   each batch's phase, isolation merges and serial steps, before the act it
 *   governs, so a rerun after a crash converges on it; a run in flight at the
 *   crash is asked again, its ref still at its sha.
 * - **Reap.** With no batch in flight, each `dropped/<name>` whose fix ticket
 *   the run read closed at its start is compare-and-deleted, and its drop
 *   record entry marked reaped, so landing-status still names the ticket. An
 *   entry reaped longer ago than the queue log keeps its rows is pruned at a
 *   run's start. A `dropped/*` ref no entry names, as a lost or torn record
 *   leaves it, gets its entry back first, naming the fix ticket the tracker
 *   holds under its title, or none, so a ticket is filed for it (#4498).
 * - **Queue log.** A take row for each member a batch takes, a land row for
 *   each member `main` moves past, and a drop row for each dropped member,
 *   through the injected `logQueue`. A batch `main` holds with its land rows
 *   unrecorded, as a crash after the push leaves it, logs them on restart.
 * - **Verdicts.** A green or red reached at a sha is ledgered by that sha, the
 *   files it ran and its pass, the rerun and the confirm being the second.
 *   A base check's verdict at `main` is kept on its batch, never the
 *   ledger, so each batch asks it afresh (#4501), unless `main` went green
 *   on the green ledger within `BASE_GREEN_MS` (#4564). An unknown
 *   verdict is no verdict: it lands and drops nothing and is never
 *   ledgered, so the next run asks again. A tree no CI run fired for is a
 *   verdict, never an unknown (#4571): the tester reads it as a red naming
 *   no file, marked `noRun`, which takes the red path above, so a batch
 *   whose run never starts ends, and a member whose tree alone fires none is
 *   dropped, its fix ticket saying so. A no-run red stands NO_RUN_RETAKE_MS
 *   from when it was ledgered, then is asked again (#4572).
 * - **Faults.** A step that throws a transient fault (a network blip, a spawn
 *   fault, a broken git object, a merge timing out, a tester's `transient` no
 *   verdict, as its suite slot staying shut) is retried with backoff and the
 *   run's state kept; any other throw, or one outlasting the tries, exits
 *   naming it.
 *
 * Unbuilt caller: the cutover's launcher, which starts scripts/queue-lander.js
 * on a queue push (#4485)
 */

const { caught, parseErrorText } = require("./caught.js");
const { FilingRefusedError } = require("./filing-refused.js");
const { HEARTBEAT_MS } = require("./lander-files.js");
const { parseRefusal, remote, short } = require("./lander-git.js");
const {
	LANDER_ISO_PREFIX,
	LANDER_ISO_SUITE_PREFIX,
	QUEUE_PREFIX,
	batchBranch,
	droppedNameOf,
	droppedRefsOf,
} = require("./landing-refs.js");
const { QUEUE_LOG_RETAIN_MS } = require("./queue-log.js");
const { isNetworkFault } = require("./network-fault.js");

/* Untraced, a first guess and stated as one: the codes a fork returns while
 * the machine is short of processes or memory for a moment. */
const SPAWN_FAULTS = ["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"];

/** A fault a retry can outlast that no error code names. */
class TransientFault extends Error {}

/**
 * @typedef {{file: string, test: string, message?: string,
 *   signature?: string}} Failure a failing test; where the runner printed its
 *   error, `message` to read and `signature` to compare, the same across runs
 *   of one failure
 * @typedef {{kind: "green", run?: number}
 *   | {kind: "red", files: string[], jobs?: string[], failures?: Failure[],
 *      retried?: boolean, noRun?: true}
 *   | {kind: "unknown", reason: string, transient?: true}} Verdict `run` the
 *   CI run that passed it and `jobs` the failing CI jobs, where the tester
 *   read a CI run; `failures` where it named the failing tests; `noRun`
 *   where no CI run fired for the tree at all, naming no file; `transient`
 *   where asking again shortly can reach a verdict, as when its suite slot
 *   stayed shut
 * @typedef {{verdict: (sha: string, files?: string[], again?: boolean) =>
 *   Promise<Verdict>, requiresRun?: boolean, parallel?: boolean,
 *   cancel?: (branch: string, keep: string|null) => string[]}} QueueTester
 *   the whole suite at `sha` where `files` is absent or empty, else only
 *   `files`, `again` where a verdict reached there is to be had anew, as a
 *   rerun or confirm; `requiresRun` where `main` takes only a sha a CI run
 *   passed, so only a green naming its `run` lands; `parallel` where it can
 *   be asked several verdicts at once; `cancel` stops every unfinished run
 *   on the batch ref `branch` not at `keep`, returning every sha `branch`
 *   lists a run at, finished or not
 * @typedef {import("./lander-files.js").Ledger} Ledger
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly pushedAt: number}} QueueRef a queue ref on the remote: `name`
 *   after `queue/`, `pushedAt` its push time in ms
 * @typedef {QueueRef} Member a batch member, at its snapshot sha
 * @typedef {"merging" | "testing" | "isolating" | "serial" | "requeued"
 *   | "held" | "landed"} Phase `isolating` while each member is tested alone
 *   on `main`, `serial` while members land one at a time after a collision,
 *   `requeued` done without landing, `held` done on its `hold`
 * @typedef {{readonly kind: "base", readonly main: string,
 *   readonly files: readonly string[], readonly ticket: number|null,
 *   readonly retakeAt?: number}
 *   | {readonly kind: "refused", readonly main: string,
 *     readonly sha: string, readonly reason: string}} Hold why a batch
 *   stopped at `main`: red only where `main` is, on `files`, none where the
 *   red named none, with the base-red ticket, and `retakeAt`, in ms, where
 *   no run fired at `main` either; or its push of `sha` refused
 * @typedef {object} Blame what a red batch's isolation runs on
 * @property {readonly string[]} files the failing files `main` passes, none
 *   where the red named none
 * @property {readonly string[]} base the failing files `main` fails too
 * @property {readonly string[]} members the names isolated, in push order
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly iso: string}} Isolated a member merged alone onto the batch's
 *   `onto` as `iso`
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly onto: string}} Step a serial step: the member `name` merged
 *   alone onto `onto` as `sha`
 * @typedef {{readonly landed: readonly string[],
 *   readonly step: Step|null}} Serial the members landed so far, and the
 *   step under test
 * @typedef {object} Batch
 * @property {number} slot the k of its `lander/batch-<k>` ref, unique among
 *   the pipeline's batches
 * @property {readonly Member[]} members in push order
 * @property {readonly string[]} deferred the names of members left out, to
 *   be taken by the next batch
 * @property {readonly string[]} dropped
 * @property {string} onto the base its members were merged onto: `main`
 *   for the line's head and a search, else the integration commit of the
 *   batch ahead
 * @property {string|null} integration the commit under test, null while
 *   merging
 * @property {Phase} phase
 * @property {readonly string[]} ahead the members that form the next batch
 *   alone, ahead of newer refs
 * @property {Blame|null} blame
 * @property {readonly Isolated[]} isolated
 * @property {Serial|null} serial
 * @property {Hold|null} hold
 * @property {readonly BaseVerdict[]} bases the base checks this batch asked
 * @typedef {object} Pipeline
 * @property {readonly Batch[]} line the batches in flight, in queue order,
 *   the head first
 * @property {Batch|null} search the red batch whose culprits are sought, or
 *   done held or re-batched, until a take or a new search replaces it
 * @property {number} depth the window: how many batches the line may hold
 * @typedef {{readonly sha: string, readonly files: readonly string[],
 *   readonly verdict: Exclude<Verdict, {kind: "unknown"}>}} BaseVerdict a
 *   base check's verdict at `main`'s `sha` on `files`, none for the whole
 *   suite
 * @typedef {{readonly ref: string, readonly sha: string}} DroppedRef a
 *   `dropped/*` ref on the remote, `ref` after `refs/heads/`
 * @typedef {{readonly main: string|null, readonly queue: readonly QueueRef[],
 *   readonly dropped: readonly DroppedRef[]}} QueueRefs the remote's `main`,
 *   queue refs and dropped refs, each queue commit present locally
 * @typedef {{readonly kind: "red", readonly name: string,
 *   readonly files: readonly string[], readonly iso: string,
 *   readonly noRun?: true}} RedAlone red on `files` twice, none where the
 *   red named none, merged alone onto `main` as `iso`, where `main` passed
 *   them; `noRun` where no CI run fired for that tree
 * @typedef {{readonly kind: "collision", readonly name: string,
 *   readonly files: readonly string[], readonly step: string,
 *   readonly after: readonly string[], readonly noRun?: true}} Collision
 *   the serial step `step`, merging it onto `main` after the members `after`
 *   landed, red twice on `files`, none where the red named none, each member
 *   having passed alone; `noRun` where no CI run fired for that tree
 * @typedef {{readonly kind: "unrecorded", readonly name: string}} Unrecorded
 *   a dropped ref no drop record entry named
 * @typedef {Unmerged | RedAlone | Collision | Unrecorded} Cause
 * @typedef {object} Drop a dropped member, as the drop record holds it
 * @property {string} name after `queue/`
 * @property {string} sha
 * @property {string} ref the dropped ref holding it, after `refs/heads/`
 * @property {string} onto the `main` it was merged onto, or, for an entry
 *   written back for a ref none named, `main` when it was
 * @property {Cause} cause
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
 * @typedef {{readonly branch: string, readonly sha: string}} IsoRun a run
 *   alone at `sha`, pushed to the `lander/iso-*` ref `branch` before it is
 *   asked
 * @typedef {{readonly line: readonly Batch[], readonly search: Batch|null}}
 *   Live the pipeline's batches that are not spent
 * @typedef {"take-batch" | "detach" | "await-verdict" | "wait"} PipelineKind
 *   the actions on the pipeline rather than on one batch in it
 * @typedef {{readonly kind: "take-batch", readonly batch: Batch,
 *     readonly pipeline: Pipeline}
 *   | {readonly kind: "detach", readonly slot: number,
 *     readonly cancel: readonly {sha: string, slot: number}[],
 *     readonly pipeline: Pipeline}
 *   | {readonly kind: "await-verdict"}
 *   | {readonly kind: "wait"}
 *   | {readonly kind: "merge-members", readonly onto: string,
 *     readonly members: readonly Member[], readonly fresh: boolean}
 *   | {readonly kind: "merge-alone", readonly onto: string,
 *     readonly member: Member}
 *   | {readonly kind: "defer-member", readonly name: string}
 *   | {readonly kind: "drop-member", readonly drop: Drop}
 *   | {readonly kind: "file-fix-ticket", readonly drop: Drop}
 *   | {readonly kind: "adopt-dropped-ref", readonly ref: string,
 *     readonly sha: string, readonly onto: string}
 *   | {readonly kind: "delete-dropped-ref", readonly ref: string,
 *     readonly sha: string}
 *   | {readonly kind: "test-sha", readonly sha: string}
 *   | ({readonly kind: "rerun-files"} & TestRun)
 *   | {readonly kind: "check-base", readonly sha: string,
 *     readonly files: readonly string[]}
 *   | {readonly kind: "file-base-red", readonly sha: string,
 *     readonly files: readonly string[]}
 *   | {readonly kind: "hold", readonly hold: Hold}
 *   | {readonly kind: "unledger", readonly sha: string}
 *   | {readonly kind: "start-isolation" | "start-serial",
 *     readonly blame: Blame}
 *   | {readonly kind: "merge-iso", readonly onto: string,
 *     readonly member: Member}
 *   | {readonly kind: "serial-land-step", readonly onto: string,
 *     readonly member: Member, readonly fresh: boolean}
 *   | {readonly kind: "isolate-members" | "confirm-members",
 *     readonly files: readonly string[], readonly runs: readonly IsoRun[]}
 *   | {readonly kind: "rebatch-passers", readonly ahead: readonly string[]}
 *   | {readonly kind: "land-step" | "record-step", readonly sha: string,
 *     readonly name: string}
 *   | {readonly kind: "fast-forward-main", readonly sha: string}
 *   | {readonly kind: "record-landed", readonly sha: string}
 *   | {readonly kind: "delete-landed-ref", readonly name: string,
 *     readonly sha: string}
 *   | {readonly kind: "exit", readonly reason: string,
 *     readonly relaunch?: string}} QueueAction `take-batch` and `detach`
 *   carry the pipeline they leave; `cancel` the runs `detach` stops; `wait`,
 *   which no run takes, a batch whose next step waits on another's;
 *   `relaunch`, the `main` a fresh run on the new code takes the queue on from
 * @typedef {Extract<QueueAction, {kind: "exit"}>} QueueEnd
 * @typedef {"rerun-files" | "check-base" | "file-base-red" | "hold"
 *   | "start-isolation" | "start-serial" | "merge-iso" | "serial-land-step" | "isolate-members"
 *   | "confirm-members" | "rebatch-passers" | "land-step" | "record-step"}
 *   RedKind the red path's steps
 * @typedef {{readonly sha: string, readonly files: readonly string[],
 *   readonly pass: number}} TestRun a run at `sha` on `files`, the whole
 *   suite where none, on its `pass`: 1 the first, 2 the rerun or confirm,
 *   BASE_PASS a base check
 * @typedef {TestRun & {readonly reason: string}} Unread a run this run's
 *   tester reached no verdict at
 * @typedef {object} QueueState what the next action is chosen from
 * @property {string|null} main
 * @property {readonly QueueRef[]} queue
 * @property {Pipeline} pipeline
 * @property {(sha: string) => boolean} isGreen whether the green ledger holds
 *   `sha`
 * @property {(sha: string) => number|null} greenAt when the green ledger took
 *   `sha`, in ms
 * @property {(sha: string) => string|null} refusalOf the remote's refusal of
 *   a push of `sha` to `main`, where the refused record holds one
 * @property {(sha: string, files: readonly string[], pass: number) =>
 *   Ledgered|null} verdictOf the verdict ledgered at `sha` on `files`, empty
 *   for the whole suite, on its `pass`
 * @property {boolean} requiresRun where `main` takes only a sha a CI run
 *   passed, so only a green naming its `run` lands
 * @property {boolean} parallel where the tester takes several asks at once
 * @property {(r: TestRun) => boolean} isPending whether this run has asked
 *   `r` and awaits its verdict
 * @property {boolean} busy
 * @property {readonly Unread[]} unread
 * @property {readonly DroppedRef[]} dropped
 * @property {readonly Drop[]} drops
 * @property {number} now the step's clock, in ms
 * @property {(ticket: number) => boolean} isClosed whether this run read the
 *   ticket closed at its start
 * @property {{readonly onto: string, readonly result: Unmerged}|null}
 *   unmerged the batch merge this run could not make
 * @property {(Merge & {readonly name: string})|null} alone the merge of the
 *   member `name` alone this run made, where it was not recorded
 * @property {readonly string[]} kept members whose compare-and-delete this run
 *   found moved, as `<name>@<sha>`
 * @property {readonly string[]} unfiled dropped refs whose fix ticket this
 *   run could not file or search for
 * @property {readonly string[]} baseFiled the base reds this run filed or
 *   refreshed the base-red ticket for, by baseKey
 * @property {number|null} baseTicket the base-red ticket this run last filed
 *   or refreshed, null where none or it would not file
 * @property {boolean} [superseded] whether a move of `main` this run made
 *   changed the code it runs. The run takes no batch on it and ends once its
 *   batches are done: what they hold in memory — their isolated, unfiled and
 *   kept members — is lost to a fresh run.
 */

/* The pass of a base check: a run at `main` of its own, never the verdict
 * `main`'s sha reached as a batch. */
const BASE_PASS = 0;
/* How recently `main` went green for a red batch to read it green with no
 * base check (#4564): #4501's age limit on a base verdict. A first guess,
 * unmeasured. */
const BASE_GREEN_MS = 60 * 60 * 1000;
/* Untraced, a first guess and stated as one: how long a no-run red stands,
 * and a hold on one waits to be retaken. Room for an Actions outage to
 * clear, and many times one no-run ask's 3-6 min. Residual: a red path
 * slowed past it, as by fault backoff or a lander restarted after a gap,
 * asks its first verdict again, and batches may stack onto a head whose
 * no-run red lapsed until it is reached again. */
const NO_RUN_RETAKE_MS = 60 * 60 * 1000;

/* Untraced, #4556's figures and stated as such: the window a run starts at,
 * the deepest it grows to, and the one a red drops it to. */
const DEPTH_START = 2;
const DEPTH_CEILING = 3;
const DEPTH_FLOOR = 1;

/**
 * The first run of `sha`'s whole suite.
 * @param {string} sha
 * @returns {TestRun}
 */
const wholeRun = (sha) => ({ sha, files: [], pass: 1 });

/** @type {Extract<QueueAction, {kind: "wait"}>} */
const WAIT = { kind: "wait" };

/** @returns {Pipeline} */
const emptyPipeline = () => ({ line: [], search: null, depth: DEPTH_START });

/**
 * Every batch the pipeline holds, its search first.
 * @param {Pipeline} p
 * @returns {Batch[]}
 */
const batchesOf = (p) => (p.search ? [p.search, ...p.line] : [...p.line]);

/**
 * The pipeline with `b` in place of the batch holding its slot.
 * @param {Pipeline} p
 * @param {Batch} b
 * @returns {Pipeline}
 */
const withBatch = (p, b) => ({
	...p,
	search: p.search?.slot === b.slot ? b : p.search,
	line: p.line.map((x) => (x.slot === b.slot ? b : x)),
});

/**
 * The lowest slot no batch of `p` holds.
 * @param {Pipeline} p
 */
function freeSlot(p) {
	const held = new Set(batchesOf(p).map((b) => b.slot));
	let k = 0;
	while (held.has(k)) k++;
	return k;
}

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
 * Whether the batch ended without landing: its passers to form the next
 * batch, or held.
 * @param {Batch} b
 */
const isDone = (b) => b.phase === "requeued" || b.phase === "held";

/**
 * The members `main` holds: every one a landed batch merged, else those its
 * serial steps landed.
 * @param {Batch} b
 */
const landedOf = (b) =>
	b.phase === "landed"
		? included(b)
		: included(b).filter((m) => b.serial?.landed.includes(m.name));

/**
 * Every queue ref waiting, at the sha it holds now, as a batch onto `onto`
 * at the line's tail; only those of `ahead` where any of them waits.
 * @param {readonly QueueRef[]} queue
 * @param {string} onto
 * @param {readonly string[]} ahead
 * @param {Pipeline} p the pipeline it joins, its spent batches left out
 * @returns {QueueAction}
 */
function takeBatch(queue, onto, ahead, p) {
	const first = queue.filter((r) => ahead.includes(r.name));
	const members = (first.length > 0 ? first : queue)
		.map(({ name, sha, pushedAt }) => ({ name, sha, pushedAt }))
		.sort(byPushOrder);
	/** @type {Batch} */
	const batch = {
		slot: freeSlot(p),
		members,
		deferred: [],
		dropped: [],
		onto,
		integration: null,
		phase: "merging",
		...redPathAtRest(),
	};
	/* A done search, held or re-batched, is replaced by the take, which
	 * takes its members. */
	const search = p.search && isDone(p.search) ? null : p.search;
	return {
		kind: "take-batch",
		batch,
		pipeline: { ...p, search, line: [...p.line, batch] },
	};
}

/**
 * A batch's red-path fields before any red: a fresh object per call, so no
 * two batches share its lists.
 * @returns {Pick<Batch, "ahead"|"blame"|"isolated"|"serial"|"hold"|"bases">}
 */
function redPathAtRest() {
	return {
		ahead: [],
		blame: null,
		isolated: [],
		serial: null,
		hold: null,
		bases: [],
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
 * @param {Member} m
 * @param {string} onto
 * @param {Cause} cause
 * @param {QueueState} s
 * @returns {QueueAction}
 */
const dropAction = (m, onto, cause, s) => ({
	kind: "drop-member",
	drop: {
		name: m.name,
		sha: m.sha,
		ref: droppedRefFor(m, s.dropped),
		onto,
		cause,
		ticket: null,
		at: s.now,
	},
});

/**
 * The merge of the member `name` alone onto `onto` this run made, where it
 * was not recorded, else null.
 * @param {QueueState} s
 * @param {string} name
 * @param {string} onto
 * @returns {MergeResult|null}
 */
const aloneAt = (s, name, onto) =>
	s.alone?.name === name && s.alone.onto === onto ? s.alone.result : null;

/**
 * Drop or defer the member the batch merge stopped at: merged alone onto
 * `main`, it conflicts only with what is ahead of it, a batch ahead's
 * member among them, and is deferred.
 * @param {readonly Member[]} members the batch's, still in it
 * @param {QueueState} s
 * @param {{onto: string, result: Unmerged}} u
 * @param {string} main
 * @returns {QueueAction}
 */
function unmergedAction(members, s, u, main) {
	const { name } = u.result;
	const m = members.find((x) => x.name === name);
	if (!m) return exit(`queue/${name} did not merge, but is no batch member`);
	if (members[0] === m && u.onto === main)
		return dropAction(m, main, u.result, s);
	const alone = aloneAt(s, name, main);
	if (alone === null) return { kind: "merge-alone", onto: main, member: m };
	if (alone.kind === "merged") return { kind: "defer-member", name };
	return dropAction(m, main, alone, s);
}

/** @param {readonly string[]} a @param {readonly string[]} b */
const sameFiles = (a, b) =>
	a.length === b.length && a.every((f) => b.includes(f));

/**
 * The green or red ledgered for the run `r`, else null.
 * @param {QueueState} s
 * @param {TestRun} r
 * @returns {Exclude<Verdict, {kind: "unknown"}>|null}
 */
function ledgered(s, { sha, files, pass }) {
	const got = s.verdictOf(sha, files, pass);
	if (got === null) return null;
	const { verdict: v, at } = got;
	if (v.kind === "unknown") return null;
	return v.kind === "red" && v.noRun && s.now - at >= NO_RUN_RETAKE_MS
		? null
		: v;
}

/**
 * The exit naming why this run's ask for the run `r` reached no verdict,
 * else null.
 * @param {QueueState} s
 * @param {TestRun} r
 * @returns {QueueEnd|null}
 */
function unreadExit(s, { sha, files, pass }) {
	const u = s.unread.find(
		(x) => x.sha === sha && x.pass === pass && sameFiles(x.files, files),
	);
	return u ? exit(`no verdict at ${short(sha)}: ${u.reason}`) : null;
}

/**
 * `ask`, or a wait where `r` is asked already, or the tester, not
 * `parallel`, awaits another ask.
 * @param {QueueState} s
 * @param {TestRun} r
 * @param {QueueAction} ask
 * @returns {QueueAction}
 */
const askOrWait = (s, r, ask) =>
	s.isPending(r) || (!s.parallel && s.busy) ? WAIT : ask;

/**
 * The verdict ledgered for the run `r`, else `ask`, or the exit where this
 * run asked and reached none.
 * @param {QueueState} s
 * @param {TestRun} r
 * @param {QueueAction} ask
 * @returns {{v: Exclude<Verdict, {kind: "unknown"}>} | {action: QueueAction}}
 */
function verdictOr(s, r, ask) {
	const v = ledgered(s, r);
	if (v !== null) return { v };
	return { action: unreadExit(s, r) ?? askOrWait(s, r, ask) };
}

/**
 * Whether `main` may move to a sha `v` judged green.
 * @param {Verdict} v
 * @param {QueueState} s
 */
const isLandable = (v, s) =>
	v.kind === "green" && (!s.requiresRun || v.run !== undefined);

/**
 * @param {Verdict} v
 * @param {QueueState} s
 * @param {Extract<QueueAction, {sha: string}>} land
 * @returns {QueueAction}
 */
const landGreen = (v, s, land) =>
	isLandable(v, s)
		? land
		: exit(`no verdict at ${short(land.sha)}: its green read no CI run`);

/**
 * @param {string} main
 * @param {readonly string[]} files
 */
const baseKey = (main, files) => `${main} ${[...files].sort().join(",")}`;

/**
 * @typedef {{readonly base: readonly string[],
 *   readonly left: readonly string[], readonly baseOnly: boolean,
 *   readonly noRun?: true}} BaseRead what of a red `main` shares: the files
 *   red there too, the rest, whether nothing is left, and `noRun` where
 *   what it shares is that no run fired at either
 */

/**
 * @param {Failure} a
 * @param {Failure} b
 */
const isSameFailure = (a, b) =>
	a.file === b.file &&
	a.test === b.test &&
	(a.signature === undefined ||
		b.signature === undefined ||
		a.signature === b.signature);

/**
 * @param {Verdict|null|undefined} v
 * @param {string} file
 * @returns {Failure[]}
 */
const failuresIn = (v, file) =>
	v?.kind === "red" ? (v.failures ?? []).filter((f) => f.file === file) : [];

/**
 * Null where either names no test in `file`.
 * @param {Verdict|null|undefined} v
 * @param {Verdict|null} onMain
 * @param {string} file
 * @returns {boolean|null}
 */
function isRepeatOfMain(v, onMain, file) {
	const got = failuresIn(v, file);
	const there = failuresIn(onMain, file);
	if (got.length === 0 || there.length === 0) return null;
	return got.every((f) => there.some((m) => isSameFailure(f, m)));
}

/**
 * The files of `checked` red on `main`: those a red run there named, or all
 * of them where it named none of them, less any where `v` fails a test `main`
 * did not.
 * @param {Verdict|null} onMain
 * @param {string[]} checked
 * @param {Verdict|null} [v]
 */
function redOnMain(onMain, checked, v) {
	if (onMain?.kind !== "red") return [];
	const named = checked.filter((f) => onMain.files.includes(f));
	return (named.length > 0 ? named : checked).filter(
		(f) => isRepeatOfMain(v, onMain, f) !== false,
	);
}

/**
 * Whether `main`'s verdict `onMain` shares `v`, a red naming no file: no run
 * fired at either, or `main` failed every job `v` did.
 * @param {Verdict} onMain
 * @param {Extract<Verdict, {kind: "red"}>} v
 */
function sharesWhole(onMain, v) {
	if (onMain.kind !== "red") return false;
	if (v.noRun) return onMain.noRun === true;
	const jobs = onMain.jobs ?? [];
	return (v.jobs ?? []).every((j) => jobs.includes(j));
}

/**
 * The base check at `main` of `v`, red on its rerun: the run it is owed,
 * else what of it `main` shares. A red naming no file is `main`'s where `main` fails every job it does.
 * A tree that fired no run takes no green off the green ledger (#4571).
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @param {Extract<Verdict, {kind: "red"}>} v
 * @returns {{action: QueueAction} | {read: BaseRead}}
 */
function baseCheck(b, s, main, v) {
	const files = [...v.files];
	const at = s.greenAt(main);
	const onMain =
		b.bases.find((x) => x.sha === main && sameFiles(x.files, files))?.verdict ??
		(!v.noRun && at !== null && s.now - at < BASE_GREEN_MS
			? /** @type {Verdict} */ ({ kind: "green" })
			: undefined);
	if (onMain === undefined) {
		const r = { sha: main, files, pass: BASE_PASS };
		return {
			action:
				unreadExit(s, r) ??
				askOrWait(s, r, { kind: "check-base", sha: main, files }),
		};
	}
	if (files.length === 0) {
		const baseOnly = sharesWhole(onMain, v);
		return {
			read: {
				base: [],
				left: [],
				baseOnly,
				...(baseOnly && v.noRun ? { noRun: v.noRun } : {}),
			},
		};
	}
	const base = redOnMain(onMain, files, v);
	const left = files.filter((f) => !base.includes(f));
	return { read: { base, left, baseOnly: left.length === 0 } };
}

/**
 * The step a base check owes: the base-red ticket filed where `main` shares
 * any of the red, then, where it shares all of it, `land` or the hold; null
 * where some of the red is left to blame.
 * @param {QueueState} s
 * @param {string} main
 * @param {BaseRead} read
 * @param {Extract<QueueAction, {sha: string}>} land
 * @returns {QueueAction|null}
 */
function baseAction(s, main, { base, baseOnly, noRun }, land) {
	if (
		(base.length > 0 || baseOnly) &&
		!s.baseFiled.includes(baseKey(main, base))
	)
		return { kind: "file-base-red", sha: main, files: base };
	if (!baseOnly) return null;
	/* Spec #4458's story 26 lands a red only `main` shares, but GitHub's
	 * `main: suite passed` ruleset, with no bypass, takes no sha whose
	 * `Suite passed` failed: where `main` takes only a sha a CI run passed
	 * the batch is held instead, never ledgered green, and its fix lands as a
	 * later batch (#4485). Residual: held, the queue waits on that fix, a new
	 * ref or a move of `main`; the local tester lands past `main`'s reds, its
	 * base-red ticket their one trace. */
	return s.requiresRun
		? {
				kind: "hold",
				hold: {
					kind: "base",
					main,
					files: base,
					ticket: s.baseTicket,
					...(noRun ? { retakeAt: s.now + NO_RUN_RETAKE_MS } : {}),
				},
			}
		: land;
}

/**
 * The next step on the integration commit `sha`, whose whole suite was red
 * on `whole`.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @param {{sha: string, whole: Extract<Verdict, {kind: "red"}>}} red
 * @returns {QueueAction}
 */
function redAction(b, s, main, { sha, whole }) {
	/** @type {QueueAction} */
	const land = { kind: "fast-forward-main", sha };
	const rerun = { sha, files: whole.files, pass: 2 };
	/* Retried in its own run already: red again there, so no re-run (#4545). */
	const again = whole.retried
		? { v: whole }
		: verdictOr(s, rerun, { kind: "rerun-files", ...rerun });
	if ("action" in again) return again.action;
	if (again.v.kind === "green") return landGreen(again.v, s, land);
	const files = again.v.files.length > 0 ? again.v.files : whole.files;
	const checked = baseCheck(b, s, main, { ...again.v, files });
	if ("action" in checked) return checked.action;
	const owed = baseAction(s, main, checked.read, land);
	if (owed) return owed;
	const { base, left } = checked.read;
	const members = included(b).map((m) => m.name);
	return { kind: "start-isolation", blame: { files: left, base, members } };
}

/**
 * @param {Extract<Verdict, {kind: "red"}>} v
 * @returns {{noRun?: true}}
 */
const noRunOf = (v) => (v.noRun ? { noRun: v.noRun } : {});

/**
 * The `lander/iso-*` ref a run alone on `files` is pushed to, `k` its
 * member's index or `base` for `main`: an iso-suite one for the whole
 * suite, whose push the suite runs on.
 * @param {readonly string[]} files
 * @param {number | "base"} k
 */
const isoBranch = (files, k) =>
	`${files.length > 0 ? LANDER_ISO_PREFIX : LANDER_ISO_SUITE_PREFIX}${k}`;

/**
 * The next step of an isolation.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {Blame} blame
 * @returns {QueueAction}
 */
function isolationAction(b, s, blame) {
	const { onto } = b;
	const members = included(b).filter((m) => blame.members.includes(m.name));
	for (const m of members) {
		if (b.isolated.some((i) => i.name === m.name)) continue;
		const alone = aloneAt(s, m.name, onto);
		if (alone !== null && alone.kind !== "merged")
			return dropAction(m, onto, alone, s);
		return { kind: "merge-iso", onto, member: m };
	}
	const isolated = b.isolated.flatMap((i, k) =>
		members.some((m) => m.name === i.name && m.sha === i.sha)
			? [{ ...i, k }]
			: [],
	);
	/** @param {Isolated} i @param {number} pass */
	const at = (i, pass) => ledgered(s, { sha: i.iso, files: blame.files, pass });
	/**
	 * The runs of `of` with no verdict on `pass` asked, else null; the exit
	 * where this run asked one of them and reached none.
	 * @param {typeof isolated} of
	 * @param {1 | 2} pass
	 * @returns {QueueAction|null}
	 */
	const ask = (of, pass) => {
		const owed = of.filter((i) => at(i, pass) === null);
		for (const i of owed) {
			const r = { sha: i.iso, files: blame.files, pass };
			const stop = unreadExit(s, r);
			if (stop) return stop;
			if (s.isPending(r)) return WAIT;
		}
		if (owed.length === 0) return null;
		if (!s.parallel && s.busy) return WAIT;
		return {
			kind: pass === 1 ? "isolate-members" : "confirm-members",
			files: blame.files,
			runs: owed.map((i) => ({
				branch: isoBranch(blame.files, i.k),
				sha: i.iso,
			})),
		};
	};
	const first = ask(isolated, 1);
	if (first) return first;
	const reds = isolated.filter((i) => at(i, 1)?.kind === "red");
	const second = ask(reds, 2);
	if (second) return second;
	for (const i of reds) {
		const v = at(i, 2);
		const m = members.find((x) => x.name === i.name);
		if (v?.kind !== "red" || !m) continue;
		const files = v.files.length > 0 ? v.files : blame.files;
		return dropAction(
			m,
			onto,
			{
				kind: "red",
				name: m.name,
				files,
				iso: i.iso,
				...noRunOf(v),
			},
			s,
		);
	}
	if (blame.members.some((n) => b.dropped.includes(n)))
		return { kind: "rebatch-passers", ahead: members.map((m) => m.name) };
	return { kind: "start-serial", blame };
}

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function serialAction(b, s, main) {
	const blame = b.blame ?? { files: [], base: [], members: [] };
	const landed = b.serial?.landed ?? [];
	const order = included(b).filter((m) => blame.members.includes(m.name));
	const left = order.filter((m) => !landed.includes(m.name));
	/** @type {QueueAction} */
	const rebatch = { kind: "rebatch-passers", ahead: left.map((m) => m.name) };
	if (blame.members.some((n) => b.dropped.includes(n))) return rebatch;
	const [next] = left;
	if (next === undefined) return { kind: "record-landed", sha: main };
	const at = b.serial?.step;
	if (at?.name === next.name && at.sha === main)
		return { kind: "record-step", sha: main, name: next.name };
	if (at?.name === next.name && at.onto === main)
		return stepAction(
			b,
			s,
			{ ...at, member: next },
			{ blame, landed, rebatch },
		);
	/* Each member merged into the batch in this order, so one that will not
	 * now is no collision's culprit: the rest are batched again. */
	if (aloneAt(s, next.name, main) !== null) return rebatch;
	return {
		kind: "serial-land-step",
		onto: main,
		member: next,
		fresh: isRefused(s, [next]),
	};
}

/**
 * The serial step `at`, its member merged onto `main`: landed where its
 * whole suite passes, its member dropped where it is red twice on a blamed
 * file, or on any where the red named none; held where the remote refused
 * it.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {Step & {member: Member}} at
 * @param {{blame: Blame, landed: readonly string[], rebatch: QueueAction}}
 *   so the blame, the members landed before it, and the re-batch of the rest
 * @returns {QueueAction}
 */
function stepAction(b, s, { sha, onto, member }, { blame, landed, rebatch }) {
	const refused = refusedHold(s, onto, sha);
	if (refused) return refused;
	/** @type {QueueAction} */
	const land = { kind: "land-step", sha, name: member.name };
	if (s.isGreen(sha)) return land;
	const first = verdictOr(s, wholeRun(sha), { kind: "test-sha", sha });
	if ("action" in first) return first.action;
	if (first.v.kind === "green") return landGreen(first.v, s, land);
	const confirm = { sha, files: [], pass: 2 };
	const again = verdictOr(s, confirm, { kind: "rerun-files", ...confirm });
	if ("action" in again) return again.action;
	const { v } = again;
	if (v.kind === "green") return landGreen(v, s, land);
	if (blame.files.length === 0 || v.files.some((f) => blame.files.includes(f)))
		return dropAction(
			member,
			onto,
			{
				kind: "collision",
				name: member.name,
				files: v.files,
				step: sha,
				after: landed,
				...noRunOf(v),
			},
			s,
		);
	/* Red twice, but on no file the collision failed: no culprit of it. Its
	 * files are checked at this step's `main`, as earlier steps moved it past
	 * the batch's, and any red beyond `main`'s is batched again to be blamed
	 * on its own red path. */
	if (v.files.length === 0) return rebatch;
	const checked = baseCheck(b, s, onto, v);
	if ("action" in checked) return checked.action;
	return baseAction(s, onto, checked.read, land) ?? rebatch;
}

/**
 * Whether any of `members` is at a sha the remote refused on `main`.
 * @param {QueueState} s
 * @param {readonly Member[]} members
 */
const isRefused = (s, members) =>
	members.some((m) => s.refusalOf(m.sha) !== null);

/**
 * The hold of a batch at `main` whose landing sha `sha` the remote refused,
 * else null.
 * @param {QueueState} s
 * @param {string} main
 * @param {string} sha
 * @returns {QueueAction|null}
 */
function refusedHold(s, main, sha) {
	const reason = s.refusalOf(sha);
	return reason === null
		? null
		: { kind: "hold", hold: { kind: "refused", main, sha, reason } };
}

/**
 * A member a landed batch merged whose queue ref still holds its snapshot,
 * owed its compare-and-delete, else undefined.
 * @param {Batch} b
 * @param {QueueState} s
 * @returns {Member|undefined}
 */
const landedOwed = (b, s) =>
	landedOf(b).find(
		(m) =>
			!s.kept.includes(`${m.name}@${m.sha}`) &&
			s.queue.some((r) => r.name === m.name && r.sha === m.sha),
	);

/**
 * Whether the batch is spent: it holds no member, or it landed and no
 * member's ref is owed its delete.
 * @param {Batch} b
 * @param {QueueState} s
 */
const isSpent = (b, s) =>
	included(b).length === 0 ||
	(b.phase === "landed" && landedOwed(b, s) === undefined);

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @returns {QueueAction}
 */
function deleteOwed(b, s) {
	const m = landedOwed(b, s);
	return m
		? { kind: "delete-landed-ref", name: m.name, sha: m.sha }
		: exit("a landed batch owed no delete");
}

/**
 * The head's red or refusal taking it out of the line as the search: every
 * run behind it cancelled, finished or not, as a restart no longer knows
 * which it asked, and the batches behind it merged again onto `main`, as
 * many as the window holds. A red drops the window to DEPTH_FLOOR; a refusal
 * keeps it, as it says nothing of the batches. A wait while another search
 * runs.
 * @param {QueueState} s
 * @param {Live} live the live line, the head first, and the live search
 * @param {boolean} red
 * @returns {QueueAction}
 */
function detachAction(s, { line, search }, red) {
	if (search && !isDone(search)) return WAIT;
	const [head, ...rest] = line;
	if (!head) return exit("a detach with no head");
	const depth = red ? DEPTH_FLOOR : s.pipeline.depth;
	const cancel = rest.flatMap((b) =>
		b.integration === null ? [] : [{ sha: b.integration, slot: b.slot }],
	);
	/** @type {Batch[]} */
	const rebuilt = rest
		.slice(0, depth)
		.map((b) => ({ ...b, integration: null, phase: "merging" }));
	return {
		kind: "detach",
		slot: head.slot,
		cancel,
		pipeline: { line: rebuilt, search: head, depth },
	};
}

/**
 * The merge of `b` onto `base`, where it is not merged there yet: a batch
 * merged onto a base that has since moved is merged again onto the new one,
 * so `main` only ever fast-forwards; else null.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} base
 * @returns {QueueAction|null}
 */
function mergeStep(b, s, base) {
	if (b.phase !== "merging" && b.onto === base && b.integration !== null)
		return null;
	const members = included(b);
	return {
		kind: "merge-members",
		onto: base,
		members,
		fresh: isRefused(s, members),
	};
}

/**
 * The step a landed batch owes, or one whose integration commit `main`
 * already holds: its refs' deletes, or its landing recorded; else null.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction|null}
 */
function landedStep(b, s, main) {
	if (b.phase === "landed") return deleteOwed(b, s);
	if (b.integration === main) return { kind: "record-landed", sha: main };
	return null;
}

/**
 * The next step of the line's head, merged onto `main`: the only batch that
 * lands.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @param {Live} live
 * @returns {QueueAction}
 */
function headAction(b, s, main, live) {
	const landed = landedStep(b, s, main);
	if (landed) return landed;
	if (live.search?.phase === "serial") return WAIT;
	if (s.unmerged?.onto === main)
		return unmergedAction(included(b), s, s.unmerged, main);
	const merge = mergeStep(b, s, main);
	if (merge || b.integration === null) return merge ?? WAIT;
	const sha = b.integration;
	if (s.refusalOf(sha) !== null) return detachAction(s, live, false);
	/** @type {QueueAction} */
	const land = { kind: "fast-forward-main", sha };
	if (s.isGreen(sha)) return land;
	const got = verdictOr(s, wholeRun(sha), { kind: "test-sha", sha });
	if ("action" in got) return got.action;
	if (got.v.kind === "red") return detachAction(s, live, true);
	return landGreen(got.v, s, land);
}

/**
 * The next step of a batch behind the head: merged onto `prev`'s
 * integration commit and its run started, then a wait until it heads the
 * line. A member that will not merge is deferred or dropped as the head's
 * is, judged alone on `main`.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @param {{prev: Batch, search: Batch|null}} around the batch ahead of it,
 *   and the live search
 * @returns {QueueAction}
 */
function followerAction(b, s, main, { prev, search }) {
	const base = prev.integration;
	if (search?.phase === "serial" || base === null || prev.phase === "merging")
		return WAIT;
	if (s.unmerged?.onto === base)
		return unmergedAction(included(b), s, s.unmerged, main);
	const merge = mergeStep(b, s, base);
	if (merge || b.integration === null) return merge ?? WAIT;
	const r = wholeRun(b.integration);
	const ahead = ledgered(s, wholeRun(base));
	if (
		ahead?.kind === "red" ||
		ledgered(s, r) !== null ||
		s.unread.some((u) => u.sha === r.sha && u.pass === 1)
	)
		return WAIT;
	return askOrWait(s, r, { kind: "test-sha", sha: r.sha });
}

/**
 * The next step of the search: the red path, on the `main` it was merged
 * onto; its green landed where `main` is still there, else its members
 * batched again.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function searchAction(b, s, main) {
	const landed = landedStep(b, s, main);
	if (landed) return landed;
	if (isDone(b)) return landedOwed(b, s) ? deleteOwed(b, s) : WAIT;
	if (b.phase === "isolating" && b.blame) return isolationAction(b, s, b.blame);
	if (b.phase === "serial") return serialAction(b, s, main);
	return searchRedAction(b, s, main);
}

/**
 * The search's first steps, its whole suite red at its integration commit:
 * the rerun and the base check, at the `main` it was merged onto.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function searchRedAction(b, s, main) {
	const sha = b.integration;
	if (sha === null) return exit("a search with no integration commit");
	const refused = refusedHold(s, b.onto, sha);
	if (refused) return refused;
	/** @type {QueueAction} */
	const land = { kind: "fast-forward-main", sha };
	/** @type {QueueAction} */
	let next = land;
	if (!s.isGreen(sha)) {
		const got = verdictOr(s, wholeRun(sha), { kind: "test-sha", sha });
		if ("action" in got) return got.action;
		next =
			got.v.kind === "red"
				? redAction(b, s, b.onto, { sha, whole: got.v })
				: landGreen(got.v, s, land);
	}
	if (next.kind === "fast-forward-main" && main !== b.onto)
		return { kind: "rebatch-passers", ahead: included(b).map((m) => m.name) };
	return next;
}

/**
 * The exit naming the hold, where it stands: `main` where it stopped, no
 * queue ref waiting that the batch did not take, and its retake not due.
 * @param {Batch} b
 * @param {number} now
 * @param {string} main
 * @param {readonly QueueRef[]} waiting
 * @returns {QueueEnd|null}
 */
function heldExit({ hold, members }, now, main, waiting) {
	if (hold === null || hold.main !== main) return null;
	const retakeAt = hold.kind === "base" ? hold.retakeAt : undefined;
	if (retakeAt !== undefined && now >= retakeAt) return null;
	if (
		waiting.some(
			(r) => !members.some((m) => m.name === r.name && m.sha === r.sha),
		)
	)
		return null;
	const until = `retaken once a new ref waits or main moves${
		retakeAt === undefined
			? ""
			: `, or at ${new Date(retakeAt).toISOString()} as no run fired at main either`
	}`;
	if (hold.kind === "refused")
		return exit(
			`held: the push of ${short(hold.sha)} to main was refused: ${hold.reason}; ${until}`,
		);
	const on =
		hold.files.length > 0
			? `on ${hold.files.join(", ")}`
			: "on the whole suite, naming no file";
	const ticket =
		hold.ticket === null ? "its base-red ticket unfiled" : `#${hold.ticket}`;
	return exit(
		`held: red only where main at ${short(main)} is too, ${on}, ${ticket}; ${until}`,
	);
}

/**
 * What a crash or a refusal left owed before anything else: a drop cut
 * short, a fix ticket unfiled, a refused sha still green-ledgered; else null.
 * @param {QueueState} s
 * @returns {QueueAction|null}
 */
function owedAction(s) {
	const cut = s.drops.find(
		(d) =>
			d.reapedAt === undefined &&
			!s.dropped.some((r) => r.ref === d.ref && r.sha === d.sha) &&
			!(d.ticket !== null && s.isClosed(d.ticket)),
	);
	if (cut) return { kind: "drop-member", drop: cut };
	const orphan = s.dropped.find(
		(r) =>
			!s.unfiled.includes(r.ref) &&
			!s.drops.some((d) => d.ref === r.ref && d.sha === r.sha),
	);
	if (orphan && s.main !== null)
		return { kind: "adopt-dropped-ref", ...orphan, onto: s.main };
	const owed = s.drops.find(
		(d) => d.ticket === null && !s.unfiled.includes(d.ref),
	);
	if (owed) return { kind: "file-fix-ticket", drop: owed };
	/* Off the green ledger, so the pre-push gate passes no later push of a sha
	 * the remote refused, before the batch merges again past it. */
	const pushed = batchesOf(s.pipeline)
		.flatMap((b) => [
			b.integration,
			b.serial?.step?.sha,
			b.hold?.kind === "refused" ? b.hold.sha : null,
		])
		.find((sha) => sha && s.isGreen(sha) && s.refusalOf(sha) !== null);
	return pushed ? { kind: "unledger", sha: pushed } : null;
}

/**
 * The batch a new take joins the line as, where the window has room and the
 * tail's run is under way on a base not known red; else null.
 * @param {QueueState} s
 * @param {string} main
 * @param {Live} live
 * @param {readonly QueueRef[]} waiting
 * @returns {QueueAction|null}
 */
function fillAction(s, main, { line, search }, waiting) {
	if (waiting.length === 0 || s.superseded) return null;
	const depth = Math.min(s.pipeline.depth, s.parallel ? DEPTH_CEILING : 1);
	if (line.length >= depth || search?.phase === "serial") return null;
	const tail = line.at(-1);
	if (tail && (tail.integration === null || tail.phase === "merging"))
		return null;
	const onto = tail?.integration ?? main;
	if (tail && ledgered(s, wholeRun(onto))?.kind === "red") return null;
	if (search?.phase === "held" && heldExit(search, s.now, main, waiting))
		return null;
	const ahead = search?.phase === "requeued" ? search.ahead : [];
	return takeBatch(waiting, onto, ahead, {
		...s.pipeline,
		line: [...line],
		search,
	});
}

/**
 * The batches the pipeline record holds that are not spent.
 * @param {QueueState} s
 * @returns {Live}
 */
function liveOf(s) {
	const { search } = s.pipeline;
	return {
		line: s.pipeline.line.filter((b) => !isSpent(b, s)),
		search: search && !isSpent(search, s) ? search : null,
	};
}

/**
 * The first step a live batch owes, the search first, then the line in
 * queue order; null where each waits.
 * @param {QueueState} s
 * @param {string} main
 * @param {Live} live
 * @returns {{action: QueueAction, slot: number}|null}
 */
function batchStep(s, main, live) {
	const { line, search } = live;
	if (search) {
		const action = searchAction(search, s, main);
		if (action.kind !== "wait") return { action, slot: search.slot };
	}
	for (const [k, b] of line.entries()) {
		const prev = line[k - 1];
		const action = prev
			? followerAction(b, s, main, { prev, search })
			: headAction(b, s, main, live);
		if (action.kind !== "wait") return { action, slot: b.slot };
	}
	return null;
}

/**
 * The names a live batch holds, and the queue refs waiting for a take: in
 * no live batch, at no sha a batch landed or a delete found moved.
 * @param {QueueState} s
 * @param {Live} live
 */
function waitingOf(s, { line, search }) {
	const flying = new Set(
		[...line, ...(search && !isDone(search) ? [search] : [])].flatMap((b) =>
			b.members.map((m) => m.name),
		),
	);
	const landed = batchesOf(s.pipeline).flatMap((b) =>
		landedOf(b).map((m) => `${m.name}@${m.sha}`),
	);
	const waiting = s.queue.filter(
		(r) =>
			!flying.has(r.name) &&
			!s.kept.includes(`${r.name}@${r.sha}`) &&
			!landed.includes(`${r.name}@${r.sha}`),
	);
	return { flying, waiting };
}

/**
 * The step with no batch in flight owing one: a dropped ref reaped, else
 * the run's end.
 * @param {QueueState} s
 * @param {string} main
 * @param {Batch|null} search
 * @param {readonly QueueRef[]} waiting
 * @returns {QueueAction}
 */
function idleAction(s, main, search, waiting) {
	const reaped = s.drops.find(
		(d) =>
			d.reapedAt === undefined && d.ticket !== null && s.isClosed(d.ticket),
	);
	if (reaped)
		return { kind: "delete-dropped-ref", ref: reaped.ref, sha: reaped.sha };
	/* A landed batch's member still waiting moved after its snapshot. */
	if (waiting.length === 0) return exit("no queue ref waits");
	if (s.superseded)
		return {
			...exit(
				"main changed this lander's own code; a fresh run takes the queue",
			),
			relaunch: main,
		};
	return (
		(search?.phase === "held" && heldExit(search, s.now, main, waiting)) ||
		exit("no queue ref the window can take")
	);
}

/**
 * @param {QueueState} s
 * @returns {{action: QueueAction, slot: number|null}} the action, and the
 *   slot of the batch it acts on, null for none
 */
function nextQueueAction(s) {
	const next = stepOrEnd(s);
	/* An end awaits each ask in flight first, so a verdict a run reached is
	 * kept rather than asked again by the next. */
	return next.action.kind === "exit" && s.busy
		? { action: { kind: "await-verdict" }, slot: null }
		: next;
}

/**
 * @param {QueueState} s
 * @returns {{action: QueueAction, slot: number|null}}
 */
function stepOrEnd(s) {
	const { main } = s;
	/** @param {QueueAction} action */
	const unslotted = (action) => ({ action, slot: null });
	if (main === null) return unslotted(exit("the remote has no main branch"));
	const owed = owedAction(s);
	if (owed) {
		const d = owed.kind === "drop-member" ? owed.drop : null;
		const holder = batchesOf(s.pipeline).find((b) =>
			b.members.some((m) => m.name === d?.name && m.sha === d.sha),
		);
		return { action: owed, slot: holder?.slot ?? null };
	}
	const live = liveOf(s);
	const stepped = batchStep(s, main, live);
	if (stepped) return stepped;
	const { flying, waiting } = waitingOf(s, live);
	const fill = fillAction(s, main, live, waiting);
	if (fill) return unslotted(fill);
	if (s.busy) return unslotted({ kind: "await-verdict" });
	if (flying.size > 0)
		return unslotted(
			exit("no batch in flight has a step, and no verdict awaits"),
		);
	return unslotted(idleAction(s, main, live.search, waiting));
}

/**
 * @typedef {object} QueueGit
 * @property {() => QueueRefs} refs
 * @property {(onto: string, members: readonly Member[], fresh?: boolean,
 *   started?: (sha: string) => void) => MergeResult} mergeMembers each member
 *   merged in order onto `onto`, in the lander's own worktree; a lone member
 *   descending from `onto` is itself the integration commit, unless `fresh`,
 *   where it is merged as a new commit. Where the tester's run repeats the
 *   gates the batch's pass leaves out, `started` is given the members'
 *   merges before that pass runs, so their run starts alongside it (#4573)
 * @property {(slot: number, sha: string) => void} pushBatch `sha` to the
 *   lander's `lander/batch-<slot>` ref, forced, so a tester reading that
 *   ref's runs sees it
 * @property {(branch: string, sha: string) => void} pushIso `sha` to the
 *   lander's `lander/iso-*` ref `branch`, forced, before its verdict is
 *   asked, as the tester tells a run alone by the remote's iso refs
 * @property {(sha: string) => string|null} pushMain a plain, non-forced push
 *   of `sha` to the remote's `main`: the remote's refusal line where it
 *   refused it for good, as a ruleset does, else null, throwing on any other
 *   failure, a network fault or `main` moved under it among them
 * @property {(branch: string, sha: string) => boolean} deleteRef deletes the
 *   remote's `branch` only where it still holds `sha`, false where it moved
 * @property {(sha: string, of: string) => boolean} isAncestor whether `sha`
 *   is `of` or an ancestor of it
 * @property {(branch: string, sha: string) => void} createRef creates the
 *   remote's `branch` at `sha`, refused where it holds another sha
 * @typedef {object} QueueTracker
 * @property {(d: Drop) => string} fileDropTicket files the drop's fix ticket,
 *   returning the line naming it, as `#<n>`, and throwing a FilingRefusedError
 *   where the tracker refuses it for good
 * @property {(name: string, sha: string) => number|null} findDropTicket the
 *   fix ticket, open or closed, filed for `queue/<name>` dropped at `sha`,
 *   null where the tracker holds none, throwing where it cannot be searched
 * @property {(sha: string, files: readonly string[]) => string} fileBaseRed
 *   files the one base-red ticket for `files` red at `main`'s `sha`, or
 *   refreshes the open one, returning the line naming it
 * @property {(n: number) => "open" | "closed"} stateOf the ticket's state,
 *   throwing where it cannot be read
 * @typedef {object} DropRecord
 * @property {() => Drop[]} read
 * @property {(drops: readonly Drop[]) => void} write
 * @typedef {"take" | "land" | "drop"} LanderEvent
 * @typedef {{readonly verdict: Verdict, readonly at: number}} Ledgered a
 *   ledgered verdict and when it was ledgered, in ms
 * @typedef {object} VerdictLedger
 * @property {(sha: string, files: readonly string[], pass?: number) =>
 *   Ledgered|null} get
 * @property {(sha: string, files: readonly string[], v: Verdict,
 *   pass?: number) => void} add
 * @typedef {object} RefusedRecord every sha the remote refused on `main`,
 *   kept for good, as no batch may push one again
 * @property {(sha: string) => string|null} refusalOf the refusal of `sha`,
 *   null where none
 * @property {(sha: string, reason: string) => void} add
 * @typedef {object} PipelineRecord
 * @property {() => Pipeline|null} read
 * @property {(p: Pipeline) => void} write
 * @typedef {object} QueueLanderDeps
 * @property {QueueGit} git
 * @property {QueueTester} tester
 * @property {Ledger & {remove: (sha: string) => void,
 *   greenAt: (sha: string) => number|null}} ledger the green
 *   ledger the pre-push gate on `main` reads
 * @property {VerdictLedger} verdicts
 * @property {RefusedRecord} refused
 * @property {PipelineRecord} record
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
 * @property {(sha: string) => boolean} [mainMoved] after each move of `main`
 *   to `sha`: true where that changed the code this run loaded and the
 *   checkout now carries it
 * @property {() => number} now the clock, in ms
 * @property {(line: string) => void} [say] reports a fix or base-red ticket
 *   filed or left unfiled, or one whose state was not read, and a run not
 *   cancelled or an early batch push that failed
 * @typedef {Pick<QueueState, "pipeline" | "unread" | "unmerged" | "alone"
 *   | "kept" | "unfiled" | "isClosed" | "baseFiled" | "baseTicket"
 *   | "superseded"> & {pending: Map<string, Pending>, acting: Batch|null}}
 *   QueueRun what a run carries between actions; `pending` its asks awaiting
 *   their verdicts, by their runs, shared by every copy of the run; `acting`
 *   the batch the action under way acts on
 * @typedef {{readonly runs: readonly TestRun[],
 *   readonly settled: Promise<Settled>}} Pending an ask in flight
 * @typedef {{ok: true, apply: (deps: QueueLanderDeps, run: QueueRun) =>
 *   QueueRun} | {ok: false, err: unknown}} Settled an ask's end: its
 *   verdicts to keep, or what it threw
 * @typedef {Omit<QueueLanderDeps, "record"> & {record: {write: (b: Batch) =>
 *   void}}} BatchDeps the deps an action on one batch runs on, its record
 *   writing that batch into the pipeline
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
 * The batch with `name` dropped: merged again without it, or, isolating or
 * landing serially, going on without it.
 * @param {Batch} b
 * @param {string} name
 * @returns {Batch}
 */
const droppedFrom = (b, name) =>
	b.phase === "isolating" || b.phase === "serial"
		? { ...b, dropped: [...b.dropped, name] }
		: leaveOut(b, name, "dropped");

/**
 * @param {QueueRun} run
 * @returns {Batch}
 */
function batchOf(run) {
	if (run.acting === null) throw new Error("a batch action with no batch");
	return run.acting;
}

/**
 * Drops the member, each record written before the refs it names, so a rerun
 * after a crash finishes the drop and never lands the member: the drop
 * record first, whose row a rerun finishes before the batch goes on. A step
 * repeated after a crash finds its ref already made, and keeps its filed
 * ticket.
 * @param {BatchDeps} deps
 * @param {Drop} d
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function dropMember(deps, d, run) {
	const { acting: batch } = run;
	const member = batch?.members.some(
		(m) => m.name === d.name && m.sha === d.sha,
	);
	const left =
		batch && member && !batch.dropped.includes(d.name)
			? droppedFrom(batch, d.name)
			: batch;
	const drops = deps.drops.read();
	const was = drops.find((x) => x.ref === d.ref && x.sha === d.sha);
	deps.drops.write([
		...drops.filter((x) => x !== was),
		{ ...d, ticket: was?.ticket ?? null },
	]);
	if (left && left !== batch) deps.record.write(left);
	deps.git.createRef(d.ref, d.sha);
	deps.git.deleteRef(`${QUEUE_PREFIX}${d.name}`, d.sha);
	deps.logQueue("drop", d);
	return { ...run, acting: left, unmerged: null, alone: null };
}

/**
 * Files the drop's fix ticket and records its number. A filing that throws
 * other than transiently or for good, or prints no number, is reported and
 * left for the next run (#4485).
 * @param {BatchDeps} deps
 * @param {Drop} d
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function fileFixTicket(deps, d, run) {
	const { say = () => undefined } = deps;
	/** @param {string} why */
	const unfiled = (why) =>
		leaveUnfiled(deps, run, { ref: d.ref, undone: "filed", why });
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
 * The run with `ref`'s fix ticket left for the next run, reported.
 * @param {BatchDeps} deps
 * @param {QueueRun} run
 * @param {{ref: string, undone: "filed" | "searched", why: string}} left
 * @returns {QueueRun}
 */
function leaveUnfiled(deps, run, { ref, undone, why }) {
	const { say = () => undefined } = deps;
	say(`fix ticket for ${ref} not ${undone}, left for the next run: ${why}`);
	return { ...run, unfiled: [...run.unfiled, ref] };
}

/**
 * Writes back the drop record entry of a dropped ref none names, with the
 * fix ticket the tracker holds for it, its state read so a closed one is
 * reaped this run; with none, the next action files one, unless `main`
 * already holds its sha, where the ref is deleted instead. A search that
 * throws other than transiently is reported, and the ref left for the next
 * run, so no second ticket is filed on a search that read nothing (#4498).
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "adopt-dropped-ref"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function adoptDroppedRef(deps, { ref, sha, onto }, run) {
	const name = droppedNameOf(ref, sha);
	let ticket;
	try {
		ticket = deps.tracker.findDropTicket(name, sha);
	} catch (err) {
		if (isTransientFault(err)) throw err;
		return leaveUnfiled(deps, run, {
			ref,
			undone: "searched",
			why: parseRefusal(parseErrorText(err)),
		});
	}
	if (ticket === null && deps.git.isAncestor(sha, onto)) {
		deps.git.deleteRef(ref, sha);
		return run;
	}
	deps.drops.write([
		...deps.drops.read(),
		{
			name,
			sha,
			ref,
			onto,
			cause: { kind: "unrecorded", name },
			ticket,
			at: deps.now(),
		},
	]);
	if (ticket === null) return run;
	const closed = readClosed(deps, ticket, ref);
	const { isClosed } = run;
	return closed
		? { ...run, isClosed: (n) => n === ticket || isClosed(n) }
		: run;
}

/**
 * Keeps `v`, reached at `sha` on `files` on its `pass`, through `keep`, the
 * verdict ledger where absent; a no verdict is left for the machine to exit
 * on.
 * @param {Pick<QueueLanderDeps, "verdicts">} deps
 * @param {{sha: string, files: readonly string[], pass: number, v: Verdict}} r
 * @param {QueueRun} run
 * @param {(v: Exclude<Verdict, {kind: "unknown"}>) => QueueRun} [keep]
 * @returns {QueueRun}
 */
function writeVerdict(deps, { sha, files, pass, v }, run, keep) {
	if (v.kind === "unknown")
		return {
			...run,
			unread: [...run.unread, { sha, files, pass, reason: v.reason }],
		};
	if (keep) return keep(v);
	deps.verdicts.add(sha, files, v, pass);
	return run;
}

/**
 * The tester's verdict, beating the heartbeat while it is awaited. A
 * transient fault or no verdict is asked again with backoff, in the ask, as
 * the run goes on between; one that outlasts the tries throws as final, so
 * no retry of a step asks it afresh.
 * @param {Pick<QueueLanderDeps, "tester" | "beat" | "wait">} deps
 * @param {string} sha
 * @param {string[]} [files]
 * @param {boolean} [again]
 * @returns {Promise<Verdict>}
 */
async function verdictAt(deps, sha, files, again) {
	const { tester, beat } = deps;
	beat(sha);
	const timer = setInterval(() => beat(sha), HEARTBEAT_MS);
	try {
		return await remote(
			deps,
			async () => {
				const v = await tester.verdict(sha, files, again);
				if (v.kind === "unknown" && v.transient)
					throw new TransientFault(`no verdict at ${short(sha)}: ${v.reason}`);
				return v;
			},
			isTransientFault,
		);
	} catch (err) {
		throw isTransientFault(err) ? new Error(caught(err).message) : err;
	} finally {
		clearInterval(timer);
	}
}

/**
 * @param {readonly TestRun[]} runs
 */
const askKey = (runs) =>
	runs
		.map(({ sha, files, pass }) => `${sha} ${pass} ${[...files].sort()}`)
		.join(" + ");

/**
 * @param {TestRun} a
 * @param {TestRun} b
 */
const sameRun = (a, b) =>
	a.sha === b.sha && a.pass === b.pass && sameFiles(a.files, b.files);

/**
 * Starts the ask `ask` for `runs`, unawaited: the run goes on, and the
 * verdicts are kept through `keep` once a later step awaits them.
 * @template T
 * @param {QueueRun} run accumulator: the ask is set in its `pending`
 * @param {readonly TestRun[]} runs
 * @param {() => Promise<T>} ask
 * @param {(deps: QueueLanderDeps, run: QueueRun, got: T) => QueueRun} keep
 * @returns {QueueRun}
 */
function startAsk(run, runs, ask, keep) {
	/** @type {Promise<Settled>} */
	const settled = ask().then(
		(got) => ({ ok: true, apply: (deps, r) => keep(deps, r, got) }),
		(err) => ({ ok: false, err }),
	);
	run.pending.set(askKey(runs), { runs, settled });
	return run;
}

/**
 * Awaits the first ask in flight to end and keeps its verdicts; one that
 * threw is forgotten first, so the retry asks it again.
 * @param {QueueLanderDeps} deps
 * @param {QueueRun} run accumulator: the ended ask is deleted from its
 *   `pending`
 * @returns {Promise<QueueRun>}
 */
async function awaitVerdict(deps, run) {
	const [key, got] = await Promise.race(
		[...run.pending].map(([k, p]) =>
			p.settled.then((x) => /** @type {const} */ ([k, x])),
		),
	);
	run.pending.delete(key);
	if (!got.ok) throw got.err;
	return got.apply(deps, run);
}

/**
 * Forgets each ask in flight at `sha`.
 * @param {QueueRun} run accumulator: the asks at `sha` are deleted from its
 *   `pending`
 * @param {string} sha
 */
function forgetAsks(run, sha) {
	for (const [k, p] of run.pending)
		if (p.runs.some((r) => r.sha === sha)) run.pending.delete(k);
}

/**
 * Has the tester cancel every unfinished run on the batch ref of `slot` not
 * at `keep`, saying each sha of `expected` it listed no run at; a cancel
 * that throws is reported and stops nothing, as the runs' verdicts are only
 * unwanted (#4556, #4576).
 * @param {Pick<QueueLanderDeps, "tester" | "say">} deps
 * @param {number} slot
 * @param {string|null} keep
 * @param {readonly string[]} expected
 */
function cancelRuns(deps, slot, keep, expected) {
	const { say = () => undefined } = deps;
	const branch = batchBranch(slot);
	/** @type {string[]|undefined} */
	let listed;
	try {
		listed = deps.tester.cancel?.(branch, keep);
	} catch (err) {
		say(
			`runs on ${branch} not cancelled: ${parseRefusal(parseErrorText(err))}`,
		);
		return;
	}
	if (listed === undefined) return;
	for (const sha of expected)
		if (sha !== keep && !listed.includes(sha))
			say(
				`no run at ${short(sha)} listed on ${branch} to cancel; the next merge there, if any, cancels one listed later`,
			);
}

/**
 * Pushes `sha` to the batch's ref and starts the ask of its whole suite.
 * @param {BatchDeps} deps
 * @param {string} sha
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function testSha(deps, sha, run) {
	deps.git.pushBatch(batchOf(run).slot, sha);
	const r = wholeRun(sha);
	return startAsk(
		run,
		[r],
		() => verdictAt(deps, sha),
		(d, next, v) => writeVerdict(d, { ...r, v }, next),
	);
}

/**
 * Pushes each run's sha to its `lander/iso-*` ref, then starts an ask of
 * each one's verdict on `files`, each kept as it ends: all at once where the
 * tester is `parallel`, else one after another.
 * @param {BatchDeps} deps
 * @param {{runs: readonly IsoRun[], files: readonly string[], pass: number}}
 *   asked
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function testIsolated(deps, { runs, files, pass }, run) {
	for (const { branch, sha } of runs) deps.git.pushIso(branch, sha);
	/** @type {Promise<unknown>} */
	let ahead = Promise.resolve();
	return runs.reduce((next, { sha }) => {
		const r = { sha, files, pass };
		const after = ahead;
		const out = startAsk(
			next,
			[r],
			() =>
				deps.tester.parallel
					? verdictAt(deps, sha, [...files], pass === 2)
					: after.then(() => verdictAt(deps, sha, [...files], pass === 2)),
			(d, from, v) => writeVerdict(d, { ...r, v }, from),
		);
		ahead = out.pending.get(askKey([r]))?.settled ?? ahead;
		return out;
	}, run);
}

/**
 * Files or refreshes the base-red ticket. One that will not file is
 * reported, and stops nothing: the failures it names are `main`'s, which the
 * next batch red on them files again (#4485).
 * @param {BatchDeps} deps
 * @param {string} sha
 * @param {readonly string[]} files
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function fileBaseRed(deps, sha, files, run) {
	const { say = () => undefined } = deps;
	const baseFiled = [...run.baseFiled, baseKey(sha, files)];
	try {
		const line = deps.tracker.fileBaseRed(sha, files);
		say(line);
		const n = Number(FILED.exec(line)?.[1]);
		return { ...run, baseFiled, baseTicket: Number.isInteger(n) ? n : null };
	} catch (err) {
		if (isTransientFault(err)) throw err;
		say(
			`base-red ticket for main at ${short(sha)} not filed: ${parseRefusal(parseErrorText(err))}`,
		);
		return { ...run, baseFiled, baseTicket: null };
	}
}

/**
 * Logs the land row of the member `name` a serial step landed, then records
 * it landed; a crash between the two repeats the row, which the log takes
 * once.
 * @param {BatchDeps} deps
 * @param {string} name
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function recordStep(deps, name, run) {
	const b = batchOf(run);
	const m = b.members.find((x) => x.name === name);
	if (m) deps.logQueue("land", m);
	/** @type {Batch} */
	const batch = {
		...b,
		serial: { landed: [...(b.serial?.landed ?? []), name], step: null },
	};
	deps.record.write(batch);
	return { ...run, acting: batch };
}

/**
 * @param {BatchDeps} deps
 * @param {Batch} batch
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function recorded(deps, batch, run) {
	deps.record.write(batch);
	return { ...run, acting: batch };
}

/**
 * Moves `main` to `sha`, the integration commit or a serial step, then
 * records what landed; a push the remote refuses is written to the refused
 * record instead, for the machine to hold the batch on.
 * @param {BatchDeps} deps
 * @param {string} sha
 * @param {QueueRun} run
 * @param {(run: QueueRun) => QueueRun} landed records the landing
 * @returns {QueueRun}
 */
function moveMain(deps, sha, run, landed) {
	/* Ledgered first, so the pre-push gate can tell this push from any
	 * other. */
	if (!deps.ledger.has(sha)) deps.ledger.add(sha);
	const refusal = deps.git.pushMain(sha);
	if (refusal !== null) {
		deps.refused.add(sha, refusal);
		return run;
	}
	const next = landed(run);
	return deps.mainMoved?.(sha) === true ? { ...next, superseded: true } : next;
}

/**
 * Logs a land row for each member `main` moved past, then records the batch
 * landed; a crash between the two repeats the rows, which the log takes
 * once.
 * @param {BatchDeps} deps
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function recordLanded(deps, run) {
	/** @type {Batch} */
	const batch = { ...batchOf(run), phase: "landed" };
	for (const m of included(batch))
		if (!batch.serial?.landed.includes(m.name)) deps.logQueue("land", m);
	deps.record.write(batch);
	return { ...run, acting: batch };
}

/**
 * Merges the batch's members onto `action.onto`, pushing the merges to the
 * batch's ref before its gate pass, and records it testing where they merge.
 * Every unfinished run on the ref but the one at the sha it tests is
 * cancelled (#4573, #4576): never that one, as a restart's merge may
 * reproduce the sha a crash left pushed, and its push then fires no new run.
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "merge-members"}>} action
 * @param {QueueRun} run accumulator: the asks at the batch's recorded
 *   integration are deleted from its `pending`
 * @returns {QueueRun}
 */
function mergeBatch(deps, action, run) {
	const { git, record } = deps;
	const { integration: was, slot } = batchOf(run);
	if (was !== null) forgetAsks(run, was);
	const expected = was === null ? [] : [was];
	/** @type {string|null} */
	let started = null;
	/* A failed early push leaves the push to test-sha (#4573). */
	const merged = git.mergeMembers(
		action.onto,
		action.members,
		action.fresh,
		(sha) => {
			try {
				git.pushBatch(slot, sha);
				started = sha;
			} catch (err) {
				deps.say?.(
					`${short(sha)} not pushed before its gate pass: ${parseRefusal(parseErrorText(err))}`,
				);
				return;
			}
			cancelRuns(deps, slot, sha, expected);
		},
	);
	/* The run the merges started before the batch's gates is unwanted
	 * where the gates refused or committed edits on top (#4573). */
	const kept = merged.kind === "merged" ? merged.sha : null;
	if (started === null || kept !== started)
		cancelRuns(deps, slot, kept, started === null ? expected : [started]);
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
	return { ...run, acting: batch };
}

/**
 * @param {BatchDeps} deps
 * @param {Exclude<QueueAction, QueueEnd | {kind: PipelineKind}>} action
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function act(deps, action, run) {
	const { git, record } = deps;
	switch (action.kind) {
		case "merge-members":
			return mergeBatch(deps, action, run);
		case "merge-alone": {
			const { member, onto } = action;
			const result = git.mergeMembers(onto, [member]);
			return { ...run, alone: { name: member.name, onto, result } };
		}
		case "defer-member": {
			const batch = leaveOut(batchOf(run), action.name, "deferred");
			record.write(batch);
			return { ...run, acting: batch, unmerged: null, alone: null };
		}
		case "drop-member":
			return dropMember(deps, action.drop, run);
		case "file-fix-ticket":
			return fileFixTicket(deps, action.drop, run);
		case "adopt-dropped-ref":
			return adoptDroppedRef(deps, action, run);
		case "test-sha":
			return testSha(deps, action.sha, run);
		case "fast-forward-main":
			return moveMain(deps, action.sha, run, (r) => recordLanded(deps, r));
		case "unledger":
			deps.ledger.remove(action.sha);
			return run;
		case "record-landed":
			return recordLanded(deps, run);
		case "delete-landed-ref":
			return git.deleteRef(`${QUEUE_PREFIX}${action.name}`, action.sha)
				? run
				: { ...run, kept: [...run.kept, `${action.name}@${action.sha}`] };
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
		default:
			return actRed(deps, action, run);
	}
}

/**
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: RedKind}>} action
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function actRed(deps, action, run) {
	switch (action.kind) {
		case "rerun-files": {
			const { sha, files, pass } = action;
			const r = { sha, files, pass };
			return startAsk(
				run,
				[r],
				() => verdictAt(deps, sha, [...files], pass === 2),
				(d, next, v) => writeVerdict(d, { ...r, v }, next),
			);
		}
		case "check-base":
			return checkBase(deps, action, run);
		case "file-base-red":
			return fileBaseRed(deps, action.sha, action.files, run);
		case "hold":
			return recorded(
				deps,
				{ ...batchOf(run), phase: "held", hold: action.hold },
				run,
			);
		case "start-isolation":
		case "start-serial": {
			const serial = action.kind === "start-serial";
			return recorded(
				deps,
				{
					...batchOf(run),
					phase: serial ? "serial" : "isolating",
					blame: action.blame,
					isolated: [],
					serial: serial ? { landed: [], step: null } : null,
				},
				run,
			);
		}
		case "merge-iso":
		case "serial-land-step":
			return mergeAlone(deps, action, run);
		case "isolate-members":
			return testIsolated(deps, { ...action, pass: 1 }, run);
		case "confirm-members":
			return testIsolated(deps, { ...action, pass: 2 }, run);
		case "rebatch-passers":
			return recorded(
				deps,
				{ ...batchOf(run), phase: "requeued", ahead: action.ahead },
				run,
			);
		case "land-step":
			return moveMain(deps, action.sha, run, (r) =>
				recordStep(deps, action.name, r),
			);
		case "record-step":
			return recordStep(deps, action.name, run);
	}
}

/**
 * Pushes `main`'s `sha` to `lander/iso-base`, or iso-suite-base for the
 * whole suite, and starts the ask of its verdict on `files` afresh, kept on
 * the batch's record.
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "check-base"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function checkBase(deps, { sha, files }, run) {
	deps.git.pushIso(isoBranch(files, "base"), sha);
	const { slot } = batchOf(run);
	const r = { sha, files, pass: BASE_PASS };
	return startAsk(
		run,
		[r],
		() => verdictAt(deps, sha, [...files], true),
		(d, next, v) =>
			writeVerdict(d, { ...r, v }, next, (got) => {
				const b = batchesOf(next.pipeline).find((x) => x.slot === slot);
				if (!b) return next;
				const bases = [...b.bases, { sha, files: [...files], verdict: got }];
				return writePipeline(
					d,
					next,
					withBatch(next.pipeline, { ...b, bases }),
				);
			}),
	);
}

/**
 * Merges the member alone onto `onto` and records the commit: as its
 * isolation commit, or as the serial step under test. One that does not
 * merge is carried as `alone`, for the machine to drop or re-batch.
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "merge-iso" | "serial-land-step"}>}
 *   action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function mergeAlone(deps, action, run) {
	const { kind, member, onto } = action;
	const fresh = action.kind === "serial-land-step" && action.fresh;
	const result = deps.git.mergeMembers(onto, [member], fresh);
	if (result.kind !== "merged")
		return { ...run, alone: { name: member.name, onto, result } };
	const b = batchOf(run);
	const { name, sha } = member;
	return recorded(
		deps,
		kind === "merge-iso"
			? { ...b, isolated: [...b.isolated, { name, sha, iso: result.sha }] }
			: {
					...b,
					serial: {
						landed: b.serial?.landed ?? [],
						step: { name, sha: result.sha, onto },
					},
				},
		run,
	);
}

/**
 * @param {Pick<QueueLanderDeps, "record">} deps
 * @param {QueueRun} run
 * @param {Pipeline} pipeline
 * @returns {QueueRun}
 */
function writePipeline(deps, run, pipeline) {
	deps.record.write(pipeline);
	return { ...run, pipeline };
}

/**
 * Takes `action` on the batch of `slot`, or on none where null, its record
 * writes put into the pipeline; a batch it lands widens the window by one.
 * @param {QueueLanderDeps} deps
 * @param {Exclude<QueueAction, QueueEnd | {kind: PipelineKind}>} action
 * @param {QueueRun} run
 * @param {number|null} slot
 * @returns {Promise<QueueRun>}
 */
async function actOn(deps, action, run, slot) {
	let { pipeline } = run;
	const was = batchesOf(pipeline).find((b) => b.slot === slot) ?? null;
	/** @type {BatchDeps} */
	const focused = {
		...deps,
		record: {
			write(b) {
				pipeline = withBatch(pipeline, b);
				deps.record.write(pipeline);
			},
		},
	};
	const out = await act(focused, action, { ...run, pipeline, acting: was });
	if (out.acting) pipeline = withBatch(pipeline, out.acting);
	if (out.acting?.phase === "landed" && was?.phase !== "landed") {
		pipeline = {
			...pipeline,
			depth: Math.min(DEPTH_CEILING, pipeline.depth + 1),
		};
		deps.record.write(pipeline);
	}
	return { ...out, pipeline, acting: null };
}

/**
 * Takes a pipeline action: a take, the head's detach, or the await of an
 * ask in flight.
 * @param {QueueLanderDeps} deps
 * @param {Extract<QueueAction, {kind: "take-batch" | "detach"
 *   | "await-verdict"}>} action
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function actOnPipeline(deps, action, run) {
	switch (action.kind) {
		case "take-batch": {
			const next = writePipeline(deps, run, action.pipeline);
			for (const m of action.batch.members) deps.logQueue("take", m);
			return { ...next, unmerged: null, alone: null };
		}
		case "detach":
			/* Cancelled first: the record written drops the shas to cancel. */
			for (const c of action.cancel) {
				forgetAsks(run, c.sha);
				cancelRuns(deps, c.slot, null, [c.sha]);
			}
			return writePipeline(deps, run, action.pipeline);
		case "await-verdict":
			return awaitVerdict(deps, run);
	}
}

/**
 * The next action, taken; the run's end where it is an exit. Waiting on a
 * verdict is no action, so it is not logged.
 * @param {QueueLanderDeps} deps
 * @param {QueueRun} run
 * @param {(action: QueueAction) => void} log
 * @returns {Promise<QueueRun | QueueEnd>}
 */
async function step(deps, run, log) {
	const head = run.pipeline.line[0] ?? run.pipeline.search;
	deps.beat(head?.integration ?? null);
	const { action, slot } = nextQueueAction({
		...deps.git.refs(),
		...run,
		drops: deps.drops.read(),
		now: deps.now(),
		isGreen: (sha) => deps.ledger.has(sha),
		greenAt: (sha) => deps.ledger.greenAt(sha),
		refusalOf: (sha) => deps.refused.refusalOf(sha),
		verdictOf: (sha, files, pass) => deps.verdicts.get(sha, files, pass),
		requiresRun: deps.tester.requiresRun === true,
		parallel: deps.tester.parallel === true,
		isPending: (r) =>
			[...run.pending.values()].some((p) => p.runs.some((x) => sameRun(x, r))),
		busy: run.pending.size > 0,
	});
	if (action.kind !== "await-verdict") log(action);
	switch (action.kind) {
		case "exit":
			return action;
		case "wait":
			throw new Error("a wait reached the run");
		case "take-batch":
		case "detach":
		case "await-verdict":
			return actOnPipeline(deps, action, run);
		default:
			return actOn(deps, action, run, slot);
	}
}

/**
 * Whether each recorded drop's fix ticket is closed, read once for the run.
 * One that cannot be read reads as open and is reported, its dropped ref
 * kept for a later run to read again (#4485).
 * @param {QueueLanderDeps} deps
 * @returns {(ticket: number) => boolean}
 */
function readClosedTickets(deps) {
	/** @type {Set<number>} */
	const closed = new Set();
	for (const { ticket, ref, reapedAt } of deps.drops.read())
		if (
			ticket !== null &&
			reapedAt === undefined &&
			readClosed(deps, ticket, ref)
		)
			closed.add(ticket);
	return (ticket) => closed.has(ticket);
}

/**
 * Whether the ticket is closed; one that cannot be read reads as open and is
 * reported (#4485).
 * @param {Pick<QueueLanderDeps, "tracker" | "say">} deps
 * @param {number} ticket
 * @param {string} ref the dropped ref it reaps
 * @returns {boolean}
 */
function readClosed(deps, ticket, ref) {
	const { say = () => undefined } = deps;
	try {
		return deps.tracker.stateOf(ticket) === "closed";
	} catch (err) {
		say(
			`#${ticket}'s state not read, ${ref} kept for a later run: ${parseRefusal(parseErrorText(err))}`,
		);
		return false;
	}
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
		pipeline: deps.record.read() ?? emptyPipeline(),
		pending: new Map(),
		acting: null,
		unread: [],
		unmerged: null,
		alone: null,
		kept: [],
		unfiled: [],
		isClosed: readClosedTickets(deps),
		baseFiled: [],
		baseTicket: null,
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
			return `take-batch onto ${short(a.batch.onto)} as ${batchBranch(a.batch.slot)}: ${a.batch.members.map((m) => `queue/${m.name}@${short(m.sha)}`).join(", ")}`;
		case "detach":
			return `detach ${batchBranch(a.slot)}${a.cancel.length > 0 ? `, cancelling ${a.cancel.map((c) => short(c.sha)).join(", ")}` : ""}`;
		case "await-verdict":
		case "wait":
			return a.kind;
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
		case "adopt-dropped-ref":
			return `adopt-dropped-ref ${a.ref}@${short(a.sha)}`;
		case "delete-landed-ref":
			return `delete-landed-ref queue/${a.name}@${short(a.sha)}`;
		case "delete-dropped-ref":
			return `delete-dropped-ref ${a.ref}@${short(a.sha)}`;
		case "rerun-files":
			return `rerun-files ${a.sha} pass ${a.pass}: ${a.files.join(", ")}`;
		case "check-base":
		case "file-base-red":
			return `${a.kind} main@${short(a.sha)}: ${a.files.length > 0 ? a.files.join(", ") : "the whole suite"}`;
		case "hold":
			return `hold ${a.hold.kind} at main@${short(a.hold.main)}`;
		case "start-isolation":
		case "start-serial":
			return `${a.kind} ${a.blame.members.map((n) => `queue/${n}`).join(", ")}${a.blame.files.length > 0 ? ` on ${a.blame.files.join(", ")}` : ""}`;
		case "merge-iso":
		case "serial-land-step":
			return `${a.kind} onto ${short(a.onto)}: queue/${a.member.name}`;
		case "isolate-members":
		case "confirm-members":
			return `${a.kind} ${a.runs.map((r) => `${r.branch}@${short(r.sha)}`).join(", ")}`;
		case "rebatch-passers":
			return `rebatch-passers ${a.ahead.map((n) => `queue/${n}`).join(", ")}`;
		case "land-step":
		case "record-step":
			return `${a.kind} queue/${a.name} at ${a.sha}`;
		default:
			return `${a.kind} ${a.sha}`;
	}
}

module.exports = {
	TransientFault,
	batchesOf,
	buildQueueActionLine,
	redPathAtRest,
	runQueueLander,
};
