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
	HOOK_GRACE_MS,
	KILLED_EXIT,
	RUN_BUDGETED,
	TIMEOUT_EXIT,
	isRunnerFailure,
} = require("./run-budgeted.js");
const {
	GATED_COMMIT_TIMEOUT_MS,
	createRemoteRef,
	deleteRemoteRef,
	isAncestor,
	parseGateRefusal,
	parseRefusal,
	pushRemote,
	readConflictedFiles,
	readGit,
	readRemoteHeads,
	short,
	withThrowawayTree,
} = require("./lander-git.js");
const {
	DROPPED_PREFIX,
	isQueueHead,
	queueBranch,
	queueHead,
	queueNameOf,
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
const { TransientFault, fileSetKey } = require("./queue-lander.js");
const { REGENERATED_FILES } = require("./regenerated-files.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { isStringList, parseVerdict } = require("./lander-records.js");
const { isCoreHost } = require("./plugin-state.js");
const { CoreUnresolved, resolveTreeCore } = require("./tree-core.js");

const REGISTRY_PROFILE = (() => {
	const profile = PROFILES["guard-registry"];
	if (!profile)
		throw new Error("lib/fault-profiles.js carries no guard-registry profile");
	return profile;
})();

// guess, #4485
const VERDICT_RETAIN_MS = 14 * DAY_MS;
const DROPPED_HEADS = `refs/heads/${DROPPED_PREFIX}`;
const REMOTE_REJECTED = /^ ! \[remote rejected\].*/m;
const REJECTED_REF = /^ ! \[(?:remote )?rejected\]\s+\S+ -> (\S+) /gm;
const BROKEN_OBJECT =
	/(?:object file|stored in) \S*?([0-9a-f]{2})\/([0-9a-f]{38,62})\)? is (?:empty|corrupt)/;

/** @typedef {"merge" | "batch" | "tested" | "all"} GateSet */

// guess, #5308
const PIPE_CLOSE_MARGIN_MS = 10_000;

class GateTimeout extends Error {}

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
 * @typedef {{dir: string,
 *   inTree: (args: string[], timeout?: number) => string,
 *   gates: (set: "merge") => void,
 *   gateCopy: (rel: string) => string}} MergeTree
 */

/**
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
	if (envelope.outcome === "SKIP") {
		writeFd(
			2,
			`queue-lander: ${over} skipped, so no guard-registry fault was judged: ${envelope.summary}\n`,
		);
		return null;
	}
	if (envelope.outcome === "BROKEN")
		throw new Error(`${over} could not judge it: ${envelope.summary}`);
	return envelope;
}

/**
 * @param {string} root
 * @param {object} [options]
 * @param {number} [options.mergeTimeoutMs]
 * @param {ReadonlyMap<string, Regenerated>} [options.regenerated]
 * @param {boolean} [options.ciRepeats]
 * @param {number} [options.gateGraceMs]
 * @param {boolean} [options.suiteRepeats]
 * @returns {QueueGit}
 */
function queueGit(
	root,
	{
		mergeTimeoutMs = GATED_COMMIT_TIMEOUT_MS,
		regenerated = REGENERATED_FILES,
		ciRepeats = false,
		suiteRepeats = false,
		gateGraceMs = HOOK_GRACE_MS,
	} = {},
) {
	const batchSet = batchGateSet(ciRepeats, suiteRepeats);
	/**
	 * @param {string} dir
	 * @returns {(rel: string) => string}
	 */
	const gateCopies = (dir) => {
		/** @type {string | undefined} */
		let core;
		return (rel) => {
			core ??= isCoreHost(dir) ? dir : resolveCoreOf(dir);
			return path.join(core, rel);
		};
	};
	/** @param {string} dir */
	const resolveCoreOf = (dir) => {
		try {
			return resolveTreeCore(dir, mergeTimeoutMs);
		} catch (err) {
			if (caught(err).code !== "ETIMEDOUT") throw err;
			throw new TransientFault(
				`resolving its tree's workflow-core timed out after ${mergeTimeoutMs / 1000} s`,
				{ cause: err },
			);
		}
	};
	const fetchSpecs = [
		trackingRefspec(VERIFIED_BRANCH),
		QUEUE_REFSPEC,
		`+${DROPPED_HEADS}*:refs/remotes/${REMOTE}/${DROPPED_PREFIX}*`,
	];
	/**
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
					isQueueHead(ref) ? [{ ref, sha }] : [],
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
					return { name: queueNameOf(ref), sha, pushedAt };
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
				for (const m of members) {
					const alone = mergeGated(onto, [m]);
					if (alone.kind !== "merged") return alone;
				}
				return whole;
			}),
		pushMain(sha, leases) {
			const leasing = leases.flatMap((l) => {
				const ref = `refs/heads/${queueBranch(l.name)}`;
				return [`--force-with-lease=${ref}:${l.sha}`, `${l.sha}:${ref}`];
			});
			try {
				pushRemote(root, [
					"--atomic",
					...leasing,
					`${sha}:refs/heads/${VERIFIED_BRANCH}`,
				]);
				return { kind: "pushed" };
			} catch (err) {
				if (!(err instanceof PushRefused)) throw err;
				const stderr = String(err.stderr ?? "");
				const rejected = new Set(
					[...stderr.matchAll(REJECTED_REF)].map((m) => m[1]),
				);
				const lost = leases
					.filter((l) => rejected.has(queueBranch(l.name)))
					.map((l) => l.name);
				if (lost.length > 0) return { kind: "lease-lost", names: lost };
				const refused = REMOTE_REJECTED.exec(stderr);
				if (refused === null) throw err;
				return { kind: "refused", line: refused[0].trim() };
			}
		},
		isAncestor: (sha, of) => isAncestor(root, sha, of),
		deleteRef: (branch, sha) => deleteRemoteRef(root, branch, sha),
		createRef: (branch, sha) => createRemoteRef(root, branch, sha),
	};

	/**
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
				const gateCopy = gateCopies(dir);
				for (const m of members) {
					const failed = mergeFailure(m, inTree, () =>
						mergeMember(m, { dir, inTree, gates, gateCopy }),
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
					gateCopy,
				);
			},
		);
	}

	/**
	 * @param {string} onto
	 * @param {MergeResult} merged
	 * @param {Member} last
	 * @param {(rel: string) => string} [gateCopy]
	 * @returns {MergeResult}
	 */
	function judgeWhole(onto, merged, last, gateCopy) {
		if (merged.kind !== "merged") return merged;
		/** @type {Record<string, unknown> | null} */
		let tree;
		try {
			tree = readRegistry(merged.sha, gateCopy);
		} catch (err) {
			if (!(err instanceof CoreUnresolved)) throw err;
			return refusedWith(last.name, err);
		}
		const gating = tree ? newFaultItems(tree, {}, REGISTRY_PROFILE) : [];
		if (!tree || gating.length === 0) return merged;
		return judgeGating(onto, { sha: merged.sha, tree, gating }, last);
	}

	/**
	 * @param {string} onto
	 * @param {{sha: string, tree: Record<string, unknown>,
	 *   gating: ReturnType<typeof newFaultItems>}} whole
	 * @param {Member} last
	 * @returns {MergeResult}
	 */
	function judgeGating(onto, { sha, tree, gating }, last) {
		const base = readBaseRegistry(onto);
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
			sha,
			onto,
			rows: gating.map((f) => f.line),
		};
	}

	/** @param {string} onto */
	function readBaseRegistry(onto) {
		try {
			return readRegistry(onto);
		} catch (err) {
			if (err instanceof CoreUnresolved) return null;
			throw err;
		}
	}

	/**
	 * @param {string} sha
	 * @param {(rel: string) => string} [gateCopy]
	 * @returns {Record<string, unknown> | null}
	 */
	function readRegistry(sha, gateCopy) {
		return withThrowawayTree(
			root,
			sha,
			{ program: "queue-lander", use: "registry" },
			(dir) => {
				const checker = (gateCopy ?? gateCopies(dir))(
					"scripts/check-guard-registry.js",
				);
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
	 * @param {{onto: string, sha: string, last: Member}} batch
	 * @param {(args: string[], timeout?: number) => string} inTree
	 * @param {(set: Exclude<GateSet, "merge">) => void} gates
	 * @returns {MergeResult}
	 */
	function batchPass({ onto, sha, last }, inTree, gates) {
		inTree(["reset", "--quiet", "--soft", onto]);
		const failed = mergeFailure(last, inTree, () => gates(batchSet));
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
	 * @param {string} dir
	 * @param {(args: string[]) => string} inTree
	 * @returns {(set: GateSet) => void}
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
				writeFd(
					2,
					`queue-lander: ${hook} is not executable, so no gate ran on this merge\n`,
				);
				return;
			}
			runHook(hook, set, {
				dir,
				limitMs: mergeTimeoutMs,
				graceMs: gateGraceMs,
			});
		};
	}

	/**
	 * @param {Member} m
	 * @param {MergeTree} tree
	 */
	function mergeMember(m, { dir, inTree, gates, gateCopy }) {
		try {
			inTree(
				[
					"merge",
					"--no-ff",
					"--no-commit",
					"-m",
					`Merge ${queueBranch(m.name)} at ${short(m.sha)} into the batch`,
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
		regenerate(dir, inTree, gateCopy);
		gates("merge");
		inTree(
			["-c", "core.hooksPath=/dev/null", "commit", "--no-edit"],
			mergeTimeoutMs,
		);
	}

	/**
	 * @param {string} dir
	 * @param {(args: string[]) => string} inTree
	 * @param {(rel: string) => string} gateCopy
	 */
	function regenerate(dir, inTree, gateCopy) {
		for (const [file, { generator }] of regenerated) {
			if (!fs.existsSync(path.join(dir, file))) continue;
			execFileSync(process.execPath, [gateCopy(generator)], {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: mergeTimeoutMs,
			});
			inTree(["add", "--", file]);
		}
	}

	/**
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
			if (err instanceof CoreUnresolved) return refusedWith(m.name, err);
			if (!(err instanceof GateTimeout)) return judgeFault(m, inTree, err);
			writeFd(
				2,
				`queue-lander: ${queueBranch(m.name)}'s merge refused: ${parseRefusal(err.message)}\n`,
			);
			return refusedWith(m.name, err);
		}
	}

	/**
	 * @param {Member} m
	 * @param {(args: string[]) => string} inTree
	 * @param {unknown} err
	 * @returns {MergeResult}
	 */
	function judgeFault(m, inTree, err) {
		const e = caught(err);
		if (e.code === "ETIMEDOUT")
			throw new TransientFault(
				`${queueBranch(m.name)}'s merge timed out after ${mergeTimeoutMs / 1000} s`,
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
					reason: parseGateRefusal(parseErrorText(err)),
				};
	}
}

/**
 * @param {string} name
 * @param {Error} err
 * @returns {MergeResult}
 */
const refusedWith = (name, err) => ({
	kind: "refused",
	name,
	reason: err.message,
});

/**
 * @param {boolean} ciRepeats
 * @param {boolean} suiteRepeats
 * @returns {Exclude<GateSet, "merge">}
 */
function batchGateSet(ciRepeats, suiteRepeats) {
	if (ciRepeats) return "batch";
	return suiteRepeats ? "tested" : "all";
}

/**
 * @param {string} hook
 * @param {GateSet} set
 * @param {{dir: string, limitMs: number, graceMs: number}} limits
 */
function runHook(hook, set, { dir, limitMs, graceMs }) {
	const gates = set === "all" ? "" : `${set} `;
	const began = performance.now();
	try {
		execFileSync(
			process.execPath,
			[
				RUN_BUDGETED,
				String(limitMs),
				String(graceMs),
				hook,
				...(gates === "" ? [] : [`--gates=${set}`]),
			],
			{
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: CHILD_MAX_BUFFER,
				timeout: limitMs + graceMs + PIPE_CLOSE_MARGIN_MS,
			},
		);
	} catch (err) {
		const e = caught(err);
		const r = { status: e.status ?? null, stderr: String(e.stderr ?? "") };
		if (isRunnerFailure(r))
			throw Object.assign(
				new Error(`${hook} did not run: ${parseRefusal(r.stderr)}`, {
					cause: err,
				}),
				{ code: /\bE[A-Z]+\b/.exec(r.stderr)?.[0] },
			);
		const overran =
			e.code === "ETIMEDOUT" ||
			((r.status === TIMEOUT_EXIT || r.status === KILLED_EXIT) &&
				performance.now() - began >= limitMs);
		if (!overran) throw err;
		const output = parseGateRefusal(`${e.stdout ?? ""}\n${r.stderr}`);
		throw new GateTimeout(
			`its ${gates}gates ran past their ${limitMs / 1000} s limit and were ended, every process they started with them; the same gates on this tree run past it again${output === "" ? "" : `:\n${output}`}`,
			{ cause: err },
		);
	}
}

/** @param {(args: string[]) => string} inTree */
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

/** @param {unknown} at */
const parseLedgerTime = (at) => Date.parse(String(at)) || 0;

/**
 * @param {string} file
 * @returns {VerdictLedger}
 */
function verdictLedger(file) {
	return {
		get(sha, files, pass = 1) {
			const key = fileSetKey(files);
			const rows = readJsonl(file)?.rows ?? [];
			for (const row of rows.toReversed()) {
				if (row.sha !== sha || !isStringList(row.files)) continue;
				if (fileSetKey(row.files) !== key || (row.pass ?? 1) !== pass) continue;
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
				{ now: () => now() },
			);
		},
	};
}

/**
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
 * @param {string} root
 * @returns {QueueLanderDeps["logQueue"]}
 */
const queueLogger = (root) => (event, m) => {
	const file = queueLogFile(root);
	const ref = queueHead(m.name);
	if (event !== "take" && readNewestEvent(file, ref, m.sha) === event) return;
	logQueueEvent(file, event, { ref, sha: m.sha, at: now() });
};

module.exports = {
	queueGit,
	queueLogger,
	refusedRecord,
	verdictLedger,
};
