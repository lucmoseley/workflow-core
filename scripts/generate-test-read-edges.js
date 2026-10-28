#!/usr/bin/env node
/*
 * generate-test-read-edges.js — renders docs/test-read-edges.json.
 *
 * Usage:
 *   node scripts/generate-test-read-edges.js [--check] [--root <dir>] [--only <path>...]
 *   node scripts/generate-test-read-edges.js --unseen [--root <dir>]
 *
 * --check  render the index into memory and diff against the manifest the
 *          index holds; exit 1 on a difference, printing what moved. This is
 *          what the pre-commit gate runs, so a stale manifest cannot be
 *          committed — and the index is what the commit carries (#557).
 * --only   render what `git commit -- <path>...` will carry — HEAD plus those
 *          paths from disk — rather than the whole working tree; a named
 *          intent-to-add entry over a HEAD path is dropped, as the bare
 *          commit a refused --check judged drops it. Every positional is
 *          a path, and a positional without --only refuses.
 * --unseen list every read in the tree's tests the selector cannot attribute,
 *          writing nothing (#1881). --check warns about the same reads in the
 *          test files the commit adds or changes, and never refuses on one: an
 *          anchored read the extractor cannot resolve may be a tempdir or
 *          sibling fixture, so it is an inference (base §S4).
 *
 * The write judges the disk; --check judges the index. The two disagree
 * while the tree holds work the commit leaves out, which is what --only is for.
 *
 * The manifest is `generated-only`: never hand-edited. What an edge means and
 * why the pass is lexical: scripts/lib/test-read-edges.js's header.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { gitList } = require("./lib/test-read-edges.js");
const { execGit, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { OUT, hasHead, render } = require("./lib/read-edges-render.js");

/**
 * Files this render actually read — every test file `buildManifest` scanned
 * and every one-hop helper it resolved, plus the extractor's and the render's own files —
 * that also carry an uncommitted change right now (mantahostels#2270).
 *
 * Scoped to what was actually READ, not to the render's output: a dirty test
 * file whose edit REMOVES a read literal yields no edge and so is absent from
 * `edges` entirely — the under-population direction mantahostels#2270 warns about.
 *
 * NEVER THROWS, AND A `[]` IS NOT PROOF THE TREE WAS CLEAN: a repo with no
 * HEAD, a wedged git, a dirty tree past `maxBuffer` — every one of those is
 * answered `[]`, same as a genuinely clean tree.
 *
 * WARN, never refuse: dirty is inferred, not a structured fact, and the
 * dirty file may simply be this session's own in-progress work (mantahostels#103 §6's
 * warn-not-deny line).
 *
 * @param {string} root
 * @param {Set<string>} read
 * @returns {string[]}
 */
function readDirtyContributors(root, read) {
	let changed;
	try {
		changed = execGit(["diff", "--name-only", "-z", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\0")
			.filter(Boolean);
	} catch {
		return [];
	}
	const used = new Set([
		"scripts/generate-test-read-edges.js",
		"scripts/lib/test-read-edges.js",
		"scripts/lib/read-edges-render.js",
		...read,
	]);
	return changed.filter((f) => used.has(f)).sort();
}

/**
 * The files a commit adds or changes: the `--only` paths, else the index's
 * changes against HEAD, or the whole index before the first commit.
 * @param {string} root
 * @param {string[] | undefined} only
 * @returns {Set<string>}
 */
function readCommittedFiles(root, only) {
	if (only) return new Set(only);
	try {
		return new Set(
			gitList(
				root,
				hasHead(root)
					? ["diff", "--cached", "--name-only", "-z", "--diff-filter=d", "HEAD"]
					: ["ls-files", "-z"],
			),
		);
	} catch (e) {
		/* Fails open (#1881), said, so a silence is not read as a clean commit. */
		writeFd(
			2,
			`${OUT}: unseen-read warning skipped, git could not list the commit's files: ${e instanceof Error ? e.message : e}\n`,
		);
		return new Set();
	}
}

/**
 * @param {Record<string, import("./lib/test-read-edges.js").Site[]>} unseen
 * @param {(file: string) => boolean} keep
 * @returns {string[]}
 */
const buildSiteLines = (unseen, keep) =>
	Object.entries(unseen)
		.filter(([file]) => keep(file))
		.flatMap(([file, sites]) =>
			sites.map((s) => `${file}:${s.line}: ${s.shape}`),
		);

const WAYS_OUT =
	"Name the path as a literal the test or a helper it imports spells, so a " +
	"change to that file selects the test, or add a `full-sweep-only: <why>` " +
	"line to the test's header comment, leaving its reads to the full run.";

/**
 * The command that makes this commit's manifest fresh: the plain write where
 * the disk renders as this commit does, otherwise the `--only` write for the
 * commit's own paths (#557). Those paths are the index's changes against HEAD:
 * on a pathspec commit, exactly the pathspec.
 *
 * @param {string} root
 * @param {string} text  what the index renders
 */
function regenerateCommand(root, text) {
	const plain = "npm run gen:test-read-edges";
	try {
		if (render(root).text === text) return plain;
		const paths = gitList(root, [
			"diff",
			"--cached",
			"--name-only",
			"-z",
			"HEAD",
		]).filter((p) => p !== OUT);
		const q = (/** @type {string} */ p) =>
			/^[\w./@+-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`;
		return (
			`${plain} -- --only ${[...paths, OUT].map(q).join(" ")}\n` +
			"  (the tree holds changes this commit leaves out, so a plain regenerate would not converge)"
		);
	} catch {
		return plain;
	}
}

/**
 * @param {string} root
 * @param {boolean} narrowed  --check or --only was passed too, which a
 *   listing of the working tree cannot honour
 * @returns {number}  1 on a narrowing flag, else 0
 */
function listUnseen(root, narrowed) {
	if (narrowed) {
		writeFd(
			2,
			`--unseen lists the working tree and takes neither --check nor --only\n${CLI.usage}\n`,
		);
		return 1;
	}
	const lines = buildSiteLines(
		render(root, { sites: true }).unseen,
		() => true,
	);
	writeFd(
		1,
		lines.map((l) => `${l}\n`).join("") +
			`${lines.length} read(s) the diff selector cannot attribute.\n` +
			(lines.length > 0 ? `${WAYS_OUT}\n` : ""),
	);
	return 0;
}

/**
 * Warns about the unseen reads in the test files this commit adds or
 * changes.
 * @param {string} root
 * @param {string[] | undefined} only
 * @param {Record<string, import("./lib/test-read-edges.js").Site[]>} unseen
 * @returns {void}
 */
function warnUnseen(root, only, unseen) {
	const committed = readCommittedFiles(root, only);
	const lines = buildSiteLines(unseen, (f) => committed.has(f));
	if (lines.length === 0) return;
	writeFd(
		2,
		`${OUT}: warning: ${lines.length} read(s) in this commit's tests the diff selector cannot attribute, so a change to what they read never selects them:\n` +
			lines.map((l) => `  ${l}\n`).join("") +
			`${WAYS_OUT}\n`,
	);
}

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage:
		"usage: node scripts/generate-test-read-edges.js [--check | --unseen] [--root <dir>] [--only <path>...]",
	flags: {
		"--check": "boolean",
		"--root": "value",
		"--only": "boolean",
		"--unseen": "boolean",
	},
	max: Number.POSITIVE_INFINITY,
};

/**
 * argv as the run it asks for, or the exit code of a usage refusal.
 * @param {string[]} argv
 * @returns {number | { root: string, check: boolean, only: string[] | undefined, unseen: boolean }}
 */
function parseArgs(argv) {
	const parsed = parseOrCode(argv, CLI);
	/* A usage refusal is 2 from cli-args; a generator exits 0 or 1 (base §N3). */
	if (typeof parsed === "number") return parsed === 0 ? 0 : 1;
	const { flags, positionals } = parsed;
	if (positionals.length > 0 && !flags["--only"]) {
		writeFd(2, `paths need --only\n${CLI.usage}\n`);
		return 1;
	}
	return {
		root: flagValue(flags, "--root") ?? process.cwd(),
		check: Boolean(flags["--check"]),
		only: flags["--only"] ? positionals : undefined,
		unseen: Boolean(flags["--unseen"]),
	};
}

function main(argv = process.argv.slice(2)) {
	const opts = parseArgs(argv);
	if (typeof opts === "number") return opts;
	const { root, check, only } = opts;
	const target = path.join(root, OUT);
	if (opts.unseen) return listUnseen(root, check || Boolean(only));
	const { text, edges, anchored, tests, read, tree, warnings, unseen } = render(
		root,
		{ index: check, only, sites: check },
	);
	/* An unresolved `source` is an edge this manifest cannot carry (#657). */
	for (const w of warnings) writeFd(2, `${OUT}: warning: ${w}\n`);

	if (!check) {
		fs.writeFileSync(target, text);
		process.stdout.write(
			`${OUT}: ${Object.keys(edges).length} file(s) read by ${anchored} of ${tests} test file(s)\n`,
		);
		const dirty = readDirtyContributors(root, read);
		if (dirty.length > 0)
			writeFd(
				2,
				`${OUT}: ${dirty.length} file(s) this render used are uncommitted right now — ` +
					"this write may have read a neighbour's in-progress edit (mantahostels#2270). " +
					"Re-run once the tree is still:\n" +
					dirty.map((f) => `  ${f}\n`).join(""),
			);
		return 0;
	}

	warnUnseen(root, only, unseen);

	/* The manifest the commit carries, not the one on disk. */
	const have = tree.tracked.has(OUT) ? tree.read(OUT) : "";
	if (have === text) return 0;

	/* Name the rows that moved, not a diff: the row names which test did it,
	 * and the fix is the same command without --check. */
	const before = have ? (JSON.parse(have).edges ?? {}) : {};
	const keys = new Set([...Object.keys(before), ...Object.keys(edges)]);
	const moved = [...keys]
		.filter((k) => (before[k] ?? []).join("\n") !== (edges[k] ?? []).join("\n"))
		.sort();
	writeFd(
		2,
		`${OUT} is stale — ${moved.length} file(s) changed their reader set:\n` +
			`${moved
				.slice(0, 20)
				.map(
					(k) =>
						`  ${k}: ${(before[k] ?? []).length} -> ${(edges[k] ?? []).length} reader(s)\n`,
				)
				.join("")}` +
			(moved.length > 20 ? `  … and ${moved.length - 20} more\n` : "") +
			`Regenerate it:\n  ${regenerateCommand(root, text)}\n`,
	);
	return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main };
