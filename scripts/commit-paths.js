#!/usr/bin/env node
// cli-args-exempt: #1161

const { spawn, spawnSync } = require("node:child_process");
const { spawnGitSync } = require("./lib/git.js");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");

const core = require("./lib/arbiter-core.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { isUnder } = require("./lib/is-under.js");
const { numstatPaths } = require("./lib/patch-files.js");
const { notInTree } = require("./lib/patch-in-tree.js");
const { formatHeader, parseHeader } = require("./lib/hunk-header.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { caught } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");
const {
	commitKey,
	stampVariable,
	stampFile,
	writeStamp,
} = require("./lib/commit-key.js");
const { settleTestGate } = require("./lib/test-gate.js");
const { isHoldArmable, readConfig } = require("./lib/workflow-core-config.js");
const { monotonicMs } = require("./lib/clock.js");
const { runInTree } = require("./lib/isolated-worktree.js");
const { trimEndRun } = require("./lib/trim-run.js");
const { readText } = require("./lib/file-read.js");
const { precommitStamp } = require("./lib/precommit-stamp.js");
const { reviewTierStamp } = require("./lib/review-tier-stamp.js");
const { NO_CORE_FIX } = require("./lib/adopter-skeleton.js");
const { isHookShim } = require("./lib/hook-shim.js");
const { resolveCore } = require("./lib/resolve-core.js");

const NAME = "commit-paths";
const USAGE = `usage: node scripts/${NAME}.js (-m <message> | -F <file|->) -- <path>...
       node scripts/${NAME}.js (-m <message> | -F <file|->) --patch <file> [-- <path>...]
       node scripts/${NAME}.js --tree [--patch <file>] -- <path>...
       node scripts/${NAME}.js --check [--patch <file>] [-m <message> | -F <file|->] -- <path>...`;

/** @param {string} text */
const out = (text) => writeFd(1, text);
/** @param {string} text */
const err = (text) => writeFd(2, text);

/** @type {Record<number, string>} */
const OUTCOMES = {
	0: "committed",
	2: "refused",
	3: "git-refused",
	4: "committed-unsettled",
};

let preLockMs = 0;
/** @param {number} ms */
function countPreLockMs(ms) {
	preLockMs += ms;
}

const SLOW_GATES = /** @type {const} */ (["test", "mutation"]);

/** @typedef {typeof SLOW_GATES[number]} SlowGate */

const GATES_END = ": end of the gates commit-paths runs before its suite";

/** @typedef {{index: string, messageFile: string, stamps: Record<SlowGate, string>, gates: string}} RunFiles */

/** @typedef {{ms: number}|{why: string}} SlowRun */

/** @typedef {{gate: SlowGate, label: string, run: () => SlowRun}} DueGate */

/**
 * @type {(RunFiles & {sweeper: import("node:child_process").ChildProcess})|null}
 */
let runFiles = null;

let commitsNothing = false;

let checkOnly = false;

/**
 * @type {{index: string, gitDir: string}|null}
 */
let checkedIndex = null;

/** @param {RunFiles} files */
const armStampRemoval = ({ index }) => {
	checkedIndex = { index, gitDir: path.dirname(index) };
};

function removeHookStamps() {
	if (!checkedIndex) return;
	const { index, gitDir } = checkedIndex;
	checkedIndex = null;
	/** @param {string} what @param {string} why */
	const leftBehind = (what, why) =>
		err(
			`${NAME}: ${what} may be left in ${gitDir} (${why}); a later commit of the checked tree could stand its gates down on it. Remove it by hand.\n`,
		);
	const tree = spawnGitSync(["write-tree"], {
		encoding: "utf8",
		env: { ...process.env, GIT_INDEX_FILE: index },
	});
	if (tree.status !== 0)
		return leftBehind(
			"a hook's stamp",
			`git could not write the checked tree: ${(tree.stderr ?? "").trim()}`,
		);
	const stamps = [precommitStamp(gitDir)];
	const review = reviewTierStamp(gitDir, process.env.CLAUDE_CODE_SESSION_ID);
	if (review !== null) stamps.push(review);
	for (const stamp of stamps) {
		const read = readText(stamp);
		if (read.state === "unreadable") leftBehind(stamp, read.message);
		if (read.state !== "read") continue;
		if (read.data.split("\n", 1)[0] === tree.stdout.trim())
			fs.rmSync(stamp, { force: true });
	}
}

function removeRunFiles() {
	if (!runFiles) return;
	fs.rmSync(runFiles.index, { force: true });
	fs.rmSync(runFiles.messageFile, { force: true });
	for (const stamp of Object.values(runFiles.stamps))
		fs.rmSync(stamp, { force: true });
	fs.rmSync(runFiles.gates, { force: true });
	runFiles.sweeper.stdin?.destroy();
}

/**
 * @type {(code: number) => never}
 */
const finish = (code) => {
	runPostCommit();
	removeHookStamps();
	removeRunFiles();
	if (commitsNothing) process.exit(code);
	try {
		const log = core.paths.commitPathsLog();
		fs.mkdirSync(path.dirname(log), { recursive: true });
		fs.appendFileSync(
			log,
			`${new Date().toISOString()}\t${OUTCOMES[code]}\t${(preLockMs / 1000).toFixed(1)}\n`,
		);
	} catch (e) {
		const { code: errCode, message } = caught(e);
		err(
			`${NAME}: could not append the outcome line (${errCode ?? message}).\n`,
		);
	}
	process.exit(code);
};

/** @type {(text: string, code: number) => never} */
const fail = (text, code) => {
	err(`${NAME}: ${text}\n`);
	return finish(code);
};

let owedPostCommit = false;
const owePostCommit = () => {
	owedPostCommit = true;
};

let touched = false;
const markTouched = () => {
	touched = true;
};

/** @param {string} p */
const literal = (p) => `:(literal)${p}`;
/** @param {string} p */
const topLiteral = (p) => `:(top,literal)${p}`;

/**
 * @param {string[]} args
 * @param {string} [index]
 * @param {string} [input]
 * @param {NodeJS.ProcessEnv} [extra]
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function git(args, index, input, extra) {
	const env = { ...process.env, ...extra };
	if (index) env.GIT_INDEX_FILE = index;
	const r = spawnGitSync(args, {
		encoding: "utf8",
		env,
		input,
	});
	if (r.error) fail(`could not run git (${r.error.message})`, touched ? 3 : 2);
	return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** @type {string|undefined} */
let rootCache;
function readRoot() {
	rootCache ??= fs.realpathSync(
		git(["rev-parse", "--show-toplevel"]).stdout.replace(/\n$/, ""),
	);
	return rootCache;
}

/** @param {string} stdout */
const nulList = (stdout) => stdout.split("\0").filter(Boolean);

/**
 * @param {string[]} argv
 * @returns {{message: string, paths: string[], patch: string|null, tree: boolean, check: boolean}}
 */
function parseArgs(argv) {
	let dash = -1;
	/** @type {string|null} */
	let message = null;
	/** @type {string|null} */
	let patch = null;
	let tree = false;
	let check = false;
	for (let i = 0; i < argv.length; i++) {
		const opt = argv[i];
		if (opt === "--") {
			dash = i;
			break;
		}
		if (opt === "--tree") {
			tree = true;
			commitsNothing = true;
			continue;
		}
		if (opt === "--check") {
			check = true;
			checkOnly = true;
			commitsNothing = true;
			continue;
		}
		refuseOption(opt, { patch, message });
		const value = argv[++i];
		if (value === undefined) fail(`${opt} needs a value.\n${USAGE}`, 2);
		if (opt === "--patch") patch = readArgFile(value, value, "patch");
		else message = readMessageOf(opt, value);
	}
	const paths = dash === -1 ? [] : argv.slice(dash + 1);
	if (tree && check)
		fail(
			`give --tree or --check, not both: one prints the tree, the other runs its gates. Nothing written.\n${USAGE}`,
			2,
		);
	const given = requireMessage(message, { tree, check });
	refuseNoPaths({ patch, dash, paths });
	return { message: given, paths, patch, tree, check };
}

/**
 * @param {string | undefined} opt
 * @param {string} value
 */
const readMessageOf = (opt, value) =>
	opt === "-m"
		? value
		: readArgFile(value === "-" ? 0 : value, value, "message");

/**
 * @param {string | null} message
 * @param {{tree: boolean, check: boolean}} mode
 * @returns {string}
 */
function requireMessage(message, { tree, check }) {
	if (tree) {
		if (message !== null)
			fail(`--tree commits nothing, so it takes no message.\n${USAGE}`, 2);
		return "";
	}
	if (check && message === null) return "";
	if (message === null || !message.trim())
		fail(`no commit message. Nothing written.\n${USAGE}`, 2);
	return message;
}

/**
 * @param {{patch: string | null, dash: number, paths: string[]}} a
 */
function refuseNoPaths({ patch, dash, paths }) {
	if (patch === null && (dash === -1 || paths.length === 0))
		fail(
			`no paths after \`--\`. A commit with none would take whatever the index holds. Nothing written.\n${USAGE}`,
			2,
		);
}

/**
 * @param {string | undefined} opt
 * @param {{patch: string | null, message: string | null}} seen
 */
function refuseOption(opt, { patch, message }) {
	if (opt !== "-m" && opt !== "-F" && opt !== "--patch")
		fail(`unknown option ${opt}. Nothing written.\n${USAGE}`, 2);
	if (opt === "--patch" && patch !== null)
		fail(
			`give --patch once; one patch may cover several files. Nothing written.\n${USAGE}`,
			2,
		);
	if (opt !== "--patch" && message !== null)
		fail(`give the message once, by -m or -F. Nothing written.\n${USAGE}`, 2);
}

/**
 * @param {string | number} source
 * @param {string} value
 * @param {string} what
 * @returns {string}
 */
function readArgFile(source, value, what) {
	try {
		return fs.readFileSync(source, "utf8");
	} catch (e) {
		return fail(
			`could not read the ${what} from ${value} (${caught(e).code}).`,
			2,
		);
	}
}

/**
 * @param {string} p
 * @returns {"dir"|"file"|null}
 */
function readDiskKind(p) {
	try {
		return fs.lstatSync(p).isDirectory() ? "dir" : "file";
	} catch {
		return null;
	}
}

/**
 * #1794 #2363
 * @param {string} p
 * @param {"dir"|"file"|null} kind
 */
function trackedUnder(p, kind) {
	const indexed = lsFiles(p);
	if (kind === "file" || !hasHeadCommit()) return indexed;
	const inIndex = new Set(indexed);
	return lsFiles(p, "--with-tree=HEAD").filter(
		(f) => inIndex.has(f) || readDiskKind(f) === null,
	);
}

/**
 * @param {string} p
 * @param {string[]} flags
 */
function lsFiles(p, ...flags) {
	const r = git(["ls-files", "-z", ...flags, "--", literal(p)]);
	if (r.status !== 0) fail(`${p}: ${r.stderr.trim()}. Nothing written.`, 2);
	return nulList(r.stdout);
}

/**
 * #1663
 * @param {string} p
 */
function readIgnoreRule(p) {
	const r = git(["check-ignore", "-v", "-z", "--stdin"], undefined, `${p}\0`);
	if (r.status === 1) return null;
	if (r.status !== 0)
		return fail(
			`git could not say whether ${p} is ignored (${r.stderr.trim()}). Nothing written.`,
			2,
		);
	const [source, line, pattern, file] = r.stdout.split("\0");
	if (pattern?.startsWith("!")) return null;
	return `${source}:${line}:${pattern}\t${file}`;
}

/**
 * @param {string[]} paths
 */
function classify(paths) {
	/** @type {string[]} */
	const toAdd = [];
	for (const p of paths) {
		const kind = readDiskKind(p);
		const tracked = trackedUnder(p, kind);
		if (kind === "dir") {
			assertDirectoryCommittable(p, tracked);
			continue;
		}
		if (tracked.length > 0) continue;
		if (kind === null)
			fail(
				`${p} exists nowhere — not on disk, not tracked. Check the spelling. Nothing written.`,
				2,
			);
		const rule = readIgnoreRule(p);
		if (rule)
			fail(
				`${p} is ignored (${rule}). Scratch is not committed; if it should be, change the ignore rule first. Nothing written.`,
				2,
			);
		toAdd.push(p);
	}
	return toAdd;
}

/**
 * @param {string} p
 * @param {string[]} tracked
 */
function assertDirectoryCommittable(p, tracked) {
	const r = git([
		"ls-files",
		"-z",
		"--others",
		"--exclude-standard",
		"--",
		literal(p),
	]);
	if (r.status !== 0)
		fail(
			`git could not list the untracked files under ${p} (${r.stderr.trim()}). Nothing written.`,
			2,
		);
	const untracked = nulList(r.stdout);
	if (untracked.length > 0)
		fail(
			`${p} is a directory holding ${untracked.length} file(s) git does not track:\n${untracked.map((u) => `  ${u}`).join("\n")}\ngit would commit the tracked files under it and leave these behind. Name the ones that are yours as paths instead. Nothing written.`,
			2,
		);
	if (tracked.length > 0) return;
	const rule = readIgnoreRule(p);
	fail(
		rule
			? `${p} is ignored (${rule}). Scratch is not committed; if it should be, change the ignore rule first. Nothing written.`
			: `${p} is a directory holding nothing git tracks. Name the files in it you mean to add. Nothing written.`,
		2,
	);
}

/**
 * @param {string} root
 * @param {string} patch
 */
function readPatchFiles(root, patch) {
	const r = git(
		["-C", root, "apply", "--numstat", "-z", "--unidiff-zero", "-"],
		undefined,
		patch,
	);
	if (r.status !== 0) return { files: null, why: r.stderr.trim() };
	return { files: numstatPaths(r.stdout), why: "" };
}

/** @typedef {import("./lib/patch-in-tree.js").PatchSection} PatchSection */

/**
 * @param {string} root
 * @param {string} patch
 * @returns {PatchSection[]}
 */
function readPatchSections(root, patch) {
	/** @type {PatchSection[]} */
	const sections = [];
	for (const section of patch.split(/^(?=diff --git )/m)) {
		const file = readPatchFiles(root, section).files?.[0];
		if (file) sections.push({ section, file });
	}
	return sections;
}

/**
 * @param {PatchSection[]} sections
 * @param {string} base
 */
function stalePreimages(sections, base) {
	const stale = [];
	for (const { section, file } of sections) {
		const pre = parseIndexLine(section)?.pre;
		if (!pre || /^0+$/.test(pre) || isBlobAt(base, file, pre)) continue;
		const blob = readBlobSha(base, file);
		stale.push(
			`${file} (cut against ${pre}, HEAD holds ${blob ? blob.slice(0, pre.length) : "no such file"})`,
		);
	}
	return stale;
}

/**
 * @param {PatchSection[]} sections
 * @param {string} base
 */
function isPatchCommitted(sections, base) {
	return sections.every(({ section, file }) => {
		const from = /^rename from (.+)$/m.exec(section)?.[1];
		if (from !== undefined && readBlobSha(base, from) !== "") return false;
		const post = parseIndexLine(section)?.post;
		if (post) return isBlobAt(base, file, post);
		return from !== undefined && readBlobSha(base, file) !== "";
	});
}

/** @param {string} section */
function parseIndexLine(section) {
	const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(section);
	return m ? { pre: m[1], post: m[2] } : null;
}

/**
 * @param {string} base
 * @param {string} file
 * @param {string} sha
 */
function isBlobAt(base, file, sha) {
	const blob = readBlobSha(base, file);
	return /^0+$/.test(sha) ? blob === "" : blob.startsWith(sha);
}

/** @type {(rev: string, file: string) => string} */
const readBlobSha = (rev, file) =>
	git(["rev-parse", "-q", "--verify", `${rev}:${file}`]).stdout.trim();

/** @param {string} sha */
const printCommitted = (sha) =>
	out(`committed ${git(["log", "-1", "--format=%h %s", sha, "--"]).stdout}`);

/**
 * #1659
 * @param {string} cut
 * @returns {string}
 */
function renumberHunks(cut) {
	let shift = 0;
	let oldLeft = 0;
	let newLeft = 0;
	return cut
		.split("\n")
		.map((line) => {
			if (oldLeft > 0 || newLeft > 0) {
				if (line[0] !== "+" && line[0] !== "\\") oldLeft--;
				if (line[0] !== "-" && line[0] !== "\\") newLeft--;
				return line;
			}
			if (line.startsWith("--- ")) shift = 0;
			const h = renumberHeader(line, shift);
			if (!h) return line;
			({ oldLeft, newLeft } = h);
			shift += newLeft - oldLeft;
			return h.line;
		})
		.join("\n");
}

/**
 * @param {string} line
 * @param {number} shift
 */
function renumberHeader(line, shift) {
	const h = parseHeader(line);
	if (!h) return null;
	const above = h.oldStart - (h.oldCount === 0 ? 0 : 1) + shift;
	const newStart = above + (h.newCount === 0 ? 0 : 1);
	return {
		line: formatHeader({ ...h, newStart }),
		oldLeft: h.oldCount,
		newLeft: h.newCount,
	};
}

/**
 * @param {string} message
 * @param {string} cut
 * @param {string[]} whole
 * @returns {never}
 */
function commitPatch(message, cut, whole) {
	const { patch, root, sections } = preparePatch(cut, whole);

	const files = sweptRunFiles();
	const { index } = files;

	const patchBuild = {
		index,
		whole,
		root,
		patch,
		sections,
		refuseUnchanged: true,
	};
	const base = buildOnHead(patchBuild);
	// #1653
	const stampEnv = preLockRun(
		() => files,
		(privateIndex) => buildIndex({ ...patchBuild, index: privateIndex }, base),
	);

	const changed = nulList(
		git(["diff", "--cached", "--name-only", "-z", "--no-renames", base], index)
			.stdout,
	);
	const sha = commitIndex(message, files, base, stampEnv);

	resetIndex(changed);
	runPostCommit();

	out(git(["show", "--stat", "--format=", sha]).stdout);
	printCommitted(sha);
	return finish(0);
}

/**
 * #2638
 * @param {string} message
 * @param {RunFiles} files
 * @param {string} base
 * @param {NodeJS.ProcessEnv|undefined} stampEnv
 * @returns {string}
 */
function commitIndex(message, files, base, stampEnv) {
	const { tree, cleaned } = runCommitHooks(files, base, stampEnv, message);
	const run = inIndex(files.index, stampEnv);
	const sign =
		run(["config", "--type=bool", "--get", "commit.gpgSign"]).stdout.trim() ===
		"true"
			? ["-S"]
			: [];
	const sha = stdoutOrRefuse(
		run(["commit-tree", ...sign, tree, "-p", base], cleaned),
	).trim();
	const subject = cleaned.split("\n", 1)[0];
	stdoutOrRefuse(
		run(["update-ref", "-m", `commit: ${subject}`, "HEAD", sha, base]),
	);
	markTouched();
	owePostCommit();
	return sha;
}

/**
 * @param {string} index
 * @param {NodeJS.ProcessEnv|undefined} stampEnv
 * @returns {(args: string[], input?: string) => ReturnType<typeof git>}
 */
const inIndex = (index, stampEnv) => (args, input) =>
	git(args, index, input, { ...stampEnv, GIT_EDITOR: ":" });

/**
 * @param {ReturnType<typeof git>} r
 * @returns {string}
 */
function stdoutOrRefuse(r) {
	if (r.status === 0) return r.stdout;
	out(r.stdout);
	err(r.stderr);
	return fail(
		checkOnly
			? `a hook refused (exit ${r.status}), so a commit of these paths would be refused; the output above is the work. Nothing written.`
			: `git or a hook refused the commit (exit ${r.status}); the output above is the work. The worktree's index and the working tree were never touched, so re-running the same command after the fix is safe.`,
		3,
	);
}

/**
 * @param {RunFiles} files
 * @param {string|null} base
 * @param {NodeJS.ProcessEnv|undefined} stampEnv
 * @param {string} message
 * @returns {{tree: string, cleaned: string}}
 */
function runCommitHooks({ index, messageFile }, base, stampEnv, message) {
	const run = inIndex(index, stampEnv);
	const hook = (/** @type {string[]} */ ...args) => {
		const r = run(["hook", "run", "--ignore-missing", ...args]);
		err(r.stderr);
		return { ...r, stderr: "" };
	};
	const cleanup = run(["config", "--get", "commit.cleanup"]).stdout.trim();
	/** @param {string} text */
	const clean = (text) =>
		cleanup === "verbatim"
			? text
			: stdoutOrRefuse(
					run(
						cleanup === "strip"
							? ["stripspace", "--strip-comments"]
							: ["stripspace"],
						text,
					),
				);

	stdoutOrRefuse(hook("pre-commit"));
	const tree = stdoutOrRefuse(run(["write-tree"])).trim();
	if (
		base !== null &&
		tree === git(["rev-parse", `${base}^{tree}`]).stdout.trim()
	)
		fail(
			"the pre-commit hook left the index matching HEAD, so there is nothing to commit. Read what the hook printed above for what it unstaged. Nothing written.",
			3,
		);
	if (message === "") return { tree, cleaned: "" };

	fs.writeFileSync(messageFile, clean(message));
	stdoutOrRefuse(hook("prepare-commit-msg", "--", messageFile, "message"));
	stdoutOrRefuse(hook("commit-msg", "--", messageFile));
	const cleaned = clean(fs.readFileSync(messageFile, "utf8"));
	if (!cleaned.trim())
		fail(
			"the prepare-commit-msg or commit-msg hook left the message empty, so git made no commit. Read what that hook printed above. Nothing written.",
			3,
		);
	return { tree, cleaned };
}

// #3565
function runPostCommit() {
	if (!owedPostCommit) return;
	const env = { GIT_EDITOR: ":" };
	owedPostCommit = false;
	const r = git(
		["hook", "run", "--ignore-missing", "post-commit"],
		undefined,
		undefined,
		env,
	);
	err(r.stderr);
	git(["maintenance", "run", "--auto", "--quiet"], undefined, undefined, env);
}

/**
 * @param {string} cut
 * @param {string[]} whole
 */
function preparePatch(cut, whole) {
	classify(whole);
	const patch = renumberHunks(cut);
	const root = readRoot();
	const patched = readPatched(root, patch);

	refuseWholeInPatch(whole, patched);
	const sections = readPatchSections(root, cut);
	refuseNotInTree(root, sections);

	if (!hasHeadCommit())
		fail("--patch needs a HEAD to apply the patch to. Nothing written.", 2);
	for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
		if (git(["rev-parse", "-q", "--verify", ref]).status === 0)
			fail(
				`${ref} is set: a merge, cherry-pick or revert is in progress, and --patch commits outside one. Finish or abort it first. Nothing written.`,
				2,
			);
	return { patch, root, sections };
}

/**
 * #4338 #4339
 * @param {string} root
 * @param {PatchSection[]} sections
 */
function refuseNotInTree(root, sections) {
	const checkout = {
		fileMode: readBoolConfig(root, "core.fileMode"),
		symlinks: readBoolConfig(root, "core.symlinks"),
	};
	const created = new Set(
		sections
			.filter((s) => /^new file mode /m.test(s.section))
			.map((s) => s.file),
	);
	const refusals = [];
	for (const s of sections) {
		if (created.has(s.file) && /^deleted file mode /m.test(s.section)) continue;
		const tree = readTreeFile(root, s.file, checkout);
		if (tree === false) continue;
		const why = notInTree(s.section, tree);
		if (why !== null) refusals.push(`${s.file} (${why})`);
	}
	if (refusals.length > 0)
		fail(
			`the patch's lines, modes or contents are not in this tree's files for ${refusals.join("; ")}. --patch never writes the working tree, so this tree would show the commit reversed. Cut the patch from \`git diff HEAD -U0 -- <path>\` (\`--binary\` for a binary file) in the tree you commit from. Nothing written.`,
			2,
		);
}

/**
 * @param {string} root
 * @param {string} key
 */
function readBoolConfig(root, key) {
	const r = git(["-C", root, "config", "--type=bool", key]);
	if (r.status === 1) return true;
	if (r.status !== 0)
		fail(`git could not read ${key} (${r.stderr.trim()}). Nothing written.`, 2);
	return r.stdout.trim() !== "false";
}

/**
 * @param {string} root
 * @param {string} file
 * @param {{fileMode: boolean, symlinks: boolean}} checkout
 * @returns {import("./lib/patch-in-tree.js").TreeFile|null|false}
 */
function readTreeFile(root, file, checkout) {
	const p = path.join(root, file);
	let stat;
	try {
		stat = fs.lstatSync(p);
	} catch {
		return null;
	}
	if (stat.isSymbolicLink()) {
		const text = fs.readlinkSync(p);
		const blob = readGit(
			["-C", root, "hash-object", "--stdin"],
			`git could not hash ${file}'s symlink target`,
			text,
		).trim();
		return { text, blob, modes: ["120000"] };
	}
	if (stat.isDirectory()) {
		const top = git(["-C", p, "rev-parse", "--show-toplevel"]);
		if (top.status !== 0 || top.stdout.trim() !== fs.realpathSync(p))
			return false;
		const blob = readGit(
			["-C", p, "rev-parse", "HEAD"],
			`git could not read submodule ${file}'s HEAD`,
		).trim();
		return { text: `Subproject commit ${blob}\n`, blob, modes: ["160000"] };
	}
	const blob = readGit(
		["-C", root, "hash-object", "-w", "--", file],
		`git could not read ${file} from the working tree`,
	).trim();
	const diskMode = stat.mode & 0o100 ? "100755" : "100644";
	const modes = checkout.fileMode ? [diskMode] : ["100644", "100755"];
	if (!checkout.symlinks) modes.push("120000");
	return {
		text: readGit(
			["cat-file", "blob", blob],
			`git could not read back ${file}'s cleaned blob`,
		),
		blob,
		modes,
	};
}

/**
 * @param {string[]} args
 * @param {string} why
 * @param {string} [input]
 */
function readGit(args, why, input) {
	const r = git(args, undefined, input);
	if (r.status !== 0) fail(`${why} (${r.stderr.trim()}). Nothing written.`, 2);
	return r.stdout;
}

/**
 * @param {string} root
 * @param {string} patch
 * @returns {string[]}
 */
function readPatched(root, patch) {
	const { files, why } = readPatchFiles(root, patch);
	if (!files)
		fail(`git could not read the patch (${why}). Nothing written.`, 2);
	const patched = files;
	if (patched.length === 0)
		fail("the patch touches no file. Nothing written.", 2);
	return patched;
}

/**
 * @param {string[]} whole
 * @param {string[]} patched
 */
function refuseWholeInPatch(whole, patched) {
	const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim();
	for (const p of whole) {
		const rel = trimEndRun(
			path.posix.normalize(
				prefix + path.relative(process.cwd(), path.resolve(p)),
			),
			"/",
		);
		const hit = patched.find((q) => rel === "." || isUnder(q, [rel]));
		if (hit)
			fail(
				`${hit} is in the patch and also named whole after \`--\`, which would commit the whole working-tree file. Leave it to the patch. Nothing written.`,
				2,
			);
	}
}

/**
 * @typedef {{index: string, whole: string[], root: string, patch: string, sections: PatchSection[], refuseUnchanged: boolean}} PatchBuild
 */

/**
 * @param {PatchBuild} b
 * @returns {string}
 */
function buildOnHead(b) {
	const base = git(["rev-parse", "HEAD"]).stdout.trim();
	buildIndex(b, base);
	return base;
}

/**
 * @param {PatchBuild} b
 * @param {string} base
 */
function buildIndex(
	{ index, whole, root, patch, sections, refuseUnchanged },
	base,
) {
	fs.rmSync(index, { force: true });
	const tree = git(["read-tree", base], index);
	if (tree.status !== 0)
		fail(
			`git could not read HEAD into a private index (${tree.stderr.trim()}). Nothing written.`,
			2,
		);
	// #1960
	const gone = whole.filter((p) => readDiskKind(p) === null);
	const present = whole.filter((p) => !gone.includes(p));
	/** @type {[string[], string[]][]} */
	const steps = [
		[gone, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--"]],
		[present, ["add", "-A", "--"]],
	];
	for (const [paths, args] of steps) {
		if (paths.length === 0) continue;
		const r = git([...args, ...paths.map(literal)], index);
		if (r.status !== 0)
			fail(
				`git could not stage ${paths.join(", ")} (${r.stderr.trim()}). Nothing written.`,
				2,
			);
	}
	if (!refuseUnchanged && isPatchCommitted(sections, base)) return;
	const stale = stalePreimages(sections, base);
	if (stale.length > 0)
		fail(
			`the patch was not cut against HEAD for ${stale.join("; ")}. Where this command already committed it, it is done; otherwise cut it again from \`git diff HEAD -U0 -- <path>\`. Nothing written.`,
			2,
		);
	const r = git(
		["-C", root, "apply", "--cached", "--unidiff-zero", "-"],
		index,
		patch,
	);
	if (r.status !== 0)
		fail(
			`the patch does not apply to HEAD (${r.stderr.trim()}). Cut it from \`git diff HEAD -U0 -- <path>\`, which diffs against HEAD rather than the index. Nothing written.`,
			2,
		);
	if (
		refuseUnchanged &&
		git(["diff", "--cached", "--quiet", base], index).status === 0
	)
		fail(
			"nothing to commit — the patch and paths leave HEAD as it is. Nothing written.",
			2,
		);
}

/**
 * @param {string[]} changed
 */
function resetIndex(changed) {
	const r = git(["reset", "-q", "--", ...changed.map(topLiteral)]);
	if (r.status === 0) return;
	err(r.stdout + r.stderr);
	fail(
		`git refused to bring the index to the commit (exit ${r.status}). Do not re-run this command: the commit has landed. Reset the index yourself, or it stages the reverse of this commit for the next bare \`git commit\`:\n  git reset -q -- ${changed.map(topLiteral).map(shellQuote).join(" ")}`,
		4,
	);
}

function hasHeadCommit() {
	return git(["rev-parse", "--verify", "-q", "HEAD"]).status === 0;
}

/**
 * @returns {RunFiles}
 */
function sweptRunFiles() {
	const r = git(["rev-parse", "--absolute-git-dir"]);
	if (r.status !== 0)
		fail(
			`git could not name the git directory (${r.stderr.trim()}). Nothing written.`,
			2,
		);
	const run = `${NAME}-${process.pid}`;
	/** @param {string} kind */
	const named = (kind) => path.join(r.stdout.trim(), `${run}.${kind}`);
	const index = named("index");
	const messageFile = named("message");
	const stamps = /** @type {Record<SlowGate, string>} */ (
		Object.fromEntries(
			SLOW_GATES.map((g) => [g, stampFile(g, r.stdout.trim(), run)]),
		)
	);
	const gates = named("gates");
	// #1680
	const sweeper = spawn(
		"sh",
		[
			"-c",
			`trap '' HUP INT TERM; cat >/dev/null; rm -f -- "$@"`,
			"sh",
			index,
			messageFile,
			...Object.values(stamps),
			gates,
		],
		{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
	);
	if (sweeper.pid === undefined)
		err(
			`${NAME}: the shell that removes this run's files if it is killed did not start, so a kill may leave ${index} behind. Nothing honours it.\n`,
		);
	sweeper.on("error", noop);
	sweeper.unref();
	runFiles = { index, messageFile, stamps, gates, sweeper };
	return { index, messageFile, stamps, gates };
}

const MUTATION_HOLD = path.join(__dirname, "mutation-hold-gate.js");

// #4306
function isHoldArmed() {
	try {
		const { modules, sensitivePaths } = readConfig();
		return isHoldArmable(modules, sensitivePaths);
	} catch {
		// #1910
		return false;
	}
}

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {"--due"|"--pre-lock"} mode
 */
const runHold = (root, env, mode) =>
	spawnSync(process.execPath, [MUTATION_HOLD, mode], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});

/**
 * #1763
 * @param {() => RunFiles} runFilesNow
 * @param {(index: string) => void} build
 * @returns {NodeJS.ProcessEnv|undefined}
 */
function preLockRun(runFilesNow, build) {
	let found;
	try {
		found = settleTestGate((line) => err(`${NAME}: ${line}\n`));
	} catch {
		// #1639
		err(
			`${NAME}: no pre-lock test run — the config could not be read, so the commit's hook judges it.\n`,
		);
		return;
	}
	const command = found.gate === "commit" ? found.command : null;
	const holdOn = isHoldArmed();
	if (command === null && !holdOn) return;
	const { index, stamps, gates } = runFilesNow();

	try {
		build(index);
	} catch (e) {
		err(
			`${NAME}: no pre-lock run — ${caught(e).message.trim()}. The commit's hook runs every gate in the lock instead.\n`,
		);
		return;
	}
	const root = readRoot();
	const common = git([
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]).stdout.trim();
	/** @type {NodeJS.ProcessEnv} */
	const runEnv = {
		...process.env,
		PATH: `${path.dirname(common)}/node_modules/.bin:node_modules/.bin:${process.env.PATH}`,
	};
	const holdEnv = { ...runEnv, GIT_INDEX_FILE: index };

	/** @type {DueGate[]} */
	const due = [];
	if (command !== null)
		due.push({
			gate: "test",
			label: `'${command}'`,
			run: () => preLockTest(root, index, command, runEnv),
		});
	if (holdOn && runHold(root, holdEnv, "--due").status === 0)
		due.push({
			gate: "mutation",
			label: "the mutation hold",
			run: () => preLockHold(root, holdEnv),
		});
	if (due.length === 0) return;

	preLockGates({
		root,
		index,
		gates,
		env: runEnv,
		slowLabel: due.map((d) => d.label).join(" and "),
	});
	const keyEnv = { ...process.env, GIT_INDEX_FILE: index };
	/** @type {NodeJS.ProcessEnv} */
	const stampEnv = {};
	for (const d of due) {
		const stamp = stampedRun(d, {
			stamp: stamps[d.gate],
			index,
			keyEnv,
			build,
		});
		if (stamp !== null) stampEnv[stampVariable(d.gate)] = stamp;
	}
	return stampEnv;
}

/**
 * @param {DueGate} d
 * @param {{stamp: string, index: string, keyEnv: NodeJS.ProcessEnv, build: (index: string) => void}} at
 * @returns {string|null}
 */
function stampedRun({ gate, label, run }, { stamp, index, keyEnv, build }) {
	/** @type {(why: string) => null} */
	const deferToHook = (why) => {
		err(
			`${NAME}: no pre-lock green for ${label} — ${why}. The commit's hook runs it in the lock instead.\n`,
		);
		return null;
	};
	const keyNow = () => {
		try {
			build(index);
			return commitKey(gate, { env: keyEnv });
		} catch (e) {
			return deferToHook(caught(e).message.trim());
		}
	};
	const keyBefore = keyNow();
	if (keyBefore === null) return null;
	const r = run();
	if ("why" in r) return deferToHook(r.why);

	// #1652
	const keyAfter = keyNow();
	if (keyAfter === null) return null;
	if (keyAfter !== keyBefore)
		return deferToHook(
			`it was green (${seconds(r.ms)}), but the commit's own changes moved while it ran`,
		);

	try {
		writeStamp(stamp, keyBefore);
	} catch (e) {
		return deferToHook(
			`it was green (${seconds(r.ms)}), but its stamp could not be written (${caught(e).code})`,
		);
	}
	err(
		`${NAME}: ${label} is green (${seconds(r.ms)}); the commit's hook stands its run down on that.\n`,
	);
	return stamp;
}

/**
 * #1760
 * @param {string} root
 * @param {string} index
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 * @returns {SlowRun}
 */
function preLockTest(root, index, command, env) {
	const tree = git(["write-tree"], index);
	if (tree.status !== 0)
		return {
			why: `git could not write the commit's tree (${tree.stderr.trim()})`,
		};
	let start = monotonicMs();
	const r = runInTree(root, tree.stdout.trim(), command, {
		env,
		gate: true,
		onStart: () => {
			err(
				`${NAME}: running '${command}' before the commit takes the index lock.\n`,
			);
			start = monotonicMs();
		},
	});
	if (r.error !== null) return { why: r.error.trim() };
	const ms = monotonicMs() - start;
	countPreLockMs(ms);
	if (r.status !== 0) {
		err(r.output);
		if (r.spawnError) err(`${r.spawnError.message}\n`);
		fail(
			`the declared test command is RED — '${command}' — so this commit is refused. Nothing written.
  It ran on HEAD plus this commit's own paths, so no unsaved edit outside them reached it (#1760): the red is in HEAD, in this commit, or in a gitignored file the suite needs that its worktree lacks.
  Fix the failing test and commit again. Where the red is a gitignored file the worktree lacks, name it in \`worktreeLinks\` in .claude/workflow-core.json, and the worktree links it in (#1767).`,
			3,
		);
	}
	return { ms };
}

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @returns {SlowRun}
 */
function preLockHold(root, env) {
	err(
		`${NAME}: running the mutation hold before the commit takes the index lock.\n`,
	);
	const start = monotonicMs();
	const r = runHold(root, env, "--pre-lock");
	const ms = monotonicMs() - start;
	countPreLockMs(ms);
	err(`${r.stdout ?? ""}${r.stderr ?? ""}`);
	if (r.status === 0) return { ms };
	if (r.status === 1)
		fail(
			"the mutation hold refused this commit before it took the index lock, as the commit's hook would. Nothing written.",
			3,
		);
	return {
		why:
			r.status === 3
				? "it judged nothing before the lock"
				: `it did not finish (${r.error?.message ?? (r.status === null ? `killed by ${r.signal}` : `exit ${r.status}`)})`,
	};
}

/**
 * #1763 #5288
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @returns {{text: string, core: string|null, why: null}|{text: null, why: string, noCore?: string}}
 */
function readHookGatesText(root, env) {
	const r = git([
		"-C",
		root,
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"hooks",
	]);
	if (r.status !== 0)
		return {
			text: null,
			why: `git could not name the hooks directory (${r.stderr.trim()})`,
		};
	const hooks = r.stdout.trim();
	const gitHook = fs.existsSync(path.join(hooks, "h"))
		? path.join(path.dirname(hooks), "pre-commit")
		: path.join(hooks, "pre-commit");
	/** @param {string} at @returns {{body: string}|{why: string}} */
	const readHook = (at) => {
		const read = readText(at);
		if (read.state === "read") return { body: read.data };
		return {
			why: `${at} could not be read (${read.state === "absent" ? "ENOENT" : read.message})`,
		};
	};
	const gitRead = readHook(gitHook);
	if ("why" in gitRead) return { text: null, why: gitRead.why };
	let hook = gitHook;
	let body = gitRead.body;
	/** @type {string|null} */
	let coreDir = null;
	if (isHookShim(body)) {
		try {
			coreDir = resolveCore({
				env,
				warn: noop,
			});
		} catch (e) {
			const noCore = caught(e).message;
			return {
				text: null,
				why: `${gitHook} is the core's shim, and no core resolves for it (${noCore})`,
				noCore,
			};
		}
		hook = path.join(coreDir, ".husky", "pre-commit");
		const coreRead = readHook(hook);
		if ("why" in coreRead) return { text: null, why: coreRead.why };
		body = coreRead.body;
	}
	const lines = body.split("\n");
	const end = lines.indexOf(GATES_END);
	if (end === -1)
		return {
			text: null,
			why: `${hook} has no line marking where its gates end, an older hook than this script`,
		};
	return {
		text: `${lines.slice(0, end).join("\n")}\n`,
		core: coreDir,
		why: null,
	};
}

/**
 * #1763
 * @param {{root: string, index: string, gates: string, env: NodeJS.ProcessEnv, slowLabel: string}} a
 */
function preLockGates({ root, index, gates, env, slowLabel }) {
	/** @type {(why: string) => void} */
	const deferToHook = (why) => {
		err(
			`${NAME}: no early gate run — ${why}. The commit's hook runs its gates after ${slowLabel}, in the lock.\n`,
		);
	};
	const hook = readHookGatesText(root, env);
	if ("noCore" in hook && hook.noCore !== undefined)
		fail(
			`this repo's pre-commit hook is workflow-core's shim, and no core resolves for it to run (${hook.noCore}), so the hook would refuse this commit; ${slowLabel} never started. Nothing written.
  ${NO_CORE_FIX}`,
			3,
		);
	if (hook.text === null) return deferToHook(hook.why);
	const gatesEnv =
		hook.core === null ? env : { ...env, WFC_PLUGIN_ROOT: hook.core };
	try {
		fs.writeFileSync(gates, hook.text);
	} catch (e) {
		return deferToHook(
			`the gates could not be copied out to run (${caught(e).code})`,
		);
	}
	err(
		`${NAME}: running the pre-commit hook's gates but its slow ones, before ${slowLabel}.\n`,
	);
	const r = spawnSync("sh", ["-c", 'sh -e "$1" </dev/null 2>&1', "sh", gates], {
		cwd: root,
		env: { ...gatesEnv, GIT_INDEX_FILE: index },
		stdio: ["ignore", "pipe", "inherit"],
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});
	fs.rmSync(gates, { force: true });
	if (r.status === 0) return;
	err(r.stdout ?? "");
	if (r.error || r.status === null)
		return deferToHook(
			`the run did not finish (${r.error?.message ?? `killed by ${r.signal}`})`,
		);
	fail(
		`a pre-commit gate refused this commit (exit ${r.status}), so ${slowLabel} never started. Nothing written.
  The gates ran on what the commit would carry, in this worktree, as the hook runs them in the lock, so it would refuse the same. A gate reading the working tree rather than the commit, as tsc and ESLint do, may be red on an unsaved edit this commit does not carry (mantahostels#273). Fix the finding above, or set that edit aside, and commit again.`,
		3,
	);
}

/**
 * @param {{index: string, specs: string[], toAdd: string[]}} b
 */
function buildCommitIndex({ index, specs, toAdd }) {
	/** @type {(r: ReturnType<typeof git>, what: string) => string} */
	const ok = (r, what) => {
		if (r.status !== 0)
			throw new Error(`git could not ${what} (${r.stderr.trim()})`);
		return r.stdout;
	};
	fs.rmSync(index, { force: true });
	const hasHead = hasHeadCommit();
	const withTree = hasHead ? ["--with-tree=HEAD"] : [];
	let listed = ok(
		git(["ls-files", "-z", "--full-name", ...withTree, "--", ...specs]),
		"list the named paths",
	);
	if (toAdd.length > 0)
		listed += ok(
			git([
				"ls-files",
				"-z",
				"--full-name",
				"--others",
				"--",
				...toAdd.map(literal),
			]),
			"list the named new files",
		);
	if (hasHead)
		ok(git(["read-tree", "HEAD"], index), "read HEAD into a private index");
	ok(
		git(
			["-C", readRoot(), "update-index", "--add", "--remove", "-z", "--stdin"],
			index,
			listed,
		),
		"stage the named paths in a private index",
	);
}

/**
 * @param {string[]} paths
 * @param {{refuseUnchanged: boolean}} mode
 */
function prepareWhole(paths, { refuseUnchanged }) {
	const toAdd = classify(paths);
	const specs = paths.map(literal);
	if (
		refuseUnchanged &&
		toAdd.length === 0 &&
		hasHeadCommit() &&
		git(["diff", "--quiet", "HEAD", "--", ...specs]).status === 0
	)
		fail(
			"nothing to commit — every named path matches HEAD. Check the edit was saved and the path is the one you changed. Nothing written.",
			2,
		);
	return { toAdd, specs };
}

/**
 * @param {string[]} whole
 * @param {string|null} cut
 * @returns {never}
 */
function printTree(whole, cut) {
	const { index } = sweptRunFiles();
	// #4288
	buildPrivateIndex(whole, cut, index, { refuseUnchanged: false });
	const r = git(["write-tree"], index);
	if (r.status !== 0)
		fail(`git could not write the tree (${r.stderr.trim()}).`, 2);
	out(r.stdout);
	return finish(0);
}

/**
 * @param {string[]} whole
 * @param {string|null} cut
 * @param {string} message
 * @returns {never}
 */
function checkCommit(whole, cut, message) {
	const files = sweptRunFiles();
	const { base, build } = buildPrivateIndex(whole, cut, files.index, {
		refuseUnchanged: true,
	});
	const stampEnv = preLockRun(() => files, build);
	armStampRemoval(files);
	runCommitHooks(files, base, stampEnv, message);
	if (message === "")
		err(
			`${NAME}: no message given, so the message checks — prepare-commit-msg and commit-msg — were skipped.\n`,
		);
	out(
		`${NAME}: every gate a commit of these paths would run passed. Nothing written.\n`,
	);
	return finish(0);
}

/**
 * @param {string[]} whole
 * @param {string|null} cut
 * @param {string} index
 * @param {{refuseUnchanged: boolean}} mode
 * @returns {{base: string|null, build: (index: string) => void}}
 */
function buildPrivateIndex(whole, cut, index, { refuseUnchanged }) {
	if (cut !== null) {
		const { patch, root, sections } = preparePatch(cut, whole);
		const patchBuild = {
			index,
			whole,
			root,
			patch,
			sections,
			refuseUnchanged,
		};
		const base = buildOnHead(patchBuild);
		return {
			base,
			build: (i) => buildIndex({ ...patchBuild, index: i }, base),
		};
	}
	const { toAdd, specs } = prepareWhole(whole, { refuseUnchanged });
	const base = hasHeadCommit()
		? git(["rev-parse", "HEAD"]).stdout.trim()
		: null;
	/** @param {string} i */
	const build = (i) => buildCommitIndex({ index: i, specs, toAdd });
	try {
		build(index);
	} catch (e) {
		fail(`${caught(e).message}. Nothing written.`, 2);
	}
	return { base, build };
}

function main() {
	// #1639
	for (const gate of SLOW_GATES) delete process.env[stampVariable(gate)];
	const { message, paths, patch, tree, check } = parseArgs(
		process.argv.slice(2),
	);

	if (git(["rev-parse", "--git-dir"]).status !== 0)
		fail("not inside a git repository. Nothing written.", 2);

	if (tree) printTree(paths, patch);
	if (check) checkCommit(paths, patch, message);
	if (patch !== null) commitPatch(message, patch, paths);

	const { toAdd, specs } = prepareWhole(paths, { refuseUnchanged: true });

	const stampEnv = preLockRun(sweptRunFiles, (index) =>
		buildCommitIndex({ index, specs, toAdd }),
	);

	const leftNote =
		toAdd.length > 0
			? `\nThe intent-add entries for ${toAdd.join(", ")} are left in the index — they commit nothing on their own — so re-running the same command after the fix just works.`
			: "";

	if (toAdd.length > 0) {
		const r = git(["add", "-N", "--", ...toAdd.map(literal)]);
		if (r.status !== 0) {
			err(r.stdout + r.stderr);
			fail(
				`git refused the intent-add (exit ${r.status}); git writes the index whole or not at all, so nothing was intent-added. Re-run once the cause above is gone.`,
				3,
			);
		}
		markTouched();
	}

	const r = git(
		["commit", "-m", message, "--", ...specs],
		undefined,
		undefined,
		stampEnv,
	);
	out(r.stdout);
	err(r.stderr);
	if (r.status !== 0)
		fail(
			`git or a hook refused the commit (exit ${r.status}); the output above is the work.${leftNote}`,
			3,
		);

	printCommitted("HEAD");
	finish(0);
}

main();
