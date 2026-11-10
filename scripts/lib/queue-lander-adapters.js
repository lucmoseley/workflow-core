/*
 * queue-lander-adapters.js — the production adapters lib/queue-lander.js
 * runs on: its git against lib/landing-refs.js's remote, and its verdict
 * ledger and refused record (workflow-core#4485, spec workflow-core#4458). lib/lander-records.js holds
 * the pipeline and drop records.
 *
 * A queue ref's push time is the one lib/queue-log.js logged for it at the
 * sha it now holds. A sha with no row, as one pushed from another machine,
 * falls back to its tip's committer time, as the remote, GitHub, tells git
 * no push time.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { newFaultItems } = require("./fault-diff.js");
const { PROFILES } = require("./fault-profiles.js");
const { now } = require("./check.js");
const { caught, parseErrorText } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
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
const { isStringList, parseVerdict } = require("./lander-records.js");

const REGISTRY_PROFILE = (() => {
	const profile = PROFILES["guard-registry"];
	if (!profile)
		throw new Error("lib/fault-profiles.js carries no guard-registry profile");
	return profile;
})();

/* Untraced, a first guess and stated as one: a verdict is read again only
 * for a batch a run resumes, which waits hours, never weeks. */
const VERDICT_RETAIN_MS = 14 * DAY_MS;
const DROPPED_HEADS = `refs/heads/${DROPPED_PREFIX}`;
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
 * @typedef {import("./lander-records.js").Member} Member
 * @typedef {import("./queue-lander.js").MergeResult} MergeResult
 * @typedef {import("./queue-lander.js").QueueGit} QueueGit
 * @typedef {import("./queue-lander.js").QueueRef} QueueRef
 * @typedef {import("./queue-lander.js").VerdictLedger} VerdictLedger
 * @typedef {import("./queue-lander.js").RefusedRecord} RefusedRecord
 * @typedef {import("./queue-lander.js").DroppedRef} DroppedRef
 * @typedef {import("./queue-lander.js").QueueLanderDeps} QueueLanderDeps
 * @typedef {import("./regenerated-files.js").Regenerated} Regenerated
 */

/**
 * The copy of `rel` the commit gate runs over the merged tree at `dir`:
 * `WFC_PLUGIN_ROOT`'s, else the tree's own.
 * @param {string} dir
 * @param {string} rel
 */
const gateCopy = (dir, rel) =>
	path.join(process.env.WFC_PLUGIN_ROOT || dir, rel);

/**
 * The registry checker's --json envelope out of its run over `sha`, null
 * where it skipped.
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {string} sha
 * @param {number} timeoutMs
 * @returns {Record<string, unknown> | null}
 */
function readEnvelope(r, sha, timeoutMs) {
	const over = `check-guard-registry.js over ${short(sha)}`;
	if (caught(r.error).code === "ETIMEDOUT")
		throw new TransientFault(`${over} timed out after ${timeoutMs / 1000} s`, {
			cause: r.error,
		});
	/** @type {Record<string, unknown>} */
	let envelope;
	try {
		envelope = JSON.parse(r.stdout);
	} catch (err) {
		const last = String(r.stderr ?? r.error?.message ?? "")
			.trim()
			.split("\n")
			.at(-1);
		throw new Error(
			`${over} gave no --json envelope (exit ${r.status}): ${last}`,
			{
				cause: err,
			},
		);
	}
	if (envelope.outcome === "SKIP") return null;
	if (envelope.outcome === "BROKEN")
		throw new Error(`${over} could not judge it: ${envelope.summary}`);
	return envelope;
}

/**
 * The queue lander's git, run in `root`. Merges are made in a throwaway
 * worktree, through its merge driver, each running the pre-commit hook's
 * merge gate set and committed with no hook; the batch's set then runs once
 * over them all (workflow-core#4545). A call that meets a broken loose object removes that object's file
 * and fetches before it throws, so its retry reads the object afresh.
 * @param {string} root
 * @param {number} [mergeTimeoutMs] each member's merge, its gates included,
 *   and the batch's one gate pass: each at most one commit's whole gate
 *   stack, which workflow-core#3913's figure was measured on
 * @param {ReadonlyMap<string, Regenerated>} [regenerated] the files each
 *   merge renders afresh rather than takes from either side
 * @param {{ciRepeats?: boolean}} [options] `ciRepeats` where the tester's
 *   run repeats the gates the batch's set leaves out, its `repeatsGates`;
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
					return judgeWhole(onto, { kind: "merged", sha: lone.sha }, lone);
				const whole = mergeGated(onto, members, started);
				if (whole.kind !== "refused" || members.length === 1) return whole;
				/* The batch's gates refused: the first member they refuse alone,
				 * else the interaction, named by the last member (workflow-core#4545). */
				for (const m of members) {
					const alone = mergeGated(onto, [m]);
					if (alone.kind !== "merged") return alone;
				}
				return whole;
			}),
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
	 * batch's gates run once over them all, staged against `onto` (workflow-core#4545),
	 * `started` given the merges first where `ciRepeats` (workflow-core#4573).
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
				return judgeWhole(
					onto,
					batchPass({ onto, sha, last }, inTree, gates),
					last,
				);
			},
		);
	}

	/**
	 * `merged` judged on its whole tree's guard-registry faults, not only the
	 * ones its merges add (workflow-core#4807): a tree holding a gating one `onto` lacks is
	 * refused, naming `last`; one whose every such fault `onto` holds too is
	 * `stale-base`, which stops the line rather than drops a member, since
	 * `main` must be re-anchored first. Any other result passes through.
	 * @param {string} onto
	 * @param {MergeResult} merged
	 * @param {Member} last
	 * @returns {MergeResult}
	 */
	function judgeWhole(onto, merged, last) {
		if (merged.kind !== "merged") return merged;
		const tree = readRegistry(merged.sha);
		const gating = tree ? newFaultItems(tree, {}, REGISTRY_PROFILE) : [];
		if (!tree || gating.length === 0) return merged;
		const base = readRegistry(onto);
		const added = base ? newFaultItems(tree, base, REGISTRY_PROFILE) : gating;
		const inherited = gating.filter((f) => !added.includes(f));
		if (added.length > 0)
			return {
				kind: "refused",
				name: last.name,
				reason: `its tree holds guard-registry fault(s) ${short(onto)} does not: ${added.map((f) => f.line).join("; ")}${
					inherited.length > 0
						? `; ${short(onto)} is stale too, and must be re-anchored first: ${inherited.map((f) => f.line).join("; ")}`
						: ""
				}`,
			};
		return {
			kind: "stale-base",
			name: last.name,
			sha: merged.sha,
			onto,
			rows: gating.map((f) => f.line),
		};
	}

	/**
	 * check-guard-registry.js's --json envelope over `sha`'s tree, null where
	 * the tree carries no checker.
	 * @param {string} sha
	 * @returns {Record<string, unknown> | null}
	 */
	function readRegistry(sha) {
		return withThrowawayTree(
			root,
			sha,
			{ program: "queue-lander", use: "registry" },
			(dir) => {
				const checker = gateCopy(dir, "scripts/check-guard-registry.js");
				if (!fs.existsSync(checker)) return null;
				const r = spawnSync(
					process.execPath,
					[checker, "--root", dir, "--json"],
					{
						cwd: dir,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "pipe"],
						timeout: mergeTimeoutMs,
						maxBuffer: CHILD_MAX_BUFFER,
					},
				);
				return readEnvelope(r, sha, mergeTimeoutMs);
			},
		);
	}

	/**
	 * The batch's one gate pass over every member's merge `sha` staged against
	 * `onto`, then back on `sha`, committing what the gates staged, as a
	 * member's own commit took its hook's edits (workflow-core#4545). A refusal names
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
				/* Fails open as git does on a hook it cannot run (workflow-core#4545). */
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
	 * gates' index, the anchors a merge carries among them (workflow-core#4514), is what
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
		for (const [file, { generator }] of regenerated) {
			/* Absent: the merge deleted it, and a deletion stands. */
			if (!fs.existsSync(path.join(dir, file))) continue;
			execFileSync(process.execPath, [gateCopy(dir, generator)], {
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

/**
 * A ledger row's time in ms, the epoch where it has none readable, so a
 * no-run red of unknown age is asked again rather than trusted (workflow-core#4572).
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
	queueGit,
	queueLogger,
	refusedRecord,
	verdictLedger,
};
