#!/usr/bin/env node
/*
 * measure-pass-store-rows.js — the pass-store rows a read-audit change costs
 * (#5029), before and after, off one set of kept audit logs.
 *
 * Usage:
 *   node scripts/measure-pass-store-rows.js --against <rev|dir>
 *     [--logs <dir>] [--keep] [--batch-files <n>]
 *
 * Draws #4916's sample, every third tracked `*.test.ts`, and runs it through
 * `run-vitest.js --queue --fresh` in this tree, in batches of at most
 * `--batch-files` (default 120, under the 121 files that take the
 * whole-suite slot, and each inside the suite ceiling). Each batch keeps its
 * audit logs and the run its pass store was handed (lib/row-measure.js's
 * `KEEP_ENV`). The kept logs are then judged twice: by `--against`, a
 * revision or a directory holding a `scripts/` reader, and by this tree's
 * reader, each recording into a scratch store as the run did. It prints each
 * reader's rows and named-run weighted share, and each file lost or gained
 * with the doubt that cost it.
 *
 * `--logs <dir>` judges logs a `--keep` run left, running nothing. The logs
 * hold the run's environment, keys included: they are deleted once judged
 * unless `--keep` is given, and a `--logs` directory is never deleted.
 *
 * The tree must stand as the batches left it until the judging is done: a
 * move drops every row on both sides, so the command refuses it.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { execGit } = require("./lib/git.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { WHOLE_SLOT_FILES } = require("./lib/suite-bounded.js");
const { readMarkers, repoRoot } = require("./lib/test-pass-marker.js");
const {
	KEEP_ENV,
	WINDOW_DAYS,
	batchesOf,
	judge,
	movedSince,
	namedRunWeights,
	readKept,
	summarise,
} = require("./lib/row-measure.js");

/* The tree the batches run in and the judging reads: this session's. */
const ROOT = worktreeRoot();
const DAY_MS = 864e5;

const CLI = {
	usage:
		"usage: node scripts/measure-pass-store-rows.js --against <rev|dir> [--logs <dir>] [--keep] [--batch-files <n>]",
	flags: {
		"--against": /** @type {const} */ ("value"),
		"--logs": /** @type {const} */ ("value"),
		"--keep": /** @type {const} */ ("boolean"),
		"--batch-files": /** @type {const} */ ("value"),
	},
};

/** Every third tracked `*.test.ts`, the first included (#4916). */
function drawSample() {
	return String(
		execGit(["ls-files", "*.test.ts"], { cwd: ROOT, encoding: "utf8" }),
	)
		.split("\n")
		.filter(Boolean)
		.filter((_, i) => i % 3 === 0);
}

/**
 * Run each batch, keeping its logs under `keep`.
 * @param {string[][]} batches
 * @param {string} keep
 */
function runBatches(batches, keep) {
	for (const [i, batch] of batches.entries()) {
		const log = path.join(keep, `batch-${i + 1}.log`);
		const out = fs.openSync(log, "w");
		const began = Date.now();
		const before = readKept(keep).length;
		process.stdout.write(
			`batch ${i + 1}/${batches.length}: ${batch.length} files… `,
		);
		const { status } = spawnSync(
			process.execPath,
			[path.join(__dirname, "run-vitest.js"), "--queue", "--fresh", ...batch],
			{
				cwd: ROOT,
				env: { ...process.env, [KEEP_ENV]: keep },
				stdio: ["ignore", out, out],
			},
		);
		fs.closeSync(out);
		const kept = readKept(keep).length > before;
		const secs = Math.round((Date.now() - began) / 1000);
		process.stdout.write(
			`exit ${status}, ${secs} s, ${kept ? "kept" : "KEPT NOTHING"}\n`,
		);
		if (!kept)
			process.stdout.write(
				`${fs.readFileSync(log, "utf8").split("\n").slice(-20).join("\n")}\n`,
			);
	}
}

/**
 * The reader `against` names, as a `scripts/lib` directory under `into`: a
 * directory's `scripts/` copied, or a revision's archived. Its git guard is
 * this checkout's, linked in: the audit tells the guard by its real path
 * beside the reader (lib/read-audit-paths.js's `GUARD`), and the logs name
 * the guard that ran.
 * @param {string} against
 * @param {string} into
 */
function placeReader(against, into) {
	if (fs.statSync(against, { throwIfNoEntry: false })?.isDirectory())
		fs.cpSync(path.join(against, "scripts"), path.join(into, "scripts"), {
			recursive: true,
		});
	else {
		const tar = path.join(into, "reader.tar");
		execGit(["archive", `--output=${tar}`, against, "scripts"], { cwd: ROOT });
		const { status, stderr } = spawnSync("tar", ["-xf", tar, "-C", into], {
			encoding: "utf8",
		});
		if (status !== 0)
			throw new Error(`tar would not unpack ${against}: ${stderr}`);
	}
	const lib = path.join(into, "scripts", "lib");
	const guard = path.join(lib, "host-git-guard");
	fs.rmSync(guard, { recursive: true, force: true });
	fs.symlinkSync(path.join(ROOT, "scripts", "lib", "host-git-guard"), guard);
	return lib;
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), CLI);
	const against = flagValue(flags, "--against");
	if (!against) {
		process.stderr.write(`--against is required\n${CLI.usage}\n`);
		return 2;
	}
	const given = flagValue(flags, "--logs");
	const max = Number(flagValue(flags, "--batch-files") ?? WHOLE_SLOT_FILES - 1);
	if (!Number.isInteger(max) || max < 1) {
		process.stderr.write("--batch-files takes a whole number above 0\n");
		return 2;
	}
	const sample = drawSample();
	const keep =
		given ?? fs.mkdtempSync(path.join(os.tmpdir(), "wfc-row-measure-"));
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-row-reader-"));
	try {
		if (!given) runBatches(batchesOf(sample, max), keep);
		const kept = readKept(keep);
		if (kept.length === 0) {
			process.stderr.write(`no run kept under ${keep}: nothing to judge\n`);
			return 1;
		}
		for (const { dir, run } of kept) {
			const moved = movedSince(run);
			if (moved) {
				process.stderr.write(
					`the tree moved since ${path.basename(dir)} ran (${moved.slice(0, 10).join(", ")}), which drops every row it records on both sides; rerun on a still tree\n`,
				);
				return 1;
			}
		}
		const head = String(
			execGit(["rev-parse", "--short", "HEAD"], {
				cwd: ROOT,
				encoding: "utf8",
			}),
		).trim();
		/**
		 * @param {string} name
		 * @param {string} lib
		 */
		const side = (name, lib) => {
			const judged = judge(lib, kept);
			for (const s of judged.said) process.stderr.write(`${name}: ${s}`);
			return { name, ...judged };
		};
		const before = side(`against ${against}`, placeReader(against, scratch));
		const after = side(`this tree (${head})`, path.join(__dirname, "lib"));
		const { weights, runs } = namedRunWeights(
			readMarkers({ root: repoRoot(ROOT) }),
			sample,
			Date.now() - WINDOW_DAYS * DAY_MS,
		);
		const lines = summarise({
			sample,
			weights,
			runs,
			against: before,
			ours: after,
		});
		process.stdout.write(`${lines.join("\n")}\n`);
		if (flags["--keep"] && !given)
			process.stdout.write(
				`\nLogs kept at ${keep}; they hold the run's environment, keys included.\n`,
			);
		return 0;
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
		if (!given && !flags["--keep"])
			fs.rmSync(keep, { recursive: true, force: true });
	}
}

if (require.main === module) process.exitCode = main();
