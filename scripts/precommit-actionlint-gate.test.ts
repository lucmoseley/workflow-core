// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandPath } from "./lib/command-path-testkit";
import {
	cutGateFragment,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	HOOK_BOUND_LIB,
	LIB,
	LIB_COMMANDS,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { shellQuote } from "./lib/sh-quote.js";

const temps = registerTempCleanup();

const gateFragment = () => cutGateFragment("hook_bound actionlint");

const ARGS_FILE = "actionlint-args.txt";

const NEEDED = ["sh", ...LIB_COMMANDS];

function linkNeeded(bin: string): void {
	for (const cmd of NEEDED) {
		const abs = commandPath(cmd);
		fs.symlinkSync(abs, path.join(bin, cmd));
	}
}

function fixture(opts: {
	staged: Record<string, string>;
	actionlintExit?: number;
	stub?: boolean;
}): TempRepo & { bin: string; isolated: boolean } {
	const repo = stagedRepo("actionlint-gate-", temps, {}, opts.staged);
	const { root } = repo;

	const bin = path.join(root, "stub-bin");
	fs.mkdirSync(bin, { recursive: true });
	if (opts.stub === false) {
		linkNeeded(bin);
	} else {
		const stub = path.join(bin, "actionlint");
		fs.writeFileSync(
			stub,
			`#!/bin/sh\nprintf 'argc=%s\\n' "$#" >>${shellQuote(path.join(root, ARGS_FILE))}\nprintf '%s\\n' "$@" >>${shellQuote(path.join(root, ARGS_FILE))}\nexit ${opts.actionlintExit ?? 0}\n`,
		);
		fs.chmodSync(stub, 0o755);
	}

	return { ...repo, bin, isolated: opts.stub === false };
}

function runGate(repo: { root: string; bin: string; isolated?: boolean }): {
	code: number;
	output: string;
	args: string[];
	invoked: boolean;
} {
	let code = 0;
	let output = "";
	const script = `exec 2>&1\n${HOOK_BOUND_LIB}\n${LIB}\n${gateFragment()}\n:\n`;
	const search = repo.isolated
		? repo.bin
		: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`;
	try {
		output = execFileSync("sh", ["-c", script], {
			cwd: repo.root,
			encoding: "utf8",
			env: { ...process.env, PATH: search },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		code = err.status ?? 1;
		output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	const argsPath = path.join(repo.root, ARGS_FILE);
	const lines = fs.existsSync(argsPath)
		? fs.readFileSync(argsPath, "utf8").split("\n").filter(Boolean)
		: [];
	return {
		code,
		output,
		args: lines.filter((l) => !l.startsWith("argc=")),
		invoked: lines.some((l) => l.startsWith("argc=")),
	};
}

const WORKFLOW = ".github/workflows/ci.yml";
const OUTSIDE = "scripts/thing.js";
const BODY =
	"name: t\non: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n";

describe("the pre-commit actionlint gate", () => {
	it("does not run actionlint when the commit stages no workflow file", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n", "docs/x.md": "# x\n" },
			actionlintExit: 1,
		});
		const { code, invoked } = runGate(repo);
		expect(invoked).toBe(false);
		expect(code).toBe(0);
	});

	it("does not fire on a YAML file outside .github/workflows/", () => {
		const repo = fixture({
			staged: { ".github/dependabot.yml": BODY, "docs/x.yaml": BODY },
			actionlintExit: 1,
		});
		expect(runGate(repo).invoked).toBe(false);
	});

	it("runs actionlint on a staged workflow and passes when it is green", () => {
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, actionlintExit: 0 });
		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(code).toBe(0);
	});

	it("hands actionlint one argument per staged path, a space inside one included (#5542)", () => {
		const spaced = ".github/workflows/two words.yml";
		const repo = fixture({
			staged: { [WORKFLOW]: BODY, [spaced]: BODY },
			actionlintExit: 0,
		});
		const { args } = runGate(repo);
		const lines = fs
			.readFileSync(path.join(repo.root, ARGS_FILE), "utf8")
			.split("\n");
		expect(lines[0]).toBe("argc=2");
		expect([...args].sort()).toEqual([WORKFLOW, spaced].sort());
	});

	it("matches the .yaml spelling as well as .yml", () => {
		const alt = ".github/workflows/new.yaml";
		const repo = fixture({ staged: { [alt]: BODY }, actionlintExit: 0 });
		expect(runGate(repo).args).toContain(alt);
	});

	it("fails the commit when actionlint exits non-zero", () => {
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, actionlintExit: 1 });
		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		expect(output).toMatch(/actionlint failed on this commit's own/);
	});

	it("hands actionlint only the commit's own workflow paths", () => {
		const repo = fixture({
			staged: { [WORKFLOW]: BODY, [OUTSIDE]: "const a = 1;\n" },
			actionlintExit: 0,
		});
		const { args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(OUTSIDE);
	});

	it("reads the commit's staged paths, NOT the whole workflows directory", () => {
		const tracked = ".github/workflows/untouched.yml";
		const repo = fixture({ staged: {}, actionlintExit: 0 });
		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(repo.root, tracked), BODY);
		repo.git("add", "--", tracked);
		repo.git("commit", "-qm", "tracked");

		fs.writeFileSync(path.join(repo.root, WORKFLOW), BODY);
		repo.git("add", "--", WORKFLOW);

		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(tracked);
		expect(code).toBe(0);
	});

	it("drops a deletion from a commit that ALSO stages a live workflow", () => {
		const gone = ".github/workflows/gone.yml";
		const repo = fixture({ staged: {}, actionlintExit: 0 });
		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(repo.root, gone),
			`name: gone\n${"# distinct\n".repeat(12)}on: workflow_dispatch\n`,
		);
		repo.git("add", "--", gone);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--", gone);

		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(repo.root, WORKFLOW), BODY);
		repo.git("add", "--", WORKFLOW);

		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(gone);
		expect(code).toBe(0);
	});

	it("drops a path the commit UNTRACKS but leaves on disk", () => {
		const untracked = ".github/workflows/retired.yml";
		const repo = fixture({ staged: {}, actionlintExit: 0 });
		fs.mkdirSync(path.join(repo.root, ".github", "workflows"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(repo.root, untracked),
			`name: retired\n${"# distinct\n".repeat(12)}on: workflow_dispatch\n`,
		);
		repo.git("add", "--", untracked);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--cached", "--", untracked);

		fs.writeFileSync(path.join(repo.root, WORKFLOW), BODY);
		repo.git("add", "--", WORKFLOW);

		const { code, args } = runGate(repo);
		expect(args).toContain(WORKFLOW);
		expect(args).not.toContain(untracked);
		expect(code).toBe(0);
	});

	it("does not invoke actionlint at all when every staged path has been deleted from the worktree", () => {
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, actionlintExit: 1 });
		fs.rmSync(path.join(repo.root, WORKFLOW));
		const { code, invoked } = runGate(repo);
		expect(invoked).toBe(false);
		expect(code).toBe(0);
	});

	it("warns and PASSES when actionlint is not on PATH", () => {
		const repo = fixture({ staged: { [WORKFLOW]: BODY }, stub: false });
		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toMatch(/actionlint is not on PATH — its gate is SKIPPED/);
		expect(output).toMatch(/NOT blocked/);
	});

	it("says nothing about a missing binary on a commit staging no workflow", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n" },
			stub: false,
		});
		expect(runGate(repo).output).not.toMatch(/SKIPPED/);
	});

	it("passes no flags, matching check:actions, which owns their rationale", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts["check:actions"]).toBe("actionlint");
		const invocation =
			/^\s*with_lines "\$tool_paths" hook_bound actionlint([^|]*)\|\| \{/m.exec(
				gateFragment(),
			);
		expect(
			invocation,
			"the gate no longer invokes `hook_bound actionlint` over $tool_paths ahead of a `||`",
		).not.toBeNull();
		expect((invocation as RegExpExecArray)[1].trim()).toBe("");
	});
});

describe("the CI half of the same gate", () => {
	const ci = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	);
	const step = (): string => {
		const m = /- name: actionlint\n((?:.*\n)*?) {6}- name:/.exec(ci);
		expect(
			m,
			"the actionlint step no longer parses out of ci.yml",
		).not.toBeNull();
		return (m as RegExpExecArray)[1];
	};

	it("runs the same npm script the local by-hand route does", () => {
		expect(step()).toContain("npm run check:actions");
	});

	it("hard-fails, carrying no continue-on-error and no absent-binary escape", () => {
		expect(step()).not.toContain("continue-on-error");
		expect(step()).not.toMatch(/command -v actionlint/);
	});

	it("pins the image to a tag AND a digest, and installs it before the step runs", () => {
		const install = /- name: Install actionlint\n((?:.*\n)*?) {6}- name:/.exec(
			ci,
		);
		expect(install, "no Install actionlint step in ci.yml").not.toBeNull();
		const body = (install as RegExpExecArray)[1];
		expect(body).toContain("uses: ./.github/actions/image-binary");
		expect(body).toMatch(/image: \S+:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\n/);
		expect(ci.indexOf("- name: Install actionlint")).toBeLessThan(
			ci.indexOf("- name: actionlint\n"),
		);
	});
});
