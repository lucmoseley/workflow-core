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
 * the Artefact paths the code-review skill gives its two axes. `--no-spec`
 * drops the spec artefact. `--skipped` is the pure-deletion or
 * mechanical-rename route, which runs no review.
 *
 * `--paths` writes both `paths=` and its `tree=`, as the review hold rejects
 * a marker holding one without the other. Under `--patch` it names the patched
 * files too, and the tree is built with those left to the patch.
 *
 * Joins no §N3 family: it writes a marker, not a file `generate-*` owns, and
 * its exits are its own — 0 written, 1 the write or the tree failed, 2 a
 * usage error or a refusal.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { commitSha } = require("./lib/commit-sha.js");
const { spawnGitSync } = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { markersDir } = require("./lib/marker-root.js");
const { numstatPaths } = require("./lib/patch-files.js");
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
 * @param {string} root
 * @param {string} sid
 * @param {boolean} noSpec
 */
function missingArtefacts(root, sid, noSpec) {
	const axes = noSpec ? ["standards"] : ["standards", "spec"];
	return axes
		.map((axis) =>
			path.join(".claude", "tmp", `review-${axis}${reviewSuffix(sid)}.md`),
		)
		.filter((rel) => {
			try {
				return fs.statSync(path.join(root, rel)).size === 0;
			} catch {
				return true;
			}
		});
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
 * The flags, checked against each other; refuses on the first fault.
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

	const root = hostRoot();
	if (o.skipped === undefined) {
		const missing = missingArtefacts(root, sid, o.noSpec);
		if (missing.length > 0)
			fail(
				`no review left its artefact at ${missing.join(" or ")}. Run the code-review skill, its axes appending to those paths, then re-run. A pure deletion or mechanical rename takes --skipped deletion|rename --findings 0 instead. Nothing written.`,
				2,
			);
	}

	const lines = [`base=${fullSha(root, o.base)}`, `findings=${o.findings}`];
	if (o.tier !== undefined)
		lines.push(`tier=${o.tier}`, `areas=${commaList(o.areas ?? "").join(",")}`);
	if (o.paths.length > 0) {
		const paths = repoRelative(root, o.paths);
		lines.push(
			`tree=${readTreeOf(root, paths, o.patch)}`,
			`paths=${paths.join(",")}`,
		);
	}

	const marker = path.join(markersDir(root), `.codereview-pass-${sid}`);
	try {
		fs.writeFileSync(marker, `${lines.join("\n")}\n`);
	} catch (e) {
		fail(`could not write ${marker} (${caught(e).message}).`, 1);
	}
	writeFd(1, `wrote ${path.relative(root, marker)}:\n${lines.join("\n")}\n`);
}

main();
