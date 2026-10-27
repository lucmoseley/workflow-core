// @vitest-environment node
/*
 * The contract lib/git-fault-fake.ts keeps with the real git (#3067, §G7):
 * each case list runs through a wrapper of every match kind and through git,
 * and the exit code, stdout and stderr must agree. Breaking it costs the
 * suites that fault one git read their tie to git everywhere else: a wrapper
 * that drops an argument or swallows stdin fails their other reads instead.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type GitFaultMatch,
	resolveRealGit,
	writeFaultyGit,
} from "./git-fault-fake";
import { initGitRepo, mkScratchDir } from "./git-fixture";

let repo: string;
const dirs: string[] = [];

const call = (git: string, args: string[], input?: string) => {
	const r = spawnSync(git, args, { cwd: repo, encoding: "utf8", input });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

beforeAll(() => {
	repo = mkScratchDir("git-fault-contract-");
	initGitRepo(repo, path.join(repo, "no-hooks"));
	fs.writeFileSync(path.join(repo, "a.md"), "two\n");
	fs.writeFileSync(path.join(repo, "b c.md"), "spaced\n");
});

afterAll(() => {
	fs.rmSync(repo, { recursive: true, force: true });
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const unmatched: { args: string[]; input?: string }[] = [
	{ args: ["--version"] },
	{ args: ["rev-parse", "HEAD"] },
	{ args: ["rev-parse", "no-such-rev"] },
	{ args: ["status", "--porcelain"] },
	{ args: ["diff", "--name-only", "-z"] },
	{ args: ["log", "--format=%s by %an"] },
	{ args: ["ls-files", "--others", "--", "b c.md"] },
	{ args: ["hash-object", "--stdin"], input: "piped\n" },
	{ args: ["no-such-subcommand"] },
];

const matches: [string, GitFaultMatch][] = [
	["words", { words: ["diff", "--cached", "--name-only", "-z", "HEAD"] }],
	["every", { every: ["--cached", "diff"] }],
	["first", { first: "commit" }],
	["argPrefix", { argPrefix: "HEAD:" }],
];

describe.each(matches)("a %s match", (_, match) => {
	let wrapper: ReturnType<typeof writeFaultyGit>;
	beforeAll(() => {
		wrapper = writeFaultyGit(match, { exit: 7 });
		dirs.push(wrapper.dir);
	});

	it.each(unmatched)("answers $args as git does", ({ args, input }) => {
		expect(call(wrapper.git, args, input)).toEqual(
			call(resolveRealGit(), args, input),
		);
	});

	it("counts no hit for an argv it does not match", () => {
		expect(wrapper.hits()).toBe(0);
	});
});

describe("a matched argv", () => {
	it("exits with the code given, counting the hit", () => {
		const w = writeFaultyGit({ argPrefix: "HEAD:" }, { exit: 7 });
		dirs.push(w.dir);
		expect(call(w.git, ["show", "HEAD:a.md"])).toEqual({
			status: 7,
			stdout: "",
			stderr: "",
		});
		expect(w.hits()).toBe(1);
	});

	it("faults a call once, however many of its arguments match", () => {
		const w = writeFaultyGit({ argPrefix: "HEAD:" }, { script: ":" });
		dirs.push(w.dir);
		const args = ["show", "HEAD:a.md", "HEAD:a.md"];
		expect(call(w.git, args)).toEqual(call(resolveRealGit(), args));
		expect(w.hits()).toBe(1);
	});

	it("faults an every match on its arguments in any order, and not on some of them", () => {
		const w = writeFaultyGit({ every: ["--cached", "diff"] }, { exit: 7 });
		dirs.push(w.dir);
		expect(call(w.git, ["diff", "--name-only", "--cached"]).status).toBe(7);
		const some = ["diff", "--name-only"];
		expect(call(w.git, some)).toEqual(call(resolveRealGit(), some));
		expect(w.hits()).toBe(1);
	});

	it("runs a script body that sees the argv and $REAL_GIT, falling through to git where it does not exit", () => {
		const w = writeFaultyGit(
			{ first: "rev-parse" },
			{ script: 'echo "saw $# via $(basename "$REAL_GIT")" >&2' },
		);
		dirs.push(w.dir);
		const real = call(resolveRealGit(), ["rev-parse", "HEAD"]);
		expect(call(w.git, ["rev-parse", "HEAD"])).toEqual({
			...real,
			stderr: "saw 2 via git\n",
		});
	});
});
