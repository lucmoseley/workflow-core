// @vitest-environment node
/*
 * Pins which test-to-document read edges the manifest records, that it renders
 * stably, and that `--check` judges the index a commit carries and fails on any
 * edge gained or lost (mantahostels#2031, #557, mantahostels#2270).
 *
 * The generator needs a real `git ls-files`, so the fixture is a throwaway
 * repo rather than a stubbed tree.
 *
 * --check is the pre-commit gate. Its false pass is the expensive one: it ships
 * a manifest that omits a reader, and the omitted test then sits unrun behind a
 * filtered certificate that looks identical to a real one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "generate-test-read-edges.js");
const OUT = ["docs", "test-read-edges.json"].join("/");
const DOC = ["docs", "thing.md"].join("/");
const DOC2 = ["docs", "other.md"].join("/");

let dir: string;

const write = (file: string, body: string) => {
	fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), body);
};

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const run = (...args: string[]) =>
	execFileSync("node", [SCRIPT, "--root", dir, ...args], {
		cwd: dir,
		encoding: "utf8",
	});

const runFailing = (...args: string[]) => {
	try {
		run(...args);
		return { status: 0, stderr: "" };
	} catch (e) {
		const err = e as { status: number; stderr: string };
		return { status: err.status, stderr: err.stderr };
	}
};

const readManifest = () =>
	JSON.parse(fs.readFileSync(path.join(dir, OUT), "utf8")).edges;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-edges-"));
	git("init", "-q");
	// A repo-local identity, matching initGitRepo (scripts/lib/git-fixture.ts):
	// a runner with no global user.name fails every commit below with
	// "empty ident name" (mantahostels#2310).
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	write(DOC, "a tracked document\n");
	write("scripts/reader.test.ts", `process.cwd(); read("${DOC}");`);
	write("scripts/fixture.test.ts", `tmpdir(); write("${DOC}");`);
	git("add", "-A");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("generate-test-read-edges.js", () => {
	it("writes the manifest, listing the anchored reader and not the fixture", () => {
		run();
		expect(readManifest()[DOC]).toEqual(["scripts/reader.test.ts"]);
	});

	it("reports the counts it rendered, so a silent empty render is visible", () => {
		expect(run()).toMatch(/1 file\(s\) read by 1 of 2 test file\(s\)/);
	});

	it("renders byte-identically twice, so the gate never fires on order alone", () => {
		run();
		const first = fs.readFileSync(path.join(dir, OUT), "utf8");
		run();
		expect(fs.readFileSync(path.join(dir, OUT), "utf8")).toBe(first);
	});

	it("--check passes on a fresh manifest", () => {
		run();
		git("add", "-A");
		expect(runFailing("--check").status).toBe(0);
	});

	it("--check fails, naming the document, once a new test reads it", () => {
		run();
		write("scripts/late.test.ts", `process.cwd(); read("${DOC}");`);
		git("add", "-A");
		const { status, stderr } = runFailing("--check");
		expect(status).toBe(1);
		expect(stderr).toContain(`${DOC}: 1 -> 2 reader(s)`);
		expect(stderr).toContain("npm run gen:test-read-edges");
	});

	it("--check fails when a reader stops reading, so a stale edge is caught too, naming the document and its reader count", () => {
		run();
		write("scripts/reader.test.ts", "process.cwd(); // reads nothing now\n");
		git("add", "-A");
		const { status, stderr } = runFailing("--check");
		expect(status).toBe(1);
		expect(stderr).toContain(`${DOC}: 1 -> 0 reader(s)`);
	});

	it("--check fails rather than passing when the manifest is absent", () => {
		expect(runFailing("--check").status).toBe(1);
	});

	it("--check leaves the manifest alone, so the gate is never a writer", () => {
		run();
		write("scripts/late.test.ts", `process.cwd(); read("${DOC}");`);
		git("add", "-A");
		const before = fs.readFileSync(path.join(dir, OUT), "utf8");
		runFailing("--check");
		expect(fs.readFileSync(path.join(dir, OUT), "utf8")).toBe(before);
	});

	it("ignores an untracked test file, matching what a commit can carry", () => {
		write("scripts/untracked.test.ts", `process.cwd(); read("${DOC}");`);
		run();
		expect(readManifest()[DOC]).toEqual(["scripts/reader.test.ts"]);
	});

	const spawn = () =>
		spawnSync("node", [SCRIPT, "--root", dir], { cwd: dir, encoding: "utf8" });

	it("warns on stderr, naming the uncommitted file, but still writes, when an over-populating edit is uncommitted (mantahostels#2270)", () => {
		write(DOC2, "a second tracked document\n");
		run();
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
		write(
			"scripts/reader.test.ts",
			`process.cwd(); read("${DOC}"); read("${DOC2}"); // now reads a second document\n`,
		);
		const result = spawn();
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("uncommitted");
		expect(result.stderr).toContain("scripts/reader.test.ts");
		expect(readManifest()[DOC2]).toEqual(["scripts/reader.test.ts"]);
	});

	it("warns when a dirty edit removes a read literal, naming the file, and still writes the manifest without the edge", () => {
		run();
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
		write("scripts/reader.test.ts", "process.cwd(); // reads nothing now\n");
		const result = spawn();
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("uncommitted");
		expect(result.stderr).toContain("scripts/reader.test.ts");
		expect(readManifest()[DOC]).toBeUndefined();
	});

	it("warns when a dirty one-hop helper is what a test actually read, naming the helper", () => {
		write("scripts/lib/helper.ts", `process.cwd(); read("${DOC}");`);
		write(
			"scripts/reader.test.ts",
			`process.cwd(); require("./lib/helper.ts");`,
		);
		run();
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
		write(
			"scripts/lib/helper.ts",
			`process.cwd(); read("${DOC}"); // edited\n`,
		);
		const result = spawn();
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("scripts/lib/helper.ts");
	});

	it("stays silent when nothing this render read is uncommitted", () => {
		run();
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
		write("docs/unrelated.md", "not read by anything");
		git("add", "-A");
		git("commit", "-q", "-m", "unrelated, committed");
		write("docs/unrelated.md", "edited, but never read by any test");
		const result = spawn();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});

/* A tracked test file missing from disk: a neighbour's `git rm` in flight, or a
 * cut's deletions before its commit (#557). */
describe("a tracked test file missing from disk (#557)", () => {
	const goneTest = "scripts/gone.test.ts";

	beforeEach(() => {
		write(goneTest, `process.cwd(); read("${DOC2}");`);
		write(DOC2, "a second tracked document\n");
		git("add", "-A");
		run();
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
	});

	it("renders from the working tree without it, carrying none of its edges", () => {
		expect(readManifest()[DOC2]).toEqual([goneTest]);
		fs.rmSync(path.join(dir, goneTest));
		expect(run()).toMatch(/read by 1 of 2 test file\(s\)/);
		expect(readManifest()[DOC2]).toBeUndefined();
		expect(readManifest()[DOC]).toEqual(["scripts/reader.test.ts"]);
	});

	/* The gate reads the index, so a test the index still holds keeps its edges
	 * and a neighbour's deletion never reaches this commit's verdict. */
	describe("the pre-commit --check on a pathspec commit", () => {
		beforeEach(() => {
			write(".hooks/pre-commit", `#!/bin/sh\nexec node "${SCRIPT}" --check\n`);
			fs.chmodSync(path.join(dir, ".hooks/pre-commit"), 0o755);
			git("config", "core.hooksPath", ".hooks");
			git("rm", "-q", goneTest);
		});

		/* A real commit, because git's temporary pathspec index — HEAD plus the
		 * named paths — exists only inside one; no fixture can stage it. */
		const commit = (...paths: string[]) =>
			spawnSync("git", ["commit", "-q", "-m", "x", "--", ...paths], {
				cwd: dir,
				encoding: "utf8",
			});

		it("passes where the commit changes no reader set", () => {
			write("scripts/fixture.test.ts", `tmpdir(); write("${DOC}"); // edited`);
			const r = commit("scripts/fixture.test.ts");
			expect(r.stderr).not.toContain("ENOENT");
			expect(r.status).toBe(0);
		});

		it("fails on staleness, never ENOENT, where the commit adds a reader, naming the document and its reader counts", () => {
			write("scripts/late.test.ts", `process.cwd(); read("${DOC}");`);
			git("add", "scripts/late.test.ts");
			const r = commit("scripts/late.test.ts");
			expect(r.stderr).not.toContain("ENOENT");
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain(`${DOC}: 1 -> 2 reader(s)`);
		});

		/* The plain write renders the disk, which has lost `goneTest` while this
		 * commit still carries it, so following that advice never converged. */
		it("names a regenerate that converges, and the commit then lands", () => {
			write("scripts/late.test.ts", `process.cwd(); read("${DOC}");`);
			git("add", "scripts/late.test.ts");
			run();
			const refused = commit("scripts/late.test.ts", OUT);
			expect(refused.status).not.toBe(0);
			const named = /--only (.+)\n/.exec(refused.stderr)?.[1].split(" ");
			expect(named).toEqual(["scripts/late.test.ts", OUT]);
			run("--only", ...(named ?? []));
			expect(commit("scripts/late.test.ts", OUT).status).toBe(0);
			expect(readManifest()[DOC2]).toEqual([goneTest]);
		});

		it("names the plain regenerate where the disk renders as the commit does", () => {
			write("scripts/late.test.ts", `process.cwd(); read("${DOC}");`);
			git("add", "scripts/late.test.ts");
			git(
				"commit",
				"-q",
				"--no-verify",
				"-m",
				"neighbour lands",
				"--",
				goneTest,
			);
			const r = commit("scripts/late.test.ts");
			expect(r.stderr).toContain("npm run gen:test-read-edges\n");
			expect(r.stderr).not.toContain("--only");
		});
	});
});

describe("--check reads the index, the tree the commit carries (#557)", () => {
	it("passes over an unstaged edit on disk that would stale the manifest", () => {
		run();
		git("add", "-A");
		write("scripts/reader.test.ts", "process.cwd(); // reads nothing now\n");
		expect(runFailing("--check").status).toBe(0);
	});

	it("fails where the regenerated manifest sits on disk unstaged, naming the document and its reader count", () => {
		run();
		git("add", "-A");
		write("scripts/late.test.ts", `process.cwd(); read("${DOC}");`);
		git("add", "scripts/late.test.ts");
		run();
		const { status, stderr } = runFailing("--check");
		expect(status).toBe(1);
		expect(stderr).toContain(`${DOC}: 1 -> 2 reader(s)`);
	});
});

describe("the unseen-read warning and listing (#1881)", () => {
	const unseenTest = "scripts/unseen.test.ts";
	const body =
		'const ROOT = process.cwd();\nfs.readFileSync(path.join(ROOT, "docs", name));\n';
	const site = `${unseenTest}:2: a path segment held in \`name\``;
	const usage = "usage: node scripts/generate-test-read-edges.js";

	const check = () =>
		runInProcess(SCRIPT, ["--root", dir, "--check"], { cwd: dir });
	const list = () =>
		runInProcess(SCRIPT, ["--root", dir, "--unseen"], { cwd: dir });

	const stageOver = (file: string, text: string) => {
		run();
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
		write(file, text);
		run();
		git("add", "-A");
	};

	it("warns at --check about a test the commit adds, naming file, line, shape and both ways out, and passes", () => {
		write(unseenTest, body);
		run();
		git("add", "-A");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(site);
		expect(r.stderr).toContain("Name the path as a literal");
		expect(r.stderr).toContain("full-sweep-only:");
	});

	it("warns at --check about a test the commit changes", () => {
		write(unseenTest, "process.cwd();\n");
		stageOver(unseenTest, body);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(site);
	});

	it("stays silent at --check on an unseen read in a test the commit leaves untouched", () => {
		write(unseenTest, body);
		stageOver("scripts/other.test.ts", "process.cwd();\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain(unseenTest);
	});

	it("refuses on staleness alone, the warning riding beside it", () => {
		run();
		git("add", "-A");
		write(unseenTest, `${body}read("${DOC}");\n`);
		git("add", unseenTest);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(site);
		expect(r.stderr).toContain(`${DOC}: 1 -> 2 reader(s)`);
	});

	it("--unseen lists every site in the tree, a committed untouched test's included, writing nothing and exiting 0", () => {
		write(unseenTest, body);
		git("add", "-A");
		git("commit", "-q", "-m", "initial");
		const r = list();
		expect(r.status).toBe(0);
		const out = r.stdout;
		expect(out).toContain(site);
		expect(out).toContain("1 read(s) the diff selector cannot attribute.");
		expect(fs.existsSync(path.join(dir, OUT))).toBe(false);
	});

	it("--unseen refuses --check beside it, rather than silently dropping one", () => {
		const r = runInProcess(SCRIPT, ["--root", dir, "--unseen", "--check"], {
			cwd: dir,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"--unseen lists the working tree and takes neither --check nor --only",
		);
		expect(r.stderr).toContain(usage);
		expect(r.stdout).toBe("");
	});

	it("exits 1, never cli-args' 2, on an unknown flag and on a path without --only (base §N3)", () => {
		const unknown = runInProcess(SCRIPT, ["--root", dir, "--bogus"], {
			cwd: dir,
		});
		expect(unknown.status).toBe(1);
		expect(unknown.stderr).toContain("--bogus");
		expect(unknown.stderr).toContain(usage);
		const bare = runInProcess(SCRIPT, ["--root", dir, "a.test.ts"], {
			cwd: dir,
		});
		expect(bare.status).toBe(1);
		expect(bare.stderr).toContain("paths need --only");
		expect(bare.stderr).toContain(usage);
	});

	it("--unseen lists nothing once the test's header says full-sweep-only", () => {
		write(
			unseenTest,
			`// full-sweep-only: names its documents at runtime.\n${body}`,
		);
		git("add", "-A");
		const r = list();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("0 read(s) the diff selector cannot attribute.\n");
	});
});

describe("the pre-commit gate's arming (#2545)", () => {
	it("arms on every test file vitest collects", () => {
		const hook = fs.readFileSync(
			path.resolve(__dirname, "..", ".husky", "pre-commit"),
			"utf8",
		);
		const { JS_TEST_FILE } = createRequire(import.meta.url)(
			"./lib/test-kind.js",
		);
		const arm = hook.match(
			/^if armed '([^']*)'; then\n\s*node \S*generate-test-read-edges\.js --check/m,
		)?.[1];
		// grep's ERE has no non-capturing group.
		expect(arm?.split("|^")[0]).toBe(
			JS_TEST_FILE.source.replaceAll("(?:", "("),
		);
	});
});
