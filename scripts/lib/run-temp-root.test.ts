// @vitest-environment node
/*
 * Each run's private temp root (#5083): made under the real temp dir with its
 * owner's pid in the name, removed whole, and swept at a wrapper's start once
 * that pid is dead. Loosen a case and a killed run's fixtures stay in `/tmp`,
 * or a live run loses its root mid-run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
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

describe("sweepDeadRunRoots", () => {
	it("removes a dead pid's root, keeping a live one, the other kind's and any other name", () => {
		const at = tmp();
		const dead = path.join(at, "wfc-vitest-111-abcdef");
		const live = path.join(at, "wfc-vitest-222-abcdef");
		const pytest = path.join(at, "wfc-pytest-111-abcdef");
		const other = path.join(at, "wfc-vitest-cache");
		for (const dir of [dead, live, pytest, other])
			fs.mkdirSync(path.join(dir, "fixture"), { recursive: true });
		const err = { write: () => true };
		const removed = sweepDeadRunRoots("vitest", {
			tmp: at,
			alive: (pid: number) => pid === 222,
			err,
		});
		expect(removed).toEqual([dead]);
		expect(fs.readdirSync(at).sort()).toEqual([
			"wfc-pytest-111-abcdef",
			"wfc-vitest-222-abcdef",
			"wfc-vitest-cache",
		]);
	});

	it("reads a temp dir that is not there as nothing to sweep", () => {
		expect(
			sweepDeadRunRoots("pytest", { tmp: path.join(tmp(), "gone") }),
		).toEqual([]);
	});

	it("runs at run-pytest.js's start", () => {
		const at = tmp();
		const dead = path.join(at, "wfc-pytest-999999999-abcdef");
		const live = path.join(at, `wfc-pytest-${process.pid}-abcdef`);
		fs.mkdirSync(dead);
		fs.mkdirSync(live);
		/* A path that is no test file: the wrapper runs no test, and returns
		 * in under a second. spawn-kept: the sweep sits in the entry, whose
		 * `main()` starts a pytest child an in-process call would outlive. */
		spawnSync(
			process.execPath,
			[
				path.join(__dirname, "..", "run-pytest.js"),
				path.join(at, "test_none.py"),
			],
			{ env: { ...process.env, TMPDIR: at }, stdio: "ignore" },
		);
		expect(fs.existsSync(dead)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
	});
});
