// @vitest-environment node
/*
 * Pins that check-guard-test-isolation.js fails a test spawning a guard that
 * logs fail-opens without redirecting CLAUDE_CONFIG_DIR, through shared
 * helpers and unresolved indirection too, and never on a guard merely named
 * (mantahostels#1452).
 *
 * check-guard-test-isolation.js reads call sites, so a throwaway git repo
 * holding a shell script and a test file that spawns it is the whole fixture;
 * one last case runs it against this repo to prove it finds tests to judge.
 *
 * It is a hard gate in .husky/pre-commit and roadmap-digest.yml: loosen a case
 * and a guard's test fills the live fail-open log with deliberate faults,
 * burying a real one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "check-guard-test-isolation.js");
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

/** The shared lib every guard's fail-open record goes through (mantahostels#147). */
const guardLog = () =>
	track("scripts/lib/guard-log.sh", 'gl_log() { : "$CLAUDE_CONFIG_DIR"; }\n');

/** A guard that records its fail-opens, `via` an intermediate lib if given. */
const guard = (name: string, via?: string) => {
	guardLog();
	if (via) {
		track(`scripts/lib/${via}`, 'source "$here/lib/guard-log.sh"\n');
		track(`scripts/${name}`, `source "$here/lib/${via}"\n`);
	} else {
		track(`scripts/${name}`, 'source "$here/lib/guard-log.sh"\n');
	}
};

/** A guard that records nothing — no route to guard-log.sh at all. */
const quietGuard = (name: string) =>
	track(`scripts/${name}`, "echo '{}'\nexit 0\n");

const run = (...args: string[]) => {
	const r = spawnSync("node", [SCRIPT, ...args], {
		cwd: dir,
		encoding: "utf8",
	});
	return {
		status: r.status ?? -1,
		stdout: r.stdout ?? "",
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		json: () => JSON.parse(r.stdout),
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-isolation-"));
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a test that spawns a fail-open-logging guard", () => {
	it("fails when it lets the guard inherit the real CLAUDE_CONFIG_DIR, naming the test file", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			'const GUARD = path.resolve(__dirname, "guard-x.sh");\n' +
				"spawnSync(GUARD, [], { env: { ...process.env } });\n",
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/guard-x.test.ts");
		expect(r.out).toContain("CLAUDE_CONFIG_DIR");
	});

	it("passes when it redirects CLAUDE_CONFIG_DIR", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			'const GUARD = path.resolve(__dirname, "guard-x.sh");\n' +
				"spawnSync(GUARD, [], { env: { CLAUDE_CONFIG_DIR: tmp } });\n",
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("follows the source chain — a guard reaching guard-log.sh through a lib", () => {
		guard("guard-x.sh", "guard-parse.sh");
		track(
			"scripts/guard-x.test.ts",
			'spawnSync(path.join(__dirname, "guard-x.sh"), []);\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/guard-x.test.ts");
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-x.sh",
		]);
	});

	it("names the guard it found spawned", () => {
		guard("guard-x.sh");
		track("scripts/guard-x.test.ts", 'spawnSync("guard-x.sh", []);\n');
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-x.sh",
		]);
	});
});

describe("what it declines to flag", () => {
	it("passes a test that only names a guard in a string", () => {
		guard("guard-x.sh");
		track(
			"scripts/registrations.test.ts",
			'const settings = read("settings.json");\n' +
				'expect(settings).toContain("scripts/guard-x.sh");\n' +
				"spawnSync(process.execPath, [CLI]);\n",
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.json).toBeDefined();
	});

	it("passes a test spawning a guard that records no fail-opens", () => {
		guardLog();
		quietGuard("guard-quiet.sh");
		track(
			"scripts/guard-quiet.test.ts",
			'const GUARD = path.resolve(__dirname, "guard-quiet.sh");\n' +
				"spawnSync(GUARD, []);\n",
		);
		expect(run().status).toBe(0);
	});

	it("counts only the tests that spawn one", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			'spawnSync(path.join(__dirname, "guard-x.sh"), [], { env: { CLAUDE_CONFIG_DIR: t } });\n',
		);
		track("scripts/other.test.ts", "spawnSync(process.execPath, [CLI]);\n");
		expect(run("--json").json().spawningTests).toBe(1);
	});
});

describe("indirection, assumed guilty", () => {
	it("flags a spawn of an argv[0] it cannot resolve, naming the test file and recording the guard", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			'const GUARD = path.resolve(__dirname, "guard-x.sh");\n' +
				"const at = copyGuardTo(tmp);\n" +
				"spawnSync(at, [], { env: { ...process.env } });\n",
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/guard-x.test.ts");
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-x.sh",
		]);
	});

	it("does not read an interpreter spawn as indirection", () => {
		guard("guard-x.sh");
		track(
			"scripts/reads-guard.test.ts",
			'const GUARD = path.resolve(__dirname, "guard-x.sh");\n' +
				"expect(fs.readFileSync(GUARD, 'utf8')).toContain('source');\n" +
				'spawnSync("bash", ["-c", "true"]);\n',
		);
		expect(run().status).toBe(0);
	});

	it("does not read a fixed program's literal as indirection (#2143)", () => {
		guard("guard-x.sh");
		track(
			"scripts/reads-guard.test.ts",
			'const GUARD = path.resolve(__dirname, "guard-x.sh");\n' +
				'spawnSync("which", ["jq"]);\n',
		);
		expect(run().status).toBe(0);
	});
});

describe("a shared helper that spawns the guard its caller hands it (#837)", () => {
	const helper = (rel: string, env: string) =>
		track(
			rel,
			"export const runGuard = (guard: string) =>\n" +
				`\tspawnSync(guard, [], { env: { ...process.env, ${env} } });\n`,
		);
	const caller = (importSpec: string) =>
		track(
			"scripts/guard-x.test.ts",
			`import { runGuard } from "${importSpec}";\n` +
				'const GUARD = path.resolve(__dirname, "guard-x.sh");\n' +
				"runGuard(GUARD);\n",
		);

	it("blames the helper, naming the guard its importer hands it", () => {
		guard("guard-x.sh");
		helper("scripts/guard-x-fixture.ts", "A: 1");
		caller("./guard-x-fixture");
		const r = run("--json");
		expect(r.status).toBe(1);
		const out = run().out;
		expect(out).toContain("scripts/guard-x-fixture.ts, a shared test helper");
		expect(out).toContain(
			"a helper must set CLAUDE_CONFIG_DIR in its own spawn env",
		);
		expect(r.json().findings).toEqual([
			expect.objectContaining({
				file: "scripts/guard-x-fixture.ts",
				guards: ["scripts/guard-x.sh"],
			}),
		]);
	});

	it("follows an import into scripts/lib", () => {
		guard("guard-x.sh");
		helper("scripts/lib/x-testkit.ts", "A: 1");
		caller("./lib/x-testkit.ts");
		expect(run("--json").json().findings[0].file).toBe(
			"scripts/lib/x-testkit.ts",
		);
	});

	it("passes a helper that sets CLAUDE_CONFIG_DIR in its spawn env", () => {
		guard("guard-x.sh");
		helper("scripts/guard-x-fixture.ts", "CLAUDE_CONFIG_DIR: tmp");
		caller("./guard-x-fixture");
		const r = run("--json");
		expect(r.status).toBe(0);
		expect(r.json().spawningTests).toBe(1);
	});

	it("does not read a comment or a caller-override read as the redirect", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x-fixture.ts",
			"// fail-opens log under CLAUDE_CONFIG_DIR\n" +
				"const cfg = ctx().env?.CLAUDE_CONFIG_DIR;\n" +
				"export const runGuard = (guard: string) =>\n" +
				"\tspawnSync(guard, [], { env: { ...process.env, ...ctx().env } });\n",
		);
		caller("./guard-x-fixture");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/guard-x-fixture.ts, a shared test helper");
	});

	it("does not read a type annotation as the redirect", () => {
		guard("guard-x.sh");
		helper("scripts/guard-x-fixture.ts", "A: 1");
		fs.appendFileSync(
			path.join(dir, "scripts/guard-x-fixture.ts"),
			"type Env = { CLAUDE_CONFIG_DIR: string };\n",
		);
		git("add", "--", "scripts/guard-x-fixture.ts");
		caller("./guard-x-fixture");
		expect(run().out).toContain(
			"scripts/guard-x-fixture.ts, a shared test helper",
		);
	});

	it("passes a helper no logging-guard test imports", () => {
		guard("guard-x.sh");
		helper("scripts/guard-x-fixture.ts", "A: 1");
		track(
			"scripts/other.test.ts",
			'import { runGuard } from "./guard-x-fixture";\nrunGuard("/bin/true");\n',
		);
		expect(run().status).toBe(0);
	});
});

describe("the escape hatch and the caller-side cap", () => {
	it("drops a file whose comment gives a reason", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			"/* isolation-exempt: asserts the guard refuses before it can log. */\n" +
				'spawnSync(path.join(__dirname, "guard-x.sh"), []);\n',
		);
		expect(run().status).toBe(0);
	});

	it("counts an exempt file out of the all-clear it reports", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			"/* isolation-exempt: refuses before it can log. */\n" +
				'spawnSync(path.join(__dirname, "guard-x.sh"), []);\n',
		);
		const r = run("--json");
		expect(r.json().exempt).toBe(1);
		expect(r.json().summary).toContain("1 exempt");
	});

	it("ignores a bare marker carrying no reason", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			"/* isolation-exempt: */\n" +
				'spawnSync(path.join(__dirname, "guard-x.sh"), []);\n',
		);
		// exempt (mantahostels#2082): Same finding path as "fails when it lets the guard inherit the real
		// CLAUDE_CONFIG_DIR" above, which pins the message — this only proves
		// the empty marker doesn't suppress it.
		expect(run().status).toBe(1);
	});

	it("--warn reports the finding without gating", () => {
		guard("guard-x.sh");
		track("scripts/guard-x.test.ts", 'spawnSync("guard-x.sh", []);\n');
		const r = run("--warn");
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN:");
	});
});

describe("apparatus failures are BROKEN, never green", () => {
	it("is BROKEN outside a git repo", () => {
		const loose = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		const r = spawnSync("node", [SCRIPT], { cwd: loose, encoding: "utf8" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"git rev-parse failed while locating the repo root",
		);
		fs.rmSync(loose, { recursive: true, force: true });
	});
});

describe("the real repository", () => {
	it("passes, having found spawning tests to judge", () => {
		const r = spawnSync("node", [SCRIPT, "--json"], {
			cwd: REPO,
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout ?? "{}").spawningTests).toBeGreaterThan(0);
	});
});
