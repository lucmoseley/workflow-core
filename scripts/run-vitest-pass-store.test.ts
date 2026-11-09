// @vitest-environment node
/*
 * The launcher's half of the per-file pass store (#4790), through
 * run-vitest.js's `main` and its injected spawn: a file a recorded pass
 * covers on identical inputs is taken out of what vitest is handed, a
 * launch the store covers whole spawns nothing and joins no queue yet leaves
 * its pass record and ledger line, and the launches that ask every file to
 * run look nothing up. The store itself — what a row holds, what voids it —
 * is lib/pass-store.test.ts's.
 *
 * Loosen a case and a file is skipped on a run that asked for it, or a run
 * that skipped one attests nothing of it.
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { main } = require("./run-vitest.js");
const {
	CACHED_ENV,
	readCachedHandoff,
	record,
} = require("./lib/pass-store.js");
const { looksUpPassStore } = require("./lib/launch-route.js");
const { EDGES_FILE, storePath } = require("./lib/test-pass-marker.js");
const { markersDir } = require("./lib/marker-root.js");
const { RUN_LEDGER } = require("./lib/run-ledger.js");

const A = "scripts/a.test.ts";
const B = "scripts/b.test.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

/** A repository holding two test files, committed. */
function repo() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rvps-")));
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	fs.mkdirSync(path.join(dir, "scripts"));
	fs.mkdirSync(path.join(dir, "docs"));
	fs.writeFileSync(path.join(dir, ".gitignore"), ".claude/\n");
	for (const f of [A, B, "vitest.config.ts", "package.json"])
		fs.writeFileSync(path.join(dir, f), `${f} v0\n`);
	fs.writeFileSync(path.join(dir, EDGES_FILE), JSON.stringify({ edges: {} }));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return dir;
}

/** A clean vitest run at `dir` in which each of `files` passed. */
function passed(dir: string, files: string[]) {
	record(
		{
			sha: git(dir, "rev-parse", "HEAD"),
			at: new Date(Date.now() - 60_000).toISOString(),
			tree: null,
			root: dir,
			files: files.map((file) => ({ file, outcome: "pass", imports: [] })),
			shared: ["vitest.config.ts"],
			clean: true,
			drifted: [],
		},
		{ storeRoot: dir, lander: false },
	);
}

/** A child that closes at once with 0, and the spawns it was handed. */
function spawner() {
	const calls: { args: string[]; env: Record<string, string> }[] = [];
	const handoffs: unknown[] = [];
	const spawnFn = (
		_bin: string,
		args: string[],
		opts: { env: Record<string, string> },
	) => {
		calls.push({ args, env: opts.env });
		handoffs.push(readCachedHandoff(opts.env));
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		queueMicrotask(() => {
			child.stdout.end();
			child.stderr.end();
			child.emit("close", 0);
		});
		return child;
	};
	return { spawnFn, calls, handoffs };
}

function sink() {
	const text: string[] = [];
	return { text, write: (s: string) => text.push(s) };
}

async function launch(dir: string, argv: string[], extra = {}) {
	const spawned = spawner();
	const out = sink();
	const err = sink();
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	let code: number;
	try {
		code = await main([...argv, "--shared"], {
			spawnFn: spawned.spawnFn,
			root: dir,
			out,
			err,
			...extra,
		});
	} finally {
		stdout.mockRestore();
	}
	return {
		code,
		...spawned,
		out: out.text.join(""),
		err: err.text.join(""),
	};
}

const lastLine = (file: string) => {
	const lines = fs.readFileSync(file, "utf8").trim().split("\n");
	return JSON.parse(lines.at(-1) as string);
};

describe("a named launch the pass store partly covers", () => {
	it("hands vitest only the files it does not cover, names each it does, and hands the child what it cached", async () => {
		const dir = repo();
		passed(dir, [A]);
		const ran = await launch(dir, [A, B]);
		expect(ran.code).toBe(0);
		expect(ran.calls).toHaveLength(1);
		expect(ran.calls[0]?.args).toContain(B);
		expect(ran.calls[0]?.args).not.toContain(A);
		expect(ran.out).toMatch(/CACHED — 1 selected file/);
		expect(ran.out).toContain(A);
		expect(ran.handoffs[0]).toEqual([expect.objectContaining({ file: A })]);
	});

	it("runs a file whose input changed since its pass", async () => {
		const dir = repo();
		passed(dir, [A]);
		fs.writeFileSync(path.join(dir, A), "changed\n");
		const ran = await launch(dir, [A, B]);
		expect(ran.calls[0]?.args).toEqual(expect.arrayContaining([A, B]));
		expect(ran.handoffs[0]).toEqual([]);
	});
});

describe("a launch the pass store covers whole", () => {
	it("spawns nothing, exits 0, and leaves a pass record and ledger line naming what it cached", async () => {
		const dir = repo();
		passed(dir, [A, B]);
		const ran = await launch(dir, [A, B]);
		expect(ran.code).toBe(0);
		expect(ran.calls).toEqual([]);
		expect(ran.out).toMatch(/Every selected file was cached/);
		const marker = lastLine(storePath(dir));
		expect(marker.selected).toEqual([A, B]);
		expect(marker.cached.map((c: { file: string }) => c.file)).toEqual([A, B]);
		expect(lastLine(path.join(markersDir(dir), RUN_LEDGER))).toMatchObject({
			cachedFiles: 2,
			ranFiles: 0,
		});
	});

	it("joins no queue", async () => {
		const dir = repo();
		passed(dir, [A]);
		const gate = vi.fn(() => true);
		const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "rvps-q-"));
		dirs.push(queueDir);
		const ran = await launch(dir, [A, "--queue"], { gate, queueDir });
		expect(ran.code).toBe(0);
		expect(ran.calls).toEqual([]);
		expect(gate).not.toHaveBeenCalled();
	});
});

describe("launches that look nothing up", () => {
	it("runs every file under `--no-cache`, handing the child no inherited cache", async () => {
		const dir = repo();
		passed(dir, [A]);
		vi.stubEnv(CACHED_ENV, path.join(dir, "inherited.json"));
		const ran = await launch(dir, [A, "--no-cache"]);
		expect(ran.calls[0]?.args).toContain(A);
		expect(ran.calls[0]?.env).not.toHaveProperty(CACHED_ENV);
	});

	it.each([
		["a full run", { kind: "full", source: "full" }, []],
		["a retest", { kind: "named", source: "retest" }, []],
		["`--no-cache`", { kind: "named", source: "named" }, ["--no-cache"]],
	])("%s", (_name, route, argv) => {
		expect(looksUpPassStore(route, argv)).toBe(false);
	});

	it("a named run otherwise", () => {
		expect(looksUpPassStore({ kind: "named", source: "named" }, [A])).toBe(
			true,
		);
	});
});

describe("the `uncached:` pragma (#4790)", () => {
	it("refuses a launch naming a file whose pragma gives no reason, running nothing", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, A), "// uncached:\nit()\n");
		const ran = await launch(dir, [A, B]);
		expect(ran.code).toBe(1);
		expect(ran.calls).toEqual([]);
		expect(ran.err).toMatch(
			/UNCACHED PRAGMA WITH NO REASON — scripts\/a\.test\.ts/,
		);
	});

	it("runs a file whose pragma gives one, however its pass was recorded", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, A), "// uncached: reads the clock\n");
		passed(dir, [A]);
		const ran = await launch(dir, [A]);
		expect(ran.calls[0]?.args).toContain(A);
	});
});
