/*
 * Tests for lib/git-objects.js's ls-tree and cat-file readers, against a
 * committed fixture tree. Loosen one and a checker or the test-read-edges
 * render reads a short or wrong tree as a whole one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

it("installs no process handler on load, so a suite launch's program can require it (#2493)", () => {
	const r = spawnSync(
		process.execPath,
		[
			"-e",
			`require(${JSON.stringify(path.join(__dirname, "git-objects.js"))}); console.log(process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection"));`,
		],
		{ encoding: "utf8" },
	);
	expect(r.stdout.trim()).toBe("0");
});

describe("listTree and readObjectBatch, run in a caller's directory (#2382)", () => {
	// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
	const lib: any = createRequire(__filename)("./git-objects.js");
	const { isOutcomeError } = createRequire(__filename)("./outcome-error.js");
	const { GIT_MODE } = createRequire(__filename)("./git-mode.js");

	/** A committed tree, read only: a file, a link to its directory and a link out of the repo. */
	let root: string;
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "check-lib-tree-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init", "-q", ".");
		fs.mkdirSync(path.join(root, "top", "sub"), { recursive: true });
		fs.writeFileSync(path.join(root, "top", "sub", "a.md"), "A body\n");
		fs.symlinkSync("sub", path.join(root, "top", "in"));
		fs.symlinkSync(os.tmpdir(), path.join(root, "top", "out"));
		git("add", "-A");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c");
	});
	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("lists a directory's own entries, trees and links with their modes, when not recursive", () => {
		const entries = lib.listTree("HEAD", ["top/"], {
			cwd: root,
			recursive: false,
		});
		expect(
			entries.map((e: { mode: string; path: string }) => [e.mode, e.path]),
		).toEqual([
			[GIT_MODE.symlink, "top/in"],
			[GIT_MODE.symlink, "top/out"],
			[GIT_MODE.tree, "top/sub"],
		]);
	});

	it("lists every blob and link under the pathspec, when recursive", () => {
		const entries = lib.listTree("HEAD", ["top/"], { cwd: root });
		expect(entries.map((e: { path: string }) => e.path)).toEqual([
			"top/in",
			"top/out",
			"top/sub/a.md",
		]);
	});

	it("answers a followed link with its target's blob, a link out of the repo with git's symlink type, and a missing path with null", () => {
		const got = lib.readObjectBatch(
			[
				"HEAD:./top/in/a.md",
				"HEAD:./top/out/x",
				"HEAD:./top/none",
				"HEAD:./top/sub/a.md",
			],
			"the fixture's files",
			{ cwd: root, followSymlinks: true },
		);
		expect(
			got.map((o: { type: string; body: Buffer } | null) =>
				o === null ? null : [o.type, o.body.toString("utf8")],
			),
		).toEqual([
			["blob", "A body\n"],
			/* git prints the target alone, not the path left to walk. */
			["symlink", os.tmpdir()],
			null,
			["blob", "A body\n"],
		]);
	});

	it("answers a link itself as a blob holding its target, when not following", () => {
		const [link] = lib.readObjectBatch(["HEAD:top/in"], "the fixture's link", {
			cwd: root,
		});
		expect([link.type, link.body.toString("utf8")]).toEqual(["blob", "sub"]);
	});

	it("answers under a timeout a healthy git meets (#2493)", () => {
		const opts = { cwd: root, timeout: 30_000 };
		expect(lib.listTree("HEAD", ["top/sub/"], opts)).toHaveLength(1);
		expect(
			lib.readObjectBatch(["HEAD:top/sub/a.md"], "a", opts)[0].body.toString(),
		).toBe("A body\n");
	});

	it("throws an outcome error once a wedged git outlives the caller's timeout (#2493)", () => {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "check-lib-wedged-"));
		fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", {
			mode: 0o755,
		});
		const Path = process.env.PATH;
		process.env.PATH = `${bin}${path.delimiter}${Path}`;
		/* Crosses the real clock: the guarantee is spawnSync's own kill, which
		 * no seam reaches. Any timeout under the stub's 30 s sleep fires, and
		 * 200 ms keeps the case cheap. */
		const thrown = (fn: () => unknown) => {
			try {
				fn();
			} catch (e) {
				return e;
			}
			throw new Error("did not throw");
		};
		try {
			const opts = { cwd: root, timeout: 200 };
			const listed = thrown(() => lib.listTree("HEAD", [], opts));
			const batched = thrown(() =>
				lib.readObjectBatch(["HEAD:top/sub/a.md"], "a", opts),
			);
			expect(isOutcomeError(listed)).toBe(true);
			expect(String(listed)).toMatch(/ls-tree failed/);
			expect(isOutcomeError(batched)).toBe(true);
			expect(String(batched)).toMatch(/cat-file failed/);
		} finally {
			process.env.PATH = Path;
			fs.rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("readFileAt — one file's text at a revision or in the index (#3139)", () => {
	// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
	const lib: any = createRequire(__filename)("./git-objects.js");
	const { isOutcomeError } = createRequire(__filename)("./outcome-error.js");

	let root: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "ignore" });
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "check-lib-file-at-"));
		git("init", "-q", ".");
		fs.mkdirSync(path.join(root, "dir"));
		fs.writeFileSync(path.join(root, "dir", "f"), "committed\n");
		git("add", "-A");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c");
		fs.writeFileSync(path.join(root, "dir", "f"), "staged\n");
		git("add", "dir/f");
	});
	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("reads the committed text at a revision and the staged text from the index", () => {
		expect(lib.readFileAt("HEAD", "dir/f", { cwd: root })).toBe("committed\n");
		expect(lib.readFileAt("", "dir/f", { cwd: root })).toBe("staged\n");
	});

	it("answers null where the path is absent, at a revision and in the index", () => {
		expect(lib.readFileAt("HEAD", "gone", { cwd: root })).toBeNull();
		expect(lib.readFileAt("", "gone", { cwd: root })).toBeNull();
	});

	it("answers undefined where the revision names no commit, an unborn HEAD included", () => {
		expect(
			lib.readFileAt("no-such-rev", "dir/f", { cwd: root }),
		).toBeUndefined();
		const unborn = fs.mkdtempSync(path.join(os.tmpdir(), "check-lib-unborn-"));
		try {
			execFileSync("git", ["init", "-q", "."], { cwd: unborn });
			expect(lib.readFileAt("HEAD", "f", { cwd: unborn })).toBeUndefined();
		} finally {
			fs.rmSync(unborn, { recursive: true, force: true });
		}
	});

	it("throws BROKEN through readCommittedFile where the revision names no commit, null still for an absent path", () => {
		let thrown: unknown;
		try {
			lib.readCommittedFile("no-such-rev", "dir/f", { cwd: root });
		} catch (e) {
			thrown = e;
		}
		expect(isOutcomeError(thrown)).toBe(true);
		expect((thrown as Error).message).toBe("no-such-rev names no commit");
		expect(lib.readCommittedFile("HEAD", "gone", { cwd: root })).toBeNull();
	});

	it("throws BROKEN where a revision or the index holds a submodule at the path", () => {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		git("update-index", "--add", "--cacheinfo", `160000,${sha},sub`);
		try {
			expect(() => lib.readFileAt("", "sub", { cwd: root })).toThrow(
				"sub at the index is not a file",
			);
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "s");
			expect(() => lib.readFileAt("HEAD", "sub", { cwd: root })).toThrow(
				"sub at HEAD is not a file",
			);
		} finally {
			git("reset", "-q", "--soft", sha);
			git("rm", "-q", "--cached", "sub");
		}
	});

	it("throws BROKEN where the path holds no file", () => {
		let thrown: unknown;
		try {
			lib.readFileAt("HEAD", "dir", { cwd: root });
		} catch (e) {
			thrown = e;
		}
		expect(isOutcomeError(thrown)).toBe(true);
		expect((thrown as Error).message).toBe("dir at HEAD is not a file");
	});
});
