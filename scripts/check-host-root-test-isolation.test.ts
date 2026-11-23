// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-host-root-test-isolation.js");
const REPO = path.resolve(__dirname, "..");

let dir: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const track = (rel: string, body: string) => {
	fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
	git("add", "--", rel);
};

const rooted = (name: string, via?: "marker-root.js") => {
	if (via) {
		track("scripts/lib/marker-root.js", 'require("./host-root.js");\n');
		track(`scripts/${name}`, 'require("./lib/marker-root.js");\n');
	} else {
		track(`scripts/${name}`, 'require("./lib/host-root.js");\n');
	}
};

const unrooted = (name: string) =>
	track(`scripts/${name}`, "process.exit(0);\n");

const run = (...args: string[]) => {
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

const repoTemplate = defineTemplate((at) => {
	execFileSync("git", ["init", "-q"], { cwd: at });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: at });
	execFileSync("git", ["config", "user.name", "t"], { cwd: at });
});

beforeEach(() => {
	dir = repoTemplate.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "host-root-test-isolation-")),
	);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SEAM_WITH_WRAPPER =
	'gr_root() {\n  printf .\n}\ngr_worktree_root() {\n  printf "$(gr_root)"\n}\n';

describe("a test that spawns a hostRoot()- or gr_root-rooted script", () => {
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

	it("follows a bash checker bound through a constant to its gr_root call in a sourced lib (#3311)", () => {
		track("scripts/lib/guard-root.sh", "gr_root() {\n  printf .\n}\n");
		track(
			"scripts/lib/marker-root.sh",
			'source "$_mr_here/guard-root.sh"\nroot="$(gr_root)"\n',
		);
		track("scripts/check-thing.sh", 'source "$here/lib/marker-root.sh"\n');
		track(
			"scripts/check-thing.test.ts",
			'const CHECKER = "scripts/check-thing.sh";\n' +
				"const realChecker = path.join(ROOT, CHECKER);\n" +
				'spawnSync("bash", [realChecker], { env: { ...process.env } });\n',
		);
		const r = run("--json");
		expect(r.status).toBe(1);
		expect(r.json().findings[0].scripts).toEqual(["scripts/check-thing.sh"]);
	});

	it("flags a shell script calling gr_worktree_root (#5287)", () => {
		track("scripts/lib/guard-root.sh", SEAM_WITH_WRAPPER);
		track(
			"scripts/thing.sh",
			'source "$here/lib/guard-root.sh"\nroot="$(gr_worktree_root)"\n',
		);
		track(
			"scripts/thing.test.ts",
			'spawnSync("bash", ["scripts/thing.sh"], {});\n',
		);
		expect(run().status).toBe(1);
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

	it("passes a shell script that sources guard-root.sh but never calls gr_root", () => {
		track(
			"scripts/lib/guard-root.sh",
			"# gr_root is defined here\ngr_root() {\n  printf .\n}\n",
		);
		track(
			"scripts/thing.sh",
			'source "$here/lib/guard-root.sh"\n# not gr_root\ngr_config_dir d\n',
		);
		track(
			"scripts/thing.test.ts",
			'spawnSync("bash", ["scripts/thing.sh"], {});\n',
		);
		expect(run().status).toBe(0);
	});

	it("passes a script sourcing guard-root.sh whose own functions call gr_root (#5287)", () => {
		track("scripts/lib/guard-root.sh", SEAM_WITH_WRAPPER);
		track(
			"scripts/thing.sh",
			'source "$here/lib/guard-root.sh"\ngr_config_dir d\n',
		);
		track(
			"scripts/thing.test.ts",
			'spawnSync("bash", ["scripts/thing.sh"], {});\n',
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
	it("drops a file whose comment names an issue", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			"/* isolation-exempt: #160 */\n" +
				'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		expect(run().status).toBe(0);
	});

	it("counts an exempt file out of the all-clear it reports", () => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			"// isolation-exempt: #160\n" +
				'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
		const r = run("--json");
		expect(r.json().exempt).toBe(1);
	});

	it.each([
		["no pointer", "/* isolation-exempt: */"],
		["prose", "/* isolation-exempt: reads the real repo on purpose. */"],
	])("ignores a marker carrying %s", (_what, marker) => {
		rooted("thing.js");
		track(
			"scripts/thing.test.ts",
			`${marker}\n` +
				'const SCRIPT = path.resolve(__dirname, "thing.js");\n' +
				'spawnSync("node", [SCRIPT], {});\n',
		);
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
