#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { execGit } = require("./lib/git.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { writeFd } = require("./lib/write-fd.js");
const { WHOLE_SLOT_FILES } = require("./lib/suite-bounded.js");
const { readMarkers, repoRoot } = require("./lib/test-pass-marker.js");
const {
	KEEP_ENV,
	WINDOW_DAYS,
	batchesOf,
	buildJudge,
	movedSince,
	namedRunWeights,
	readKept,
	readOptions,
	runKey,
	summarise,
} = require("./lib/row-measure.js");

const ROOT = worktreeRoot();
const DAY_MS = 864e5;
const KEEP_PREFIX = "wfc-row-measure-";

const LOG_TAIL_LINES = 20;

const MOVED_SHOWN = 10;

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

function drawSample() {
	return String(
		execGit(["ls-files", "*.test.ts"], { cwd: ROOT, encoding: "utf8" }),
	)
		.split("\n")
		.filter(Boolean)
		.filter((_, i) => i % 3 === 0);
}

function sweepLeftovers() {
	const tmp = os.tmpdir();
	for (const name of fs.readdirSync(tmp)) {
		if (!name.startsWith(KEEP_PREFIX)) continue;
		const dir = path.join(tmp, name);
		const stat = fs.statSync(dir, { throwIfNoEntry: false });
		if (stat?.isDirectory() && Date.now() - stat.mtimeMs > DAY_MS)
			fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
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

/** @type {import("node:child_process").ChildProcess|null} */
let running = null;

/**
 * @param {string[]} batch
 * @param {string} keep
 * @param {string} log
 * @returns {Promise<number|null>}
 */
function runBatch(batch, keep, log) {
	const out = fs.openSync(log, "w");
	running = spawn(
		process.execPath,
		[path.join(__dirname, "run-vitest.js"), "--queue", "--fresh", ...batch],
		{
			cwd: ROOT,
			env: { ...process.env, [KEEP_ENV]: keep },
			stdio: ["ignore", out, out],
		},
	);
	return new Promise((resolve) => {
		running?.on("close", (status) => {
			fs.closeSync(out);
			running = null;
			resolve(status);
		});
	});
}

/**
 * @param {string} keep
 * @param {Set<string>} done
 * @param {ReturnType<typeof buildJudge>[]} judges
 * @param {boolean} retain
 */
function judgeNew(keep, done, judges, retain) {
	for (const kept of readKept(keep)) {
		if (done.has(kept.dir)) continue;
		const moved = movedSince(kept.run);
		if (moved) return { dir: kept.dir, moved };
		for (const j of judges) j.add(kept);
		done.add(kept.dir);
		if (!retain) fs.rmSync(kept.dir, { recursive: true, force: true });
	}
	return null;
}

/** @param {{dir: string, moved: string[]}} refusal */
const movedRefusal = ({ dir, moved }) =>
	`the tree moved since ${path.basename(dir)} was kept (${moved.slice(0, MOVED_SHOWN).join(", ")}), which drops rows on both sides; rerun on a still tree\n`;

/**
 * @param {string[][]} batches
 * @param {{keep: string, done: Set<string>, own: Set<string>,
 *   judges: ReturnType<typeof buildJudge>[], retain: boolean}} ctx
 * @returns {Promise<number|null>}
 */
async function runAndJudge(batches, { keep, done, own, judges, retain }) {
	for (const [i, batch] of batches.entries()) {
		const log = path.join(keep, `batch-${i + 1}.log`);
		const began = Date.now();
		writeFd(2, `batch ${i + 1}/${batches.length}: ${batch.length} files… `);
		const status = await runBatch(batch, keep, log);
		const before = done.size;
		for (const { run } of readKept(keep)) own.add(runKey(run));
		const refused = judgeNew(keep, done, judges, retain);
		const secs = Math.round((Date.now() - began) / 1000);
		const kept = done.size > before ? "judged" : "KEPT NOTHING";
		writeFd(2, `exit ${status}, ${secs} s, ${kept}\n`);
		if (refused) {
			writeFd(2, movedRefusal(refused));
			return 1;
		}
		if (done.size === before)
			writeFd(
				2,
				`${fs.readFileSync(log, "utf8").split("\n").slice(-LOG_TAIL_LINES).join("\n")}\n`,
			);
	}
	return null;
}

/**
 * @typedef {{name: string, judge: ReturnType<typeof buildJudge>}} Side
 * @param {Side} before
 * @param {Side} after
 * @param {string[]} sample
 * @param {Set<string>} own
 */
function report(before, after, sample, own) {
	const read = (/** @type {Side} */ { name, judge }) => {
		const j = judge.read();
		for (const s of j.said) writeFd(2, `${name}: ${s}`);
		return { name, ...j };
	};
	const { weights, runs } = namedRunWeights(
		readMarkers({ root: repoRoot(ROOT) }),
		sample,
		Date.now() - WINDOW_DAYS * DAY_MS,
		own,
	);
	const lines = summarise({
		sample,
		weights,
		runs,
		against: read(before),
		ours: read(after),
	});
	writeFd(1, `${lines.join("\n")}\n`);
}

/**
 * @param {{against: string, logs: string|null, keep: boolean, max: number}} o
 * @param {string} keep
 * @param {string} scratch
 */
async function measure({ against, logs, keep: retain, max }, keep, scratch) {
	const sample = drawSample();
	const head = String(
		execGit(["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }),
	).trim();
	const before = {
		name: `against ${against}`,
		judge: buildJudge(placeReader(against, scratch)),
	};
	const after = {
		name: `this tree (${head})`,
		judge: buildJudge(path.join(__dirname, "lib")),
	};
	const ctx = {
		keep,
		done: new Set(/** @type {string[]} */ ([])),
		own: new Set(/** @type {string[]} */ ([])),
		judges: [before.judge, after.judge],
		retain,
	};
	try {
		if (logs) {
			for (const { run } of readKept(keep)) ctx.own.add(runKey(run));
			const refused = judgeNew(keep, ctx.done, ctx.judges, true);
			if (refused) {
				writeFd(2, movedRefusal(refused));
				return 1;
			}
		} else {
			const stopped = await runAndJudge(batchesOf(sample, max), ctx);
			if (stopped !== null) return stopped;
		}
		if (ctx.done.size === 0) {
			writeFd(2, `no run kept under ${keep}: nothing to judge\n`);
			return 1;
		}
		report(before, after, sample, ctx.own);
		if (retain && !logs)
			writeFd(
				2,
				`Logs kept at ${keep}; they hold the run's environment, keys included.\n`,
			);
		return 0;
	} finally {
		for (const j of ctx.judges) j.dispose();
	}
}

async function main() {
	const { flags } = parseOrExit(process.argv.slice(2), CLI);
	const options = readOptions(flags, WHOLE_SLOT_FILES - 1);
	if ("refusal" in options) {
		writeFd(2, `${options.refusal}\n${CLI.usage}\n`);
		return 2;
	}
	sweepLeftovers();
	const keep =
		options.logs ?? fs.mkdtempSync(path.join(os.tmpdir(), KEEP_PREFIX));
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-row-reader-"));
	const cleanUp = () => {
		fs.rmSync(scratch, { recursive: true, force: true });
		if (!options.logs && !options.keep)
			fs.rmSync(keep, { recursive: true, force: true });
	};
	const stop = () => {
		running?.kill("SIGTERM");
		cleanUp();
		process.exit(1);
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.once(signal, stop);
	try {
		return await measure(options, keep, scratch);
	} finally {
		cleanUp();
	}
}

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			writeFd(2, `${e?.stack ?? e}\n`);
			process.exitCode = 1;
		},
	);
