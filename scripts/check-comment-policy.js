#!/usr/bin/env node
/*
 * check-comment-policy.js — the comment-policy gate's shell over the
 * permitted kinds (workflow-core#5455), judged by lib/comment-policy.js (workflow-core#5477, workflow-core#5490).
 *
 * Usage:
 *   node check-comment-policy.js [--root <dir>] [--all] [--against <rev>] [--json] [--warn]
 *
 * lib/precommit-gates.js runs it under `--against HEAD` while the `comments`
 * module is on, so a commit is charged only the comments it adds: an edited
 * comment is new, a moved one is not, and a renamed file keeps the comments
 * it brought.
 *
 * IMPLICIT:  with the comments module on, refuses a commit adding a comment to a JS, TS, Python or shell file that fits no permitted kind, or a suppression of a rule off the style-only list, naming the file and line.
 * JUSTIFIED: fail-safe — the fix is deleting or reshaping the comment the commit itself adds.
 * DEFEAT:    --warn caps findings below the gating line; the module off stands the gate down.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { spawnGitSync } = require("./lib/git.js");
const { listTree } = require("./lib/git-objects.js");
const {
	CODE_FILE,
	depsPattern,
	judgeSource,
	langOf,
} = require("./lib/comment-policy.js");
const { readText } = require("./lib/file-read.js");
const STYLE_ONLY = require("./lib/style-only-rules.json").rules;

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/comment-policy.js").FileFacts} FileFacts */
const { baselineOf, runCheck } = require("./lib/check");

const SURFACE = "scripts/lib/helper-surface.json";
const ADR_DIR = "docs/adr";
const SUPPORT = [
	SURFACE,
	ADR_DIR,
	"package.json",
	"pyproject.toml",
	"tsconfig.json",
];
/* The direct requirements: an `.in` file, or `requirements.txt` where it is
 * hand-written; a compiled lock such as requirements-dev.txt names every
 * transitive package. */
const REQUIREMENTS = /^requirements(?:[\w.-]*\.in|\.txt)$/;
/* A guess at what a terminal line shows of a comment beside its path. */
const EXCERPT_MAX = 80;

/**
 * @param {string} root
 * @param {string} rel
 */
const readOr = (root, rel) => {
	const r = readText(path.join(root, rel));
	if (r.state === "unreadable") throw new Error(r.message);
	return r.state === "read" ? r.data : null;
};

/**
 * The tree's files, as a materialised side holds them.
 * @param {Ctx} ctx
 * @param {string} root
 * @param {boolean} walked
 * @returns {string[]}
 */
function readTreeFiles(ctx, root, walked) {
	if (!walked) {
		const r = spawnGitSync(["ls-files", "-s", "-z"], {
			cwd: root,
			encoding: "utf8",
		});
		if (r.status !== 0) ctx.broken(`git ls-files failed: ${r.stderr}`);
		return r.stdout
			.split("\0")
			.filter((e) => /^100(?:644|755) /.test(e))
			.map((e) => e.slice(e.indexOf("\t") + 1))
			.sort();
	}
	/** @type {string[]} */
	const out = [];
	/** @param {string} rel */
	const walk = (rel) => {
		for (const e of fs.readdirSync(path.join(root, rel), {
			withFileTypes: true,
		})) {
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git")
				walk(child);
			else if (e.isFile()) out.push(child);
		}
	};
	walk("");
	return out.sort();
}

const PACKAGE_KEYS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];

/**
 * The names each requirements file's lines open with.
 * @param {string} root
 */
function readRequirementDeps(root) {
	const files = fs.existsSync(root)
		? fs.readdirSync(root).filter((n) => REQUIREMENTS.test(n))
		: [];
	return files.flatMap((name) =>
		[
			...(readOr(root, name) ?? "").matchAll(/^[ \t]*([A-Za-z0-9][\w.-]*)/gm),
		].map((m) => m[1] ?? ""),
	);
}

/**
 * Every dependency name the tree's manifests declare.
 * @param {string} root
 */
function readManifestDeps(root) {
	const pkg = JSON.parse(readOr(root, "package.json") ?? "{}");
	const pyproject = readOr(root, "pyproject.toml") ?? "";
	const fromPyproject = [
		...pyproject.matchAll(/dependencies\s*=\s*\[([^\]]*)\]/g),
	].flatMap((block) =>
		[...(block[1] ?? "").matchAll(/["']([A-Za-z0-9][\w.-]*)/g)].map(
			(m) => m[1] ?? "",
		),
	);
	return [
		...PACKAGE_KEYS.flatMap((key) => Object.keys(pkg[key] ?? {})),
		...readRequirementDeps(root),
		...fromPyproject,
	].filter(Boolean);
}

/**
 * The facts every file's verdict shares.
 * @param {string} root
 */
function readTreeFacts(root) {
	const surface = JSON.parse(readOr(root, SURFACE) ?? "{}");
	const adrDir = path.join(root, ADR_DIR);
	const adrs = new Set(
		(fs.existsSync(adrDir) ? fs.readdirSync(adrDir) : []).flatMap((name) => {
			const m = /^(\d{4})-.*\.md$/.exec(name);
			return m?.[1] ? [m[1]] : [];
		}),
	);
	return {
		/** @type {Record<string, string[]>} */
		entryPoints: surface.entryPoints ?? {},
		commands: new Set(Object.keys(surface.commands ?? {})),
		adrs,
		deps: depsPattern(readManifestDeps(root)),
		checkJs: /"checkJs"\s*:\s*true/.test(readOr(root, "tsconfig.json") ?? ""),
	};
}

/**
 * The paths the commit changes, and each rename's source.
 * @param {Ctx} ctx
 */
function readChangedPaths(ctx) {
	const rev = baselineOf(ctx.value("--against", "HEAD"));
	const head = ctx.value("--head", "");
	const args = head
		? ["diff", "-z", "--name-status", "-M", rev, head]
		: ["diff", "--cached", "-z", "--name-status", "-M", rev];
	const r = spawnGitSync(args, { encoding: "utf8" });
	if (r.status !== 0) ctx.broken(`git ${args.join(" ")} failed: ${r.stderr}`);
	const fields = r.stdout.split("\0").filter(Boolean);
	/** @type {string[]} */
	const paths = [];
	/** @type {Map<string, string>} */
	const renames = new Map();
	for (let i = 0; i < fields.length; ) {
		const status = fields[i] ?? "";
		const moved = /^[RC]/.test(status);
		const from = fields[i + 1] ?? "";
		const to = moved ? (fields[i + 2] ?? "") : from;
		i += moved ? 3 : 2;
		if (status.startsWith("D")) continue;
		paths.push(to);
		if (status.startsWith("R")) renames.set(to, from);
	}
	return { paths, renames };
}

/** @type {WeakMap<Ctx, ReturnType<typeof readChangedPaths>>} */
const changed = new WeakMap();

/**
 * The commit's changed paths, read once a run for both sides and the settle.
 * @param {Ctx} ctx
 */
const changedOnce = (ctx) => {
	const known = changed.get(ctx);
	if (known) return known;
	const read = readChangedPaths(ctx);
	changed.set(ctx, read);
	return read;
};

/**
 * What a side materialises: the changed code paths, each rename's source,
 * and the files the verdicts read.
 * @param {Ctx} ctx
 * @param {string} rev
 */
function sidePaths(ctx, rev) {
	const { paths, renames } = changedOnce(ctx);
	const requirements = listTree(rev, [], { recursive: false })
		.map((e) => e.path)
		.filter((p) => REQUIREMENTS.test(p));
	const code = [...paths, ...renames.values()].filter((p) => CODE_FILE.test(p));
	return [...SUPPORT, ...requirements, ...code];
}

/** @param {unknown} item */
const identity = (item) => {
	const f = /** @type {Record<string, unknown>} */ (item);
	return JSON.stringify([f.tag, f.file, f.match, f.nth]);
};

/**
 * The added breaches less those a renamed file brought from its source.
 * @param {Ctx} ctx
 * @param {import("./lib/check").FaultItem[]} added
 * @param {{ baseline: Record<string, unknown> | undefined }} sides
 */
function settle(ctx, added, { baseline }) {
	const { renames } = changedOnce(ctx);
	const had = new Set(
		/** @type {unknown[]} */ (baseline?.findings ?? []).map(identity),
	);
	const refuse = added.filter((f) => {
		const item = /** @type {Record<string, unknown>} */ (f.item);
		const from = renames.get(String(item.file));
		return !from || !had.has(identity({ ...item, file: from }));
	});
	return { refuse, remedy: REMEDY };
}

const REMEDY = [
	"Delete each comment, or reshape it to a permitted kind (workflow-core#5455): a licence header; a suppression of a rule on scripts/lib/style-only-rules.json; a bare `#N`, `ADR-NNNN` or RFC pointer; a one-line `measured` or `guess` derivation with its `#N`; a note naming its source, a URL or a manifest dependency; a doc on an export the helper surface lists.",
];

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "comment-policy",
	usage:
		"node check-comment-policy.js [--root <dir>] [--all] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	flags: ["--all"],
	against: {
		profile: "comment-policy",
		materialise: "blobs",
		pathspecs: sidePaths,
		settle,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		if (!fs.existsSync(root))
			ctx.broken(`the host root ${root} does not exist — nothing was read`);
		const tree = readTreeFacts(root);
		/** @type {Map<string, number>} */
		const perFile = new Map();
		let judged = 0;
		for (const rel of readTreeFiles(ctx, root, ctx.has("--root"))) {
			const text = readOr(root, rel);
			const lang = text === null ? null : langOf(rel, text);
			if (text === null || lang === null) continue;
			judged++;
			const n = judgeFile(ctx, rel, text, factsFor(tree, rel, lang));
			if (n > 0) perFile.set(rel, n);
		}
		if (ctx.has("--all")) printCounts(ctx, perFile);
		return {
			okLine: `${judged} code file(s), every comment a permitted kind.`,
			noun: `comment breach(es) in ${perFile.size} of ${judged} code file(s)`,
			count: ctx.findings.length,
			data: { files: judged, perFile: Object.fromEntries(perFile) },
		};
	},
};

/**
 * @param {ReturnType<typeof readTreeFacts>} tree
 * @param {string} rel
 * @param {import("./lib/comment-policy.js").Lang} lang
 * @returns {FileFacts}
 */
const factsFor = (tree, rel, lang) => ({
	lang,
	checkJs: tree.checkJs && /\.[cm]?jsx?$/.test(rel),
	exports: new Set(tree.entryPoints[rel] ?? []),
	shipped: rel in tree.entryPoints || tree.commands.has(rel),
	adrs: tree.adrs,
	deps: tree.deps,
	styleOnly: STYLE_ONLY,
});

/**
 * Record one file's breaches; returns how many.
 * @param {Ctx} ctx
 * @param {string} rel
 * @param {string} text
 * @param {FileFacts} facts
 */
function judgeFile(ctx, rel, text, facts) {
	/** @type {Map<string, number>} */
	const seen = new Map();
	const breaches = judgeSource(text, facts);
	for (const b of breaches) {
		const nth = (seen.get(`${b.tag}\t${b.match}`) ?? 0) + 1;
		seen.set(`${b.tag}\t${b.match}`, nth);
		const shown =
			b.match.length > EXCERPT_MAX
				? `${b.match.slice(0, EXCERPT_MAX - 3)}…`
				: b.match;
		const message = `${rel}:${b.line}  ${shown} — ${b.why}`;
		ctx.fail(b.tag, message, { file: rel, line: b.line, match: b.match, nth });
		if (!ctx.has("--all")) ctx.say(`  ${message}`);
	}
	return breaches.length;
}

/**
 * The per-file counts, most first.
 * @param {Ctx} ctx
 * @param {Map<string, number>} perFile
 */
function printCounts(ctx, perFile) {
	const rows = [...perFile].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);
	for (const [rel, n] of rows) ctx.say(`${String(n).padStart(6)}  ${rel}`);
}

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
