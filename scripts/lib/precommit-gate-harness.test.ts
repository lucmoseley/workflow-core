// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	armingPattern,
	cutGateFragment,
	expectFixtureSupplies,
	gateHead,
	gateTmpdir,
	linkedWorktree,
	newRepo,
	registerTempCleanup,
	stagedRepo,
} from "./precommit-gate-harness";
import { HOOK, ROOT, writeCheckerDelegates } from "./precommit-gate-testkit";
import { runInProcess } from "./run-in-process.js";

const temps = registerTempCleanup();

describe("cutGateFragment", () => {
	it("names the anchor it could not find", () => {
		expect(() => cutGateFragment("scripts/no-such-checker.js")).toThrow(
			/no scripts\/no-such-checker\.js gate found/,
		);
	});

	it("skips a comment naming the anchor and takes the call line", () => {
		expect(cutGateFragment("--broken-only")).toContain(
			"scripts/check-superseded-values.js",
		);
	});

	it("stops at the `fi` in column zero, not an indented one", () => {
		const fragment = cutGateFragment("command typecheck");
		const fis = fragment.split("\n").filter((l) => l.trim() === "fi");
		expect(fis.length).toBeGreaterThan(1);
		expect(fis.slice(0, -1).every((l) => l !== "fi")).toBe(true);
		expect(fragment.endsWith("\nfi")).toBe(true);
	});

	it("cuts a different block for each anchor", () => {
		expect(cutGateFragment("command typecheck")).not.toBe(
			cutGateFragment("scripts/check-vendored-skills.js"),
		);
	});

	it("names an anchor with no gate above it", () => {
		expect(() =>
			cutGateFragment("scripts/x.js", "echo hi\nnode scripts/x.js\n"),
		).toThrow(/scripts\/x\.js .*outside any gate/);
	});

	it("reports an unclosed gate", () => {
		expect(() =>
			cutGateFragment(
				"scripts/x.js",
				"if git diff --cached; then\n\tnode scripts/x.js\n",
			),
		).toThrow(/is unclosed/);
	});

	it("names an anchor outside any gate rather than returning the gate above it (#3511)", () => {
		expect(() =>
			cutGateFragment(
				"scripts/x.js",
				"if armed 'a'; then\n\tnode scripts/a.js\nfi\nnode scripts/x.js\n",
			),
		).toThrow(/scripts\/x\.js .*outside any gate/);
	});

	it("names an anchor after a gate closed by `fi # …`, not cutting through to the next gate's `fi` (#3511)", () => {
		expect(() =>
			cutGateFragment(
				"scripts/x.js",
				"if armed 'a'; then\n\t:\nfi # a\nnode scripts/x.js\nif armed 'b'; then\n\t:\nfi\n",
			),
		).toThrow(/scripts\/x\.js .*outside any gate/);
	});
});

describe("gateHead and armingPattern (#1597)", () => {
	it("reads a one-line head and its pattern", () => {
		const pattern = "^skills-lock\\.json$";
		expect(gateHead("scripts/check-vendored-skills.js")).toBe(
			`if armed '${pattern}'; then\n`,
		);
		expect(armingPattern("scripts/check-vendored-skills.js")).toBe(pattern);
	});

	it("reads a head wrapped across lines through its `then`", () => {
		const hook =
			"if armed '^a/' &&\n  [ -f x ]; then\n\tnode scripts/x.js\nfi\n";
		expect(gateHead("scripts/x.js", hook)).toBe(
			"if armed '^a/' &&\n  [ -f x ]; then\n",
		);
		expect(armingPattern("scripts/x.js", hook)).toBe("^a/");
	});

	it("reads a head whose `then` carries a trailing comment", () => {
		const hook = "if armed '^a/'; then # why\n\tnode scripts/x.js\nfi\n";
		expect(gateHead("scripts/x.js", hook)).toBe("if armed '^a/'; then # why\n");
	});

	it("takes the first pattern where a head arms on two", () => {
		const hook =
			"if armed '^a/' ||\n  armed '^b/'; then\n\tnode scripts/x.js\nfi\n";
		expect(armingPattern("scripts/x.js", hook)).toBe("^a/");
	});

	it("names the gate whose head never reaches `then`", () => {
		const hook = "if armed '^a/'\n\tnode scripts/x.js\nfi\n";
		expect(() => gateHead("scripts/x.js", hook)).toThrow(
			/the scripts\/x\.js gate .* has no `then`/,
		);
		expect(() => armingPattern("scripts/x.js", hook)).toThrow(
			/the scripts\/x\.js gate .* has no `then`/,
		);
	});

	it("names the gate whose head passes `armed` no single-quoted pattern", () => {
		const hook = 'if armed "$P"; then\n\tnode scripts/x.js\nfi\n';
		expect(() => armingPattern("scripts/x.js", hook)).toThrow(
			/the scripts\/x\.js gate .* no single-quoted pattern/,
		);
	});
});

const invokedBy = (anchor: string, hook?: string): string[] => {
	try {
		expectFixtureSupplies(anchor, [], hook);
		return [];
	} catch (e) {
		const listed = /gate invokes \[([^\]]*)\]/.exec((e as Error).message);
		if (!listed) throw e;
		return listed[1] ? listed[1].split(", ") : [];
	}
};

describe("the scripts a gate invokes", () => {
	it("finds a call inside a single-quoted string handed to staged_gate", () => {
		expect(invokedBy("--broken-only")).toEqual([
			"scripts/check-superseded-values.js",
		]);
	});

	it("finds a call inside a command substitution, alongside the direct call after it", () => {
		expect(invokedBy("check-ruff-introduced.js")).toEqual([
			"scripts/check-ruff-introduced.js",
			"scripts/lib/formatters.js",
		]);
	});

	it("de-duplicates a script the fragment calls more than once", () => {
		const invoked = invokedBy("check-ruff-introduced.js");
		expect(
			invoked.filter((s) => s === "scripts/lib/formatters.js"),
		).toHaveLength(1);
	});

	it("returns nothing for a gate that calls no repo script", () => {
		expect(invokedBy("hook_bound actionlint")).toEqual([]);
	});

	it("never reports a scripts/… path quoted inside a message string", () => {
		expect(
			invokedBy(
				"see scripts/foo.js",
				'if git diff --cached; then\n\techo "see scripts/foo.js for details" >&2\nfi\n',
			),
		).toEqual([]);
	});

	it("skips a comment naming a script rather than calling it", () => {
		expect(
			invokedBy(
				"node scripts/real.js",
				"if git diff --cached; then\n\t# node scripts/foo.js\n\tnode scripts/real.js\nfi\n",
			),
		).toEqual(["scripts/real.js"]);
	});

	it("matches bash and sh as well as node", () => {
		expect(
			invokedBy(
				"bash scripts/a.sh",
				"if git diff --cached; then\n\tbash scripts/a.sh\n\tsh scripts/b.sh\nfi\n",
			),
		).toEqual(["scripts/a.sh", "scripts/b.sh"]);
	});

	it.each([
		[
			"upstream-record",
			"scripts/check-vendored-skills.js",
			["scripts/check-vendored-skills.js"],
		],
		[
			"digest-version",
			"scripts/check-digest-version.js",
			["scripts/check-digest-version.js"],
		],
		[
			"superseded-needle",
			"--broken-only",
			["scripts/check-superseded-values.js"],
		],
		[
			"eslint",
			"--no-error-on-unmatched-pattern",
			["scripts/lib/workflow-core-config.js"],
		],
		["shellcheck", "shellcheck -x", ["scripts/lib/serialised.sh"]],
		[
			"ruff",
			"check-ruff-introduced.js",
			["scripts/check-ruff-introduced.js", "scripts/lib/formatters.js"],
		],
		[
			"swallowed-errors",
			"check-swallowed-errors.js",
			["scripts/check-swallowed-errors.js"],
		],
		["actionlint", "hook_bound actionlint", []],
	] as const)(
		"matches the live .husky/pre-commit exactly on the %s gate",
		(_name, anchor, supplied) => {
			expect(invokedBy(anchor)).toEqual([...supplied].sort());
		},
	);
});

describe("expectFixtureSupplies", () => {
	it("passes silently when the fixture matches the gate", () => {
		expect(() =>
			expectFixtureSupplies("--broken-only", [
				"scripts/check-superseded-values.js",
			]),
		).not.toThrow();
	});

	it("names the missing script and the gate on a short supply list", () => {
		expect(() => expectFixtureSupplies("--broken-only", [])).toThrow(
			/--broken-only gate invokes \[scripts\/check-superseded-values\.js\].*missing from the fixture: scripts\/check-superseded-values\.js/s,
		);
	});

	it("also names an extra the fixture supplies but the gate never calls", () => {
		expect(() =>
			expectFixtureSupplies("--broken-only", [
				"scripts/check-superseded-values.js",
				"scripts/unused.js",
			]),
		).toThrow(/supplied but never invoked: scripts\/unused\.js/);
	});
});

describe("newRepo", () => {
	it("returns a repo git can commit in", () => {
		const { root, git } = newRepo("harness-", temps);
		fs.writeFileSync(path.join(root, "a.txt"), "a\n");
		git("add", "--", "a.txt");
		git("commit", "-qm", "a");

		expect(String(git("log", "--oneline"))).toContain("a");
	});

	it("registers the root for cleanup rather than removing it itself", () => {
		const { root } = newRepo("harness-", temps);

		expect(temps).toContain(root);
		expect(fs.existsSync(root)).toBe(true);
	});

	it("hands back a fresh directory each time", () => {
		expect(newRepo("harness-", temps).root).not.toBe(
			newRepo("harness-", temps).root,
		);
	});
});

describe("linkedWorktree (#5832)", () => {
	it("checks out the repo's HEAD in a worktree git lists, its parent registered for cleanup", () => {
		const repo = stagedRepo("harness-", temps, {}, {});
		const wt = linkedWorktree(repo, temps);

		expect(temps).toContain(path.dirname(wt));
		expect(fs.readFileSync(path.join(wt, "seed.txt"), "utf8")).toBe("seed\n");
		expect(String(repo.git("worktree", "list", "--porcelain"))).toContain(
			`worktree ${fs.realpathSync(wt)}\n`,
		);
		expect(
			String(repo.git("-C", wt, "rev-parse", "--abbrev-ref", "HEAD")),
		).toBe("HEAD\n");
	});
});

describe("stagedRepo", () => {
	it("commits the seed and `committed`, and stages `staged` over them", () => {
		const { git } = stagedRepo(
			"harness-",
			temps,
			{ "a/kept.txt": "old\n" },
			{ "a/kept.txt": "new\n", "b/c/added.txt": "x\n" },
		);

		expect(String(git("ls-tree", "-r", "--name-only", "HEAD"))).toBe(
			"a/kept.txt\nseed.txt\n",
		);
		expect(String(git("diff", "--cached", "--name-status"))).toBe(
			"M\ta/kept.txt\nA\tb/c/added.txt\n",
		);
	});
});

describe("gateTmpdir (#2648)", () => {
	it("makes a directory inside the repo's own .git that no status reports, and hands the same one back", () => {
		const { root, git } = newRepo("harness-", temps);
		const dir = gateTmpdir(root);
		fs.writeFileSync(path.join(dir, "wfc-shellcheck.lock"), "");

		expect(dir.startsWith(path.join(root, ".git") + path.sep)).toBe(true);
		expect(String(git("status", "--porcelain", "--ignored"))).toBe("");
		expect(gateTmpdir(root)).toBe(dir);
	});
});

describe("writeCheckerDelegates (mantahostels#2073)", () => {
	const fixtureName = `__precommit-gate-harness-test-fixture-${process.pid}.js`;
	const fixturePath = path.join(ROOT, "scripts", fixtureName);

	afterEach(() => {
		fs.rmSync(fixturePath, { force: true });
	});

	it("propagates a non-zero child exit status when the real checker refuses", () => {
		fs.writeFileSync(
			fixturePath,
			"process.exit(process.argv[2] === 'refuse' ? 1 : 0);\n",
		);
		const { root } = newRepo("delegate-", temps);
		writeCheckerDelegates(root, [fixtureName]);
		const delegate = path.join(root, "scripts", fixtureName);

		expect(runInProcess(delegate, ["refuse"]).status).toBe(1);
		expect(runInProcess(delegate, ["pass"]).status).toBe(0);
	});

	it("pins 128 + signal number when the real checker dies to a signal, distinct from a refusal's exit 1 (mantahostels#2128)", () => {
		fs.writeFileSync(fixturePath, "process.kill(process.pid, 'SIGTERM');\n");
		const { root } = newRepo("delegate-", temps);
		writeCheckerDelegates(root, [fixtureName]);
		const delegate = path.join(root, "scripts", fixtureName);

		const result = runInProcess(delegate);

		expect(result.status).toBe(128 + os.constants.signals.SIGTERM);
		expect(result.status).not.toBe(1);
	});

	it("writes a delegate that calls spawnSync and never bare-requires a real repo path", () => {
		const { root } = newRepo("delegate-", temps);
		writeCheckerDelegates(root, [fixtureName]);
		const body = fs.readFileSync(
			path.join(root, "scripts", fixtureName),
			"utf8",
		);

		expect(body).toContain("spawnSync");
		const required = [...body.matchAll(/require\(\s*(['"])(.*?)\1\s*\)/g)].map(
			(m) => m[2],
		);
		expect(required).toEqual(["node:child_process", "node:os"]);
	});
});

describe("registerTempCleanup", () => {
	it("drains its own array, leaving another suite's untouched", () => {
		const mine = [fs.mkdtempSync(path.join(os.tmpdir(), "harness-drain-"))];
		const theirs = [...mine];

		for (const t of mine.splice(0))
			fs.rmSync(t, { recursive: true, force: true });

		expect(mine).toHaveLength(0);
		expect(theirs).toHaveLength(1);
		expect(fs.existsSync(theirs[0])).toBe(false);
	});
});

describe("HOOK", () => {
	it("is the live .husky/pre-commit, read once", () => {
		expect(HOOK).toBe(
			fs.readFileSync(
				path.join(__dirname, "..", "..", ".husky", "pre-commit"),
				"utf8",
			),
		);
	});
});
