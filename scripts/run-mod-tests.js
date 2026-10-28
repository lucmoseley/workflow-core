#!/usr/bin/env node
/*
 * run-mod-tests.js — the pre-push gate on the mods (#857, on #849
 * §Testing Decisions; #865): where a push's range touches a mod's folder, run
 * `claude plugin test` on that folder as the pushed commit holds it, and refuse
 * the push on a failing test, so a broken mod is caught before adopters pull
 * it.
 *
 * `--all` IS THE SWEEP'S RUN (#1854): ci.yml's `Mod tests` step tests every
 * mod at HEAD, with no ref list, and exits 1 on anything but a pass, an
 * unrun mod and a mod missing from the tree included — a runner that installed
 * `claude` to test the mods has no reason to pass untested. It catches what
 * this gate cannot: a push made with `--no-verify` or no `claude`, and a
 * Claude Code release that breaks a mod with no commit behind it.
 *
 * IN NO `scripts/` FAMILY (code-standards §N3, §G4). It refuses, which no
 * `guard-*` may, and its exit codes are its own: on a push 2 refuses and every
 * other path exits 0, so runCheck's alphabet — where 2 is BROKEN — would read
 * it wrong. A bad flag exits 2 as well, which the hook, passing none, never
 * sees. `.husky/pre-push` refuses on 2 alone, so a crash, or an adopter's stale
 * plugin path exiting 1 on MODULE_NOT_FOUND, still lets the push through.
 *
 * WARNS AND PASSES — a fail-open, printed (#857) — where the `claude` binary is
 * missing, unusable (an unknown subcommand) or its run cannot finish, and
 * where `claude --version` is below the floor the mod's README states for its
 * tests (#901), there read off the pushed commit's README so the floor has one
 * home. Only a nonzero `N fail` count, or the runner refusing to load the
 * mod's folder, is a failing mod.
 *
 * THE BYTES TESTED ARE THE PUSHED COMMIT'S, extracted with `git archive` into a
 * temp directory, never the working tree, where a neighbour's half-written file
 * would refuse a push that does not carry it (`rule:suite-tree-dirty`).
 *
 * A PUSH LANDING ON A TAG IS SKIPPED (#932): a release tag's tree is rendered
 * without the mods' TypeScript, so its folders can never load. A tag on a
 * commit no branch push carries goes untested.
 *
 * WITH NO RANGE TO READ — the remote tip not held here and no pushed ref —
 * every mod the commit holds counts as touched. Deliberately unlike `attestationOf`,
 * whose answer there is "unjudged", because a warning can say so and a refusal
 * cannot.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const { execGit } = require("./lib/git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isZeroSha, parsePushes } = require("./lib/push-refs.js");
const { pushedRef } = require("./lib/landing-refs.js");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { readClaudeVersion } = require("./lib/claude-version.js");

const MODS = [".claude/skills/wfc-delivery", ".claude/skills/wfc-liveness"];
/* A guess at a ceiling for a hung runner, not a measurement (#857). */
const TIMEOUT_MS = 120_000;
const REFUSE = 2;
/* The runner's summary line on a failing test, and its prefix when it refuses
 * the folder itself (no hooks module, no such folder) — both read off 2.1.289's
 * output. */
const FAIL_COUNT = /^[^\S\n\r\u2028\u2029]*[1-9]\d* fail$/m;
const FOLDER_REFUSED = "claude plugin test: ";
/* The README sentence carrying a mod's test floor (#896, #901). */
const TEST_FLOOR =
	/\*\*The tests need Claude Code (\d+\.\d+\.\d+) or later\*\*/;

/* §N7: `claude` is injected at WFC_CLAUDE_BIN repo-wide, never by PATH. */
const claudeBin = () => process.env.WFC_CLAUDE_BIN || "claude";

/** @param {string[]} args */
const git = (args) =>
	execGit(args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** @param {string[]} args */
const gitOk = (args) => {
	try {
		git(args);
		return true;
	} catch {
		return false;
	}
};

/** @type {string | null | undefined} */
let cliVersion;
/** `claude --version`'s number, once per run; null where it gives none. */
function readClaudeVersionOnce() {
	if (cliVersion === undefined) cliVersion = readClaudeVersion(claudeBin());
	return cliVersion;
}

/**
 * The floor the mod's README at `dir` states for its tests, where `claude` is
 * below it; else null, an unreadable version included.
 * @param {string} dir
 */
function unmetTestFloor(dir) {
	let readme = "";
	try {
		readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
	} catch {
		/* No README states no floor; the tests run. */
	}
	const floor = TEST_FLOOR.exec(readme)?.[1];
	const have = floor && readClaudeVersionOnce();
	if (!floor || !have) return null;
	const parseVersion = (/** @type {string} */ v) => v.split(".").map(Number);
	const f = parseVersion(floor);
	/* Both are x.y.z, by TEST_FLOOR and readClaudeVersionOnce's patterns. */
	const cmp =
		parseVersion(have)
			.map((n, i) => {
				const m = f[i];
				if (m === undefined)
					throw new Error(`claude ${have} has more parts than floor ${floor}`);
				return n - m;
			})
			.find((d) => d !== 0) ?? 0;
	return cmp < 0 ? floor : null;
}

/**
 * Where the range a push sends starts: the remote's tip where git names one
 * this repo holds, else the merge-base with the pushed ref
 * (lib/landing-refs.js), else null.
 * @param {string} sha
 * @param {string | undefined} remote
 */
function readBaseOf(sha, remote) {
	if (
		remote &&
		!isZeroSha(remote) &&
		gitOk(["cat-file", "-e", `${remote}^{commit}`])
	)
		return remote;
	try {
		return git(["merge-base", sha, pushedRef()]) || null;
	} catch {
		return null;
	}
}

/**
 * @param {string} sha
 * @param {string} mod
 */
const holdsMod = (sha, mod) => gitOk(["cat-file", "-e", `${sha}:${mod}`]);

/**
 * The mods `sha` holds that the range from `base` touches; with no base, every
 * mod `sha` holds (header).
 * @param {string} sha
 * @param {string | null} base
 */
function touchedMods(sha, base) {
	return MODS.filter(
		(mod) =>
			holdsMod(sha, mod) &&
			(base === null ||
				git(["diff", "--name-only", base, sha, "--", mod]) !== ""),
	);
}

/**
 * "fail" carries the runner's own output.
 * @param {string} sha
 * @param {string} mod
 * @returns {{ verdict: "pass" } | { verdict: "fail", output: string } | { verdict: "unrun", why: string }}
 */
function runModTests(sha, mod) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-mod-tests-"));
	try {
		const archive = path.join(dir, "mod.tar");
		execGit(["archive", "-o", archive, sha, "--", mod], {
			stdio: "ignore",
		});
		execFileSync("tar", ["-xf", archive, "-C", dir], { stdio: "ignore" });
		const floor = unmetTestFloor(path.join(dir, mod));
		if (floor)
			return {
				verdict: "unrun",
				why: `\`claude\` is ${readClaudeVersionOnce()}, below ${floor}, the floor its README states for its tests (#901) — update Claude Code to test it`,
			};
		const r = spawnSync(claudeBin(), ["plugin", "test", path.join(dir, mod)], {
			encoding: "utf8",
			timeout: TIMEOUT_MS,
		});
		const error = r.error;
		if (caught(error).code === "ENOENT")
			return { verdict: "unrun", why: `no \`${claudeBin()}\` binary found` };
		if (error || r.status === null)
			return {
				verdict: "unrun",
				why: `\`claude plugin test\` did not finish (${error?.message ?? r.signal})`,
			};
		if (r.status === 0) return { verdict: "pass" };
		const output = `${r.stdout}${r.stderr}`.trimEnd();
		if (FAIL_COUNT.test(output) || output.startsWith(FOLDER_REFUSED))
			return { verdict: "fail", output };
		return {
			verdict: "unrun",
			why: `\`claude plugin test\` exited ${r.status} without a test result: ${output.split("\n")[0]}`,
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * One mod at one sha, its verdict printed. True where it refuses the push.
 * @param {string} sha
 * @param {string} mod
 */
function judge(sha, mod) {
	const name = path.basename(mod);
	const at = sha.slice(0, 7);
	const r = runModTests(sha, mod);
	if (r.verdict === "pass") {
		process.stderr.write(`pre-push: ${name}'s plugin tests pass at ${at}.\n`);
		return false;
	}
	if (r.verdict === "unrun") {
		process.stderr.write(
			`WARN: pre-push: ${name}'s plugin tests were not run at ${at}: ${r.why}. The push proceeds untested (#857).\n`,
		);
		return false;
	}
	process.stderr.write(
		`${r.output}\n\npre-push: ${name}'s plugin tests fail at ${at} on \`claude\` ${readClaudeVersionOnce() ?? "of unread version"}, so the push is refused (#857).\n` +
			`  Fix the mod, commit, and push again; \`claude plugin test ${mod}\` reruns them on the working tree.\n`,
	);
	return true;
}

/** `--all` (header): every mod at HEAD; 1 where any is not a pass. */
function sweep() {
	const sha = git(["rev-parse", "HEAD"]);
	let red = false;
	for (const mod of MODS) {
		const name = path.basename(mod);
		if (!holdsMod(sha, mod)) {
			process.stderr.write(
				`mod tests: ${mod} is not in the tree at ${sha.slice(0, 7)}; update MODS in scripts/run-mod-tests.js.\n`,
			);
			red = true;
			continue;
		}
		const r = runModTests(sha, mod);
		if (r.verdict === "pass")
			process.stderr.write(`mod tests: ${name}'s plugin tests pass.\n`);
		else {
			process.stderr.write(
				r.verdict === "fail"
					? `${r.output}\n\nmod tests: ${name}'s plugin tests fail on \`claude\` ${readClaudeVersionOnce() ?? "of unread version"}; \`claude plugin test ${mod}\` reruns them.\n`
					: `mod tests: ${name}'s plugin tests were not run on \`claude\` ${readClaudeVersionOnce() ?? "of unread version"}: ${r.why}.\n`,
			);
			red = true;
		}
	}
	return red ? 1 : 0;
}

function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage:
			"usage: run-mod-tests.js [--all]\n  git's pre-push ref list on stdin, or --all: every mod at HEAD (#1854)",
		flags: { "--all": "boolean" },
	});
	if (typeof parsed === "number") return parsed;
	if (parsed.flags["--all"]) return sweep();
	let stdin = "";
	try {
		stdin = fs.readFileSync(0, "utf8");
	} catch (e) {
		process.stderr.write(
			`WARN: pre-push: could not read git's ref list (${caught(e).message}); the mod's tests were not run (#857).\n`,
		);
		return 0;
	}
	let refuse = false;
	for (const { sha, remoteSha } of parsePushes(stdin, { skipTags: true })) {
		try {
			for (const mod of touchedMods(sha, readBaseOf(sha, remoteSha)))
				refuse = judge(sha, mod) || refuse;
		} catch (e) {
			/* One unreadable ref fails open (#857) and keeps a refusal already
			 * found on another. */
			process.stderr.write(
				`WARN: pre-push: the mod-test gate could not judge ${sha.slice(0, 7)} (${caught(e).message}); it proceeds untested (#857).\n`,
			);
		}
	}
	return refuse ? REFUSE : 0;
}

process.exitCode = main();
