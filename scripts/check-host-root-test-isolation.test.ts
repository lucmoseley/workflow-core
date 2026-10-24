// @vitest-environment node
/*
 * Pins that check-host-root-test-isolation.js fails a test spawning a
 * hostRoot()-rooted script without redirecting CLAUDE_PROJECT_DIR, and never
 * one that merely names such a script.
 *
 * check-host-root-test-isolation.js reads call sites, so a throwaway git repo
 * holding a host-root-rooted script and a test file that spawns it is the
 * whole fixture. It gates `.husky/pre-commit`: a false FAIL here refuses an
 * unrelated commit, and a false OK lets a test root itself in the real repo
 * unnoticed, the way #154 did before it was found and fixed (#160).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-host-root-test-isolation.js");
const REPO = path.resolve(__dirname, "..");

let dir: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** Track `rel` with `body`, creating its directory. */
const track = (rel: string, body: string) => {
	fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
	git("add", "--", rel);
};

/** A script that roots itself through hostRoot(), `via` marker-root.js if given. */
const rooted = (name: string, via?: "marker-root.js") => {
	if (via) {
		track("scripts/lib/marker-root.js", 'require("./host-root.js");\n');
		track(`scripts/${name}`, 'require("./lib/marker-root.js");\n');
	} else {
		track(`scripts/${name}`, 'require("./lib/host-root.js");\n');
	}
};

/** A script that touches neither seam. */
const unrooted = (name: string) =>
	track(`scripts/${name}`, "process.exit(0);\n");

const run = (...args: string[]) => {
	// Off, not inherited: a real Actions run sets it globally, and this suite
	// runs inside one — runCheck's ::error:: annotation, added off this flag,
	// would otherwise leak into `out` (mantahostels#2427, check-git-fixture-identity.test.ts's
	// own `run`).
	const r = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: { ...process.env, GITHUB_ACTIONS: "" },
	});
	return {
		status: r.status,
		stdout: r.stdout,
		out: `${r.stdout}${r.stderr}`,
		json: () => JSON.parse(r.stdout),
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-root-test-isolation-"));
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a test that spawns a hostRoot()-rooted script", () => {
	it("fails when it lets the script inherit the real CLAUDE_PROJECT_DIR, naming the test file", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], { env: { ...process.env } });\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/thing.test.ts");
		expect(r.out).toContain("CLAUDE_PROJECT_DIR");
	});

	it("passes when it redirects CLAUDE_PROJECT_DIR", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], { env: { CLAUDE_PROJECT_DIR: tmp } });\n',
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("follows the one named indirection — a script reaching host-root.js through marker-root.js", () => {
		rooted("thing.js", "marker-root.js");
		track(
			"scripts/thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/thing.test.ts");
		expect(r.out).toContain("CLAUDE_PROJECT_DIR");
		expect(run("--json").json().findings[0].scripts).toEqual([
			"scripts/thing.js",
		]);
	});

	it('reads process.execPath the same as "node"', () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				"spawnSync(process.execPath, [SCRIPT], {});\n",
		);
		expect(run().status).toBe(1);
	});
});

describe("what it declines to flag", () => {
	it("passes a test spawning a script that never touches either seam", () => {
		unrooted("thing.js");
		track(
			"scripts/thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		expect(run().status).toBe(0);
	});

	it("passes a test that only names a rooted script in a string", () => {
		rooted("thing.js");
		track(
			"scripts/registrations.test.ts",
			'const settings = read("settings.json");\n' +
				'expect(settings).toContain("scripts/thing.js");\n' +
				'spawnSync("git", ["status"]);\n',
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.json).toBeDefined();
	});

	it("does not read an unrelated interpreter call as indirection", () => {
		rooted("thing.js");
		track(
			"scripts/reads-thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'execFileSync("git", ["add", "-A"], { cwd: dir });\n' +
				'expect(fs.readFileSync(SCRIPT, "utf8")).toContain("host-root");\n',
		);
		expect(run().status).toBe(0);
	});

	it("counts only the tests that spawn one", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], { env: { CLAUDE_PROJECT_DIR: t } });\n',
		);
		track("scripts/other.test.ts", 'spawnSync("git", ["status"]);\n');
		expect(run("--json").json().spawningTests).toBe(1);
	});
});

describe("the escape hatch and the caller-side cap", () => {
	it("drops a file whose comment gives a reason", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			"/* isolation-exempt: hostRoot() resolving to the real repo is the point. */\n" +
				'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		expect(run().status).toBe(0);
	});

	it("counts an exempt file out of the all-clear it reports", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			"/* isolation-exempt: reads the real repo on purpose. */\n" +
				'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		const r = run("--json");
		expect(r.json().exempt).toBe(1);
	});

	it("ignores a bare marker carrying no reason", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			"/* isolation-exempt: */\n" +
				'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		// Same finding path as "fails when it lets the script inherit the real
		// CLAUDE_PROJECT_DIR" above, which pins the message — this only proves
		// the empty marker doesn't suppress it.
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/thing.test.ts");
	});

	it("--warn reports the finding without gating", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		const r = run("--warn");
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN:");
	});
});

describe("apparatus failures are BROKEN, never green", () => {
	it("is BROKEN outside a git repo", () => {
		const loose = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		const r = runInProcess(SCRIPT, [], { cwd: loose });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"git rev-parse failed while locating the repo root",
		);
		fs.rmSync(loose, { recursive: true, force: true });
	});
});

describe("the real repository", () => {
	it("passes, having found spawning tests to judge", () => {
		const r = runInProcess(SCRIPT, ["--json"], { cwd: REPO });
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout || "{}").spawningTests).toBeGreaterThan(0);
	});
});
