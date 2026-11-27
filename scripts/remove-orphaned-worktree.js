#!/usr/bin/env node

const fs = require("node:fs");
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
const { readProcCwd } = require("./lib/claude-sessions.js");
const {
	dropWorktreeFilings,
	readWorktreeFiling,
} = require("./lib/orphan-filings.js");
const { readOwnedByLive } = require("./lib/orphan-owners.js");
const { procRoot } = require("./lib/proc-root.js");
const { recordOwnAct } = require("./lib/own-acts.js");
const { scriptPath } = require("./lib/script-path.js");
const {
	worktreeHolding,
	worktreeLabel,
	worktreeOwners,
} = require("./lib/session-worktrees.js");
const { releaseOwnClaim, scriptIo } = require("./lib/tracker-ops.js");
const { readLinkedWorktrees } = require("./lib/worktree-paths.js");

const LANDED_REF = VERIFIED_REF;
const USAGE = `usage: node ${scriptPath("remove-orphaned-worktree.js")} <dir>`;
const NAMED_MAX = 5;

/** @type {import("./lib/tracker-ops.js").ScriptIo} */
const io = scriptIo("remove-orphaned-worktree");

/** @param {string[]} paths */
const nameSome = (paths) =>
	`${paths.slice(0, NAMED_MAX).join(", ")}${paths.length > NAMED_MAX ? `, and ${String(paths.length - NAMED_MAX)} more` : ""}`;

/**
 * @param {string} root
 * @param {string} target
 * @returns {string|null}
 */
function whyNotRegistered(root, target) {
	const linked = readLinkedWorktrees(root);
	if (linked === null)
		return `git would not list the worktrees of ${root}, so ${target} cannot be confirmed as one`;
	if (target === deref(root))
		return `${target} is the main checkout, not a linked worktree`;
	if (!linked.includes(target))
		return `${target} is not a registered worktree of ${root}`;
	if (worktreeHolding(deref(process.cwd()), [target]))
		return `${target} holds this command's own working directory`;
	return null;
}

/**
 * @param {string} target
 * @returns {string|null}
 */
function whyCommitsOff(target) {
	if (!gitRead(["rev-parse", "--verify", "-q", LANDED_REF], target))
		return `${LANDED_REF} does not resolve, so whether its HEAD has landed is unknown`;
	const n = countUnlandedCommits(target, LANDED_REF);
	if (n === null) return `git would not count its commits off ${LANDED_REF}`;
	return n > 0
		? `its HEAD has ${String(n)} commit(s) not on ${LANDED_REF}`
		: null;
}

/**
 * @typedef {{rel: string, head: string, index: string, gone: boolean}} Entry
 * @typedef {{tracked: Entry[], deleted: string[], untracked: string[],
 *   odd: string[]}} Status
 */

/**
 * @param {Status} s
 * @param {string} f
 * @param {string[]} rest
 */
function addRecord(s, f, rest) {
	if (f.startsWith("? ")) {
		s.untracked.push(f.slice(2));
		return;
	}
	const kind = f[0];
	if (kind !== "1" && kind !== "2") {
		s.odd.push(f.split(" ").pop() ?? f);
		return;
	}
	const parts = f.split(" ");
	const rel = parts.slice(kind === "1" ? 8 : 9).join(" ");
	if (kind === "2") s.deleted.push(rest.shift() ?? "");
	if (parts[2]?.startsWith("S")) {
		s.odd.push(rel);
		return;
	}
	s.tracked.push({
		rel,
		head: parts[6] ?? "",
		index: parts[7] ?? "",
		gone: (parts[1] ?? "").includes("D"),
	});
}

/**
 * @param {string} out
 * @returns {Status}
 */
function parseStatus(out) {
	/** @type {Status} */
	const s = { tracked: [], deleted: [], untracked: [], odd: [] };
	const fields = out.split("\0").filter(Boolean);
	for (let f = fields.shift(); f !== undefined; f = fields.shift())
		addRecord(s, f, fields);
	return s;
}

/**
 * @param {string} target
 * @returns {Status|null}
 */
function readStatus(target) {
	const out = gitRead(
		[
			"--no-optional-locks",
			"status",
			"--porcelain=v2",
			"-z",
			"--untracked-files=all",
			"--",
			".",
			":(top,exclude)node_modules",
		],
		target,
	);
	return out === null ? null : parseStatus(out);
}

/**
 * @param {string} target
 * @param {Status} status
 * @returns {Promise<string[]>}
 */
async function whyDirtUnlanded(target, status) {
	/** @type {string[]} */
	const why = [];
	if (status.odd.length > 0)
		why.push(
			`unmerged or submodule path(s) it cannot judge: ${nameSome(status.odd)}`,
		);
	const deleted = [
		...status.deleted,
		...status.tracked.filter((e) => e.gone).map((e) => e.rel),
	];
	const kept = deleted.filter((rel) =>
		gitRead(["rev-parse", "--verify", "-q", `${LANDED_REF}:${rel}`], target),
	);
	if (kept.length > 0)
		why.push(
			`deleted here but still on ${LANDED_REF}: ${nameSome(kept.sort())}`,
		);
	const present = status.tracked.filter((e) => !e.gone);
	const ids =
		present.length > 0
			? gitRead(
					["hash-object", "--stdin-paths"],
					target,
					undefined,
					`${present.map((e) => e.rel).join("\n")}\n`,
				)
			: "";
	if (ids === null) return [...why, "git would not hash its working files"];
	const blobs = ids.split("\n");
	const files = present.map((e, i) => ({ ...e, blob: blobs[i] ?? "" }));
	const staged = files.filter((f) => f.index !== f.head && f.index !== f.blob);
	if (staged.length > 0)
		why.push(
			`staged content that is neither HEAD's nor the working copy's: ${nameSome(staged.map((f) => f.rel))}`,
		);
	const judged = files.filter((f) => f.blob !== f.head);
	const landed = await readLanded(target, judged, LANDED_REF);
	const unlanded = judged.filter((_, i) => !landed[i]).map((f) => f.rel);
	if (unlanded.length > 0)
		why.push(
			`changed and not on ${LANDED_REF}'s history: ${nameSome(unlanded)}`,
		);
	if (status.untracked.length > 0)
		why.push(`untracked file(s) not gitignored: ${nameSome(status.untracked)}`);
	return why;
}

/**
 * @param {string} target
 * @returns {string|null}
 */
function whyProcessInside(target) {
	let pids;
	try {
		pids = fs.readdirSync(procRoot()).filter((p) => /^\d+$/.test(p));
	} catch (e) {
		return `the process table would not read (${caught(e).message}), so a process inside it cannot be ruled out`;
	}
	const inside = pids.filter((pid) => {
		if (pid === String(process.pid)) return false;
		const cwd = readProcCwd(pid);
		return (
			cwd !== null &&
			worktreeHolding(deref(cwd.replace(/ \(deleted\)$/, "")), [target]) !==
				null
		);
	});
	return inside.length > 0
		? `process(es) ${nameSome(inside)} have their working directory inside it`
		: null;
}

/**
 * @param {string} target
 * @returns {string|null}
 */
function whyLiveOwner(target) {
	const live = readOwnedByLive();
	if (!live.owned)
		return `${live.why}, so whether a live session owns it is unknown`;
	const held = [...live.owned].filter(
		(key) => deref(key.split("\0")[0] ?? "") === target,
	);
	if (held.length > 0)
		return `a live session claims, observed or wrote ${String(held.length)} path(s) in it`;
	const { owners, unread } = worktreeOwners([target], live.listed);
	if (unread.length > 0)
		return `job state ${nameSome(unread)} would not read, so its owner is unknown`;
	const owner = owners.get(target);
	if (
		owner &&
		isListedLive(owner.sessionId, live.listed.ids, live.listed.terminal)
	)
		return `live session ${owner.sessionId}${owner.name ? ` (${owner.name})` : ""} owns it`;
	return null;
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {Promise<string[]>}
 */
async function readRefusals(root, target) {
	const unregistered = whyNotRegistered(root, target);
	if (unregistered) return [unregistered];
	const status = readStatus(target);
	const why = [
		whyCommitsOff(target),
		...(status === null
			? ["git status would not list its paths"]
			: await whyDirtUnlanded(target, status)),
		whyProcessInside(target),
		whyLiveOwner(target),
	];
	return why.filter((w) => w !== null);
}

/**
 * @param {string} root
 * @param {string} target
 */
function removeWorktree(root, target) {
	const link = path.join(target, "node_modules");
	if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink())
		fs.unlinkSync(link);
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
	const [, repo = "", n = ""] = m;
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
	const target = deref(path.resolve(positionals[0] ?? ""));
	const refusals = await readRefusals(root, target);
	if (refusals.length > 0)
		io.fail(
			`refused, nothing removed — ${target}:\n${refusals.map((r) => `  - ${r}`).join("\n")}`,
			1,
		);
	const common = gitCommonDir(root, { timeout: GIT_TIMEOUT_MS });
	const label = worktreeLabel(root, target);
	const filed = common ? readWorktreeFiling(common, label) : null;
	try {
		removeWorktree(root, target);
	} catch (e) {
		io.fail(`removing ${target} failed: ${caught(e).message.trim()}`, 1);
	}
	io.out(`${target}: removed.\n`);
	if (common) dropWorktreeFilings(common, label);
	if (filed === null) {
		io.out("No orphaned-edit filing names it, so no issue was closed.\n");
		return;
	}
	process.exitCode = closeFiling(filed, target);
}

module.exports = { main };
if (require.main === module)
	main().catch((e) => {
		io.fail(caught(e).message, 1);
	});
