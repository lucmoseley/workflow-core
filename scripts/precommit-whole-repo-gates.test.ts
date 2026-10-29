// @vitest-environment node
/*
 * Pins the whole-repo pre-commit gates (mantahostels#1753) — guard-registry,
 * guard-test-isolation, git-fixture-identity, jsonl-reads, report-programs, cli-args and test-spawn — exercised as the
 * shell they are: each one call, `--against HEAD` for a direction-gated gate
 * and bare for a whole-tree one, refusing with the checker's own exit code,
 * and, for a direction-gated one, the `--root` each side of the comparison is
 * read through.
 *
 * The shell is one line each, and what `--against HEAD` does is proved once,
 * against a fake check, in scripts/lib/check.test.ts. What is left here is what
 * only the hook can answer. Each checker is stubbed in a throwaway repo, the
 * shared tree's index being repo-global (mantahostels#63).
 *
 * They are hard gates in `.husky/pre-commit`: loosen a case and a commit adding
 * a new fault — a rule claiming backing it lacks, a test escaping its fixture —
 * lands unrefused, or a direction-gated one is refused for faults it inherited.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cutGateScript,
	expectFixtureSupplies,
	newRepo,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { coreCall, HOOK, LIB, ROOT } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const temps = registerTempCleanup();

const GATES = [
	{
		profile: "guard-registry",
		checker: "scripts/check-guard-registry.js",
		/** A path in this gate's `git diff --cached` condition. */
		staged: "scripts/guard-x.sh",
		/** What the hook line hands the checker. */
		args: "--against HEAD",
	},
	{
		profile: "guard-test-isolation",
		checker: "scripts/check-guard-test-isolation.js",
		staged: "scripts/a.test.ts",
		args: "--against HEAD",
	},
	{
		profile: "git-fixture-identity",
		checker: "scripts/check-git-fixture-identity.js",
		staged: "scripts/a.test.ts",
		args: "--against HEAD",
	},
	{
		profile: "jsonl-reads",
		checker: "scripts/check-jsonl-reads.js",
		staged: "scripts/a.js",
		args: "",
	},
	{
		profile: "report-programs",
		checker: "scripts/check-report-programs.js",
		staged: "scripts/report-a.js",
		args: "",
	},
	{
		profile: "cli-args",
		checker: "scripts/check-cli-args.js",
		staged: "scripts/a.js",
		args: "--against HEAD",
	},
	{
		profile: "test-spawn",
		checker: "scripts/check-test-spawn.js",
		staged: "scripts/a.test.ts",
		args: "",
	},
];

const STUB_MARKER = "STUB-CHECK-RAN";

/** A git repo with one commit and a stubbed checker whose exit code is ours to choose. */
function fixture(opts: {
	checker: string;
	staged: string;
	checkerExit: number;
}): { root: string; git: (...args: string[]) => Buffer } {
	const checker =
		`const fs = require("node:fs");\n` +
		`console.log("${STUB_MARKER}");\n` +
		`fs.appendFileSync("argv.log", process.argv.slice(2).join(" ") + "\\n");\n` +
		`process.exit(${opts.checkerExit});\n`;
	return stagedRepo(
		"whole-repo-gate-",
		temps,
		{ [opts.checker]: checker },
		{ [opts.staged]: "x\n" },
	);
}

/** The fixture above, but committing `from` and staging its `git mv` to `to`. */
function renamed(checker: string, from: string, to: string): string {
	const { root, git } = fixture({ checker, staged: from, checkerExit: 1 });
	git("commit", "-qm", "add");
	fs.mkdirSync(path.join(root, path.dirname(to)), { recursive: true });
	git("mv", "--", from, to);
	return root;
}

/*
 * spawnSync, not execFileSync: the gate's verdicts go to stderr, and
 * execFileSync returns stdout alone on a zero exit.
 *
 * `-e` because husky runs the hook under `sh -e`, where an unconsumed non-zero
 * status aborts the file rather than falling through.
 */
function runGate(
	cwd: string,
	fragment: string,
): { code: number; output: string } {
	const run = spawnSync("sh", ["-ec", fragment], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GITHUB_ACTIONS: "" },
	});
	return {
		code: run.status ?? 1,
		output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
	};
}

const readLog = (root: string, name: string) =>
	fs.existsSync(path.join(root, name))
		? fs.readFileSync(path.join(root, name), "utf8")
		: "";

describe.each(GATES)("the pre-commit $profile gate", (gate) => {
	const fragment = () => cutGateScript(gate.checker);
	const build = (checkerExit: number) =>
		fixture({ checker: gate.checker, staged: gate.staged, checkerExit }).root;

	it("is wired into .husky/pre-commit as one call", () => {
		expect(HOOK).toContain(
			`${coreCall("node", gate.checker)}${gate.args ? ` ${gate.args}` : ""} || exit "$?"`,
		);
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(gate.checker, [gate.checker]);
	});

	it("names a profile lib/fault-profiles.js actually carries", () => {
		const { PROFILES } = require("./lib/fault-profiles.js");
		expect(Object.keys(PROFILES)).toContain(gate.profile);
	});

	it("hands the checker its args and nothing else", () => {
		const root = build(0);

		runGate(root, fragment());

		expect(readLog(root, "argv.log").trim()).toBe(gate.args);
	});

	/* The hook line must not swallow the checker's own report. lib/check.test.ts
	 * proves the LIBRARY streams it, and nothing but this proves `|| exit "$?"`
	 * leaves it alone. */
	it.each([0, 1, 2])(
		"passes the checker's own report through on exit %i",
		(code) => {
			expect(runGate(build(code), fragment()).output).toContain(STUB_MARKER);
		},
	);

	it("passes a green run", () => {
		expect(runGate(build(0), fragment()).code).toBe(0);
	});

	/* The checker's alphabet reaches the session intact: a BROKEN 2 must stay
	 * distinguishable from a fault this commit adds (1), because they call for
	 * different acts (mantahostels#155). */
	// exempt (mantahostels#2081): the STUB_MARKER pin for exit 1 and 2 is carried by
	// "passes the checker's own report through on exit %i" above, run over
	// [0, 1, 2]. This test's own residual claim — that the observed code came
	// from the checker and not some other non-zero route — is what its
	// `.toBe(code)` structural pin proves; the marker pin alone would not.
	it.each([1, 2])("refuses with the checker's own exit code %i", (code) => {
		expect(runGate(build(code), fragment()).code).toBe(code);
	});

	/* After `git mv`, a bare `--name-only` prints the new name alone, so a move
	 * out of the condition armed nothing. */
	it("fires on a rename out of its condition (#1483)", () => {
		const root = renamed(
			gate.checker,
			gate.staged,
			`bin/${path.basename(gate.staged)}`,
		);

		const { code, output } = runGate(root, fragment());

		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not fire on a rename with neither end in its condition", () => {
		const root = renamed(gate.checker, "app/page.tsx", "bin/page.tsx");

		const { code, output } = runGate(root, fragment());

		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("does not fire on a commit outside its condition", () => {
		const { root } = fixture({
			checker: gate.checker,
			staged: "app/page.tsx",
			checkerExit: 1,
		});

		const { code, output } = runGate(root, fragment());

		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});
});

describe("the shell's direction gate (mantahostels#1793)", () => {
	it("keeps gate_direction for its one caller, the doc map", () => {
		// Spelled out deliberately, for its --map-dirty flag, temp index and
		// untracked-entry replay (mantahostels#1793).
		expect(LIB).toContain("gate_direction() {");
		expect(HOOK).toContain("gate_direction doc-map");
	});
});

describe("the --root each side of the comparison is read through", () => {
	/* An EMPTY tree, because a --root silently ignored answers about the live
	 * worktree, which is the one answer an empty tree cannot produce. */
	const emptyTree = () => newRepo("empty-root-", temps).root;

	const runChecker = (checker: string, args: string[]) =>
		runInProcess(path.join(ROOT, "scripts", checker), args, {
			cwd: ROOT,
			env: { ...process.env, GITHUB_ACTIONS: "" },
		});

	it("reads check-guard-registry.js's --root, not its own directory", () => {
		const r = runChecker("check-guard-registry.js", [
			"--root",
			emptyTree(),
			"--json",
		]);

		const envelope = JSON.parse(r.stdout);
		expect(envelope.ruleCount).toBe(0);
		const tags = envelope.findings.map((f: { tag: string }) => f.tag);
		expect(tags).toContain("NO-REGION");
	});

	const plantedStore = (root: string) => {
		const store = path.join(root, "docs", "agents", "rules");
		fs.mkdirSync(store, { recursive: true });
		fs.writeFileSync(path.join(store, "rule-planted.txt"), "planted\n");
		fs.writeFileSync(
			path.join(store, "manifest.json"),
			JSON.stringify({ "rule-planted": {} }),
		);
	};

	it("points the rule-text store at --root's own store, not the live worktree", () => {
		/* A CORE tree, which is what --against materialises here: the checker's
		 * own file in it is what marks it one. */
		const root = emptyTree();
		plantedStore(root);
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "check-guard-registry.js"), "");
		fs.mkdirSync(path.join(root, "self-plugin", "hooks"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "self-plugin", "hooks", "hooks.json"),
			'{"hooks": {}}',
		);
		const r = runChecker("check-guard-registry.js", ["--root", root, "--json"]);

		expect(JSON.parse(r.stdout).ruleStore.fragments).toEqual(["rule-planted"]);
	});

	it("layers an adopter --root's own store over the CORE's", () => {
		/* An adopter that generates a fragment still reads every core guard's
		 * from the plugin (#97). */
		const root = emptyTree();
		plantedStore(root);
		const r = runChecker("check-guard-registry.js", ["--root", root, "--json"]);

		const { fragments } = JSON.parse(r.stdout).ruleStore;
		expect(fragments).toContain("rule-planted");
		expect(fragments.length).toBeGreaterThan(50);
	});

	it("falls back to the CORE's store where --root has none of its own", () => {
		/* An adopter never copies the fragments — they ship in the plugin — so
		 * pinning its absent store would call every rule id in its rules file
		 * unresolvable (#5). */
		const r = runChecker("check-guard-registry.js", [
			"--root",
			emptyTree(),
			"--json",
		]);

		expect(JSON.parse(r.stdout).ruleStore.fragments.length).toBeGreaterThan(50);
	});

	it("reads check-guard-test-isolation.js's --root instead of asking git", () => {
		// Its live scope comes from `git ls-files`, which in a temp directory would
		// read the enclosing repo or nothing at all.
		const r = runChecker("check-guard-test-isolation.js", [
			"--root",
			emptyTree(),
			"--json",
		]);

		expect(JSON.parse(r.stdout).scanned).toBe(0);
	});

	/* --review writes anchors back into the tree it read, so both flags that
	 * point the read somewhere throwaway must refuse it (mantahostels#1833). */
	it.each([
		["--root", ["--review", "--root", "<tree>"]],
		["--against", ["--review", "--against", "HEAD"]],
	])("refuses --review under %s", (flag, args) => {
		const r = runChecker(
			"check-guard-registry.js",
			args.map((a) => (a === "<tree>" ? emptyTree() : a)),
		);

		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toContain(`cannot run under ${flag}`);
	});
});
