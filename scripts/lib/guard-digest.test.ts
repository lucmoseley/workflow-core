// @vitest-environment node
/*
 * guard-digest.js over fixture trees: a plain directory, read on disk, and a
 * git checkout, whose membership is the index and whose bytes are the disk's
 * (#4508). The digest is what the guard registry anchors a rule's prose to;
 * one that misses a dependency lets a rule go stale unwarned, one that reads
 * outside the tree gives two worktrees of one commit two verdicts.
 *
 * tree-members.js reads each checkout's index once per process, so every
 * index a case changes is read through a tree no earlier call has seen.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./git-fixture";

const { digestOf } = require("./guard-digest.js") as {
	digestOf: (
		base: string,
		rel: string,
	) => { digest: string | null; hashed: Set<string>; absent: Set<string> };
};

const scratch = mkScratchDir("guard-digest-");
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const noHooks = path.join(scratch, "no-hooks");
fs.mkdirSync(noHooks);

let n = 0;
const fresh = (name: string) => path.join(scratch, `${name}-${n++}`);

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

function writeTree(root: string, files: Record<string, string>) {
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	}
}

/** A directory no checkout tops, read as it lies on disk. */
function plainTree(files: Record<string, string>) {
	const root = fresh("plain");
	writeTree(root, files);
	return root;
}

/** A checkout with `files` committed. */
function committed(files: Record<string, string>) {
	const root = fresh("repo");
	initGitRepo(root, noHooks);
	writeTree(root, files);
	git(root, "add", "-A");
	git(root, "commit", "-q", "--allow-empty", "-m", "fixture");
	return root;
}

/** A second worktree of `root`'s HEAD. */
function worktreeOf(root: string) {
	const other = fresh("wt");
	git(root, "worktree", "add", "-q", "--detach", other);
	return other;
}

const sorted = (s: Set<string>) => [...s].sort();

describe("a guard's closure, read on disk in a plain directory", () => {
	it("hashes its dependencies in sorted order, whatever order it names them in", () => {
		const files = {
			"scripts/g.js": 'require("./lib/b.js");\nrequire("./lib/a.js");\n',
			"scripts/lib/a.js": "1\n",
			"scripts/lib/b.js": "2\n",
		};
		const sha = (...parts: string[]) => {
			const h = createHash("sha256");
			for (const p of parts) h.update(p);
			return h.digest("hex").slice(0, 16);
		};
		const want = sha(
			files["scripts/g.js"],
			`\0scripts/lib/a.js\0${sha(files["scripts/lib/a.js"])}`,
			`\0scripts/lib/b.js\0${sha(files["scripts/lib/b.js"])}`,
		);

		expect(digestOf(plainTree(files), "scripts/g.js").digest).toBe(want);
	});
	it("hashes a cycle once, and still moves on an edit inside it", () => {
		const files = {
			"scripts/g.js": 'require("./lib/a.js");\n',
			"scripts/lib/a.js": 'require("./b.js");\n',
			"scripts/lib/b.js": 'require("./a.js");\n',
		};
		const root = plainTree(files);
		const before = digestOf(root, "scripts/g.js");
		const edited = plainTree({
			...files,
			"scripts/lib/b.js": 'require("./a.js");\n// edited\n',
		});

		expect(before.digest).not.toBeNull();
		expect(sorted(before.hashed)).toEqual([
			"scripts/g.js",
			"scripts/lib/a.js",
			"scripts/lib/b.js",
		]);
		expect(digestOf(edited, "scripts/g.js").digest).not.toBe(before.digest);
	});

	it("hashes a dependency not on disk as absent and reports it", () => {
		const root = plainTree({ "scripts/g.js": 'require("./lib/gone.js");\n' });
		const d = digestOf(root, "scripts/g.js");

		expect(d.digest).not.toBeNull();
		expect(sorted(d.absent)).toEqual(["scripts/lib/gone.js"]);
		expect(d.hashed.has("scripts/lib/gone.js")).toBe(true);
	});

	it("moves when only a dispatch manifest row changes (#3124)", () => {
		const manifest = (tools: string) =>
			`${JSON.stringify({
				PreToolUse: [
					{ name: "x", core: "x.js", tools, failure: "open", tree: "host" },
				],
			})}\n`;
		const files = (tools: string) => ({
			"scripts/guard-dispatch.js": 'require("./lib/guard-dispatch.js");\n',
			"scripts/lib/guard-dispatch.js": "module.exports = 1;\n",
			"scripts/lib/guard-cores.json": manifest(tools),
			"scripts/lib/x.js": "module.exports = 1;\n",
		});
		const bash = digestOf(
			plainTree(files("Bash")),
			"scripts/guard-dispatch.js",
		);
		const write = digestOf(
			plainTree(files("Write")),
			"scripts/guard-dispatch.js",
		);

		expect(sorted(bash.hashed)).toEqual([
			"scripts/guard-dispatch.js",
			"scripts/lib/guard-cores.json",
			"scripts/lib/guard-dispatch.js",
			"scripts/lib/x.js",
		]);
		expect(write.digest).not.toBe(bash.digest);
	});
});

describe("a gate stack's digest stops at the gates it runs (#4456)", () => {
	const header = (runs: string) =>
		[
			"#!/usr/bin/env sh",
			"# IMPLICIT:  runs every gate below and refuses the commit on a red.",
			runs,
			"",
		].join("\n");
	const declared =
		"# RUNS:      gates — scripts/named.js joins them; each is judged by its own row.";
	const stack = (runs: string, extra: Record<string, string> = {}) =>
		plainTree({
			".husky/pre-commit": `${header(runs)}. "\${ROOT:-.}"/scripts/lib/gate.sh\nnode "\${ROOT:-.}"/scripts/check-valid.js || exit "$?"\n`,
			"scripts/lib/gate.sh": "gate() { :; }\n",
			"scripts/check-valid.js": 'require("./lib/valid-lib.js");\n',
			"scripts/lib/valid-lib.js": "module.exports = 1;\n",
			"scripts/named.js": 'require("./lib/named-lib.js");\n',
			"scripts/lib/named-lib.js": "module.exports = 1;\n",
			...extra,
		});
	const of = (root: string) => digestOf(root, ".husky/pre-commit");

	it("hashes what it sources and the files its header names, not what it runs", () => {
		expect(sorted(of(stack(declared)).hashed)).toEqual([
			".husky/pre-commit",
			"scripts/lib/gate.sh",
			"scripts/named.js",
		]);
	});

	it("moves on a named file's bytes, not on that file's libraries or a gate's", () => {
		const base = of(stack(declared)).digest;

		expect(
			of(stack(declared, { "scripts/lib/valid-lib.js": "2\n" })).digest,
		).toBe(base);
		expect(
			of(stack(declared, { "scripts/lib/named-lib.js": "2\n" })).digest,
		).toBe(base);
		expect(
			of(stack(declared, { "scripts/named.js": "// edited\n" })).digest,
		).not.toBe(base);
	});

	it("still follows the gates of a stack that declares nothing, as a thin wrapper needs", () => {
		expect(sorted(of(stack("#")).hashed)).toEqual([
			".husky/pre-commit",
			"scripts/check-valid.js",
			"scripts/lib/gate.sh",
			"scripts/lib/valid-lib.js",
		]);
	});
});

describe("a guard's closure in a git checkout: the index's members, the disk's bytes (#4508)", () => {
	/* Every probe the closure makes: a hook-local lib shadowing the shared one,
	 * a sibling shadowing a run target, a require of a lib not in the tree, and
	 * a scripts/ path a gate stack's header names that no commit carries. */
	const shadows = [
		".husky/lib/gate.sh",
		".husky/scripts/check-valid.js",
		"scripts/lib/absent.js",
		"scripts/not-yet.js",
	];
	const rows = [".husky/pre-commit", "scripts/check-valid.js"];
	const files = {
		".husky/pre-commit": [
			"#!/usr/bin/env sh",
			"# IMPLICIT:  runs every gate below and refuses the commit on a red.",
			"# RUNS:      gates — scripts/not-yet.js joins them later.",
			"#",
			'. "$ROOT"/scripts/lib/gate.sh',
			'node "$ROOT"/scripts/check-valid.js || exit "$?"',
			"",
		].join("\n"),
		"scripts/lib/gate.sh": "gate() { :; }\n",
		"scripts/check-valid.js": 'require("./lib/absent.js");\n',
		".gitignore": ".husky/lib/\n",
	};
	const plant = (tree: string) =>
		writeTree(tree, Object.fromEntries(shadows.map((p) => [p, "planted\n"])));
	const digests = (tree: string) =>
		Object.fromEntries(rows.map((g) => [g, digestOf(tree, g).digest]));

	it("gives every row one digest in two worktrees, one carrying untracked and ignored shadows", () => {
		const root = committed(files);
		const other = worktreeOf(root);
		plant(other);
		const clean = digests(root);

		expect(Object.values(clean).every((d) => d !== null)).toBe(true);
		expect(digests(other)).toEqual(clean);
		expect(sorted(digestOf(other, "scripts/check-valid.js").absent)).toEqual([
			"scripts/lib/absent.js",
		]);
	});

	it("takes a shadow into the closure once it is in the index", () => {
		const root = committed(files);
		const clean = digests(root);
		const other = worktreeOf(root);
		writeTree(other, { "scripts/lib/absent.js": "1\n" });
		git(other, "add", "scripts/lib/absent.js");
		const staged = digestOf(other, "scripts/check-valid.js");

		expect(staged.digest).not.toBe(clean["scripts/check-valid.js"]);
		expect(staged.absent.size).toBe(0);
	});

	it("hashes a tracked dependency's unstaged bytes", () => {
		const lib = {
			"scripts/g.js": 'require("./lib/a.js");\n',
			"scripts/lib/a.js": "1\n",
		};
		const root = committed(lib);
		const clean = digestOf(root, "scripts/g.js").digest;
		const other = worktreeOf(root);
		writeTree(other, { "scripts/lib/a.js": "2\n" });

		expect(digestOf(other, "scripts/g.js").digest).not.toBe(clean);
	});

	it("gives a guard outside the index no digest, whatever lies on disk (#4517)", () => {
		const root = committed({});
		writeTree(root, { "scripts/g.js": "1\n" });
		const d = digestOf(root, "scripts/g.js");

		expect(d.digest).toBeNull();
		expect(sorted(d.hashed)).toEqual(["scripts/g.js"]);
	});
});
