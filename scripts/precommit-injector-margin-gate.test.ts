// @vitest-environment node
/*
 * The pre-commit injector-margin gate and its checker (mantahostels#1915).
 *
 * `.husky/pre-commit` runs `check-injector-margin.sh` only when the commit
 * stages `scripts/lib/tracker-inject-text.js` or a rule fragment /code-review's
 * rules read, and fails the commit when it exits non-zero. Two halves are
 * tested here: the gate's wiring and scoping, stubbing the checker so both exit
 * codes can be driven; and the checker itself against synthetic text modules.
 *
 * WHAT STAYS UNVERIFIED: that 10,000 is still the harness's threshold (mantahostels#1868).
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a text module whose
 * payload crosses the threshold lands, and the tracker commands silently get a
 * ~2 KB preview of their rules instead of the rules.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
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
import { shellQuote } from "./lib/sh-quote.js";

const CHECKER = "scripts/check-injector-margin.sh";
const INJECTOR = "scripts/lib/tracker-inject-text.js";
const REVIEW_RULES = [
	"review-dispatch-shape",
	"review-deviations-read",
	"review-finding-destination",
].map((id) => `docs/agents/rules/${id}.txt`);
const HOOK_LIMITS = "scripts/lib/hook-limits.js";
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
			[CHECKER]: `echo ${shellQuote(STUB_MARKER)}\nexit ${opts.checkerExit}\n`,
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
		// checker's, and `|| exit "$?"` could be deleted with every case still green.
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

	it("arms on exactly the files the checker measures", () => {
		// Each path, two spellings. Renaming one in the checker alone would leave
		// a gate that silently never fires on it.
		const checker = fs.readFileSync(path.join(ROOT, CHECKER), "utf8");
		expect(checker).toContain(`TEXT_MODULE="${INJECTOR}"`);
		const ids = /^REVIEW_RULES=\((.*)\)$/m.exec(checker)?.[1].split(" ");
		expect(ids?.map((id) => `docs/agents/rules/${id}.txt`)).toEqual(
			REVIEW_RULES,
		);
		const pattern = new RegExp(armingPattern(CHECKER));
		for (const rel of [INJECTOR, ...REVIEW_RULES])
			expect(pattern.test(rel), rel).toBe(true);
	});

	it("runs the checker for a commit staging only a rule fragment it reads", () => {
		const { root } = fixture({
			staged: { [REVIEW_RULES[0] as string]: "x\n" },
			checkerExit: 0,
		});

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
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
	// a module that will not evaluate — and must block the commit just as an
	// over-threshold payload does, rather than passing vacuously.
	it("fails the commit when the checker reports BROKEN", () => {
		const { root } = fixture({ staged: { [INJECTOR]: "x\n" }, checkerExit: 2 });

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit that leaves the text module alone", () => {
		const { root } = fixture({
			// Exit 1, so a gate that wrongly ran it fails loudly.
			staged: {
				"docs/agents/issue-tracker.md": "x\n",
				"docs/agents/rules/review-standards-axis.txt": "x\n",
				"app/page.tsx": "x\n",
			},
			checkerExit: 1,
		});

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	// The pattern is anchored at both ends, so a path merely containing the
	// module's name is not the module.
	it("does not fire on a path that only resembles the text module", () => {
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

	it('stops failing the commit when `|| exit "$?"` is dropped', () => {
		const { root } = fixture({ staged: { [INJECTOR]: "x\n" }, checkerExit: 1 });

		expect(runGate(root, mutate(' || exit "$?"', "")).code).toBe(0);
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
				mutate("tracker-inject-text\\.js", "check-context-budget\\.js"),
			).code,
		).toBe(0);
	});
});

/*
 * The checker itself, against synthetic text modules.
 *
 * A fake module is any CommonJS source exporting the composers the checker's
 * helper calls, so a case can choose the exact payload length either side of
 * the threshold. The real module's own figures are asserted by
 * inject-tracker-docs.test.ts, which owns that ground; pinning one here would
 * go red on every ordinary rule edit.
 */
describe("check-injector-margin.sh", () => {
	const realChecker = path.join(ROOT, CHECKER);

	/** A stand-in module whose every command's payload is `body`. */
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

	/** A stand-in module emitting `size` characters for every command named. */
	const fakeModule = (commands: string[], size: number) =>
		moduleOf(commands, "x".repeat(size));

	/**
	 * A repo whose staged module is `staged`, and whose tree copy is `tree`.
	 * `tree: null` removes the working-tree copy, leaving the staged blob alone.
	 * The live hook-limits.js is committed beside it, as the checker reads the
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
		// spawnSync, not execFileSync: the SKIP limb reports on stderr and exits 0,
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
		const { root } = injectorRepo(fakeModule(["alpha", "beta"], 9000));

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("/alpha         9000 chars,  1000 left");
		expect(output).toContain("/beta          9000 chars,  1000 left");
	});

	it("fails on a payload at the threshold, which is already persisted, marking it OVER and saying to replace a paste with a pointer", () => {
		const { root } = injectorRepo(fakeModule(["alpha"], 10_000));

		const { code, output } = run(root);
		expect(code).toBe(1);
		expect(output).toContain("OVER");
		// The exit code alone is half of it: a refused commit has to say the way out.
		expect(output).toContain("replace a paste with a pointer");
	});

	it("passes one character under it", () => {
		const { root } = injectorRepo(fakeModule(["alpha"], 9999));

		expect(run(root).code).toBe(0);
	});

	// TIGHT_HEADROOM_CHARS is `-lt`, so exactly one rule of headroom is not yet
	// tight. The note rides on the SAME LINE as the margin, so a case asserting
	// only the margin passes either way.
	it("does not mark exactly one rule of headroom as tight", () => {
		const { root } = injectorRepo(fakeModule(["alpha"], 9000));

		expect(run(root).output).not.toContain("tight");
	});

	it("marks one character less than that as tight, without failing", () => {
		const { root } = injectorRepo(fakeModule(["alpha"], 9001));

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("tight");
	});

	it("does not mark a comfortable payload as tight", () => {
		const { root } = injectorRepo(fakeModule(["alpha"], 5000));

		expect(run(root).output).not.toContain("tight");
	});

	it("measures every command the module's COMMANDS names, and no list of its own", () => {
		const { root } = injectorRepo(fakeModule(["one", "two", "three"], 100));

		const { output } = run(root);
		for (const cmd of ["one", "two", "three"])
			expect(output).toContain(`/${cmd}`);
	});

	// The whole reason the checker reads the index rather than the disk: the tree
	// is repo-global and a neighbour may be mid-save on the module (mantahostels#250).
	it("measures the staged blob, not the working tree", () => {
		const { root } = injectorRepo(
			fakeModule(["alpha"], 5000),
			fakeModule(["alpha"], 10_500),
		);

		expect(run(root).code).toBe(0);
		// exempt (mantahostels#2081): the OVER message for this same over-threshold code path
		// is pinned by "fails on a payload at the threshold, which is already
		// persisted" above (:310-314) — this case's own contribution is that
		// --tree, not --index, is what catches the persisted-but-unstaged case.
		expect(run(root, "--tree").code).toBe(1);
	});

	/* The routes on which this gate must NOT refuse a commit (mantahostels#1915). */
	it("skips a commit that stages the text module's deletion", () => {
		// `git diff --cached --name-only` names a deleted path, so the gate fires;
		// `git show :` then has nothing to hand back.
		const { root, git } = injectorRepo(fakeModule(["alpha"], 5000));
		git("commit", "-qm", "add text module");
		git("rm", "-q", "--", INJECTOR);

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("staged for deletion");
		expect(output).not.toContain("chars,");
	});

	/* git reports a rename as R, never D, so the deletion probe above missed it
	 * and a moved module was refused as BROKEN (#1483). */
	it("skips a commit that renames the text module away (#1483)", () => {
		const { root, git } = injectorRepo(fakeModule(["alpha"], 5000));
		git("commit", "-qm", "add text module");
		fs.mkdirSync(path.join(root, "bin"));
		git("mv", "--", INJECTOR, "bin/tracker-inject-text.js");

		const { code, output } = run(root);
		expect(code).toBe(0);
		expect(output).toContain("staged for deletion");
		expect(output).not.toContain("BROKEN");
	});

	it("reports BROKEN, not a pass, when hook-limits.js names no threshold", () => {
		const { root, git } = injectorRepo(fakeModule(["alpha"], 5000));
		fs.writeFileSync(path.join(root, HOOK_LIMITS), "// emptied\n");
		git("add", "--", HOOK_LIMITS);

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("no const HOOK_PERSIST_CHARS = <n>; line");
	});

	it("reports BROKEN, not a pass, when hook-limits.js names no RULE_CAP", () => {
		const { root, git } = injectorRepo(fakeModule(["alpha"], 5000));
		fs.writeFileSync(
			path.join(root, HOOK_LIMITS),
			"const HOOK_PERSIST_CHARS = 10000;\n",
		);
		git("add", "--", HOOK_LIMITS);

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("no const RULE_CAP = <n>; line");
	});

	it("reports BROKEN with the cause when --tree has no file to read", () => {
		const { root } = injectorRepo(fakeModule(["alpha"], 5000), null);

		const { code, output } = run(root, "--tree");
		expect(code).toBe(2);
		expect(output).toContain("BROKEN");
		// The underlying error, not just a generic "cannot read": absent and
		// unreadable are different faults with different fixes.
		expect(output).toMatch(/No such file|not read/i);
	});

	it("reports BROKEN, not a pass, when the module exports no COMMANDS", () => {
		const { root } = injectorRepo("module.exports = {};\n");

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("BROKEN");
	});

	it("reports BROKEN when the module names no command", () => {
		const { root } = injectorRepo(fakeModule([], 100));

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("names no command");
	});

	// The staged blob may be another session's (a merge, a revert), so it is
	// evaluated with no `require` to reach anything with.
	it("reports BROKEN, running nothing, when the module reaches for require", () => {
		const { root } = injectorRepo(
			`require("node:fs").writeFileSync("ran", "");\n${fakeModule(["alpha"], 100)}`,
		);

		const { code, output } = run(root);
		expect(code).toBe(2);
		expect(output).toContain("require is not defined");
		expect(fs.existsSync(path.join(root, "ran"))).toBe(false);
	});

	it("counts the units the harness slices with, not codepoints", () => {
		// An astral character is two UTF-16 units and one codepoint.
		const { root } = injectorRepo(
			moduleOf(["alpha"], "\u{1F600}".repeat(5000)),
		);

		// 5,000 emoji: 5,000 codepoints, 10,000 UTF-16 units — over the line.
		// exempt (mantahostels#2081): the OVER message for this over-threshold code path is
		// pinned by "fails on a payload at the threshold, which is already
		// persisted" above (:310-314); this case's contribution is the
		// unit-vs-codepoint count, carried by the code alone.
		expect(run(root).code).toBe(1);
	});

	it("measures exactly the commands the live module names", () => {
		const source = fs.readFileSync(path.join(ROOT, INJECTOR), "utf8");
		const { root } = injectorRepo(source);
		const { COMMANDS } = require(path.join(ROOT, INJECTOR)) as {
			COMMANDS: string[];
		};
		const { code, output } = run(root);
		expect(code).not.toBe(2);
		for (const cmd of COMMANDS) expect(output).toContain(`/${cmd} `);
	});
});
