/*
 * queue-lander-adapters.js — the production adapters lib/queue-lander.js
 * runs on (#4485, spec #4458): its git against lib/landing-refs.js's remote,
 * and its verdict ledger and batch record files.
 *
 * A production adapter (code-standards §T7): it runs git and reads and
 * writes files under the canonical checkout's markers directory,
 * machine-local and gitignored, beside the landing lander's pidfile and green
 * ledger, which the queue lander shares (lib/lander.js).
 *
 * Push order is a queue ref's tip committer time. The remote, GitHub, tells
 * git no push time (no reflog over the wire), and a session pushes its ref as
 * a fast-forward, so a later push carries a later tip. Residual: a tip
 * committed early and pushed late sorts ahead of refs pushed before it, which
 * moves only the merge order, never what is tested.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught, parseErrorText } = require("./caught.js");
const { execGit } = require("./git.js");
const { readJsonl } = require("./jsonl.js");
const {
	GATED_COMMIT_TIMEOUT_MS,
	LANDER_GIT_TIMEOUT_MS,
	parseRefusal,
	pushRemote,
	readLocalCommits,
	short,
} = require("./lander.js");
const {
	LANDER_BATCH_BRANCH,
	QUEUE_PREFIX,
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
} = require("./landing-refs.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { writeFd } = require("./write-fd.js");

/* Untraced, a first guess and stated as one: a verdict is read again only
 * for a batch a run resumes, which waits hours, never weeks. */
const VERDICT_RETAIN_MS = 14 * DAY_MS;
const QUEUE_HEADS = `refs/heads/${QUEUE_PREFIX}`;
/* git push's words for a compare-and-delete refused because the ref moved. */
const STALE = /\(stale info\)/;
const GONE = /remote ref does not exist/;
const PHASES = ["merging", "testing", "landed"];

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
 * worktree, so the checkout's own tree and branch are never touched, and
 * run its merge driver and commit hooks as any merge there does.
 * @param {string} root
 * @param {number} [mergeTimeoutMs] each member's merge, its gates included
 * @returns {QueueGit}
 */
function queueGit(root, mergeTimeoutMs = GATED_COMMIT_TIMEOUT_MS) {
	/**
	 * @param {string[]} args
	 * @param {{cwd?: string, timeout?: number}} [opts]
	 */
	const git = (args, { cwd = root, timeout = LANDER_GIT_TIMEOUT_MS } = {}) =>
		execGit(args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout,
		});
	/** @param {string} a @param {string} b */
	const isAncestor = (a, b) => {
		try {
			git(["merge-base", "--is-ancestor", a, b]);
			return true;
		} catch (err) {
			/* Exit 1 is git's no; anything else is a fault. */
			if (caught(err).status === 1) return false;
			throw err;
		}
	};
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
		refs() {
			const rows = git([
				"ls-remote",
				REMOTE,
				`refs/heads/${VERIFIED_BRANCH}`,
				`${QUEUE_HEADS}*`,
			])
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("\t"));
			const main =
				rows.find(([, ref]) => ref === `refs/heads/${VERIFIED_BRANCH}`)?.[0] ??
				null;
			const listed = rows.flatMap(([sha, ref]) =>
				sha && ref?.startsWith(QUEUE_HEADS)
					? [{ name: ref.slice(QUEUE_HEADS.length), sha }]
					: [],
			);
			const shas = [main, ...listed.map((r) => r.sha)].filter(
				(sha) => sha !== null,
			);
			if (readLocalCommits(root, shas).length < new Set(shas).size)
				git([
					"fetch",
					"--quiet",
					REMOTE,
					trackingRefspec(VERIFIED_BRANCH),
					`+${QUEUE_HEADS}*:refs/remotes/${REMOTE}/${QUEUE_PREFIX}*`,
				]);
			const times = committedAt(listed.map((r) => r.sha));
			/** @type {QueueRef[]} */
			const queue = listed.map(({ name, sha }) => {
				const pushedAt = times.get(sha);
				if (pushedAt === undefined || !Number.isFinite(pushedAt))
					throw new Error(`git log printed no committer time for ${sha}`);
				return {
					name,
					sha,
					pushedAt,
					onMain: main === null || isAncestor(main, sha),
				};
			});
			return { main, queue };
		},
		mergeMembers(onto, members) {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-lander-merge-"));
			git(["worktree", "add", "--quiet", "--detach", dir, onto]);
			try {
				for (const m of members) {
					const failed = mergeFailure(m, () =>
						git(
							[
								"merge",
								"--no-ff",
								"--no-edit",
								"-m",
								`Merge queue/${m.name} at ${short(m.sha)} into the batch`,
								m.sha,
							],
							{ cwd: dir, timeout: mergeTimeoutMs },
						),
					);
					if (failed) return failed;
				}
				return {
					kind: "merged",
					sha: git(["rev-parse", "HEAD"], { cwd: dir }).trim(),
				};
			} finally {
				try {
					git(["worktree", "remove", "--force", dir]);
				} catch (err) {
					/* Never replaces the return: a leftover worktree costs disk,
					 * and `git worktree prune` takes it once its directory goes. */
					writeFd(
						2,
						`queue-lander: could not remove the merge's worktree ${dir}: ${parseRefusal(parseErrorText(err))}\n`,
					);
				}
			}

			/**
			 * Why `m` did not merge, else null. A fault that is no git
			 * refusal, a spawn failure among them, throws for the run to retry.
			 * @param {Member} m
			 * @param {() => unknown} merge
			 * @returns {MergeResult|null}
			 */
			function mergeFailure(m, merge) {
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
					if (e.status === undefined) throw err;
					const files = git(["diff", "--name-only", "--diff-filter=U"], {
						cwd: dir,
					})
						.split("\n")
						.filter(Boolean);
					return files.length > 0
						? { kind: "conflict", name: m.name, files }
						: {
								kind: "refused",
								name: m.name,
								reason: parseRefusal(parseErrorText(err)),
							};
				}
			}
		},
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
}

/** @param {unknown} files @returns {files is string[]} */
const isFileList = (files) =>
	Array.isArray(files) && files.every((f) => typeof f === "string");

/**
 * The row's verdict where it is a green or a red, else null: a ledger line
 * is read back from disk, so its shape is checked before it is trusted.
 * @param {unknown} v
 * @returns {Verdict|null}
 */
function readVerdict(v) {
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
				const v = readVerdict(row.verdict);
				if (v) return v;
			}
			return null;
		},
		add(sha, files, v) {
			appendRetained(
				file,
				{
					at: new Date().toISOString(),
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
 * A record that is absent or not a batch reads as none, so the next run takes
 * a fresh batch and lands nothing it did not test.
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
