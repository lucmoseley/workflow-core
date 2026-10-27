// @vitest-environment node
/*
 * Pins which pushed commits the pre-push check names as attested by no certificate,
 * per suite the range reaches, and that no finding of its refuses a push.
 *
 * The pre-push checker driven the way git drives it: ref lines on stdin,
 * warnings on stderr — over real repositories, since what it prints is the
 * composed attestation's verdict on a real range (#814). In process, but for three
 * spawns, each saying why where it stands.
 *
 * mantahostels#908 ruled the gate warns and never refuses, so every finding is a
 * WARN at exit 0, a missing or corrupt store included. Its own failure is
 * BROKEN at exit 2, printed, and the hook's `|| :` lets the push through
 * (#1444).
 *
 * It runs in `.husky/pre-push`: loosen a case and a push of commits no suite
 * was seen to pass goes unwarned, so a red sits on `main` until a sweep finds
 * it, or a broken store starts refusing pushes.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { storePath } from "./lib/test-pass-marker.js";

const SCRIPT = path.join(__dirname, "check-test-marker.js");
const HOOK = path.join(__dirname, "..", ".husky", "pre-push");
const ZERO = "0".repeat(40);

const dirs: string[] = [];

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/**
 * A repository with one published commit — `origin/main` at the root — whose
 * declared test command writes the marker (#740).
 */
function repo(test: string | null = "node scripts/run-vitest.js") {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "prepush-")),
	);
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude/workflow-core.json"),
		JSON.stringify(test === null ? {} : { commands: { test } }),
	);
	git(dir, "add", ".claude");
	git(dir, "commit", "-q", "-m", "root");
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
	return { dir, root: git(dir, "rev-parse", "HEAD") };
}

function commitTouching(dir: string, ...paths: string[]) {
	for (const rel of paths) {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), `${rel} ${Math.random()}\n`);
	}
	git(dir, "add", "--", ...paths);
	git(dir, "commit", "-q", "-m", "c");
	return git(dir, "rev-parse", "HEAD");
}

const writeStore = (dir: string, ...entries: unknown[]) =>
	fs.writeFileSync(
		storePath(dir),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);

const FULL_SCOPE = {
	modulesRun: 123,
	modulesTotal: 123,
	tests: 900,
	passed: 890,
	skipped: 10,
	failed: 0,
	nameFilter: null,
	fileFilters: [],
};

/* A still tree AND the whole suite, keyed to `sha`. */
const full = (sha: string, over: Record<string, unknown> = {}) => ({
	sha,
	at: "2026-08-21T08:00:00.000Z",
	dirtyAtStart: false,
	dirtyCount: 0,
	headMovedDuringRun: false,
	foreign: [],
	scope: FULL_SCOPE,
	...over,
});

/** An admissible narrowed certificate on `sha`, selected for `paths` and reading them alone. */
const narrowedOn = (dir: string, sha: string, paths: string[], at: string) =>
	full(sha, {
		at,
		scope: { ...FULL_SCOPE, modulesRun: 2, changed: "x", admissible: true },
		treeAtEnd: git(dir, "rev-parse", `${sha}^{tree}`),
		closure: paths,
		changedPaths: paths,
	});

/** A certificate from `vitest run <file> -t <name>`, which attests nothing. */
const partial = (sha: string) => ({
	...full(sha),
	scope: {
		...FULL_SCOPE,
		modulesRun: 1,
		nameFilter: "/ref/",
		fileFilters: ["scripts/check-test-marker.test.ts"],
	},
});

/**
 * git's own stdin format: `<local ref> <local sha> <remote ref> <remote sha>`.
 * The all-zero remote sha is a ref the remote does not have yet, so the range
 * runs from the merge-base with `origin/main`.
 */
const buildRefLine = (sha: string, remote: string = ZERO) =>
	`refs/heads/main ${sha} refs/heads/main ${remote}\n`;

const run = (
	cwd: string,
	stdin: string,
	env: Record<string, string | undefined> = {},
) =>
	runInProcess(SCRIPT, [], {
		cwd,
		stdin,
		env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
	});

const OWED = "LACK A VITEST CERTIFICATE";
const ATTESTED = "OK: certificates attest every pushed commit.\n";
const NOTHING = "OK: no pushed ref to judge.\n";

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("check-test-marker", () => {
	it("says BROKEN at exit 2 on a contract the reader refuses", () => {
		const { dir, root } = repo();
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			'{"contract":9}',
		);
		git(dir, "commit", "-q", "-am", "contract 9");
		const r = run(dir, buildRefLine(root), { WFC_MODULES: undefined });
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^BROKEN: .*declares contract 9/);
	});

	it("skips with one line, warning nothing, where the suites module is off", () => {
		const { dir, root } = repo();
		const r = run(dir, buildRefLine(root), { WFC_MODULES: undefined });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			'SKIP: module "suites" is off — .claude/workflow-core.json does not list it under "modules"\n',
		);
	});

	it.each(["node --test", "npm test"])(
		"skips with one line where the declared test command is %s, which writes no marker",
		(test) => {
			const { dir, root } = repo(test);
			const r = run(dir, buildRefLine(root));
			expect(r.status).toBe(0);
			expect(r.stderr).toBe(
				"SKIP: commands.test is gated at commit — it mints no certificate, so a push has none to read\n",
			);
		},
	);

	it("warns where no test command is declared", () => {
		const { dir } = repo(null);
		const sha = commitTouching(dir, "a.js");
		expect(run(dir, buildRefLine(sha)).stderr).toContain(OWED);
	});

	it("warns where the declared command is the npm script that runs run-vitest.js", () => {
		const { dir } = repo("npm run test");
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { test: "node scripts/run-vitest.js" } }),
		);
		git(dir, "add", "package.json");
		const sha = commitTouching(dir, "a.js");
		/* The check reads package.json at the pushed HEAD, not this copy (#3135). */
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { test: "jest" } }),
		);
		expect(run(dir, buildRefLine(sha)).stderr).toContain(OWED);
	});

	it("names each file no certificate attests and its commit, says they are public, and asks for a run and a push:check — exiting 0", () => {
		const { dir, root } = repo();
		const c1 = commitTouching(dir, "a.js");
		const c2 = commitTouching(dir, "b.js");
		writeStore(dir, narrowedOn(dir, c1, ["a.js"], "A"));
		const r = run(dir, buildRefLine(c2, root));
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(
			/⚠ {2}1 FILE\(S\) IN \S+ LACK A VITEST CERTIFICATE/,
		);
		expect(r.stderr).toContain(`b.js — commit ${c2.slice(0, 12)}`);
		expect(r.stderr).not.toContain("a.js —");
		expect(r.stderr).toContain("Those commits are already public.");
		expect(r.stderr).toContain("Run `npm run test` now, report any red");
		expect(r.stderr).toContain("push-check.js` before your next push");
		expect(r.stderr).not.toMatch(/push again/i);
		expect(r.stderr).toMatch(
			/WARN: 1 pushed commit\(s\) no certificate is shown to attest\n$/,
		);
	});

	it("passes where two sessions' certificates attest the range between them, noting the tree match", () => {
		const { dir, root } = repo();
		const c1 = commitTouching(dir, "a.js");
		const c2 = commitTouching(dir, "b.js");
		writeStore(
			dir,
			narrowedOn(dir, c1, ["a.js"], "A"),
			narrowedOn(dir, c2, ["b.js"], "B"),
		);
		const r = run(dir, buildRefLine(c2, root));
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("attested by tree");
		expect(r.stderr).not.toContain("CERTIFICATE:");
		expect(r.stderr.endsWith(ATTESTED)).toBe(true);
	});

	it("skips with the lander's line, warning nothing, where the landing module is on (#2929)", () => {
		const { dir } = repo();
		const c1 = commitTouching(dir, "a.js");
		const r = run(dir, buildRefLine(c1), { WFC_MODULES: "suites,landing" });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			'SKIP: module "landing" is on — the lander runs the full suite before main moves, so no push owes a certificate\n',
		);
	});

	it("says only OK on a clean full certificate on the pushed sha", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, "a.js");
		writeStore(dir, full(sha));
		const r = run(dir, buildRefLine(sha, root));
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(ATTESTED);
		expect(r.stdout).toBe("");
	});

	/* The dirty line qualifies the attestation, as push-check.js reads it, and is no
	 * finding. */
	it("notes a certificate taken over a dirty tree, naming the foreign count, and passes", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, "a.js");
		writeStore(
			dir,
			full(sha, {
				dirtyAtStart: true,
				dirtyCount: 2,
				foreign: [{ path: "docs/doc-map.md", why: "held by sess-9" }],
			}),
		);
		const r = run(dir, buildRefLine(sha, root));
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("dirty tree:");
		expect(r.stderr).toContain("read 1 file(s) another session held");
		expect(r.stderr.endsWith(ATTESTED)).toBe(true);
	});

	it("counts a filtered certificate toward nothing", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, "a.js");
		writeStore(dir, partial(sha));
		expect(run(dir, buildRefLine(sha, root)).stderr).toContain(OWED);
	});

	it("judges no commit on a branch deletion — an all-zero sha has no bytes to test", () => {
		const { dir, root } = repo();
		const r = run(dir, `refs/heads/gone ${ZERO} refs/heads/gone ${root}\n`);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(NOTHING);
	});

	it("warns once per sha when git feeds several refs, including a repeat", () => {
		const { dir, root } = repo();
		const c1 = commitTouching(dir, "a.js");
		const c2 = commitTouching(dir, "b.js");
		const r = run(
			dir,
			buildRefLine(c1, root) + buildRefLine(c1, root) + buildRefLine(c2, root),
		);
		expect(r.status).toBe(0);
		expect(r.stderr.match(new RegExp(OWED, "g"))).toHaveLength(2);
	});

	it("judges no commit on empty stdin", () => {
		const r = run(repo().dir, "");
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(NOTHING);
	});

	/* A spawn, for a real fd 0 the read fails on: a directory, which the
	 * in-process runner's string stdin cannot stand in for. */
	it("says BROKEN, not OK, when stdin cannot be read (#1444)", () => {
		const { dir } = repo();
		const fd = fs.openSync(dir, "r");
		try {
			const r = spawnSync(process.execPath, [SCRIPT], {
				cwd: dir,
				stdio: [fd, "pipe", "pipe"],
				encoding: "utf8",
				env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
			});
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(
				/^BROKEN: could not read the pushed refs on stdin: EISDIR/,
			);
		} finally {
			fs.closeSync(fd);
		}
	});

	it("treats a corrupt store as no marker rather than as a failure", () => {
		const { dir, root } = repo();
		const sha = commitTouching(dir, "a.js");
		fs.writeFileSync(storePath(dir), "{not json\n");
		const r = run(dir, buildRefLine(sha, root));
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(OWED);
	});

	it("exits 0 outside a git repository, where there is no store to find", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
		dirs.push(dir);
		const r = run(dir, buildRefLine("a".repeat(40)));
		expect(r.status).toBe(0);
	});

	it("says it could not judge where the remote sha is one this checkout lacks", () => {
		const { dir } = repo();
		const sha = commitTouching(dir, "a.js");
		const r = run(dir, buildRefLine(sha, "c".repeat(40)));
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("could not judge whether certificates attest");
		expect(r.stderr).toContain("never refuses a push");
	});

	/*
	 * A SPAWN, KEPT FOR A REAL FD: the in-process runner captures writes before
	 * any pipe sees them. node drops what is still buffered on a pipe at
	 * process.exit, and 64 KiB is the pipe buffer. An owed reading lists 20
	 * files at most and costs several git calls, so the report is built from
	 * the cheapest one: 450 refs this checkout lacks, ~150 bytes each.
	 */
	it("prints a report longer than the pipe buffer whole, summary included (#1444)", () => {
		const { dir } = repo();
		const refs = Array.from({ length: 450 }, (_, i) =>
			buildRefLine((i + 1).toString(16).padStart(40, "0"), "c".repeat(40)),
		).join("");
		const r = spawnSync(process.execPath, [SCRIPT], {
			cwd: dir,
			input: refs,
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
		});
		expect(r.status).toBe(0);
		expect(r.stderr.length).toBeGreaterThan(64 * 1024);
		expect(r.stderr).toMatch(
			/\nWARN: 450 pushed commit\(s\) no certificate is shown to attest\n$/,
		);
	});

	/*
	 * A spawn, the hook being a shell script. Both checkers are stubs under the
	 * repository's own root, where the hook resolves them.
	 */
	it("lets the push through when the checker exits BROKEN (#1444)", () => {
		const { dir, root } = repo();
		fs.mkdirSync(path.join(dir, "scripts"));
		const ran = path.join(dir, "checker-ran");
		const stub = (code: number, touch = "") =>
			`const fs = require("node:fs"); fs.readFileSync(0);${touch} process.exit(${code});\n`;
		fs.writeFileSync(
			path.join(dir, "scripts/check-test-marker.js"),
			stub(2, ` fs.writeFileSync(${JSON.stringify(ran)}, "");`),
		);
		fs.writeFileSync(path.join(dir, "scripts/run-mod-tests.js"), stub(0));
		const r = spawnSync("sh", [HOOK], {
			cwd: dir,
			input: buildRefLine(root),
			encoding: "utf8",
		});
		expect(fs.existsSync(ran)).toBe(true);
		expect(r.status).toBe(0);
	});

	/*
	 * Each suite answers for itself (mantahostels#1256), and a suite covering part of the
	 * repo is asked only about a push that could have broken it. vitest carries
	 * no such pattern and always answers.
	 */
	describe("the suites the range reaches", () => {
		it("says nothing about pytest where the range touches no Python", () => {
			const { dir, root } = repo();
			const sha = commitTouching(dir, "docs/note.md");
			const r = run(dir, buildRefLine(sha, root));
			expect(r.stderr).toContain(OWED);
			expect(r.stderr).not.toContain("PYTEST");
		});

		it.each([
			"scripts/measure/test_thing.py",
			"pytest.ini",
			"requirements-dev.txt",
			"scripts/run-pytest.js",
		])(
			"asks about pytest where the range touches %s, whatever vitest's certificates attest",
			(rel) => {
				const { dir, root } = repo();
				const sha = commitTouching(dir, rel);
				writeStore(dir, full(sha));
				const r = run(dir, buildRefLine(sha, root));
				expect(r.stderr).toContain("LACK A PYTEST CERTIFICATE");
				expect(r.stderr).toContain("npm run test:py");
				expect(r.stderr).not.toContain(OWED);
			},
		);

		it("asks about vitest where only pytest left a certificate", () => {
			const { dir, root } = repo();
			const sha = commitTouching(dir, "scripts/test_x.py");
			writeStore(dir, { ...full(sha), suite: "pytest" });
			const r = run(dir, buildRefLine(sha, root));
			expect(r.stderr).toContain(OWED);
			expect(r.stderr).not.toContain("LACK A PYTEST CERTIFICATE");
		});

		/* mantahostels#2170: `package.json` came out of `touches`. */
		it("says nothing about pytest where the range touches only package.json", () => {
			const { dir, root } = repo();
			const sha = commitTouching(dir, "package.json");
			const r = run(dir, buildRefLine(sha, root));
			expect(r.stderr).toContain(OWED);
			expect(r.stderr).not.toContain("PYTEST");
		});
	});
});
