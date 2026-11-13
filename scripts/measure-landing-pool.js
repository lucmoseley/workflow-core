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
 * `.claude/workflow-core.json` lists `landing`, its stays and green runs
 * counted under each lander run that ran `<sha>` (#5174). A run whose
 * started line names its code counts where that code carries `<sha>`: a
 * commit that has it as an ancestor, or a release tag carrying it. The log is
 * read back to the run in force at `--since`. A run whose line names no code
 * falls back on the checkout's own: workflow-core where `<sha>` is on its `origin/main`, an adopter from the
 * time its pin first carried `<sha>` without break: the committer time of the
 * oldest `.claude/settings.json` revision in the unbroken run of carrying pins
 * ending at HEAD, or the file's mtime where only its uncommitted pin carries
 * it. A stay or green run counts only where every run it spans counts.
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
const { landerLog, parseStartedCode } = require("./lib/lander-start.js");
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
const { DAY_MS } = require("./lib/retained-jsonl.js");
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
 * @typedef {{from: number|null, pin: string|null} | {why: string}} Fallback
 *   what a lander run naming no code is judged by: `from` the time the
 *   checkout began running the sha, null for workflow-core, whose `--since`
 *   is the sha's arrival on its own `main`; `why` it did not
 * @typedef {{name: string, root: string, fallback: Fallback}} Member
 * @typedef {{name: string, why: string}} LeftOut
 */

/** @param {number} t */
const iso = (t) => new Date(t).toISOString();

/**
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

/* Required on first use, past the core check: the release leaves it behind. */
const releaseTags = () => require("./lib/release-tags.js");

/**
 * Whether a pin's ref carries `sha`: lib/release-tags.js
 * readTagCarry, a ref this clone lacks read as unread.
 * @param {string} core workflow-core's checkout
 * @param {string} sha
 * @returns {(ref: string) => Carry}
 */
function buildTagCarrier(core, sha) {
	const { readTagCarry } = releaseTags();
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

/**
 * Whether the code a lander's started line names carries `sha`. A code this
 * clone lacks does not.
 * @param {string} core
 * @param {string} sha
 * @param {(ref: string) => Carry} carry
 * @returns {(code: string) => boolean}
 */
function buildCodeCarrier(core, sha, carry) {
	const { TAG_RE } = releaseTags();
	/** @type {Map<string, boolean>} */
	const seen = new Map();
	return (code) => {
		const known = seen.get(code);
		if (known !== undefined) return known;
		let carries = false;
		if (TAG_RE.test(code)) {
			const c = carry(code);
			carries = "carries" in c && c.carries;
		} else if (commitSha(core, code) !== null)
			carries = isAncestor(core, sha, code);
		seen.set(code, carries);
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
		/* null where the revision deleted the file. */
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
 * The checkouts under `home` with `landing` on, each with its fallback, and
 * each one left out with why.
 * @param {string} home
 * @param {(ref: string) => Carry} carry
 * @param {string} sha full
 * @returns {{members: Member[], left: LeftOut[]}}
 */
function readPool(home, carry, sha) {
	/** @type {Member[]} */
	const members = [];
	/** @type {LeftOut[]} */
	const left = [];
	for (const root of readAdopterCheckouts(home).included) {
		const name = path.basename(root);
		if (!hasLanding(root)) left.push({ name, why: "landing is off" });
		else if (isCoreHost(root))
			members.push({
				name,
				root,
				fallback: isAncestor(root, sha, "origin/main")
					? { from: null, pin: null }
					: { why: "the sha is not on its origin/main" },
			});
		else members.push({ name, root, fallback: readCarriedSince(root, carry) });
	}
	return { members, left };
}

/**
 * The time a lander run naming no code counts from under `f`: -Infinity for
 * workflow-core, null where no such run counts.
 * @param {Fallback} f
 * @returns {number|null}
 */
const unnamedFrom = (f) =>
	"from" in f ? (f.from ?? Number.NEGATIVE_INFINITY) : null;

/**
 * The stamped lines of the lander log at `file` from the run in force at
 * `since`: the log is read back past `since` a day, then twice as far each
 * time, until a started line at or before `since` is in, or the whole log is.
 * @param {string} file
 * @param {number} since
 * @returns {import("./lib/time-to-land.js").LanderEvent[]}
 */
function readRunsSince(file, since) {
	for (let back = 0; ; back = back === 0 ? DAY_MS : back * 2) {
		const reach = since - back;
		const events = parseLanderLog(readLogSince(file, reach));
		const first = events[0]?.t;
		if (
			first === undefined ||
			first >= reach ||
			events.some((e) => e.kind === "started" && e.t <= since)
		)
			return events;
	}
}

/**
 * Whether a span of a checkout's log ran the sha: every lander run it spans
 * does, by its named code or else the checkout's fallback.
 * @param {import("./lib/time-to-land.js").LanderEvent[]} events
 * @param {Fallback} fallback
 * @param {(code: string) => boolean} codeCarries
 * @returns {{admit: (from: number, to: number) => boolean, carried: number}}
 *   `carried` the runs whose named code carries the sha
 */
function buildAdmission(events, fallback, codeCarries) {
	const runs = events
		.filter((e) => e.kind === "started")
		.map((e) => ({ t: e.t, code: parseStartedCode(e.rest) }));
	const unnamed = unnamedFrom(fallback);
	/** @param {string|null} code @param {number} t */
	const ran = (code, t) =>
		code === null ? unnamed !== null && t >= unnamed : codeCarries(code);
	/** @param {number} t */
	const codeAt = (t) => runs.findLast((r) => r.t <= t)?.code ?? null;
	return {
		admit: (from, to) =>
			ran(codeAt(from), from) &&
			runs.every((r) => r.t <= from || r.t > to || ran(r.code, r.t)),
		carried: runs.filter((r) => r.code !== null && codeCarries(r.code)).length,
	};
}

/** @param {Fallback} f @param {number} since */
const fromLine = (f, since) => {
	if (!("from" in f))
		return `from ${iso(since)}, only under lander runs whose code carries it, as ${f.why}`;
	return f.from !== null && f.from > since
		? `from ${iso(since)} under lander runs whose code carries it, from ${iso(f.from)} under any other, when its pin ${f.pin} first carried it`
		: `from ${iso(since)}`;
};

/** @param {LeftOut[]} left */
const leftLine = (left) =>
	left.length === 0
		? []
		: [`  left out: ${left.map((l) => `${l.name} (${l.why})`).join(", ")}`];

/**
 * @param {{members: Member[], left: LeftOut[]}} pool
 * @param {{since: number, until: number}} w
 * @param {string} sha
 * @param {(code: string) => boolean} codeCarries
 */
function poolStays(pool, w, sha, codeCarries) {
	const left = [...pool.left];
	const ran = pool.members.flatMap((m) => {
		const events = readRunsSince(landerLog(m.root), w.since);
		const { admit, carried } = buildAdmission(events, m.fallback, codeCarries);
		if ("why" in m.fallback && carried === 0) {
			left.push({
				name: m.name,
				why: `${m.fallback.why}, and no lander run names code carrying it`,
			});
			return [];
		}
		return [{ m, events, admit }];
	});
	left.sort((a, b) => a.name.localeCompare(b.name));
	const repos = ran.map(({ m, events, admit }) => {
		const unnamed = unnamedFrom(m.fallback) ?? Number.POSITIVE_INFINITY;
		const r = judgeTimeToLand(
			memberStays(readQueueRows(queueLogFile(m.root))).filter((s) =>
				admit(s.take, s.at),
			),
			greenSuiteSpans(events).filter((g) => admit(g.from, g.at)),
			{ since: w.since, until: w.until, label: "" },
		);
		const reading = r.judged
			? `${r.stays} stay(s), ${r.overTarget} over its target of ${secs(r.targetMs)} s (${TARGET_MULTIPLE} times its green p50 of ${secs(r.greenP50Ms)} s over ${r.greens} run(s))`
			: `${r.stays} stay(s), unjudged: no green run in its window, so left out of the pool`;
		return {
			name: m.name,
			unnamedFrom:
				unnamed === Number.POSITIVE_INFINITY
					? null
					: iso(Math.max(w.since, unnamed)),
			judged: r.judged,
			stays: r.stays,
			overTarget: r.overTarget,
			targetMs: r.targetMs,
			greenP50Ms: r.greenP50Ms,
			greens: r.greens,
			line: `${reading}, ${fromLine(m.fallback, w.since)}`,
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
			left,
		},
		lines: [
			`queue stays taken and landed or dropped since ${iso(w.since)}, every landing checkout running ${sha.slice(0, SHORT_SHA)}, each against its own target:`,
			...repos.map((r) => `  ${r.name}: ${r.line}`),
			...leftLine(left),
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
 * A `--since` still ahead reads 0: #5054's gate is set
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
	const carry = buildTagCarrier(core, sha);
	return poolStays(
		readPool(home, carry, sha),
		w,
		sha,
		buildCodeCarrier(core, sha, carry),
	);
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
