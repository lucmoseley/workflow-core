// @vitest-environment node
/*
 * Pins the band read's `put`, `get` and `list`: an entry stored under the key
 * it was given or a body's own, only tracked paths recorded, and a missing or
 * malformed key refused rather than invented (mantahostels#385).
 *
 * Run against a throwaway repository: `put` records which of the write-set's
 * paths git tracks, so the assertions need a real tree, and pointing it at this
 * one would write the real cache.
 *
 * `/pick-next` runs `put` after every band read: break it and a judged answer
 * lands under the wrong key, or not at all, and the next pick pays for the
 * read again or ranks on a stale write-set.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const writeSetCache = require("./lib/write-set-cache.js");

const SCRIPT = path.resolve(__dirname, "pick-next-cache.js");

/** Real 64-hex keys: `put` refuses anything else. */
const HASH_A = writeSetCache.bodyHash("body a");
const HASH_B = writeSetCache.bodyHash("body b");
let root: string;

/** A throwaway repo tracking `files`. */
const stubRepo = (files: string[]) => {
	for (const f of files) {
		fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
		fs.writeFileSync(path.join(root, f), "");
	}
	spawnSync("git", ["init", "-q"], { cwd: root });
	spawnSync("git", ["add", "-A"], { cwd: root });
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, CLAUDE_PROJECT_DIR: root, WFC_REPO_ROOT: root },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-cache-"));
	stubRepo([]);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("put", () => {
	it("stores the write-set under the key it was given", () => {
		const hash = writeSetCache.bodyHash("a body");
		const r = run(
			"put",
			"7",
			"--body-hash",
			hash,
			"--write-set",
			"scripts/a.js,scripts/b.js",
			"--size",
			"M",
			"--gist",
			"does a thing",
		);
		expect(r.status).toBe(0);
		expect(writeSetCache.readEntry(root, 7)).toMatchObject({
			issue: 7,
			bodyHash: hash,
			writeSet: ["scripts/a.js", "scripts/b.js"],
			sizeBand: "M",
			gist: "does a thing",
		});
	});

	it("derives the key from a body file, for a caller holding no hash", () => {
		const f = path.join(root, "body.md");
		fs.writeFileSync(f, "a body");
		expect(run("put", "7", "--body-file", f).status).toBe(0);
		expect(writeSetCache.readEntry(root, 7).bodyHash).toBe(
			writeSetCache.bodyHash("a body"),
		);
	});

	it("records only the write-set paths git tracks today", () => {
		// That subset is what later tells a rename from a file yet to be created.
		stubRepo(["scripts/exists.js"]);
		run(
			"put",
			"7",
			"--body-hash",
			HASH_A,
			"--write-set",
			"scripts/exists.js,scripts/planned.js",
		);
		const entry = writeSetCache.readEntry(root, 7);
		expect(entry.writeSet).toEqual(["scripts/exists.js", "scripts/planned.js"]);
		expect(entry.trackedAtDerive).toEqual(["scripts/exists.js"]);
	});

	it("records no tracked path where git cannot answer at all", () => {
		// Claiming a path was tracked when that is unknown would re-derive the
		// entry the moment git works again.
		stubRepo(["scripts/a.js"]);
		const put = () =>
			run("put", "7", "--body-hash", HASH_A, "--write-set", "scripts/a.js");
		put();
		expect(writeSetCache.readEntry(root, 7).trackedAtDerive).toEqual([
			"scripts/a.js",
		]);

		fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
		put();
		expect(writeSetCache.readEntry(root, 7).trackedAtDerive).toEqual([]);
		expect(writeSetCache.readEntry(root, 7).writeSet).toEqual(["scripts/a.js"]);
	});

	it("stores an empty write-set for a comment-only issue", () => {
		expect(run("put", "7", "--body-hash", HASH_A).status).toBe(0);
		expect(writeSetCache.readEntry(root, 7).writeSet).toEqual([]);
	});

	it("refuses without a key, naming a key flag to pass, rather than storing one it invented", () => {
		const r = run("put", "7", "--write-set", "scripts/a.js");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/--body-hash|--body-file/);
		expect(writeSetCache.readEntry(root, 7)).toBeNull();
	});

	it("refuses both key flags at once rather than picking one, and stores nothing", () => {
		const f = path.join(root, "body.md");
		fs.writeFileSync(f, "a body");
		const r = run("put", "7", "--body-hash", HASH_A, "--body-file", f);
		expect(r.status).toBe(1);
		expect(writeSetCache.readEntry(root, 7)).toBeNull();
	});

	it("refuses an unreadable body file, and stores nothing", () => {
		const r = run("put", "7", "--body-file", path.join(root, "absent.md"));
		expect(r.status).toBe(1);
		expect(writeSetCache.readEntry(root, 7)).toBeNull();
	});

	it("takes the key a dumped body carries, not a hash of the whole file", () => {
		// A --dump-bodies file is the body plus a title line and the key itself,
		// so hashing it whole yields a key that can never match while reporting
		// success.
		const f = path.join(root, "7.md");
		fs.writeFileSync(
			f,
			`# #7 — a title\n\n<!-- body-hash: ${HASH_A} -->\n\nthe body\n`,
		);
		expect(run("put", "7", "--body-file", f).status).toBe(0);
		expect(writeSetCache.readEntry(root, 7).bodyHash).toBe(HASH_A);
	});

	it("refuses a key that is not the 64-hex one the script printed, and stores nothing", () => {
		const r = run("put", "7", "--body-hash", "abc");
		expect(r.status).toBe(1);
		expect(writeSetCache.readEntry(root, 7)).toBeNull();
	});

	it("leaves no scratch file behind, the write going through a rename", () => {
		run("put", "7", "--body-hash", HASH_A);
		expect(
			fs
				.readdirSync(writeSetCache.cacheDir(root))
				.filter((f: string) => f.endsWith(".tmp")),
		).toEqual([]);
	});

	it("overwrites an earlier entry for the same issue", () => {
		run("put", "7", "--body-hash", HASH_A, "--gist", "first");
		run("put", "7", "--body-hash", HASH_A, "--gist", "second");
		expect(writeSetCache.readEntry(root, 7).gist).toBe("second");
	});
});

describe("get and list", () => {
	it("prints a stored entry and says so when there is none", () => {
		expect(run("get", "7").out).toMatch(/no entry for #7/);
		run("put", "7", "--body-hash", HASH_A, "--gist", "a gist");
		expect(JSON.parse(run("get", "7").out)).toMatchObject({ gist: "a gist" });
	});

	it("lists what is cached, and says nothing is when the store is empty", () => {
		expect(run("list").out).toMatch(/no store yet/);
		run("put", "7", "--body-hash", HASH_A);
		run("put", "9", "--body-hash", HASH_B);
		const out = run("list").out;
		expect(out).toMatch(/2 cached write-set\(s\)/);
		expect(out).toMatch(/#7/);
		expect(out).toMatch(/#9/);
	});
});

describe("bad invocation", () => {
	it("exits non-zero on an unknown command and on a missing number", () => {
		expect(run("frobnicate", "7").status).toBe(1);
		expect(run("put").status).toBe(1);
		expect(run("get", "not-a-number").status).toBe(1);
	});
});
