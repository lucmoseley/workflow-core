/*
 * queue-lander-adapters.js — the production adapters lib/queue-lander.js
 * runs on (#4485, spec #4458): its git against lib/landing-refs.js's remote,
 * and its verdict ledger and batch record files.
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
} = require("./lander.js");
const {
	LANDER_BATCH_BRANCH,
	QUEUE_PREFIX,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");
const { queueLogFile, readEnqueueTimes } = require("./queue-log.js");
const { TransientFault } = require("./queue-lander.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");

/* Untraced, a first guess and stated as one: a verdict is read again only
 * for a batch a run resumes, which waits hours, never weeks. */
const VERDICT_RETAIN_MS = 14 * DAY_MS;
const QUEUE_HEADS = `refs/heads/${QUEUE_PREFIX}`;
/* git push's words for a compare-and-delete refused because the ref moved. */
const STALE = /\(stale info\)/;
const GONE = /remote ref does not exist/;
const PHASES = ["merging", "testing", "landed"];
/* Git's words for a loose object a crash left empty or torn, naming its file
 * by its fan-out directory and name. */
const BROKEN_OBJECT =
	/(?:object file|stored in) \S*?([0-9a-f]{2})\/([0-9a-f]{38,62})\)? is (?:empty|corrupt)/;

/**
 * @typedef {import("./lander.js").Verdict} Verdict
 * @typedef {import("./queue-lander.js").Batch} Batch
 * @typedef {import("./queue-lander.js").Member} Member
 * @typedef {import("./queue-lander.js").MergeResult} MergeResult
 * @typedef {import("./queue-lander.js").QueueGit} QueueGit
 * @typedef {import("./queue-lander.js").QueueRef} QueueRef
 * @typedef {import("./queue-lander.js").VerdictLedger} VerdictLedger
 * @typedef {import("./queue-lander.js").BatchRecord} BatchRecord
 */

/**
 * @param {string} root the canonical checkout's root
 */
function queueLanderFiles(root) {
	const dir = markersDir(root);
	return {
		verdicts: path.join(dir, ".queue-lander-verdicts.jsonl"),
		batch: path.join(dir, ".queue-lander-batch.json"),
		/* Its own, as the landing lander's carries that lander's hold and red
		 * batch to its next run. */
		heartbeat: path.join(dir, ".queue-lander-heartbeat.json"),
	};
}

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
		`+${QUEUE_HEADS}*:refs/remotes/${REMOTE}/${QUEUE_PREFIX}*`,
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
					[mainRef, `${QUEUE_HEADS}*`],
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
				return { main: heads.get(mainRef) ?? null, queue };
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
		pushMain(sha) {
			pushRemote(root, [`${sha}:refs/heads/${VERIFIED_BRANCH}`]);
		},
		deleteRef(name, sha) {
			const ref = `${QUEUE_HEADS}${name}`;
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
	};

	/**
	 * Why `m` did not merge, else null. A fault that is no git refusal, a
	 * spawn failure among them, throws for the run to retry.
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
				return {
					kind: "refused",
					name: m.name,
					reason: `its merge timed out after ${mergeTimeoutMs / 1000} s`,
				};
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

/** @param {unknown} files @returns {files is string[]} */
const isFileList = (files) =>
	Array.isArray(files) && files.every((f) => typeof f === "string");

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
	if (o?.kind === "red" && isFileList(o.files))
		return { kind: "red", files: o.files };
	return null;
}

/** @param {readonly string[]} files */
const fileKey = (files) => [...files].sort().join("\n");

/**
 * The verdict ledger: one JSON line per green or red reached, by sha and the
 * files it ran, the whole suite being none. The newest line for a sha and
 * file set is its verdict. A line lost to an unwritable file costs a rerun,
 * never a landing.
 * @param {string} file
 * @returns {VerdictLedger}
 */
function verdictLedger(file) {
	return {
		get(sha, files) {
			const key = fileKey(files);
			const rows = readJsonl(file)?.rows ?? [];
			for (const row of rows.toReversed()) {
				if (row.sha !== sha || !isFileList(row.files)) continue;
				if (fileKey(row.files) !== key) continue;
				const v = parseVerdict(row.verdict);
				if (v) return v;
			}
			return null;
		},
		add(sha, files, v) {
			appendRetained(
				file,
				{
					at: new Date(now()).toISOString(),
					sha,
					files: [...files].sort(),
					verdict: v,
				},
				VERDICT_RETAIN_MS,
			);
		},
	};
}

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
 * The batch record: the batch a run is landing, so the next run resumes it.
 * A record that is absent or not a batch reads as none.
 * @param {string} file
 * @returns {BatchRecord}
 */
function batchRecord(file) {
	return {
		read() {
			let parsed;
			try {
				parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch (err) {
				if (caught(err).code === "ENOENT" || err instanceof SyntaxError)
					return null;
				throw err;
			}
			const b = /** @type {Record<string, unknown>|null} */ (
				parsed !== null && typeof parsed === "object" ? parsed : null
			);
			if (
				!b ||
				!Array.isArray(b.members) ||
				!b.members.every(isMember) ||
				typeof b.onto !== "string" ||
				!(b.integration === null || typeof b.integration === "string") ||
				typeof b.phase !== "string" ||
				!PHASES.includes(b.phase)
			)
				return null;
			return {
				members: b.members,
				onto: b.onto,
				integration: b.integration,
				phase: /** @type {Batch["phase"]} */ (b.phase),
			};
		},
		write(b) {
			writeFileAtomic(file, `${JSON.stringify(b)}\n`);
		},
	};
}

module.exports = { batchRecord, queueGit, queueLanderFiles, verdictLedger };
