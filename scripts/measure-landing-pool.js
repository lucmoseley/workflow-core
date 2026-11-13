#!/usr/bin/env node
/*
 * measure-landing-pool.js — counts an event every workflow-core checkout on
 * this machine logs, so a gate measuring shared code reads every repo that
 * runs it, not workflow-core alone (#5159).
 *
 * Usage:
 *   node scripts/measure-landing-pool.js stays --since <ISO> --carrying <sha> [--json]
 *   node scripts/measure-landing-pool.js reaps --since <ISO> [--json]
 *
 * THE POOL (`stays`): each main checkout under $HOME whose
 * `.claude/workflow-core.json` lists `landing` and that runs `<sha>`:
 * workflow-core where `<sha>` is on its `origin/main`, an adopter where its
 * pin is a release tag carrying it (lib/release-tags.js readTagCarry). An adopter
 * counts from the time its pin first carried `<sha>` without break: the
 * committer time of the oldest `.claude/settings.json` revision in the
 * unbroken run of carrying pins ending at HEAD, or the file's mtime where only
 * its uncommitted pin carries it. Residual: a lander the refill loop starts
 * runs the loop's own code, so an adopter pinned below `<sha>` may run it
 * too; it is left out until the lander logs its code (#5174).
 *
 * Pool only what adopters' own runs can show: a gate on a workflow-core
 * test file reads workflow-core's batches alone, as no adopter suite holds it.
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
const {
	SHORT_SHA,
	execGit,
	gitCommonDir,
	gitOrNull,
	spawnGitSync,
} = require("./lib/git.js");
const { readJsonl } = require("./lib/jsonl.js");
const { landerLog } = require("./lib/lander-start.js");
const { findPin, isCoreHost, readJsonSafe } = require("./lib/plugin-state.js");
const { queueLogFile, readQueueRows } = require("./lib/queue-log.js");
const { homeDir, readAdopterCheckouts } = require("./lib/refill-repos.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	ISO_TIME_RE,
	TARGET_MULTIPLE,
	buildIsoRefusal,
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
	"usage: node scripts/measure-landing-pool.js stays --since <ISO> --carrying <sha> [--json]",
	"       node scripts/measure-landing-pool.js reaps --since <ISO> [--json]",
].join("\n");
const POOLED = { "--carrying": /** @type {"value"} */ ("value") };
/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	flags: { "--since": "value", "--json": "boolean" },
	commands: {
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
 * Whether `ancestor` is in `rev`'s history.
 * @param {string} cwd
 * @param {string} ancestor
 * @param {string} rev
 */
function isAncestor(cwd, ancestor, rev) {
	const r = spawnGitSync(["merge-base", "--is-ancestor", ancestor, rev], {
		cwd,
		stdio: "ignore",
	});
	if (r.status === 0 || r.status === 1) return r.status === 0;
	throw new Error(`git merge-base failed on ${rev} in ${cwd}`);
}

/**
 * @typedef {{carries: boolean} | {unread: string}} Carry
 */

/**
 * Whether a pin's ref carries `sha`, memoised: lib/release-tags.js
 * readTagCarry, a ref this clone lacks read as unread.
 * @param {string} core workflow-core's checkout
 * @param {string} sha
 * @returns {(ref: string) => Carry}
 */
function buildTagCarrier(core, sha) {
	/* Required here, past the core check: the release leaves it behind. */
	const { readTagCarry } = require("./lib/release-tags.js");
	/** @type {Map<string, Carry>} */
	const seen = new Map();
	return (ref) => {
		const known = seen.get(ref);
		if (known) return known;
		const carry =
			commitSha(core, ref) === null
				? { unread: `${ref} is not in ${core}` }
				: readTagCarry(core, ref, sha);
		seen.set(ref, carry);
		return carry;
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
 * Since when adopter `root`'s pin has carried the sha without break, or why
 * it is left out. A revision whose pin is absent, unreadable or not carrying
 * ends the run.
 * @param {string} root
 * @param {(ref: string) => Carry} carry
 * @returns {{from: number, pin: string} | {why: string}} `from` in ms
 */
function readCarriedSince(root, carry) {
	const file = path.join(root, SETTINGS);
	const pin = pinRef(readJsonSafe(file));
	if (pin === null) return { why: "it has no workflow-core pin" };
	const current = carry(pin);
	if ("unread" in current)
		return { why: `its pin is unread: ${current.unread}` };
	if (!current.carries) return { why: `its pin ${pin} does not carry the sha` };
	/** @type {number|null} */
	let from = null;
	const log = String(
		execGit(["log", "--format=%H %ct", "--", SETTINGS], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	for (const line of log.split("\n").filter(Boolean)) {
		const [rev, ct] = line.split(" ");
		/* null where the revision deleted the file, which ends the run too. */
		const ref = pinRef(
			parseJsonOrNull(gitOrNull(["show", `${rev}:${SETTINGS}`], { cwd: root })),
		);
		const then = ref === null ? null : carry(ref);
		if (then === null || !("carries" in then) || !then.carries) break;
		from = Number(ct) * 1000;
	}
	return { from: from ?? fs.statSync(file).mtimeMs, pin };
}

/** @param {string} root */
function hasLanding(root) {
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
	const carry = buildTagCarrier(core, sha);
	/** @type {Member[]} */
	const members = [];
	/** @type {LeftOut[]} */
	const left = [];
	for (const root of readAdopterCheckouts(home).included) {
		const name = path.basename(root);
		if (!hasLanding(root)) left.push({ name, why: "landing is off" });
		else if (!isCoreHost(root)) {
			const r = readCarriedSince(root, carry);
			if ("why" in r) left.push({ name, why: r.why });
			else members.push({ name, root, from: r.from, pin: r.pin });
		} else if (isAncestor(root, sha, "origin/main"))
			members.push({ name, root, from: null, pin: null });
		else left.push({ name, why: "the sha is not on its origin/main" });
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
			`queue stays taken and landed or dropped since ${iso(w.since)}, every landing checkout running ${sha.slice(0, SHORT_SHA)}, each against its own target:`,
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

/**
 * The reaps reading. A `--since` still ahead reads 0: #5054's gate is set
 * before the reaps it counts begin.
 * @param {string} home
 * @param {string} since
 * @returns {{data: object, lines: string[]}|string}
 */
const readReaps = (home, since) =>
	ISO_TIME_RE.test(since)
		? countReaps(home, Date.parse(since))
		: buildIsoRefusal("since", since);

/** @param {string} text */
const refuse = (text) => {
	writeFd(2, `${text}\n`);
	return 2;
};

/**
 * A `stays` reading over the pool running `ref`, or why there
 * is none.
 * @param {string|undefined} command
 * @param {string|true|undefined} ref
 * @param {string} home
 * @param {string} since an ISO time
 * @returns {{data: object, lines: string[]}|string}
 */
function readPooled(command, ref, home, since) {
	const w = windowOf({ since }, now());
	if (typeof w === "string") return w;
	const core = repoRoot();
	if (core === null || !isCoreHost(core))
		return "measure-landing-pool.js runs in workflow-core: it reads its release tags.";
	if (typeof ref !== "string")
		return `${command} needs --carrying <sha>\n\n${USAGE}`;
	const sha = commitSha(core, ref);
	if (sha === null) return `${ref} names no commit in ${core}`;
	return poolStays(readPool(home, core, sha), w, sha);
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const { command, flags } = parsed;
	const since = flags["--since"];
	if (typeof since !== "string")
		return refuse(`--since is required\n\n${USAGE}`);
	const home = homeDir();
	const out =
		command === "reaps"
			? readReaps(home, since)
			: readPooled(command, flags["--carrying"], home, since);
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
