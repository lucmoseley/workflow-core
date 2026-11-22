#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { execGit } = require("./lib/git.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { buildTree } = require("./lib/plugin-tree.js");
const {
	isMajorBump,
	newestTag,
	readLatestTag,
	buildReleaseMessage,
} = require("./lib/release-tags.js");
const { runVerify } = require("./lib/verify-run.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const {
	buildCommandUndeclaredLine,
	readConfig,
	MIGRATIONS_DIR,
	UPSTREAM_CODE_REPO,
} = require("./lib/workflow-core-config.js");
const { validateNote, parseNote } = require("./lib/migration-note.js");
const { upgrade } = require("./lib/upgrade-walk.js");
const { gh, ghApiSlurp, parseErrLine } = require("./lib/gh.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { runLinkSync } = require("./lib/link-writer.js");
const { scriptPath } = require("./lib/script-path.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { originLabel } = require("./lib/issue-origin.js");
const { takesLabel } = require("./lib/takes-label.js");
const { URGENT_LABEL } = require("./lib/urgent-label.js");
const {
	homeDir,
	readAdopterCheckouts,
	readHostTracker,
} = require("./lib/refill-repos.js");
const { isCoreHost } = require("./lib/plugin-state.js");
const { caught } = require("./lib/caught.js");
const { isSameRepo } = require("./lib/issue-ref.js");

const MIGRATION_LABEL = takesLabel("implement");
const HOLD_REL = `${MIGRATIONS_DIR}/hold.txt`;

const CLI = {
	usage:
		"usage: node scripts/release-plugin.js [--push] [--dry-run-adopter <path>] [--file-bump-issues]",
	flags: {
		"--push": /** @type {const} */ ("boolean"),
		"--dry-run-adopter": /** @type {const} */ ("value"),
		"--file-bump-issues": /** @type {const} */ ("boolean"),
	},
};

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
const git = (cwd, args, env) =>
	execGit(args, {
		cwd,
		env: env ?? process.env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

// #135 guess
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

// #1268
/** @param {string} message */
function refusal(message) {
	const detail = message.split("\n").slice(1).join("\n");
	return Object.assign(new Error(message), { detail });
}

/**
 * @param {string} root
 * @param {string} command
 * @param {string} label
 * @param {NodeJS.ProcessEnv} [env]
 */
function verifyOrThrow(root, command, label, env) {
	const result = runVerify(command, {
		cwd: root,
		env,
		timeout: VERIFY_TIMEOUT_MS,
	});
	if (result.ok) return;
	throw refusal(
		`${label} failed (\`${command}\`)${result.suffix}:\n${result.said}`,
	);
}

// #463
/** @param {string} root */
function surfaceContractOrThrow(root) {
	const r = spawnSync(
		process.execPath,
		[path.join(__dirname, "check-surface-contract.js"), "--json"],
		{
			cwd: root,
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
			encoding: "utf8",
		},
	);
	if (r.status === 0) return;
	let envelope;
	try {
		envelope = JSON.parse(r.stdout);
	} catch (e) {
		throw new Error(
			`the surface-contract check did not run: ${(r.stderr || String(r.error)).trim().split("\n")[0]}`,
			{ cause: e },
		);
	}
	const faults = envelope.findings.map(
		(/** @type {{message: string}} */ f) => f.message,
	);
	throw new Error(
		`the helper surface breaks its contract — ${faults.length > 0 ? faults.join("; ") : envelope.summary}`,
	);
}

/**
 * @param {string} adopterRoot
 * @param {string} pluginRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function helperCheck(adopterRoot, pluginRoot, env) {
	const command = readConfig({ root: adopterRoot, quiet: true }).commands
		.helper_check;
	if (!command)
		return `helper check: SKIPPED (${buildCommandUndeclaredLine("helper_check")})\n`;
	verifyOrThrow(adopterRoot, command, "the dry-run adopter's helper check", {
		...env,
		CLAUDE_PROJECT_DIR: adopterRoot,
		WORKFLOW_CORE_DIR: pluginRoot,
	});
	return `helper check: passed (\`${command}\`)\n`;
}

/**
 * @param {string} root
 * @returns {{plugin: {name: string, version: string}, tag: string}}
 */
function readReleaseTarget(root) {
	const show = (/** @type {string} */ f) =>
		JSON.parse(git(root, ["show", `HEAD:.claude-plugin/${f}`]));
	const plugin = show("plugin.json");
	const tag = `v${plugin.version}`;
	const entry = show("marketplace.json").plugins.find(
		(/** @type {{name: string}} */ p) => p.name === plugin.name,
	);
	const ref = entry?.source?.ref;
	if (ref !== tag) {
		throw new Error(
			`.claude-plugin/marketplace.json pins ${plugin.name} to ${ref ?? "no ref"}, not ${tag}`,
		);
	}
	if (git(root, ["tag", "--list", tag]) !== "") {
		throw new Error(`tag ${tag} already exists — bump plugin.json's version`);
	}
	return { plugin, tag };
}

/**
 * @param {string} root
 * @param {string} ref
 * @param {string} rel
 * @returns {string | null}
 */
function readAt(root, ref, rel) {
	if (git(root, ["ls-tree", "--name-only", ref, "--", rel]) === "") {
		return null;
	}
	return git(root, ["show", `${ref}:${rel}`]);
}

/**
 * @param {string} root
 * @param {string} tag
 */
function noteAheadOrThrow(root, tag) {
	const noted = git(root, [
		"ls-tree",
		"--name-only",
		"HEAD",
		`${MIGRATIONS_DIR}/`,
	])
		.split("\n")
		.map((rel) => path.basename(rel, ".md"));
	const newest = newestTag([...noted, tag]);
	if (newest !== tag)
		throw refusal(
			`${MIGRATIONS_DIR}/${newest}.md is ahead of ${tag} — cut ${newest}, the release that note describes`,
		);
}

/**
 * @param {string} root
 * @param {string} tag
 * @returns {string | null}
 */
function readNoteOrThrow(root, tag) {
	const prior = readLatestTag(root);
	const noteRel = `${MIGRATIONS_DIR}/${tag}.md`;
	const isMajor = isMajorBump(tag, prior);
	const note = readAt(root, "HEAD", noteRel);
	if (isMajor && note === null) {
		throw new Error(
			`${tag} is a major bump over ${prior} and ships no ${noteRel}`,
		);
	}
	if (note !== null) {
		const faults = validateNote(note);
		if (faults.length > 0) {
			// #246
			throw new Error(`${noteRel} is malformed: ${faults.join("; ")}`);
		}
	}
	return note;
}

/**
 * @param {string} dryRunAdopter
 * @param {string} tmp
 * @param {string} outDir
 * @param {NodeJS.ProcessEnv} verifyEnv
 * @returns {string}
 */
function walkAdopter(dryRunAdopter, tmp, outDir, verifyEnv) {
	// #291 #296
	const adopterCopy = path.join(tmp, "adopter");
	const unwanted = new Set(["node_modules", ".git"]);
	fs.cpSync(dryRunAdopter, adopterCopy, {
		recursive: true,
		dereference: true,
		filter: (from) => !unwanted.has(path.basename(from)),
	});
	git(adopterCopy, ["init", "-q"]);
	/** @type {string[]} */
	const adopterOut = [];
	const result = upgrade({
		root: adopterCopy,
		pluginRoot: outDir,
		out: (line) => adopterOut.push(line),
		env: { ...verifyEnv, CLAUDE_PROJECT_DIR: adopterCopy },
		verifyTimeoutMs: VERIFY_TIMEOUT_MS,
		labels: { off: "a release's dry run writes no labels" },
	});
	if (result.status !== 0) {
		throw refusal(
			`dry-run adopter walk failed: ${result.reason ?? "non-zero exit"}`,
		);
	}
	return (
		`adopter walk: passed against ${dryRunAdopter}\n` +
		adopterOut.map((l) => `  ${l}\n`).join("") +
		helperCheck(adopterCopy, outDir, verifyEnv)
	);
}

/**
 * @param {string} root
 */
function refuseIfHeld(root) {
	const hold =
		readAt(root, "HEAD", HOLD_REL) ?? readAt(root, VERIFIED_REF, HOLD_REL);
	if (hold === null) return;
	// #246
	throw new Error(
		`releases are held by ${HOLD_REL}: ${hold.replace(/\s+/g, " ")}`,
	);
}

/** @param {string} root */
function verifiedOrThrow(root) {
	try {
		git(root, ["merge-base", "--is-ancestor", "HEAD", VERIFIED_REF]);
	} catch (e) {
		throw new Error(
			`HEAD is not on ${VERIFIED_REF} — a release ships only a commit main holds, so land it there and fetch first`,
			{ cause: e },
		);
	}
}

/**
 * @param {string} root
 * @param {{dryRunAdopter?: string}} [opts]
 * @returns {{tag: string, commit: string, adopterLine: string}}
 */
function release(root, { dryRunAdopter } = {}) {
	if (git(root, ["status", "--porcelain"]) !== "") {
		throw new Error(
			"the working tree is dirty — commit or stash before releasing",
		);
	}

	verifiedOrThrow(root);
	refuseIfHeld(root);
	const { plugin, tag } = readReleaseTarget(root);

	noteAheadOrThrow(root, tag);
	const note = readNoteOrThrow(root, tag);
	surfaceContractOrThrow(root);
	if (
		dryRunAdopter &&
		!fs.statSync(dryRunAdopter, { throwIfNoEntry: false })?.isDirectory()
	) {
		throw new Error(`--dry-run-adopter ${dryRunAdopter} is not a directory`);
	}

	const config = readConfig({ root, quiet: true });

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-release-"));
	try {
		// #135
		const verifyEnv = {
			...process.env,
			CLAUDE_CONFIG_DIR: path.join(tmp, "release-claude-config"),
		};
		if (config.commands.test) {
			verifyOrThrow(root, config.commands.test, "the core's suite", verifyEnv);
		}

		if (note !== null) {
			const parsed = parseNote(note);
			verifyOrThrow(
				root,
				/** @type {string} */ (parsed.verify),
				`${tag}'s note Verify`,
				verifyEnv,
			);
		}

		const src = path.join(tmp, "src");
		const outDir = path.join(tmp, "out");
		const tar = path.join(tmp, "head.tar");
		fs.mkdirSync(src);
		git(root, ["archive", "--format=tar", "-o", tar, "HEAD"]);
		execFileSync("tar", ["-x", "-f", tar, "-C", src]);
		buildTree(src, outDir);

		const adopterLine = dryRunAdopter
			? walkAdopter(dryRunAdopter, tmp, outDir, verifyEnv)
			: "adopter walk: SKIPPED (no --dry-run-adopter given)\n";

		const source = git(root, ["rev-parse", "HEAD"]);
		const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
		const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
		const plumb = (/** @type {string[]} */ args) =>
			git(outDir, ["--git-dir", gitDir, "--work-tree", outDir, ...args], env);
		plumb(["add", "--all", "--force", "."]);
		const commit = plumb([
			"commit-tree",
			plumb(["write-tree"]),
			"-m",
			buildReleaseMessage(plugin.name, tag, source),
		]);
		git(root, ["tag", "-a", tag, commit, "-m", `${plugin.name} ${tag}`]);
		return { tag, commit, adopterLine };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

const BUMP_TITLE = "Bump workflow-core to ";

/**
 * @typedef {object} BumpFailure
 * @property {string} where
 * @property {string} reason
 * @property {string} retry
 */

// #4867 #2562
/**
 * @param {string[]} repos
 * @param {string} tag
 * @returns {{filed: string[], failed: BumpFailure[]}}
 */
function fileBumpIssues(repos, tag) {
	/** @type {string[]} */
	const filed = [];
	/** @type {BumpFailure[]} */
	const failed = [];
	/**
	 * @template T
	 * @param {string} repo
	 * @param {string[]} args
	 * @param {(args: string[]) => T} run
	 * @returns {T|null}
	 */
	const ghStep = (repo, args, run) => {
		try {
			return run(args);
		} catch (err) {
			failed.push({
				where: repo,
				reason: parseErrLine(err),
				retry: `gh ${args.map(shellQuote).join(" ")}`,
			});
			return null;
		}
	};
	/**
	 * @param {string} repo
	 * @param {number} blocked
	 * @param {number} blocker
	 */
	const block = (repo, blocked, blocker) => {
		const args = [`${repo}#${blocked}`, `${repo}#${blocker}`];
		const r = runLinkSync("blocker", args);
		if (r.warning) writeFd(2, `${r.warning}\n`);
		if (r.code !== 0)
			failed.push({
				where: repo,
				reason: r.err,
				retry: `node ${shellQuote(scriptPath("link-blocker.js"))} ${args.map(shellQuote).join(" ")}`,
			});
	};
	for (const repo of repos) {
		/** @type {{number: number, id: number, title: string, assignees: unknown[]}[]|null} */
		const older = ghStep(
			repo,
			[
				"api",
				`repos/${repo}/issues?state=open&labels=${MIGRATION_LABEL}&per_page=100`,
			],
			(args) =>
				ghApiSlurp(args.slice(1)).filter(
					(i) => !i.pull_request && i.title.startsWith(BUMP_TITLE),
				),
		);
		if (older === null) continue;
		const unstarted = older.filter((i) => i.assignees.length === 0);
		const walking = older.filter((i) => i.assignees.length > 0);
		const supersedes =
			unstarted.length > 0
				? ` It supersedes ${unstarted.map((i) => `#${i.number}`).join(", ")}, closed as its duplicates: the walk runs their notes too.`
				: "";
		/** @type {{number: number, id: number}|null} */
		const created = ghStep(
			repo,
			[
				"api",
				"--method",
				"POST",
				`repos/${repo}/issues`,
				"-f",
				`title=${BUMP_TITLE}${tag}`,
				"-f",
				`body=Migration note: ${MIGRATIONS_DIR}/${tag}.md in ${UPSTREAM_CODE_REPO}. Closed by the bump commit. After it, run the install commands and the accept that docs/agents/adopter-upgrade.md §The install is the session's names, each bare (#5230).${supersedes}`,
				"-f",
				`labels[]=${MIGRATION_LABEL}`,
				"-f",
				`labels[]=${URGENT_LABEL}`,
				"-f",
				`labels[]=${originLabel("release-bump")}`,
			],
			(args) => JSON.parse(gh(args)),
		);
		if (created === null) continue;
		filed.push(repo);
		for (const i of unstarted)
			ghStep(
				repo,
				[
					"issue",
					"close",
					String(i.number),
					"--repo",
					repo,
					"--duplicate-of",
					String(created.number),
					"--comment",
					`Superseded by #${created.number}, ${BUMP_TITLE}${tag}: its walk runs this note too.`,
				],
				gh,
			);
		for (const i of walking) block(repo, created.number, i.number);
	}
	return { filed, failed };
}

/**
 * @param {string} home
 * @returns {{repos: string[], unresolved: BumpFailure[], excluded: import("./lib/refill-repos").LeftOut[]}}
 */
function readBumpTrackers(home) {
	/** @type {string[]} */
	const repos = [];
	/** @type {BumpFailure[]} */
	const unresolved = [];
	const adopters = readAdopterCheckouts(home);
	for (const root of adopters.included) {
		if (isCoreHost(root)) continue;
		/** @type {string|null} */
		let tracker;
		let why = "no tracker resolves";
		try {
			tracker = readHostTracker(root);
		} catch (err) {
			tracker = null;
			why = caught(err).message;
		}
		if (tracker === null) {
			unresolved.push({
				where: root,
				reason: why,
				retry: `declare "tracker" in ${path.join(root, ".claude", "workflow-core.json")}, then open its bump issue by hand`,
			});
			continue;
		}
		const seen = tracker;
		if (!repos.some((r) => isSameRepo(r, seen))) repos.push(seen);
	}
	return {
		repos,
		unresolved,
		excluded: adopters.excluded,
	};
}

/**
 * @param {string} tag
 * @param {string} home
 * @returns {{report: string, trackerFailure: boolean}}
 */
function buildBumpIssueReport(tag, home) {
	let report = "";
	// #242
	let trackers;
	try {
		trackers = readBumpTrackers(home);
	} catch (err) {
		return {
			report: `failed bump issues:\n  ${home} (${caught(err).message})\n    retry: open each adopter's bump issue by hand\n`,
			trackerFailure: true,
		};
	}
	const { repos, unresolved, excluded } = trackers;
	const { filed, failed } = fileBumpIssues(repos, tag);
	failed.unshift(...unresolved);
	for (const e of excluded)
		report += `bump issue skipped: ${e.root} (${e.why})\n`;
	if (filed.length > 0) report += `filed bump issues: ${filed.join(", ")}\n`;
	if (filed.length === 0 && failed.length === 0)
		report += `filed bump issues: none, since no adopter checkout other than workflow-core is under ${home}\n`;
	if (failed.length === 0) return { report, trackerFailure: false };
	report += "failed bump issues:\n";
	for (const f of failed)
		report += `  ${f.where} (${f.reason})\n    retry: ${f.retry}\n`;
	return { report, trackerFailure: true };
}

/**
 * @param {string[]} argv
 */
function main(argv) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const { flags } = parsed;
	const args = {
		dryRunAdopter: flagValue(flags, "--dry-run-adopter"),
		push: flags["--push"] === true,
		fileBumpIssues: flags["--file-bump-issues"] === true,
	};
	try {
		const root = worktreeRoot();
		const { tag, commit, adopterLine } = release(root, {
			dryRunAdopter: args.dryRunAdopter,
		});
		let report = `tagged ${tag} at ${commit}\n${adopterLine}`;
		if (args.push) {
			git(root, ["push", "origin", tag]);
			report += `pushed ${tag}\n`;
		} else {
			report += `publish: git push origin ${tag}\n`;
		}
		const bump = args.fileBumpIssues
			? buildBumpIssueReport(tag, homeDir())
			: { report: "", trackerFailure: false };
		report += bump.report;
		const trackerFailure = bump.trackerFailure;
		writeFd(1, report);
		return trackerFailure ? 1 : 0;
	} catch (err) {
		const detail =
			err instanceof Error && "detail" in err ? String(err.detail) : "";
		writeFd(
			2,
			`release-plugin: ${parseErrLine(err)}\n${detail ? `${detail}\n` : ""}`,
		);
		return 1;
	}
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
