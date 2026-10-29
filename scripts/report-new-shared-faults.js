#!/usr/bin/env node
/*
 * Which faults of the CHECKERS table's checkers and check-doc-map.js a COMMIT
 * added relative to its parent (mantahostels#1823, mantahostels#1824) — the same
 * set-difference checker-new-faults.js already does for staged-vs-HEAD (mantahostels#1753),
 * generalised to two arbitrary commits.
 *
 *   node scripts/report-new-shared-faults.js [<sha>]   (default HEAD)
 *
 * PURELY A REPORT. Wired into .husky/post-commit (mantahostels#1825), its only
 * automatic caller.
 *
 * check-doc-map.js DOESN'T TAKE --root, unlike the others, so its
 * reading is built differently from the archive-materialised pair below —
 * see readDocMapEnvelope's own docstring (mantahostels#1824).
 *
 * NOT IN THE `report-*` FAMILY DESPITE THE PREFIX (§N3, §G4): that family
 * files a GitHub issue and always exits 0. This has no scheduled trigger of
 * its own and would file one issue per commit. Exit code is informational
 * only, never a gate:
 *   0  nothing new to report (a root commit, or a clean diff)
 *   1  the lines printed are faults this commit added
 *   2  at least one side could not be read — the printed line names which —
 *      or lib/cli-args.js refused the command line; `--help` exits 0
 *
 * PROFILES come from lib/fault-profiles.js so the two scripts can never drift
 * on what makes two faults the same fault.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const { execGit, gitCommonDirOrThrow, spawnGitSync } = require("./lib/git.js");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const os = require("node:os");
const path = require("node:path");
const { PROFILES } = require("./lib/fault-profiles.js");
const { parseOrExit } = require("./lib/cli-args");
const { newFaults } = require("./lib/fault-diff");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group");
const { caught } = require("./lib/caught.js");
const { parseErrorFirstLine, parseFirstLine } = require("./lib/first-line.js");

/* Core content: every checker below ships beside this script, so each is named
 * from THIS DIRECTORY (#1) — a plugin install keeps them beside the caller. */
const CORE_SCRIPTS = __dirname;

/** Profile name -> the checker script that emits its --json envelope, for the
 * checkers that take --root. check-doc-map.js is not in this table: its
 * envelope is read by readDocMapEnvelope() below, on a different calling
 * convention (see the header comment). */
const CHECKERS = {
	"guard-registry": path.join(CORE_SCRIPTS, "check-guard-registry.js"),
	"guard-test-isolation": path.join(
		CORE_SCRIPTS,
		"check-guard-test-isolation.js",
	),
	"host-root-test-isolation": path.join(
		CORE_SCRIPTS,
		"check-host-root-test-isolation.js",
	),
	"context-budget": path.join(CORE_SCRIPTS, "check-context-budget.js"),
	"website-copy": path.join(CORE_SCRIPTS, "check-website-copy.js"),
	"git-fixture-identity": path.join(
		CORE_SCRIPTS,
		"check-git-fixture-identity.js",
	),
	"host-root": path.join(CORE_SCRIPTS, "check-host-root.js"),
	"skill-frontmatter": path.join(CORE_SCRIPTS, "check-skill-frontmatter.js"),
	"jsonl-reads": path.join(CORE_SCRIPTS, "check-jsonl-reads.js"),
	"clock-copies": path.join(CORE_SCRIPTS, "check-clock-copies.js"),
	"report-programs": path.join(CORE_SCRIPTS, "check-report-programs.js"),
	"cli-args": path.join(CORE_SCRIPTS, "check-cli-args.js"),
	"test-spawn": path.join(CORE_SCRIPTS, "check-test-spawn.js"),
};

const CHECK_DOC_MAP = path.join(CORE_SCRIPTS, "check-doc-map.js");

/* A JSON object of profile name -> checker script that replaces CHECKERS
 * whole, so report-new-shared-faults.test.ts can run the program against stub
 * checkers in a fixture repo (#1370). Never set in production. */
const CHECKERS_ENV = "WFC_SHARED_FAULT_CHECKERS";

/** @returns {Record<string, string>} */
const checkersInForce = () => {
	const raw = process.env[CHECKERS_ENV];
	return raw ? JSON.parse(raw) : CHECKERS;
};

/**
 * Why each registered checker is in the notice, and what a red there costs the
 * OTHER sessions (mantahostels#1750).
 *
 * `full` is the command that shows the reader MORE than the notice already
 * did — the checker itself, over the working tree, WARNs and context included.
 *
 * KEYED BY PROFILE NAME, AND EVERY lib/fault-profiles.js PROFILE HAS A ROW —
 * a profile with none throws, and report-new-shared-faults.test.ts prints a
 * cost line for every profile, so registering a checker for the diff and
 * registering it for the notice are one act. A row no profile names is
 * harmless and goes unchecked.
 *
 * @type {Record<string, { why: string, cost: string, full: string }>}
 */
const COSTS = {
	"guard-registry": {
		why: "whole-repo, no direction gate in .husky/pre-commit",
		cost:
			"refuses every other session's commit touching docs/, .claude/, " +
			"scripts/, .husky/, CLAUDE.md or AGENTS.md",
		full: "node scripts/check-guard-registry.js",
	},
	"guard-test-isolation": {
		why: "whole-repo, no direction gate in .husky/pre-commit",
		cost:
			"refuses every other session's commit touching a scripts/ .ts or " +
			"shell file",
		full: "node scripts/check-guard-test-isolation.js",
	},
	"host-root-test-isolation": {
		why: "whole-repo, no direction gate in .husky/pre-commit",
		cost:
			"refuses every other session's commit touching a scripts/ test or " +
			"script",
		full: "node scripts/check-host-root-test-isolation.js",
	},
	"git-fixture-identity": {
		why: "whole-repo, no direction gate in .husky/pre-commit",
		cost:
			"refuses every other session's commit touching a scripts/ test file, " +
			"over a raw-init/raw-commit pair that can sit in an unrelated file",
		full: "node scripts/check-git-fixture-identity.js",
	},
	"doc-map": {
		why: "whole-repo assertion, direction-gated in .husky/pre-commit",
		cost: "fails the scheduled sweeps, and warns every other session's docs commit",
		full: "node scripts/check-doc-map.js",
	},
	"context-budget": {
		why: "whole-repo surface, direction-gated in .husky/pre-commit (mantahostels#1834)",
		cost:
			"warns every other session's commit touching docs/, .claude/, CLAUDE.md, " +
			"AGENTS.md or the tracker injector, and refuses the next one that adds " +
			"to the same surface",
		full: "node scripts/check-context-budget.js",
	},
	"website-copy": {
		why: "whole-repo scan of app/, direction-gated in .husky/pre-commit (mantahostels#1834)",
		cost: "warns every other session's commit touching app/",
		full: "node scripts/check-website-copy.js",
	},
	"skill-frontmatter": {
		why: "every own skill, direction-gated in .husky/pre-commit (#887)",
		cost: "fails the scheduled sweep, and warns every other session's commit touching that skill",
		full: "node scripts/check-skill-frontmatter.js",
	},
	"host-root": {
		why: "every script's host-root seam, direction-gated in .husky/pre-commit (#917)",
		cost: "warns every other session's commit touching scripts/, .claude/ or .husky/",
		full: "node scripts/check-host-root.js",
	},
	"jsonl-reads": {
		why: "every hand split-and-parse of JSONL, judged whole-tree in .husky/pre-commit (#3452, #3453)",
		cost: "refuses every other session's commit staging a scripts/ program until that site reads through lib/jsonl.js",
		full: "node scripts/check-jsonl-reads.js",
	},
	"clock-copies": {
		why: "every WFC_NOW read outside lib/check.js's now(), judged whole-tree in .husky/pre-commit (#3457)",
		cost: "refuses every other session's commit staging a scripts/ program until that read goes through now()",
		full: "node scripts/check-clock-copies.js",
	},
	"report-programs": {
		why: "every report-* program's output and issue filing, judged whole-tree in .husky/pre-commit (#3454)",
		cost: "refuses every other session's commit staging a report-* until that program writes through writeFd and files through createIssue",
		full: "node scripts/check-report-programs.js",
	},
	"cli-args": {
		why: "every top-level script's argv reader, direction-gated in .husky/pre-commit (#920)",
		cost: "refuses every other session's commit that edits that script until it parses its argv strictly",
		full: "node scripts/check-cli-args.js",
	},
	"test-spawn": {
		why: "every test's spawn of node on the program under test, judged whole-tree in .husky/pre-commit (#3458)",
		cost: "refuses every other session's commit staging a test until that spawn runs in-process or states why",
		full: "node scripts/check-test-spawn.js",
	},
	registrations: {
		why: "a host's own hooks, guards and checkers, direction-gated in .husky/pre-commit (#1456)",
		cost: "refuses every other session's commit touching .claude/settings.json, a host registry, scripts/, .husky/ or a workflow",
		full: "node scripts/check-registrations.js",
	},
};

/* git and check-doc-map.js's stdout both default to Node's 1 MiB spawn cap —
 * the doc-map alone is ~79,000 words (check-doc-map.js's own header). */
const MAX_BUFFER = 64 * 1024 * 1024;

/* ── Leftovers, and the sweep that clears them (mantahostels#1883) ─────────────────────
 *
 * Every temp directory and every worktree below is removed in a `finally`,
 * which covers every route this script can RETURN through and none it can be
 * KILLED through. mantahostels#1825 wired it into .husky/post-commit, so it now runs on
 * every commit, on a machine where earlyoom killing a process mid-run is
 * routine (docs/environment.md §5). A SIGKILL left two ~20 MB trees under
 * os.tmpdir() and — the one that matters — a detached worktree still
 * registered in .git/worktrees, a write to the repository outliving the
 * process, against mantahostels#1750's user story 20 ("the reporter never writes to the
 * repository").
 *
 * So every leftover is named with the pid that made it, and each run sweeps
 * the ones whose pid is gone before it makes its own. A signal handler is not
 * the whole answer: it cannot see SIGKILL at all. Nor is `git worktree
 * prune` — it has no way to be scoped, so it would also drop
 * a SESSION's worktree whose directory had been deleted by hand.
 *
 * They all sit in ONE directory of our own rather than loose in os.tmpdir():
 * /tmp here holds ~225,000 entries and a readdir of it costs ~400 ms, against
 * the 4.75-5.90 s the whole script takes on this repo's own HEAD.
 *
 * KNOWN GAP: leftovers from BEFORE mantahostels#1883 were flat siblings in os.tmpdir()
 * (`report-new-shared-faults-*`), carry no pid, and no sweep can judge them.
 * Measured as zero on this machine — no such directory, and no such worktree
 * in `git worktree list` — so no migration was written.
 */
const LEFTOVER_ROOT_ENV = "WFC_SHARED_FAULT_TMP";

/**
 * Where the leftovers live. report-new-shared-faults.test.ts redirects it:
 * those cases SIGKILL real runs and then assert the leftovers are STILL THERE,
 * while every neighbour session's post-commit run (mantahostels#1825) sweeps
 * this same shared directory — so a neighbour's commit landing mid-test would
 * sweep the leftovers the assertion is about. Never set in production.
 */
const leftoverRoot = () =>
	process.env[LEFTOVER_ROOT_ENV] ||
	path.join(os.tmpdir(), "report-new-shared-faults");

/** The two leftover shapes: `tree` is a materialised archive, `dm` a detached
 * doc-map worktree. One list feeds both the names written and the name read
 * back, so the two can never drift. */
const KINDS = ["tree", "dm"];
const LEFTOVER_NAME = new RegExp(`^(${KINDS.join("|")})-(\\d+)-`);

/** `<kind>-<pid>-`, the stem a new leftover's name starts with. */
const leftoverStem = (/** @type {string} */ kind) => `${kind}-${process.pid}-`;

/**
 * `{ kind, pid }` for one of OUR leftover names, or null for anything else. A
 * name that does not parse is never swept, which is what keeps this off a
 * session's worktree, a neighbour script's temp dir, and whatever else is
 * sitting in the same directory.
 *
 * @returns {{ kind: string, pid: number } | null}
 */
function parseLeftover(/** @type {string} */ base) {
	const m = LEFTOVER_NAME.exec(base);
	return m
		? {
				kind: requiredGroup(m, 1, LEFTOVER_NAME),
				pid: Number(requiredGroup(m, 2, LEFTOVER_NAME)),
			}
		: null;
}

/** A backstop under pid reuse: a leftover older than this is swept whatever
 * its pid now belongs to. The whole script runs in seconds, so no live run can
 * reach it. */
const STALE_MS = 24 * 60 * 60 * 1000;

function pidAlive(/** @type {number} */ pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM is a live process owned by another user; ESRCH is a gone one.
		return caught(e).code === "EPERM";
	}
}

/** True where the run that made this leftover is gone. */
function isStale(
	/** @type {{ pid: number }} */ parsed,
	/** @type {number} */ mtimeMs,
) {
	return !pidAlive(parsed.pid) || Date.now() - mtimeMs > STALE_MS;
}

/** Abandoned archive trees. `dm-` names are left to sweepWorktrees(): removing
 * a worktree's DIRECTORY out from under git turns a registration git could
 * still remove cleanly into a dangling one. */
function sweepTrees() {
	const root = leftoverRoot();
	for (const base of fs.readdirSync(root)) {
		const dir = path.join(root, base);
		try {
			const parsed = parseLeftover(base);
			if (parsed?.kind !== "tree") continue;
			if (!isStale(parsed, fs.statSync(dir).mtimeMs)) continue;
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* raced by a concurrent sweep, or not ours to remove — leave it */
		}
	}
}

/**
 * Abandoned detached worktrees — the registration under .git/worktrees, not
 * just the directory. Read one admin directory at a time (each one's `gitdir`
 * file names the worktree it belongs to) so the name test above decides each
 * on its own, which is what a scoped `git worktree prune` would have to do and
 * cannot.
 */
function sweepWorktrees(/** @type {string} */ cwd) {
	const admin = path.join(
		gitCommonDirOrThrow(cwd, { stdio: ["ignore", "pipe", "inherit"] }),
		"worktrees",
	);
	if (!fs.existsSync(admin)) return;
	const root = leftoverRoot();
	/* git writes a RESOLVED path into each admin directory's `gitdir`, so a
	 * symlinked TMPDIR fails a raw string compare and would disable this whole
	 * sweep silently. Both spellings are accepted. */
	const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
	for (const id of fs.readdirSync(admin)) {
		const entry = path.join(admin, id);
		try {
			const worktree = path.dirname(
				fs.readFileSync(path.join(entry, "gitdir"), "utf8").trim(),
			);
			const parent = path.dirname(worktree);
			if (parent !== root && parent !== realRoot) continue;
			const parsed = parseLeftover(path.basename(worktree));
			if (parsed?.kind !== "dm") continue;
			if (!isStale(parsed, fs.statSync(entry).mtimeMs)) continue;
			if (fs.existsSync(worktree))
				execGit(["worktree", "remove", "--force", worktree], {
					cwd,
				});
			/* `git worktree remove` drops the admin directory itself; where the
			 * worktree directory was already gone — a /tmp cleaner, or a kill
			 * between the rm and the deregistration — nothing but this removes
			 * the registration. */
			fs.rmSync(entry, { recursive: true, force: true });
		} catch {
			/* unreadable, raced, or git refused — leave the entry standing */
		}
	}
}

/**
 * Both sweeps, and never a throw: a report that cannot tidy still reports.
 * Called once at the top of `run()`, before this run makes leftovers of its
 * own.
 */
function sweepLeftovers(/** @type {string} */ cwd) {
	fs.mkdirSync(leftoverRoot(), { recursive: true });
	/* Worktrees FIRST, so git removes the directory and its registration in
	 * one act rather than finding the directory already gone. sweepTrees()
	 * skipping `dm-` names makes the order redundant today — it is kept as the
	 * second guard, not the only one. */
	try {
		sweepWorktrees(cwd);
	} catch {
		/* not a git checkout, or git refused — the report itself still stands */
	}
	try {
		sweepTrees();
	} catch {
		/* the directory is unreadable — nothing to do about it here */
	}
}

/**
 * `ref`'s sha and its parents, oldest-first-parent order, as `git rev-list
 * --parents` prints them. An empty `parents` means a root commit.
 *
 * @returns {{ sha: string, parents: string[] }}
 */
function resolveCommit(/** @type {string} */ ref, /** @type {string} */ cwd) {
	const line = execGit(["rev-list", "--parents", "-n", "1", ref], {
		cwd,
		encoding: "utf8",
	}).trim();
	const [sha, ...parents] = line.split(/\s+/).filter(Boolean);
	if (sha === undefined)
		throw new Error(`git rev-list printed nothing for ${ref}`);
	return { sha, parents };
}

/**
 * Materialises `sha`'s tree into a fresh temp dir via `git archive` — the
 * pattern scripts/lib/check.js's `--against` materialiser uses, generalised
 * past HEAD to an arbitrary sha. Caller removes the directory.
 */
function materialise(/** @type {string} */ sha, /** @type {string} */ cwd) {
	const dir = fs.mkdtempSync(path.join(leftoverRoot(), leftoverStem("tree")));
	const tar = path.join(dir, "tree.tar");
	execGit(["archive", "--format=tar", "-o", tar, sha], { cwd });
	execFileSync("tar", ["-xf", tar, "-C", dir]);
	fs.rmSync(tar);
	return dir;
}

/**
 * `r` is a finished spawnSync() result whose stdout is meant to be a --json
 * envelope. Throws — never returns a partial or empty envelope — where the
 * process failed to start, hit a non-zero exit with unparseable stdout, or
 * printed something that is not a JSON object; the FAIL/WARN/BROKEN outcomes a
 * checker reports ITSELF still parse fine and are not this function's concern.
 */
function parseEnvelope(
	/** @type {{ error?: Error, status: number|null, stdout: string, stderr: string }} */ r,
) {
	if (r.error) throw new Error(r.error.message);
	let parsed;
	try {
		parsed = JSON.parse(r.stdout);
	} catch (e) {
		throw new Error(
			`invalid --json (exit ${r.status}): ${parseErrorFirstLine(e)}` +
				(r.stderr ? ` — ${parseFirstLine(r.stderr)}` : ""),
			{ cause: e },
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`not a --json envelope object (exit ${r.status})`);
	return parsed;
}

/**
 * Runs `checker --root <root> --json` and parses its envelope, for the two
 * checkers whose whole scan lives under a `--root` directory.
 */
function readEnvelope(
	/** @type {string} */ checker,
	/** @type {string} */ root,
) {
	return parseEnvelope(
		spawnSync(process.execPath, [checker, "--root", root, "--json"], {
			encoding: "utf8",
		}),
	);
}

/**
 * check-doc-map.js's --json envelope for `sha`, read without ever touching the
 * live working tree.
 *
 * A GIT_INDEX_FILE + `git read-tree <sha>` redirect (`.husky/pre-commit`'s own
 * doc-map block uses that for staged-vs-HEAD) only fixes `git ls-files` — the
 * scope check-doc-map.js asks git for directly, with no flag to redirect it.
 * It does NOT fix a literal `"HEAD"` rev, and lib/doc-map.js's `mapAtHead()`
 * and `readCommittedRevs()` both read one — always the live branch tip, whichever
 * `sha` was asked for. A throwaway DETACHED WORKTREE fixes both at once: its
 * `HEAD` genuinely IS `sha` there, so every git call check-doc-map.js makes —
 * `ls-files`, a literal `HEAD` rev, anything else — reads that commit and
 * nothing else. It also holds the six doc-map files as real files rather than
 * ones this function has to fetch out one by one, so check-doc-map.js is
 * pointed straight at the worktree's own docs/.
 *
 * A missing sidecar, an unparseable one, or anything else check-doc-map.js
 * cannot answer surfaces as ITS OWN BROKEN outcome (its header: "a missing or
 * unloadable data file is BROKEN") rather than a thrown error here — so a
 * BROKEN envelope is translated to a throw explicitly, or `newFaults` would
 * read its empty fault arrays as a clean run instead of "cannot answer".
 *
 * `cwd` must be a real git checkout (the host root, in production, #1) —
 * `git worktree add` needs a working `.git`.
 */
function readDocMapEnvelope(
	/** @type {string} */ sha,
	/** @type {string} */ cwd,
) {
	const dir = path.join(
		leftoverRoot(),
		`${leftoverStem("dm")}${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	execGit(["worktree", "add", "--detach", "--quiet", dir, sha], {
		cwd,
	});
	try {
		const envelope = parseEnvelope(
			spawnSync(
				process.execPath,
				[
					CHECK_DOC_MAP,
					path.join(dir, "docs", "doc-map.md"),
					"--data-dir",
					path.join(dir, "docs"),
					"--json",
				],
				{ cwd: dir, encoding: "utf8", maxBuffer: MAX_BUFFER },
			),
		);
		if (envelope.outcome === "BROKEN")
			throw new Error(
				typeof envelope.summary === "string"
					? envelope.summary
					: `check-doc-map.js reported BROKEN at ${sha}`,
			);
		return envelope;
	} finally {
		execGit(["worktree", "remove", "--force", dir], { cwd });
	}
}

/**
 * Whether `sha` carries a doc map at all.
 *
 * ABSENT is not the same as UNREADABLE, and only the second is worth a notice.
 * A repo that never took the map — a fork of this core — has nothing for the
 * doc-map limb to compare, and running it anyway prints
 * `could not read <sha>'s --json: BROKEN` after every single commit, which is a
 * false alarm rather than a finding. A map that IS in the tree and will not
 * read or parse still reaches `readDocMapEnvelope` and is still reported.
 *
 * `cat-file -e` asks the presence question and nothing else. Its own failure to
 * run is read as absent deliberately: this whole file reports and never blocks,
 * so the safe direction here is silence, and the doc-map gate in
 * `.husky/pre-commit` is what actually holds the map.
 *
 * @param {string} sha
 * @param {string} cwd
 * @returns {boolean}
 */
function hasDocMap(sha, cwd) {
	return (
		spawnGitSync(["cat-file", "-e", `${sha}:docs/doc-map.md`], {
			cwd,
			encoding: "utf8",
		}).status === 0
	);
}

/**
 * Reads `profile`'s two envelopes via the given thunks (each already
 * bound to shaDir/parentDir, or to sha/parent for doc-map — the two
 * profile families read differently, see readDocMapEnvelope's header) and
 * pushes what's new. Stops at the first unreadable side: a staged read
 * that fails never spends a second process on the baseline.
 * @param {{ sha: string, parent: string, err: string[], byProfile: Map<string, string[]> }} ctx
 * @param {string} profile
 * @param {() => Record<string, unknown>} readStaged
 * @param {() => Record<string, unknown>} readBaseline
 * @returns {boolean} whether a side could not be read
 */
function diffProfile(ctx, profile, readStaged, readBaseline) {
	const { sha, parent, err, byProfile } = ctx;
	const diffing = PROFILES[profile];
	if (diffing === undefined)
		throw new Error(`lib/fault-profiles.js has no profile ${profile}`);
	let staged;
	let baseline;
	try {
		staged = readStaged();
	} catch (e) {
		err.push(
			`report-new-shared-faults: ${profile} — could not read ${sha}'s --json: ${caught(e).message}`,
		);
		return true;
	}
	try {
		baseline = readBaseline();
	} catch (e) {
		err.push(
			`report-new-shared-faults: ${profile} — could not read ${parent}'s --json: ${caught(e).message}`,
		);
		return true;
	}
	for (const line of newFaults(staged, baseline, diffing)) {
		if (!byProfile.has(profile)) byProfile.set(profile, []);
		/** @type {string[]} */ (byProfile.get(profile)).push(line);
	}
	return false;
}

/**
 * Every profile's faults new at `sha` against `parent`.
 * @param {{ sha: string, parent: string, shaDir: string, parentDir: string, cwd: string, err: string[] }} trees
 * @returns {{ broken: boolean, byProfile: Map<string, string[]> }}
 */
function collectNewFaults(trees) {
	const { sha, parent, shaDir, parentDir, cwd, err } = trees;
	let broken = false;
	/** Profile name -> the fault lines it added, insertion-ordered so the
	 * notice reads in registration order. @type {Map<string, string[]>} */
	const byProfile = new Map();
	const ctx = { sha, parent, err, byProfile };

	for (const [profile, checker] of Object.entries(checkersInForce()))
		if (
			diffProfile(
				ctx,
				profile,
				() => readEnvelope(checker, shaDir),
				() => readEnvelope(checker, parentDir),
			)
		)
			broken = true;

	// check-doc-map.js is not in CHECKERS (see readDocMapEnvelope's header): it
	// reads a throwaway detached worktree rather than the one archived
	// `--root` tree the checkers above share.
	//
	// Gated on the map being THERE at both revisions — hasDocMap's header
	// owns why absence stands the limb down rather than reporting it.
	if (
		hasDocMap(sha, cwd) &&
		hasDocMap(parent, cwd) &&
		diffProfile(
			ctx,
			"doc-map",
			() => readDocMapEnvelope(sha, cwd),
			() => readDocMapEnvelope(parent, cwd),
		)
	)
		broken = true;
	return { broken, byProfile };
}

/**
 * The framing — heading, per-checker cost clause, footer — is written
 * ONLY where a fault was actually added, so a clean commit stays silent
 * and a merge or root commit with nothing new keeps its one bare line.
 * @param {string} sha
 * @param {Map<string, string[]>} byProfile
 * @returns {{ count: number, lines: string[] }} the faults added, and the
 *   notice's lines
 */
function noticeOf(sha, byProfile) {
	const count = [...byProfile.values()].reduce((n, l) => n + l.length, 0);
	/** @type {string[]} */
	const out = [];
	if (!count) return { count, lines: out };
	out.push(
		`report-new-shared-faults: ${sha} added ${count} whole-repo fault${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not in its parent.`,
		"  This REPORTS and never blocks.",
	);
	for (const [profile, lines] of byProfile) {
		const costed = COSTS[profile];
		if (costed === undefined)
			throw new Error(`COSTS has no row for profile ${profile}`);
		const { why, cost, full } = costed;
		out.push(`  ${profile} (${why}) — a red here ${cost}:`);
		for (const line of lines) out.push(`    ${line}`);
		out.push(`    In full, WARNs and context included: ${full}`);
	}
	out.push(
		`  Re-read this notice after a later commit: node scripts/report-new-shared-faults.js ${sha}`,
	);
	return { count, lines: out };
}

/**
 * The whole comparison, as data rather than side effects.
 *
 * @param {string} ref
 * @param {string} cwd
 * @returns {{ code: number, out: string[], err: string[] }}
 */
function run(ref, cwd) {
	/** @type {string[]} */
	const out = [];
	/** @type {string[]} */
	const err = [];

	sweepLeftovers(cwd);

	let sha;
	let parents;
	try {
		({ sha, parents } = resolveCommit(ref, cwd));
	} catch (e) {
		err.push(
			`report-new-shared-faults: ${ref} does not resolve to a commit — ${parseErrorFirstLine(e)}`,
		);
		return { code: 2, out, err };
	}

	const [parent, ...otherParents] = parents;
	if (parent === undefined) {
		out.push(
			`report-new-shared-faults: ${sha} has no parent (initial commit) — nothing to compare.`,
		);
		return { code: 0, out, err };
	}
	const merge = otherParents.length > 0;

	let shaDir;
	let parentDir;
	try {
		shaDir = materialise(sha, cwd);
		parentDir = materialise(parent, cwd);
	} catch (e) {
		// shaDir may already exist here if only the second materialise threw;
		// clean it up before returning rather than leaking it.
		if (shaDir) fs.rmSync(shaDir, { recursive: true, force: true });
		err.push(
			`report-new-shared-faults: could not materialise a tree — ${parseErrorFirstLine(e)}`,
		);
		return { code: 2, out, err };
	}

	try {
		if (merge)
			out.push(
				`report-new-shared-faults: ${sha} is a merge — compared against its first parent ${parent} only.`,
			);

		const { broken, byProfile } = collectNewFaults({
			sha,
			parent,
			shaDir,
			parentDir,
			cwd,
			err,
		});
		const { count, lines } = noticeOf(sha, byProfile);
		out.push(...lines);
		/* `broken` outranks the faults found, the opposite of checker-new-faults.js's own
		 * fail-closed rule (mantahostels#1753's own header: "a baseline that could not be
		 * produced must refuse … rather than call every fault inherited") —
		 * chosen here because this script gates nothing (mantahostels#1823's body): a caller
		 * reading exit 2 knows a side of this report is unreliable, which a 1
		 * would bury under "some faults found, trust the rest of the list".
		 * Residual: a genuinely new fault can be sitting in `out` on an exit-2
		 * run — printed, but not the code's own story. */
		let code = 0;
		if (broken) code = 2;
		else if (count) code = 1;
		return { code, out, err };
	} finally {
		fs.rmSync(shaDir, { recursive: true, force: true });
		fs.rmSync(parentDir, { recursive: true, force: true });
	}
}

function main() {
	const { positionals } = parseOrExit(process.argv.slice(2), {
		usage:
			"usage: node scripts/report-new-shared-faults.js [<sha>]   (default HEAD)",
		max: 1,
	});
	const ref = positionals[0] || "HEAD";
	const { code, out, err } = run(ref, hostRoot());
	/* writeFd, not console: same reason as checker-new-faults.js — a caller
	 * may read this through a pipe, and node drops buffered writes on exit. */
	if (out.length > 0) writeFd(1, `${out.join("\n")}\n`);
	if (err.length > 0) writeFd(2, `${err.join("\n")}\n`);
	process.exit(code);
}

if (require.main === module) main();
