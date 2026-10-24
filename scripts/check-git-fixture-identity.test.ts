// @vitest-environment node
/*
 * Pins that check-git-fixture-identity.js fails a repo a test both raw-inits
 * and raw-commits without a full local identity, keyed per repo variable, and
 * passes every identitied, init-only or exempt shape.
 *
 * check-git-fixture-identity.js reads call sites, so a throwaway git repo
 * holding one test file is the whole fixture. mantahostels#2310 is the regression this
 * checker exists to catch (mantahostels#2355): a raw git commit with no local identity,
 * green on a developer machine's global identity and red on a runner with
 * none.
 *
 * git-identity-exempt: this file's own fixture strings quote raw `git(...,
 * "init"/"commit", ...)` calls as TEXT, for the checker under test to read —
 * to the lexical scan itself those read exactly like real call sites, since a
 * string literal and real code are indistinguishable without a parser (mantahostels#2355's
 * spec review, F2). Genuinely committing here is via the real beforeEach/`git`
 * helper above, which sets identity.
 *
 * It is a hard gate in .husky/pre-commit and a step in roadmap-digest.yml:
 * loosen a case and an identity-less fixture lands green on a developer
 * machine, to go red on the first CI runner with no global identity.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-git-fixture-identity.js");

let dir: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** Track `rel` with `body`, creating its directory. */
const track = (rel: string, body: string) => {
	fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
	git("add", "--", rel);
};

const run = (...args: string[]) => {
	// Off, not inherited: a real Actions run sets it globally, and this
	// suite runs inside one — runCheck's ::error:: annotation, added off
	// this flag, would otherwise leak into `out` (mantahostels#2427).
	const r = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: { ...process.env, GITHUB_ACTIONS: "" },
	});
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		json: () => JSON.parse(r.stdout),
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-fixture-identity-"));
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a test file that raw-inits and raw-commits one repo (mantahostels#2310's shape)", () => {
	it("fails when the repo gets no identity, and names the fix", () => {
		track(
			"scripts/fixture-x.test.ts",
			'git("init", "-q");\ngit("commit", "-qm", "seed");\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/fixture-x.test.ts");
		expect(r.out).toContain("no identity");
		expect(r.out).toContain("git-identity-exempt:");
		expect(r.out).toContain('git(<repo>, "config", "user.email"');
	});

	it("still fails on user.email alone — git also needs user.name (mantahostels#2355's spec review, F1)", () => {
		track(
			"scripts/fixture-x.test.ts",
			'git("init", "-q");\n' +
				'git("config", "user.email", "test@example.com");\n' +
				'git("commit", "-qm", "seed");\n',
		);
		const r = run();
		expect(r.status).toBe(1);
	});

	it("passes when the repo gets a config user.email/user.name pair", () => {
		track(
			"scripts/fixture-x.test.ts",
			'git("init", "-q");\n' +
				'git("config", "user.email", "test@example.com");\n' +
				'git("config", "user.name", "test");\n' +
				'git("commit", "-qm", "seed");\n',
		);
		const r = run();
		expect(r.status).toBe(0);
	});

	it("passes when identity is set with the inline -c form", () => {
		track(
			"scripts/fixture-x.test.ts",
			'git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed");\n' +
				'git("init", "-q");\n',
		);
		const r = run();
		expect(r.status).toBe(0);
	});

	it("passes on an init-only fixture", () => {
		track("scripts/fixture-x.test.ts", 'git("init", "-q");\n');
		const r = run();
		expect(r.status).toBe(0);
	});

	it("drops the file on a git-identity-exempt comment", () => {
		track(
			"scripts/fixture-x.test.ts",
			"// git-identity-exempt: this repo never actually commits, see #999\n" +
				'git("init", "-q");\n' +
				'git("commit", "-qm", "seed");\n',
		);
		const r = run();
		expect(r.status).toBe(0);
	});
});

describe("two repos in one file, keyed by their own variable", () => {
	it("passes committing into an already-identitied repo while a separate raw init stays bare", () => {
		track(
			"scripts/fixture-x.test.ts",
			// `fresh` is raw-inited with no identity but never committed — inert.
			'execFileSync("git", ["init", "-q"], { cwd: fresh });\n' +
				// `shared` is committed but never raw-inited in this file (built by a
				// helper elsewhere) — presumed already identitied.
				'execFileSync("git", ["commit", "-qm", "x"], { cwd: shared });\n',
		);
		const r = run();
		expect(r.status).toBe(0);
	});

	it("fails the one key that is both raw-inited and raw-committed with no identity, naming that key alone, independent of a clean sibling key", () => {
		track(
			"scripts/fixture-x.test.ts",
			'execFileSync("git", ["init", "-q"], { cwd: a });\n' +
				'execFileSync("git", ["config", "user.email", "t@t"], { cwd: a });\n' +
				'execFileSync("git", ["config", "user.name", "t"], { cwd: a });\n' +
				'execFileSync("git", ["commit", "-qm", "x"], { cwd: a });\n' +
				'execFileSync("git", ["init", "-q"], { cwd: b });\n' +
				'execFileSync("git", ["commit", "-qm", "y"], { cwd: b });\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("no identity");
		// Not a text match on the flagged key: the retired `/\ba\b.*no
		// identity/` matched the indefinite article in the ::error::
		// annotation's prose ("commits a raw git repo (b)…"), not the key
		// itself — this reads the flagged key directly instead (mantahostels#2427).
		const j = run("--json").json();
		expect(j.findings).toHaveLength(1);
		expect(j.findings[0].repos).toEqual(["b"]);
	});

	it("still sees a raw commit call site the formatter wraps across several lines (mantahostels#2355's spec review, F3)", () => {
		track(
			"scripts/fixture-x.test.ts",
			'execFileSync("git", ["init", "-q"], { cwd: repo });\n' +
				'execFileSync(\n"git",\n["commit", "-qm", "x"],\n{ cwd: repo },\n);\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("repo");
	});

	it("tolerates a config call the formatter wraps across several lines", () => {
		track(
			"scripts/fixture-x.test.ts",
			'execFileSync("git", ["init", "-q"], { cwd: sb.repo });\n' +
				'execFileSync("git", ["config", "user.email", "t@t"], {\n' +
				"\tcwd: sb.repo,\n" +
				"});\n" +
				'execFileSync("git", ["config", "user.name", "t"], { cwd: sb.repo });\n' +
				'execFileSync("git", ["commit", "-qm", "x"], { cwd: sb.repo });\n',
		);
		const r = run();
		expect(r.status).toBe(0);
	});
});

describe("a commit message that reads like a call site", () => {
	it("does not mistake a JSON test payload's embedded command string for a real init", () => {
		track(
			"scripts/fixture-x.test.ts",
			"const payload = { command: 'git commit -m \"init\"' };\n",
		);
		const r = run();
		expect(r.status).toBe(0);
	});
});

describe("scope and reporting", () => {
	it("passes an empty tree", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("counts every raw-init/raw-commit file as scanned, not only the faulted ones", () => {
		track(
			"scripts/fixture-clean.test.ts",
			'git("init", "-q");\n' +
				'git("config", "user.email", "test@example.com");\n' +
				'git("config", "user.name", "test");\n' +
				'git("commit", "-qm", "seed");\n',
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^OK: 1 of \d+ scripts\/ test files/);
	});

	it("reports JSON with the finding's file and repo keys", () => {
		track(
			"scripts/fixture-x.test.ts",
			'git("init", "-q");\ngit("commit", "-qm", "seed");\n',
		);
		const r = run("--json");
		const j = r.json();
		expect(j.outcome).toBe("FAIL");
		expect(j.findings[0].file).toBe("scripts/fixture-x.test.ts");
		expect(j.findings[0].repos).toContain("__default__");
	});

	it("--warn caps a FAIL to WARN and exit 0", () => {
		track(
			"scripts/fixture-x.test.ts",
			'git("init", "-q");\ngit("commit", "-qm", "seed");\n',
		);
		const r = run("--warn");
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});
});
