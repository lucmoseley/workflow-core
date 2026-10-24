// @vitest-environment node
/*
 * The pre-commit ESLint gate (mantahostels#1133), exercised as the shell it is.
 *
 * `.husky/pre-commit` runs ESLint only when the commit stages an `app/` or
 * `lib/` `.ts`/`.tsx` file, hands it exactly those paths, and fails the commit
 * when ESLint exits non-zero.
 *
 * The gate is HARD-FAILING, unlike the tsc gate directly above it in the hook,
 * because ESLint takes explicit paths and so never reads a parallel session's
 * half-written file — the shared-tree hazard that forced tsc to warn-only at
 * mantahostels#1062.
 *
 * ESLint itself is stubbed as a script on PATH, so both exit codes are ours to
 * drive and no case depends on the repo's real findings. The CI half, `ci.yml`'s
 * Lint and tests job, is read from the file and pinned too.
 *
 * Both halves are hard gates: loosen a case and an ESLint finding in `app/` or
 * `lib/` — the product's own code — lands on `main` unrefused.
 */

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
import { copyRequireClosure } from "./lib/require-closure";

const temps = registerTempCleanup();

// Anchored on --no-error-on-unmatched-pattern, not on --max-warnings 0: the
// cutter must survive a mutation to the flag the cases below assert, or
// removing that flag would break every case by throwing rather than by
// failing the one that guards it.
const gateFragment = () => cutGateFragment("--no-error-on-unmatched-pattern");

/** Where the stub records the argv it was handed, one path per line. */
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
		`#!/bin/sh\nprintf '%s\\n' "$@" >>"${path.join(root, ARGS_FILE)}"\nexit ${opts.eslintExit}\n`,
	);
	fs.chmodSync(stub, 0o755);

	// The gate runs only where the adopter declares `commands.lint` (#2), which
	// it asks the real config reader.
	copyRequireClosure(root, ROOT, [
		"scripts/lib/workflow-core-config.js",
		"scripts/lib/host-root.js",
		"scripts/lib/caught.js",
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
		// A trailing no-op stands in for the rest of the hook, which really does
		// continue past this gate. Without it the fragment's own exit status is
		// ESLint's, and the `|| { … exit 1; }` block could be deleted with every
		// case still green.
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

/** A file ESLint would match, and one it would not, for the scope cases. */
const INSIDE = "app/page.tsx";
const OUTSIDE = "scripts/thing.ts";

describe("the pre-commit ESLint gate", () => {
	it("does not run ESLint when the commit stages nothing under app/ or lib/", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "export const a = 1;\n", "docs/x.md": "# x\n" },
			// Red, so a gate that fired anyway would fail the case rather than
			// passing by luck.
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
		// The case above is passed by a gate whose guard `if` filters deletions
		// but whose path list does not, because nothing fires it at all. This one
		// forces the gate open with a live file, so the deletion can only be kept
		// out by the --diff-filter on the path list itself. Without it ESLint is
		// handed a path with no file behind it (mantahostels#1133).
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

	// Two spellings of one scope: widening eslint.config.mjs alone would leave a
	// gate that silently never fires on the new directory.
	it("scopes to the same directories eslint.config.mjs declares", () => {
		const config = fs.readFileSync(
			path.join(ROOT, "eslint.config.mjs"),
			"utf8",
		);
		const declared = [...config.matchAll(/"(\w+)\/\*\*\/\*\.\{ts,tsx\}"/g)]
			.map((m) => m[1])
			.sort();
		expect(declared.length).toBeGreaterThan(0);

		const grep = /^\^\(([^)]*)\)/.exec(
			armingPattern("--no-error-on-unmatched-pattern"),
		);
		expect(grep, "the gate's arming pattern no longer parses").not.toBeNull();
		expect((grep as RegExpExecArray)[1].split("|").sort()).toEqual(declared);
	});
});

describe("the CI half of the same gate", () => {
	const ci = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	);

	it("runs ESLint in the existing Lint and tests job", () => {
		// A step, not a job: Actions bills a one-minute minimum per job.
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
		// `npm run lint` must route through it, or the by-hand command and the
		// gate would disagree about what counts as a finding.
		expect(pkg.scripts.lint).toContain("check:eslint");
	});
});
