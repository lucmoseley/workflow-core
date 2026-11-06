#!/usr/bin/env node
/*
 * suite-timings.js — the CLI over scripts/lib/suite-timings.js. `extract`
 * turns one vitest JSON run into a tracked per-file dataset; `latest` does it
 * from the newest green suite run's reports, which each Vitest shard in CI
 * plans by (#4574); `shares` recomputes the percentile table from a dataset
 * already committed.
 *
 * `latest` WRITES THE COMMITTED RECORD'S COPY where it cannot read a run: no
 * green run with reports, or GitHub failing twice. Every shard meeting the
 * same failure so still plans as one; a shard meeting it alone plans apart,
 * which the verdict job's comparison of the shards' `# run:` lines turns red.
 *
 * IT JOINS NO FAMILY (§G4, §N3, mantahostels#2039). It gates nothing, so it is no
 * `check-*` and owes none of that alphabet; it is not a hook, so it is no
 * `guard-*`; `generate-*` fits `extract` and not `shares`, which writes
 * nothing. Exit is 0 or 1 — never 2, which would read as `check-*`'s BROKEN
 * from a script outside that contract.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SUITE_WORKFLOW } = require("./lib/actions-tester.js");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { gh, ghJson, retryingOnceSync } = require("./lib/gh.js");
const { writeFd } = require("./lib/write-fd.js");
const { codeRepoArgs } = require("./lib/workflow-core-config.js");
const {
	CI_RECORD,
	timingSources,
	readReports,
	shares,
	toCsv,
	parseCsv,
	formatShares,
	parseMeta,
} = require("./lib/suite-timings.js");
const { worktreeRoot } = require("./lib/host-root.js");

const USAGE = `Usage:
  node scripts/suite-timings.js extract <vitest.json|dir> <out.csv> [key=value ...]
  node scripts/suite-timings.js latest <out.csv> [--before-run <run-id>]
  node scripts/suite-timings.js shares <dataset.csv>

Produce the JSON with:
  WFC_VITEST_JSON=<vitest.json> npm run test -- --full=<cause>
A dir merges every *.json under it, as one sharded run's reports:
  gh run download <run-id> -R lucmoseley/workflow-core -p 'vitest-report-*' -D <dir>
`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	commands: {
		extract: { usage: USAGE, min: 2, max: Number.POSITIVE_INFINITY },
		latest: { usage: USAGE, min: 1, flags: { "--before-run": "value" } },
		shares: { usage: USAGE, min: 1 },
	},
};

/*
 * writeFd, not console (§N6). Every path here precedes process.exit, and
 * this script is read from Bash by an agent, whose stdout is a pipe — node
 * drops whatever is still buffered to a pipe when the process exits.
 */
/** @param {string} s */
const out = (s) => writeFd(1, `${s}\n`);
/** @param {string} s */
const err = (s) => writeFd(2, `${s}\n`);

/* The vitest report's file names are paths in the tree the suite ran over, so
 * they are relativised against it (#1, #4493): a linked worktree's own, where
 * the run was in one. Never `__dirname` — a plugin install's own checkout is
 * not that tree. */
const ROOT = worktreeRoot();

/* Candidates tried for reports, newest first. Untraced: a green run
 * uploads its reports, so past the first few none is coming. */
const SOURCES_TRIED = 5;
/* What `gh run download` prints for a run whose reports are gone or never
 * uploaded (#4292). */
const NO_ARTEFACTS = /no valid artifacts found/i;

/** @param {() => any} read */
function readOrThrow(read) {
	const r = retryingOnceSync(read);
	if (!r.ok) throw new Error(r.error);
	return r.out;
}

/**
 * The newest green suite run finished before `beforeRun` was created, and its
 * rows; null where none of the newest SOURCES_TRIED holds reports.
 * @param {string|undefined} beforeRun
 * @returns {{ run: number, sha: string, rows: ReturnType<typeof readReports> }|null}
 */
function latestRows(beforeRun) {
	const repo = codeRepoArgs({ root: ROOT })[1] ?? process.env.GITHUB_REPOSITORY;
	if (!repo) throw new Error("no codeRepo configured and no GITHUB_REPOSITORY");
	const before =
		beforeRun === undefined
			? Date.now()
			: Date.parse(
					readOrThrow(() =>
						ghJson(["api", `repos/${repo}/actions/runs/${beforeRun}`]),
					).created_at,
				);
	if (!Number.isFinite(before))
		throw new Error(`run ${beforeRun} has no creation time`);
	const iso = new Date(before).toISOString().replace(/\.\d{3}Z$/, "Z");
	/** @type {(import("./lib/suite-timings.js").ListedRun & { head_sha: string })[]} */
	const runs = readOrThrow(
		() =>
			ghJson([
				"api",
				`repos/${repo}/actions/workflows/${SUITE_WORKFLOW}/runs?status=success&exclude_pull_requests=true&per_page=30&created=%3C${iso}`,
			]).workflow_runs,
	);
	const sha = new Map(runs.map((r) => [r.id, r.head_sha]));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "suite-timings-"));
	try {
		for (const run of timingSources(runs, before).slice(0, SOURCES_TRIED)) {
			const dir = path.join(work, String(run));
			try {
				readOrThrow(() =>
					gh([
						"run",
						"download",
						String(run),
						"-p",
						"vitest-report-*",
						"-D",
						dir,
					]),
				);
			} catch (e) {
				if (NO_ARTEFACTS.test(caught(e).message)) continue;
				throw e;
			}
			const rows = readReports(dir, ROOT);
			if (rows.length > 0) return { run, sha: sha.get(run) ?? "", rows };
		}
		return null;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @param {string} target
 * @param {string|undefined} beforeRun
 * @returns {number}
 */
function latest(target, beforeRun) {
	let found;
	try {
		found = latestRows(beforeRun);
	} catch (e) {
		err(
			`suite-timings: no run read (${caught(e).message.trim()}) — writing ${CI_RECORD} instead`,
		);
		found = null;
	}
	if (found === null) {
		if (!fs.existsSync(path.join(ROOT, CI_RECORD))) {
			err(`suite-timings: no ${CI_RECORD} to fall back on — wrote nothing`);
			return 1;
		}
		fs.copyFileSync(path.join(ROOT, CI_RECORD), target);
		out(`${CI_RECORD} → ${target}`);
		return 0;
	}
	fs.writeFileSync(
		target,
		toCsv(found.rows, { run: found.run, sha: found.sha }),
	);
	out(`${found.rows.length} files from run ${found.run} → ${target}`);
	return 0;
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	/* A refusal exits 1, never cli-args' 2 (see the header). */
	if (typeof parsed === "number") return parsed === 0 ? 0 : 1;
	const { command, positionals, flags } = parsed;
	if (command === "latest") {
		const [target] = positionals;
		if (target === undefined)
			throw new Error("parseOrCode's min: 1 let a missing <out.csv> through");
		const beforeRun = flags["--before-run"];
		return latest(
			target,
			typeof beforeRun === "string" ? beforeRun : undefined,
		);
	}
	if (command === "extract") {
		const [source, target, ...pairs] = positionals;
		if (source === undefined || target === undefined)
			throw new Error("parseOrCode's min: 2 let a missing path through");
		const { meta, bad } = parseMeta(pairs);
		if (bad !== null) {
			err(
				`suite-timings: "${bad}" is not key=value — metadata is written as run=... sha=...`,
			);
			return 1;
		}
		const rows = readReports(source, ROOT);
		fs.writeFileSync(target, toCsv(rows, meta));
		out(`${rows.length} files → ${target}`);
		out(formatShares(shares(rows)));
		return 0;
	}
	const [source] = positionals;
	if (source === undefined)
		throw new Error("parseOrCode's min: 1 let a missing <dataset.csv> through");
	out(formatShares(shares(parseCsv(fs.readFileSync(source, "utf8")).rows)));
	return 0;
}

/* Exports nothing (§N7): the seam is scripts/lib/suite-timings.js, and the
 * test drives this file end to end through scripts/lib/run-in-process.js,
 * which loads it as the entry module so this guard fires as it does under
 * node. */
if (require.main === module) process.exit(main());
