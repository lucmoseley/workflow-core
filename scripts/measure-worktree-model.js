#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { caught } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { porcelainEntries } = require("./lib/dirty-tree.js");
const { execGit, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { landerLog } = require("./lib/lander-start.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const {
	listTranscripts,
	oneCopyEach,
	projectDirs,
} = require("./lib/project-dirs.js");
const { loopFiles } = require("./lib/refill-files.js");
const reading = require("./lib/worktree-model-reading.js");
const { worktreePaths } = require("./lib/worktree-paths.js");
const { writeFd } = require("./lib/write-fd.js");

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage:
		"usage: node scripts/measure-worktree-model.js --since <iso> [--until <iso>] [--json]",
	flags: { "--since": "value", "--until": "value", "--json": "boolean" },
};

/**
 * @typedef {import("./lib/worktree-model-reading.js").Window} Window
 * @typedef {import("./lib/worktree-model-reading.js").ReflogRow} ReflogRow
 * @typedef {import("./lib/worktree-model-reading.js").Reading} Reading
 */

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} [input]
 */
const git = (args, cwd, input) =>
	String(
		execGit(args, {
			cwd,
			input,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		}),
	);

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {boolean}
 */
function isGitYes(args, cwd) {
	try {
		git(args, cwd);
		return true;
	} catch (err) {
		if (caught(err).status === 1) return false;
		throw err;
	}
}

/**
 * @param {string} ref
 * @param {string} cwd
 * @returns {ReflogRow[]}
 */
function readReflog(ref, cwd) {
	if (!isGitYes(["reflog", "exists", ref], cwd)) return [];
	return reading.parseReflog(
		git(
			["reflog", "show", "--date=unix", "--format=%H%x09%gd%x09%gs", ref, "--"],
			cwd,
		),
	);
}

/** @param {string} out */
const parseNulList = (out) => out.split("\0").filter(Boolean);

/**
 * @param {string} file
 * @returns {AsyncIterable<string>}
 */
const readLines = (file) =>
	readline.createInterface({
		input: fs.createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});

/** @param {string} file */
async function readRecords(file) {
	/** @type {import("./lib/transcript.js").TranscriptRecord[]} */
	const records = [];
	let unparsed = 0;
	for await (const line of readLines(file)) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			unparsed++;
		}
	}
	return { records, unparsed };
}

/**
 * @param {string} root
 * @param {Window} w
 */
function readMain(root, w) {
	/** @type {Map<string, boolean>} */
	const memo = new Map();
	/** @param {string} a @param {string} b */
	const isAncestor = (a, b) => {
		const key = `${a} ${b}`;
		if (!memo.has(key))
			memo.set(key, isGitYes(["merge-base", "--is-ancestor", a, b], root));
		return memo.get(key) === true;
	};
	const all = readReflog("refs/heads/main", root);
	const rows = reading.inWindow(all, w);
	const moves = reading.inWindow(
		readReflog("refs/remotes/origin/main", root),
		w,
	);
	const tips = [...new Set([...rows.map((r) => r.sha), "main"])];
	const unlanded = git(["rev-list", ...tips, "^origin/main", "--"], root)
		.split("\n")
		.filter(Boolean);
	const lags = reading.levelLags(
		moves,
		all.filter((r) => r.t >= w.since),
		isAncestor,
		w.until,
	);
	return {
		all,
		main: {
			rows,
			moves,
			foreign: reading.foreignMainEntries(rows),
			unlanded,
			lags,
		},
	};
}

/**
 * @param {string} root
 * @param {Window} w
 */
function readReconcile(root, w) {
	const worktrees = worktreePaths((args) => git(args, root));
	const branches = git(
		["for-each-ref", "--format=%(refname)", "refs/heads/reconcile-*"],
		root,
	)
		.split("\n")
		.filter(Boolean);
	/** @type {Map<string, import("./lib/worktree-model-reading.js").ReconcileEntry>} */
	const bySha = new Map();
	for (const dir of worktrees)
		for (const r of reading.reconcileEntries(
			reading.inWindow(readReflog("HEAD", dir), w),
		))
			bySha.set(r.sha, { where: path.basename(dir), ...r });
	for (const ref of branches)
		for (const r of reading.inWindow(readReflog(ref, root), w))
			bySha.set(r.sha, { where: ref, ...r });
	const merges = git(
		[
			"log",
			"--all",
			"--merges",
			"--format=%H%x09%ct%x09%s",
			`--since=@${Math.floor(w.since / 1000)}`,
			`--until=@${Math.floor(w.until / 1000)}`,
		],
		root,
	);
	for (const line of merges.split("\n")) {
		const [sha, ct, ...subject] = line.split("\t");
		const msg = subject.join("\t");
		if (sha && reading.isMergeIntoReconcile(msg))
			bySha.set(sha, { where: "merge", t: Number(ct) * 1000, sha, msg });
	}
	return { worktrees: worktrees.length, entries: [...bySha.values()] };
}

/**
 * @param {string} root
 * @param {Window} w
 */
async function readRefusals(root, w) {
	/** @type {import("./lib/worktree-model-reading.js").Refusal[]} */
	const refusals = [];
	const absentLogs = [];
	for (const log of [landerLog(root), loopFiles().log]) {
		if (!fs.existsSync(log)) {
			absentLogs.push(log);
			continue;
		}
		const all = [];
		for await (const line of readLines(log)) all.push(line);
		refusals.push(...reading.levellingRefusals(all, w, root));
	}
	return { refusals, absentLogs };
}

/**
 * @param {string} root
 * @param {ReflogRow[]} all
 * @param {Window} w
 */
function readDirt(root, all, w) {
	const dirty = [];
	let untracked = 0;
	for (const { xy, path: p } of porcelainEntries(
		git(["status", "--porcelain=v1", "-z", "-unormal"], root),
	)) {
		if (xy === "??") untracked++;
		else dirty.push(p);
	}
	const forwarded = new Set();
	let from = all.filter((r) => r.t < w.since).at(-1)?.sha;
	for (const r of reading.inWindow(all, w)) {
		if (from)
			for (const p of parseNulList(
				git(["diff", "--name-only", "-z", from, r.sha], root),
			))
				forwarded.add(p);
		from = r.sha;
	}
	const touched = parseNulList(git(["ls-files", "-z"], root)).filter((p) => {
		if (forwarded.has(p)) return false;
		try {
			const mtime = fs.lstatSync(path.join(root, p)).mtimeMs;
			return mtime >= w.since && mtime < w.until;
		} catch (err) {
			if (caught(err).code === "ENOENT") return false;
			throw err;
		}
	});
	return { dirty, untracked, touched };
}

/**
 * @typedef {{ edits: { rel: string, ms: number }[], editErrors: number, merges: { sha: string, start: number, end: number }[], land: Omit<import("./lib/worktree-model-reading.js").LandCounts, "merged"> }} Spans
 */

/**
 * @param {string} root
 * @param {import("./lib/worktree-model-reading.js").ToolSpan} span
 * @param {Spans} spans
 */
function fileSpan(root, span, spans) {
	const rel =
		span.name === "Edit" ? reading.repoPath(root, span.input.file_path) : null;
	if (rel !== null && span.isError) spans.editErrors++;
	else if (rel !== null) spans.edits.push({ rel, ms: span.end - span.start });
	const landed = reading.landingOutcome(span);
	if (landed?.kind === "merged")
		spans.merges.push({ sha: landed.sha, start: span.start, end: span.end });
	else if (landed) spans.land[landed.kind]++;
}

/**
 * @param {string} root
 * @param {Spans["merges"]} merges
 */
function readMergeCosts(root, merges) {
	const toCommit = [];
	let unread = 0;
	for (const m of merges) {
		if (!isGitYes(["cat-file", "-e", `${m.sha}^{commit}`], root)) {
			unread++;
			continue;
		}
		const at =
			Number(git(["show", "-s", "--format=%ct", m.sha], root).trim()) * 1000;
		toCommit.push(Math.max(0, at - m.start));
	}
	return {
		mergeToCommit: reading.spread(toCommit),
		mergeCall: reading.spread(merges.map((m) => m.end - m.start)),
		mergeUnread: unread,
	};
}

/**
 * @param {string} root
 * @param {Window} w
 */
async function readCosts(root, w) {
	const files = oneCopyEach(listTranscripts(projectDirs()).found).filter(
		(f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= w.since,
	);
	/** @type {Spans} */
	const spans = {
		edits: [],
		editErrors: 0,
		merges: [],
		land: { pushed: 0, moved: 0, failed: 0 },
	};
	let unparsed = 0;
	for (const file of files) {
		const read = await readRecords(file);
		unparsed += read.unparsed;
		for (const span of reading.toolSpans(read.records))
			if (span.start >= w.since && span.start < w.until)
				fileSpan(root, span, spans);
	}
	const tracked = new Set(
		parseNulList(
			git(["ls-tree", "-r", "-z", "--name-only", VERIFIED_REF], root),
		),
	);
	return {
		transcripts: files.length,
		unparsed,
		edit: reading.spread(
			spans.edits.filter((e) => tracked.has(e.rel)).map((e) => e.ms),
		),
		editErrors: spans.editErrors,
		land: { ...spans.land, merged: spans.merges.length },
		...readMergeCosts(root, spans.merges),
	};
}

/**
 * @param {Record<string, string | true>} flags
 * @returns {Window | null}
 */
function parseWindow(flags) {
	const since = Date.parse(String(flagValue(flags, "--since") ?? ""));
	const untilFlag = flagValue(flags, "--until");
	const until =
		untilFlag === undefined ? Date.now() : Date.parse(String(untilFlag));
	return Number.isNaN(since) || Number.isNaN(until) || until <= since
		? null
		: { since, until };
}

/**
 * @param {string} root
 * @param {Window} w
 * @returns {Promise<Reading>}
 */
async function readAll(root, w) {
	const { all, main: levelled } = readMain(root, w);
	return {
		main: levelled,
		reconcile: readReconcile(root, w),
		...(await readRefusals(root, w)),
		dirt: readDirt(root, all, w),
		costs: await readCosts(root, w),
	};
}

/** @param {string[]} [argv] */
async function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const w = parseWindow(parsed.flags);
	if (w === null) {
		writeFd(
			2,
			`${CLI.usage}\n--since and --until are ISO times, --since the earlier\n`,
		);
		return 2;
	}
	const root = mainCheckout(process.cwd());
	if (root === null) {
		writeFd(
			2,
			"measure worktree model: no main checkout holds this directory\n",
		);
		return 2;
	}
	try {
		const r = await readAll(root, w);
		const { text, failed } = reading.render(r, w);
		if (parsed.flags["--json"] === true)
			writeFd(1, `${JSON.stringify({ ...r, window: w, failed })}\n`);
		else writeFd(2, `${text}\n`);
		return failed ? 1 : 0;
	} catch (err) {
		writeFd(
			2,
			`measure worktree model: failed: ${caught(err).message.trim()}\n`,
		);
		return 2;
	}
}

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			writeFd(2, `measure worktree model: failed: ${caught(err).message}\n`);
			process.exitCode = 2;
		},
	);

module.exports = { main };
