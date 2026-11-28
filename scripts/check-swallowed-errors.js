#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { runCheck } = require("./lib/check");
const {
	readBlob,
	readRenameSources,
	spawn,
	readStagedDiff,
} = require("./lib/staged");
const { spawnGitSync } = require("./lib/git.js");
const { globMatches } = require("./lib/pathspec-glob.js");
const { pythonRouteKind } = require("./lib/python-routes.js");
const { readConfig } = require("./lib/workflow-core-config.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { scriptPath } = require("./lib/script-path.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/workflow-core-config.js").PythonKind} PythonKind */
/** @typedef {{ line: number, function: string, caught: string }} Breach */
/** @typedef {{ name: string, breaches?: Breach[], error?: string }} Result */

const WALK = path.join(__dirname, "swallowed_errors.py");

/**
 * @param {Record<string, PythonKind> | undefined} declared
 * @returns {(p: string, text: string) => boolean}
 */
const buildIsProgram = (declared) => (p, text) => {
	const kind = pythonRouteKind(declared, p);
	if (kind) return kind === "program";
	return !globMatches("**/test/**", p) && text.startsWith("#!");
};

const PYTHON_INSTALL =
	"sudo apt install python3, brew install python3, or python.org/downloads";

/**
 * @param {Ctx} ctx
 * @param {Source[]} sources
 * @returns {Map<string, Result>}
 */
function walk(ctx, sources) {
	const r = spawn("python3", [WALK], JSON.stringify({ sources }));
	if (r.error)
		ctx.broken(
			`cannot run python3: ${r.error.message}${
				/** @type {NodeJS.ErrnoException} */ (r.error).code === "ENOENT"
					? ` — install it: ${PYTHON_INSTALL}`
					: ""
			}`,
		);
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
		ctx.fail("SWALLOWED", `${p}: ${bs.length - old} swallow in ${fn}`, {
			path: p,
			key: k,
			introduced: bs.length - old,
		});
		const note =
			old > 0 ? ` (${old} of these ${bs.length} were already in HEAD)` : "";
		ctx.say(`${p}: \`${clause}\` in ${fn} swallows its error${note}`);
		for (const b of bs) ctx.say(`  ${p}:${b.line}`);
	}
	return charged;
}

/** @typedef {{ name: string, text: string }} Source */

/**
 * @param {Ctx} ctx
 * @returns {string[]}
 */
function readTrackedPython(ctx) {
	const r = spawnGitSync(["ls-files", "-z", "--", "*.py"], {
		encoding: "utf8",
	});
	if (r.status !== 0) ctx.broken(`git ls-files failed: ${r.stderr}`);
	return r.stdout.split("\0").filter(Boolean);
}

/** @typedef {(p: string, text: string) => boolean} IsProgram */

/**
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
 * @param {Ctx} ctx
 * @param {string[]} paths
 * @param {IsProgram} isProgram
 * @returns {{ now: Source[], before: Source[] }}
 */
function readStagedSources(ctx, paths, isProgram) {
	const renamed = readRenameSources(ctx);
	/** @type {Source[]} */
	const now = [];
	/** @type {Source[]} */
	const before = [];
	for (const p of paths) {
		const staged = readBlob(`:${p}`);
		if (staged === null) ctx.broken(`${p} has no staged blob`);
		if (!isProgram(p, staged)) continue;
		now.push({ name: p, text: staged });
		const head = readBlob(`HEAD:${renamed.get(p) ?? p}`);
		if (head !== null) before.push({ name: p, text: head });
	}
	return { now, before };
}

runCheck({
	name: "swallowed-errors",
	usage: `node ${scriptPath("check-swallowed-errors.js")} [--all]`,
	flags: ["--all"],
	run(/** @type {Ctx} */ ctx) {
		const isProgram = buildIsProgram(
			readConfig({ root: worktreeRoot() }).pythonRoutes,
		);
		const all = ctx.has("--all");
		const listed = all
			? readTrackedPython(ctx)
			: readStagedDiff(ctx, ["--name-only", "--diff-filter=ACMR"]);
		const paths = listed.filter((p) => p.endsWith(".py"));
		const { now, before } = all
			? worktreeSources(paths, isProgram)
			: readStagedSources(ctx, paths, isProgram);
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
				"Each `except`, broad `suppress` and catching `__exit__` raises, exits, or hands its error to `fail_open` from scripts/lib/fail_open.py, which prints it, with a test pinning the fail-open (base §N5, #5487, #5561).",
			);
			return { noun: `swallow(s)${scope}`, count: charged };
		}
		return {
			okLine: `no swallow${scope} across ${now.length} program-routed Python path(s)`,
		};
	},
});
