#!/usr/bin/env node

const { runCheck } = require("./lib/check.js");
const { readRuleTextOr } = require("./lib/rule-text");
const { caught } = require("./lib/caught.js");
const { spawnGitSync } = require("./lib/git.js");
const { readStagedDiff } = require("./lib/staged.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {Record<string, unknown>} Json */

const MANIFEST = "package.json";
const NPM_LOCKS = ["npm-shrinkwrap.json", "package-lock.json"];
const OTHER_LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];
const READS = [MANIFEST, ...NPM_LOCKS, ...OTHER_LOCKS];

function readLockfileRule() {
	return readRuleTextOr(
		"lockfile-sync",
		"Always commit the lockfile with the manifest change that moves it",
		"check-lockfile-sync",
	).split("\n");
}

/**
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
 * @param {unknown} v
 * @returns {Record<string, unknown>}
 */
const depMap = (v) => (isObject(v) ? v : {});

/**
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
	const touched = readStagedDiff(ctx, [
		"--name-only",
		"--no-renames",
		"--",
		...READS.map((f) => `:(top)${f}`),
	]);
	if (touched.length === 0) {
		return ctx.skip(`this commit stages neither ${MANIFEST} nor a lockfile.`);
	}
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

const SPEC = {
	name: "lockfile-sync",
	usage: "node check-lockfile-sync.js [--json] [--warn]",
	run,
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
