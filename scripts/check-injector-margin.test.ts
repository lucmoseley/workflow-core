// @vitest-environment node
/*
 * check-injector-margin.js against synthetic text modules (mantahostels#1915):
 * its exits, the margin it prints, --index's staged reading, and the
 * evaluation that runs nothing of the module, and its in-process run as
 * the pre-commit dispatcher makes it. The row's arming is
 * precommit-injector-margin-gate.test.ts's.
 *
 * A fake module is any CommonJS source exporting the composers the measure
 * calls. The real module's own figures are asserted by
 * lib/inject-tracker-docs.test.ts, which owns that ground; pinning one here
 * would go red on every ordinary rule edit.
 *
 * WHAT STAYS UNVERIFIED: that 10,000 is still the harness's threshold
 * (mantahostels#1868).
 *
 * It is a hard pre-commit gate: loosen a case and a text module
 * whose payload crosses the threshold lands, and the tracker commands silently
 * get a ~2 KB preview of their rules instead of the rules.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inProcess, spawned } from "./lib/check-in-process-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-injector-margin.js");
const ROOT = path.resolve(__dirname, "..");
const TEXT = "scripts/lib/tracker-inject-text.js";
const HOOK_LIMITS = "scripts/lib/hook-limits.js";

let root: string;

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};

const moduleOf = (commands: string[], body: string) =>
	[
		`const COMMANDS = ${JSON.stringify(commands)};`,
		`const BODY = ${JSON.stringify(body)};`,
		"module.exports = {",
		"\tCOMMANDS,",
		"\tTAKES_READ: [],",
		'\tpricedOptionsWhole: () => "",',
		"\ttrackerContext: () => BODY,",
		"};",
		"",
	].join("\n");

const fakeModule = (commands: string[], size: number) =>
	moduleOf(commands, "x".repeat(size));

const seed = (text: string) => {
	write(HOOK_LIMITS, fs.readFileSync(path.join(ROOT, HOOK_LIMITS), "utf8"));
	write(TEXT, text);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { code: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "injector-margin-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-injector-margin.js", () => {
	it("passes and reports the margin when every payload fits", () => {
		seed(fakeModule(["alpha", "beta"], 9000));

		const { code, output } = run();
		expect(code).toBe(0);
		expect(output).toContain("/alpha         9000 chars,  1000 left");
		expect(output).toContain("/beta          9000 chars,  1000 left");
	});

	it("fails on a payload at the threshold, which is already persisted, marking it OVER and saying to replace a paste with a pointer", () => {
		seed(fakeModule(["alpha"], 10_000));

		const { code, output } = run();
		expect(code).toBe(1);
		expect(output).toContain(
			"← OVER: this payload is persisted to a file, not delivered inline",
		);
		// The exit code alone is half of it: a refused commit has to say the way out.
		expect(output).toContain("replace a paste with a pointer");
	});

	it("passes one character under it", () => {
		seed(fakeModule(["alpha"], 9999));

		expect(run().code).toBe(0);
	});

	// The tight note rides on the SAME LINE as the margin, so a case asserting
	// only the margin passes either way.
	it("does not mark exactly one rule of headroom as tight", () => {
		seed(fakeModule(["alpha"], 9000));

		expect(run().output).not.toContain("tight");
	});

	it("marks one character less than that as tight, without failing", () => {
		seed(fakeModule(["alpha"], 9001));

		const { code, output } = run();
		expect(code).toBe(0);
		expect(output).toContain("tight");
	});

	it("does not mark a comfortable payload as tight", () => {
		seed(fakeModule(["alpha"], 5000));

		expect(run().output).not.toContain("tight");
	});

	it("measures every command the module's COMMANDS names, and no list of its own", () => {
		seed(fakeModule(["one", "two", "three"], 100));

		const { output } = run();
		for (const cmd of ["one", "two", "three"])
			expect(output).toContain(`/${cmd}`);
	});

	it("reports BROKEN, not a pass, when hook-limits.js names no threshold", () => {
		seed(fakeModule(["alpha"], 5000));
		write(HOOK_LIMITS, "// emptied\n");

		const { code, output } = run();
		expect(code).toBe(2);
		expect(output).toContain("no const HOOK_PERSIST_CHARS = <n>; line");
	});

	it("reports BROKEN, not a pass, when hook-limits.js names no RULE_CAP", () => {
		seed(fakeModule(["alpha"], 5000));
		write(HOOK_LIMITS, "const HOOK_PERSIST_CHARS = 10000;\n");

		const { code, output } = run();
		expect(code).toBe(2);
		expect(output).toContain("no const RULE_CAP = <n>; line");
	});

	it("reports BROKEN with the cause when hook-limits.js is absent", () => {
		write(TEXT, fakeModule(["alpha"], 5000));

		const { code, output } = run();
		expect(code).toBe(2);
		expect(output).toContain(`cannot read ${HOOK_LIMITS}`);
		expect(output).toMatch(/no such file/i);
	});

	it("SKIPs, measuring nothing, where the root holds no text module", () => {
		const { code, output } = run();
		expect(code).toBe(0);
		expect(output).toContain(`SKIP: no ${TEXT} to measure`);
		expect(output).not.toContain("chars,");
	});

	it("reports BROKEN, not a pass, when the module exports no COMMANDS", () => {
		seed("module.exports = {};\n");

		const { code, output } = run();
		expect(code).toBe(2);
		expect(output).toContain(`BROKEN: ${TEXT} could not be measured`);
	});

	it("reports BROKEN when the module names no command", () => {
		seed(fakeModule([], 100));

		const { code, output } = run();
		expect(code).toBe(2);
		expect(output).toContain("names no command");
	});

	// The staged blob may be another session's (a merge, a revert), so it is
	// evaluated with no `require` to reach anything with.
	it("reports BROKEN, running nothing, when the module reaches for require", () => {
		seed(
			`require("node:fs").writeFileSync("ran", "");\n${fakeModule(["alpha"], 100)}`,
		);

		const { code, output } = run();
		expect(code).toBe(2);
		expect(output).toContain("require is not defined");
		expect(fs.existsSync(path.join(root, "ran"))).toBe(false);
	});

	it("counts the units the harness slices with, not codepoints", () => {
		// 5,000 emoji: 5,000 codepoints, 10,000 UTF-16 units — over the line.
		seed(moduleOf(["alpha"], "\u{1F600}".repeat(5000)));

		const { code, output } = run();
		expect(code).toBe(1);
		expect(output).toContain("/alpha        10000 chars");
	});

	it("names each fragment whose fallback stood in for /code-review", () => {
		seed(
			moduleOf(["code-review"], "").replace(
				"module.exports = {",
				'const codeReviewRules = (h) => ["review-dispatch-shape", "review-deviations-read"].map(h.fragment).join("");\nmodule.exports = {\n\tcodeReviewRules,',
			),
		);
		write("docs/agents/rules/review-dispatch-shape.txt", "shape\n");

		const { code, output } = run();
		expect(code).toBe(0);
		expect(output).toContain(
			"/code-review measured with the text module's fallback for unreadable fragment review-deviations-read.",
		);
		expect(output).not.toContain("fragment review-dispatch-shape");
	});

	it("measures exactly the commands the live module names", () => {
		seed(fs.readFileSync(path.join(ROOT, TEXT), "utf8"));
		const { COMMANDS } = require(path.join(ROOT, TEXT)) as {
			COMMANDS: string[];
		};
		const { code, output } = run();
		expect(code).not.toBe(2);
		for (const cmd of COMMANDS) expect(output).toContain(`/${cmd} `);
	});
});

describe("--index: the commit's bytes", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "pipe" });

	/* Stages a /code-review composer whose body is `composer`, beside a
	 * review-dispatch-shape fragment holding "shape". */
	const stageCodeReview = (composer: string) => {
		write(
			TEXT,
			moduleOf(["code-review"], "").replace(
				"module.exports = {",
				`const codeReviewRules = (h) => ${composer};\nmodule.exports = {\n\tcodeReviewRules,`,
			),
		);
		write("docs/agents/rules/review-dispatch-shape.txt", "shape\n");
		git("add", TEXT, "docs/agents/rules/review-dispatch-shape.txt");
	};
	const store = () => [
		process.env.WFC_RULES_DIR,
		process.env.WFC_RULES_FALLBACK_DIR,
	];

	beforeEach(() => {
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		seed(fakeModule(["alpha"], 5000));
		git("add", ".");
		git("commit", "-qm", "seed");
	});

	it("measures the staged blob, not the working tree", () => {
		write(TEXT, fakeModule(["alpha"], 10_500));

		expect(run("--index").code).toBe(0);
		expect(run().code).toBe(1);
		git("add", TEXT);
		// --json, as the index side's report streams to the real stderr, which
		// runInProcess does not capture.
		const { code, output } = run("--index", "--json");
		expect(code).toBe(1);
		expect(JSON.parse(output).findings).toMatchObject([
			{ tag: "PAYLOAD-OVER", command: "alpha", chars: 10_500 },
		]);
	});

	it("reads hook-limits.js from the index too", () => {
		write(HOOK_LIMITS, "// emptied\n");
		expect(run("--index").code).toBe(0);
		git("add", HOOK_LIMITS);
		const { code, output } = run("--index");
		expect(code).toBe(2);
		expect(output).toContain("no const HOOK_PERSIST_CHARS = <n>; line");
	});

	it("measures a fragment the index lacks as its fallback, never the working copy", () => {
		stageCodeReview('h.fragment("review-dispatch-shape")');
		git("rm", "-q", "--cached", "docs/agents/rules/review-dispatch-shape.txt");

		const { code, output } = run("--index", "--json");
		expect(code).toBe(0);
		expect(JSON.parse(output).findings).toMatchObject([
			{ tag: "FRAGMENT-FALLBACK", id: "review-dispatch-shape" },
		]);
		expect(JSON.parse(run("--json").output).findings).toEqual([]);
	});

	/* The dispatcher runs the row in the process every row shares (#5194):
	 * the fragment store is pinned to the measured root for the read alone,
	 * so the run reads as its spawned CLI and leaves the environment as it
	 * found it. */
	it("runs in-process exactly as spawned, its fragment store pinned to the measured root", async () => {
		stageCodeReview(
			'["review-dispatch-shape", "review-deviations-read"].map(h.fragment).join("")',
		);
		const before = store();

		const inside = await inProcess(SCRIPT, ["--index"], root);
		expect(inside).toEqual(spawned(SCRIPT, ["--index"], root));
		expect(`${inside.stdout}${inside.stderr}`).toContain(
			"fallback for unreadable fragment review-deviations-read.",
		);
		expect(`${inside.stdout}${inside.stderr}`).not.toContain(
			"fragment review-dispatch-shape",
		);
		expect(store()).toEqual(before);
	});

	/* A store an earlier row or the caller left in the environment is never
	 * the one measured (#5202): the pin outranks it for the read alone. The
	 * "runs in-process exactly as spawned" case above is this negative
	 * assertion's positive pair, printing the fallback note it looks for. */
	it("reads the measured root's fragments over a stale WFC_RULES_DIR, leaving it set", async () => {
		stageCodeReview('h.fragment("review-dispatch-shape")');
		const clean = await inProcess(SCRIPT, ["--index"], root);
		expect(clean.exit).toBe(0);
		const report = `${clean.stdout}${clean.stderr}`;
		expect(report).toContain("/code-review");
		expect(report).not.toContain("unreadable fragment");
		const stale = path.join(root, "stale-rules");
		fs.mkdirSync(stale);
		vi.stubEnv("WFC_RULES_DIR", stale);
		vi.stubEnv("WFC_RULES_FALLBACK_DIR", stale);

		expect(await inProcess(SCRIPT, ["--index"], root)).toEqual(clean);
		expect(store()).toEqual([stale, stale]);
	});

	/* The routes on which this gate must NOT refuse a commit (mantahostels#1915). */
	it("SKIPs a commit that stages the text module's deletion", () => {
		git("rm", "-q", "--", TEXT);

		const { code, output } = run("--index");
		expect(code).toBe(0);
		expect(output).toContain("SKIP");
		expect(output).not.toContain("chars,");
	});

	/* git reports a rename as R, never D, so a deletion probe could miss it and
	 * refuse a moved module as BROKEN (#1483). */
	it("SKIPs a commit that renames the text module away (#1483)", () => {
		fs.mkdirSync(path.join(root, "bin"));
		git("mv", "--", TEXT, "bin/tracker-inject-text.js");

		const { code, output } = run("--index");
		expect(code).toBe(0);
		expect(output).toContain("SKIP");
		expect(output).not.toContain("BROKEN");
	});
});
