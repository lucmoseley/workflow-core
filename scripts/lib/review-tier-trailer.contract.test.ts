// @vitest-environment node
/*
 * The equivalence contract for the review-tier trailer (#5208, spec #5207
 * seam 3): scripts/review-tier-trailer.js's PROGRAM, run in-process as
 * .husky/prepare-commit-msg's dispatcher row runs it, gives the same exit
 * code, stdout and stderr, and leaves the same message file and stamp, as
 * the same program spawned as `node review-tier-trailer.js <args>` over an
 * identical fixture.
 *
 * Every case compares the two runs, never a hand-written expectation.
 *
 * Breaking it costs the licence for the trailer row: a trailer whose
 * in-process run drifts from its spawned one writes, strips or refuses
 * differently at commit.
 *
 * spawn-kept: `spawned` is the program each in-process run is held to.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROGRAM } from "../review-tier-trailer.js";
import { initGitRepo, mkScratchDir } from "./git-fixture";
import { reviewTierStamp } from "./review-tier-stamp.js";

const TRAILER = path.join(__dirname, "..", "review-tier-trailer.js");
const SID = "contract-session";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

interface Fixture {
	repo: string;
	msg: string;
	env: NodeJS.ProcessEnv;
	stamp: string;
}

/**
 * A repo with `f.txt` staged, its message file holding `message` and, where
 * `stamped`, this session's hold stamp on the staged tree.
 */
function fixture(message: string, stamped: boolean): Fixture {
	const dir = fs.realpathSync(mkScratchDir("review-tier-trailer-contract-"));
	dirs.push(dir);
	const repo = path.join(dir, "repo");
	fs.mkdirSync(repo);
	initGitRepo(repo, path.join(dir, "no-hooks"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_CODE_SESSION_ID: SID,
		CLAUDE_CONFIG_DIR: dir,
		CLAUDE_PROJECT_DIR: repo,
	};
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: repo, env, encoding: "utf8" }).trim();
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	git("add", "-A");
	git("commit", "-qm", "base");
	fs.writeFileSync(path.join(repo, "f.txt"), "held\n");
	git("add", "-A");
	const stamp = reviewTierStamp(path.join(repo, ".git"), SID) as string;
	if (stamped) {
		const tree = git("write-tree");
		fs.writeFileSync(
			stamp,
			`${tree}\nescalated; areas=secrets; base=b; tree=${tree}; paths=f.txt\n`,
		);
	}
	const msg = path.join(dir, "MSG");
	fs.writeFileSync(msg, message);
	return { repo, msg, env, stamp };
}

const left = (f: Fixture) => ({
	message: fs.readFileSync(f.msg, "utf8"),
	stamp: fs.existsSync(f.stamp),
});

const spawned = (f: Fixture, args: string[]) => {
	// spawn-kept: the spawned program is the comparand each in-process run is held to.
	const r = spawnSync(process.execPath, [TRAILER, ...args], {
		cwd: f.repo,
		env: f.env,
		encoding: "utf8",
	});
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr, ...left(f) };
};

const inProcess = (f: Fixture, args: string[]) => ({
	...PROGRAM({ cwd: f.repo, env: f.env, args }),
	...left(f),
});

describe("the trailer in-process equals review-tier-trailer.js spawned", () => {
	it.each([
		["a stamp of this session's on the staged tree", "land it\n", true],
		["no stamp and no Review-Tier: line", "land it\n", false],
		[
			"an unvouched Review-Tier: line",
			"land it\n\nReview-Tier: escalated\n",
			false,
		],
	])("on %s", (_name, message, stamped) => {
		const a = fixture(message, stamped);
		const b = fixture(message, stamped);
		expect(inProcess(a, [a.msg])).toEqual(spawned(b, [b.msg]));
	});

	it.each([
		["an empty message path", [""]],
		["no message file", []],
		["two message files", ["a", "b"]],
	])("on %s", (_name, args) => {
		const a = fixture("land it\n", true);
		const b = fixture("land it\n", true);
		expect(inProcess(a, args)).toEqual(spawned(b, args));
	});
});
