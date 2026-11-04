#!/usr/bin/env node
/*
 * write-review-marker.js — write this session's `.codereview-pass-<sid>`
 * marker, only once the review it vouches for has left its artefacts (#2040).
 *
 *   node scripts/write-review-marker.js --base <rev> --findings <n>
 *     [--no-spec] [--skipped deletion|rename]
 *     [--tier escalated|mission-critical --areas <a,b>]
 *     [--paths <p,q> [--patch <file>]]
 *
 * A session told to write the marker lines itself looks, to the auto-mode
 * classifier, like an agent forging its own gate stamp, and is refused; this
 * script is the narrow command an allow rule can name instead.
 *
 * Refuses, writing nothing, unless `.claude/tmp/review-standards-<sid8>.md`
 * and `.claude/tmp/review-spec-<sid8>.md` both exist and are non-empty —
 * the Artefact paths the code-review skill gives its two axes. `--tier`
 * adds the runs that tier dispatches: the focus artefact, and at
 * mission-critical the attack artefact. `--no-spec` drops the spec artefact.
 * `--skipped` is the pure-deletion or mechanical-rename route, which runs no
 * review.
 *
 * `--paths` writes both `paths=` and its `tree=`, as the review hold rejects
 * a marker holding one without the other. Under `--patch` it names the patched
 * files too, and the tree is built with those left to the patch.
 *
 * FROM A LINKED WORKTREE (#3714), `--base`, `--paths` and the tree read that
 * worktree, where the commit is made, and an artefact counts in it or in the
 * host, wherever the run's working directory put it. The marker stays in the
 * host's store, which the hold, the nag and the warning read. The host is the
 * one the commit's hook is handed, so a shell with `CLAUDE_PROJECT_DIR` unset
 * finds the same store (#3830).
 *
 * AFTER A RESUME UNDER A NEW ID (#4101), an artefact also counts under a past
 * id of this session: one the refill loop's launch row names, and whose session
 * the oracle says has ended. Doubt about either counts nothing. Stderr names each
 * one taken for the session to judge.
 *
 * Joins no §N3 family: it writes a marker, not a file `generate-*` owns, and
 * its exits are its own — 0 written, 1 the write or the tree failed, 2 a
 * usage error or a refusal.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { isListedLive, listedSessionIds } = require("./lib/agent-liveness.js");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { commitSha } = require("./lib/commit-sha.js");
const { spawnGitSync } = require("./lib/git.js");
const { resolveCommitHost, worktreeRoot } = require("./lib/host-root.js");
const { markersDir } = require("./lib/marker-root.js");
const { numstatPaths } = require("./lib/patch-files.js");
const { readState } = require("./lib/refill-state.js");
const { reviewSuffix } = require("./lib/review-suffix.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE =
	"usage: node scripts/write-review-marker.js --base <rev> --findings <n> [--no-spec] [--skipped deletion|rename] [--tier escalated|mission-critical --areas <a,b>] [--paths <p,q> [--patch <file>]]";

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
 * @returns {string[]} the review axes owed
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
 * @param {string[]} roots the trees an artefact counts in
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
 * The ids session `sid` ran under before a refill-loop resume, newest first,
 * as its launch row names them.
 * @param {string} sid
 * @returns {string[]}
 */
function readPastIds(sid) {
	const { launches } = readState((line) => writeFd(2, `${line}\n`));
	const row = launches.find((l) => l.sessionId === sid);
	return [...(row?.pastSessionIds ?? [])].reverse();
}

/**
 * What past ids of `sid` cover of `axes`: the artefact taken for each axis one
 * covers, and a sentence on each id that left one but is not counted.
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
 * @param {string[]} roots the trees an artefact counts in
 * @param {string} sid
 * @param {{noSpec: boolean, tier?: string}} o
 * @returns {{missing: string[], taken: string[], uncountedNotes: string[]}} the
 *   artefacts still owed, those taken from past ids, and why any past id's are not
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
 * The files `patch` touches, which `--tree` takes from the patch and refuses
 * named whole after `--`, though `paths=` must still name them for the hold.
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
 * Each `--paths` entry in the repo-relative spelling commit-paths.js and the
 * hold's exact `paths=` match both take: `./a.js` and `scripts/` become
 * `a.js` and `scripts`. Resolved against `root`, not the cwd, as `--tree`
 * runs there. Refuses one outside the repository.
 * @param {string} root
 * @param {string[]} paths
 * @returns {string[]}
 */
function repoRelative(root, paths) {
	return paths.map((p) => {
		const rel = path.relative(root, path.resolve(root, p));
		if (rel === "" || rel.split("/")[0] === "..")
			fail(
				`--paths entry '${p}' names no file inside ${root}. Nothing written.`,
				2,
			);
		return rel;
	});
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
	const tree = String(r.stdout ?? "").trim();
	if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(tree))
		fail(
			`commit-paths.js --tree failed (exit ${r.status}): ${String(r.stderr ?? "").trim()} Nothing written.`,
			1,
		);
	return tree;
}

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
		lines.push(
			`tree=${readTreeOf(treeRoot, paths, o.patch)}`,
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
