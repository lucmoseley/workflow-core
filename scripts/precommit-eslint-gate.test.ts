// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	armingPattern,
	cutGateFragment,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { LIB, ROOT } from "./lib/precommit-gate-testkit";
import { copyRequireClosure, launchedScripts } from "./lib/require-closure";
import { shellQuote } from "./lib/sh-quote.js";

const temps = registerTempCleanup();

const gateFragment = () => cutGateFragment("--no-error-on-unmatched-pattern");

const ARGS_FILE = "eslint-args.txt";

/**
 * A git repo with one commit, a stubbed `eslint` on PATH whose exit code is
 * ours to choose, and `staged` written and staged. Nothing else is staged.
 */
function fixture(opts: {
	staged: Record<string, string>;
	eslintExit: number;
}): TempRepo & { bin: string } {
	const repo = stagedRepo("eslint-gate-", temps, {}, opts.staged);
	const { root } = repo;

	const bin = path.join(root, "stub-bin");
	fs.mkdirSync(bin, { recursive: true });
	const stub = path.join(bin, "eslint");
	fs.writeFileSync(
		stub,
		`#!/bin/sh\nprintf '%s\\n' "$@" >>${shellQuote(path.join(root, ARGS_FILE))}\nexit ${opts.eslintExit}\n`,
	);
	fs.chmodSync(stub, 0o755);

	copyRequireClosure(root, ROOT, [
		"scripts/lib/workflow-core-config.js",
		"scripts/lib/host-root.js",
		"scripts/lib/caught.js",
		...launchedScripts(`${LIB}\n${gateFragment()}`),
	]);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude/workflow-core.json"),
		JSON.stringify({ commands: { lint: "npm run lint" } }),
	);

	return { ...repo, bin };
}

function runGate(
	repo: { root: string; bin: string },
	fragment: string = gateFragment(),
): { code: number; output: string; args: string[] } {
	let code = 0;
	let output = "";
	try {
		output = execFileSync("sh", ["-c", `${LIB}\n${fragment}\n:\n`], {
			cwd: repo.root,
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: repo.root,
				PATH: `${repo.bin}:${process.env.PATH}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		code = err.status ?? 1;
		output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	const argsPath = path.join(repo.root, ARGS_FILE);
	const args = fs.existsSync(argsPath)
		? fs.readFileSync(argsPath, "utf8").split("\n").filter(Boolean)
		: [];
	return { code, output, args };
}

const INSIDE = "app/page.tsx";
const OUTSIDE = "hooks/thing.ts";

describe("the pre-commit ESLint gate", () => {
	it("does not run ESLint when the commit stages nothing under app/, lib/ or scripts/", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "export const a = 1;\n", "docs/x.md": "# x\n" },
			eslintExit: 1,
		});
		const { code, args } = runGate(repo);
		expect(args).toEqual([]);
		expect(code).toBe(0);
	});

	it("runs ESLint on a staged app/ path and passes when ESLint is green", () => {
		const repo = fixture({
			staged: { [INSIDE]: "export default function P() { return null; }\n" },
			eslintExit: 0,
		});
		const { code, args } = runGate(repo);
		expect(args).toContain(INSIDE);
		expect(code).toBe(0);
	});

	it("runs ESLint on a staged lib/ path too", () => {
		const repo = fixture({
			staged: { "lib/review-strip/x.ts": "export const a = 1;\n" },
			eslintExit: 0,
		});
		expect(runGate(repo).args).toContain("lib/review-strip/x.ts");
	});

	it.each(["scripts/thing.js", "scripts/lib/thing.ts"])(
		"runs ESLint on the staged scripts/ path %s",
		(file) => {
			const repo = fixture({
				staged: { [file]: "export const a = 1;\n" },
				eslintExit: 0,
			});
			expect(runGate(repo).args).toContain(file);
		},
	);

	it("fails the commit when ESLint exits non-zero", () => {
		const repo = fixture({
			staged: { [INSIDE]: "export default function P() { return null; }\n" },
			eslintExit: 1,
		});
		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		expect(output).toMatch(/ESLint failed on this commit's own/);
	});

	it("hands ESLint only the commit's own in-scope paths", () => {
		const repo = fixture({
			staged: {
				[INSIDE]: "export default function P() { return null; }\n",
				[OUTSIDE]: "export const a = 1;\n",
			},
			eslintExit: 0,
		});
		const { args } = runGate(repo);
		expect(args).toContain(INSIDE);
		expect(args).not.toContain(OUTSIDE);
	});

	it("leaves a staged DELETION out, its worktree path being gone", () => {
		const repo = fixture({ staged: {}, eslintExit: 0 });
		fs.mkdirSync(path.join(repo.root, "app"), { recursive: true });
		fs.writeFileSync(path.join(repo.root, INSIDE), "export const a = 1;\n");
		repo.git("add", "--", INSIDE);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--", INSIDE);
		const { code, args } = runGate(repo);
		expect(args).not.toContain(INSIDE);
		expect(code).toBe(0);
	});

	it("drops a deletion from a commit that ALSO stages a live in-scope file", () => {
		const gone = "lib/review-strip/gone.ts";
		const repo = fixture({ staged: {}, eslintExit: 0 });
		fs.mkdirSync(path.join(repo.root, "lib", "review-strip"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(repo.root, gone), "export const a = 1;\n");
		repo.git("add", "--", gone);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--", gone);

		fs.mkdirSync(path.join(repo.root, "app"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.root, INSIDE),
			"export default function P() { return null; }\n",
		);
		repo.git("add", "--", INSIDE);

		const { code, args } = runGate(repo);
		expect(args).toContain(INSIDE);
		expect(args).not.toContain(gone);
		expect(code).toBe(0);
	});

	it("carries --max-warnings 0, without which a warn-only file passes", () => {
		expect(gateFragment()).toContain("--max-warnings 0");
	});

	it("carries --no-warn-ignored, without which a scripts/ test file refuses the commit", () => {
		expect(gateFragment()).toContain("--no-warn-ignored");
	});

	it("scopes to the same directories eslint.config.mjs declares", () => {
		const config = fs.readFileSync(
			path.join(ROOT, "eslint.config.mjs"),
			"utf8",
		);
		const declared = [...config.matchAll(/files: \[([^\]]*)\]/g)].flatMap((m) =>
			[...(m[1] ?? "").matchAll(/"(\w+)\/\*\*\/\*\.\{([^}]*)\}"/g)].flatMap(
				(g) => (g[2] ?? "").split(",").map((ext) => `${g[1]}/*.${ext}`),
			),
		);
		expect(declared.length).toBeGreaterThan(0);

		const branches = armingPattern("--no-error-on-unmatched-pattern")
			.split("|^")
			.map((b) => /^\^?\(?([^)]*)\)?\/\.\*\\\.\(([^)]*)\)\$$/.exec(b));
		expect(
			branches.every(Boolean),
			"the gate's arming pattern no longer parses",
		).toBe(true);
		const armed = branches.flatMap((b) => {
			const [, dirs = "", exts = ""] = b as RegExpExecArray;
			return dirs
				.split("|")
				.flatMap((d) => exts.split("|").map((ext) => `${d}/*.${ext}`));
		});
		expect(armed.sort()).toEqual(declared.sort());
	});
});

describe("the CI half of the same gate", () => {
	const ci = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	);

	it("runs ESLint in the existing Lint and tests job", () => {
		expect(ci).toContain("run: npm run check:eslint");
		expect(ci.split("jobs:")[1]).toMatch(/- name: ESLint/);
	});

	it("hard-fails, carrying no continue-on-error", () => {
		const step = /- name: ESLint\n((?:.*\n)*?) {6}- name:/.exec(ci);
		expect(
			step,
			"the ESLint step no longer parses out of ci.yml",
		).not.toBeNull();
		expect((step as RegExpExecArray)[1]).not.toContain("continue-on-error");
	});
});

describe("the npm script both halves lean on", () => {
	it("keeps --max-warnings 0 on check:eslint", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts["check:eslint"]).toContain("--max-warnings 0");
		expect(pkg.scripts.lint).toContain("check:eslint");
	});
});
