// @vitest-environment node
/*
 * The pre-commit injector-margin gate and its checker (mantahostels#1915).
 *
 * `.husky/pre-commit` runs `check-injector-margin.sh` only when the commit
 * stages `scripts/inject-tracker-docs.sh`, and fails the commit when it exits
 * non-zero. Two halves are tested here: the gate's wiring and scoping, stubbing
 * the checker so both exit codes can be driven; and the checker itself against
 * synthetic injectors.
 *
 * WHAT STAYS UNVERIFIED: that 10,000 is still the harness's threshold (mantahostels#1868).
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and an injector whose
 * payload crosses the threshold lands, and the tracker commands silently get a
 * ~2 KB preview of their rules instead of the rules.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	armingPattern,
	cutGateFragment,
	expectFixtureSupplies,
	gateHead,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { coreCall, HOOK, LIB, ROOT } from "./lib/precommit-gate-testkit";

const CHECKER = "scripts/check-injector-margin.sh";
const INJECTOR = "scripts/inject-tracker-docs.sh";
const HOOK_LIMITS = "scripts/lib/hook-limits.sh";
const BUDGET = "scripts/check-context-budget.js";

const gateFragment = () => cutGateFragment(CHECKER);

const temps = registerTempCleanup();

const STUB_MARKER = "STUB-INJECTOR-MARGIN-RAN";

/**
 * A git repo with one commit, plus a stubbed checker whose exit code is ours to
 * choose. `staged` is written and staged; nothing else is.
 */
function fixture(opts: {
	staged: Record<string, string>;
	checkerExit: number;
}): TempRepo {
	return stagedRepo(
		"injector-margin-gate-",
		temps,
		{
			[CHECKER]: `echo "${STUB_MARKER}"\nexit ${opts.checkerExit}\n`,
		},
		opts.staged,
	);
}

function runGate(
	cwd: string,
	fragment: string = gateFragment(),
): { code: number; output: string } {
	try {
		// A trailing no-op stands in for the rest of the hook, which really does
		// continue past this gate. Without it the fragment's own exit status is the
		// checker's, and `|| exit 1` could be deleted with every case still green.
		const out = execFileSync("sh", ["-c", `${LIB}\n${fragment}\n:\n`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output: out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

describe("the pre-commit injector-margin gate", () => {
	it("is wired into .husky/pre-commit", () => {
		expect(HOOK).toContain(coreCall("bash", CHECKER));
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(CHECKER, [CHECKER]);
	});

	it("runs after the context-budget gate, which is the cheaper, broader one", () => {
		// Positions of the CALL lines, never of a comment naming the checker:
		// `indexOf` on the raw text would compare one gate's commentary against the
		// other gate's call and still read as ordered.
		const lines = HOOK.split("\n");
		const callOf = (needle: string) =>
			lines.findIndex(
				(l) => l.includes(needle) && !l.trimStart().startsWith("#"),
			);
		expect(callOf(BUDGET)).toBeGreaterThan(-1);
		expect(callOf(CHECKER)).toBeGreaterThan(callOf(BUDGET));
	});

	it("arms on exactly the file the checker measures", () => {
		// One path, two spellings. Renaming the injector in the checker alone
		// would leave a gate that silently never fires.
		const checker = fs.readFileSync(path.join(ROOT, CHECKER), "utf8");
		expect(checker).toContain(`INJECTOR="${INJECTOR}"`);
		expect(armingPattern(CHECKER)).toBe(`^${INJECTOR.replaceAll(".", "\\.")}$`);
	});

	it("runs the checker for a commit staging the injector", () => {
		const { root } = fixture({ staged: { [INJECTOR]: "x\n" }, checkerExit: 0 });

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fails the commit when a payload is over the threshold", () => {
		const { root } = fixture({ staged: { [INJECTOR]: "x\n" }, checkerExit: 1 });

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	// BROKEN (exit 2) is the checker unable to do its job — an unreadable blob or
	// an unparseable COMMANDS array — and must block the commit just as an
	// over-threshold payload does, rather than passing vacuously.
	it("fails the commit when the checker reports BROKEN", () => {
		const { root } = fixture({ staged: { [INJECTOR]: "x\n" }, checkerExit: 2 });

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit that leaves the injector alone", () => {
		const { root } = fixture({
			// Exit 1, so a gate that wrongly ran it fails loudly.
			staged: { "docs/agents/issue-tracker.md": "x\n", "app/page.tsx": "x\n" },
			checkerExit: 1,
		});

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	// The pattern is anchored at both ends, so a path merely containing the
	// injector's name is not the injector.
	it("does not fire on a path that only resembles the injector", () => {
		const { root } = fixture({
			staged: {
				[`vendor/${INJECTOR}`]: "x\n",
				[`${INJECTOR}.bak`]: "x\n",
			},
			checkerExit: 1,
		});

		expect(runGate(root).code).toBe(0);
	});
});

describe("mutations of the gate are caught by the cases above", () => {
	/*
	 * Each mutation is applied to the fragment IN MEMORY — the live
	 * `.husky/pre-commit` is read by every session in this tree and by every
	 * worktree (mantahostels#344) — and asserts the mutation actually changed the text, since
	 * a `.replace()` matching nothing would silently re-test the real gate and
	 * pass vacuously.
	 */
	const mutate = (find: string | RegExp, replace: string): string => {
		const mutant = gateFragment().replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(gateFragment());
		return mutant;
	};

	it("stops failing the commit when `|| exit 1` is dropped", () => {
		const { root } = fixture({ staged: { [INJECTOR]: "x\n" }, checkerExit: 1 });

		expect(runGate(root, mutate(" || exit 1", "")).code).toBe(0);
	});

	it("runs the checker out of scope when the path filter is dropped", () => {
		const { root } = fixture({
			staged: { "app/page.tsx": "x\n" },
			checkerExit: 1,
		});

		const mutant = mutate(gateHead(CHECKER), "if true; then\n");
		const { code, output } = runGate(root, mutant);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fires on a look-alike path when the pattern loses its leading anchor", () => {
		const { root } = fixture({
			staged: { [`vendor/${INJECTOR}`]: "x\n" },
			checkerExit: 1,
		});

		const { code, output } = runGate(
			root,
			mutate(armingPattern(CHECKER), armingPattern(CHECKER).replace(/^\^/, "")),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("stops firing at all when the grep names another file", () => {
		const { root } = fixture({ staged: { [INJECTOR]: "x\n" }, checkerExit: 1 });

		expect(
			runGate(
				root,
				mutate("inject-tracker-docs\\.sh", "check-context-budget\\.js"),
			).code,
		).toBe(0);
	});
});

/*
 * The checker itself, against synthetic injectors.
 *
 * A fake injector is any script emitting the hook's JSON shape, so a case can
 * choose the exact payload length either side of the threshold. The real
 * injector's own figures are asserted by inject-tracker-docs.test.ts, which owns
 * that ground; pinning one here would go red on every ordinary rule edit.
 */
describe("check-injector-margin.sh", () => {
	const realChecker = path.join(ROOT, CHECKER);

	/** A stand-in injector emitting `size` characters for every command named. */
	const fakeInjector = (commands: string[], size: number) =>
		[
			"#!/usr/bin/env bash",
			`COMMANDS=(${commands.join(" ")})`,
			"cat >/dev/null 2>&1 || true",
			`printf '{"hookSpecificOutput":{"additionalContext":"%s"}}' \\`,
			`  "$(head -c ${size} /dev/zero | tr '\\0' 'x')"`,
			"",
		].join("\n");

	/**
	 * A repo whose staged injector is `staged`, and whose tree copy is `tree`.
	 * `tree: null` removes the working-tree copy, leaving the staged blob alone.
	 * The live hook-limits.sh is committed beside it, as the checker reads the
	 * threshold there.
	 */
	function injectorRepo(
		staged: string,
		tree: string | null = staged,
	): TempRepo {
		const repo = stagedRepo(
			"injector-margin-checker-",
			temps,
			{ [HOOK_LIMITS]: fs.readFileSync(path.join(ROOT, HOOK_LIMITS), "utf8") },
			{ [INJECTOR]: staged },
		);
		const { root } = repo;
		if (tree === null) fs.rmSync(path.join(root, INJECTOR));
		else if (tree !== staged) fs.writeFileSync(path.join(root, INJECTOR), tree);
		return repo;
	}

	function run(cwd: string, ...args: string[]) {
		return runWithEnv(cwd, {}, ...args);
	}

	function runWithEnv(
		cwd: string,
		env: Record<string, string>,
		...args: string[]
	) {
		// spawnSync, not execFileSync: the SKIP limbs report on stderr and exit 0,
		// where execFileSync hands back stdout alone and the message vanishes.
		// CLAUDE_PROJECT_DIR is the fixture: gr_root answers it before the git
		// top level, and a session exports it as the live checkout (#3311).
		const r = spawnSync("bash", [realChecker, ...args], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
		});
		return {
			code: r.status ?? 1,
			output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		};
	}

	it("passes and reports the margin when every payload fits", () => {
		const { root } = injectorRepo(fakeInjector(["alpha", "beta"], 9000));

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("/alpha         9000 chars,  1000 left");
		expect(output).toContain("/beta          9000 chars,  1000 left");
	});

	it("fails on a payload at the threshold, which is already persisted, marking it OVER and saying to replace a paste with a pointer", () => {
		const { root } = injectorRepo(fakeInjector(["alpha"], 10_000));

		const { code, output } = run(root);
		expect(code).toBe(1);
		expect(output).toContain("OVER");
		// The exit code alone is half of it: a refused commit has to say the way out.
		expect(output).toContain("replace a paste with a pointer");
	});

	it("passes one character under it", () => {
		const { root } = injectorRepo(fakeInjector(["alpha"], 9999));

		expect(run(root).code).toBe(0);
	});

	// TIGHT_HEADROOM_CHARS is `-lt`, so exactly one rule of headroom is not yet
	// tight. The note rides on the SAME LINE as the margin, so a case asserting
	// only the margin passes either way.
	it("does not mark exactly one rule of headroom as tight", () => {
		const { root } = injectorRepo(fakeInjector(["alpha"], 9000));

		expect(run(root).output).not.toContain("tight");
	});

	it("marks one character less than that as tight, without failing", () => {
		const { root } = injectorRepo(fakeInjector(["alpha"], 9001));

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("tight");
	});

	it("does not mark a comfortable payload as tight", () => {
		const { root } = injectorRepo(fakeInjector(["alpha"], 5000));

		expect(run(root).output).not.toContain("tight");
	});

	it("measures every command the COMMANDS array names, and no list of its own", () => {
		const { root } = injectorRepo(fakeInjector(["one", "two", "three"], 100));

		const { output } = run(root);
		for (const cmd of ["one", "two", "three"])
			expect(output).toContain(`/${cmd}`);
	});

	// The whole reason the checker reads the index rather than the disk: the tree
	// is repo-global and a neighbour may be mid-save on the injector (mantahostels#250).
	it("measures the staged blob, not the working tree", () => {
		const { root } = injectorRepo(
			fakeInjector(["alpha"], 5000),
			fakeInjector(["alpha"], 10_500),
		);

		expect(run(root).code).toBe(0);
		// exempt (mantahostels#2081): the OVER message for this same over-threshold code path
		// is pinned by "fails on a payload at the threshold, which is already
		// persisted" above (:310-314) — this case's own contribution is that
		// --tree, not --index, is what catches the persisted-but-unstaged case.
		expect(run(root, "--tree").code).toBe(1);
	});

	/* The three routes on which this gate must NOT refuse a commit (mantahostels#1915). */
	it("skips, rather than refusing the commit, when jq is not on PATH", () => {
		// The injector fails open without jq (inject-tracker-docs.sh's
		// `command -v jq` line), so a hard dependency here refuses the commit
		// while blaming a command.
		const { root } = injectorRepo(fakeInjector(["alpha"], 5000));
		const shim = fs.mkdtempSync(path.join(os.tmpdir(), "no-jq-path-"));
		temps.push(shim);
		for (const bin of ["bash", "git", "mktemp", "sed", "cat", "grep", "rm"]) {
			const real = execFileSync("sh", ["-c", `command -v ${bin}`], {
				encoding: "utf8",
			}).trim();
			fs.symlinkSync(real, path.join(shim, bin));
		}

		const { code, output } = runWithEnv(root, { PATH: shim });
		expect(code).toBe(0);
		expect(output).toContain("SKIPPED");
		expect(output).toContain("jq");
		expect(output).not.toContain("chars,");
	});

	it("skips a commit that stages the injector's deletion", () => {
		// `git diff --cached --name-only` names a deleted path, so the gate fires;
		// `git show :` then has nothing to hand back.
		const { root, git } = injectorRepo(fakeInjector(["alpha"], 5000));
		git("commit", "-qm", "add injector");
		git("rm", "-q", "--", INJECTOR);

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("staged for deletion");
		expect(output).not.toContain("chars,");
	});

	/* git reports a rename as R, never D, so the deletion probe above missed it
	 * and a moved injector was refused as BROKEN (#1483). */
	it("skips a commit that renames the injector away (#1483)", () => {
		const { root, git } = injectorRepo(fakeInjector(["alpha"], 5000));
		git("commit", "-qm", "add injector");
		fs.mkdirSync(path.join(root, "bin"));
		git("mv", "--", INJECTOR, "bin/inject-tracker-docs.sh");

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("staged for deletion");
		expect(output).not.toContain("BROKEN");
	});

	it("reports BROKEN, not a pass, when hook-limits.sh names no threshold", () => {
		const { root, git } = injectorRepo(fakeInjector(["alpha"], 5000));
		fs.writeFileSync(path.join(root, HOOK_LIMITS), "# emptied\n");
		git("add", "--", HOOK_LIMITS);

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("no HOOK_PERSIST_CHARS=<n> line");
	});

	it("reports BROKEN with the cause when --tree has no file to read", () => {
		const { root } = injectorRepo(fakeInjector(["alpha"], 5000), null);

		const { code, output } = run(root, "--tree");
		expect(code).toBe(2);
		expect(output).toContain("BROKEN");
		// The underlying error, not just a generic "cannot read": absent and
		// unreadable are different faults with different fixes.
		expect(output).toMatch(/No such file|not read/i);
	});

	it("reports BROKEN, not a pass, when the COMMANDS array cannot be parsed", () => {
		const { root } = injectorRepo("#!/usr/bin/env bash\necho hi\n");

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("BROKEN");
	});

	it("reports BROKEN when the injector emits nothing measurable", () => {
		const { root } = injectorRepo(
			"#!/usr/bin/env bash\nCOMMANDS=(alpha)\nexit 0\n",
		);

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("BROKEN");
	});

	it("counts the units the harness slices with, not codepoints", () => {
		// An astral character is two UTF-16 units and one codepoint.
		const { root } = injectorRepo(
			[
				"#!/usr/bin/env bash",
				"COMMANDS=(alpha)",
				"cat >/dev/null 2>&1 || true",
				`printf '{"hookSpecificOutput":{"additionalContext":"%s"}}' \\`,
				`  "$(printf '\\xf0\\x9f\\x98\\x80%.0s' $(seq 5000))"`,
				"",
			].join("\n"),
		);

		// 5,000 emoji: 5,000 codepoints, 10,000 UTF-16 units — over the line.
		// exempt (mantahostels#2081): the OVER message for this over-threshold code path is
		// pinned by "fails on a payload at the threshold, which is already
		// persisted" above (:310-314); this case's contribution is the
		// unit-vs-codepoint count, carried by the code alone.
		expect(run(root).code).toBe(1);
	});

	// The `sed` parse depends on a shape the injector is free to change, and the
	// worst break is silent: QUOTED elements survive into the match, no command
	// matches, and the refusal blames a command rather than the array. So the
	// live array's shape is asserted here, where a reshape goes red.
	it("finds a single-line, unquoted COMMANDS array in the live injector", () => {
		const injector = fs.readFileSync(path.join(ROOT, INJECTOR), "utf8");
		const m = /^COMMANDS=\((.*)\)$/m.exec(injector);
		expect(m, `no single-line COMMANDS=(...) in ${INJECTOR}`).not.toBeNull();
		expect(m?.[1]).not.toContain('"');
		expect(m?.[1]).not.toContain("'");
		expect(m?.[1].trim().split(/\s+/).length).toBeGreaterThan(1);
	});

	it("measures exactly the commands the live injector matches", () => {
		// The two spellings of the command set — this checker's `sed` and the
		// injector suite's own list — must not drift apart.
		const injector = fs.readFileSync(path.join(ROOT, INJECTOR), "utf8");
		const live = /^COMMANDS=\((.*)\)$/m.exec(injector)?.[1].trim().split(/\s+/);
		const { output } = run(ROOT, "--tree");
		for (const cmd of live ?? []) expect(output).toContain(`/${cmd} `);
	});
});
