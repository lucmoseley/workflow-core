// @vitest-environment node
/*
 * The harness's error contract (mantahostels#953), and the fixture helpers every
 * pre-commit gate suite builds on.
 *
 * `cutGateFragment` is the single cutter behind every gate suite but
 * precommit-staged-gate.test.ts, so a silent miss here empties them all at
 * once — each `.husky/pre-commit` gate they cover then goes untested while CI
 * stays green.
 *
 * The hook text is injected rather than read from disk wherever a case needs a
 * malformed one: .husky/pre-commit is repo-global (mantahostels#63), and no test may edit it.
 *
 * The invoked-scripts `it.each` pins the exact script list of each gate it
 * lists (mantahostels#2071); the other gate suites pin theirs through
 * `expectFixtureSupplies`.
 *
 * `writeCheckerDelegates` lives in precommit-gate-testkit.ts but is tested
 * here, so the fixture name the repo ignore list and plugin-tree.js pin stays
 * put.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	armingPattern,
	cutGateFragment,
	expectFixtureSupplies,
	gateHead,
	newRepo,
	registerTempCleanup,
	stagedRepo,
} from "./precommit-gate-harness";
import { HOOK, ROOT, writeCheckerDelegates } from "./precommit-gate-testkit";

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
		// The doc-map gate nests several `if`s, so every `fi` but the last is
		// indented.
		const fragment = cutGateFragment("scripts/check-doc-map.js");
		const fis = fragment.split("\n").filter((l) => l.trim() === "fi");
		expect(fis.length).toBeGreaterThan(1);
		expect(fis.slice(0, -1).every((l) => l !== "fi")).toBe(true);
		expect(fragment.endsWith("\nfi")).toBe(true);
	});

	it("cuts a different block for each anchor", () => {
		expect(cutGateFragment("scripts/check-doc-map.js")).not.toBe(
			cutGateFragment("scripts/check-roadmap-valid.js"),
		);
	});

	it("reports a gate with no `if` line above it", () => {
		expect(() =>
			cutGateFragment("scripts/x.js", "echo hi\nnode scripts/x.js\n"),
		).toThrow(/has no `if`/);
	});

	it("reports an unclosed gate", () => {
		expect(() =>
			cutGateFragment(
				"scripts/x.js",
				"if git diff --cached; then\n\tnode scripts/x.js\n",
			),
		).toThrow(/is unclosed/);
	});
});

describe("gateHead and armingPattern (#1597)", () => {
	it("reads a one-line head and its pattern", () => {
		expect(gateHead("scripts/check-roadmap-valid.js")).toBe(
			"if armed '^docs/reference-roadmap\\.html$'; then\n",
		);
		expect(armingPattern("scripts/check-roadmap-valid.js")).toBe(
			"^docs/reference-roadmap\\.html$",
		);
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

/** The scripts the gate anchored on `anchor` invokes, as the list
 * `expectFixtureSupplies` names when handed an empty supply. */
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

	it("finds a call passed as a bare argument to gate_direction, alongside the direct calls around it", () => {
		expect(invokedBy("scripts/check-doc-map.js")).toEqual([
			"scripts/check-doc-map.js",
			"scripts/checker-new-faults.js",
		]);
	});

	it("de-duplicates a script the fragment calls more than once", () => {
		const invoked = invokedBy("scripts/check-doc-map.js");
		expect(
			invoked.filter((s) => s === "scripts/check-doc-map.js"),
		).toHaveLength(1);
	});

	it("returns nothing for a gate that calls no repo script", () => {
		expect(invokedBy("actionlint $tool_paths")).toEqual([]);
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
			"roadmap-valid",
			"scripts/check-roadmap-valid.js",
			["scripts/check-roadmap-valid.js"],
		],
		[
			"injector-margin",
			"scripts/check-injector-margin.sh",
			["scripts/check-injector-margin.sh"],
		],
		[
			"digest-version",
			"scripts/check-digest-version.js",
			["scripts/check-digest-version.js"],
		],
		[
			"guard-registry",
			"scripts/check-guard-registry.js",
			["scripts/check-guard-registry.js"],
		],
		[
			"doc-map",
			"scripts/check-doc-map.js",
			["scripts/check-doc-map.js", "scripts/checker-new-faults.js"],
		],
		[
			"context-budget",
			"scripts/check-context-budget.js",
			["scripts/check-context-budget.js", "scripts/lib/always-loaded-pool.js"],
		],
		[
			"superseded-needle",
			"--broken-only",
			["scripts/check-superseded-values.js"],
		],
		[
			"guard-test-isolation",
			"scripts/check-guard-test-isolation.js",
			["scripts/check-guard-test-isolation.js"],
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
		["actionlint", "actionlint $tool_paths", []],
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

describe("writeCheckerDelegates (mantahostels#2073)", () => {
	// A fixture "real" script under the actual ROOT/scripts, since the delegate
	// re-execs `path.join(ROOT, "scripts", name)` — a throwaway repo's own
	// scripts/ is never on that path. pid-suffixed so a concurrent stray run of
	// this suite can't delete the other's fixture out from under it.
	// **Residual:** an untracked file is left under the real scripts/ if the
	// process dies between the write and this afterEach (mantahostels#2073).
	const fixtureName = `__precommit-gate-harness-test-fixture-${process.pid}.js`;
	const fixturePath = path.join(ROOT, "scripts", fixtureName);

	afterEach(() => {
		fs.rmSync(fixturePath, { force: true });
	});

	it("names itself the required delegate route in its own docstring (mantahostels#2129)", () => {
		// Anchored on the JSDoc block immediately preceding the declaration, not
		// on prose fragments inside it — those drift with the docstring itself,
		// so a case anchored on them could go on passing after the claim moved
		// or was cut.
		const src = fs.readFileSync(
			path.join(ROOT, "scripts", "lib", "precommit-gate-testkit.ts"),
			"utf8",
		);
		const declSite = src.indexOf("function writeCheckerDelegates(");
		expect(
			declSite,
			"writeCheckerDelegates' declaration moved or was renamed",
		).toBeGreaterThan(-1);
		const commentEnd = src.lastIndexOf("*/", declSite);
		const commentStart = src.lastIndexOf("/**", commentEnd);
		expect(
			commentStart,
			"no JSDoc block immediately precedes writeCheckerDelegates",
		).toBeGreaterThan(-1);
		const docstring = src.slice(commentStart, commentEnd);
		expect(docstring).toContain("the required route");
		expect(docstring).toContain("is not a delegate");
	});

	it("propagates a non-zero child exit status when the real checker refuses", () => {
		fs.writeFileSync(
			fixturePath,
			"process.exit(process.argv[2] === 'refuse' ? 1 : 0);\n",
		);
		const { root } = newRepo("delegate-", temps);
		writeCheckerDelegates(root, [fixtureName]);
		const delegate = path.join(root, "scripts", fixtureName);

		// spawnSync, not run-in-process: the delegate under test is itself a
		// separate-process re-exec ending in an unconditional `process.exit`
		// (precommit-gate-testkit.ts), so asserting on its own exit code needs a
		// real child.
		expect(spawnSync(process.execPath, [delegate, "refuse"]).status).toBe(1);
		expect(spawnSync(process.execPath, [delegate, "pass"]).status).toBe(0);
	});

	it("pins 128 + signal number when the real checker dies to a signal, distinct from a refusal's exit 1 (mantahostels#2128)", () => {
		fs.writeFileSync(fixturePath, "process.kill(process.pid, 'SIGTERM');\n");
		const { root } = newRepo("delegate-", temps);
		writeCheckerDelegates(root, [fixtureName]);
		const delegate = path.join(root, "scripts", fixtureName);

		const result = spawnSync(process.execPath, [delegate]);

		expect(result.status).toBe(128 + os.constants.signals.SIGTERM);
		expect(result.status).not.toBe(1);
	});

	it("writes a delegate that calls spawnSync and never bare-requires a real repo path", () => {
		// writeCheckerDelegates only stringifies this path into the generated
		// body — it never reads or executes the target, so no fixture file needs
		// to exist on disk for this assertion.
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
