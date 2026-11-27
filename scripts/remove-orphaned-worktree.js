#!/usr/bin/env node

const path = require("node:path");
const { isListedLive } = require("./lib/agent-liveness");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args");
const { deref } = require("./lib/deref.js");
const { gitRead } = require("./lib/dirty-tree.js");
const { gh, parseErrLine } = require("./lib/gh.js");
const { gitCommonDir, GIT_TIMEOUT_MS, spawnGitSync } = require("./lib/git.js");
const { adoptHostRoot } = require("./lib/host-root.js");
const { countUnlandedCommits, readLanded } = require("./lib/landed-edit.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { readProcesses } = require("./lib/checkout-repo.js");
const { isDepLink, unlinkDepLink } = require("./lib/dep-store.js");
const {
	deletedPaths,
	judgeContents,
	judgeRegistration,
	judgedFiles,
	pairBlobs,
	parseStatus,
	presentEntries,
	buildRefusedMessage,
} = require("./lib/orphaned-worktree-refusals.js");
const { requiredGroup } = require("./lib/regex-group.js");
const {
	buildWaysOut,
	dropWorktreeFilings,
	readWorktreeRefs,
} = require("./lib/orphan-filings.js");
const { readOwnedByLive, treeOfKey } = require("./lib/orphan-owners.js");
const { procRoot } = require("./lib/proc-root.js");
const { recordOwnAct } = require("./lib/own-acts.js");
const { scriptPath } = require("./lib/script-path.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { worktreeLabel, worktreeOwners } = require("./lib/session-worktrees.js");
const { releaseOwnClaim, scriptIo } = require("./lib/tracker-ops.js");
const { readLinkedWorktrees } = require("./lib/worktree-paths.js");

const LANDED_REF = VERIFIED_REF;
const USAGE = `usage: node ${scriptPath("remove-orphaned-worktree.js")} <dir>`;

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("remove-orphaned-worktree");

/**
 * @param {string} target
 * @returns {string|null}
 */
function readRawStatus(target) {
	return gitRead(
		[
			"--no-optional-locks",
			"status",
			"--porcelain=v2",
			"-z",
			"--untracked-files=all",
			"--",
			".",
			...(isDepLink(target) ? [":(top,exclude)node_modules"] : []),
		],
		target,
	);
}

/**
 * @param {string} target
 * @param {string} spec
 */
const isResolvable = (target, spec) =>
	Boolean(gitRead(["rev-parse", "--verify", "-q", spec], target));

/**
 * @param {string} target
 * @param {import("./lib/orphaned-worktree-refusals.js").Entry[]} present
 * @returns {string[]|null}
 */
function hashFiles(target, present) {
	if (present.length === 0) return [];
	const ids = gitRead(
		["hash-object", "--stdin-paths"],
		target,
		undefined,
		`${present.map((e) => e.rel).join("\n")}\n`,
	);
	return ids === null ? null : ids.split("\n");
}

/** @returns {import("./lib/orphaned-worktree-refusals.js").Processes} */
function readProcessCwds() {
	try {
		return readProcesses(procRoot()).map((p) => ({
			pid: p.pid,
			cwd: deref(p.cwd),
		}));
	} catch (e) {
		return { error: caught(e).message };
	}
}

/**
 * @param {string} target
 * @returns {import("./lib/orphaned-worktree-refusals.js").Ownership}
 */
function readOwnership(target) {
	const live = readOwnedByLive();
	if (!live.owned) return { why: live.why };
	const { owners, unread } = worktreeOwners([target], live.listed);
	const found = owners.get(target);
	return {
		ownedTrees: [...live.owned].map((key) => deref(treeOfKey(key))),
		unread,
		owner: found
			? {
					sessionId: found.sessionId,
					name: found.name,
					live: isListedLive(
						found.sessionId,
						live.listed.ids,
						live.listed.terminal,
					),
				}
			: null,
	};
}

/**
 * @param {string} target
 * @returns {Promise<import("./lib/orphaned-worktree-refusals.js").Contents>}
 */
async function readContents(target) {
	const raw = readRawStatus(target);
	const status = raw === null ? null : parseStatus(raw);
	const blobs = status ? hashFiles(target, presentEntries(status)) : [];
	const files =
		status && blobs ? pairBlobs(presentEntries(status), blobs) : null;
	return {
		target,
		ref: LANDED_REF,
		commits: isResolvable(target, LANDED_REF)
			? { unlanded: countUnlandedCommits(target, LANDED_REF) }
			: { unresolved: true },
		status,
		keptOnRef: status
			? deletedPaths(status).filter((rel) =>
					isResolvable(target, `${LANDED_REF}:${rel}`),
				)
			: [],
		files,
		landed: files
			? (await readLanded(target, judgedFiles(files), LANDED_REF)).map(Boolean)
			: [],
		processes: readProcessCwds(),
		selfPid: String(process.pid),
		ownership: readOwnership(target),
	};
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {Promise<string[]>}
 */
async function readRefusals(root, target) {
	const unregistered = judgeRegistration({
		root,
		mainRoot: deref(root),
		target,
		cwd: deref(process.cwd()),
		linked: readLinkedWorktrees(root),
	});
	if (unregistered) return [unregistered];
	return judgeContents(await readContents(target));
}

/**
 * @param {string} root
 * @param {string} target
 */
function removeWorktree(root, target) {
	unlinkDepLink(target);
	const r = spawnGitSync(["worktree", "remove", "--force", target], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(`git worktree remove exited ${r.status}: ${r.stderr}`);
}

const ISSUE_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/;

/**
 * @param {string} ref
 * @param {string} target
 * @returns {0|1}
 */
function closeFiling(ref, target) {
	const m = ISSUE_URL.exec(ref);
	if (!m) {
		io.warn(
			`its orphaned-edit filing ${ref} is no issue URL — close it by hand.`,
		);
		return 1;
	}
	const repo = requiredGroup(m, 1, ISSUE_URL);
	const n = requiredGroup(m, 2, ISSUE_URL);
	const comment = `Removed \`${target}\` with \`${scriptPath("remove-orphaned-worktree.js")}\`: its \`HEAD\` and every change in it were on \`${LANDED_REF}\`, nothing untracked stood in it, and no live process or session held it.`;
	try {
		gh([
			"issue",
			"close",
			n,
			"--repo",
			repo,
			"--reason",
			"completed",
			"--comment",
			comment,
		]);
		const state = gh([
			"issue",
			"view",
			n,
			"--repo",
			repo,
			"--json",
			"state",
			"-q",
			".state",
		]);
		if (String(state).trim() !== "CLOSED")
			throw new Error(`it reads back as ${String(state).trim()}`);
	} catch (e) {
		io.warn(
			`the worktree is gone, but closing ${ref} failed (${parseErrLine(e)}) — close it by hand.`,
		);
		return 1;
	}
	recordOwnAct("close", repo, Number(n));
	io.out(`${ref}: closed as completed.\n`);
	return releaseOwnClaim(io, Number(n)) === 0 ? 0 : 1;
}

async function main() {
	const { positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		min: 1,
		max: 1,
	});
	const root = adoptHostRoot();
	const [given] = positionals;
	if (given === undefined) return io.fail(USAGE, 2);
	const target = deref(path.resolve(given));
	const refusals = await readRefusals(root, target);
	if (refusals.length > 0)
		io.fail(
			buildRefusedMessage(target, refusals, {
				status: `git -C ${shellQuote(target)} status`,
				land: buildWaysOut(target).land,
			}),
			1,
		);
	const common = gitCommonDir(root, { timeout: GIT_TIMEOUT_MS });
	const label = worktreeLabel(root, target);
	const filed = common ? readWorktreeRefs(common, label) : [];
	try {
		removeWorktree(root, target);
	} catch (e) {
		io.fail(`removing ${target} failed: ${caught(e).message.trim()}`, 1);
	}
	io.out(`${target}: removed.\n`);
	if (common) dropWorktreeFilings(common, label);
	if (filed.length === 0) {
		io.out("No orphaned-edit filing names it, so no issue was closed.\n");
		return;
	}
	process.exitCode = Math.max(...filed.map((ref) => closeFiling(ref, target)));
}

module.exports = { main };
if (require.main === module)
	main().catch((e) => {
		io.fail(caught(e).message, 1);
	});
