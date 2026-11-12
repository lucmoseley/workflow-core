// @vitest-environment node
/*
 * Each run's private temp root (#5083): made under the real temp dir with its
 * owner's pid in the name, removed whole, and swept at a wrapper's start once
 * that pid is dead. Loosen a case and a killed run's fixtures stay in `/tmp`,
 * or a live run loses its root mid-run.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
	STALE_MS,
	makeRunRoot,
	removeRunRoot,
	sweepDeadRunRoots,
} = require("./run-temp-root.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) removeRunRoot(dirs.pop() as string);
});

function tmp() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-temp-root-"));
	dirs.push(dir);
	return dir;
}

describe("makeRunRoot", () => {
	it("names the kind and the owning pid", () => {
		const at = tmp();
		const root = makeRunRoot("vitest", { tmp: at, pid: 42 });
		expect(path.dirname(root)).toBe(at);
		expect(path.basename(root)).toMatch(/^wfc-vitest-42-\w{6}$/);
		expect(fs.statSync(root).isDirectory()).toBe(true);
	});
});

describe("removeRunRoot", () => {
	it("removes a fixture left without write or search permission", () => {
		const root = makeRunRoot("pytest", { tmp: tmp() });
		const locked = path.join(root, "a", "locked");
		fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
		fs.writeFileSync(path.join(locked, "inner", "f"), "x");
		fs.chmodSync(locked, 0o500);
		removeRunRoot(root);
		expect(fs.existsSync(root)).toBe(false);
	});
});

/* Above Linux's pid_max ceiling of 2^22, so no process holds it. */
const DEAD_PID = 999_999_999;

function staleRoot(dir: string, ageMs = STALE_MS + 1000) {
	fs.mkdirSync(path.join(dir, "fixture"), { recursive: true });
	const at = (Date.now() - ageMs) / 1000;
	fs.utimesSync(dir, at, at);
	return dir;
}

describe("sweepDeadRunRoots", () => {
	it("removes a dead pid's stale root, keeping a live one, a fresh one, the other kind's and any other name", () => {
		const at = tmp();
		const dead = staleRoot(path.join(at, "wfc-vitest-111-abcdef"));
		staleRoot(path.join(at, "wfc-vitest-222-abcdef"));
		staleRoot(path.join(at, "wfc-vitest-333-abcdef"), STALE_MS - 60_000);
		staleRoot(path.join(at, "wfc-pytest-111-abcdef"));
		staleRoot(path.join(at, "wfc-vitest-cache"));
		const removed = sweepDeadRunRoots("vitest", {
			tmp: at,
			alive: (pid: number) => pid === 222,
			err: { write: () => true },
		});
		expect(removed).toEqual([dead]);
		expect(fs.readdirSync(at).sort()).toEqual([
			"wfc-pytest-111-abcdef",
			"wfc-vitest-222-abcdef",
			"wfc-vitest-333-abcdef",
			"wfc-vitest-cache",
		]);
	});

	it("reads a temp dir that is not there as nothing to sweep", () => {
		expect(
			sweepDeadRunRoots("pytest", { tmp: path.join(tmp(), "gone") }),
		).toEqual([]);
	});

	it("removes a dead pid's root and keeps a live one when run-pytest.js starts", () => {
		const at = tmp();
		const dead = staleRoot(path.join(at, `wfc-pytest-${DEAD_PID}-abcdef`));
		const live = staleRoot(path.join(at, `wfc-pytest-${process.pid}-abcdef`));
		/* A path that is no test file: the wrapper runs no test, and returns
		 * in under a second. spawn-kept: the sweep sits in the entry, whose
		 * `main()` starts a pytest child an in-process call would outlive. */
		const r = spawnSync(
			process.execPath,
			[
				path.join(__dirname, "..", "run-pytest.js"),
				path.join(at, "test_none.py"),
			],
			{ env: { ...process.env, TMPDIR: at }, encoding: "utf8" },
		);
		/* The wrapper's exit for a path that holds no test; a crash would
		 * print `run-pytest:` with its stack. */
		expect(r.status).toBe(1);
		expect(r.stderr).not.toMatch(/run-pytest:|run-temp-root:/);
		expect(fs.existsSync(dead)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
	});

	it("removes a dead pid's root and keeps a live one when run-vitest.js starts", async () => {
		const at = tmp();
		const dead = staleRoot(path.join(at, `wfc-vitest-${DEAD_PID}-abcdef`));
		const live = staleRoot(path.join(at, `wfc-vitest-${process.pid}-abcdef`));
		const host = fs.mkdtempSync(path.join(at, "host-"));
		/* spawn-kept: the sweep sits in the entry, before a load hold that
		 * may wait on this machine's memory, so the child is killed once the
		 * sweep is seen. `--shared` and the stub bin as run-vitest.test.ts's
		 * real-child case takes them. */
		const child = spawn(
			process.execPath,
			[path.join(__dirname, "..", "run-vitest.js"), "--shared"],
			{
				env: {
					...process.env,
					TMPDIR: at,
					CLAUDE_PROJECT_DIR: host,
					WFC_RUN_VITEST_BIN: "/bin/true",
				},
				stdio: "ignore",
			},
		);
		const closed = new Promise((resolve) => child.on("close", resolve));
		try {
			await vi.waitFor(() => expect(fs.existsSync(dead)).toBe(false), {
				timeout: 30_000,
				interval: 50,
			});
		} finally {
			child.kill("SIGKILL");
			await closed;
		}
		expect(fs.existsSync(live)).toBe(true);
	});
});
