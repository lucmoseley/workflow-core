#!/usr/bin/env node
/*
 * measure-landing-pool.js — counts an event every workflow-core checkout on
 * this machine logs, so a gate measuring shared code reads every repo that
 * runs it, not workflow-core alone (#5159).
 *
 * Usage:
 *   node scripts/measure-landing-pool.js batches --since <ISO> --carrying <sha> [--json]
 *   node scripts/measure-landing-pool.js stays --since <ISO> --carrying <sha> [--json]
 *   node scripts/measure-landing-pool.js reaps --since <ISO> [--json]
 *
 * THE POOL (`batches`, `stays`): each main checkout under $HOME whose
 * `.claude/workflow-core.json` lists `landing` and that runs `<sha>`:
 * workflow-core where `<sha>` is on its `origin/main`, an adopter where its
 * pin is a release tag carrying it (release-contains.js's test). An adopter
 * counts from the time its pin first carried `<sha>` without break: the
 * committer time of the oldest `.claude/settings.json` revision in the
 * unbroken run of carrying pins ending at HEAD, or the file's mtime where only
 * its uncommitted pin carries it. Residual: a lander the refill loop starts
 * runs the loop's own code, so an adopter pinned below `<sha>` may run it
 * too; it is left out.
 *
 * `batches`: `take-batch` lines in each checkout's lander log after its start.
 *
 * `stays`: each checkout's stays judged against its own target, 3 times its
 * own green suite's p50 (lib/time-to-land.js judgeTimeToLand), then pooled as
 * counts: stays and stays over target summed, the exact binomial count taken
 * at the pooled n. Raw times are never pooled, as each repo's suite differs.
 * A checkout with no green run in its window has no target; its stays are
 * named and left out of the pool.
 *
 * `reaps`: every main checkout under $HOME carrying a config, whatever its
 * modules or pin: the disk is the machine's, and the refill loop's reaper
 * runs its own code in each. Rows of `wfc-reaped-worktrees.jsonl` in each
 * checkout's git common dir after `--since`.
 *
 * CORE-ONLY: it reads workflow-core's release tags, which an adopter's clone
 * lacks (lib/plugin-tree.js leaves `measure-` scripts behind). Joins no §N3
 * family: it answers a gate's question and gates nothing. Exits 0 on a
 * reading, 2 on a usage error or outside workflow-core.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { now } = require("./lib/clock.js");
const { commitSha } = require("./lib/commit-sha.js");
const { execGit, gitCommonDir, spawnGitSync } = require("./lib/git.js");
const { readJsonl } = require("./lib/jsonl.js");
const { landerLog } = require("./lib/lander-start.js");
const { findPin, isCoreHost, readJsonSafe } = require("./lib/plugin-state.js");
const { queueLogFile, readQueueRows } = require("./lib/queue-log.js");
const { homeDir, readAdopterCheckouts } = require("./lib/refill-repos.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	TARGET_MULTIPLE,
	greenSuiteSpans,
	memberStays,
	overCountNeeded,
	parseLanderLog,
	readLogSince,
	judgeTimeToLand,
	secs,
	windowOf,
} = require("./lib/time-to-land.js");
const { REAPED_RECORD } = require("./lib/worktree-reaper.js");
const { writeFd } = require("./lib/write-fd.js");

const PLUGIN = "workflow-core";
const SETTINGS = ".claude/settings.json";

const USAGE = [
	"usage: node scripts/measure-landing-pool.js batches --since <ISO> --carrying <sha> [--json]",
	"       node scripts/measure-landing-pool.js stays --since <ISO> --carrying <sha> [--json]",
	"       node scripts/measure-landing-pool.js reaps --since <ISO> [--json]",
].join("\n");
const POOLED = { "--carrying": /** @type {"value"} */ ("value") };
/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	flags: { "--since": "value", "--json": "boolean" },
	commands: {
		batches: { usage: USAGE, flags: POOLED },
		stays: { usage: USAGE, flags: POOLED },
		reaps: { usage: USAGE },
	},
};

/**
 * @typedef {{name: string, root: string, from: number|null, pin: string|null}}
 *   Member `from` the time it began running the sha, null for workflow-core,
 *   whose `--since` is the sha's arrival on its own `main`
 * @typedef {{name: string, why: string}} LeftOut
 */

/** @param {number} t */
const iso = (t) => new Date(t).toISOString();

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null} stdout, null where git refuses
 */
function gitOut(cwd, args) {
	try {
		return String(
			execGit(args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
	} catch {
		return null;
	}
}

/**
 * @param {string} cwd
 * @param {string} ancestor
 * @param {string} rev
 */
const isAncestor = (cwd, ancestor, rev) =>
	spawnGitSync(["merge-base", "--is-ancestor", ancestor, rev], {
		cwd,
		stdio: "ignore",
	}).status === 0;

/**
 * Whether release tag `tag` carries `sha`, as release-contains.js reads it:
 * its commit message names the source it was rendered from.
 * @param {string} core workflow-core's checkout
 * @param {string} sha
 * @returns {(tag: string) => boolean}
 */
function tagCarrier(core, sha) {
	/* Required here, past the core check: the release leaves it behind. */
	const { RENDERED_FROM } = require("./lib/release-tags.js");
	/** @type {Map<string, boolean>} */
	const seen = new Map();
	return (tag) => {
		const known = seen.get(tag);
		if (known !== undefined) return known;
		const message = gitOut(core, ["log", "-1", "--format=%B", tag]) ?? "";
		const source = RENDERED_FROM.exec(message)?.[1];
		const carries =
			source !== undefined &&
			commitSha(core, source) !== null &&
			isAncestor(core, sha, source);
		seen.set(tag, carries);
		return carries;
	};
}

/** @param {unknown} settings @returns {string|null} the pin's tag or ref */
const pinRef = (settings) =>
	findPin(
		/** @type {import("./lib/plugin-state").AdopterSettings|null} */ (settings),
		PLUGIN,
	)?.ref ?? null;

/** @param {string|null} text @returns {unknown} null where it is no JSON */
function parseJsonOrNull(text) {
	try {
		return text === null ? null : JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Since when adopter `root`'s pin has carried the sha without break, or null
 * where its current pin does not.
 * @param {string} root
 * @param {(tag: string) => boolean} carries
 * @returns {number|null} ms
 */
function carriedSince(root, carries) {
	const file = path.join(root, SETTINGS);
	const current = pinRef(readJsonSafe(file));
	if (current === null || !carries(current)) return null;
	/** @type {number|null} */
	let since = null;
	const log = gitOut(root, ["log", "--format=%H %ct", "--", SETTINGS]) ?? "";
	for (const line of log.split("\n").filter(Boolean)) {
		const [rev, ct] = line.split(" ");
		const ref = pinRef(
			parseJsonOrNull(gitOut(root, ["show", `${rev}:${SETTINGS}`])),
		);
		if (ref === null || !carries(ref)) break;
		since = Number(ct) * 1000;
	}
	return since ?? fs.statSync(file).mtimeMs;
}

/** @param {string} root */
function listsLanding(root) {
	const cfg = /** @type {{modules?: unknown}|null} */ (
		readJsonSafe(path.join(root, ".claude", "workflow-core.json"))
	);
	return Array.isArray(cfg?.modules) && cfg.modules.includes("landing");
}

/**
 * The checkouts under `home` that run `sha` with `landing` on, and each one
 * left out with why.
 * @param {string} home
 * @param {string} core
 * @param {string} sha full
 * @returns {{members: Member[], left: LeftOut[]}}
 */
function readPool(home, core, sha) {
	const carries = tagCarrier(core, sha);
	/** @type {Member[]} */
	const members = [];
	/** @type {LeftOut[]} */
	const left = [];
	const short = sha.slice(0, 9);
	for (const root of readAdopterCheckouts(home).included) {
		const name = path.basename(root);
		if (!listsLanding(root)) {
			left.push({ name, why: "landing is off" });
			continue;
		}
		if (isCoreHost(root)) {
			if (isAncestor(root, sha, "origin/main"))
				members.push({ name, root, from: null, pin: null });
			else left.push({ name, why: `${short} is not on its origin/main` });
			continue;
		}
		const pin = pinRef(readJsonSafe(path.join(root, SETTINGS)));
		const from = carriedSince(root, carries);
		if (from === null)
			left.push({
				name,
				why: `its pin ${pin ?? "(none)"} does not carry ${short}`,
			});
		else members.push({ name, root, from, pin });
	}
	return { members, left };
}

/**
 * @param {Member} m
 * @param {number} since
 */
const startOf = (m, since) => Math.max(since, m.from ?? since);

/** @param {Member} m @param {number} since */
const fromLine = (m, since) =>
	m.from !== null && m.from > since
		? `from ${iso(m.from)}, when its pin ${m.pin} first carried it`
		: `from ${iso(since)}`;

/** @param {LeftOut[]} left */
const leftLine = (left) =>
	left.length === 0
		? []
		: [`  left out: ${left.map((l) => `${l.name} (${l.why})`).join(", ")}`];

/**
 * @param {{members: Member[], left: LeftOut[]}} pool
 * @param {number} since
 * @param {string} sha
 */
function countBatches(pool, since, sha) {
	const repos = pool.members.map((m) => {
		const from = startOf(m, since);
		const count = parseLanderLog(readLogSince(landerLog(m.root), from)).filter(
			(e) => e.kind === "take-batch" && e.t > from,
		).length;
		return { name: m.name, from: iso(from), count, line: fromLine(m, since) };
	});
	const total = repos.reduce((n, r) => n + r.count, 0);
	return {
		data: { since: iso(since), carrying: sha, total, repos, left: pool.left },
		lines: [
			`lander batches taken since ${iso(since)}, every landing checkout running ${sha.slice(0, 9)}:`,
			...repos.map((r) => `  ${r.name}: ${r.count} (${r.line})`),
			...leftLine(pool.left),
			`total: ${total} batch(es) across ${repos.length} checkout(s)`,
		],
	};
}

/**
 * @param {{members: Member[], left: LeftOut[]}} pool
 * @param {{since: number, until: number}} w
 * @param {string} sha
 */
function poolStays(pool, w, sha) {
	const repos = pool.members.map((m) => {
		const since = startOf(m, w.since);
		const mine = { since, until: w.until, label: "" };
		const r = judgeTimeToLand(
			memberStays(readQueueRows(queueLogFile(m.root))),
			greenSuiteSpans(parseLanderLog(readLogSince(landerLog(m.root), since))),
			mine,
		);
		const reading = r.judged
			? `${r.stays} stay(s), ${r.overTarget} over its target of ${secs(r.targetMs)} s (${TARGET_MULTIPLE} times its green p50 of ${secs(r.greenP50Ms)} s over ${r.greens} run(s))`
			: `${r.stays} stay(s), unjudged: no green run in its window, so left out of the pool`;
		return {
			name: m.name,
			from: iso(since),
			judged: r.judged,
			stays: r.stays,
			overTarget: r.overTarget,
			targetMs: r.targetMs,
			greenP50Ms: r.greenP50Ms,
			greens: r.greens,
			line: `${reading}, ${fromLine(m, w.since)}`,
		};
	});
	const judged = repos.filter((r) => r.judged);
	const stays = judged.reduce((n, r) => n + r.stays, 0);
	const overTarget = judged.reduce((n, r) => n + (r.overTarget ?? 0), 0);
	const overNeeded = overCountNeeded(stays);
	const over = judged.length > 0 && overTarget >= overNeeded;
	return {
		data: {
			since: iso(w.since),
			until: iso(w.until),
			carrying: sha,
			stays,
			overTarget,
			overNeeded,
			over,
			repos,
			left: pool.left,
		},
		lines: [
			`queue stays taken and landed or dropped since ${iso(w.since)}, every landing checkout running ${sha.slice(0, 9)}, each against its own target:`,
			...repos.map((r) => `  ${r.name}: ${r.line}`),
			...leftLine(pool.left),
			`pooled: ${overTarget} of ${stays} stay(s) over their checkout's target; ${overNeeded} would call it over`,
		],
	};
}

/**
 * @param {string} home
 * @param {number} since
 */
function countReaps(home, since) {
	const repos = readAdopterCheckouts(home).included.map((root) => {
		const common = gitCommonDir(root);
		const rows = common
			? (readJsonl(path.join(common, REAPED_RECORD))?.rows ?? null)
			: null;
		const count =
			rows?.filter((r) => Date.parse(String(r.at)) > since).length ?? 0;
		return { name: path.basename(root), count, logged: rows !== null };
	});
	const total = repos.reduce((n, r) => n + r.count, 0);
	return {
		data: { since: iso(since), total, repos },
		lines: [
			`worktree reaps logged since ${iso(since)}, every workflow-core checkout under ${home}:`,
			...repos.map(
				(r) => `  ${r.name}: ${r.logged ? r.count : `0 (no ${REAPED_RECORD})`}`,
			),
			`total: ${total} reap(s) across ${repos.length} checkout(s)`,
		],
	};
}

/** @param {string} text */
const refuse = (text) => {
	writeFd(2, `${text}\n`);
	return 2;
};

/**
 * A `batches` or `stays` reading over the pool running `ref`, or why there
 * is none.
 * @param {string|undefined} command
 * @param {string|true|undefined} ref
 * @param {string} home
 * @param {{since: number, until: number}} w
 * @returns {{data: object, lines: string[]}|string}
 */
function readPooled(command, ref, home, w) {
	const core = repoRoot();
	if (core === null || !isCoreHost(core))
		return "measure-landing-pool.js runs in workflow-core: it reads its release tags.";
	if (typeof ref !== "string")
		return `${command} needs --carrying <sha>\n\n${USAGE}`;
	const sha = commitSha(core, ref);
	if (sha === null) return `${ref} names no commit in ${core}`;
	const pool = readPool(home, core, sha);
	return command === "batches"
		? countBatches(pool, w.since, sha)
		: poolStays(pool, w, sha);
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const { command, flags } = parsed;
	const at = now();
	const w = windowOf({ since: /** @type {string} */ (flags["--since"]) }, at);
	if (typeof w === "string" || flags["--since"] === undefined)
		return refuse(
			typeof w === "string" ? w : `--since is required\n\n${USAGE}`,
		);
	const home = homeDir();
	const out =
		command === "reaps"
			? countReaps(home, w.since)
			: readPooled(command, flags["--carrying"], home, w);
	if (typeof out === "string") return refuse(out);
	writeFd(
		1,
		flags["--json"]
			? `${JSON.stringify(out.data, null, "\t")}\n`
			: `${out.lines.join("\n")}\n`,
	);
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
