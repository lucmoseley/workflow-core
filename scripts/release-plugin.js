#!/usr/bin/env node
/*
 * release-plugin.js — cuts a plugin release: the trimmed tree
 * lib/plugin-tree.js renders from HEAD, committed and tagged
 * `v<plugin.json version>`, so the marketplace's `ref` names exactly what an
 * adopter installs (#4, founder ruling Q1 (B)).
 *
 * Usage:
 *   node scripts/release-plugin.js [--push] [--dry-run-adopter <path>]
 *     [--file-bump-issues] [--reason <why>]
 *
 * Joins no §N3 family: it writes git objects and a tag rather than a file,
 * exiting 0 on a cut and 1, reason on stderr, on a refusal — and 1 for a
 * SUCCESSFUL cut too where `--file-bump-issues` left a tracker unfiled or a
 * bump unlinked, the reason then on stdout, in the report, alongside every
 * filed one (#242).
 *
 * Releases the tree it runs in, a linked worktree included, never that
 * worktree's main checkout (lib/host-root.js `worktreeRoot`, #2412).
 *
 * HEAD, NEVER THE WORKING TREE. The tree is rendered from `git archive HEAD`,
 * so an uncommitted edit cannot ship. And HEAD must be on `origin/main`
 * (lib/landing-refs.js's VERIFIED_REF): a session's HEAD carries queue-ref
 * commits the full suite has not yet passed (#2408).
 *
 * THE RELEASE COMMIT IS A ROOT COMMIT, off every branch, made with plumbing
 * against a throwaway index: nothing on `main` moves and no hook runs. The tag
 * alone keeps it reachable. Pushing is left to the caller — the command is printed.
 * So `git tag --contains <sha>` is always empty: which release carries a
 * commit is `node scripts/release-contains.js <sha>`'s to answer (#797).
 *
 * Refuses where the tag already exists, and where the marketplace entry for
 * this plugin does not pin the tag, since a cut the marketplace does not name
 * installs nothing.
 *
 * #463 adds one more: a helper-surface export the last release promised,
 * dropped without a major bump and its note (check-surface-contract.js).
 *
 * RELEASES ARE BATCHED, ABOUT ONE A WEEK (founder ruling #5223 Q1 (A)): each
 * cut reports the days since the last tag, and one under CADENCE_DAYS after it
 * refuses unless `--reason <why>` states one, such as a broken release or an
 * adopter blocked on a fix. The reason rides in the tag's annotation.
 *
 * #4252 adds one more: a `migrations/hold.txt` at HEAD or on `origin/main`
 * holds every cut, its text the reason and what lifts it. The commit that
 * lifts the hold deletes it.
 *
 * And one more: a migration note at HEAD naming a version above the tag
 * being cut (#5276).
 *
 * #6 adds five more refusals: a dirty tree; a red core
 * (`commands.test`, skipped where undeclared — CLAUDE.md's own skip
 * convention); a major bump with no `migrations/v<tag>.md`; a malformed one
 * (scripts/lib/migration-note.js); and that note's own *Verify* command
 * failing against the core. `--dry-run-adopter <path>` runs `upgrade.js`
 * against a throwaway COPY of a second checkout (a local path in tests; the
 * real dry-run adopter is the caller's to pass) — the copy takes the whole
 * walk for real, residue and each note's own *Verify* included, so the walk
 * never writes to the caller's tree (#291) and the check still proves what
 * it is named for (#296). A note's Verify is arbitrary shell and can still
 * write anywhere it likes; what is bounded is the walk. Refuses if the walk
 * refuses, whether on a malformed note, a pin ahead of the release, or an
 * in-range note's Verify — a PROBED note's Verify is reported and stepped
 * over (upgrade.js, #284). Omitted, it SKIPS
 * rather than silently passing, since this repo has no standing network
 * fixture to point at by default. After the walk, the copy's own
 * `commands.helper_check` runs with the resolver's WORKFLOW_CORE_DIR pointed
 * at the rendered tree, proving the surface importable from outside the
 * plugin before the tag exists (#464); undeclared, it SKIPS. The copy carries
 * no node_modules, so the command must need none — the surface requires no
 * npm package, and the resolver only builtins.
 *
 * PUSHING AND BUMP-ISSUE FILING STAY OPT-IN (`--push`, `--file-bump-issues`):
 * the spec has `release` do both unconditionally, but cutting a real tag,
 * pushing it and opening issues on other trackers are irreversible and this
 * repo's own guard rules gate pushes on a human decision — so the default
 * call still only prints the publish command.
 *
 * THE BUMP TRACKERS ARE DERIVED, never typed (#5229): every adopter checkout
 * lib/refill-repos.js finds under `$HOME`, save the core itself, by the
 * tracker its config resolves.
 */

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
const { now } = require("./lib/clock.js");
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
		"usage: node scripts/release-plugin.js [--push] [--dry-run-adopter <path>] [--file-bump-issues] [--reason <why>]",
	flags: {
		"--push": /** @type {const} */ ("boolean"),
		"--dry-run-adopter": /** @type {const} */ ("value"),
		"--file-bump-issues": /** @type {const} */ ("boolean"),
		"--reason": /** @type {const} */ ("value"),
	},
};

const CADENCE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

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

/* A first guess, and stated as one (#135 review): long enough for a real
 * suite, short enough that a hung Verify still frees the tmp dir it now runs
 * inside rather than leaking it for the life of the process. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * main()'s catch prints a refusal through `parseErrLine`, which keeps the message's
 * first line only; a command's output under it rides on `detail`, printed whole
 * beneath that line (#1268).
 * @param {string} message
 */
function refusal(message) {
	const detail = message.split("\n").slice(1).join("\n");
	return Object.assign(new Error(message), { detail });
}

/**
 * @param {string} root
 * @param {string} command a shell command
 * @param {string} label named in the refusal on failure
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

/**
 * Refuses a cut that drops a helper-surface export an adopter was promised,
 * short of a major bump with a note (#463). Its SKIPs pass: a core with no
 * surface, or no prior release carrying one, has no contract to break.
 * Spawned rather than imported so the release gets the same OK/SKIP/BROKEN
 * verdict CI does.
 * @param {string} root
 */
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
 * Runs the adopter's `commands.helper_check` in `adopterRoot` against the
 * rendered tree `pluginRoot`, throwing on a failure (#464).
 * @param {string} adopterRoot
 * @param {string} pluginRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} the report line
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
 * `rel`'s text at `ref`, or null where `ref` holds no such file.
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
 * Refuses a cut below the newest migration note at HEAD: its release names
 * that version, so a lower tag ships what the note describes under the wrong
 * number, and no adopter walks the note until a later cut (#5276).
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
 * The tag's migration note at HEAD, or null where it ships none.
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
			/* One line, for the reason `refusal()` gives (#246 — a malformed
			 * manual step must name the bullet in that refusal). */
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
 * @returns {string} the report's adopter lines
 */
function walkAdopter(dryRunAdopter, tmp, outDir, verifyEnv) {
	/* NO REAL INSTALL HERE, and none is possible: upgrade() (#217, #230)
	 * never materialises the plugin — that is wholly the reconciler's
	 * job.
	 *
	 * WALKED AGAINST A COPY, never the adopter itself (#291, #296).
	 * #291 stopped the adopter being mutated by passing
	 * `dryRun: true`, but that same flag skips `applyResidue` and
	 * the note's own Verify with it (lib/upgrade-walk.js's `walkNote`), leaving
	 * this step proving note SHAPE alone — which the cut's own note
	 * checks in `release()` already prove against the core. Copying first
	 * gets both back: residue applies, Verify runs, `walkedTo`
	 * advances and `.husky/*` is rewritten to shims, all under `tmp`, which
	 * `release()`'s `finally` deletes.
	 *
	 * THREE THINGS KEEP THE WALK'S WRITES INSIDE THE COPY:
	 *
	 * `dereference: true` — cpSync otherwise copies a symlink AS a
	 * symlink and rewrites a relative target to an absolute one
	 * pointing back into the ORIGINAL, so re-pointing the copy's own
	 * `.husky/pre-commit` would have written the caller's file.
	 *
	 * `.git` dropped, alongside `node_modules` — `.git` carries
	 * sockets `cpSync` refuses outright, and without an origin remote
	 * nothing can derive an adopter tracker from the copy. A fresh,
	 * remoteless `git init` stands in for it, so a Verify's
	 * `git check-ignore` of an untracked path reads the copy's own
	 * `.gitignore` as a real adopter's would (#780). Residual: the
	 * repository is empty — no index, no commits, not the original's
	 * `.git/info/exclude` — so a Verify asking what is tracked or
	 * committed, or leaning on that exclude file, answers otherwise.
	 *
	 * The labels are turned off: every run syncs the adopter's
	 * real tracker, a live write no dry run may make (#1501).
	 *
	 * upgrade() takes `env` and `verifyTimeoutMs` (#300): #135's
	 * throwaway CLAUDE_CONFIG_DIR and this leg's own
	 * CLAUDE_PROJECT_DIR — pinned to `adopterCopy`, so
	 * hostRoot() (which reads it before the cwd) resolves the copy
	 * rather than this release's own checkout — are passed straight
	 * to the call below, and VERIFY_TIMEOUT_MS bounds it exactly as
	 * it bounds the core's own suite and note Verify in `release()`.
	 *
	 * `out` is collected rather than dropped (#117 review): upgrade()
	 * returns 0 for a directory-sourced adopter and for "nothing to
	 * walk" alike, so a bare "passed" line cannot be told from a
	 * Verify that did nothing. */
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
	/* One line: `refusal()` prints only the first (#246). */
	throw new Error(
		`releases are held by ${HOLD_REL}: ${hold.replace(/\s+/g, " ")}`,
	);
}

/**
 * The report line on the gap since the last tag, and whether the cut is early;
 * refuses an early cut that no `reason` explains.
 * @param {string} root
 * @param {string} [reason]
 * @returns {{line: string, early: boolean}}
 */
function cadenceOrThrow(root, reason) {
	const last = readLatestTag(root);
	if (last === null) return { line: "last release: none\n", early: false };
	const cutSec = Number(
		git(root, [
			"for-each-ref",
			"--format=%(creatordate:unix)",
			`refs/tags/${last}`,
		]),
	);
	const days = (now() - cutSec * 1000) / DAY_MS;
	const line = `last release: ${last}, ${days.toFixed(1)} days ago\n`;
	if (days >= CADENCE_DAYS) return { line, early: false };
	if (!reason) {
		throw new Error(
			`${last} was cut ${days.toFixed(1)} days ago, under the ${CADENCE_DAYS}-day release cadence (#5223) — batch the change into the next weekly cut, or pass --reason "<why>", such as a broken release or an adopter blocked on a fix`,
		);
	}
	return { line: `${line}early cut: ${reason}\n`, early: true };
}

/**
 * Refuses a HEAD that `origin/main` does not hold.
 * @param {string} root
 */
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
 * @param {{dryRunAdopter?: string, reason?: string}} [opts]
 * @returns {{tag: string, commit: string, adopterLine: string, cadenceLine: string}}
 */
function release(root, { dryRunAdopter, reason } = {}) {
	if (git(root, ["status", "--porcelain"]) !== "") {
		throw new Error(
			"the working tree is dirty — commit or stash before releasing",
		);
	}

	verifiedOrThrow(root);
	refuseIfHeld(root);
	const { plugin, tag } = readReleaseTarget(root);
	const cadence = cadenceOrThrow(root, reason);

	/* Cheapest refusals first — no point running the whole suite before a
	 * missing or malformed note refuses the release outright. */
	noteAheadOrThrow(root, tag);
	const note = readNoteOrThrow(root, tag);
	surfaceContractOrThrow(root);
	/* Here rather than at the copy in `walkAdopter`, which happens after the core's own
	 * suite and note Verify have already run — a mistyped path should refuse
	 * in the same breath as a missing note, not ten minutes later. */
	if (
		dryRunAdopter &&
		!fs.statSync(dryRunAdopter, { throwIfNoEntry: false })?.isDirectory()
	) {
		throw new Error(`--dry-run-adopter ${dryRunAdopter} is not a directory`);
	}

	const config = readConfig({ root, quiet: true });

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-release-"));
	try {
		/* #135: the whole cut's shell-outs — the core's own suite, a note's
		 * Verify, and the adopter walk's Verify below — run under one
		 * throwaway CLAUDE_CONFIG_DIR rather than whatever the calling
		 * session's own env carries, the same hazard #117 fixed for the
		 * dry-run-adopter step. */
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
		const annotation = cadence.early
			? `${plugin.name} ${tag}\n\nEarly cut: ${reason}`
			: `${plugin.name} ${tag}`;
		git(root, ["tag", "-a", tag, commit, "-m", annotation]);
		return { tag, commit, adopterLine, cadenceLine: cadence.line };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

const BUMP_TITLE = "Bump workflow-core to ";

/**
 * @typedef {object} BumpFailure
 * @property {string} where the tracker, or the checkout whose tracker would
 *   not resolve
 * @property {string} reason
 * @property {string} retry
 */

/**
 * Opens "Bump workflow-core to vX" on each adopter tracker, labelled for
 * `/pick-next` and `urgent`, so a bump outranks the adopter's other work, and
 * `origin:release-bump`, so the ticket-mix review counts it (#4867). Opt-in — see the header. The binary is `scripts/lib/gh.js`'s
 * WFC_GH seam, not a per-call override — a test points it there directly.
 *
 * ONE LINE PER ADOPTER (#2562). `upgrade.js` walks every note from `walkedTo`
 * to the installed plugin, so the newest bump does every older open bump's
 * work, and two bump sessions in one tree rewrite the same pin, `walkedTo`
 * and `stepsOwed` under each other. pick-next takes no issue with an open
 * blocker, so each older bump nobody is assigned is blocked by the new one,
 * whose body names them for its session to close; an assigned one may
 * already be walking, so the new one is blocked by it instead. Blocked
 * rather than bundled: pick-next's merge rule wants disjoint edit targets.
 *
 * Each gh step is caught on its own (#242). A failed entry carries the exact
 * command to retry that step by hand, alongside the reason. A failed read of
 * the older bumps files nothing, since filing blind would reopen the race.
 * @param {string[]} repos `owner/name` per tracker
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
	 * @returns {T|null} null once the failure is recorded
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
	 * The link, through lib/link-writer.js, which refuses a loop and verifies
	 * the edge in a separate read.
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
			// per_page=100 is GitHub's maximum page size.
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
		const covered = older.filter((i) => i.assignees.length === 0);
		const walking = older.filter((i) => i.assignees.length > 0);
		const closesCovered =
			covered.length > 0
				? ` It walks through the notes of ${covered.map((i) => `#${i.number}`).join(", ")} too: close each with a comment naming the bump commit.`
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
				`body=Migration note: ${MIGRATIONS_DIR}/${tag}.md in ${UPSTREAM_CODE_REPO}. Closed by the bump commit. After it, run the install commands and the accept that docs/agents/adopter-upgrade.md §The install is the session's names, each bare (#5230).${closesCovered}`,
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
		for (const i of covered) block(repo, i.number, created.number);
		for (const i of walking) block(repo, created.number, i.number);
	}
	return { filed, failed };
}

/**
 * Each adopter's tracker, once; each adopter whose tracker will not resolve,
 * which files nothing and so fails the run; and each config-carrying checkout
 * discovery left out, with why.
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
 * @param {string} home where the adopter checkouts sit
 * @returns {{report: string, trackerFailure: boolean}}
 */
function buildBumpIssueReport(tag, home) {
	let report = "";
	/* Thrown here, the tag is already cut, so it reports as a tracker
	 * failure, never as main's no-tag refusal (#242). */
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
		reason: flagValue(flags, "--reason")?.trim() || undefined,
	};
	try {
		const root = worktreeRoot();
		const { tag, commit, adopterLine, cadenceLine } = release(root, {
			dryRunAdopter: args.dryRunAdopter,
			reason: args.reason,
		});
		let report = `tagged ${tag} at ${commit}\n${cadenceLine}${adopterLine}`;
		if (args.push) {
			git(root, ["push", "origin", tag]);
			report += `pushed ${tag}\n`;
		} else {
			report += `publish: git push origin ${tag}\n`;
		}
		/* Distinct from the refusals below (#242), which mean no tag was cut
		 * at all. */
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
