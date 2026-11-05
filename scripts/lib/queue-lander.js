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
 * - **Red.** The failing files are rerun once at the integration sha, and
 *   where they pass the batch is green. Those still red are run at `main`:
 *   the ones red there too are base failures, blamed on no member, and the
 *   one base-red ticket is filed or refreshed for them; where none is left,
 *   the batch is green. The rest isolate: each member is merged alone onto
 *   `main`, pushed to `lander/iso-<k>` and run on those files, all at once
 *   where the tester is `parallel` (the Actions one), else one after another
 *   (the local one, under its one admission slot). A member red alone is run
 *   again, and red twice it is dropped with a fix ticket naming the files.
 *   Where any member dropped, the rest form the next batch alone, ahead of
 *   any newer ref. Where none did, the batch is a collision: its members land
 *   one at a time in push order, each step the whole suite on `main`, and the
 *   first step red beyond the base failures drops its member, the rest
 *   forming the next batch. A red naming no file has no files to rerun or
 *   isolate on, so it goes straight to that serial landing.
 * - **Restart.** Each decision is written to the batch record, which keeps
 *   the phase, the isolation merges and the serial steps, before the act it
 *   governs, so a rerun after a crash converges on it.
 * - **Reap.** With no batch in flight, each `dropped/<name>` whose fix ticket
 *   the run read closed at its start is compare-and-deleted, and its drop
 *   record entry marked reaped, so landing-status still names the ticket. An
 *   entry reaped longer ago than the queue log keeps its rows is pruned at a
 *   run's start.
 * - **Queue log.** A take row for each member a batch takes, a land row for
 *   each member `main` moves past, and a drop row for each dropped member,
 *   through the injected `logQueue`. A batch `main` holds with its land rows
 *   unrecorded, as a crash after the push leaves it, logs them on restart.
 * - **Verdicts.** A green or red reached at a sha is ledgered by that sha, the
 *   files it ran and its pass, the rerun and the confirm being the second,
 *   and survives a restart. An unknown verdict is no verdict: it lands and
 *   drops nothing and is never ledgered, so the next run asks again.
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
const {
	parseRefusal,
	redOnMain,
	remote,
	short,
	verdictAt,
} = require("./lander.js");
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
 * @typedef {"merging" | "testing" | "isolating" | "serial" | "requeued"
 *   | "landed"} Phase `isolating` while each member is tested alone on
 *   `main`, `serial` while members land one at a time after a collision,
 *   `requeued` done without landing, its `ahead` forming the next batch
 * @typedef {object} Blame what a red batch's isolation runs on
 * @property {readonly string[]} files the failing files `main` passes, none
 *   where the red named none
 * @property {readonly string[]} base the failing files `main` fails too
 * @property {readonly string[]} members the names isolated, in push order
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly iso: string}} Isolated a member merged alone onto the batch's
 *   `onto` as `iso`, pushed to `lander/iso-<k>`, `k` its index
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly onto: string}} Step a serial step: the member `name` merged
 *   alone onto `onto` as `sha`
 * @typedef {{readonly landed: readonly string[],
 *   readonly step: Step|null}} Serial the members landed so far, and the
 *   step under test
 * @typedef {object} Batch the batch record
 * @property {readonly Member[]} members in push order
 * @property {readonly string[]} deferred the names of members left out, to
 *   be taken by the next batch
 * @property {readonly string[]} dropped
 * @property {string} onto `main` when its members were taken or merged
 * @property {string|null} integration the commit under test, null while
 *   merging
 * @property {Phase} phase
 * @property {readonly string[]} ahead the members that form the next batch
 *   alone, ahead of newer refs
 * @property {Blame|null} blame
 * @property {readonly Isolated[]} isolated
 * @property {Serial|null} serial
 * @typedef {{readonly ref: string, readonly sha: string}} DroppedRef a
 *   `dropped/*` ref on the remote, `ref` after `refs/heads/`
 * @typedef {{readonly main: string|null, readonly queue: readonly QueueRef[],
 *   readonly dropped: readonly DroppedRef[]}} QueueRefs the remote's `main`,
 *   queue refs and dropped refs, each queue commit present locally
 * @typedef {{readonly kind: "red", readonly name: string,
 *   readonly files: readonly string[], readonly iso: string}} RedAlone red
 *   on `files` twice, merged alone onto `main` as `iso`, where `main` passed
 *   them
 * @typedef {{readonly kind: "collision", readonly name: string,
 *   readonly files: readonly string[], readonly step: string,
 *   readonly after: readonly string[]}} Collision the serial step `step`,
 *   merging it onto `main` after the members `after` landed, red on `files`,
 *   none where the red named none, each member having passed alone
 * @typedef {Unmerged | RedAlone | Collision} Cause
 * @typedef {object} Drop a dropped member, as the drop record holds it
 * @property {string} name after `queue/`
 * @property {string} sha
 * @property {string} ref the dropped ref holding it, after `refs/heads/`
 * @property {string} onto the `main` it was merged onto
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
 * @typedef {{readonly k: number, readonly sha: string}} IsoRun an isolation
 *   commit, at `lander/iso-<k>`
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
 *   | ({readonly kind: "rerun-files"} & TestRun)
 *   | {readonly kind: "file-base-red", readonly sha: string,
 *     readonly files: readonly string[]}
 *   | {readonly kind: "start-isolation" | "start-serial",
 *     readonly blame: Blame}
 *   | {readonly kind: "merge-iso" | "serial-land-step",
 *     readonly onto: string, readonly member: Member}
 *   | {readonly kind: "isolate-members" | "confirm-members",
 *     readonly files: readonly string[], readonly runs: readonly IsoRun[]}
 *   | {readonly kind: "rebatch-passers", readonly ahead: readonly string[]}
 *   | {readonly kind: "land-step" | "record-step", readonly sha: string,
 *     readonly name: string}
 *   | {readonly kind: "fast-forward-main", readonly sha: string}
 *   | {readonly kind: "record-landed", readonly sha: string}
 *   | {readonly kind: "delete-landed-ref", readonly name: string,
 *     readonly sha: string}
 *   | {readonly kind: "exit", readonly reason: string}} QueueAction
 * @typedef {Extract<QueueAction, {kind: "exit"}>} QueueEnd
 * @typedef {"rerun-files" | "file-base-red" | "start-isolation"
 *   | "start-serial" | "merge-iso" | "serial-land-step" | "isolate-members"
 *   | "confirm-members" | "rebatch-passers" | "land-step" | "record-step"}
 *   RedKind the red path's steps
 * @typedef {{readonly sha: string, readonly files: readonly string[],
 *   readonly pass: number}} TestRun a run at `sha` on `files`, the whole
 *   suite where none, on its `pass`, 1 the first and 2 the rerun or confirm
 * @typedef {TestRun & {readonly reason: string}} Unread a run this run's
 *   tester reached no verdict at
 * @typedef {object} QueueState what the next action is chosen from
 * @property {string|null} main
 * @property {readonly QueueRef[]} queue
 * @property {Batch|null} batch the batch record
 * @property {(sha: string) => boolean} isGreen whether the green ledger holds
 *   `sha`
 * @property {(sha: string, files: readonly string[], pass: number) =>
 *   Verdict|null} verdictOf the verdict ledgered at `sha` on `files`, empty
 *   for the whole suite, on its `pass`, 1 the first run and 2 the rerun
 * @property {boolean} requiresRun where `main` takes only a sha a CI run
 *   passed, so only a green naming its `run` lands
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
 *   found moved
 * @property {readonly string[]} unfiled dropped refs whose fix ticket this
 *   run could not file
 * @property {readonly string[]} baseFiled the base reds this run filed or
 *   refreshed the base-red ticket for, by baseKey
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
 * already at its integration commit, as a crash after the push leaves it, or
 * it ended without landing, its passers to form the next batch.
 * @param {Batch} b
 * @param {string} main
 */
const isDone = (b, main) =>
	b.phase === "landed" ||
	b.phase === "requeued" ||
	b.integration === main ||
	included(b).length === 0;

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
 * Every queue ref waiting, at the sha it holds now; only those of `ahead`
 * where any of them waits.
 * @param {readonly QueueRef[]} queue
 * @param {string} main
 * @param {readonly string[]} ahead
 * @returns {QueueAction}
 */
function takeBatch(queue, main, ahead) {
	const first = queue.filter((r) => ahead.includes(r.name));
	const members = (first.length > 0 ? first : queue)
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
			ahead: [],
			blame: null,
			isolated: [],
			serial: null,
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
	if (members[0] === m) return dropAction(m, u.onto, u.result, s);
	const alone = s.alone;
	if (alone?.name !== name || alone.onto !== u.onto)
		return { kind: "merge-alone", onto: u.onto, member: m };
	if (alone.result.kind === "merged") return { kind: "defer-member", name };
	return dropAction(m, u.onto, alone.result, s);
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
	const v = s.verdictOf(sha, files, pass);
	return v === null || v.kind === "unknown" ? null : v;
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
	return { action: unreadExit(s, r) ?? ask };
}

/**
 * Whether `main` may move to a sha `v` judged green.
 * @param {Verdict} v
 * @param {QueueState} s
 */
const isLandable = (v, s) =>
	v.kind === "green" && (!s.requiresRun || v.run !== undefined);

/**
 * The landing of the integration commit `sha` its green `v` allows.
 * @param {string} sha
 * @param {Verdict} v
 * @param {QueueState} s
 * @returns {QueueAction}
 */
const landGreen = (sha, v, s) =>
	isLandable(v, s)
		? { kind: "fast-forward-main", sha }
		: exit(`no verdict at ${short(sha)}: its green read no CI run`);

/**
 * @param {string} main
 * @param {readonly string[]} files
 */
const baseKey = (main, files) => `${main} ${[...files].sort().join(",")}`;

/**
 * The next step on the integration commit `sha`, whose whole suite was red
 * on `whole`: the rerun of its failing files, their run at `main`, the
 * base-red ticket, and the isolation of what is left.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @param {{sha: string, whole: Extract<Verdict, {kind: "red"}>}} red
 * @returns {QueueAction}
 */
function redAction(b, s, main, { sha, whole }) {
	const members = included(b).map((m) => m.name);
	if (whole.files.length === 0)
		return {
			kind: "start-serial",
			blame: { files: [], base: [], members },
		};
	const rerun = { sha, files: whole.files, pass: 2 };
	const again = verdictOr(s, rerun, { kind: "rerun-files", ...rerun });
	if ("action" in again) return again.action;
	if (again.v.kind === "green") return landGreen(sha, again.v, s);
	const rest = again.v.files.length > 0 ? again.v.files : whole.files;
	const atMain = { sha: main, files: rest, pass: 1 };
	const there = verdictOr(s, atMain, { kind: "rerun-files", ...atMain });
	if ("action" in there) return there.action;
	const base = redOnMain(there.v, [...rest], again.v);
	const files = rest.filter((f) => !base.includes(f));
	if (base.length > 0 && !s.baseFiled.includes(baseKey(main, base)))
		return { kind: "file-base-red", sha: main, files: base };
	if (files.length === 0) return { kind: "fast-forward-main", sha };
	return { kind: "start-isolation", blame: { files, base, members } };
}

/**
 * The next step of an isolation: each member merged alone onto the batch's
 * `onto`, run on the blamed files, a red one run again, and a red confirmed
 * dropped; then the passers re-batched where any dropped, else the serial
 * landing.
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
		const alone = s.alone;
		if (
			alone?.name === m.name &&
			alone.onto === onto &&
			alone.result.kind !== "merged"
		)
			return dropAction(m, onto, alone.result, s);
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
			const stop = unreadExit(s, { sha: i.iso, files: blame.files, pass });
			if (stop) return stop;
		}
		if (owed.length === 0) return null;
		return {
			kind: pass === 1 ? "isolate-members" : "confirm-members",
			files: blame.files,
			runs: owed.map((i) => ({ k: i.k, sha: i.iso })),
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
			{ kind: "red", name: m.name, files, iso: i.iso },
			s,
		);
	}
	if (blame.members.some((n) => b.dropped.includes(n)))
		return { kind: "rebatch-passers", ahead: members.map((m) => m.name) };
	return { kind: "start-serial", blame };
}

/**
 * The next step of a serial landing: the next member in push order merged
 * onto `main` and tested on the whole suite; once one is dropped, the rest
 * re-batched.
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
		return stepAction(s, { ...at, member: next }, { blame, landed });
	/* Each member merged into the batch in this order, so one that will not
	 * now is no collision's culprit: the rest are batched again. */
	if (s.alone?.name === next.name && s.alone.onto === main) return rebatch;
	return { kind: "serial-land-step", onto: main, member: next };
}

/**
 * The serial step `at`, its member merged onto `main`: landed where its
 * whole suite passes or is red only where `main` was, else its member
 * dropped.
 * @param {QueueState} s
 * @param {Step & {member: Member}} at
 * @param {{blame: Blame, landed: readonly string[]}} so the blame and the
 *   members landed before it
 * @returns {QueueAction}
 */
function stepAction(s, { sha, onto, member }, { blame, landed }) {
	/** @type {QueueAction} */
	const land = { kind: "land-step", sha, name: member.name };
	if (s.isGreen(sha)) return land;
	const got = verdictOr(
		s,
		{ sha, files: [], pass: 1 },
		{ kind: "test-sha", sha },
	);
	if ("action" in got) return got.action;
	const { v } = got;
	if (v.kind === "green")
		return isLandable(v, s)
			? land
			: exit(`no verdict at ${short(sha)}: its green read no CI run`);
	const beyond = v.files.filter((f) => !blame.base.includes(f));
	if (v.files.length > 0 && beyond.length === 0) return land;
	return dropAction(
		member,
		onto,
		{
			kind: "collision",
			name: member.name,
			files: v.files,
			step: sha,
			after: landed,
		},
		s,
	);
}

/**
 * The next step of a batch not yet done.
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function batchAction(b, s, main) {
	if (b.phase === "isolating" && b.blame) return isolationAction(b, s, b.blame);
	if (b.phase === "serial") return serialAction(b, s, main);
	const members = included(b);
	if (s.unmerged?.onto === main) return unmergedAction(members, s, s.unmerged);
	/* A batch merged onto a `main` that has since moved is merged again onto
	 * the new tip, so `main` only ever fast-forwards. */
	if (b.phase === "merging" || b.onto !== main || b.integration === null)
		return { kind: "merge-members", onto: main, members };
	const sha = b.integration;
	if (s.isGreen(sha)) return { kind: "fast-forward-main", sha };
	const got = verdictOr(
		s,
		{ sha, files: [], pass: 1 },
		{ kind: "test-sha", sha },
	);
	if ("action" in got) return got.action;
	if (got.v.kind === "red") return redAction(b, s, main, { sha, whole: got.v });
	return landGreen(sha, got.v, s);
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
	const merged = batch ? landedOf(batch) : [];
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
	const ahead = batch?.phase === "requeued" ? batch.ahead : [];
	return takeBatch(waiting, main, ahead);
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
 * @property {(k: number, sha: string) => void} pushIso `sha` to the lander's
 *   `lander/iso-<k>` ref, forced, before its verdict is asked, as the
 *   tester tells an isolation run by the remote's iso refs
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
 * @property {(sha: string, files: readonly string[]) => string} fileBaseRed
 *   files the one base-red ticket for `files` red at `main`'s `sha`, or
 *   refreshes the open one, returning the line naming it
 * @property {(n: number) => "open" | "closed"} stateOf the ticket's state,
 *   throwing where it cannot be read
 * @typedef {object} DropRecord
 * @property {() => Drop[]} read
 * @property {(drops: readonly Drop[]) => void} write
 * @typedef {"take" | "land" | "drop"} LanderEvent
 * @typedef {object} VerdictLedger
 * @property {(sha: string, files: readonly string[], pass?: number) =>
 *   Verdict|null} get
 * @property {(sha: string, files: readonly string[], v: Verdict,
 *   pass?: number) => void} add
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
 * @property {(line: string) => void} [say] reports a fix or base-red ticket
 *   filed or left unfiled, or one whose state was not read
 * @typedef {Pick<QueueState, "batch" | "unread" | "unmerged" | "alone"
 *   | "kept" | "unfiled" | "isClosed" | "baseFiled">} QueueRun what a run
 *   carries between actions
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
			? droppedFrom(batch, d.name)
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
 * Ledgers `v`, reached at `sha` on `files` on its `pass`; a no verdict is
 * left for the machine to exit on, and a transient one throws for the run
 * to retry.
 * @param {QueueLanderDeps} deps
 * @param {{sha: string, files: readonly string[], pass: number, v: Verdict}} r
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function ledger(deps, { sha, files, pass, v }, run) {
	if (v.kind === "unknown" && v.transient)
		throw new TransientFault(`no verdict at ${short(sha)}: ${v.reason}`);
	if (v.kind === "unknown")
		return {
			...run,
			unread: [...run.unread, { sha, files, pass, reason: v.reason }],
		};
	deps.verdicts.add(sha, files, v, pass);
	return run;
}

/**
 * Pushes `sha` to the batch ref and ledgers the whole suite's verdict its
 * tester reaches there.
 * @param {QueueLanderDeps} deps
 * @param {string} sha
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function testSha(deps, sha, run) {
	deps.git.pushBatch(sha);
	const v = await verdictAt(deps, sha);
	return ledger(deps, { sha, files: [], pass: 1, v }, run);
}

/**
 * Pushes each isolation commit to its `lander/iso-<k>` ref, then asks its
 * verdict on `files`: all at once where the tester is `parallel`, else one
 * after another. Each verdict reached is ledgered before a transient no
 * verdict throws, so the retry asks only what is still owed.
 * @param {QueueLanderDeps} deps
 * @param {{runs: readonly IsoRun[], files: readonly string[], pass: number}}
 *   asked
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function testIsolated(deps, { runs, files, pass }, run) {
	for (const { k, sha } of runs) deps.git.pushIso(k, sha);
	/** @param {IsoRun} r */
	const ask = (r) => verdictAt(deps, r.sha, [...files]);
	/** @type {Verdict[]} */
	const vs = [];
	if (deps.tester.parallel) vs.push(...(await Promise.all(runs.map(ask))));
	else for (const r of runs) vs.push(await ask(r));
	/** @type {Error|null} */
	let transient = null;
	let next = run;
	for (const [k, r] of runs.entries()) {
		const v = vs[k];
		if (!v) continue;
		try {
			next = ledger(deps, { sha: r.sha, files, pass, v }, next);
		} catch (err) {
			if (!(err instanceof TransientFault)) throw err;
			transient ??= err;
		}
	}
	if (transient) throw transient;
	return next;
}

/**
 * Files or refreshes the base-red ticket. One that will not file is
 * reported, and lands nothing less: the failures it names are `main`'s.
 * @param {QueueLanderDeps} deps
 * @param {string} sha
 * @param {readonly string[]} files
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function fileBaseRed(deps, sha, files, run) {
	const { say = () => undefined } = deps;
	try {
		say(deps.tracker.fileBaseRed(sha, files));
	} catch (err) {
		if (isTransientFault(err)) throw err;
		say(
			`base-red ticket for main at ${short(sha)} not filed: ${parseRefusal(parseErrorText(err))}`,
		);
	}
	return { ...run, baseFiled: [...run.baseFiled, baseKey(sha, files)] };
}

/**
 * Lands the serial step `sha`, the member `name` merged onto `main`: ledgered
 * green first, then pushed to `main`, then recorded.
 * @param {QueueLanderDeps} deps
 * @param {string} sha
 * @param {string} name
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function landStep(deps, sha, name, run) {
	if (!deps.ledger.has(sha)) deps.ledger.add(sha);
	deps.git.pushMain(sha);
	const landed = recordStep(deps, name, run);
	deps.mainMoved?.();
	return landed;
}

/**
 * Logs the land row of the member `name` a serial step landed, then records
 * it landed; a crash between the two repeats the row, which the log takes
 * once.
 * @param {QueueLanderDeps} deps
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
	return { ...run, batch };
}

/**
 * Writes `batch` as the batch record and carries it on.
 * @param {QueueLanderDeps} deps
 * @param {Batch} batch
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function recorded(deps, batch, run) {
	deps.record.write(batch);
	return { ...run, batch };
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
	for (const m of included(batch))
		if (!batch.serial?.landed.includes(m.name)) deps.logQueue("land", m);
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
				unread: [],
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
		default:
			return actRed(deps, action, run);
	}
}

/**
 * A step of the red path, taken.
 * @param {QueueLanderDeps} deps
 * @param {Extract<QueueAction, {kind: RedKind}>} action
 * @param {QueueRun} run
 * @returns {Promise<QueueRun>}
 */
async function actRed(deps, action, run) {
	switch (action.kind) {
		case "rerun-files": {
			const { sha, files, pass } = action;
			const v = await verdictAt(deps, sha, [...files]);
			return ledger(deps, { sha, files, pass, v }, run);
		}
		case "file-base-red":
			return fileBaseRed(deps, action.sha, action.files, run);
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
			return landStep(deps, action.sha, action.name, run);
		case "record-step":
			return recordStep(deps, action.name, run);
	}
}

/**
 * Merges the member alone onto `onto` and records the commit: as its
 * isolation commit, or as the serial step under test. One that does not
 * merge is carried as `alone`, for the machine to drop or re-batch.
 * @param {QueueLanderDeps} deps
 * @param {Extract<QueueAction, {kind: "merge-iso" | "serial-land-step"}>}
 *   action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function mergeAlone(deps, { kind, member, onto }, run) {
	const result = deps.git.mergeMembers(onto, [member]);
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
		verdictOf: (sha, files, pass) => deps.verdicts.get(sha, files, pass),
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
		unread: [],
		unmerged: null,
		alone: null,
		kept: [],
		unfiled: [],
		isClosed: readClosedTickets(deps),
		baseFiled: [],
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
		case "rerun-files":
			return `rerun-files ${a.sha} pass ${a.pass}: ${a.files.join(", ")}`;
		case "file-base-red":
			return `file-base-red main@${short(a.sha)}: ${a.files.join(", ")}`;
		case "start-isolation":
		case "start-serial":
			return `${a.kind} ${a.blame.members.map((n) => `queue/${n}`).join(", ")}${a.blame.files.length > 0 ? ` on ${a.blame.files.join(", ")}` : ""}`;
		case "merge-iso":
		case "serial-land-step":
			return `${a.kind} onto ${short(a.onto)}: queue/${a.member.name}`;
		case "isolate-members":
		case "confirm-members":
			return `${a.kind} ${a.runs.map((r) => `lander/iso-${r.k}@${short(r.sha)}`).join(", ")}`;
		case "rebatch-passers":
			return `rebatch-passers ${a.ahead.map((n) => `queue/${n}`).join(", ")}`;
		case "land-step":
		case "record-step":
			return `${a.kind} queue/${a.name} at ${a.sha}`;
		default:
			return `${a.kind} ${a.sha}`;
	}
}

module.exports = { TransientFault, buildQueueActionLine, runQueueLander };
