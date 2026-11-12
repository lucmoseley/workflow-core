// @vitest-environment node
/*
 * lib/push-coverage.js (#5016): the touched tests a queue push holds that no
 * local pass covers, and the warning `session-checkout.js land` prints. Loosen
 * it and a push whose newest commits no local run tested reaches the lander
 * unremarked, or a covered push warns for nothing.
 *
 * In-process, the selector swapped for an adapter, and the pass store too
 * outside the real-store cases; the real `vitest list` is crossed once, by
 * scripts/session-checkout.test.ts.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_READS, watched } from "./pass-store-testkit";
import { buildCoverageWarning, readUncovered } from "./push-coverage.js";

const require = createRequire(import.meta.url);
const { record } = require("./pass-store.js");
const { EDGES_FILE } = require("./test-pass-marker.js");

type Look = NonNullable<
	NonNullable<Parameters<typeof readUncovered>[1]>["look"]
>;

const storeCovering =
	(covered: string[]): Look =>
	(files) => ({
		cached: [],
		run: files.filter((f) => !covered.includes(f)),
		refused: [],
		notice: null,
	});

it("names the touched tests the pass store holds no pass for, of all it touched", () => {
	const c = readUncovered("/w", {
		select: () => ({ files: ["a.test.ts", "b.test.ts", "c.test.ts"] }),
		look: storeCovering(["b.test.ts"]),
		storeRoot: "/root",
	});

	expect(c).toEqual({
		files: ["a.test.ts", "c.test.ts"],
		touched: 3,
		notice: null,
	});
	expect(buildCoverageWarning(c)).toBe(
		[
			"warning: no local pass covers 2 of the 3 test files your work touches, so the lander runs them first, and a red there costs a lander run and a drop (#5016):",
			"  a.test.ts",
			"  c.test.ts",
			"Run them with `npm run test`, which selects them and skips what a pass covers. The push stands: the lander still runs the full suite.",
		].join("\n"),
	);
});

it("asks the pass store about the worktree's own tree, and warns nothing where every touched test is covered", () => {
	const asked: unknown[] = [];
	const c = readUncovered("/w", {
		select: () => ({ files: ["a.test.ts"] }),
		look: (files, at) => {
			asked.push(at);
			return storeCovering(["a.test.ts"])(files, at);
		},
		storeRoot: "/root",
	});

	expect(asked).toEqual([{ root: "/w", storeRoot: "/root" }]);
	expect(buildCoverageWarning(c)).toBeNull();
});

it("warns nothing and asks no store where the work touches no test", () => {
	const c = readUncovered("/w", {
		select: () => ({ files: [] }),
		look: () => {
			throw new Error("asked");
		},
		storeRoot: "/root",
	});

	expect(c).toEqual({ files: [], touched: 0, notice: null });
	expect(buildCoverageWarning(c)).toBeNull();
});

it("carries the pass store's own fault notice under the files it then counts uncovered", () => {
	const c = readUncovered("/w", {
		select: () => ({ files: ["a.test.ts"] }),
		look: (files) => ({
			cached: [],
			run: files,
			refused: [],
			notice: "pass store: unreadable — every selected file runs (#4790).",
		}),
		storeRoot: "/root",
	});

	expect(buildCoverageWarning(c)).toBe(
		[
			"warning: no local pass covers 1 of the 1 test file your work touches, so the lander runs it first, and a red there costs a lander run and a drop (#5016):",
			"  a.test.ts",
			"pass store: unreadable — every selected file runs (#4790).",
			"Run them with `npm run test`, which selects them and skips what a pass covers. The push stands: the lander still runs the full suite.",
		].join("\n"),
	);
});

it("says a selection it could not read, rather than throwing", () => {
	const c = readUncovered("/w", {
		select: () => {
			throw new Error("vitest list failed\n");
		},
		storeRoot: "/root",
	});

	expect(buildCoverageWarning(c)).toBe(
		"warning: which touched tests a local pass covers could not be read (vitest list failed), so any of them may first run in the lander (#5016)",
	);
});

it("names a bare `uncached:` pragma the pass store refuses, never every touched file", () => {
	const c = readUncovered("/w", {
		select: () => ({ files: ["a.test.ts", "b.test.ts"] }),
		look: (files) => ({
			cached: [],
			run: files,
			refused: ["a.test.ts"],
			notice: null,
		}),
		storeRoot: "/root",
	});

	expect(buildCoverageWarning(c)).toBe(
		"warning: which touched tests a local pass covers could not be read (a.test.ts carries an `uncached:` pragma naming no reason, which `npm run test` refuses), so any of them may first run in the lander (#5016)",
	);
});

describe("over the real pass store", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0)
			fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
	});
	const git = (dir: string, ...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	const A = "scripts/a.test.ts";

	function passed() {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pc-")));
		dirs.push(dir);
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		fs.mkdirSync(path.join(dir, "scripts"));
		fs.mkdirSync(path.join(dir, "docs"));
		fs.writeFileSync(path.join(dir, ".gitignore"), ".claude/tmp/\n");
		for (const f of [
			A,
			"lib.js",
			"vitest.config.ts",
			"vitest.setup.ts",
			"package.json",
			"package-lock.json",
		])
			fs.writeFileSync(path.join(dir, f), `${f} v0\n`);
		fs.writeFileSync(path.join(dir, EDGES_FILE), JSON.stringify({ edges: {} }));
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "base");
		record(
			{
				sha: git(dir, "rev-parse", "HEAD"),
				at: new Date(Date.now() - 60_000).toISOString(),
				tree: null,
				root: dir,
				files: [{ file: A, outcome: "pass", imports: ["lib.js"] }],
				shared: ["vitest.config.ts", "vitest.setup.ts"],
				clean: true,
				steadiness: watched(dir),
				audits: new Map([[A, { reads: NO_READS }]]),
			},
			{ storeRoot: dir, lander: false },
		);
		return dir;
	}
	const uncovered = (dir: string) =>
		readUncovered(dir, { select: () => ({ files: [A] }), storeRoot: dir });

	it("counts a test covered while the inputs its pass read stand", () => {
		expect(uncovered(passed())).toEqual({
			files: [],
			touched: 1,
			notice: null,
		});
	});

	it("names the test once a later commit changes an input its pass read", () => {
		const dir = passed();
		fs.writeFileSync(path.join(dir, "lib.js"), "lib.js v1\n");
		git(dir, "commit", "-q", "-am", "later");

		expect(uncovered(dir)).toMatchObject({ files: [A], touched: 1 });
	});
});
