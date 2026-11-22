// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFaultyGit } from "./git-fault-fake";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	trioTemplate,
} from "./git-fixture";
import { patchFiles, treeClassifier } from "./git-tree.js";
import { shellQuote } from "./sh-quote.js";

const template = defineTemplate(trioTemplate());

let dir: string;
let shared: string;
let worktree: string;
let elsewhere: string;
beforeAll(() => {
	dir = mkScratchDir("git-tree-");
	template.instantiate(dir);
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const fresh = (name: string) => fs.mkdtempSync(path.join(dir, `${name}-`));

const brokenRepo = () => {
	const broken = fresh("broken-repo");
	fs.writeFileSync(
		path.join(broken, ".git"),
		`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
	);
	return broken;
};

const stubGit = (delay = 0) => {
	const at = fresh("stub");
	const log = path.join(at, "calls");
	const { git } = writeFaultyGit(
		{ all: true },
		{
			script: [
				`echo "$* @ $(pwd -P)" >> ${shellQuote(log)}`,
				...(delay ? [`sleep ${delay}`] : []),
			].join("\n"),
		},
		{ under: at },
	);
	vi.stubEnv("WFC_GIT", git);
	return {
		calls: () =>
			fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
	};
};

describe("treeClassifier's four answers", () => {
	it("separates the shared tree from a linked worktree of the same repo", () => {
		const classify = treeClassifier(shared);
		expect(classify(shared)).toBe("shared");
		expect(classify(worktree)).toBe("linked");
	});

	it("answers from inside a worktree's own root too", () => {
		expect(treeClassifier(worktree)(shared)).toBe("shared");
	});

	it("calls another repo, and a path in none, `other`", () => {
		const classify = treeClassifier(shared);
		expect(classify(elsewhere)).toBe("other");
		expect(classify(path.join(dir, "no-such-dir"))).toBe("other");
	});

	it("calls a directory in no repository at all `other` (mantahostels#253)", () => {
		const opaque = mkDirOutsideRepo("not-a-repo-");
		try {
			expect(treeClassifier(shared)(opaque)).toBe("other");
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
	});

	it("calls a tree git cannot answer for `unknown`, not `other` (mantahostels#147)", () => {
		expect(treeClassifier(shared)(brokenRepo())).toBe("unknown");
	});

	it("finds the repo marker through a symlinked path (mantahostels#253)", () => {
		const outside = mkDirOutsideRepo("git-tree-link-");
		try {
			const proj = path.join(outside, "real", "proj");
			fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
			fs.writeFileSync(
				path.join(proj, ".git"),
				`gitdir: ${path.join(outside, "no-such-gitdir")}\n`,
			);
			const link = path.join(outside, "link");
			fs.symlinkSync(path.join(proj, "sub"), link);
			expect(treeClassifier(shared)(link)).toBe("unknown");
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("reads the shared tree through a symlink to it as the shared tree", () => {
		const link = path.join(fresh("links"), "to-shared");
		fs.symlinkSync(shared, link);
		expect(treeClassifier(shared)(link)).toBe("shared");
	});

	it("calls an empty path `unknown`, not `other` (#311)", () => {
		expect(treeClassifier(shared)("")).toBe("unknown");
	});
});

describe("treeClassifier — the repo itself", () => {
	it("throws where the root did not resolve", () => {
		expect(() => treeClassifier("")).toThrow(
			"the repo root did not resolve — command allowed unchecked",
		);
	});

	it("throws where git resolves no git dir for the root", () => {
		const bare = mkDirOutsideRepo("git-tree-bare-");
		try {
			expect(() => treeClassifier(bare)).toThrow(
				`git could not resolve a git dir for ${bare} — command allowed unchecked`,
			);
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}
	});
});

describe("treeClassifier — one git call per question, under a timeout", () => {
	it("asks git once for a directory named twice", () => {
		const classify = treeClassifier(shared);
		const target = fresh("memo");
		fs.cpSync(shared, target, { recursive: true });
		const git = stubGit();
		expect(classify(target)).toBe("other");
		expect(classify(target)).toBe("other");
		expect(git.calls()).toEqual([
			`rev-parse --path-format=absolute --git-common-dir @ ${fs.realpathSync(target)}`,
			expect.stringContaining(
				`-C ${target} rev-parse --path-format=absolute --git-dir @ `,
			),
		]);
	});

	it("answers `unknown` where git outlives the timeout", () => {
		const classify = treeClassifier(shared, { timeoutMs: 100 });
		const target = fresh("slow");
		stubGit(1);
		expect(classify(target)).toBe("unknown");
	});

	it("answers `unknown` for a timeout in a directory in no repository", () => {
		const classify = treeClassifier(shared, { timeoutMs: 100 });
		const opaque = mkDirOutsideRepo("git-tree-slow-");
		stubGit(1);
		try {
			expect(classify(opaque)).toBe("unknown");
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
	});
});

describe("patchFiles (#2147)", () => {
	const writePatch = () => {
		const at = fresh("patch");
		const file = path.join(at, "own.patch");
		fs.writeFileSync(
			file,
			"diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n+b\n" +
				"diff --git a/a.md b/c.md\nsimilarity index 100%\nrename from a.md\nrename to c.md\n",
		);
		return file;
	};

	const top = () => fs.realpathSync(shared);

	it("names each file the patch touches from the tree's top level, a rename by its new name", () => {
		expect(patchFiles(shared, writePatch())).toEqual([
			`${top()}/a.md`,
			`${top()}/c.md`,
		]);
	});

	it("joins a relative patch word to the directory", () => {
		const file = writePatch();
		const sub = path.join(shared, "sub");
		fs.mkdirSync(sub, { recursive: true });
		fs.copyFileSync(file, path.join(sub, "p.diff"));
		expect(patchFiles(sub, "p.diff")).toEqual([
			`${top()}/a.md`,
			`${top()}/c.md`,
		]);
	});

	it("answers null for an unreadable or missing patch, asking git apply nothing", () => {
		const git = stubGit();
		expect(patchFiles(shared, path.join(dir, "no-such.patch"))).toBeNull();
		expect(git.calls().filter((c) => c.includes(" apply "))).toEqual([]);
	});

	it("answers null where git apply outlives the timeout, whatever it printed", () => {
		const { git: slow } = writeFaultyGit(
			{ words: ["apply"] },
			{ script: "printf '1\\t1\\ta.md\\0'\nexec sleep 3" },
			{ under: dir },
		);
		const tree = fresh("slow-tree");
		fs.cpSync(shared, tree, { recursive: true });
		vi.stubEnv("WFC_GIT", slow);
		expect(patchFiles(tree, writePatch(), { timeoutMs: 1000 })).toBeNull();
	});

	it("answers null for a patch git will not read", () => {
		const file = path.join(fresh("garbage"), "bad.patch");
		fs.writeFileSync(file, "not a patch\n");
		expect(patchFiles(shared, file)).toBeNull();
	});

	it("answers null for a directory in no repository", () => {
		const opaque = mkDirOutsideRepo("git-tree-nopatch-");
		try {
			expect(patchFiles(opaque, writePatch())).toBeNull();
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
	});
});
