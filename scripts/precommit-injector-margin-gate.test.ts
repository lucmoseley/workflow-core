// @vitest-environment node
/*
 * The pre-commit injector-margin gate and its checker (mantahostels#1915).
 *
 * `.husky/pre-commit` runs `check-injector-margin.js` only when the commit
 * stages `scripts/lib/tracker-inject-text.js` or a rule fragment /code-review's
 * rules read, and fails the commit when it exits non-zero. The gate's wiring
 * and scoping are tested here, stubbing the checker so every exit code can be
 * driven; the checker itself is check-injector-margin.test.ts's.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a text module whose
 * payload crosses the threshold lands, and the tracker commands silently get a
 * ~2 KB preview of their rules instead of the rules.
 */

import { execFileSync } from "node:child_process";
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
import { coreCall, HOOK, LIB } from "./lib/precommit-gate-testkit";

const CHECKER = "scripts/check-injector-margin.js";
const INJECTOR = "scripts/lib/tracker-inject-text.js";
const { REVIEW_RULES: RULE_IDS } =
	require("./lib/injector-margin.js") as typeof import("./lib/injector-margin.js");
const REVIEW_RULES = RULE_IDS.map((id) => `docs/agents/rules/${id}.txt`);
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
			[CHECKER]: `process.stdout.write(${JSON.stringify(`${STUB_MARKER}\n`)});\nprocess.exit(${opts.checkerExit});\n`,
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
		expect(HOOK).toContain(`${coreCall("node", CHECKER)} --index`);
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
		const { MARGIN_INPUTS } =
			require("./lib/injector-margin.js") as typeof import("./lib/injector-margin.js");
		for (const rel of [INJECTOR, ...REVIEW_RULES])
			expect(MARGIN_INPUTS).toContain(rel);
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
