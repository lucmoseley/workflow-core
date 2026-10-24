#!/usr/bin/env node
/*
 * check-swallowed-errors.js — base §N5's gate over Python: it refuses an
 * `except` a commit INTRODUCES that neither raises nor exits and cites no
 * ticket, narrow catches included, which ruff's BLE001 and E722 never see
 * (#1830). The walk is scripts/swallowed_errors.py, whose header owns what
 * counts as raising, exiting and citing.
 *
 * Usage:
 *   node scripts/check-swallowed-errors.js [--all]
 *
 * WHAT IS JUDGED: the program-routed `.py` paths. A path takes the kind of the
 * first `pythonRoutes` row in .claude/workflow-core.json whose glob matches
 * it, git's `:(glob)` pathspec reading, then of base §0's default map
 * (buildIsProgram); only `program` binds §N5.
 *
 * STAGED, the default: each staged program path's blob against its HEAD blob
 * (a staged rename's source, for a renamed path), charging only what the
 * commit adds, as check-ruff-introduced.js does (#122). A breach is keyed by
 * its enclosing function and the clause it catches, never by line, which any
 * edit above it moves; a key the staged blob holds more of than HEAD's is
 * introduced. --all judges every tracked program path's worktree copy and
 * charges every breach: the migration's first run, and an audit.
 *
 * A path that does not parse is passed with a line saying so: ruff's E9
 * refuses that commit. python3 missing is BROKEN, refusing the commit, not
 * the skip the ruff gate allows where a workflow runs ruff (#1563): no
 * adopter's workflow runs this walk, so a skip there would judge nothing.
 */

const fs = require("node:fs");
const path = require("node:path");

const { runCheck } = require("./lib/check");
const { blob, renameSources, spawn, stagedDiff } = require("./lib/staged");
const { globMatches } = require("./lib/pathspec-glob.js");
const { readConfig, resolveKey } = require("./lib/workflow-core-config.js");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/** @typedef {import("./lib/workflow-core-config.js").PythonKind} PythonKind */
/** @typedef {{ line: number, function: string, caught: string }} Breach */
/** @typedef {{ name: string, breaches?: Breach[], error?: string }} Result */

const WALK = path.join(__dirname, "swallowed_errors.py");

/**
 * The host's `pythonRoutes` rows first, as its local file's route rows come
 * first; then base §0's default map as it reaches Python: under `test/` a
 * test, any other file opening with a shebang a program. A `.py` neither
 * matches binds §G alone, so is not judged.
 * @param {Record<string, PythonKind> | undefined} declared
 * @returns {(p: string, text: string) => boolean}
 */
const buildIsProgram = (declared) => {
	const rows = Object.entries(declared ?? {});
	return (p, text) => {
		const row = rows.find(([g]) => globMatches(g, p));
		if (row) return row[1] === "program";
		return !globMatches("**/test/**", p) && text.startsWith("#!");
	};
};

/**
 * The repo names a citation may prefix: each corpus tracker's `name` half.
 * @returns {string[]}
 */
const prefixes = () =>
	/** @type {string[]} */ (resolveKey("corpus") ?? []).map(
		(t) => t.split("/")[1] ?? t,
	);

/**
 * @param {Ctx} ctx
 * @param {Source[]} sources
 * @returns {Map<string, Result>}
 */
function walk(ctx, sources) {
	const r = spawn(
		"python3",
		[WALK],
		JSON.stringify({ prefixes: prefixes(), sources }),
	);
	if (r.error) ctx.broken(`cannot run python3: ${r.error.message}`);
	if (r.status !== 0) ctx.broken(`${WALK} exited ${r.status}: ${r.stderr}`);
	try {
		const { results } = /** @type {{ results: Result[] }} */ (
			JSON.parse(r.stdout)
		);
		return new Map(results.map((x) => [x.name, x]));
	} catch (e) {
		ctx.broken(`${WALK} printed no JSON: ${caught(e).message}`);
	}
}

/** @param {Breach[]} bs */
function byKey(bs) {
	/** @type {Map<string, Breach[]>} */
	const groups = new Map();
	for (const b of bs) {
		const k = JSON.stringify([b.function, b.caught]);
		groups.set(k, [...(groups.get(k) ?? []), b]);
	}
	return groups;
}

/**
 * Charge each key `now` holds more of than `had`, listing every breach under
 * it; returns how many were charged.
 * @param {Ctx} ctx
 * @param {string} p
 * @param {Breach[]} now
 * @param {Map<string, Breach[]>} had
 */
function charge(ctx, p, now, had) {
	let charged = 0;
	for (const [k, bs] of byKey(now)) {
		const old = had.get(k)?.length ?? 0;
		const [first] = bs;
		if (first === undefined || bs.length <= old) continue;
		charged += bs.length - old;
		const { function: fn, caught: clause } = first;
		ctx.fail("SWALLOWED", `${p}: ${bs.length - old} uncited swallow in ${fn}`, {
			path: p,
			key: k,
			introduced: bs.length - old,
		});
		// Which of the n is new cannot be told apart, so every one is listed.
		const note =
			old > 0 ? ` (${old} of these ${bs.length} were already in HEAD)` : "";
		ctx.say(
			`${p}: \`except ${clause}\` in ${fn} swallows and cites no ticket${note}`,
		);
		for (const b of bs) ctx.say(`  ${p}:${b.line}`);
	}
	return charged;
}

/** @typedef {{ name: string, text: string }} Source */

/**
 * Every tracked `.py` path, broken if git fails.
 * @param {Ctx} ctx
 * @returns {string[]}
 */
function trackedPython(ctx) {
	const r = spawn("git", ["ls-files", "-z", "--", "*.py"]);
	if (r.status !== 0) ctx.broken(`git ls-files failed: ${r.stderr}`);
	return r.stdout.split("\0").filter(Boolean);
}

/** @typedef {(p: string, text: string) => boolean} IsProgram */

/**
 * Each program path's worktree copy, a path deleted there skipped.
 * @param {string[]} paths
 * @param {IsProgram} isProgram
 * @returns {{ now: Source[], before: Source[] }}
 */
function worktreeSources(paths, isProgram) {
	const now = paths
		.filter((p) => fs.existsSync(p))
		.map((p) => ({ name: p, text: fs.readFileSync(p, "utf8") }))
		.filter(({ name, text }) => isProgram(name, text));
	return { now, before: [] };
}

/**
 * Each program path's staged blob, and its HEAD blob where HEAD has one.
 * @param {Ctx} ctx
 * @param {string[]} paths
 * @param {IsProgram} isProgram
 * @returns {{ now: Source[], before: Source[] }}
 */
function stagedSources(ctx, paths, isProgram) {
	const renamed = renameSources(ctx);
	/** @type {Source[]} */
	const now = [];
	/** @type {Source[]} */
	const before = [];
	for (const p of paths) {
		const staged = blob(`:${p}`);
		if (staged === null) ctx.broken(`${p} has no staged blob`);
		if (!isProgram(p, staged)) continue;
		now.push({ name: p, text: staged });
		const head = blob(`HEAD:${renamed.get(p) ?? p}`);
		if (head !== null) before.push({ name: p, text: head });
	}
	return { now, before };
}

runCheck({
	name: "swallowed-errors",
	usage: "node scripts/check-swallowed-errors.js [--all]",
	flags: ["--all"],
	run(/** @type {Ctx} */ ctx) {
		const isProgram = buildIsProgram(readConfig().pythonRoutes);
		const all = ctx.has("--all");
		const listed = all
			? trackedPython(ctx)
			: stagedDiff(ctx, ["--name-only", "--diff-filter=ACMR"]);
		const paths = listed.filter((p) => p.endsWith(".py"));
		const { now, before } = all
			? worktreeSources(paths, isProgram)
			: stagedSources(ctx, paths, isProgram);
		if (now.length === 0)
			return { okLine: "no program-routed Python path to judge" };
		const judged = walk(ctx, now);
		const had = before.length > 0 ? walk(ctx, before) : new Map();
		let charged = 0;
		for (const { name } of now) {
			const result = judged.get(name);
			if (result?.error !== undefined)
				ctx.say(
					`${name}: does not parse, so not judged here (${result.error})`,
				);
			const found = result?.breaches ?? [];
			const old = had.get(name)?.breaches ?? [];
			if (found.length > 0) charged += charge(ctx, name, found, byKey(old));
		}

		const scope = all ? "" : " introduced";
		if (charged > 0) {
			ctx.say(
				"Each swallow says why at the site and cites the ticket that chose it, or raises or exits (base §N5, #1830).",
			);
			return { noun: `uncited swallow(s)${scope}`, count: charged };
		}
		return {
			okLine: `no uncited swallow${scope} across ${now.length} program-routed Python path(s)`,
		};
	},
});
