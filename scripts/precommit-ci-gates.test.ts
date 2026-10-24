// @vitest-environment node
/*
 * Pins that `.husky/pre-commit` runs and enforces the two gates that moved out
 * of CI at mantahostels#910, when the push trigger came off
 * `.github/workflows/roadmap-digest.yml`: each fires only on its own staged
 * paths and refuses the commit on a finding.
 *
 * `check-digest-version.js` and `check-guard-registry.js` are now the local half
 * of a claim CLAUDE.md makes — the roadmap/digest pair cannot drift, and no
 * parallel-safety rule can claim an enforcement it does not have. Delete these
 * hook blocks and the next thing to run either check is the scheduled sweep, up
 * to ~12 hours later (mantahostels#2204) — the cron is 4-hourly, but delivery lags it.
 *
 * UNVERIFIED, and deliberately: the CI half — the steps still in
 * roadmap-digest.yml, and the schedule in scheduled-checks.yml that now calls
 * it. Testing those means running a workflow.
 *
 * Both checkers are stubbed in each fixture so their exit codes are ours to
 * drive.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	armingPattern,
	cutGateScript,
	expectFixtureSupplies,
	gateHead,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { coreCall, HOOK } from "./lib/precommit-gate-testkit";

const DIGEST_CHECKER = "scripts/check-digest-version.js";
const REGISTRY_CHECKER = "scripts/check-guard-registry.js";
const ROADMAP = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

const STUB_MARKER = "STUB-CHECK-RAN";

const temps = registerTempCleanup();

function write(root: string, rel: string, body: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
}

/**
 * A repo holding one commit, a stubbed checker, and whatever `staged` names.
 *
 * The stub prints its own marker and every argument it was handed. `committed`
 * seeds files into the first commit so a case can stage a change over them.
 */
function fixture(opts: {
	checker: string;
	checkerExit: number;
	committed?: Record<string, string>;
	staged?: Record<string, string>;
	dirty?: Record<string, string>;
	/**
	 * The direction gate's verdict (mantahostels#1753): 1 = this commit ADDS the faults and
	 * is refused, 0 = every fault is inherited and it passes, 2 = the comparison
	 * could not answer and the gate fails closed.
	 *
	 */
	newFaultsExit?: number;
}): TempRepo {
	const checker = `console.log("${STUB_MARKER}");
const fs = require("node:fs");
// Echo the file arguments the digest gate stages out. A flag or a rev — which
// is all the guard-registry gate passes since #1833 — is not one, and reading
// it would kill the stub before its chosen exit code.
for (const a of process.argv.slice(2)) {
	if (fs.existsSync(a) && fs.statSync(a).isFile())
		console.log("ARG " + fs.readFileSync(a, "utf8").trim());
}
process.exit(${opts.checkerExit});
`;
	const repo = stagedRepo(
		"ci-gates-",
		temps,
		{
			"scripts/checker-new-faults.js": `console.log("findings: stub-new-fault");\nprocess.exit(${opts.newFaultsExit ?? 1});\n`,
			[opts.checker]: checker,
			...opts.committed,
		},
		opts.staged ?? {},
	);
	// Written AFTER staging, so the worktree and the index disagree on purpose.
	for (const [rel, body] of Object.entries(opts.dirty ?? {}))
		write(repo.root, rel, body);
	return repo;
}

function runGate(
	cwd: string,
	fragment: string,
): { code: number; output: string } {
	try {
		// `sh -e`, as husky runs the real hook (.husky/_/h), plus a trailing no-op
		// standing in for the rest of the file, so a deleted `|| exit` cannot hide
		// behind the fragment's own exit status. Unlike the same no-op in
		// precommit-roadmap-valid-gate, no case here currently needs it (mantahostels#953).
		//
		// `2>&1` over the whole block because the gate's skip notice goes to
		// stderr, and execFileSync hands back stdout alone.

		const out = execFileSync("sh", ["-ec", `{\n${fragment}\n:\n} 2>&1\n`], {
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

/** The roadmap pair, present in the index so the gate has something to read. */
const PAIR = { [ROADMAP]: "v1.0 committed\n", [DIGEST]: "v1.0 committed\n" };

describe("the pre-commit digest-version gate", () => {
	const fragment = () => cutGateScript(DIGEST_CHECKER);

	it("is wired into .husky/pre-commit", () => {
		expect(HOOK).toContain(coreCall("node", DIGEST_CHECKER));
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(DIGEST_CHECKER, [DIGEST_CHECKER]);
	});

	it("runs the checker for a commit staging the roadmap", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 0,
			committed: PAIR,
			staged: { [ROADMAP]: "v1.1\n" },
		});

		const { code, output } = runGate(root, fragment());
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("runs the checker for a commit staging the digest", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 0,
			committed: PAIR,
			staged: { [DIGEST]: "v1.1\n" },
		});

		expect(runGate(root, fragment()).output).toContain(STUB_MARKER);
	});

	it("fails the commit when the versions have drifted", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 1,
			committed: PAIR,
			staged: { [ROADMAP]: "v1.1\n" },
		});

		const { code, output } = runGate(root, fragment());
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	// BROKEN (exit 2) is the checker unable to do its job — a file that will not
	// read or will not parse — and must block the commit as a finding does.
	it("fails the commit when the checker reports BROKEN", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 2,
			committed: PAIR,
			staged: { [ROADMAP]: "v1.1\n" },
		});

		// digest-version runs in `status` mode (unlike `hold`), which exits
		// with the checker's own code unflattened — pin 2 exactly, or a
		// `|| exit 1` mutation passes alongside the real BROKEN case.
		const { code, output } = runGate(root, fragment());
		expect(code).toBe(2);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit touching neither file", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			// Exit 1, so a gate that wrongly ran it fails loudly.
			checkerExit: 1,
			committed: PAIR,
			staged: { "app/page.tsx": "x\n" },
		});

		const { code, output } = runGate(root, fragment());
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("does not fire on a path that only resembles the pair", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 1,
			committed: PAIR,
			staged: { [`vendor/${ROADMAP}`]: "x\n", [`${DIGEST}.bak`]: "x\n" },
		});

		expect(runGate(root, fragment()).code).toBe(0);
	});

	it("judges the staged bytes, not the ones in the working tree", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 0,
			committed: PAIR,
			staged: { [ROADMAP]: "INDEX\n" },
			dirty: { [ROADMAP]: "NEIGHBOUR-HALF-WRITTEN\n" },
		});

		const { output } = runGate(root, fragment());
		expect(output).toContain("ARG INDEX");
		expect(output).not.toContain("NEIGHBOUR");
	});

	// The unstaged half is read at its committed content, which is what it will
	// still be after this commit.
	it("reads the unstaged half of the pair from the index too", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 0,
			committed: PAIR,
			staged: { [ROADMAP]: "INDEX\n" },
		});

		expect(runGate(root, fragment()).output).toContain("ARG v1.0 committed");
	});

	// Apparatus missing is not a finding: warn and let the commit through.
	it("skips, without failing, when the pair is not in the index", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 1,
			staged: { [ROADMAP]: "v1.1\n" },
		});

		const { code, output } = runGate(root, fragment());
		expect(code).toBe(0);
		expect(output).toContain("skipped the digest-version check");
		expect(output).not.toContain(STUB_MARKER);
	});
});

describe("the pre-commit guard-registry gate", () => {
	const fragment = () => cutGateScript(REGISTRY_CHECKER);

	it("is wired into .husky/pre-commit", () => {
		expect(HOOK).toContain(coreCall("node", REGISTRY_CHECKER));
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(REGISTRY_CHECKER, [REGISTRY_CHECKER]);
	});

	// Every root the checker actually reads: the documents carrying
	// guard-registry regions, and the guard files their **Enforced** claims name.
	// A guard is a file, so deleting .husky/pre-commit falsifies a claim with no
	// document changing at all.
	it.each([
		"docs/doc-map.md",
		".claude/skills/tdd/SKILL.md",
		"scripts/guard-branch.sh",
		".husky/pre-commit",
		"AGENTS.md",
		"CLAUDE.md",
	])("runs the checker for a commit staging %s", (staged) => {
		const { root } = fixture({
			checker: REGISTRY_CHECKER,
			checkerExit: 0,
			staged: { [staged]: "x\n" },
		});

		expect(runGate(root, fragment()).output).toContain(STUB_MARKER);
	});

	it("fails the commit when a rule's stated backing does not hold, passing the checker report through", () => {
		const { root } = fixture({
			checker: REGISTRY_CHECKER,
			checkerExit: 1,
			staged: { "CLAUDE.md": "x\n" },
		});

		const { code, output } = runGate(root, fragment());
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit outside that scope", () => {
		const { root } = fixture({
			checker: REGISTRY_CHECKER,
			checkerExit: 1,
			staged: { "app/page.tsx": "x\n", "public/robots.txt": "x\n" },
		});

		const { code, output } = runGate(root, fragment());
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	// The `^` and `$` anchors: a directory merely beginning with the letters
	// "docs", and a file merely ending in "CLAUDE.md", are not in scope.
	/* Which of the checker's faults this commit ADDS is no longer the hook's
	 * question: since mantahostels#1833 it is `--against HEAD` inside scripts/lib/check.js,
	 * proved once in scripts/lib/check.test.ts. The hook owns the arming
	 * condition and the exit, and those alone are what this file still covers. */

	it("does not fire on paths that only resemble the scope", () => {
		const { root } = fixture({
			checker: REGISTRY_CHECKER,
			checkerExit: 1,
			staged: { "docs-archive/x.md": "x\n", "vendor/MYCLAUDE.md": "x\n" },
		});

		expect(runGate(root, fragment()).code).toBe(0);
	});
});

/*
 * Mutation coverage, held as cases rather than run by hand.
 *
 * `.husky/pre-commit` is read by every session in this repo-global tree and by
 * every worktree (mantahostels#344), so breaking the live file to prove a case bites would
 * break parallel sessions' commits for as long as the mutation stood. Each
 * mutation is applied to the fragment IN MEMORY, and every case asserts the
 * mutation actually changed the text — a `.replace()` matching nothing would
 * silently re-test the real gate and pass vacuously.
 */
describe("mutations of the two gates are caught by the cases above", () => {
	const mutate = (
		checker: string,
		find: string | RegExp,
		replace: string,
	): string => {
		/* The whole script, library included: since mantahostels#1793 the staging, the exit
		 * and the direction gate live in scripts/lib/precommit-gate.sh, so a
		 * mutation of the block alone could no longer reach them. */
		const original = cutGateScript(checker);
		const mutant = original.replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(original);
		return mutant;
	};

	const fragment = () => cutGateScript(REGISTRY_CHECKER);

	const dropFilter = (checker: string): string => {
		// Read off the block; the literal it yields is replaced in the whole script.
		return mutate(checker, gateHead(checker), "if true; then\n");
	};

	it("digest-version stops failing the commit when the exit is dropped", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 1,
			committed: PAIR,
			staged: { [ROADMAP]: "v1.1\n" },
		});

		const mutant = mutate(DIGEST_CHECKER, /exit "\$sg_(status|exit)"/g, ":");
		expect(runGate(root, mutant).code).toBe(0);
	});

	it("digest-version runs out of scope when its path filter is dropped", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 1,
			committed: PAIR,
			staged: { "app/page.tsx": "x\n" },
		});

		const { code, output } = runGate(root, dropFilter(DIGEST_CHECKER));
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("digest-version fires on a look-alike when the pattern loses its leading anchor", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 1,
			committed: PAIR,
			staged: { [`vendor/${ROADMAP}`]: "x\n" },
		});

		const { code, output } = runGate(
			root,
			mutate(
				DIGEST_CHECKER,
				armingPattern(DIGEST_CHECKER),
				armingPattern(DIGEST_CHECKER).replace(/^\^/, ""),
			),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("digest-version reads the wrong bytes when the index ref becomes HEAD", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 0,
			committed: PAIR,
			staged: { [ROADMAP]: "INDEX\n" },
		});

		const mutant = mutate(
			DIGEST_CHECKER,
			'cat-file -p ":$gate_p"',
			'cat-file -p "HEAD:$gate_p"',
		);
		const { output } = runGate(root, mutant);
		expect(output).not.toContain("ARG INDEX");
		expect(output).toContain("ARG v1.0 committed");
	});

	/*
	 * A mutation that SURVIVES, recorded rather than dropped: deleting the
	 * `|| exit "$gr_status"` after the direction gate changes nothing, because
	 * husky runs the hook as `sh -e` (.husky/_/h) and the gate's own non-zero
	 * return aborts the shell. It does not lose the BROKEN code either — a
	 * non-FAIL status never reaches the direction gate at all, taking the `elif`
	 * the case below mutates.
	 *
	 * The digest-version gate does not share the property: staged_gate captures
	 * the checker's status so it can print advice first, which swallows the
	 * failure — so there the explicit exit IS load-bearing.
	 */
	it("guard-registry still refuses, with the checker report, without its explicit exit, because sh -e catches it", () => {
		const { root } = fixture({
			checker: REGISTRY_CHECKER,
			checkerExit: 1,
			staged: { "CLAUDE.md": "x\n" },
		});

		const { code, output } = runGate(
			root,
			mutate(REGISTRY_CHECKER, ' || exit "$?"', ""),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	/* A BROKEN 2 and a fault this commit adds (1) call for different acts, so
	 * the checker's own code has to survive the hook: `|| exit "$?"` is what
	 * carries it, and a bare `|| exit 1` would flatten the two. */
	it("guard-registry flattens a BROKEN to 1 when the exit stops reading $?", () => {
		const broken = () =>
			fixture({
				checker: REGISTRY_CHECKER,
				checkerExit: 2,
				staged: { "CLAUDE.md": "x\n" },
			});

		// A structural pin: 2 vs 1 is the checker's own BROKEN-vs-fault distinction
		// (staged_gate's `<exit> status`), not a generic non-zero.
		const base = runGate(broken().root, fragment());
		expect(base.code).toBe(2);
		expect(base.output).toContain(STUB_MARKER);

		const mutant = runGate(
			broken().root,
			mutate(REGISTRY_CHECKER, '|| exit "$?"', "|| exit 1"),
		);
		expect(mutant.code).toBe(1);
		expect(mutant.output).toContain(STUB_MARKER);
	});

	it("guard-registry runs out of scope when its path filter is dropped", () => {
		const { root } = fixture({
			checker: REGISTRY_CHECKER,
			checkerExit: 1,
			staged: { "app/page.tsx": "x\n" },
		});

		const { code, output } = runGate(root, dropFilter(REGISTRY_CHECKER));
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("guard-registry fires out of scope when the `^` anchor is dropped", () => {
		const { root } = fixture({
			checker: REGISTRY_CHECKER,
			checkerExit: 1,
			staged: { "vendor/MYCLAUDE.md": "x\n" },
		});

		const { code, output } = runGate(
			root,
			mutate(REGISTRY_CHECKER, "'^(docs/", "'(docs/"),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});
});
