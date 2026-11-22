#!/usr/bin/env node

const { execFileSync, spawnSync } = require("node:child_process");
const { execGit, gitCommonDirOrThrow, spawnGitSync } = require("./lib/git.js");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const { PROFILES } = require("./lib/fault-profiles.js");
const { parseOrCode } = require("./lib/cli-args");
const { runProgram } = require("./lib/program-scope.js");
const { newFaults } = require("./lib/fault-diff");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group");
const { caught, ignoreFailure } = require("./lib/caught.js");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { SIDE_ENV } = require("./lib/check-side.js");
const { spawnAllSync } = require("./lib/spawn-all.js");
const { parseErrorFirstLine, parseFirstLine } = require("./lib/first-line.js");
const { NOTICES } = require("./lib/shared-fault-notices.js");
const { factsAt } = require("./lib/precommit-dispatch-ports.js");
const { scriptPath } = require("./lib/script-path.js");

/**
 * @param {string} cwd
 * @returns {Record<string, string>}
 */
const checkersAt = (cwd) => {
	const fact = factsAt(cwd, writeFd);
	return Object.fromEntries(
		Object.entries(NOTICES)
			.filter(
				([profile, { facts }]) =>
					profile !== "doc-map" && facts.every((name) => fact(name)),
			)
			.map(([profile, { script }]) => [profile, script]),
	);
};

const docMapRow = NOTICES["doc-map"];
if (docMapRow === undefined) throw new Error("NOTICES has no doc-map row");
const CHECK_DOC_MAP = docMapRow.script;

const CHECKERS_ENV = "WFC_SHARED_FAULT_CHECKERS";

/**
 * @param {string} cwd
 * @returns {Record<string, string>}
 */
const checkersInForce = (cwd) => {
	const raw = process.env[CHECKERS_ENV];
	return raw ? JSON.parse(raw) : checkersAt(cwd);
};

// Node's spawn maxBuffer defaults to 1 MiB: https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options
const MAX_BUFFER = 64 * 1024 * 1024;

const LEFTOVER_ROOT_ENV = "WFC_SHARED_FAULT_TMP";

const leftoverRoot = () =>
	process.env[LEFTOVER_ROOT_ENV] ||
	path.join(os.tmpdir(), "report-new-shared-faults");

const KINDS = ["tree", "dm"];
const LEFTOVER_NAME = new RegExp(`^(${KINDS.join("|")})-(\\d+)-`);

const leftoverStem = (/** @type {string} */ kind) => `${kind}-${process.pid}-`;

/** @returns {{ kind: string, pid: number } | null} */
function parseLeftover(/** @type {string} */ base) {
	const m = LEFTOVER_NAME.exec(base);
	return m
		? {
				kind: requiredGroup(m, 1, LEFTOVER_NAME),
				pid: Number(requiredGroup(m, 2, LEFTOVER_NAME)),
			}
		: null;
}

const STALE_MS = 24 * 60 * 60 * 1000;

function isStale(
	/** @type {{ pid: number }} */ parsed,
	/** @type {number} */ mtimeMs,
) {
	return !pidAlive(parsed.pid) || Date.now() - mtimeMs > STALE_MS;
}

function sweepTrees() {
	const root = leftoverRoot();
	for (const base of fs.readdirSync(root)) {
		const dir = path.join(root, base);
		ignoreFailure(() => {
			const parsed = parseLeftover(base);
			if (parsed?.kind !== "tree") return;
			if (!isStale(parsed, fs.statSync(dir).mtimeMs)) return;
			fs.rmSync(dir, { recursive: true, force: true });
		});
	}
}

function sweepWorktrees(/** @type {string} */ cwd) {
	const admin = path.join(
		gitCommonDirOrThrow(cwd, { stdio: ["ignore", "pipe", "inherit"] }),
		"worktrees",
	);
	if (!fs.existsSync(admin)) return;
	const root = leftoverRoot();
	const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
	for (const id of fs.readdirSync(admin)) {
		const entry = path.join(admin, id);
		ignoreFailure(() => {
			const worktree = path.dirname(
				fs.readFileSync(path.join(entry, "gitdir"), "utf8").trim(),
			);
			const parent = path.dirname(worktree);
			if (parent !== root && parent !== realRoot) return;
			const parsed = parseLeftover(path.basename(worktree));
			if (parsed?.kind !== "dm") return;
			if (!isStale(parsed, fs.statSync(entry).mtimeMs)) return;
			if (fs.existsSync(worktree))
				execGit(["worktree", "remove", "--force", worktree], {
					cwd,
				});
			fs.rmSync(entry, { recursive: true, force: true });
		});
	}
}

function sweepLeftovers(/** @type {string} */ cwd) {
	fs.mkdirSync(leftoverRoot(), { recursive: true });
	ignoreFailure(() => sweepWorktrees(cwd));
	ignoreFailure(sweepTrees);
}

/** @returns {{ sha: string, parents: string[] }} */
function resolveCommit(/** @type {string} */ ref, /** @type {string} */ cwd) {
	const line = execGit(["rev-list", "--parents", "-n", "1", ref], {
		cwd,
		encoding: "utf8",
	}).trim();
	const [sha, ...parents] = line.split(/\s+/).filter(Boolean);
	if (sha === undefined)
		throw new Error(`git rev-list printed nothing for ${ref}`);
	return { sha, parents };
}

function materialise(/** @type {string} */ sha, /** @type {string} */ cwd) {
	const dir = fs.mkdtempSync(path.join(leftoverRoot(), leftoverStem("tree")));
	const tar = path.join(dir, "tree.tar");
	execGit(["archive", "--format=tar", "-o", tar, sha], { cwd });
	execFileSync("tar", ["-xf", tar, "-C", dir]);
	fs.rmSync(tar);
	return dir;
}

function parseEnvelope(
	/** @type {{ error?: Error, status: number|null, stdout: string, stderr: string }} */ r,
) {
	if (r.error) throw new Error(r.error.message);
	let parsed;
	try {
		parsed = JSON.parse(r.stdout);
	} catch (e) {
		throw new Error(
			`invalid --json (exit ${r.status}): ${parseErrorFirstLine(e)}` +
				(r.stderr ? ` — ${parseFirstLine(r.stderr)}` : ""),
			{ cause: e },
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`not a --json envelope object (exit ${r.status})`);
	return parsed;
}

/**
 * @param {string} checker
 * @param {string} root
 * @param {"index" | "baseline"} side
 * @returns {import("./lib/spawn-all.js").Job}
 */
const envelopeJob = (checker, root, side) => ({
	file: process.execPath,
	args: [checker, "--root", root, "--json"],
	env: { ...process.env, [SIDE_ENV]: side },
});

function readDocMapEnvelope(
	/** @type {string} */ sha,
	/** @type {string} */ cwd,
) {
	const dir = path.join(
		leftoverRoot(),
		`${leftoverStem("dm")}${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	execGit(["worktree", "add", "--detach", "--quiet", dir, sha], {
		cwd,
	});
	try {
		const envelope = parseEnvelope(
			spawnSync(
				process.execPath,
				[
					CHECK_DOC_MAP,
					path.join(dir, "docs", "doc-map.md"),
					"--data-dir",
					path.join(dir, "docs"),
					"--json",
				],
				{ cwd: dir, encoding: "utf8", maxBuffer: MAX_BUFFER },
			),
		);
		if (envelope.outcome === "BROKEN")
			throw new Error(
				typeof envelope.summary === "string"
					? envelope.summary
					: `check-doc-map.js reported BROKEN at ${sha}`,
			);
		return envelope;
	} finally {
		execGit(["worktree", "remove", "--force", dir], { cwd });
	}
}

/**
 * @param {string} sha
 * @param {string} cwd
 * @returns {boolean}
 */
function hasDocMap(sha, cwd) {
	return (
		spawnGitSync(["cat-file", "-e", `${sha}:docs/doc-map.md`], {
			cwd,
			encoding: "utf8",
		}).status === 0
	);
}

/**
 * @param {{ sha: string, parent: string, err: string[], byProfile: Map<string, string[]> }} ctx
 * @param {string} profile
 * @param {() => Record<string, unknown>} readStaged
 * @param {() => Record<string, unknown>} readBaseline
 * @returns {boolean}
 */
function diffProfile(ctx, profile, readStaged, readBaseline) {
	const { sha, parent, err, byProfile } = ctx;
	const diffing = PROFILES[profile];
	if (diffing === undefined)
		throw new Error(`lib/fault-profiles.js has no profile ${profile}`);
	let staged;
	let baseline;
	try {
		staged = readStaged();
	} catch (e) {
		err.push(
			`report-new-shared-faults: ${profile} — could not read ${sha}'s --json: ${caught(e).message}`,
		);
		return true;
	}
	try {
		baseline = readBaseline();
	} catch (e) {
		err.push(
			`report-new-shared-faults: ${profile} — could not read ${parent}'s --json: ${caught(e).message}`,
		);
		return true;
	}
	for (const line of newFaults(staged, baseline, diffing)) {
		if (!byProfile.has(profile)) byProfile.set(profile, []);
		/** @type {string[]} */ (byProfile.get(profile)).push(line);
	}
	return false;
}

/**
 * @param {{ sha: string, parent: string, shaDir: string, parentDir: string, cwd: string, err: string[] }} trees
 * @returns {{ broken: boolean, byProfile: Map<string, string[]> }}
 */
function collectNewFaults(trees) {
	const { sha, parent, shaDir, parentDir, cwd, err } = trees;
	let broken = false;
	/** @type {Map<string, string[]>} */
	const byProfile = new Map();
	const ctx = { sha, parent, err, byProfile };

	const checkers = Object.entries(checkersInForce(cwd));
	/** @type {import("./lib/spawn-all.js").JobResult[]} */
	let results = [];
	try {
		results = spawnAllSync(
			checkers.flatMap(([, checker]) => [
				envelopeJob(checker, shaDir, "index"),
				envelopeJob(checker, parentDir, "baseline"),
			]),
		);
	} catch (e) {
		err.push(
			`report-new-shared-faults: could not run the checkers — ${caught(e).message}`,
		);
		broken = true;
	}
	if (results.length > 0)
		checkers.forEach(([profile], i) => {
			const index = results[2 * i];
			const baseline = results[2 * i + 1];
			if (index === undefined || baseline === undefined)
				throw new Error(
					`spawn-all.js returned ${results.length} results for ${2 * checkers.length} jobs`,
				);
			if (
				diffProfile(
					ctx,
					profile,
					() => parseEnvelope(index),
					() => parseEnvelope(baseline),
				)
			)
				broken = true;
		});

	if (
		hasDocMap(sha, cwd) &&
		hasDocMap(parent, cwd) &&
		diffProfile(
			ctx,
			"doc-map",
			() => readDocMapEnvelope(sha, cwd),
			() => readDocMapEnvelope(parent, cwd),
		)
	)
		broken = true;
	return { broken, byProfile };
}

/**
 * @param {string} sha
 * @param {Map<string, string[]>} byProfile
 * @returns {{ count: number, lines: string[] }}
 */
function noticeOf(sha, byProfile) {
	const count = [...byProfile.values()].reduce((n, l) => n + l.length, 0);
	/** @type {string[]} */
	const out = [];
	if (!count) return { count, lines: out };
	out.push(
		`report-new-shared-faults: ${sha} added ${count} whole-repo fault${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not in its parent.`,
		"  This REPORTS and never blocks.",
	);
	for (const [profile, lines] of byProfile) {
		const notice = NOTICES[profile];
		if (notice === undefined)
			throw new Error(`NOTICES has no row for profile ${profile}`);
		const { why, cost, full } = notice;
		out.push(`  ${profile} (${why}) — a red here ${cost}:`);
		for (const line of lines) out.push(`    ${line}`);
		out.push(`    In full, WARNs and context included: ${full}`);
	}
	out.push(
		`  Re-read this notice after a later commit: node ${scriptPath("report-new-shared-faults.js")} ${sha}`,
	);
	return { count, lines: out };
}

/**
 * @param {string} ref
 * @param {string} cwd
 * @returns {{ code: number, out: string[], err: string[] }}
 */
function run(ref, cwd) {
	/** @type {string[]} */
	const out = [];
	/** @type {string[]} */
	const err = [];

	sweepLeftovers(cwd);

	let sha;
	let parents;
	try {
		({ sha, parents } = resolveCommit(ref, cwd));
	} catch (e) {
		err.push(
			`report-new-shared-faults: ${ref} does not resolve to a commit — ${parseErrorFirstLine(e)}`,
		);
		return { code: 2, out, err };
	}

	const [parent, ...otherParents] = parents;
	if (parent === undefined) {
		out.push(
			`report-new-shared-faults: ${sha} has no parent (initial commit) — nothing to compare.`,
		);
		return { code: 0, out, err };
	}
	const merge = otherParents.length > 0;

	let shaDir;
	let parentDir;
	try {
		shaDir = materialise(sha, cwd);
		parentDir = materialise(parent, cwd);
	} catch (e) {
		if (shaDir) fs.rmSync(shaDir, { recursive: true, force: true });
		err.push(
			`report-new-shared-faults: could not materialise a tree — ${parseErrorFirstLine(e)}`,
		);
		return { code: 2, out, err };
	}

	try {
		if (merge)
			out.push(
				`report-new-shared-faults: ${sha} is a merge — compared against its first parent ${parent} only.`,
			);

		const { broken, byProfile } = collectNewFaults({
			sha,
			parent,
			shaDir,
			parentDir,
			cwd,
			err,
		});
		const { count, lines } = noticeOf(sha, byProfile);
		out.push(...lines);
		let code = 0;
		if (broken) code = 2;
		else if (count) code = 1;
		return { code, out, err };
	} finally {
		fs.rmSync(shaDir, { recursive: true, force: true });
		fs.rmSync(parentDir, { recursive: true, force: true });
	}
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function exitCode(argv) {
	const parsed = parseOrCode(argv, {
		usage: `usage: node ${scriptPath("report-new-shared-faults.js")} [<sha>]   (default HEAD)`,
		max: 1,
	});
	if (typeof parsed === "number") return parsed;
	const ref = parsed.positionals[0] || "HEAD";
	const { code, out, err } = run(ref, hostRoot());
	if (out.length > 0) writeFd(1, `${out.join("\n")}\n`);
	if (err.length > 0) writeFd(2, `${err.join("\n")}\n`);
	return code;
}

/** @param {{ cwd: string, env: NodeJS.ProcessEnv, args: string[] }} io */
const PROGRAM = (io) => runProgram(io, () => exitCode(io.args));

module.exports = { PROGRAM };

if (require.main === module) process.exit(exitCode(process.argv.slice(2)));
