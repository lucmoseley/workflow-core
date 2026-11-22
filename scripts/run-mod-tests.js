#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const { execGit } = require("./lib/git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readFdAll } = require("./lib/read-fd.js");
const { isZeroSha, parsePushes } = require("./lib/push-refs.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { caught, orFallback } = require("./lib/caught.js");
const { compareVersions } = require("./lib/compare-versions.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { readClaudeVersion } = require("./lib/claude-version.js");
const { claudeBin } = require("./lib/claude-bin.js");

const MODS = [".claude/skills/wfc-delivery", ".claude/skills/wfc-liveness"];
/* A guess at a ceiling for a hung runner, not a measurement (#857). */
const TIMEOUT_MS = 120_000;
const REFUSE = 2;
const FAIL_COUNT = /^[^\S\n\r\u2028\u2029]*[1-9]\d* fail$/m;
const FOLDER_REFUSED = "claude plugin test: ";
const TEST_FLOOR =
	/\*\*The tests need Claude Code (\d+\.\d+\.\d+) or later\*\*/;

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
function readClaudeVersionOnce() {
	if (cliVersion === undefined) cliVersion = readClaudeVersion(claudeBin());
	return cliVersion;
}

/** @param {string} dir */
function unmetTestFloor(dir) {
	const readme = orFallback(
		() => fs.readFileSync(path.join(dir, "README.md"), "utf8"),
		"",
	);
	const floor = TEST_FLOOR.exec(readme)?.[1];
	const have = floor && readClaudeVersionOnce();
	if (!floor || !have) return null;
	const parseVersion = (/** @type {string} */ v) => v.split(".").map(Number);
	return compareVersions(parseVersion(have), parseVersion(floor)) < 0
		? floor
		: null;
}

/**
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
		return git(["merge-base", sha, VERIFIED_REF]) || null;
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
		stdin = readFdAll(0).toString("utf8");
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
			process.stderr.write(
				`WARN: pre-push: the mod-test gate could not judge ${sha.slice(0, 7)} (${caught(e).message}); it proceeds untested (#857).\n`,
			);
		}
	}
	return refuse ? REFUSE : 0;
}

process.exitCode = main();
