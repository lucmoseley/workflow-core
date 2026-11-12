// @vitest-environment node
/*
 * A run's steadiness (#5073): a real watch over a throwaway repository, then
 * the record-time query. Loosen a rule and the pass store keys a row on
 * content no test read, so a file reads green that never ran on it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
	isSteadyUnder,
	readMovedSinceEnd,
	readSteady,
	watchRun,
} = require("./run-steadiness.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const quiet = { write: () => true };

/** A repository holding `a.js`, `b.js` and `docs/one.md`, committed. */
function repo() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rst-")));
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	fs.mkdirSync(path.join(dir, "docs"));
	for (const f of ["a.js", "b.js", "docs/one.md"]) write(dir, f, `${f} v0\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return dir;
}

function write(dir: string, file: string, text: string) {
	fs.writeFileSync(path.join(dir, file), text);
}

/** What a watch on `dir` saw, `during` run while it was open. */
function watched(dir: string, during?: () => void, opts = {}) {
	const watch = watchRun(dir, { env: {}, err: quiet, ...opts });
	during?.();
	return watch.close().steadiness;
}

/** Which of `paths` read steady at `dir` under `steadiness`. */
const steadyOf = (steadiness: unknown, dir: string, paths: string[]) => {
	const { isSteady } = readSteady(steadiness, dir, paths);
	return paths.filter(isSteady);
};

describe("a path the watch saw hold still", () => {
	it("is steady, the run known and the tree settled", () => {
		const dir = repo();
		const steady = readSteady(watched(dir), dir, ["a.js", "b.js"]);
		expect([steady.known, steady.settled]).toEqual([true, true]);
		expect(["a.js", "b.js"].filter(steady.isSteady)).toEqual(["a.js", "b.js"]);
	});

	it("is not steady where the query was never asked of it", () => {
		const dir = repo();
		expect(readSteady(watched(dir), dir, ["a.js"]).isSteady("b.js")).toBe(
			false,
		);
	});
});

describe("a path that is not steady", () => {
	it("a file rewritten mid-run", () => {
		const dir = repo();
		const s = watched(dir, () => write(dir, "a.js", "a.js v1\n"));
		expect(steadyOf(s, dir, ["a.js", "b.js"])).toEqual(["b.js"]);
	});

	it("a file changed and put back, which no snapshot sees (#5018)", () => {
		const dir = repo();
		const s = watched(dir, () => {
			write(dir, "a.js", "a.js edited\n");
			write(dir, "a.js", "a.js v0\n");
		});
		expect(s.drifted).toEqual([]);
		expect(steadyOf(s, dir, ["a.js", "b.js"])).toEqual(["b.js"]);
	});

	it("an untracked file, whose content no snapshot holds", () => {
		const dir = repo();
		write(dir, "new.js", "new\n");
		expect(steadyOf(watched(dir), dir, ["new.js", "a.js"])).toEqual(["a.js"]);
	});

	it("an ignored file, which no snapshot lists (#4819)", () => {
		const dir = repo();
		write(dir, ".gitignore", "gen.json\n");
		write(dir, "gen.json", "{}\n");
		git(dir, "add", ".gitignore");
		git(dir, "commit", "-q", "-m", "ignore");
		expect(steadyOf(watched(dir), dir, ["gen.json", "a.js"])).toEqual(["a.js"]);
	});

	it("a path through a tracked symlink, which git will not judge for ignores, and only that one (#4819)", () => {
		const dir = repo();
		fs.mkdirSync(path.join(dir, "real"));
		write(dir, "real/x.js", "x\n");
		fs.symlinkSync("real", path.join(dir, "link"));
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "link");
		expect(steadyOf(watched(dir), dir, ["link/x.js", "a.js"])).toEqual([
			"a.js",
		]);
	});

	it("a file changed after the end snapshot and put back before the query", () => {
		const dir = repo();
		const s = watched(dir);
		write(dir, "a.js", "a.js late\n");
		write(dir, "a.js", "a.js v0\n");
		const steady = readSteady(s, dir, ["a.js", "b.js"]);
		expect(steady.settled).toBe(true);
		expect(["a.js", "b.js"].filter(steady.isSteady)).toEqual(["b.js"]);
	});
});

describe("a run the watch did not see through", () => {
	it("HEAD moved: unknown, and no path is steady", () => {
		const dir = repo();
		const s = watched(dir, () =>
			git(dir, "commit", "-q", "--allow-empty", "-m", "mid-run"),
		);
		const steady = readSteady(s, dir, ["a.js"]);
		expect(steady.known).toBe(false);
		expect(steady.isSteady("a.js")).toBe(false);
		expect(isSteadyUnder(s, "docs")).toBe(false);
	});

	it("no mark: no path is steady, and the watch says so", () => {
		const dir = repo();
		const said: string[] = [];
		const noMark = {
			...fs,
			mkdtempSync: () => {
				throw new Error("no room");
			},
		};
		const s = watched(dir, undefined, {
			fs: noMark,
			err: { write: (t: string) => said.push(t) },
		});
		expect(s.mark).toBeNull();
		expect(said.join("")).toMatch(/no start mark/);
		const steady = readSteady(s, dir, ["a.js"]);
		expect(steady.known).toBe(true);
		expect(steady.isSteady("a.js")).toBe(false);
	});

	it("none watched it: nothing known, settled or steady", () => {
		const dir = repo();
		const steady = readSteady(null, dir, ["a.js"]);
		expect([steady.known, steady.settled]).toEqual([false, false]);
		expect(steady.isSteady("a.js")).toBe(false);
		expect(isSteadyUnder(null, "docs")).toBe(false);
	});
});

describe("a tree walked whole", () => {
	it("is not steady under a file removed while the run ran, which neither index nor tree then holds (#4993)", () => {
		const dir = repo();
		fs.mkdirSync(path.join(dir, "lib"));
		write(dir, "lib/x.js", "x\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "lib");
		const s = watched(dir, () => git(dir, "rm", "-q", "docs/one.md"));
		expect(isSteadyUnder(s, "docs")).toBe(false);
		expect(isSteadyUnder(s, ".")).toBe(false);
		expect(isSteadyUnder(s, "lib")).toBe(true);
	});
});

describe("the end snapshot", () => {
	it("a rewrite after it leaves the tree unsettled", () => {
		const dir = repo();
		const s = watched(dir);
		write(dir, "a.js", "a.js v1\n");
		expect(readSteady(s, dir, ["b.js"]).settled).toBe(false);
		expect(readMovedSinceEnd(s, dir)).toEqual({
			headMoved: false,
			moved: [{ path: "a.js", kind: "appeared" }],
		});
	});
});

describe("the JSON form", () => {
	it("reads the same after a round trip, its mark whole", () => {
		const dir = repo();
		const s = watched(dir, () => write(dir, "a.js", "a.js v1\n"));
		const back = JSON.parse(JSON.stringify(s));
		expect(back).toEqual(s);
		expect(BigInt(back.mark)).toBe(BigInt(s.mark));
		expect(steadyOf(back, dir, ["a.js", "b.js"])).toEqual(["b.js"]);
		expect(readMovedSinceEnd(back, dir)).toBeNull();
	});
});
