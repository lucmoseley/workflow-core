// @vitest-environment node
/*
 * check-husky-shim.js reports, from any worktree, a canonical checkout whose
 * husky shim has lost #3138's own-tree lookup, and names the rerun that
 * restores it (#3172).
 *
 * The shim is the real one: husky writes it, as `npm install` does, and
 * scripts/install-hooks.js patches it, as `prepare` does — both spawned.
 *
 * Loosen it and a stock shim sends every worktree's commit and push back to
 * the shared checkout's hook copy with nothing said (#3125).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo } from "./lib/git-fixture";

const { runInProcess } = require("./lib/run-in-process.js");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(__dirname, "check-husky-shim.js");
const HUSKY = path.join(ROOT, "node_modules", "husky", "bin.js");
const INSTALL = path.join(__dirname, "install-hooks.js");

let tmp: string;
let shared: string;
let wt: string;

const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env };
	delete e.HUSKY;
	return e;
};
const husky = () =>
	execFileSync(process.execPath, [HUSKY], { cwd: shared, env: env() });
const install = () =>
	execFileSync(process.execPath, [INSTALL], { cwd: wt, env: env() });
const check = () => runInProcess(SCRIPT, [], { cwd: wt, env: env() });
const shim = () => path.join(shared, ".husky", "_", "h");

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-husky-shim-"));
	shared = path.join(tmp, "shared");
	wt = path.join(tmp, "wt");
	initGitRepo(shared, "/dev/null");
	execFileSync("git", ["worktree", "add", "-q", "--detach", wt], {
		cwd: shared,
	});
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("check-husky-shim.js (#3172)", () => {
	it("passes a shim install-hooks.js patched", () => {
		husky();
		install();
		const r = check();
		expect(r.stderr).toContain("OK:");
		expect(r.status).toBe(0);
	});

	it("fails a shim husky put back to stock, naming install-hooks.js, and passes once it reruns", () => {
		husky();
		install();
		husky();
		const r = check();
		expect(r.stderr).toContain("STOCK-SHIM");
		expect(r.stderr).toContain(shim());
		expect(r.stderr).toContain("husky's stock shim");
		expect(r.stderr).toContain("node scripts/install-hooks.js");
		expect(r.status).toBe(1);

		install();
		expect(check().status).toBe(0);
	});

	it("fails a shim carrying neither lookup, naming the constant to update", () => {
		husky();
		fs.writeFileSync(shim(), '#!/usr/bin/env sh\nsh -e "$0.hook"\n');
		const r = check();
		expect(r.stderr).toContain("UNKNOWN-SHIM");
		expect(r.stderr).toContain(shim());
		expect(r.stderr).toContain("HUSKY_LOOKUP");
		expect(r.status).toBe(1);
	});

	it("skips where husky wrote no shim", () => {
		const r = check();
		expect(r.stderr).toContain("SKIP:");
		expect(r.status).toBe(0);
	});
});
