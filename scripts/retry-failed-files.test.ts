// @vitest-environment node
/*
 * retry-failed-files.js end to end (#4545): it re-runs once the files a
 * Vitest report marks failed and names, last, the files it cleared and the
 * files still failing, which lib/actions-tester.js takes as the batch's
 * flakes (#4558) and failing files.
 *
 * Each case runs the program in a throwaway directory whose `npm test` is a
 * stub that fails the files `STUB_FAIL` names and writes its own report, so
 * no real suite runs. Loosen it and a flake the retry cleared can still be
 * blamed on a batch member, or a real failure it did not clear can be read
 * as cleared, and the lander lands a red tree.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "retry-failed-files.js");

let dir: string | null = null;
afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	dir = null;
});

const STUB = `const fs = require("node:fs");
const path = require("node:path");
const files = process.argv.slice(2);
const failing = (process.env.STUB_FAIL ?? "").split(",").filter(Boolean);
fs.appendFileSync("ran.log", files.join(" ") + "\\n");
const out = process.env.WFC_VITEST_JSON;
if (out) fs.writeFileSync(out, JSON.stringify({ testResults: files.map((f) => ({
	name: path.resolve(f), status: failing.includes(f) ? "failed" : "passed" })) }));
if (process.env.STUB_EXIT) process.exit(Number(process.env.STUB_EXIT));
process.exit(files.some((f) => failing.includes(f)) ? 1 : 0);
`;

/** A directory whose first report marks `failed` failed, named under `under`. */
function repo(failed: string[], under = ""): { root: string; report: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "retry-failed-"));
	dir = root;
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ scripts: { test: "node stub.js" } }),
	);
	fs.writeFileSync(path.join(root, "stub.js"), STUB);
	const report = path.join(root, "vitest-1.json");
	fs.writeFileSync(
		report,
		JSON.stringify({
			testResults: [
				...failed.map((f) => ({
					name: path.join(root, under, f),
					status: "failed",
				})),
				{ name: path.join(root, "ok.test.ts"), status: "passed" },
			],
		}),
	);
	return { root, report };
}

const run = (root: string, report: string, stubFail = "", stubExit = "") =>
	runInProcess(SCRIPT, [report], {
		cwd: root,
		env: {
			...process.env,
			STUB_FAIL: stubFail,
			STUB_EXIT: stubExit,
			WFC_VITEST_JSON: "",
		},
	});

it("re-runs only the failed files once, exiting 0 and naming none still failing where they pass", () => {
	const { root, report } = repo(["a.test.ts", "b.test.ts"]);
	const r = run(root, report);
	expect(r.status).toBe(0);
	expect(fs.readFileSync(path.join(root, "ran.log"), "utf8")).toBe(
		"a.test.ts b.test.ts\n",
	);
	expect(r.stdout).toContain(
		"retry-failed-files: cleared by one retry: a.test.ts, b.test.ts\nretry-failed-files: still failing after one retry: none",
	);
});

it("names only the files the retry failed again, exiting with the re-run's code", () => {
	const { root, report } = repo(["a.test.ts", "b.test.ts"]);
	const r = run(root, report, "b.test.ts");
	expect(r.status).toBe(1);
	expect(r.stdout).toContain(
		"retry-failed-files: cleared by one retry: a.test.ts\nretry-failed-files: still failing after one retry: b.test.ts",
	);
	expect(JSON.parse(fs.readFileSync(report, "utf8")).testResults).toHaveLength(
		3,
	);
});

it("re-runs a file an isolated worktree's report names by its path in this checkout (#4560)", () => {
	const { root, report } = repo(["a.test.ts"], ".claude/worktrees/isolated-7");
	fs.writeFileSync(path.join(root, "a.test.ts"), "");
	const r = run(root, report);
	expect(fs.readFileSync(path.join(root, "ran.log"), "utf8")).toBe(
		"a.test.ts\n",
	);
	expect(r.status).toBe(0);
});

it("names the first run's files still failing where the re-run fails naming no failure (#4560)", () => {
	const { root, report } = repo(["a.test.ts"]);
	const r = run(root, report, "", "1");
	expect(r.status).toBe(1);
	expect(r.stdout).toContain(
		"retry-failed-files: still failing after one retry: a.test.ts",
	);
});

it("re-runs nothing where the report marks no file failed, saying so", () => {
	const { root, report } = repo([]);
	const r = run(root, report);
	expect(r.status).toBe(1);
	expect(r.stderr).toContain(
		"the report marks no file failed: nothing to re-run",
	);
	expect(fs.existsSync(path.join(root, "ran.log"))).toBe(false);
});

it("re-runs nothing where no report exists, naming the path", () => {
	const { root } = repo([]);
	const r = run(root, path.join(root, "absent.json"));
	expect(r.status).toBe(1);
	expect(r.stderr).toContain(`no report at ${path.join(root, "absent.json")}`);
});

it("refuses a missing report argument, printing its usage", () => {
	const { root } = repo([]);
	const r = runInProcess(SCRIPT, [], { cwd: root });
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(
		"usage: node scripts/retry-failed-files.js <report.json>",
	);
});
