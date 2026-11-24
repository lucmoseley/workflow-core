#!/usr/bin/env node

const fs = require("node:fs");
const { capture } = require("./lib/check-sink.js");
const { writeFd } = require("./lib/write-fd.js");

/** @typedef {import("./lib/write-fd.js").Write} Write */
const path = require("node:path");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { gitList } = require("./lib/test-read-edges.js");
const { execGit, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { OUT, hasHead, render } = require("./lib/read-edges-render.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { scriptPath } = require("./lib/script-path.js");

/**
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
 * @param {string} root
 * @param {string[] | undefined} only
 * @param {Write} write
 * @returns {Set<string>}
 */
function readCommittedFiles(root, only, write) {
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
		// workflow-core#1881
		write(
			2,
			`${OUT}: unseen-read warning skipped, git could not list the commit's files: ${e instanceof Error ? e.message : e}\n`,
		);
		return new Set();
	}
}

/**
 * @param {string} root
 * @param {string[] | undefined} only
 * @returns {boolean}
 */
function hasManifest(root, only) {
	if (only?.includes(OUT)) return true;
	if (gitList(root, ["ls-files", "-z", "--", OUT]).length > 0) return true;
	return (
		hasHead(root) &&
		gitList(root, ["ls-tree", "-z", "--name-only", "HEAD", "--", OUT]).length >
			0
	);
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
	"change to that file selects the test, or add a `full-sweep-only: #N` " +
	"line, the issue saying why, to the test's header, leaving its reads to the full run.";

/**
 * @param {string} root
 * @param {string} text
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
		return (
			`${plain} -- --only ${[...paths, OUT].map(shellQuote).join(" ")}\n` +
			"  (the tree holds changes this commit leaves out, so a plain regenerate would not converge)"
		);
	} catch {
		return plain;
	}
}

/**
 * @param {string} root
 * @param {boolean} narrowed
 * @returns {number}
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
 * @param {string} root
 * @param {string[] | undefined} only
 * @param {Record<string, import("./lib/test-read-edges.js").Site[]>} unseen
 * @param {Write} write
 * @returns {void}
 */
function warnUnseen(root, only, unseen, write) {
	const committed = readCommittedFiles(root, only, write);
	const lines = buildSiteLines(unseen, (f) => committed.has(f));
	if (lines.length === 0) return;
	write(
		2,
		`${OUT}: warning: ${lines.length} read(s) in this commit's tests the diff selector cannot attribute, so a change to what they read never selects them:\n` +
			lines.map((l) => `  ${l}\n`).join("") +
			`${WAYS_OUT}\n`,
	);
}

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: `usage: node ${scriptPath("generate-test-read-edges.js")} [--check | --unseen] [--root <dir>] [--only <path>...]`,
	flags: {
		"--check": "boolean",
		"--root": "value",
		"--only": "boolean",
		"--unseen": "boolean",
	},
	max: Number.POSITIVE_INFINITY,
};

/**
 * @param {string[]} argv
 * @returns {number | { root: string, check: boolean, only: string[] | undefined, unseen: boolean }}
 */
function parseArgs(argv) {
	const parsed = parseOrCode(argv, CLI);
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
	if (opts.unseen) return listUnseen(root, check || Boolean(only));
	if (check) return checkAt(root, only, writeFd);
	const { text, edges, anchored, tests, read, warnings } = render(root, {
		index: false,
		only,
		sites: false,
	});
	for (const w of warnings) writeFd(2, `${OUT}: warning: ${w}\n`);
	fs.writeFileSync(path.join(root, OUT), text);
	writeFd(
		1,
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

/**
 * @param {string} root
 * @param {string[] | undefined} only
 * @param {Write} write
 * @returns {number}
 */
function checkAt(root, only, write) {
	if (!hasManifest(root, only)) return 0;
	const { text, edges, tree, warnings, unseen } = render(root, {
		index: true,
		only,
		sites: true,
	});
	for (const w of warnings) write(2, `${OUT}: warning: ${w}\n`);
	warnUnseen(root, only, unseen, write);

	const have = tree.tracked.has(OUT) ? tree.read(OUT) : "";
	if (have === text) return 0;

	const before = have ? (JSON.parse(have).edges ?? {}) : {};
	const keys = new Set([...Object.keys(before), ...Object.keys(edges)]);
	const moved = [...keys]
		.filter((k) => (before[k] ?? []).join("\n") !== (edges[k] ?? []).join("\n"))
		.sort();
	write(
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

/** @type {import("./lib/precommit-gates.js").Program} */
const PROGRAM = ({ cwd }) => capture((write) => checkAt(cwd, undefined, write));

if (require.main === module) process.exit(main());

module.exports = { main, PROGRAM };
