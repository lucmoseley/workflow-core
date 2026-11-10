/*
 * queue-lander-adapters.js — the production adapters lib/queue-lander.js
 * runs on: its git against lib/landing-refs.js's remote, and its verdict
 * ledger and batch record files (#4485, spec #4458).
 *
 * A queue ref's push time is the one lib/queue-log.js logged for it at the
 * sha it now holds. A sha with no row, as one pushed from another machine,
 * falls back to its tip's committer time, as the remote, GitHub, tells git
 * no push time.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { now } = require("./check.js");
const { caught, parseErrorText } = require("./caught.js");
const { gitCommonDirOrThrow } = require("./git.js");
const { readJsonl } = require("./jsonl.js");
const { writeFd } = require("./write-fd.js");
const { PushRefused } = require("./network-fault.js");
const {
	GATED_COMMIT_TIMEOUT_MS,
	createRemoteRef,
	deleteRemoteRef,
	isAncestor,
	parseRefusal,
	parseRefusalTail,
	pushRemote,
	readConflictedFiles,
	readGit,
	readRemoteHeads,
	short,
	withThrowawayTree,
} = require("./lander-git.js");
const {
	DROPPED_PREFIX,
	QUEUE_HEADS,
	batchBranch,
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
const { REGENERATED_FILES } = require("./regenerated-files.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");

/* Untraced, a first guess and stated as one: a verdict is read again only
 * for a batch a run resumes, which waits hours, never weeks. */
const VERDICT_RETAIN_MS = 14 * DAY_MS;
const DROPPED_HEADS = `refs/heads/${DROPPED_PREFIX}`;
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
 * protected branch does: pushed again, it is refused again — save where the
 * refusal is the remote's own fault, which lib/network-fault.js names. */
const REMOTE_REJECTED = /^ ! \[remote rejected\].*/m;
/* Git's words for a loose object a crash left empty or torn, naming its file
 * by its fan-out directory and name. */
const BROKEN_OBJECT =
	/(?:object file|stored in) \S*?([0-9a-f]{2})\/([0-9a-f]{38,62})\)? is (?:empty|corrupt)/;

/**
 * @typedef {import("./queue-lander.js").Verdict} Verdict
 * @typedef {import("./queue-lander.js").Batch} Batch
 * @typedef {import("./queue-lander.js").Pipeline} Pipeline
 * @typedef {import("./queue-lander.js").Blame} Blame
 * @typedef {import("./queue-lander.js").Isolated} Isolated
 * @typedef {import("./queue-lander.js").Serial} Serial
 * @typedef {import("./queue-lander.js").Hold} Hold
 * @typedef {import("./queue-lander.js").Member} Member
 * @typedef {import("./queue-lander.js").MergeResult} MergeResult
 * @typedef {import("./queue-lander.js").QueueGit} QueueGit
 * @typedef {import("./queue-lander.js").QueueRef} QueueRef
 * @typedef {import("./queue-lander.js").VerdictLedger} VerdictLedger
 * @typedef {import("./queue-lander.js").PipelineRecord} PipelineRecord
 * @typedef {import("./queue-lander.js").BaseVerdict} BaseVerdict
 * @typedef {import("./queue-lander.js").RefusedRecord} RefusedRecord
 * @typedef {import("./queue-lander.js").Drop} Drop
 * @typedef {import("./queue-lander.js").DropRecord} DropRecord
 * @typedef {import("./queue-lander.js").DroppedRef} DroppedRef
 * @typedef {import("./queue-lander.js").QueueLanderDeps} QueueLanderDeps
 * @typedef {import("./regenerated-files.js").Regenerated} Regenerated
 */

/**
 * @template T
 * @typedef {{kind: "absent"} | {kind: "torn"} | {kind: "read", value: T}}
 *   RecordRead a record file: absent, torn where it will not parse or is not
 *   the record, or read
 */

/**
 * The queue lander's git, run in `root`. Merges are made in a throwaway
 * worktree, through its merge driver, each running the pre-commit hook's
 * merge gate set and committed with no hook; the batch's set then runs once
 * over them all (#4545). A call that meets a broken loose object removes that object's file
 * and fetches before it throws, so its retry reads the object afresh.
 * @param {string} root
 * @param {number} [mergeTimeoutMs] each member's merge, its gates included,
 *   and the batch's one gate pass: each at most one commit's whole gate
 *   stack, which #3913's figure was measured on
 * @param {ReadonlyMap<string, Regenerated>} [regenerated] the files each
 *   merge renders afresh rather than takes from either side
 * @param {{ciRepeats?: boolean}} [options] `ciRepeats` where the tester is
 *   the Actions run, which repeats the gates the batch's set leaves out;
 *   else the batch runs every gate
 * @returns {QueueGit}
 */
function queueGit(
	root,
	mergeTimeoutMs = GATED_COMMIT_TIMEOUT_MS,
	regenerated = REGENERATED_FILES,
	{ ciRepeats = false } = {},
) {
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
	const git = (args) => readGit(root, args);
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
		mergeMembers: (onto, members, fresh, started) =>
			repairing(() => {
				const [lone] = members;
				if (
					!fresh &&
					members.length === 1 &&
					lone &&
					isAncestor(root, onto, lone.sha)
				)
					return { kind: "merged", sha: lone.sha };
				const whole = mergeGated(onto, members, started);
				if (whole.kind !== "refused" || members.length === 1) return whole;
				/* The batch's gates refused: the first member they refuse alone,
				 * else the interaction, named by the last member (#4545). */
				for (const m of members) {
					const alone = mergeGated(onto, [m]);
					if (alone.kind !== "merged") return alone;
				}
				return whole;
			}),
		pushBatch(slot, sha) {
			pushRemote(root, ["--force", `${sha}:refs/heads/${batchBranch(slot)}`]);
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
				if (refused === null || !(err instanceof PushRefused)) throw err;
				return refused[0].trim();
			}
		},
		isAncestor: (sha, of) => isAncestor(root, sha, of),
		deleteRef: (branch, sha) => deleteRemoteRef(root, branch, sha),
		createRef: (branch, sha) => createRemoteRef(root, branch, sha),
	};

	/**
	 * `members` merged in order onto `onto` in a throwaway worktree, then the
	 * batch's gates run once over them all, staged against `onto` (#4545),
	 * `started` given the merges first where `ciRepeats` (#4573).
	 * @param {string} onto
	 * @param {readonly Member[]} members
	 * @param {(sha: string) => void} [started]
	 * @returns {MergeResult}
	 */
	function mergeGated(onto, members, started) {
		return withThrowawayTree(
			root,
			onto,
			{ program: "queue-lander", use: "merge" },
			(dir, inTree) => {
				const gates = hookGates(dir, inTree);
				for (const m of members) {
					const failed = mergeFailure(m, inTree, () =>
						mergeMember(m, dir, inTree, gates),
					);
					if (failed) return failed;
				}
				const sha = inTree(["rev-parse", "HEAD"]).trim();
				const last = members.at(-1);
				if (sha === onto || !last) return { kind: "merged", sha };
				if (ciRepeats) started?.(sha);
				return batchPass({ onto, sha, last }, inTree, gates);
			},
		);
	}

	/**
	 * The batch's one gate pass over every member's merge `sha` staged against
	 * `onto`, then back on `sha`, committing what the gates staged, as a
	 * member's own commit took its hook's edits (#4545). A refusal names
	 * `last`.
	 * @param {{onto: string, sha: string, last: Member}} batch
	 * @param {(args: string[], timeout?: number) => string} inTree
	 * @param {(set: "batch" | "all") => void} gates
	 * @returns {MergeResult}
	 */
	function batchPass({ onto, sha, last }, inTree, gates) {
		inTree(["reset", "--quiet", "--soft", onto]);
		const failed = mergeFailure(last, inTree, () =>
			gates(ciRepeats ? "batch" : "all"),
		);
		if (failed) return failed;
		inTree(["reset", "--quiet", "--soft", sha]);
		if (inTree(["diff", "--cached", "--name-only"]).trim() === "")
			return { kind: "merged", sha };
		inTree(
			[
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--quiet",
				"-m",
				"Take the batch's gate fixes",
			],
			mergeTimeoutMs,
		);
		return { kind: "merged", sha: inTree(["rev-parse", "HEAD"]).trim() };
	}

	/**
	 * The pre-commit hook git would run in `dir`, on a gate set: `merge`,
	 * `batch`, or every gate on `all`; none where git would run none.
	 * @param {string} dir
	 * @param {(args: string[]) => string} inTree
	 * @returns {(set: "merge" | "batch" | "all") => void}
	 */
	function hookGates(dir, inTree) {
		const hook = path.resolve(
			dir,
			inTree(["rev-parse", "--git-path", "hooks/pre-commit"]).trim(),
		);
		return (set) => {
			try {
				fs.accessSync(hook, fs.constants.X_OK);
			} catch {
				/* Fails open as git does on a hook it cannot run (#4545). */
				writeFd(
					2,
					`queue-lander: ${hook} is not executable, so no gate ran on this merge\n`,
				);
				return;
			}
			execFileSync(hook, set === "all" ? [] : [`--gates=${set}`], {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: mergeTimeoutMs,
			});
		};
	}

	/**
	 * `--no-commit`, the merge's gates, then a commit no hook runs on: the
	 * gates' index, the anchors a merge carries among them (#4514), is what
	 * it takes. A conflict in regenerated
	 * files alone, each changed on both sides, is no refusal; one deleted on a
	 * side is, since a render would undo the deletion.
	 * @param {Member} m
	 * @param {string} dir
	 * @param {(args: string[], timeout?: number) => string} inTree
	 * @param {(set: "merge") => void} gates
	 */
	function mergeMember(m, dir, inTree, gates) {
		try {
			inTree(
				[
					"merge",
					"--no-ff",
					"--no-commit",
					"-m",
					`Merge queue/${m.name} at ${short(m.sha)} into the batch`,
					m.sha,
				],
				mergeTimeoutMs,
			);
		} catch (err) {
			const files = readConflictedFiles(inTree);
			const settles = (/** @type {string} */ f) =>
				regenerated.has(f) && changedOnBothSides(inTree, f);
			if (files.length === 0 || !files.every(settles)) throw err;
			for (const f of files) inTree(["checkout", "--ours", "--", f]);
		}
		if (!isMerging(inTree)) return;
		regenerate(dir, inTree);
		gates("merge");
		inTree(
			["-c", "core.hooksPath=/dev/null", "commit", "--no-edit"],
			mergeTimeoutMs,
		);
	}

	/**
	 * Stages each regenerated file the merge in `dir` holds as its generator
	 * writes it there: two sides' copies merged as text, or merged cleanly, can
	 * still disagree with the tree they describe. The generator is the copy the
	 * commit gate runs, `WFC_PLUGIN_ROOT`'s else the merged tree's own, so the
	 * gate passes what it writes; one that fails is a refusal carrying its
	 * output.
	 * @param {string} dir
	 * @param {(args: string[]) => string} inTree
	 */
	function regenerate(dir, inTree) {
		const pluginRoot = process.env.WFC_PLUGIN_ROOT || dir;
		for (const [file, { generator }] of regenerated) {
			/* Absent: the merge deleted it, and a deletion stands. */
			if (!fs.existsSync(path.join(dir, file))) continue;
			execFileSync(process.execPath, [path.join(pluginRoot, generator)], {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: mergeTimeoutMs,
			});
			inTree(["add", "--", file]);
		}
	}

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
						reason: parseRefusalTail(parseErrorText(err)),
					};
		}
	}
}

/**
 * Whether the tree `inTree` runs git in has a merge in progress: none follows
 * a merge of a sha it already holds. Any fault but `--verify`'s exit 1 for an
 * absent ref throws, for mergeFailure to judge.
 * @param {(args: string[]) => string} inTree
 */
const isMerging = (inTree) => {
	try {
		inTree(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
		return true;
	} catch (err) {
		if (caught(err).status === 1) return false;
		throw err;
	}
};

/**
 * Whether the merge in the tree `inTree` runs git in left `file` conflicted
 * with both sides' copies present, neither side deleting it.
 * @param {(args: string[]) => string} inTree
 * @param {string} file
 */
const changedOnBothSides = (inTree, file) => {
	const stages = new Set(
		inTree(["ls-files", "-u", "--", file])
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split(/\s+/)[2]),
	);
	return stages.has("2") && stages.has("3");
};

/** @param {unknown} list @returns {list is string[]} */
const isStringList = (list) =>
	Array.isArray(list) && list.every((f) => typeof f === "string");

/**
 * A green row's verdict: the run that passed it and the files its in-job
 * retry cleared, its flakes (#4558), where the row names them.
 * @param {Record<string, unknown>} o
 * @returns {Verdict}
 */
const parseGreen = (o) => ({
	kind: "green",
	...(typeof o.run === "number" ? { run: o.run } : {}),
	...(isStringList(o.cleared) && o.cleared.length > 0
		? { cleared: o.cleared }
		: {}),
});

/**
 * The row's verdict where it is a green or a red, else null.
 * @param {unknown} v
 * @returns {Verdict|null}
 */
function parseVerdict(v) {
	const o = /** @type {Record<string, unknown>|null} */ (
		v !== null && typeof v === "object" ? v : null
	);
	if (o?.kind === "green") return parseGreen(o);
	if (o?.kind === "red" && isStringList(o.files))
		return {
			kind: "red",
			files: o.files,
			...(isStringList(o.jobs) ? { jobs: o.jobs } : {}),
			/* Retried in its own run, so the lander takes no re-run (#4545). */
			...(o.retried === true ? { retried: true } : {}),
			...(o.noRun === true ? { noRun: true } : {}),
		};
	return null;
}

/**
 * A ledger row's time in ms, the epoch where it has none readable, so a
 * no-run red of unknown age is asked again rather than trusted (#4572).
 * @param {unknown} at
 */
const parseLedgerTime = (at) => Date.parse(String(at)) || 0;

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
				const verdict = parseVerdict(row.verdict);
				if (verdict) return { verdict, at: parseLedgerTime(row.at) };
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

/**
 * The refused record: one JSON line per sha the remote refused on `main`,
 * with its refusal.
 * @param {string} file
 * @returns {RefusedRecord}
 */
function refusedRecord(file) {
	return {
		refusalOf(sha) {
			const rows = readJsonl(file)?.rows ?? [];
			const row = rows.find(
				(r) => r.sha === sha && typeof r.reason === "string",
			);
			return row ? String(row.reason) : null;
		},
		add(sha, reason) {
			fs.appendFileSync(
				file,
				`${JSON.stringify({ at: new Date(now()).toISOString(), sha, reason })}\n`,
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
			isStringList(o.files) &&
			(o.ticket === null || Number.isInteger(o.ticket)) &&
			(o.retakeAt === undefined || Number.isFinite(o.retakeAt))
		);
	return (
		o.kind === "refused" &&
		typeof o.sha === "string" &&
		typeof o.reason === "string"
	);
};

/** @param {unknown} x @returns {x is BaseVerdict} */
const isBaseVerdict = (x) => {
	const o = objectOf(x);
	return (
		typeof o?.sha === "string" &&
		isStringList(o.files) &&
		parseVerdict(o.verdict) !== null
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
 *   & Pick<Batch, "ahead" | "blame" | "isolated" | "serial" | "hold"
 *   | "bases">}
 */
const hasRedPath = (b) =>
	isStringList(b.ahead) &&
	(b.blame === null || isBlame(b.blame)) &&
	Array.isArray(b.isolated) &&
	b.isolated.every(isIsolated) &&
	(b.serial === null || isSerial(b.serial)) &&
	(b.hold === null || isHold(b.hold)) &&
	Array.isArray(b.bases) &&
	b.bases.every(isBaseVerdict);

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
		!Number.isInteger(b.slot) ||
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
		slot: /** @type {number} */ (b.slot),
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
		bases: b.bases.map((x) => ({
			sha: x.sha,
			files: x.files,
			verdict: /** @type {BaseVerdict["verdict"]} */ (parseVerdict(x.verdict)),
		})),
	};
}

/**
 * @param {unknown} parsed
 * @returns {Pipeline|null}
 */
function parsePipeline(parsed) {
	const p = objectOf(parsed);
	if (!p || !Array.isArray(p.line) || !Number.isInteger(p.depth)) return null;
	const line = p.line.map(parseBatch);
	const search = p.search === null ? null : parseBatch(p.search);
	if (line.some((b) => b === null) || (p.search !== null && search === null))
		return null;
	return {
		line: /** @type {Batch[]} */ (line),
		search,
		depth: /** @type {number} */ (p.depth),
	};
}

/**
 * The pipeline record's file: absent, torn where it is no pipeline, or the
 * pipeline.
 * @param {string} file
 * @returns {RecordRead<Pipeline>}
 */
function readPipelineFile(file) {
	const r = readRecordFile(file);
	if (r.kind !== "read") return r;
	const pipeline = parsePipeline(r.value);
	return pipeline ? { kind: "read", value: pipeline } : { kind: "torn" };
}

/**
 * The pipeline record: the batches a run is landing, so the next run
 * resumes them. A record that is absent or no pipeline reads as none.
 * @param {string} file
 * @returns {PipelineRecord}
 */
function pipelineRecord(file) {
	return {
		read() {
			const r = readPipelineFile(file);
			return r.kind === "read" ? r.value : null;
		},
		write(p) {
			writeFileAtomic(file, `${JSON.stringify(p)}\n`);
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
		case "unrecorded":
			return true;
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
 * log's retention after its reap. An absent or torn record
 * reads as none, and the lander writes back the entry of each dropped ref it
 * named from the tracker.
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
	pipelineRecord,
	dropRecord,
	queueGit,
	queueLogger,
	readPipelineFile,
	readDropFile,
	refusedRecord,
	verdictLedger,
};
