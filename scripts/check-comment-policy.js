#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
const { spawnGitSync } = require("./lib/git.js");
const { listTree } = require("./lib/git-objects.js");
const { readAttributeExcluded } = require("./lib/git-attributes.js");
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
const PLUGIN_SURFACE = path.join(__dirname, "lib", "helper-surface.json");
const ADR_DIR = "docs/adr";
const SUPPORT = [
	SURFACE,
	ADR_DIR,
	"package.json",
	"pyproject.toml",
	"tsconfig.json",
];
const DIRECT_REQUIREMENTS = /^requirements(?:[\w.-]*\.in|\.txt)$/;
// guess, #5490
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
 * @param {Ctx} ctx
 * @param {string} root
 * @param {boolean} walked
 * @returns {string[]}
 */
function readTreeFiles(ctx, root, walked) {
	if (!walked) return readTrackedPaths(ctx, root).sort();
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
 * @param {string} root
 */
function readRequirementDeps(root) {
	const files = fs.existsSync(root)
		? fs.readdirSync(root).filter((n) => DIRECT_REQUIREMENTS.test(n))
		: [];
	return files.flatMap((name) =>
		[
			...(readOr(root, name) ?? "").matchAll(/^[ \t]*([A-Za-z0-9][\w.-]*)/gm),
		].map((m) => m[1] ?? ""),
	);
}

/**
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
 * @param {string} root
 */
function readTreeFacts(root) {
	const surface = JSON.parse(readOr(root, SURFACE) ?? "{}");
	const pluginSurface = JSON.parse(fs.readFileSync(PLUGIN_SURFACE, "utf8"));
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
		/** @type {Set<string>} */
		copies: new Set(pluginSurface.copies),
		adrs,
		deps: depsPattern(readManifestDeps(root)),
		checkJs: /"checkJs"\s*:\s*true/.test(readOr(root, "tsconfig.json") ?? ""),
	};
}

/**
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

/**
 * @param {Ctx} ctx
 * @param {ReturnType<typeof readChangedPaths>} read
 * @param {string} head
 */
function dropAttributeExcluded(ctx, { paths, renames }, head) {
	const excluded = readExcludedOrBroken(ctx, paths, {
		from: head ? { rev: head } : "index",
	});
	return {
		paths: paths.filter((p) => !excluded.has(p)),
		renames: new Map([...renames].filter(([to]) => !excluded.has(to))),
	};
}

/**
 * @param {Ctx} ctx
 * @param {string[]} paths
 * @param {import("./lib/git-attributes.js").AttributeRead} read
 * @returns {Set<string>}
 */
function readExcludedOrBroken(ctx, paths, read) {
	try {
		return readAttributeExcluded(paths, read);
	} catch (e) {
		return ctx.broken(e instanceof Error ? e.message : String(e));
	}
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {string[]}
 */
function readJudgedFiles(ctx, root) {
	const walked = ctx.has("--root");
	const files = readTreeFiles(ctx, root, walked);
	if (ctx.side) return files;
	const env = walked ? withoutGitRedirects() : undefined;
	if (!inWorkTree(ctx, root, env)) return files;
	const tracked = walked ? new Set(readTrackedPaths(ctx, root, env)) : null;
	const judged = tracked ? files.filter((p) => tracked.has(p)) : files;
	const excluded = readExcludedOrBroken(ctx, judged, {
		from: walked ? "worktree" : "index",
		cwd: root,
		env,
	});
	return judged.filter((p) => !excluded.has(p));
}

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function readTrackedPaths(ctx, root, env) {
	const r = spawnGitSync(["ls-files", "-s", "-z"], {
		cwd: root,
		encoding: "utf8",
		...(env ? { env } : {}),
	});
	if (r.status !== 0) ctx.broken(`git ls-files failed: ${r.stderr}`);
	return r.stdout
		.split("\0")
		.filter((e) => /^100(?:644|755) /.test(e))
		.map((e) => e.slice(e.indexOf("\t") + 1));
}

const withoutGitRedirects = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(k),
		),
	);

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 */
function inWorkTree(ctx, root, env) {
	const r = spawnGitSync(["rev-parse", "--is-inside-work-tree"], {
		cwd: root,
		encoding: "utf8",
		...(env ? { env } : {}),
	});
	if (r.error) ctx.broken(`git rev-parse failed: ${r.error.message}`);
	return r.status === 0 && r.stdout.trim() === "true";
}

/** @type {WeakMap<Ctx, ReturnType<typeof dropAttributeExcluded>>} */
const changed = new WeakMap();

/**
 * @param {Ctx} ctx
 */
const changedOnce = (ctx) => {
	const known = changed.get(ctx);
	if (known) return known;
	const read = dropAttributeExcluded(
		ctx,
		readChangedPaths(ctx),
		ctx.value("--head", ""),
	);
	changed.set(ctx, read);
	return read;
};

/**
 * @param {Ctx} ctx
 * @param {string} rev
 */
function sidePaths(ctx, rev) {
	const { paths, renames } = changedOnce(ctx);
	const requirements = listTree(rev, [], { recursive: false })
		.map((e) => e.path)
		.filter((p) => DIRECT_REQUIREMENTS.test(p));
	const code = [...paths, ...renames.values()].filter((p) => CODE_FILE.test(p));
	return [...SUPPORT, ...requirements, ...code];
}

/** @param {unknown} item */
const identity = (item) => {
	const f = /** @type {Record<string, unknown>} */ (item);
	return JSON.stringify([f.tag, f.file, f.match, f.nth]);
};

/**
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
	"Delete each comment, or reshape it to a permitted kind (#5455): a licence header; a suppression of a rule on scripts/lib/style-only-rules.json; a bare `#N`, `ADR-NNNN` or RFC pointer; a one-line `measured` or `guess` derivation with its `#N`; a note of at most two lines naming its source, a URL, other than a link behind a `#N` pointer, or a manifest dependency; a doc on an export the helper surface lists; atop a file it lists, a usage block that invokes the file and cites no issue.",
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
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
		if (!fs.existsSync(root))
			ctx.broken(`the root ${root} does not exist — nothing was read`);
		const tree = readTreeFacts(root);
		/** @type {Map<string, number>} */
		const perFile = new Map();
		let judged = 0;
		for (const rel of readJudgedFiles(ctx, root)) {
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
	checkJs: (tree.checkJs || tree.copies.has(rel)) && /\.[cm]?jsx?$/.test(rel),
	exports: new Set(tree.entryPoints[rel] ?? []),
	shipped:
		rel in tree.entryPoints || tree.commands.has(rel) || tree.copies.has(rel),
	name: path.basename(rel),
	adrs: tree.adrs,
	deps: tree.deps,
	styleOnly: STYLE_ONLY,
});

/**
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
