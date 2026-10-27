#!/usr/bin/env node
/*
 * check-lockfile-sync.js — refuses a commit whose staged lockfile is out of
 * step with its staged `package.json`, and prints the lockfile rule (#2029).
 *
 * Usage:
 *   node check-lockfile-sync.js [--json] [--warn]
 *
 * The rule lives in docs/agents/rules/lockfile-sync.txt and reaches a
 * session only here.
 *
 * OUT OF STEP means the lockfile's root entry (`packages[""]`) does not mirror
 * each of FIELDS as the manifest declares it, names and ranges both. npm
 * rewrites that entry on every install, so this is stricter than `npm ci`,
 * which passes a root entry still naming a dependency the manifest dropped. A
 * manifest declaring a dependency with no npm lockfile in the index is out of
 * step too.
 *
 * THE INDEX, NOT THE WORKTREE: a neighbour's half-saved manifest is not this
 * commit's.
 *
 * IMPLICIT:  on a commit staging package.json or a lockfile, refuses one whose staged pair is out of step.
 * JUSTIFIED: fail-safe — an index git will not read, or a staged file that is not a JSON object, is BROKEN rather than green.
 * DEFEAT:    --warn caps the finding below the gating line, and pre-commit never passes it. Not seen: a package.json below the root (a workspace member), a v1 lockfile's ranges (it has no root entry, so only names are compared), and a pnpm, Yarn or Bun lockfile, whose repo SKIPs.
 */

const { runCheck } = require("./lib/check.js");
const { readRuleTextOr } = require("./lib/rule-text");
const { caught } = require("./lib/caught.js");
const { spawnGitSync } = require("./lib/git.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/** @typedef {Record<string, unknown>} Json */

const MANIFEST = "package.json";
/* npm reads the shrinkwrap first where both exist. */
const NPM_LOCKS = ["npm-shrinkwrap.json", "package-lock.json"];
const OTHER_LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];

/*
 * An unreadable fragment is check-guard-registry.js's assertion, not a reason
 * to call the lockfile verdict BROKEN (mantahostels#1649's split, as in
 * check-roadmap-valid.js).
 */
function readLockfileRule() {
	return readRuleTextOr(
		"lockfile-sync",
		"Always commit the lockfile with the manifest change that moves it.",
		"check-lockfile-sync",
	).split("\n");
}

/**
 * The staged blob at `file`, or null where the index holds none.
 * @param {Ctx} ctx
 * @param {string} file
 * @returns {string | null}
 */
function readStagedBlob(ctx, file) {
	const listed = spawnGitSync(["ls-files", "--cached", "--", file], {
		encoding: "utf8",
	});
	if (listed.status !== 0) {
		ctx.broken(`cannot read the git index — ${listed.stderr.trim()}`);
	}
	if (!listed.stdout.trim()) return null;
	const blob = spawnGitSync(["show", `:${file}`], { encoding: "utf8" });
	if (blob.status !== 0) {
		ctx.broken(`cannot read the staged ${file} — ${blob.stderr.trim()}`);
	}
	return blob.stdout;
}

/** @param {unknown} v @returns {v is Json} */
const isObject = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * @param {Ctx} ctx
 * @param {string} file
 * @param {string} text
 * @returns {Json}
 */
function parseStaged(ctx, file, text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (e) {
		ctx.broken(`the staged ${file} is not JSON — ${caught(e).message}`);
	}
	if (!isObject(value)) ctx.broken(`the staged ${file} is not a JSON object.`);
	return value;
}

/**
 * A dependency map, or an empty one where the field is absent or not an object.
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
const depMap = (v) => (isObject(v) ? v : {});

/**
 * How one field's locked entries differ from the manifest's. `ranged` false
 * compares names only.
 * @param {string} field
 * @param {Record<string, unknown>} want
 * @param {Record<string, unknown>} have
 * @param {boolean} ranged
 * @returns {string[]}
 */
function fieldDisagreements(field, want, have, ranged) {
	const out = [];
	for (const [name, range] of Object.entries(want)) {
		if (!(name in have)) out.push(`${field}: ${name} is not locked`);
		else if (ranged && have[name] !== range) {
			out.push(
				`${field}: ${name} is ${range} in the manifest, ${have[name]} in the lockfile`,
			);
		}
	}
	if (!ranged) return out;
	for (const name of Object.keys(have)) {
		if (!(name in want)) {
			out.push(`${field}: ${name} is locked but not in the manifest`);
		}
	}
	return out;
}

/**
 * Each way the lock's declared dependencies differ from the manifest's.
 * @param {Json} manifest
 * @param {Json} lock
 * @returns {string[]}
 */
function disagreements(manifest, lock) {
	const root = isObject(lock.packages) ? lock.packages[""] : undefined;
	return FIELDS.flatMap((field) =>
		fieldDisagreements(
			field,
			depMap(manifest[field]),
			depMap(isObject(root) ? root[field] : lock.dependencies),
			isObject(root),
		),
	);
}

/**
 * @param {Ctx} ctx
 * @returns {{ name: string, text: string } | null}
 */
function readStagedNpmLock(ctx) {
	for (const name of NPM_LOCKS) {
		const text = readStagedBlob(ctx, name);
		if (text !== null) return { name, text };
	}
	return null;
}

/** @param {Ctx} ctx */
function run(ctx) {
	const manifestText = readStagedBlob(ctx, MANIFEST);
	if (manifestText === null) return ctx.skip(`no ${MANIFEST} in the index.`);
	const manifest = parseStaged(ctx, MANIFEST, manifestText);
	const lock = readStagedNpmLock(ctx);

	let found;
	if (lock) {
		found = disagreements(manifest, parseStaged(ctx, lock.name, lock.text));
	} else if (OTHER_LOCKS.some((f) => readStagedBlob(ctx, f) !== null)) {
		return ctx.skip("the repo locks with a package manager other than npm.");
	} else {
		const declared = FIELDS.some(
			(f) => Object.keys(depMap(manifest[f])).length > 0,
		);
		found = declared ? [`${MANIFEST} declares dependencies, no lockfile`] : [];
	}

	if (found.length === 0) {
		return { okLine: "the staged lockfile agrees with package.json." };
	}
	const lockName = lock?.name ?? "package-lock.json";
	ctx.fail(
		"OUT-OF-STEP",
		`${lockName} is out of step with ${MANIFEST}: ${found.join("; ")}.`,
	);
	ctx.say(`${lockName} is out of step with the staged ${MANIFEST}:`);
	for (const line of found) ctx.say(`  ${line}`);
	ctx.say("");
	for (const line of readLockfileRule()) ctx.say(line);
	return { noun: "lockfile disagreement(s)", count: found.length };
}

/* Every path the checker reads; .husky/pre-commit arms the gate on each. */
const READS = [MANIFEST, ...NPM_LOCKS, ...OTHER_LOCKS];

if (require.main === module) {
	runCheck({
		name: "lockfile-sync",
		usage: "node check-lockfile-sync.js [--json] [--warn]",
		run,
	});
}

module.exports = { READS };
