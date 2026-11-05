/*
 * queue-lander-adapters.js — the production adapters lib/queue-lander.js
 * runs on: its git against lib/landing-refs.js's remote, and its verdict
 * ledger and batch record files.
 *
 * A queue ref's push time is the one lib/queue-log.js logged for it at the
 * sha it now holds. A sha with no row, as one pushed from another machine,
 * falls back to its tip's committer time, as the remote, GitHub, tells git
 * no push time.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { now } = require("./check.js");
const { caught, parseErrorText } = require("./caught.js");
const { execGit, gitCommonDirOrThrow } = require("./git.js");
const { readJsonl } = require("./jsonl.js");
const {
	GATED_COMMIT_TIMEOUT_MS,
	LANDER_GIT_TIMEOUT_MS,
	isAncestor,
	parseRefusal,
	pushRemote,
	readConflictedFiles,
	readRemoteHeads,
	short,
	withThrowawayTree,
} = require("./lander-git.js");
const {
	DROPPED_PREFIX,
	LANDER_BATCH_BRANCH,
	QUEUE_HEADS,
	QUEUE_REFSPEC,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const {
	logQueueEvent,
	queueLogFile,
	readEnqueueTimes,
	readNewestEvent,
} = require("./queue-log.js");
const { TransientFault } = require("./queue-lander.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");

/* Untraced, a first guess and stated as one: a verdict is read again only
 * for a batch a run resumes, which waits hours, never weeks. */
const VERDICT_RETAIN_MS = 14 * DAY_MS;
const DROPPED_HEADS = `refs/heads/${DROPPED_PREFIX}`;
/* git push's words for a compare-and-delete refused because the ref moved. */
const STALE = /\(stale info\)/;
const GONE = /remote ref does not exist/;
const PHASES = [
	"merging",
	"testing",
	"isolating",
	"serial",
	"requeued",
	"held",
	"landed",
];
/* git push's words for a ref the remote itself refused, as a ruleset or a
 * protected branch does: pushed again, it is refused again. */
const REMOTE_REJECTED = /^ ! \[remote rejected\].*/m;
/* Git's words for a loose object a crash left empty or torn, naming its file
 * by its fan-out directory and name. */
const BROKEN_OBJECT =
	/(?:object file|stored in) \S*?([0-9a-f]{2})\/([0-9a-f]{38,62})\)? is (?:empty|corrupt)/;

/**
 * @typedef {import("./queue-lander.js").Verdict} Verdict
 * @typedef {import("./queue-lander.js").Batch} Batch
 * @typedef {import("./queue-lander.js").Blame} Blame
 * @typedef {import("./queue-lander.js").Isolated} Isolated
 * @typedef {import("./queue-lander.js").Serial} Serial
 * @typedef {import("./queue-lander.js").Hold} Hold
 * @typedef {import("./queue-lander.js").Member} Member
 * @typedef {import("./queue-lander.js").MergeResult} MergeResult
 * @typedef {import("./queue-lander.js").QueueGit} QueueGit
 * @typedef {import("./queue-lander.js").QueueRef} QueueRef
 * @typedef {import("./queue-lander.js").VerdictLedger} VerdictLedger
 * @typedef {import("./queue-lander.js").BatchRecord} BatchRecord
 * @typedef {import("./queue-lander.js").Drop} Drop
 * @typedef {import("./queue-lander.js").DropRecord} DropRecord
 * @typedef {import("./queue-lander.js").DroppedRef} DroppedRef
 * @typedef {import("./queue-lander.js").QueueLanderDeps} QueueLanderDeps
 */

/**
 * @template T
 * @typedef {{kind: "absent"} | {kind: "torn"} | {kind: "read", value: T}}
 *   RecordRead a record file: absent, torn where it will not parse or is not
 *   the record, or read
 */

/**
 * The queue lander's git, run in `root`. Merges are made in a throwaway
 * worktree, and run its merge driver and commit hooks as any merge there
 * does. A call that meets a broken loose object removes that object's file
 * and fetches before it throws, so its retry reads the object afresh.
 * @param {string} root
 * @param {number} [mergeTimeoutMs] each member's merge, its gates included
 * @returns {QueueGit}
 */
function queueGit(root, mergeTimeoutMs = GATED_COMMIT_TIMEOUT_MS) {
	const fetchSpecs = [
		trackingRefspec(VERIFIED_BRANCH),
		QUEUE_REFSPEC,
		`+${DROPPED_HEADS}*:refs/remotes/${REMOTE}/${DROPPED_PREFIX}*`,
	];
	/**
	 * `call`'s result; where it meets a broken loose object, that object's
	 * file is removed and the remote fetched, and it throws a TransientFault.
	 * @template T
	 * @param {() => T} call
	 * @returns {T}
	 */
	const repairing = (call) => {
		try {
			return call();
		} catch (err) {
			const broken = BROKEN_OBJECT.exec(String(caught(err).stderr ?? ""));
			if (!broken) throw err;
			const common = gitCommonDirOrThrow(root);
			fs.rmSync(
				path.resolve(root, common, "objects", broken[1] ?? "", broken[2] ?? ""),
				{ force: true },
			);
			git(["fetch", "--quiet", REMOTE, ...fetchSpecs]);
			throw new TransientFault(
				`a broken git object, removed and fetched again: ${parseRefusal(parseErrorText(err))}`,
				{ cause: err },
			);
		}
	};
	/** @param {string[]} args */
	const git = (args) =>
		execGit(args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: LANDER_GIT_TIMEOUT_MS,
		});
	/** @param {string[]} shas @returns {Map<string, number>} */
	const committedAt = (shas) => {
		if (shas.length === 0) return new Map();
		const printed = git([
			"log",
			"--no-walk=unsorted",
			"--format=%H %ct",
			...shas,
		]);
		return new Map(
			printed
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [sha = "", at = ""] = line.split(" ");
					return [sha, Number(at) * 1000];
				}),
		);
	};
	return {
		refs: () =>
			repairing(() => {
				const mainRef = `refs/heads/${VERIFIED_BRANCH}`;
				const heads = readRemoteHeads(
					root,
					[mainRef, `${QUEUE_HEADS}*`, `${DROPPED_HEADS}*`],
					() => fetchSpecs,
				);
				const listed = [...heads].flatMap(([ref, sha]) =>
					ref.startsWith(QUEUE_HEADS) ? [{ ref, sha }] : [],
				);
				const enqueued = readEnqueueTimes(queueLogFile(root));
				const times = committedAt(
					listed
						.filter((r) => enqueued(r.ref, r.sha) === null)
						.map((r) => r.sha),
				);
				/** @type {QueueRef[]} */
				const queue = listed.map(({ ref, sha }) => {
					const pushedAt = enqueued(ref, sha) ?? times.get(sha);
					if (pushedAt === undefined || !Number.isFinite(pushedAt))
						throw new Error(`git log printed no committer time for ${sha}`);
					return { name: ref.slice(QUEUE_HEADS.length), sha, pushedAt };
				});
				/** @type {DroppedRef[]} */
				const dropped = [...heads].flatMap(([ref, sha]) =>
					ref.startsWith(DROPPED_HEADS)
						? [{ ref: ref.slice("refs/heads/".length), sha }]
						: [],
				);
				return { main: heads.get(mainRef) ?? null, queue, dropped };
			}),
		mergeMembers: (onto, members) =>
			repairing(() => {
				const [lone] = members;
				if (members.length === 1 && lone && isAncestor(root, onto, lone.sha))
					return { kind: "merged", sha: lone.sha };
				return withThrowawayTree(
					root,
					onto,
					{ program: "queue-lander", use: "merge" },
					(_dir, inTree) => {
						for (const m of members) {
							const failed = mergeFailure(m, inTree, () =>
								inTree(
									[
										"merge",
										"--no-ff",
										"--no-edit",
										"-m",
										`Merge queue/${m.name} at ${short(m.sha)} into the batch`,
										m.sha,
									],
									mergeTimeoutMs,
								),
							);
							if (failed) return failed;
						}
						return {
							kind: "merged",
							sha: inTree(["rev-parse", "HEAD"]).trim(),
						};
					},
				);
			}),
		pushBatch(sha) {
			pushRemote(root, ["--force", `${sha}:refs/heads/${LANDER_BATCH_BRANCH}`]);
		},
		pushIso(branch, sha) {
			pushRemote(root, ["--force", `${sha}:refs/heads/${branch}`]);
		},
		pushMain(sha) {
			try {
				pushRemote(root, [`${sha}:refs/heads/${VERIFIED_BRANCH}`]);
				return null;
			} catch (err) {
				const refused = REMOTE_REJECTED.exec(String(caught(err).stderr ?? ""));
				if (refused === null) throw err;
				return refused[0].trim();
			}
		},
		deleteRef(branch, sha) {
			const ref = `refs/heads/${branch}`;
			try {
				pushRemote(root, [`--force-with-lease=${ref}:${sha}`, `:${ref}`]);
				return true;
			} catch (err) {
				const refused = parseErrorText(err);
				if (GONE.test(refused)) return true;
				if (STALE.test(refused)) return false;
				throw err;
			}
		},
		createRef(branch, sha) {
			const ref = `refs/heads/${branch}`;
			try {
				pushRemote(root, [`--force-with-lease=${ref}:`, `${sha}:${ref}`]);
			} catch (err) {
				/* Made already, as by a drop a crash repeats. */
				if (!STALE.test(parseErrorText(err))) throw err;
				const held = git(["ls-remote", REMOTE, ref]).split("\t")[0];
				if (held !== sha) throw err;
			}
		},
	};

	/**
	 * Why `m` did not merge, else null. A fault that is no git refusal, a
	 * spawn failure or a timeout among them, throws for the run to retry.
	 * @param {Member} m
	 * @param {(args: string[]) => string} inTree
	 * @param {() => unknown} merge
	 * @returns {MergeResult|null}
	 */
	function mergeFailure(m, inTree, merge) {
		try {
			merge();
			return null;
		} catch (err) {
			const e = caught(err);
			if (e.code === "ETIMEDOUT")
				throw new TransientFault(
					`queue/${m.name}'s merge timed out after ${mergeTimeoutMs / 1000} s`,
					{ cause: err },
				);
			if (e.status === undefined || BROKEN_OBJECT.test(String(e.stderr ?? "")))
				throw err;
			const files = readConflictedFiles(inTree);
			return files.length > 0
				? { kind: "conflict", name: m.name, files }
				: {
						kind: "refused",
						name: m.name,
						reason: parseRefusal(parseErrorText(err)),
					};
		}
	}
}

/** @param {unknown} list @returns {list is string[]} */
const isStringList = (list) =>
	Array.isArray(list) && list.every((f) => typeof f === "string");

/**
 * The row's verdict where it is a green or a red, else null.
 * @param {unknown} v
 * @returns {Verdict|null}
 */
function parseVerdict(v) {
	const o = /** @type {Record<string, unknown>|null} */ (
		v !== null && typeof v === "object" ? v : null
	);
	if (o?.kind === "green")
		return typeof o.run === "number"
			? { kind: "green", run: o.run }
			: { kind: "green" };
	if (o?.kind === "red" && isStringList(o.files))
		return isStringList(o.jobs)
			? { kind: "red", files: o.files, jobs: o.jobs }
			: { kind: "red", files: o.files };
	return null;
}

/** @param {readonly string[]} files */
const fileKey = (files) => [...files].sort().join("\n");

/**
 * The verdict ledger: one JSON line per green or red reached, by sha, the
 * files it ran, the whole suite being none, and its pass, a line naming none
 * the first. The newest line for a sha, file set and pass is its verdict. A
 * line lost to an unwritable file costs a rerun, never a landing.
 * @param {string} file
 * @returns {VerdictLedger}
 */
function verdictLedger(file) {
	return {
		get(sha, files, pass = 1) {
			const key = fileKey(files);
			const rows = readJsonl(file)?.rows ?? [];
			for (const row of rows.toReversed()) {
				if (row.sha !== sha || !isStringList(row.files)) continue;
				if (fileKey(row.files) !== key || (row.pass ?? 1) !== pass) continue;
				const v = parseVerdict(row.verdict);
				if (v) return v;
			}
			return null;
		},
		add(sha, files, v, pass = 1) {
			appendRetained(
				file,
				{
					at: new Date(now()).toISOString(),
					sha,
					files: [...files].sort(),
					...(pass === 1 ? {} : { pass }),
					verdict: v,
				},
				VERDICT_RETAIN_MS,
			);
		},
	};
}

/** @param {unknown} v @returns {Record<string, unknown>|null} */
const objectOf = (v) =>
	v !== null && typeof v === "object"
		? /** @type {Record<string, unknown>} */ (v)
		: null;

/** @param {unknown} b @returns {b is Blame} */
const isBlame = (b) => {
	const o = objectOf(b);
	return (
		isStringList(o?.files) && isStringList(o?.base) && isStringList(o?.members)
	);
};

/** @param {unknown} i @returns {i is Isolated} */
const isIsolated = (i) => {
	const o = objectOf(i);
	return (
		typeof o?.name === "string" &&
		typeof o.sha === "string" &&
		typeof o.iso === "string"
	);
};

/** @param {unknown} s @returns {s is Serial} */
const isSerial = (s) => {
	const o = objectOf(s);
	const step = objectOf(o?.step);
	return (
		isStringList(o?.landed) &&
		(o?.step === null ||
			(typeof step?.name === "string" &&
				typeof step.sha === "string" &&
				typeof step.onto === "string"))
	);
};

/** @param {unknown} h @returns {h is Hold} */
const isHold = (h) => {
	const o = objectOf(h);
	if (typeof o?.main !== "string") return false;
	if (o.kind === "base")
		return (
			isStringList(o.files) && (o.ticket === null || Number.isInteger(o.ticket))
		);
	return (
		o.kind === "refused" &&
		typeof o.sha === "string" &&
		typeof o.reason === "string"
	);
};

/** @param {unknown} m @returns {m is Member} */
const isMember = (m) => {
	const o = /** @type {Record<string, unknown>|null} */ (
		m !== null && typeof m === "object" ? m : null
	);
	return (
		typeof o?.name === "string" &&
		typeof o.sha === "string" &&
		typeof o.pushedAt === "number"
	);
};

/**
 * Whether a batch record's red-path fields are each well formed.
 * @param {Record<string, unknown>} b
 * @returns {b is Record<string, unknown>
 *   & Pick<Batch, "ahead" | "blame" | "isolated" | "serial" | "hold">}
 */
const hasRedPath = (b) =>
	isStringList(b.ahead) &&
	(b.blame === null || isBlame(b.blame)) &&
	Array.isArray(b.isolated) &&
	b.isolated.every(isIsolated) &&
	(b.serial === null || isSerial(b.serial)) &&
	(b.hold === null || isHold(b.hold));

/**
 * A JSON record file: absent, torn where it will not parse, or its value.
 * Any other read fault throws.
 * @param {string} file
 * @returns {RecordRead<unknown>}
 */
function readRecordFile(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return { kind: "absent" };
		throw err;
	}
	try {
		return { kind: "read", value: JSON.parse(text) };
	} catch {
		return { kind: "torn" };
	}
}

/**
 * @param {unknown} parsed
 * @returns {Batch|null}
 */
function parseBatch(parsed) {
	const b = /** @type {Record<string, unknown>|null} */ (
		parsed !== null && typeof parsed === "object" ? parsed : null
	);
	if (
		!b ||
		!Array.isArray(b.members) ||
		!b.members.every(isMember) ||
		typeof b.onto !== "string" ||
		!isStringList(b.deferred) ||
		!isStringList(b.dropped) ||
		!(b.integration === null || typeof b.integration === "string") ||
		typeof b.phase !== "string" ||
		!PHASES.includes(b.phase) ||
		!hasRedPath(b)
	)
		return null;
	return {
		members: b.members,
		deferred: b.deferred,
		dropped: b.dropped,
		onto: b.onto,
		integration: b.integration,
		phase: /** @type {Batch["phase"]} */ (b.phase),
		ahead: b.ahead,
		blame: b.blame,
		isolated: b.isolated,
		serial: b.serial,
		hold: b.hold,
	};
}

/**
 * The batch record's file: absent, torn where it is no batch, or the batch.
 * @param {string} file
 * @returns {RecordRead<Batch>}
 */
function readBatchFile(file) {
	const r = readRecordFile(file);
	if (r.kind !== "read") return r;
	const batch = parseBatch(r.value);
	return batch ? { kind: "read", value: batch } : { kind: "torn" };
}

/**
 * The batch record: the batch a run is landing, so the next run resumes it.
 * A record that is absent or not a batch reads as none.
 * @param {string} file
 * @returns {BatchRecord}
 */
function batchRecord(file) {
	return {
		read() {
			const r = readBatchFile(file);
			return r.kind === "read" ? r.value : null;
		},
		write(b) {
			writeFileAtomic(file, `${JSON.stringify(b)}\n`);
		},
	};
}

/** @param {unknown} u @returns {u is Drop["cause"]} */
const isCause = (u) => {
	const o = objectOf(u);
	if (typeof o?.name !== "string") return false;
	switch (o.kind) {
		case "conflict":
			return isStringList(o.files);
		case "refused":
			return typeof o.reason === "string";
		case "red":
			return isStringList(o.files) && typeof o.iso === "string";
		case "collision":
			return (
				isStringList(o.files) &&
				typeof o.step === "string" &&
				isStringList(o.after)
			);
		default:
			return false;
	}
};

/** @param {unknown} d @returns {d is Drop} */
const isDrop = (d) => {
	const o = /** @type {Record<string, unknown>|null} */ (
		d !== null && typeof d === "object" ? d : null
	);
	return (
		typeof o?.name === "string" &&
		typeof o.sha === "string" &&
		typeof o.ref === "string" &&
		typeof o.onto === "string" &&
		isCause(o.cause) &&
		(o.ticket === null || Number.isInteger(o.ticket)) &&
		Number.isFinite(o.at) &&
		(o.reapedAt === undefined || Number.isFinite(o.reapedAt))
	);
};

/**
 * The drop record's file: absent, torn where it is no list, or its drops, a
 * row that is not a drop skipped.
 * @param {string} file
 * @returns {RecordRead<Drop[]>}
 */
function readDropFile(file) {
	const r = readRecordFile(file);
	if (r.kind !== "read") return r;
	return Array.isArray(r.value)
		? { kind: "read", value: r.value.filter(isDrop) }
		: { kind: "torn" };
}

/**
 * The drop record: every dropped ref, with its fix ticket, until the queue
 * log's retention after its reap. A row that is not a drop is skipped; an absent or torn record
 * reads as none, and no run then reaps the refs it named.
 * @param {string} file
 * @returns {DropRecord}
 */
function dropRecord(file) {
	return {
		read() {
			const r = readDropFile(file);
			return r.kind === "read" ? r.value : [];
		},
		write(drops) {
			writeFileAtomic(file, `${JSON.stringify(drops)}\n`);
		},
	};
}

/**
 * A land or drop row repeating the newest row its ref holds at that sha is
 * skipped, as a step a crash repeats writes it again.
 * @param {string} root
 * @returns {QueueLanderDeps["logQueue"]}
 */
const queueLogger = (root) => (event, m) => {
	const file = queueLogFile(root);
	const ref = `${QUEUE_HEADS}${m.name}`;
	if (event !== "take" && readNewestEvent(file, ref, m.sha) === event) return;
	logQueueEvent(file, event, { ref, sha: m.sha, at: now() });
};

module.exports = {
	batchRecord,
	dropRecord,
	queueGit,
	queueLogger,
	readBatchFile,
	readDropFile,
	verdictLedger,
};
