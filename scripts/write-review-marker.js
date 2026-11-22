#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const path = require("node:path");
const { isListedLive, listedSessionIds } = require("./lib/agent-liveness.js");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { FULL_SHA, commitSha } = require("./lib/commit-sha.js");
const { spawnGitSync } = require("./lib/git.js");
const { resolveCommitHost, worktreeRoot } = require("./lib/host-root.js");
const { markersDir } = require("./lib/marker-root.js");
const { numstatPaths } = require("./lib/patch-files.js");
const { readState } = require("./lib/refill-state.js");
const { reviewSuffix } = require("./lib/review-suffix.js");
const { writeFd } = require("./lib/write-fd.js");
const { relativeUnder } = require("./lib/is-under.js");

const USAGE = `usage: node ${scriptPath("write-review-marker.js")} --base <rev> --findings <n> [--no-spec] [--skipped deletion|rename] [--tier escalated|mission-critical --areas <a,b>] [--paths <p,q> [--patch <file>]]`;

const FLAGS = /** @type {const} */ ({
	"--base": "value",
	"--findings": "value",
	"--no-spec": "boolean",
	"--skipped": "value",
	"--tier": "value",
	"--areas": "value",
	"--paths": "value",
	"--patch": "value",
});

/**
 * @param {string} message
 * @param {1 | 2} code
 * @returns {never}
 */
function fail(message, code) {
	writeFd(2, `write-review-marker: ${message}\n`);
	process.exit(code);
}

/** @param {string} value */
const commaList = (value) =>
	value
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);

/**
 * @param {string} root
 * @param {string} rev
 */
function fullSha(root, rev) {
	const sha = commitSha(root, rev);
	if (sha === null)
		fail(`--base '${rev}' names no commit. Nothing written.`, 2);
	return sha;
}

/**
 * @param {{noSpec: boolean, tier?: string}} o
 * @returns {string[]}
 */
function axesOwed({ noSpec, tier }) {
	const axes = noSpec ? ["standards"] : ["standards", "spec"];
	if (tier !== undefined) axes.push("focus");
	if (tier === "mission-critical") axes.push("attack");
	return axes;
}

/**
 * @param {string} axis
 * @param {string} sid
 */
const artefactPath = (axis, sid) =>
	path.join(".claude", "tmp", `review-${axis}${reviewSuffix(sid)}.md`);

/**
 * @param {string[]} roots
 * @param {string} axis
 * @param {string} sid
 */
const hasArtefact = (roots, axis, sid) =>
	roots.some((root) => {
		try {
			return fs.statSync(path.join(root, artefactPath(axis, sid))).size > 0;
		} catch {
			return false;
		}
	});

/**
 * @param {string} sid
 * @returns {string[]}
 */
function readPastIds(sid) {
	const { launches } = readState((line) => writeFd(2, `${line}\n`));
	const row = launches.find((l) => l.sessionId === sid);
	return [...(row?.pastSessionIds ?? [])].reverse();
}

/**
 * @param {string[]} roots
 * @param {string} sid
 * @param {string[]} axes
 * @returns {{taken: Map<string, string>, uncountedNotes: string[]}}
 */
function pastCoverage(roots, sid, axes) {
	const ran = readPastIds(sid).filter((id) =>
		axes.some((axis) => hasArtefact(roots, axis, id)),
	);
	if (ran.length === 0) return { taken: new Map(), uncountedNotes: [] };
	const listed = listedSessionIds();
	if (listed.why !== undefined)
		return {
			taken: new Map(),
			uncountedNotes: [
				`Past session ${ran.join(", ")} left artefacts, but whether it has ended could not be read: ${listed.why}`,
			],
		};
	const isLive = (/** @type {string} */ id) =>
		isListedLive(id, listed.ids, listed.terminal);
	const ended = ran.filter((id) => !isLive(id));
	/** @type {Map<string, string>} */
	const taken = new Map();
	for (const axis of axes) {
		const id = ended.find((e) => hasArtefact(roots, axis, e));
		if (id !== undefined) taken.set(axis, artefactPath(axis, id));
	}
	return {
		taken,
		uncountedNotes: ran
			.filter(isLive)
			.map(
				(id) =>
					`Past session ${id} is live, so the artefacts it left are its own`,
			),
	};
}

/**
 * @param {string[]} roots
 * @param {string} sid
 * @param {{noSpec: boolean, tier?: string}} o
 * @returns {{missing: string[], taken: string[], uncountedNotes: string[]}}
 */
function readArtefacts(roots, sid, o) {
	const absent = axesOwed(o).filter((axis) => !hasArtefact(roots, axis, sid));
	if (absent.length === 0)
		return { missing: [], taken: [], uncountedNotes: [] };
	const { taken, uncountedNotes } = pastCoverage(roots, sid, absent);
	return {
		missing: absent
			.filter((axis) => !taken.has(axis))
			.map((axis) => artefactPath(axis, sid)),
		taken: [...taken.values()],
		uncountedNotes,
	};
}

/**
 * @param {string} root
 * @param {string} patch
 * @returns {Set<string>}
 */
function readPatchOrFail(root, patch) {
	const r = spawnGitSync(
		["apply", "--numstat", "-z", "--unidiff-zero", path.resolve(root, patch)],
		{ cwd: root, encoding: "utf8" },
	);
	if (r.status !== 0)
		fail(
			`git could not read the patch ${patch}: ${String(r.stderr ?? "").trim()} Nothing written.`,
			1,
		);
	return new Set(numstatPaths(String(r.stdout)));
}

/**
 * @param {string} root
 * @param {string[]} paths
 * @returns {string[]}
 */
function repoRelative(root, paths) {
	return paths.map((p) => {
		const rel = relativeUnder(root, path.resolve(root, p));
		if (!rel)
			fail(
				`--paths entry '${p}' names no file inside ${root}. Nothing written.`,
				2,
			);
		return rel;
	});
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {string} what
 * @param {string} [remedy]
 */
function treeOrFail(r, what, remedy) {
	const tree = String(r.stdout ?? "").trim();
	if (r.status !== 0 || !FULL_SHA.test(tree))
		fail(
			`${what} failed (exit ${r.status}): ${String(r.stderr ?? "").trim()}${remedy ? ` ${remedy}` : ""} Nothing written.`,
			1,
		);
	return tree;
}

/**
 * @param {string} root
 * @param {string[]} paths
 * @param {string | undefined} patch
 */
function readTreeOf(root, paths, patch) {
	const args = [path.join(__dirname, "commit-paths.js"), "--tree"];
	let whole = paths;
	if (patch) {
		args.push("--patch", patch);
		const patched = readPatchOrFail(root, patch);
		whole = paths.filter((p) => !patched.has(p));
	}
	const r = spawnSync(process.execPath, [...args, "--", ...whole], {
		cwd: root,
		encoding: "utf8",
	});
	return treeOrFail(r, "commit-paths.js --tree");
}

/** @param {string} root */
const isMerging = (root) =>
	spawnGitSync(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).status === 0;

/** @param {string} root */
const readIndexTree = (root) =>
	treeOrFail(
		spawnGitSync(["write-tree"], { cwd: root, encoding: "utf8" }),
		"git write-tree mid-merge",
		"Resolve and stage every conflicted path first.",
	);

/**
 * @param {Record<string, string | true>} flags
 */
function optionsOrFail(flags) {
	/** @param {keyof typeof FLAGS} name */
	const value = (name) => {
		const v = flags[name];
		return typeof v === "string" ? v : undefined;
	};
	const base = value("--base");
	const findings = value("--findings");
	if (base === undefined || findings === undefined)
		fail(`--base and --findings are required.\n${USAGE}`, 2);
	if (!/^\d+$/.test(findings))
		fail(`--findings is a whole number, not '${findings}'.`, 2);
	const options = {
		base,
		findings,
		skipped: value("--skipped"),
		tier: value("--tier"),
		areas: value("--areas"),
		paths: commaList(value("--paths") ?? ""),
		patch: value("--patch"),
		noSpec: flags["--no-spec"] === true,
	};
	checkRoutesOrFail(options);
	return options;
}

/**
 * @param {{findings: string, skipped?: string, tier?: string, areas?: string,
 *   paths: string[], patch?: string, noSpec: boolean}} o
 */
function checkRoutesOrFail(o) {
	const skipped = o.skipped !== undefined;
	const tiered = o.tier !== undefined;
	/** @type {[boolean, string][]} */
	const faults = [
		[
			skipped && !["deletion", "rename"].includes(String(o.skipped)),
			`--skipped is deletion or rename, not '${o.skipped}'.`,
		],
		[
			skipped && Number(o.findings) !== 0,
			"--skipped runs no review, so it takes --findings 0 only.",
		],
		[
			tiered && !["escalated", "mission-critical"].includes(String(o.tier)),
			`--tier is escalated or mission-critical, not '${o.tier}'.`,
		],
		[
			tiered !== (o.areas !== undefined),
			"--tier and --areas go together: the review hold reads both.",
		],
		[
			o.patch !== undefined && o.paths.length === 0,
			"--patch needs --paths: it shapes the tree those paths carry.",
		],
		[
			tiered && (o.noSpec || skipped),
			"a sensitive change owes both review axes, so --tier takes neither --no-spec nor --skipped.",
		],
		[
			skipped && o.paths.length > 0,
			"--skipped takes no --paths: only the review hold reads them, and it holds a sensitive change, which owes a review.",
		],
	];
	const fault = faults.find(([hit]) => hit);
	if (fault) fail(fault[1], 2);
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: FLAGS,
	});
	const sid = process.env.CLAUDE_CODE_SESSION_ID ?? "";
	if (!sid) fail("CLAUDE_CODE_SESSION_ID is not set. Nothing written.", 2);
	const o = optionsOrFail(flags);

	const host = resolveCommitHost();
	const treeRoot = worktreeRoot(undefined, { host });
	/** @type {string[]} */
	let taken = [];
	if (o.skipped === undefined) {
		const read = readArtefacts([treeRoot, host], sid, o);
		if (read.missing.length > 0)
			fail(
				`no review left its artefact at ${read.missing.join(" or ")}.${read.uncountedNotes.map((u) => ` ${u}.`).join("")} Run the code-review skill, its axes appending to those paths, then re-run. A pure deletion or mechanical rename takes --skipped deletion|rename --findings 0 instead. Nothing written.`,
				2,
			);
		taken = read.taken;
	}

	const lines = [`base=${fullSha(treeRoot, o.base)}`, `findings=${o.findings}`];
	if (o.tier !== undefined)
		lines.push(`tier=${o.tier}`, `areas=${commaList(o.areas ?? "").join(",")}`);
	if (o.paths.length > 0) {
		const paths = repoRelative(treeRoot, o.paths);
		const merging = isMerging(treeRoot);
		if (merging && o.patch !== undefined)
			fail(
				"--patch has no place mid-merge: git commits a merge whole, from the index. Drop --patch and re-run. Nothing written.",
				2,
			);
		lines.push(
			`tree=${merging ? readIndexTree(treeRoot) : readTreeOf(treeRoot, paths, o.patch)}`,
			`paths=${paths.join(",")}`,
		);
	}

	const marker = path.join(markersDir(host), `.codereview-pass-${sid}`);
	try {
		fs.writeFileSync(marker, `${lines.join("\n")}\n`);
	} catch (e) {
		fail(`could not write ${marker} (${caught(e).message}).`, 1);
	}
	writeFd(1, `wrote ${path.relative(host, marker)}:\n${lines.join("\n")}\n`);
	if (taken.length > 0)
		writeFd(
			2,
			`took ${taken.join(", ")} from this session's past id. Re-run any axis whose artefact a killed run part-wrote or that reviewed other work.\n`,
		);
}

main();
