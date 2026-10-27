#!/usr/bin/env node
/*
 * check-git-fixture-identity.js — a test that inits a git repo and commits into
 * it must give that repo its own identity (both `user.email` and `user.name`
 * — git refuses a commit missing either), or it fails on a runner with no
 * global identity (mantahostels#2310, mantahostels#2355).
 *
 * Usage:
 *   node check-git-fixture-identity.js [--json] [--warn] [--root <dir>] [--against <rev>]
 *
 * Four shared helpers already set a repo-local identity — scripts/lib/git-
 * fixture.ts `initGitRepo`, scripts/lib/precommit-gate-harness.js,
 * scripts/lib/arbiter-testkit.ts, scripts/proving-run.ts.
 *
 * THE DISCRIMINATOR IS THE PAIR, PER REPO, NOT THE CALL SITE ALONE. A finding
 * needs a RAW `git ... init` site for a repo and a RAW `git ... commit` site
 * for THE SAME repo, since only a commit can fail on identity — an init-only
 * fixture is inert. A file that calls a known helper (initGitRepo and friends)
 * to build a repo carries no quoted "init" of its own for it — the quoting
 * lives inside the helper, not the caller — so a repo built that way is never
 * a raw-init target here, with no need to resolve which helper reached it; a
 * raw `git(helperRepo, "commit", ...)` against it is read as committing into
 * an ALREADY-identitied repo, never flagged on its own.
 *
 * REPO KEY extraction has two shapes. Where the call names its target
 * explicitly — `git(VAR, "init"/"commit", ...)`, or an
 * execFileSync/spawnSync("git", [...], { cwd: VAR }) — VAR is the key. Where
 * it does not — a file-fixed wrapper like `const git = (...args) =>
 * execFileSync("git", args, { cwd: dir })` called as `git("init", ...)` with
 * no leading target argument — every site in the file shares one key,
 * `__default__`, which is exactly file-scoped: correct because there is only
 * one repo in the file to be scoped to.
 *
 * IDENTITY EVIDENCE for a keyed repo is a STATEMENT (the file collapsed to one
 * line and split on `;`, §statements below) naming both that key and
 * `user.email`, and a statement naming both that key and `user.name` — the
 * two may be different statements, since this repo's fixtures usually set
 * them as two separate `git config` calls. The config call almost always
 * echoes the same target literal within its own statement, wrapped onto
 * several source lines or not. For `__default__` it is the literal substring
 * anywhere in the file. Both spellings this repo uses count: `git(VAR,
 * "config", "user.email", ...)` and the inline `-c user.email=t@t` form.
 *
 * RESIDUAL: two repos sharing one variable NAME (rebound, or a loop reusing
 * `dir`) are conflated into one key — a raw-inited, identity-less `dir` in one
 * `it()` and an unrelated already-identitied `dir` in another, PAIRED IN THE
 * SAME STATEMENT, would let the first hide behind the second's config.
 * Cheaper to accept than a real scope-aware parse.
 *
 * NOT SEEN, all residuals of scanning text rather than parsing it (mantahostels#2355's
 * spec review): a wrapper whose own name does not start with `git` (a local
 * `const run = (...args) => spawnSync("git", ["-C", dir, ...args])` reads as
 * nothing here, however it commits); identity set through an env var
 * (`GIT_AUTHOR_EMAIL`) rather than `git config`; identity set by a helper
 * function called with the repo var rather than inlined; and a `git`
 * invocation built from string concatenation rather than a quoted
 * "init"/"commit" literal. mantahostels#2355's own §Two shapes names the complement: a
 * scheduled sweep arm running the suite once under
 * GIT_CONFIG_GLOBAL=/dev/null, which catches every shape here but only after
 * the fact.
 *
 * FAIL, not WARN: the fix is a two-line addition matching every sibling
 * fixture already in the file, and the failure this catches is invisible until
 * it reaches a runner with no global git identity.
 *
 * IMPLICIT:  on every commit staging a scripts/ test file, refuses one that raw-inits and raw-commits a git repo with no identity set anywhere in the file.
 * JUSTIFIED: fail-safe — a checker that cannot enumerate or read the tracked set is BROKEN rather than green, since a silent pass here restores exactly mantahostels#2310's blind spot.
 * DEFEAT:    --warn caps findings below the gating line; a `git-identity-exempt:` comment in the test file drops that file, and nothing validates the reason it gives.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execGit } = require("./lib/git.js");
const { JS_TEST_FILE } = require("./lib/test-kind.js");

const { runCheck, errMessage } = require("./lib/check.js");

/** The comment that drops a file, with its reason: `git-identity-exempt: <why>`. */
const EXEMPT = /git-identity-exempt:[ \t]*[A-Za-z0-9]/;

const QUOTE = `["'\`]`;

/**
 * `git(VAR, "init"/"commit", ...)` — the wrapper most fixtures in this repo
 * define, taking the target repo as its first argument. VAR is captured as
 * the key.
 */
const VAR_CALL = new RegExp(
	`\\bgit\\w*\\(\\s*([A-Za-z_$][\\w.]*)\\s*,\\s*(${QUOTE})(init|commit)\\2\\s*[,)]`,
);

/**
 * `git("init"/"commit", ...)` — a file-fixed wrapper whose cwd is closed over
 * rather than passed, so the quoted verb is the call's first argument. No key:
 * every site like this in a file shares `__default__`.
 */
const DEFAULT_CALL = new RegExp(
	`\\bgit\\w*\\(\\s*(${QUOTE})(init|commit)\\1\\s*[,)]`,
);

/**
 * `execFileSync("git", ["init"/"commit", ...], { cwd: VAR })` or the
 * `spawnSync` twin — the array-argument shape. VAR from `cwd:` on the same
 * line is the key; absent a `cwd:` on the line, `__default__`.
 */
const EXEC_ARRAY_CALL = new RegExp(
	`\\b(?:execFileSync|execFile|spawnSync|spawn)\\(\\s*${QUOTE}git${QUOTE}\\s*,\\s*\\[\\s*(${QUOTE})(init|commit)\\1`,
);
const CWD_VAR = /\bcwd:\s*([A-Za-z_$][\w.]*)/;

/**
 * The file collapsed to one line and split on `;` — a JS STATEMENT, not a
 * source line. This is the unit both call-site detection and identity
 * evidence scan, because a call site or a config call can be wrapped onto
 * several source lines and a statement stays whole regardless of where the
 * formatter broke it — `execFileSync("git", ["commit", ...], {\n  cwd:
 * sb.repo,\n});` (scripts/session-arbiter.test.ts:3044-3046) is a worked case.
 * A `for (const args of [["config", "user.email", ...], ...]) spawnSync("git",
 * args, { cwd: dir });` loop (scripts/check-test-marker.test.ts's shape) is
 * also one statement end to end, so `user.email` inside the array literal and
 * `dir` in the loop body pair correctly even though neither line names the
 * other directly.
 *
 * And unlike a line-window, it does not pair two DIFFERENT repos' setup that
 * happen to sit close together — a `git(a, "config", "user.email", ...)`
 * statement and a following `git(b, "init", ...)` statement never merge, each
 * ending at its own `;`.
 *
 * Splitting on bare `;` believes every one is a statement end, so a `for (;;)`
 * C-style header or a string literal carrying its own `;` would fragment
 * wrongly — neither shape appears in this repo's git fixtures today.
 */
function statements(/** @type {string} */ text) {
	return text.replace(/\s+/g, " ").split(";");
}

/**
 * Every (repoKey, verb) call site in `text`, one statement at a time. A
 * statement can carry more than one site (rare, but `git(a, "init", ...);
 * git(b, "init", ...)` is legal JS) — matchAll over each pattern, rather than
 * the single-match `.test()` scan (String.matchAll needs `g`), so none are
 * missed.
 */
function* callSites(/** @type {string} */ text) {
	for (const stmt of statements(text)) yield* statementCallSites(stmt);
}

/** The (repoKey, verb) call sites of one statement — see callSites. */
function* statementCallSites(/** @type {string} */ stmt) {
	for (const m of stmt.matchAll(new RegExp(VAR_CALL.source, "g"))) {
		yield { key: m[1], verb: m[3] };
	}
	for (const m of stmt.matchAll(new RegExp(EXEC_ARRAY_CALL.source, "g"))) {
		yield { key: stmt.match(CWD_VAR)?.[1] ?? "__default__", verb: m[2] };
	}
	// DEFAULT_CALL only where the statement did not already match
	// VAR_CALL — a `git(fresh, "init", ...)` statement's "init" is not
	// also a bare `git("init"` site; the two patterns would otherwise
	// double-count one call as two sites (one keyed, one __default__).
	if (new RegExp(VAR_CALL.source, "g").test(stmt)) return;
	for (const m of stmt.matchAll(new RegExp(DEFAULT_CALL.source, "g"))) {
		yield { key: "__default__", verb: m[2] };
	}
}

/**
 * True where a statement names both `key` and `token` — `token` is
 * `user\.email` or `user\.name`, checked independently since git refuses a
 * commit missing either (mantahostels#2355's Spec review, F1: this checker originally
 * read `user.email` alone as sufficient, which passed a fixture git itself
 * would still refuse).
 */
function hasKeyedTokenEvidence(
	/** @type {string} */ text,
	/** @type {string} */ key,
	/** @type {RegExp} */ token,
) {
	if (key === "__default__") return token.test(text);
	const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	return statements(text).some((stmt) => re.test(stmt) && token.test(stmt));
}

const EMAIL_TOKEN = /user\.email/;
const NAME_TOKEN = /user\.name/;

/** True where `key` has both an email and a name statement — see
 * hasKeyedTokenEvidence. The two may be different statements (this repo's
 * fixtures usually set them as two separate `git config` calls). */
function hasKeyedIdentityEvidence(
	/** @type {string} */ text,
	/** @type {string} */ key,
) {
	return (
		hasKeyedTokenEvidence(text, key, EMAIL_TOKEN) &&
		hasKeyedTokenEvidence(text, key, NAME_TOKEN)
	);
}

/**
 * Every test file under `<root>/scripts/`, walked off the filesystem.
 *
 * Only ever called on a `--root` tree, which is a `git archive HEAD` extraction
 * (mantahostels#1753) — so everything in it is tracked at HEAD by construction, and the walk
 * answers exactly what `git ls-files` would. Not `ls-files` itself: a temp dir
 * is not a git repo.
 */
function walkTests(/** @type {string} */ root) {
	const out = /** @type {string[]} */ ([]);
	const walk = (/** @type {string} */ rel) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const child = `${rel}/${e.name}`;
			if (e.isDirectory()) walk(child);
			else if (JS_TEST_FILE.test(e.name)) out.push(child);
		}
	};
	walk("scripts");
	return out;
}

function readTrackedTests(/** @type {any} */ ctx) {
	const rootFlag = ctx.value("--root");
	if (rootFlag) {
		const root = path.resolve(rootFlag);
		return { root, files: walkTests(root) };
	}
	const git = (/** @type {string[]} */ args, /** @type {string} */ what) => {
		try {
			return execGit(args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			return ctx.broken(
				`git ${args[0]} failed while ${what}: ${errMessage(e)}. No test files read.`,
			);
		}
	};
	const root = git(
		["rev-parse", "--show-toplevel"],
		"locating the repo root",
	).trim();
	const files = git(["-C", root, "ls-files", "-z"], "listing tracked files")
		.split("\0")
		.filter(Boolean)
		.filter(
			(/** @type {string} */ p) =>
				p.startsWith("scripts/") && JS_TEST_FILE.test(p),
		);
	return { root, files };
}

/**
 * Every repo key in `text` that is BOTH raw-inited and raw-committed — the
 * candidate set identity evidence is checked against — split into `clean`
 * (has identity) and `bare` (does not, the finding).
 */
function pairedRepos(/** @type {string} */ text) {
	const inited = new Set();
	const committed = new Set();
	for (const { key, verb } of callSites(text)) {
		if (verb === "init") inited.add(key);
		else committed.add(key);
	}
	const clean = /** @type {string[]} */ ([]);
	const bare = /** @type {string[]} */ ([]);
	for (const key of inited) {
		if (!committed.has(key)) continue;
		(hasKeyedIdentityEvidence(text, key) ? clean : bare).push(key);
	}
	return { clean: clean.sort(), bare: bare.sort() };
}

runCheck({
	name: "git-fixture-identity",
	usage:
		"node check-git-fixture-identity.js [--json] [--warn] [--root <dir>] [--against <rev>]",
	valueFlags: ["--root"],
	/* Whole-tree, not a pathspec: the finding is a property of a single test
	 * file read on its own, so the scope this checker needs is exactly the set
	 * --against already materialises for it (scripts/lib/check.js §--against). */
	against: { profile: "git-fixture-identity", materialise: "tree" },
	run(/** @type {any} */ ctx) {
		const { root, files } = readTrackedTests(ctx);
		const checked = /** @type {string[]} */ ([]);
		const exempt = /** @type {string[]} */ ([]);

		for (const rel of files) {
			let source = "";
			try {
				source = fs.readFileSync(path.join(root, rel), "utf8");
			} catch (e) {
				return ctx.broken(
					`could not read the tracked file ${rel}: ${errMessage(e)}.`,
				);
			}
			const { clean, bare } = pairedRepos(source);
			if (clean.length === 0 && bare.length === 0) continue;
			checked.push(rel);
			if (bare.length === 0) continue;
			if (EXEMPT.test(source)) {
				exempt.push(rel);
				continue;
			}
			const findings = bare;

			ctx.fail(
				"GIT-FIXTURE-IDENTITY",
				`${rel} inits and commits a raw git repo (${findings.join(", ")}) with no identity set for it, so it fails on a runner with no global user.email/user.name (mantahostels#2310's shape, mantahostels#2355).`,
				{ file: rel, repos: findings },
			);
			ctx.say(
				`${rel} inits and commits ${findings.join(", ")} with no identity.`,
			);
			ctx.say(
				"  A developer machine carries a global git identity and never sees this fail; a runner with none fails every commit into that repo.",
			);
			ctx.say(
				'  Fix: after `git(<repo>, "init", ...)`, add `git(<repo>, "config", "user.email", "test@example.com")` and `git(<repo>, "config", "user.name", "test")` — the shape scripts/lib/git-fixture.ts\'s initGitRepo and every sibling fixture already use.',
			);
			ctx.say(
				"  Genuinely need no identity? Say so in a comment reading `git-identity-exempt: <why>` and this check drops the file.",
			);
		}

		const data = {
			rawFixtureTests: checked.length,
			exempt: exempt.length,
			scanned: files.length,
		};
		const tail =
			exempt.length > 0
				? `${exempt.length} exempt, the rest carrying an identity.`
				: "all carrying an identity.";
		return {
			okLine: `${checked.length} of ${files.length} scripts/ test files raw-init and raw-commit a git repo — ${tail}`,
			noun: "identity-less git fixture",
			data,
		};
	},
});
