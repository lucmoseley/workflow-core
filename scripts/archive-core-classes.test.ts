// @vitest-environment node
/*
 * The manual-sync archive folders in a fresh adopter (#428): `init` writes no
 * key for either, and the first file landing under one is covered by the
 * core's own CORE_CLASSES. Run inside an `init`-built throwaway repo because
 * the checkers read scope from `git ls-files` and the class from the adopter's
 * sidecar; this repo's own tree carries no archive file to exercise. A
 * loosened case here lets an adopter's first sync report go red on coverage.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const CORE = path.resolve(__dirname, "..");
const script = (name: string) => path.join(__dirname, name);

let dir: string;
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-core-classes-"));
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Archive Fixture");
	const init = runInProcess(
		script("init-adopter.js"),
		[
			"--root",
			dir,
			"--plugin-root",
			CORE,
			"--no-plugin-install",
			"--no-tracker",
			"--founder",
			"A Founder",
			"--modules",
			"governance,roadmap",
		],
		{ cwd: dir, env: process.env },
	);
	if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
	git("add", "-A");
	git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "skeleton");
}, 60_000);

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(name: string, ...args: string[]) {
	const r = runInProcess(script(name), args, {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/* Past the pairing grace window, so an uncovered file would FAIL rather than
 * WARN. */
function land(rel: string, body: string) {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
	git("add", "--", rel);
	execFileSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "land", "--", rel],
		{
			cwd: dir,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
				GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
			},
		},
	);
}

const REPORT = "docs/archive/sync-reports/2026-09-26.md";
const PROPOSAL = "docs/archive/sync-proposals/2026-09-26.md";

describe("the manual-sync archive in a fresh adopter", () => {
	it("starts with neither folder and no key for either", () => {
		expect(fs.existsSync(path.join(dir, "docs/archive"))).toBe(false);
		const classes = fs.readFileSync(
			path.join(dir, "docs/doc-map-classes.json"),
			"utf8",
		);
		expect(classes).not.toContain("docs/archive");
	});

	it.each([REPORT, PROPOSAL])("covers the first file under %s", (rel) => {
		land(rel, "# Sync report\n\nThe manual said 40% on this date.\n");
		const map = run("check-doc-map.js");
		expect(map.out).not.toContain("have no doc-map register entry");
		expect(map.status).toBe(0);
		const values = run("check-superseded-values.js");
		expect(values.status).toBe(0);
	});

	it("still refuses a file elsewhere under docs/archive, naming it and register-doc.js as the way out", () => {
		land("docs/archive/other/2026-09-26.md", "# Other\n");
		const map = run("check-doc-map.js");
		expect(map.out).toContain("have no doc-map register entry");
		expect(map.out).toContain("docs/archive/other/2026-09-26.md");
		expect(map.out).toContain("register-doc.js");
		expect(map.status).toBe(1);
	});
});
