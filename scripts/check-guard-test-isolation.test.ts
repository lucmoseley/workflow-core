// @vitest-environment node
/*
 * Pins that check-guard-test-isolation.js fails a test running a guard — a
 * bash guard or a Node entry — that logs fail-opens without redirecting
 * CLAUDE_CONFIG_DIR, through shared
 * helpers and unresolved indirection too, and never on a guard merely named
 * (mantahostels#1452).
 *
 * check-guard-test-isolation.js reads call sites, so a throwaway git repo
 * holding a guard (a shell script or a Node entry) and a test file that runs it
 * is the whole fixture;
 * one last case runs it against this repo to prove it finds tests to judge.
 *
 * It is a hard gate in .husky/pre-commit and roadmap-digest.yml: loosen a case
 * and a guard's test fills the live fail-open log with deliberate faults,
 * burying a real one.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

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

/**
 * A Node entry that records its fail-opens through lib/entry-input.js's
 * logger, by way of lib/guard-entry.js, and `via` a lib requiring that if
 * given.
 */
const nodeGuard = (name: string, via?: string) => {
	track("scripts/lib/entry-input.js", "module.exports = { logger() {} };\n");
	track("scripts/lib/guard-entry.js", 'require("./entry-input.js");\n');
	if (via) {
		track(`scripts/lib/${via}`, 'require("./guard-entry.js");\n');
		track(`scripts/${name}`, `require("./lib/${via}");\n`);
	} else {
		track(`scripts/${name}`, 'require("./lib/guard-entry.js").run({});\n');
	}
};

/** A guard that records nothing — no route to guard-log.sh at all. */
const quietGuard = (name: string) =>
	track(`scripts/${name}`, "echo '{}'\nexit 0\n");

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, { cwd: dir });
	return {
		status: r.status,
		stdout: r.stdout,
		out: `${r.stdout}${r.stderr}`,
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
		guard("guard-x.sh", "guard-log.sh");
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

describe("a test that runs a Node guard entry (#2898)", () => {
	const nodeTest = (body: string) =>
		track(
			"scripts/guard-n.test.ts",
			`const GUARD = path.resolve(__dirname, "guard-n.js");\n${body}`,
		);

	it("fails a node spawn that lets the entry inherit the real CLAUDE_CONFIG_DIR, naming the test file", () => {
		nodeGuard("guard-n.js");
		nodeTest("spawnSync(process.execPath, [GUARD], { env: process.env });\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"scripts/guard-n.test.ts spawns scripts/guard-n.js",
		);
		expect(r.out).toContain("CLAUDE_CONFIG_DIR");
	});

	it("fails an in-process run of a logging entry with no redirect, naming the entry", () => {
		nodeGuard("guard-n.js");
		nodeTest("runInProcess(GUARD, [], { stdin });\n");
		expect(run("--json").json().findings[0]).toMatchObject({
			file: "scripts/guard-n.test.ts",
			guards: ["scripts/guard-n.js"],
		});
	});

	it("passes one that redirects CLAUDE_CONFIG_DIR", () => {
		nodeGuard("guard-n.js");
		nodeTest("runInProcess(GUARD, [], { env: { CLAUDE_CONFIG_DIR: tmp } });\n");
		const r = run("--json");
		expect(r.status).toBe(0);
		expect(r.json().spawningTests).toBe(1);
	});

	it("follows the require chain — an entry reaching guard-entry.js through a lib", () => {
		nodeGuard("guard-n.js", "guard-dispatch.js");
		nodeTest('execFileSync("node", [GUARD]);\n');
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-n.js",
		]);
	});

	it("judges an entry taking the logger straight from entry-input.js, as record-divergence.js does (#2899)", () => {
		track("scripts/lib/entry-input.js", "module.exports = { logger() {} };\n");
		track("scripts/guard-n.js", 'require("./lib/entry-input.js");\n');
		nodeTest("runInProcess(GUARD, [], { stdin });\n");
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-n.js",
		]);
	});

	it("judges an entry calling arbiter-core.js's logError without entry-input.js, as the Stop guards do (#3046)", () => {
		track(
			"scripts/lib/arbiter-core.js",
			"module.exports = { logError() {} };\n",
		);
		track(
			"scripts/guard-n.js",
			'const { logError } = require("./lib/arbiter-core");\nlogError("guard-n", e);\n',
		);
		nodeTest("runInProcess(GUARD, [], { stdin });\n");
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-n.js",
		]);
	});

	it("judges an entry reaching fail-open-logger.js through a lib", () => {
		track(
			"scripts/lib/fail-open-logger.js",
			'require("./arbiter-store");\nmodule.exports = { failOpenLogger() {} };\n',
		);
		track("scripts/lib/refusal-limb.js", 'require("./fail-open-logger");\n');
		track("scripts/guard-n.js", 'require("./lib/refusal-limb");\n');
		nodeTest("runInProcess(GUARD, [], { stdin });\n");
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-n.js",
		]);
	});

	it("does not count an entry requiring the arbiter libs for anything but logError", () => {
		track(
			"scripts/lib/arbiter-core.js",
			"function logError() {}\nmodule.exports = { logError, readRecord() {} };\n",
		);
		track(
			"scripts/lib/arbiter-store.js",
			'const core = require("./arbiter-core");\nmodule.exports = { logError: core.logError };\n',
		);
		track(
			"scripts/guard-n.js",
			'const { readRecord } = require("./lib/arbiter-core");\n' +
				'const store = require("./lib/arbiter-store");\n' +
				"// logError(e) would be the fail-open\n" +
				'const name = "logError(";\n',
		);
		nodeTest("runInProcess(GUARD, [], { stdin });\n");
		expect(run("--json").json().spawningTests).toBe(0);
	});

	it("reads a node spawn's script past its flags, and a lib test's `../` entry", () => {
		nodeGuard("guard-n.js");
		track(
			"scripts/lib/n.test.ts",
			'const GUARD = path.resolve(__dirname, "../guard-n.js");\n' +
				'spawnSync("node", ["--no-warnings", GUARD]);\n',
		);
		expect(run("--json").json().findings[0]).toMatchObject({
			file: "scripts/lib/n.test.ts",
			guards: ["scripts/guard-n.js"],
		});
	});

	it("reads a node spawn whose args are no literal array as indirection", () => {
		nodeGuard("guard-n.js");
		nodeTest("spawnSync(process.execPath, argv);\n");
		expect(run("--json").json().findings[0].guards).toEqual([
			"scripts/guard-n.js",
		]);
	});

	it("does not bind a name used as a subscript key", () => {
		nodeGuard("guard-n.js");
		track(
			"scripts/fires.test.ts",
			'const needles = guards["guard-n.js"].needles;\n' +
				"runInProcess(CLI, []);\n",
		);
		expect(run().status).toBe(0);
	});

	it("does not read `node -e` source as a script run", () => {
		nodeGuard("guard-n.js");
		nodeTest('spawnSync(process.execPath, ["-e", code]);\n');
		expect(run().status).toBe(0);
	});

	it("passes a run of an entry that does not log", () => {
		track("scripts/guard-n.js", "process.exit(0);\n");
		nodeTest("runInProcess(GUARD, []);\n");
		expect(run().status).toBe(0);
	});

	it("never reads a lib it requires as an entry it runs", () => {
		nodeGuard("guard-n.js");
		track(
			"scripts/lib/entry.test.ts",
			'const kit = require("./guard-entry.js");\nrunInProcess(CLI, []);\n',
		);
		expect(run().status).toBe(0);
	});

	it("does not charge a node run with a bash guard it cannot be running", () => {
		guard("guard-x.sh");
		track(
			"scripts/guard-x.test.ts",
			'const GUARD = path.resolve(__dirname, "guard-x.sh");\n' +
				"runInProcess(CHECKER, []);\n",
		);
		expect(run().status).toBe(0);
	});

	it("does not read a call spelt inside a string as a run", () => {
		nodeGuard("guard-n.js");
		nodeTest(
			"fs.writeFileSync(at, 'spawnSync(process.execPath, [GUARD]);');\n",
		);
		expect(run().status).toBe(0);
	});

	it("hands a helper's opaque node run only its importers' Node entries", () => {
		guard("guard-x.sh");
		nodeGuard("guard-n.js");
		track(
			"scripts/run-fixture.ts",
			"export const runIt = (script: string) => runInProcess(script, []);\n",
		);
		track(
			"scripts/guard-n.test.ts",
			'import { runIt } from "./run-fixture";\n' +
				'runIt(path.resolve(__dirname, "guard-n.js"));\n' +
				'const SH = path.resolve(__dirname, "guard-x.sh");\n',
		);
		expect(run("--json").json().findings).toEqual([
			expect.objectContaining({
				file: "scripts/run-fixture.ts",
				guards: ["scripts/guard-n.js"],
			}),
		]);
	});

	it("passes a helper that stubs CLAUDE_CONFIG_DIR", () => {
		nodeGuard("guard-n.js");
		track(
			"scripts/run-fixture.ts",
			'vi.stubEnv("CLAUDE_CONFIG_DIR", tmp);\n' +
				"export const runIt = (script: string) => runInProcess(script, []);\n",
		);
		track(
			"scripts/guard-n.test.ts",
			'import { runIt } from "./run-fixture";\n' +
				'runIt(path.resolve(__dirname, "guard-n.js"));\n',
		);
		expect(run().status).toBe(0);
	});

	describe("a test calling a helper that sets process.env.CLAUDE_CONFIG_DIR, as freshSandbox does (#3046)", () => {
		const kit = (body: string) =>
			track(
				"scripts/lib/arbiter-testkit.ts",
				`export function freshSandbox() {\n\tbeforeEach(() => {\n\t\t${body}\n\t});\n}\nexport const other = () => {};\n`,
			);
		const test = (call: string, env = "{ ...process.env }") =>
			track(
				"scripts/guard-n.test.ts",
				'import { freshSandbox, other } from "./lib/arbiter-testkit";\n' +
					`${call}\n` +
					'const GUARD = path.resolve(__dirname, "guard-n.js");\n' +
					`runInProcess(GUARD, [], { env: ${env} });\n`,
			);

		it("passes where it calls the helper and spreads process.env", () => {
			nodeGuard("guard-n.js");
			kit("process.env.CLAUDE_CONFIG_DIR = home;");
			test("const sb = freshSandbox();");
			expect(run().status).toBe(0);
		});

		it("fails where the assignment is only a comment", () => {
			nodeGuard("guard-n.js");
			kit("// process.env.CLAUDE_CONFIG_DIR = home;");
			test("const sb = freshSandbox();");
			expect(run().status).toBe(1);
		});

		it("fails where it imports the helper but calls only another export", () => {
			nodeGuard("guard-n.js");
			kit("process.env.CLAUDE_CONFIG_DIR = home;");
			test("other();");
			expect(run().status).toBe(1);
		});

		it("fails where no spawn spreads process.env", () => {
			nodeGuard("guard-n.js");
			kit("process.env.CLAUDE_CONFIG_DIR = home;");
			test("const sb = freshSandbox();", "{ PATH: p }");
			expect(run().status).toBe(1);
		});
	});
});

describe("indirection, assumed guilty", () => {
	it("reads no binding spelt inside a string as one the file holds (#3046)", () => {
		nodeGuard("guard-n.js");
		track("scripts/x.js", "");
		track(
			"scripts/x.test.ts",
			'const SCRIPT = path.resolve(__dirname, "x.js");\n' +
				"write('const GUARD = path.join(__dirname, \"guard-n.js\");\\n');\n" +
				"spawnSync(process.execPath, [SCRIPT]);\n",
		);
		expect(run().status).toBe(0);
	});

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
		expect(JSON.parse(r.stdout ?? "{}").spawningTests).toBeGreaterThan(0);
	});
});
