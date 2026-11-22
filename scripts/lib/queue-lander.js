const { caught, parseErrorText } = require("./caught.js");
const { FilingRefusedError } = require("./filing-refused.js");
const { HEARTBEAT_MS } = require("./lander-files.js");
const { redPathAtRest } = require("./lander-records.js");
const { parseRefusal, remote, short } = require("./lander-git.js");
const {
	queueBranch,
	batchBranch,
	droppedNameOf,
	droppedRefsOf,
} = require("./landing-refs.js");
const { QUEUE_LOG_RETAIN_MS } = require("./queue-log.js");
const { isNetworkFault, REMOTE_TRIES } = require("./network-fault.js");

// guess, #4485
const SPAWN_FAULTS = ["EAGAIN", "ENOMEM", "EMFILE", "ENFILE"];

class TransientFault extends Error {}

/**
 * @typedef {{file: string, test: string, message?: string,
 *   signature?: string}} Failure
 * @typedef {{kind: "green", run?: number, named?: number,
 *      cleared?: string[]}
 *   | {kind: "red", files: string[], run?: number, jobs?: string[],
 *      failures?: Failure[], retried?: boolean, noRun?: true,
 *      typecheck?: string[]}
 *   | {kind: "unknown", reason: string, transient?: true}} Verdict
 * @typedef {{readonly kind: "batch", readonly slot: number}
 *   | {readonly kind: "iso", readonly k: number | "base"}} Placement
 * @typedef {{verdict: (place: Placement, sha: string, files?: string[],
 *   again?: boolean) => Promise<Verdict>, requiresRun?: boolean,
 *   parallel?: boolean, repeatsGates?: boolean, repeatsSuite?: boolean,
 *   start?: (place: Placement, sha: string) => void,
 *   cancel?: (place: Placement, keep: string|null) => string[]}} QueueTester
 * @typedef {import("./lander-files.js").Ledger} Ledger
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly pushedAt: number}} QueueRef
 * @typedef {{readonly name: string, readonly sha: string}} Lease
 * @typedef {{readonly kind: "pushed"} | {readonly kind: "refused",
 *   readonly line: string} | {readonly kind: "lease-lost",
 *   readonly names: readonly string[]}} PushResult
 * @typedef {import("./lander-records.js").Member} Member
 * @typedef {import("./lander-records.js").Hold} Hold
 * @typedef {import("./lander-records.js").Blame} Blame
 * @typedef {import("./lander-records.js").Isolated} Isolated
 * @typedef {import("./lander-records.js").Step} Step
 * @typedef {import("./lander-records.js").Batch} Batch
 * @typedef {import("./lander-records.js").Pipeline} Pipeline
 * @typedef {import("./lander-records.js").Drop} Drop
 * @typedef {import("./lander-records.js").Cause} Cause
 * @typedef {import("./lander-records.js").PipelineRecord} PipelineRecord
 * @typedef {import("./lander-records.js").DropRecord} DropRecord
 * @typedef {{readonly ref: string, readonly sha: string}} DroppedRef
 * @typedef {{readonly main: string|null, readonly queue: readonly QueueRef[],
 *   readonly dropped: readonly DroppedRef[]}} QueueRefs
 * @typedef {{readonly name: string, readonly sha: string,
 *   readonly onto: string, readonly main: string}} Deferral
 * @typedef {{readonly kind: "merged", readonly sha: string}
 *   | {readonly kind: "conflict", readonly name: string,
 *     readonly files: readonly string[]}
 *   | {readonly kind: "refused", readonly name: string,
 *     readonly reason: string}
 *   | {readonly kind: "stale-base", readonly name: string,
 *     readonly sha: string, readonly onto: string,
 *     readonly rows: readonly string[]}} MergeResult
 * @typedef {Exclude<MergeResult, {kind: "merged"}>} Unmerged
 * @typedef {{readonly onto: string, readonly result: MergeResult}} Merge
 * @typedef {{readonly k: number, readonly sha: string}} IsoRun
 * @typedef {{readonly line: readonly Batch[], readonly search: Batch|null}} Live
 * @typedef {"take-batch" | "detach" | "await-verdict" | "wait"} PipelineKind
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
 *   | ({readonly kind: "defer-member"} & Deferral)
 *   | {readonly kind: "leave-withdrawn", readonly name: string,
 *     readonly sha: string}
 *   | {readonly kind: "retake-member", readonly member: Member,
 *     readonly was: string}
 *   | {readonly kind: "drop-member", readonly drop: Drop}
 *   | {readonly kind: "file-fix-ticket", readonly drop: Drop,
 *     readonly held: readonly DroppedRef[]}
 *   | {readonly kind: "settle-drop", readonly drop: Drop,
 *     readonly main: string, readonly close: boolean,
 *     readonly refresh: {readonly drop: Drop,
 *       readonly held: readonly DroppedRef[]}|null}
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
 *   | {readonly kind: "rebatch-passers", readonly ahead: readonly string[],
 *     readonly withdrawn?: readonly string[]}
 *   | {readonly kind: "land-step", readonly sha: string,
 *     readonly name: string, readonly leases: readonly Lease[]}
 *   | {readonly kind: "record-step", readonly sha: string,
 *     readonly name: string}
 *   | {readonly kind: "fast-forward-main", readonly sha: string,
 *     readonly leases: readonly Lease[]}
 *   | {readonly kind: "record-landed", readonly sha: string}
 *   | {readonly kind: "delete-landed-ref", readonly name: string,
 *     readonly sha: string}
 *   | {readonly kind: "exit", readonly reason: string,
 *     readonly relaunch?: string}} QueueAction
 * @typedef {Extract<QueueAction, {kind: "exit"}>} QueueEnd
 * @typedef {{readonly sha: string, readonly files: readonly string[],
 *   readonly pass: number}} TestRun
 * @typedef {TestRun & {readonly reason: string}} Unread
 * @typedef {object} QueueState
 * @property {string|null} main
 * @property {readonly QueueRef[]} queue
 * @property {Pipeline} pipeline
 * @property {(sha: string) => boolean} isGreen
 * @property {(sha: string) => number|null} greenAt
 * @property {(sha: string) => string|null} refusalOf
 * @property {(sha: string, files: readonly string[], pass: number) =>
 *   Ledgered|null} verdictOf
 * @property {boolean} requiresRun
 * @property {boolean} parallel
 * @property {(r: TestRun) => boolean} isPending
 * @property {boolean} busy
 * @property {readonly Unread[]} unread
 * @property {readonly DroppedRef[]} dropped
 * @property {readonly Drop[]} drops
 * @property {number} now
 * @property {(ticket: number) => boolean} isClosed
 * @property {{readonly onto: string, readonly result: Unmerged}|null} unmerged
 * @property {(Merge & {readonly name: string})|null} alone
 * @property {readonly Deferral[]} deferrals
 * @property {readonly string[]} kept
 * @property {readonly string[]} unfiled
 * @property {readonly string[]} leftToNextRun
 * @property {(sha: string) => boolean} isOnMain
 * @property {(name: string, at: number) => boolean} hasLandedAfter
 * @property {(name: string) => OwningSessionState} owningSessionStateOf
 * @property {readonly string[]} baseFiled
 * @property {number|null} baseTicket
 * @property {boolean} [superseded]
 */

const BASE_PASS = 0;
// guess, #4564
const BASE_GREEN_MS = 60 * 60 * 1000;
// guess, #4572
const NO_RUN_RETAKE_MS = 60 * 60 * 1000;

// guess, #4556
const DEPTH_START = 2;
const DEPTH_CEILING = 3;
const DEPTH_FLOOR = 1;

/**
 * @param {string} sha
 * @param {number} [pass]
 * @returns {TestRun}
 */
const wholeRun = (sha, pass = 1) => ({ sha, files: [], pass });

/** @type {Extract<QueueAction, {kind: "wait"}>} */
const WAIT = { kind: "wait" };

/** @returns {Pipeline} */
const emptyPipeline = () => ({ line: [], search: null, depth: DEPTH_START });

/**
 * @param {import("./lander-records.js").RecordRead<Pipeline>} r
 * @returns {Pipeline}
 */
const pipelineOf = (r) => (r.kind === "read" ? r.value : emptyPipeline());

/**
 * @param {Pipeline} p
 * @returns {Batch[]}
 */
const batchesOf = (p) => (p.search ? [p.search, ...p.line] : [...p.line]);

/**
 * @param {Pipeline} p
 * @param {Batch} b
 * @returns {Pipeline}
 */
const withBatch = (p, b) => ({
	...p,
	search: p.search?.slot === b.slot ? b : p.search,
	line: p.line.map((x) => (x.slot === b.slot ? b : x)),
});

/** @param {Pipeline} p */
function freeSlot(p) {
	const held = new Set(batchesOf(p).map((b) => b.slot));
	let k = 0;
	while (held.has(k)) k++;
	return k;
}

/** @param {string} reason @returns {QueueEnd} */
const exit = (reason) => ({ kind: "exit", reason });

const LOCK_HELD = "another lander holds the lock";
const HELD = "held: ";

/** @param {Batch} b */
const retakesMoved = (b) => b.phase === "merging";

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

/** @param {Batch} b */
const unlanded = (b) =>
	included(b).filter((m) => !b.serial?.landed.includes(m.name));

/** @param {Batch} b */
const isDone = (b) => b.phase === "requeued" || b.phase === "held";

/** @param {Batch} b */
const landedOf = (b) =>
	b.phase === "landed"
		? included(b)
		: included(b).filter((m) => b.serial?.landed.includes(m.name));

/**
 * @param {readonly QueueRef[]} queue
 * @param {string} onto
 * @param {readonly string[]} ahead
 * @param {Pipeline} p
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
	const search = p.search && isDone(p.search) ? null : p.search;
	return {
		kind: "take-batch",
		batch,
		pipeline: { ...p, search, line: [...p.line, batch] },
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
		state: "open",
		decidedAt: s.now,
	},
});

/**
 * @param {QueueState} s
 * @param {string} name
 * @param {string} onto
 * @returns {MergeResult|null}
 */
const aloneAt = (s, name, onto) =>
	s.alone?.name === name && s.alone.onto === onto ? s.alone.result : null;

/**
 * @param {readonly Member[]} members
 * @param {QueueState} s
 * @param {{onto: string, result: Unmerged}} u
 * @param {string} main
 * @returns {QueueAction}
 */
function unmergedAction(members, s, u, main) {
	const { name } = u.result;
	const m = members.find((x) => x.name === name);
	if (!m)
		return exit(`${queueBranch(name)} did not merge, but is no batch member`);
	if (u.result.kind === "stale-base") return staleBaseExit(u.result, main);
	if (members[0] === m && u.onto === main)
		return dropAction(m, main, u.result, s);
	const alone = aloneAt(s, name, main);
	if (alone === null) return { kind: "merge-alone", onto: main, member: m };
	if (mergedAlone(alone))
		return { kind: "defer-member", name, sha: m.sha, onto: u.onto, main };
	return dropAction(m, main, alone, s);
}

/**
 * @param {MergeResult} r
 * @returns {r is Extract<MergeResult, {kind: "merged" | "stale-base"}>}
 */
const mergedAlone = (r) => r.kind === "merged" || r.kind === "stale-base";

/**
 * @param {Extract<MergeResult, {kind: "stale-base"}>} result
 * @param {string} main
 * @returns {QueueEnd}
 */
function staleBaseExit({ onto, rows }, main) {
	const base =
		onto === main
			? `main is stale: main at ${short(main)}`
			: `the batch ahead at ${short(onto)}`;
	return exit(
		`${HELD}${base} holds ${rows.length} gating guard-registry fault(s), so no batch onto it lands; main must be re-anchored first: ${rows.join("; ")}`,
	);
}

/** @param {readonly string[]} a @param {readonly string[]} b */
const sameFiles = (a, b) =>
	a.length === b.length && a.every((f) => b.includes(f));

/**
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
 * @param {QueueState} s
 * @param {TestRun} r
 * @param {QueueAction} ask
 * @returns {QueueAction}
 */
const askOrWait = (s, r, ask) =>
	s.isPending(r) || (!s.parallel && s.busy) ? WAIT : ask;

/**
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
 * @param {QueueState} s
 * @param {TestRun} r
 */
const askRerun = (s, r) => verdictOr(s, r, { kind: "rerun-files", ...r });

/**
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

/** @param {readonly string[]} files */
const fileSetKey = (files) => [...files].sort().join(",");

/**
 * @param {string} main
 * @param {readonly string[]} files
 */
const baseKey = (main, files) => `${main} ${fileSetKey(files)}`;

/**
 * @typedef {{readonly base: readonly string[],
 *   readonly left: readonly string[], readonly baseOnly: boolean,
 *   readonly noRun?: true}} BaseRead
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
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @param {{sha: string, whole: Extract<Verdict, {kind: "red"}>}} red
 * @returns {QueueAction}
 */
function redAction(b, s, main, { sha, whole }) {
	const land = fastForward(b, s, sha);
	const rerun = { sha, files: whole.files, pass: 2 };
	const filesAgain = whole.retried ? { v: whole } : askRerun(s, rerun);
	if ("action" in filesAgain) return filesAgain.action;
	const again =
		filesAgain.v.kind === "green" && !isLandable(filesAgain.v, s)
			? askRerun(s, wholeRun(sha, 2))
			: filesAgain;
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

// guess, #4857
const QUOTED_FAILURES_MAX = 10;
const QUOTED_MESSAGE_CHARS = 300;

/**
 * @param {Verdict|null} v
 * @returns {import("./lander-records.js").QuotedFailure[]}
 */
const quotedFailuresOf = (v) =>
	(v?.kind === "red" ? (v.failures ?? []) : [])
		.flatMap(({ file, test, message }) =>
			message
				? [{ file, test, message: message.slice(0, QUOTED_MESSAGE_CHARS) }]
				: [],
		)
		.slice(0, QUOTED_FAILURES_MAX);

/**
 * @param {Extract<Verdict, {kind: "red"}>} v
 * @param {Verdict|null} first
 * @returns {import("./lander-records.js").RedMarks}
 */
function redMarksOf(v, first) {
	const runs = [
		...new Set(
			[first, v].flatMap((x) =>
				x?.kind === "red" && x.run !== undefined ? [x.run] : [],
			),
		),
	];
	const quoted = quotedFailuresOf(v);
	const failures = quoted.length > 0 ? quoted : quotedFailuresOf(first);
	return {
		...(v.noRun ? { noRun: v.noRun } : {}),
		...(v.typecheck ? { typecheck: v.typecheck } : {}),
		...(runs.length > 0 ? { runs } : {}),
		...(failures.length > 0 ? { failures } : {}),
	};
}

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {readonly string[]} files
 * @returns {number|null}
 */
function mainRunOf(b, s, files) {
	const base = b.bases.findLast(
		(x) =>
			x.sha === b.onto &&
			(files.length === 0
				? x.files.length === 0
				: files.every((f) => x.files.includes(f))),
	)?.verdict;
	if (base?.kind === "red")
		return files.length > 0 && !files.some((f) => base.files.includes(f))
			? (base.run ?? null)
			: null;
	const checked = base?.run ?? base?.named;
	if (checked !== undefined) return checked;
	for (const pass of [1, 2]) {
		const whole = ledgered(s, { sha: b.onto, files: [], pass });
		if (whole?.kind === "green" && whole.run !== undefined) return whole.run;
	}
	return null;
}

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {{name: string, iso: string, asked: readonly string[],
 *   v: Extract<Verdict, {kind: "red"}>, first: Verdict|null}} alone
 * @returns {import("./lander-records.js").RedAlone}
 */
function redAloneCause(b, s, { name, iso, asked, v, first }) {
	const files = v.files.length > 0 ? v.files : asked;
	const mainRun = v.noRun ? null : mainRunOf(b, s, files);
	return {
		kind: "red",
		name,
		files: [...files],
		iso,
		...redMarksOf(v, first),
		...(mainRun === null ? {} : { mainRun }),
	};
}

/**
 * @param {QueueState} s
 * @param {readonly string[]} files
 * @returns {(i: Isolated, pass: number) => Exclude<Verdict, {kind: "unknown"}>|null}
 */
const isolatedVerdict = (s, files) => (i, pass) =>
	ledgered(s, { sha: i.iso, files, pass });

/**
 * @param {QueueState} s
 * @param {Blame} blame
 * @param {readonly (Isolated & {k: number})[]} isolated
 * @returns {QueueAction|null}
 */
function isolationAsk(s, blame, isolated) {
	const { files } = blame;
	const at = isolatedVerdict(s, files);
	/**
	 * @param {typeof isolated} of
	 * @param {1 | 2} pass
	 * @returns {QueueAction|null}
	 */
	const ask = (of, pass) => {
		const owed = of.filter((i) => at(i, pass) === null);
		for (const i of owed) {
			const r = { sha: i.iso, files, pass };
			const stop = unreadExit(s, r);
			if (stop) return stop;
			if (s.isPending(r)) return WAIT;
		}
		if (owed.length === 0) return null;
		if (!s.parallel && s.busy) return WAIT;
		return {
			kind: pass === 1 ? "isolate-members" : "confirm-members",
			files,
			runs: owed.map((i) => ({ k: i.k, sha: i.iso })),
		};
	};
	const beside = s.parallel && files.length > 0;
	const first = ask(isolated, 1);
	if (first && (first.kind !== "wait" || !beside)) return first;
	const owing = isolated.filter((i) =>
		beside ? at(i, 1)?.kind !== "green" : at(i, 1)?.kind === "red",
	);
	return ask(owing, 2) ?? first;
}

/**
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
		if (alone !== null && !mergedAlone(alone))
			return dropAction(m, onto, alone, s);
		return { kind: "merge-iso", onto, member: m };
	}
	const isolated = b.isolated.flatMap((i, k) =>
		members.some((m) => m.name === i.name && m.sha === i.sha)
			? [{ ...i, k }]
			: [],
	);
	const at = isolatedVerdict(s, blame.files);
	const asked = isolationAsk(s, blame, isolated);
	if (asked) return asked;
	const reds = isolated.filter((i) => at(i, 1)?.kind === "red");
	for (const i of reds) {
		const v = at(i, 2);
		const m = members.find((x) => x.name === i.name);
		if (v?.kind !== "red" || !m) continue;
		return dropAction(
			m,
			onto,
			redAloneCause(b, s, {
				name: m.name,
				iso: i.iso,
				asked: blame.files,
				v,
				first: at(i, 1),
			}),
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
	const withdrawn = leaveWithdrawn(s, left);
	if (withdrawn) return withdrawn;
	if (at?.name === next.name && at.onto === main)
		return stepAction(
			b,
			s,
			{ ...at, member: next },
			{ blame, landed, rebatch },
		);
	if (aloneAt(s, next.name, main) !== null) return rebatch;
	return {
		kind: "serial-land-step",
		onto: main,
		member: next,
		fresh: isRefused(s, [next]),
	};
}

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {Step & {member: Member}} at
 * @param {{blame: Blame, landed: readonly string[], rebatch: QueueAction}} so
 * @returns {QueueAction}
 */
function stepAction(b, s, { sha, onto, member }, { blame, landed, rebatch }) {
	const refused = refusedHold(s, onto, sha);
	if (refused) return refused;
	const land = leased(s, [member], {
		kind: "land-step",
		sha,
		name: member.name,
	});
	if (s.isGreen(sha)) return land;
	const first = verdictOr(s, wholeRun(sha), { kind: "test-sha", sha });
	if ("action" in first) return first.action;
	if (first.v.kind === "green") return landGreen(first.v, s, land);
	const again = askRerun(s, wholeRun(sha, 2));
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
				...redMarksOf(v, first.v),
			},
			s,
		);
	if (v.files.length === 0) return rebatch;
	const checked = baseCheck(b, s, onto, v);
	if ("action" in checked) return checked.action;
	return baseAction(s, onto, checked.read, land) ?? rebatch;
}

/**
 * @param {QueueState} s
 * @param {readonly Member[]} members
 */
const isRefused = (s, members) =>
	members.some((m) => s.refusalOf(m.sha) !== null);

/**
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
 * @param {QueueState} s
 * @param {Live} live
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
 * @param {QueueState} s
 * @param {Member} m
 */
const isWithdrawn = (s, m) => !s.queue.some((r) => r.name === m.name);

/**
 * @param {QueueState} s
 * @param {readonly Member[]} members
 * @returns {Extract<QueueAction, {kind: "leave-withdrawn"}>|null}
 */
function leaveWithdrawn(s, members) {
	const gone = members.find((m) => isWithdrawn(s, m));
	return gone
		? { kind: "leave-withdrawn", name: gone.name, sha: gone.sha }
		: null;
}

/**
 * @template {{kind: "fast-forward-main", sha: string}
 *   | {kind: "land-step", sha: string, name: string}} L
 * @param {QueueState} s
 * @param {readonly Member[]} members
 * @param {L} land
 * @returns {Extract<QueueAction, {kind: "fast-forward-main" | "land-step"
 *   | "leave-withdrawn"}>}
 */
function leased(s, members, land) {
	const gone = leaveWithdrawn(s, members);
	if (gone) return gone;
	const leases = s.queue.flatMap(({ name, sha }) =>
		members.some((m) => m.name === name) ? [{ name, sha }] : [],
	);
	return /** @type {Extract<QueueAction, {kind: L["kind"]}>} */ ({
		...land,
		leases,
	});
}

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} sha
 */
const fastForward = (b, s, sha) =>
	leased(s, unlanded(b), { kind: "fast-forward-main", sha });

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {readonly Member[]} members
 * @returns {Extract<QueueAction, {kind: "retake-member"}>|null}
 */
function retakeMoved(b, s, members) {
	if (!retakesMoved(b)) return null;
	for (const m of members) {
		const r = s.queue.find((q) => q.name === m.name);
		if (r && r.sha !== m.sha)
			return {
				kind: "retake-member",
				member: { name: r.name, sha: r.sha, pushedAt: r.pushedAt },
				was: m.sha,
			};
	}
	return null;
}

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} base
 * @returns {QueueAction|null}
 */
function mergeStep(b, s, base) {
	const members = included(b);
	const withdrawn = leaveWithdrawn(s, members);
	if (withdrawn) return withdrawn;
	const moved = retakeMoved(b, s, members);
	if (moved) return moved;
	if (b.phase !== "merging" && b.onto === base && b.integration !== null)
		return null;
	return {
		kind: "merge-members",
		onto: base,
		members,
		fresh: isRefused(s, members),
	};
}

/**
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
	const land = fastForward(b, s, sha);
	if (s.isGreen(sha)) return land;
	const got = verdictOr(s, wholeRun(sha), { kind: "test-sha", sha });
	if ("action" in got) return got.action;
	if (got.v.kind === "red") return detachAction(s, live, true);
	return landGreen(got.v, s, land);
}

/**
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @param {{prev: Batch, search: Batch|null}} around
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
 * @param {Batch} b
 * @param {QueueState} s
 * @param {string} main
 * @returns {QueueAction}
 */
function searchRedAction(b, s, main) {
	const sha = b.integration;
	if (sha === null) return exit("a search with no integration commit");
	const members = included(b);
	/** @type {string[]} */
	const kept = [];
	/** @type {string[]} */
	const withdrawn = [];
	for (const m of members) (isWithdrawn(s, m) ? withdrawn : kept).push(m.name);
	if (withdrawn.length > 0)
		return { kind: "rebatch-passers", ahead: kept, withdrawn };
	const refused = refusedHold(s, b.onto, sha);
	if (refused) return refused;
	const land = fastForward(b, s, sha);
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
		return { kind: "rebatch-passers", ahead: members.map((m) => m.name) };
	return next;
}

/**
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
			`${HELD}the push of ${short(hold.sha)} to main was refused: ${hold.reason}; ${until}`,
		);
	const on =
		hold.files.length > 0
			? `on ${hold.files.join(", ")}`
			: "on the whole suite, naming no file";
	const ticket =
		hold.ticket === null ? "its base-red ticket unfiled" : `#${hold.ticket}`;
	return exit(
		`${HELD}red only where main at ${short(main)} is too, ${on}, ${ticket}; ${until}`,
	);
}

/** @param {Drop} d */
const isUnsettled = (d) => d.state !== "settled" && d.reapedAt === undefined;

/**
 * @param {Drop} d
 * @param {(ticket: number) => boolean} isClosed
 */
const isStanding = (d, isClosed) =>
	isUnsettled(d) && !(d.ticket !== null && isClosed(d.ticket));

/**
 * @param {Pick<Drop, "ref" | "sha">} d
 * @returns {(x: Pick<Drop, "ref" | "sha">) => boolean}
 */
const sameDropAs = (d) => (x) => x.ref === d.ref && x.sha === d.sha;

/**
 * @template {{at: number}} T
 * @param {readonly T[]} drops
 * @returns {T[]}
 */
const newestFirst = (drops) => [...drops].sort((a, b) => b.at - a.at);

/**
 * @param {QueueState} s
 * @param {Drop} d
 * @param {string} main
 * @returns {QueueAction}
 */
function settleAction(s, d, main) {
	const [newer] = newestFirst(
		s.drops.filter(
			(x) =>
				d.ticket !== null &&
				x.ticket === d.ticket &&
				isUnsettled(x) &&
				x.at > d.at,
		),
	);
	return {
		kind: "settle-drop",
		drop: d,
		main,
		close: d.ticket !== null && newer === undefined,
		refresh:
			newer === undefined
				? null
				: { drop: newer, held: heldBy(s, newer.name, d) },
	};
}

/**
 * @param {QueueState} s
 * @param {string} name
 * @param {Drop|null} settling
 * @returns {DroppedRef[]}
 */
const heldBy = (s, name, settling) =>
	newestFirst(
		s.drops.filter(
			(x) => x.name === name && x !== settling && isStanding(x, s.isClosed),
		),
	).map(({ ref, sha }) => ({ ref, sha }));

/**
 * @param {QueueState} s
 * @param {Drop} d
 * @returns {Extract<QueueAction, {kind: "file-fix-ticket"}>}
 */
function filingOf(s, d) {
	const [newest] = newestFirst(
		s.drops.filter((x) => x.name === d.name && isUnsettled(x)),
	);
	return {
		kind: "file-fix-ticket",
		drop: newest ?? d,
		held: heldBy(s, d.name, null),
	};
}

/**
 * @param {QueueState} s
 * @param {string} main
 * @param {readonly string[]} skip
 * @returns {QueueAction|null}
 */
function dropDecision(s, main, skip) {
	const standing = newestFirst(
		s.drops.filter(
			(d) => isStanding(d, s.isClosed) && !s.leftToNextRun.includes(d.ref),
		),
	);
	for (const d of standing) {
		if (s.isOnMain(d.sha)) return settleAction(s, d, main);
		const ticketed = d.ticket !== null;
		if (!ticketed && s.queue.some((q) => q.name === d.name)) continue;
		if (s.hasLandedAfter(d.name, d.at)) return settleAction(s, d, main);
		if (ticketed || s.owningSessionStateOf(d.name) === "working") continue;
		const filing = filingOf(s, d);
		if (!skip.includes(filing.drop.ref)) return filing;
	}
	return null;
}

/**
 * @param {QueueState} s
 * @returns {QueueAction|null}
 */
function owedAction(s) {
	const unreaped = s.drops.find(
		(d) =>
			d.state === "settled" &&
			d.reapedAt === undefined &&
			!s.leftToNextRun.includes(d.ref),
	);
	if (unreaped && s.main !== null)
		return settleAction(s, unreaped, unreaped.settledOn ?? s.main);
	const cut = s.drops.find(
		(d) =>
			isStanding(d, s.isClosed) &&
			!s.dropped.some((r) => r.ref === d.ref && r.sha === d.sha),
	);
	if (cut) return { kind: "drop-member", drop: cut };
	const orphan = s.dropped.find(
		(r) =>
			!s.leftToNextRun.includes(r.ref) &&
			!s.drops.some((d) => d.ref === r.ref && d.sha === r.sha),
	);
	if (orphan && s.main !== null)
		return { kind: "adopt-dropped-ref", ...orphan, onto: s.main };
	const decided =
		s.main === null
			? null
			: dropDecision(s, s.main, [...s.unfiled, ...s.leftToNextRun]);
	if (decided) return decided;
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
 * @param {readonly Deferral[]} deferrals
 * @param {string|null} main
 * @param {readonly Batch[]} line
 * @param {QueueRef} r
 */
const isDeferredBehind = (deferrals, main, line, r) =>
	deferrals.some(
		(d) =>
			d.name === r.name &&
			d.sha === r.sha &&
			d.main === main &&
			line.some((b) => b.onto === d.onto || b.integration === d.onto),
	);

/**
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
			!landed.includes(`${r.name}@${r.sha}`) &&
			!isDeferredBehind(s.deferrals, s.main, line, r),
	);
	return { flying, waiting };
}

/**
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
 * @returns {{action: QueueAction, slot: number|null}}
 */
function nextQueueAction(s) {
	const next = stepOrEnd(s);
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
	const again = () => dropDecision(s, main, s.leftToNextRun);
	const live = liveOf(s);
	const stepped = batchStep(s, main, live);
	if (stepped?.action.kind === "exit" && !s.busy) {
		const retried = again();
		if (retried) return unslotted(retried);
	}
	if (stepped) return stepped;
	const { flying, waiting } = waitingOf(s, live);
	const fill = fillAction(s, main, live, waiting);
	if (fill) return unslotted(fill);
	if (s.busy) return unslotted({ kind: "await-verdict" });
	const retried = again();
	if (retried) return unslotted(retried);
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
 *   started?: (sha: string) => void) => MergeResult} mergeMembers
 * @property {(sha: string, leases: readonly Lease[]) => PushResult} pushMain
 * @property {(branch: string, sha: string) => boolean} deleteRef
 * @property {(sha: string, of: string) => boolean} isAncestor
 * @property {(branch: string, sha: string) => void} createRef
 * @typedef {object} QueueTracker
 * @property {(d: Drop, held: readonly DroppedRef[]) => {number: number,
 *   line: string}} fileDropTicket
 * @property {(name: string) => number|null} findDropTicket
 * @property {(ticket: number, d: Drop, held: readonly DroppedRef[]) => void} refreshDropTicket
 * @property {(ticket: number, d: Drop, main: string) => void} closeDropTicket
 * @property {(sha: string, files: readonly string[]) => string} fileBaseRed
 * @property {(n: number) => "open" | "closed"} stateOf
 * @typedef {"take" | "land" | "drop" | "settle" | "close"} LanderEvent
 * @typedef {"working" | "stopped"} OwningSessionState
 * @typedef {{readonly name: string, readonly at: number}} Landing
 * @typedef {{readonly verdict: Verdict, readonly at: number}} Ledgered
 * @typedef {object} VerdictLedger
 * @property {(sha: string, files: readonly string[], pass?: number) =>
 *   Ledgered|null} get
 * @property {(sha: string, files: readonly string[], v: Verdict,
 *   pass?: number) => void} add
 * @typedef {object} RefusedRecord
 * @property {(sha: string) => string|null} refusalOf
 * @property {(sha: string, reason: string) => void} add
 * @typedef {object} QueueLanderDeps
 * @property {QueueGit} git
 * @property {QueueTester} tester
 * @property {Ledger & {remove: (sha: string) => void,
 *   greenAt: (sha: string) => number|null}} ledger
 * @property {VerdictLedger} verdicts
 * @property {RefusedRecord} refused
 * @property {PipelineRecord} record
 * @property {DropRecord} drops
 * @property {QueueTracker} tracker
 * @property {(event: LanderEvent, m: Pick<Member, "name" | "sha">) => void} logQueue
 * @property {() => readonly Landing[]} landings
 * @property {(name: string) => OwningSessionState} owningSessionStateOf
 * @property {{acquire: () => boolean, release: () => void}} lock
 * @property {(batch?: string|null) => void} beat
 * @property {(ms: number) => Promise<void>} [wait]
 * @property {(action: QueueAction) => void} [log]
 * @property {(sha: string) => boolean} [mainMoved]
 * @property {() => number} now
 * @property {(line: string) => void} [say]
 * @typedef {Pick<QueueState, "pipeline" | "unread" | "unmerged" | "alone"
 *   | "deferrals" | "kept" | "unfiled" | "leftToNextRun" | "isClosed" | "baseFiled"
 *   | "baseTicket" | "superseded"> & {pending: Map<string, Pending>,
 *   acting: Batch|null, owningSessionStates: Map<string, OwningSessionState>}} QueueRun
 * @typedef {{readonly runs: readonly TestRun[],
 *   readonly settled: Promise<Settled>, got: Settled|null}} Pending
 * @typedef {{ok: true, apply: (deps: QueueLanderDeps, run: QueueRun) =>
 *   QueueRun} | {ok: false, err: unknown}} Settled
 * @typedef {Omit<QueueLanderDeps, "record"> & {record: {write: (b: Batch) =>
 *   void}}} BatchDeps
 */

/** @param {unknown} err */
function isTransientFault(err) {
	if (err instanceof TransientFault || isNetworkFault(err)) return true;
	const { code } = caught(err);
	return typeof code === "string" && SPAWN_FAULTS.includes(code);
}

/**
 * @param {Pick<QueueLanderDeps, "wait" | "say" | "now">} deps
 * @param {() => string} what
 */
const retrying = (deps, what) => ({
	wait: deps.wait,
	retried: (/** @type {number} */ retry, /** @type {unknown} */ err) =>
		deps.say?.(
			`${new Date(deps.now()).toISOString()} retry ${retry} of ${REMOTE_TRIES - 1}, ${what()}, after: ${parseRefusal(parseErrorText(err))}`,
		),
});

/**
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
 * @param {Batch} b
 * @param {string} name
 * @returns {Batch}
 */
const withdrawnFrom = (b, name) =>
	b.phase === "serial" && b.serial
		? {
				...b,
				deferred: [...b.deferred, name],
				serial: {
					...b.serial,
					step: b.serial.step?.name === name ? null : b.serial.step,
				},
			}
		: leaveOut(b, name, "deferred");

/**
 * @param {Batch} b
 * @param {string} name
 * @returns {string|null}
 */
function carrying(b, name) {
	if (b.phase !== "serial") return b.integration;
	const tested = b.serial?.step;
	return tested?.name === name ? tested.sha : null;
}

/**
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
	const was = drops.find(sameDropAs(d));
	const stands =
		was !== undefined &&
		isStanding(was, (ticket) => readClosed(deps, ticket, was.ref));
	deps.drops.write([
		...drops.filter((x) => x !== was),
		stands ? { ...d, ticket: was.ticket, state: was.state } : d,
	]);
	if (left && left !== batch) deps.record.write(left);
	deps.git.createRef(d.ref, d.sha);
	deps.git.deleteRef(queueBranch(d.name), d.sha);
	deps.logQueue("drop", d);
	return { ...run, acting: left, unmerged: null, alone: null };
}

/**
 * @param {Pick<QueueLanderDeps, "drops">} deps
 * @param {(d: Drop) => boolean} pick
 * @param {(d: Drop) => Drop} to
 */
function rewriteDrops(deps, pick, to) {
	deps.drops.write(deps.drops.read().map((d) => (pick(d) ? to(d) : d)));
}

/**
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "file-fix-ticket"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function fileFixTicket(deps, { drop: d, held }, run) {
	const { say = () => undefined } = deps;
	let filed;
	try {
		filed = deps.tracker.fileDropTicket(d, held);
	} catch (err) {
		if (isTransientFault(err)) throw err;
		const why = parseRefusal(parseErrorText(err));
		if (err instanceof FilingRefusedError) {
			rewriteDrops(deps, sameDropAs(d), (x) => ({ ...x, filingRefused: why }));
			throw err;
		}
		if (run.unfiled.includes(d.ref))
			return leaveToNextRun(deps, run, d.ref, `not filed again: ${why}`);
		say(
			`fix ticket for ${d.ref} not filed, filed again before this run ends: ${why}`,
		);
		return { ...run, unfiled: [...run.unfiled, d.ref] };
	}
	const at = deps.now();
	rewriteDrops(
		deps,
		(x) => x.name === d.name && isUnsettled(x) && x.ticket === null,
		(x) => ({
			...x,
			filingRefused: undefined,
			ticket: filed.number,
			state: "ticketed",
			decidedAt: at,
		}),
	);
	say(filed.line);
	return run;
}

/**
 * @param {Pick<QueueLanderDeps, "say">} deps
 * @param {QueueRun} run
 * @param {string} ref
 * @param {string} why
 * @returns {QueueRun}
 */
function leaveToNextRun(deps, run, ref, why) {
	const { say = () => undefined } = deps;
	say(`fix ticket for ${ref} ${why}; left for the next run`);
	return { ...run, leftToNextRun: [...run.leftToNextRun, ref] };
}

/**
 * @param {BatchDeps} deps
 * @param {number} ticket
 * @param {string} reaped
 * @param {{drop: Drop, held: readonly DroppedRef[]}} refresh
 */
function refreshTicket(deps, ticket, reaped, { drop, held }) {
	const { say = () => undefined } = deps;
	try {
		deps.tracker.refreshDropTicket(ticket, drop, held);
	} catch (err) {
		if (isTransientFault(err)) throw err;
		say(
			`fix ticket #${ticket} still names ${reaped}, reaped: ${parseRefusal(parseErrorText(err))}`,
		);
	}
}

/**
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "settle-drop"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function settleDrop(deps, { drop: d, main, close, refresh }, run) {
	const at = deps.now();
	if (d.state !== "settled")
		rewriteDrops(deps, sameDropAs(d), (x) => ({
			...x,
			state: "settled",
			decidedAt: at,
			settledOn: main,
		}));
	const { ticket } = d;
	if (close && ticket !== null) {
		try {
			deps.tracker.closeDropTicket(ticket, d, main);
		} catch (err) {
			if (isTransientFault(err)) throw err;
			return leaveToNextRun(
				deps,
				run,
				d.ref,
				`#${ticket} not closed: ${parseRefusal(parseErrorText(err))}`,
			);
		}
		deps.logQueue("close", d);
	} else deps.logQueue("settle", d);
	deps.git.deleteRef(d.ref, d.sha);
	rewriteDrops(deps, sameDropAs(d), (x) => ({ ...x, reapedAt: at }));
	if (refresh && ticket !== null) refreshTicket(deps, ticket, d.ref, refresh);
	const { isClosed } = run;
	return close && ticket !== null
		? { ...run, isClosed: (n) => n === ticket || isClosed(n) }
		: run;
}

/**
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "adopt-dropped-ref"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function adoptDroppedRef(deps, { ref, sha, onto }, run) {
	const name = droppedNameOf(ref, sha);
	let ticket;
	try {
		ticket = deps.tracker.findDropTicket(name);
	} catch (err) {
		if (isTransientFault(err)) throw err;
		return leaveToNextRun(
			deps,
			run,
			ref,
			`not searched: ${parseRefusal(parseErrorText(err))}`,
		);
	}
	if (ticket === null && deps.git.isAncestor(sha, onto)) {
		deps.logQueue("settle", { name, sha });
		deps.git.deleteRef(ref, sha);
		return run;
	}
	const at = deps.now();
	deps.drops.write([
		...deps.drops.read(),
		{
			name,
			sha,
			ref,
			onto,
			cause: { kind: "unrecorded", name },
			ticket,
			at,
			state: ticket === null ? "open" : "ticketed",
			decidedAt: at,
		},
	]);
	return run;
}

/**
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
 * @param {Pick<QueueLanderDeps, "tester" | "beat" | "wait" | "say" | "now">} deps
 * @param {Placement} place
 * @param {string} sha
 * @param {{files?: string[], again?: boolean}} [ask]
 * @returns {Promise<Verdict>}
 */
async function verdictAt(deps, place, sha, { files, again } = {}) {
	const { tester, beat } = deps;
	beat();
	const timer = setInterval(() => beat(), HEARTBEAT_MS);
	try {
		return await remote(
			retrying(
				deps,
				() =>
					`the verdict at ${short(sha)}${files && files.length > 0 ? ` on ${files.join(", ")}` : ""}`,
			),
			async () => {
				const v = await tester.verdict(place, sha, files, again);
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
		.map(({ sha, files, pass }) => `${sha} ${pass} ${fileSetKey(files)}`)
		.join(" + ");

/**
 * @param {TestRun} a
 * @param {TestRun} b
 */
const sameRun = (a, b) =>
	a.sha === b.sha && a.pass === b.pass && sameFiles(a.files, b.files);

/**
 * @template T
 * @param {QueueRun} run
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
	/** @type {Pending} */
	const pending = { runs, settled, got: null };
	settled.then((got) => {
		pending.got = got;
	});
	run.pending.set(askKey(runs), pending);
	return run;
}

/**
 * @param {QueueLanderDeps} deps
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function keepEnded(deps, run) {
	let out = run;
	for (const [key, p] of run.pending) {
		if (p.got === null) continue;
		run.pending.delete(key);
		if (!p.got.ok) throw p.got.err;
		out = p.got.apply(deps, out);
	}
	return out;
}

/**
 * @param {QueueLanderDeps} deps
 * @param {QueueRun} run
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
 * @param {QueueRun} run
 * @param {string} sha
 */
function forgetAsks(run, sha) {
	for (const [k, p] of run.pending)
		if (p.runs.some((r) => r.sha === sha)) run.pending.delete(k);
}

/**
 * @param {number} slot
 * @returns {Placement}
 */
const batchPlace = (slot) => ({ kind: "batch", slot });

/**
 * @param {number | "base"} k
 * @returns {Placement}
 */
const isoPlace = (k) => ({ kind: "iso", k });

/**
 * @param {Pick<QueueLanderDeps, "tester" | "say">} deps
 * @param {QueueRun} run
 * @param {{sha: string, slot: number}} at
 */
function dropRunsAt(deps, run, { sha, slot }) {
	forgetAsks(run, sha);
	cancelRuns(deps, slot, null, [sha]);
}

/**
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
		listed = deps.tester.cancel?.(batchPlace(slot), keep);
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
 * @param {BatchDeps} deps
 * @param {string} sha
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function testSha(deps, sha, run) {
	const r = wholeRun(sha);
	return startAsk(
		run,
		[r],
		() => verdictAt(deps, batchPlace(batchOf(run).slot), sha),
		(d, next, v) => {
			if (v.kind === "green" && v.cleared)
				d.say?.(buildClearedLine(sha, v.run, v.cleared));
			return writeVerdict(d, { ...r, v }, next);
		},
	);
}

/**
 * @param {string} sha
 * @param {number|undefined} run
 * @param {readonly string[]} files
 */
const buildClearedLine = (sha, run, files) =>
	`flake ${short(sha)}${run === undefined ? "" : ` run ${run}`}: green after its retry cleared ${files.join(", ")}`;

/**
 * @param {BatchDeps} deps
 * @param {{runs: readonly IsoRun[], files: readonly string[], pass: number}} asked
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function testIsolated(deps, { runs, files, pass }, run) {
	/** @type {Promise<unknown>} */
	let ahead = Promise.resolve();
	return runs.reduce((next, { k, sha }) => {
		const r = { sha, files, pass };
		const after = ahead;
		const place = isoPlace(k);
		const ask = () =>
			verdictAt(deps, place, sha, { files: [...files], again: pass === 2 });
		const out = startAsk(
			next,
			[r],
			() => (deps.tester.parallel ? ask() : after.then(ask)),
			(d, from, v) => writeVerdict(d, { ...r, v }, from),
		);
		ahead = out.pending.get(askKey([r]))?.settled ?? ahead;
		return out;
	}, run);
}

const FILED = /#(\d+)/;

/**
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
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "fast-forward-main" | "land-step"}>} action
 * @param {QueueRun} run
 * @param {(run: QueueRun) => QueueRun} landed
 * @returns {QueueRun}
 */
function moveMain(deps, { sha, leases }, run, landed) {
	if (!deps.ledger.has(sha)) deps.ledger.add(sha);
	const pushed = deps.git.pushMain(sha, leases);
	if (pushed.kind === "refused") {
		deps.refused.add(sha, pushed.line);
		return run;
	}
	if (pushed.kind === "lease-lost") {
		deps.say?.(
			`main not moved to ${short(sha)}: ${pushed.names.map((n) => queueBranch(n)).join(", ")} moved or went since this step read the refs`,
		);
		return run;
	}
	const next = landed(run);
	return deps.mainMoved?.(sha) === true ? { ...next, superseded: true } : next;
}

/**
 * @param {BatchDeps} deps
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function recordLanded(deps, run) {
	/** @type {Batch} */
	const batch = { ...batchOf(run), phase: "landed" };
	for (const m of unlanded(batch)) deps.logQueue("land", m);
	deps.record.write(batch);
	return { ...run, acting: batch };
}

/**
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "merge-members"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function mergeBatch(deps, action, run) {
	const { git, record, tester } = deps;
	const { integration: was, slot } = batchOf(run);
	if (was !== null) forgetAsks(run, was);
	const expected = was === null ? [] : [was];
	/** @type {string|null} */
	let started = null;
	const merged = git.mergeMembers(
		action.onto,
		action.members,
		action.fresh,
		(sha) => {
			if (!tester.start) return;
			try {
				tester.start(batchPlace(slot), sha);
				started = sha;
			} catch (err) {
				deps.say?.(
					`${short(sha)} not started before its gate pass: ${parseRefusal(parseErrorText(err))}`,
				);
				return;
			}
			cancelRuns(deps, slot, sha, expected);
		},
	);
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
		case "leave-withdrawn": {
			const b = batchOf(run);
			const sha = carrying(b, action.name);
			if (sha !== null) dropRunsAt(deps, run, { sha, slot: b.slot });
			const batch = withdrawnFrom(b, action.name);
			record.write(batch);
			return { ...run, acting: batch, unmerged: null, alone: null };
		}
		case "retake-member": {
			const { member } = action;
			const b = batchOf(run);
			const batch = {
				...b,
				members: b.members.map((m) => (m.name === member.name ? member : m)),
			};
			record.write(batch);
			deps.logQueue("take", member);
			return { ...run, acting: batch, unmerged: null, alone: null };
		}
		case "defer-member": {
			const { name, sha, onto, main } = action;
			const batch = leaveOut(batchOf(run), name, "deferred");
			record.write(batch);
			return {
				...run,
				acting: batch,
				unmerged: null,
				alone: null,
				deferrals: [...run.deferrals, { name, sha, onto, main }],
			};
		}
		case "drop-member":
			return dropMember(deps, action.drop, run);
		case "file-fix-ticket":
			return fileFixTicket(deps, action, run);
		case "settle-drop":
			return settleDrop(deps, action, run);
		case "adopt-dropped-ref":
			return adoptDroppedRef(deps, action, run);
		case "test-sha":
			return testSha(deps, action.sha, run);
		case "fast-forward-main":
			return moveMain(deps, action, run, (r) => recordLanded(deps, r));
		case "unledger":
			deps.ledger.remove(action.sha);
			return run;
		case "record-landed":
			return recordLanded(deps, run);
		case "delete-landed-ref":
			return git.deleteRef(queueBranch(action.name), action.sha)
				? run
				: { ...run, kept: [...run.kept, `${action.name}@${action.sha}`] };
		case "delete-dropped-ref":
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
				() =>
					verdictAt(deps, batchPlace(batchOf(run).slot), sha, {
						files: [...files],
						again: pass === 2,
					}),
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
		case "rebatch-passers": {
			const { integration: was, slot } = batchOf(run);
			if (action.withdrawn?.length && was !== null)
				dropRunsAt(deps, run, { sha: was, slot });
			return recorded(
				deps,
				{ ...batchOf(run), phase: "requeued", ahead: action.ahead },
				run,
			);
		}
		case "land-step":
			return moveMain(deps, action, run, (r) =>
				recordStep(deps, action.name, r),
			);
		case "record-step":
			return recordStep(deps, action.name, run);
	}
}

/**
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "check-base"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function checkBase(deps, { sha, files }, run) {
	const { slot } = batchOf(run);
	const r = { sha, files, pass: BASE_PASS };
	return startAsk(
		run,
		[r],
		() =>
			verdictAt(deps, isoPlace("base"), sha, {
				files: [...files],
				again: true,
			}),
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
 * @param {BatchDeps} deps
 * @param {Extract<QueueAction, {kind: "merge-iso" | "serial-land-step"}>} action
 * @param {QueueRun} run
 * @returns {QueueRun}
 */
function mergeAlone(deps, action, run) {
	const { kind, member, onto } = action;
	const fresh = action.kind === "serial-land-step" && action.fresh;
	const result = deps.git.mergeMembers(onto, [member], fresh);
	if (!mergedAlone(result))
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
			const { members } = action.batch;
			for (const m of members) deps.logQueue("take", m);
			return {
				...next,
				unmerged: null,
				alone: null,
				deferrals: run.deferrals.filter(
					(d) => !members.some((m) => m.name === d.name),
				),
			};
		}
		case "detach":
			for (const c of action.cancel) dropRunsAt(deps, run, c);
			return writePipeline(deps, run, action.pipeline);
		case "await-verdict":
			return awaitVerdict(deps, run);
	}
}

/**
 * @param {QueueLanderDeps} deps
 * @param {QueueRun} before
 * @param {(action: QueueAction) => void} log
 * @returns {Promise<QueueRun | QueueEnd>}
 */
async function step(deps, before, log) {
	const run = keepEnded(deps, before);
	const { search, line } = run.pipeline;
	deps.beat(search?.integration ?? line[0]?.integration ?? null);
	const refs = deps.git.refs();
	/** @type {readonly Landing[]|null} */
	let landings = null;
	const { action, slot } = nextQueueAction({
		...refs,
		...run,
		drops: deps.drops.read(),
		isOnMain: (sha) =>
			refs.main !== null && deps.git.isAncestor(sha, refs.main),
		hasLandedAfter: (name, at) => {
			landings ??= deps.landings();
			return landings.some((l) => l.name === name && l.at > at);
		},
		owningSessionStateOf: (name) => {
			const state =
				run.owningSessionStates.get(name) ?? deps.owningSessionStateOf(name);
			run.owningSessionStates.set(name, state);
			return state;
		},
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
 * @param {Pick<QueueLanderDeps, "tracker" | "say">} deps
 * @param {number} ticket
 * @param {string} ref
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

/** @param {QueueLanderDeps} deps */
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
 * @param {QueueLanderDeps} deps
 * @returns {Promise<QueueEnd>}
 */
async function runQueueLander(deps) {
	const { lock, log = () => undefined, say = () => undefined } = deps;
	if (!lock.acquire()) {
		const held = exit(LOCK_HELD);
		log(held);
		return held;
	}
	try {
		pruneReaped(deps);
		const pipelineRead = deps.record.read();
		if (pipelineRead.kind === "torn") {
			let aside;
			try {
				aside = deps.record.quarantine();
			} catch (err) {
				const end = exit(
					`pipeline record torn and not moved aside: ${parseRefusal(parseErrorText(err))}`,
				);
				log(end);
				return end;
			}
			say(
				`pipeline record torn, moved to ${aside}; starting from an empty pipeline`,
			);
		}
		/** @type {QueueRun} */
		let run = {
			pipeline: pipelineOf(pipelineRead),
			pending: new Map(),
			acting: null,
			unread: [],
			unmerged: null,
			alone: null,
			deferrals: [],
			kept: [],
			unfiled: [],
			leftToNextRun: [],
			owningSessionStates: new Map(),
			isClosed: readClosedTickets(deps),
			baseFiled: [],
			baseTicket: null,
		};
		const stepping = { acting: "" };
		/** @param {QueueAction} action */
		const logActing = (action) => {
			stepping.acting = buildQueueActionLine(action);
			log(action);
		};
		const retried = retrying(
			deps,
			() =>
				stepping.acting ||
				"the step before its action: reading the remote's refs and choosing one",
		);
		/** @param {QueueRun} from */
		const stepFrom = (from) => {
			stepping.acting = "";
			return step(deps, from, logActing);
		};
		try {
			for (;;) {
				const from = run;
				const next = await remote(
					retried,
					() => stepFrom(from),
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
		}
	} finally {
		lock.release();
	}
}

const RED_KINDS = /** @type {const} */ ([
	"rerun-files",
	"check-base",
	"file-base-red",
	"hold",
	"start-isolation",
	"start-serial",
	"merge-iso",
	"serial-land-step",
	"isolate-members",
	"confirm-members",
	"rebatch-passers",
	"land-step",
	"record-step",
]);
/** @typedef {typeof RED_KINDS[number]} RedKind */

/** @type {ReadonlySet<string>} */
const RED_PATH_KINDS = new Set(RED_KINDS);

/**
 * @param {number} n
 */
const goneReason = (n) =>
	n === 1
		? "its queue ref is gone from the remote"
		: "their queue refs are gone from the remote";

/**
 * @param {QueueAction} a
 * @returns {string}
 */
function buildQueueActionLine(a) {
	switch (a.kind) {
		case "exit":
			return `exit ${a.reason}`;
		case "take-batch":
			return `take-batch onto ${short(a.batch.onto)} as ${batchBranch(a.batch.slot)}: ${a.batch.members.map((m) => `${queueBranch(m.name)}@${short(m.sha)}`).join(", ")}`;
		case "detach":
			return `detach ${batchBranch(a.slot)}${a.cancel.length > 0 ? `, cancelling ${a.cancel.map((c) => short(c.sha)).join(", ")}` : ""}`;
		case "await-verdict":
		case "wait":
			return a.kind;
		case "merge-members":
			return `merge-members onto ${short(a.onto)}: ${a.members.map((m) => queueBranch(m.name)).join(", ")}`;
		case "merge-alone":
			return `merge-alone onto ${short(a.onto)}: ${queueBranch(a.member.name)}`;
		case "defer-member":
			return `defer-member ${queueBranch(a.name)}`;
		case "retake-member":
			return `retake-member ${queueBranch(a.member.name)}@${short(a.member.sha)}: moved past its snapshot ${short(a.was)} before its batch merged`;
		case "leave-withdrawn":
			return `leave-withdrawn ${queueBranch(a.name)}@${short(a.sha)}: ${goneReason(1)}`;
		case "drop-member":
			return `drop-member ${queueBranch(a.drop.name)}@${short(a.drop.sha)} as ${a.drop.ref}`;
		case "file-fix-ticket":
			return `file-fix-ticket ${a.drop.ref}@${short(a.drop.sha)}`;
		case "settle-drop":
			return `settle-drop ${a.drop.ref}@${short(a.drop.sha)} on main@${short(a.main)}${a.close ? `, closing #${a.drop.ticket}` : ""}`;
		case "adopt-dropped-ref":
			return `adopt-dropped-ref ${a.ref}@${short(a.sha)}`;
		case "delete-landed-ref":
			return `delete-landed-ref ${queueBranch(a.name)}@${short(a.sha)}`;
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
			return `${a.kind} ${a.blame.members.map((n) => queueBranch(n)).join(", ")}${a.blame.files.length > 0 ? ` on ${a.blame.files.join(", ")}` : ""}`;
		case "merge-iso":
		case "serial-land-step":
			return `${a.kind} onto ${short(a.onto)}: ${queueBranch(a.member.name)}`;
		case "isolate-members":
		case "confirm-members":
			return `${a.kind} ${a.runs.map((r) => `alone ${r.k}@${short(r.sha)}`).join(", ")}`;
		case "rebatch-passers": {
			const line = `rebatch-passers ${a.ahead.map((n) => queueBranch(n)).join(", ")}`;
			return a.withdrawn?.length
				? `${line}, leaving out ${a.withdrawn.map((n) => queueBranch(n)).join(", ")}: ${goneReason(a.withdrawn.length)}`
				: line;
		}
		case "land-step":
		case "record-step":
			return `${a.kind} ${queueBranch(a.name)} at ${a.sha}`;
		default:
			return `${a.kind} ${a.sha}`;
	}
}

module.exports = {
	HELD,
	LOCK_HELD,
	RED_PATH_KINDS,
	TransientFault,
	batchesOf,
	retakesMoved,
	buildQueueActionLine,
	fileSetKey,
	runQueueLander,
};
