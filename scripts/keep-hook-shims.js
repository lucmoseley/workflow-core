#!/usr/bin/env node
/*
 * keep-hook-shims.js — the entry for lib/hook-shims.js (#2879): writes an
 * exit-0 shim at each hook script a live session still runs after the main
 * checkout deleted it, and removes each shim no live session needs.
 *
 * IN NO PROGRAM FAMILY (§N3): a git hook's helper, run by .husky/post-commit
 * and .husky/post-merge, which git ignores the exit of. It gates nothing and
 * files nothing.
 *
 * Runs on the MAIN worktree, whichever worktree calls it: that is the tree
 * whose scripts the sessions started there run.
 *
 * `--lazy` is the hooks' route: it returns on four git calls unless a shim
 * exists or a script was deleted since the HEAD its last run saw, kept in
 * .git/wfc-hook-shims-head. A reset that deletes one is caught at the next
 * commit or merge.
 *
 * Prints one line per shim written or removed, or the fault that stopped it,
 * to stderr. Exits 0, the commit or merge having landed; 2 on a bad flag.
 */

const fs = require("node:fs");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { gitCommonDir, gitOrNull } = require("./lib/git.js");
const { keepShims } = require("./lib/hook-shims.js");
const { writeFd } = require("./lib/write-fd.js");

/* The files whose hook lines a session loads at its start. */
const HOOKS_FILES = ["self-plugin/hooks/hooks.json", ".claude/settings.json"];

const CLI = {
	usage: "usage: keep-hook-shims.js [--lazy]",
	flags: { "--lazy": /** @type {const} */ ("boolean") },
};

/**
 * @param {string} root the main worktree
 * @param {readonly string[]} args
 * @param {string} [input]
 * @returns {string | null}
 */
const git = (root, args, input) =>
	gitOrNull(["-C", root, ...args], {
		maxBuffer: CHILD_MAX_BUFFER,
		...(input === undefined
			? {}
			: { input, stdio: ["pipe", "pipe", "ignore"] }),
	});

/** @param {string | null} out */
const lines = (out) => (out ?? "").split("\n").filter(Boolean);

/** @param {string | null} out `-z` output */
const paths = (out) => (out ?? "").split("\0").filter(Boolean);

/**
 * The main worktree: the directory holding the common git dir.
 * @param {string} cwd
 * @returns {string | null}
 */
function readMainTree(cwd) {
	const common = gitCommonDir(cwd);
	return common?.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
}

/**
 * Each hooks file's text at each of `shas` that has one, each distinct blob
 * once.
 * @param {string} root
 * @param {string[]} shas
 * @returns {string[]}
 */
function readHooksAt(root, shas) {
	if (shas.length === 0) return [];
	const specs = shas.flatMap((s) => HOOKS_FILES.map((f) => `${s}:${f}`));
	const checks = lines(
		git(
			root,
			["cat-file", "--batch-check=%(objectname) %(objecttype)"],
			`${specs.join("\n")}\n`,
		),
	);
	const blobs = [
		...new Set(
			checks.flatMap((l) => {
				const [id, type] = l.split(" ");
				return id && type === "blob" ? [id] : [];
			}),
		),
	];
	return blobs.flatMap((id) => {
		const text = git(root, ["cat-file", "blob", id]);
		return text === null ? [] : [text];
	});
}

/**
 * @param {string} root the main worktree
 * @returns {import("./lib/hook-shims.js").ShimPorts}
 */
function buildHostPorts(root) {
	const exclude = path.join(root, ".git", "info", "exclude");
	const stamp = path.join(root, ".git", "wfc-hook-shims-head");
	return {
		untracked: () =>
			paths(git(root, ["ls-files", "--others", "-z", "--", "scripts"])),
		tracked: () =>
			new Set(paths(git(root, ["ls-files", "-z", "--", "scripts"]))),
		readFile: (rel) => {
			try {
				return fs.readFileSync(path.join(root, rel), "utf8");
			} catch {
				/* A file gone between the listing and this read is no shim (#2879). */
				return null;
			}
		},
		exists: (rel) => fs.existsSync(path.join(root, rel)),
		deletedSinceLastRun: () => {
			let seen;
			try {
				seen = fs.readFileSync(stamp, "utf8").trim();
			} catch {
				/* No run on record: the core reads null as "run in full" (#2879). */
				return null;
			}
			const out = git(root, [
				"diff",
				"--name-only",
				"--diff-filter=D",
				seen,
				"HEAD",
				"--",
				"scripts",
			]);
			return out === null ? null : lines(out);
		},
		recordRun: () => {
			const head = git(root, ["rev-parse", "HEAD"])?.trim();
			if (head) fs.writeFileSync(stamp, `${head}\n`);
		},
		reflog: () => {
			const out = git(root, [
				"reflog",
				"show",
				"--date=unix",
				"--format=%H %gd",
				"HEAD",
			]);
			if (out === null) return null;
			return lines(out).flatMap((l) => {
				const m = /^([0-9a-f]+) HEAD@\{(\d+)\}$/.exec(l);
				return m?.[1] ? [{ sha: m[1], at: Number(m[2]) * 1000 }] : [];
			});
		},
		hooksAt: (shas) => readHooksAt(root, shas),
		agents: () =>
			require("./lib/agent-liveness.js").listedAgents({ requireSelf: false }),
		writeShim: (rel, text) => {
			const full = path.join(root, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, text, { mode: 0o755 });
		},
		removeShim: (rel) => fs.rmSync(path.join(root, rel), { force: true }),
		readExclude: () => {
			try {
				return fs.readFileSync(exclude, "utf8");
			} catch (e) {
				/* Only an absent file is empty; any other fault must not let
				 * writeExclude replace the user's own lines. */
				if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT")
					return "";
				throw e;
			}
		},
		writeExclude: (text) => {
			fs.mkdirSync(path.dirname(exclude), { recursive: true });
			const tmp = `${exclude}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, text);
			fs.renameSync(tmp, exclude);
		},
	};
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	try {
		const root = readMainTree(process.cwd());
		if (!root) return 0;
		const r = keepShims(buildHostPorts(root), {
			lazy: parsed.flags["--lazy"] === true,
		});
		for (const line of r.lines) writeFd(2, `${line}\n`);
		if (r.why)
			require("./lib/arbiter-core.js").logError(
				"keep-hook-shims",
				new Error(r.why),
			);
	} catch (e) {
		/* Fail open, printed (#2879). */
		writeFd(2, `keep-hook-shims: ${String(e)}\n`);
		try {
			require("./lib/arbiter-core.js").logError("keep-hook-shims", e);
		} catch {
			/* An unwritable log costs the record; the line above was printed. */
		}
	}
	return 0;
}

module.exports = { main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
