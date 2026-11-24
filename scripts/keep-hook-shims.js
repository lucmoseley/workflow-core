#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { ignoreFailure } = require("./lib/caught.js");
const { gitCommonDir, gitOrNull } = require("./lib/git.js");
const { keepShims } = require("./lib/hook-shims.js");
const { runProgram } = require("./lib/program-scope.js");
const { writeFd } = require("./lib/write-fd.js");

const HOOKS_FILES = ["self-plugin/hooks/hooks.json", ".claude/settings.json"];

const CLI = {
	usage: "usage: keep-hook-shims.js [--lazy]",
	flags: { "--lazy": /** @type {const} */ ("boolean") },
};

/**
 * @param {string} root
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

/** @param {string | null} out */
const paths = (out) => (out ?? "").split("\0").filter(Boolean);

/**
 * @param {string} cwd
 * @returns {string | null}
 */
function readMainTree(cwd) {
	const common = gitCommonDir(cwd);
	return common?.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
}

/**
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
 * @param {string} root
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
				return null;
			}
		},
		exists: (rel) => fs.existsSync(path.join(root, rel)),
		deletedSinceLastRun: () => {
			let seen;
			try {
				seen = fs.readFileSync(stamp, "utf8").trim();
			} catch {
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
		writeFd(2, `keep-hook-shims: ${String(e)}\n`);
		ignoreFailure(() =>
			require("./lib/arbiter-core.js").logError("keep-hook-shims", e),
		);
	}
	return 0;
}

/**
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, args: string[] }} io
 */
const PROGRAM = (io) => runProgram(io, () => main(io.args));

module.exports = { PROGRAM, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
