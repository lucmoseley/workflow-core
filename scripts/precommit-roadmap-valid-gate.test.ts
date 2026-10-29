// @vitest-environment node
/*
 * The pre-commit roadmap-validity gate (mantahostels#698), exercised as the shell it is.
 *
 * `.husky/pre-commit` calls `check-roadmap-valid.js` only when the commit stages
 * `docs/reference-roadmap.html`, and fails the commit when it exits non-zero.
 * Those two behaviours are what this file tests, plus the ordering the ticket
 * specified: after `check-roadmap-pair.js`, so the cheaper and more common
 * half-staged-pair failure reports first.
 *
 * The hook is the PRIMARY gate, and not the only one (mantahostels#974): the
 * scheduled `Document guards` job runs the same checker in `--tree` mode, which
 * judges the roadmap as it stands rather than a commit against its parent.
 *
 * What stays UNVERIFIED: that the scheduled job actually FIRES. Testing that
 * means running a workflow (`scripts/precommit-ci-gates.test.ts` carves out the
 * same ground).
 *
 * `check-roadmap-valid.js` is stubbed in each fixture so both exit codes can be
 * driven.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a structurally
 * invalid roadmap — the sole authority on card status — lands, unseen until the
 * scheduled job next runs.
 */

import { execFileSync } from "node:child_process";
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

const CHECKER = "scripts/check-roadmap-valid.js";
const PAIR = "scripts/check-roadmap-pair.js";

const gateFragment = () => cutGateFragment(CHECKER);

/**
 * How the hook's arming pattern differs from the path `check-roadmap-valid.js`
 * itself judges, or `null` where they agree. The two are separate spellings of
 * one path: renaming the roadmap in the checker alone would leave a gate that
 * silently never fires.
 */
function parityGap(fragment: string): string | null {
	const checker = fs.readFileSync(path.join(ROOT, CHECKER), "utf8");
	const decl = /const HTML = "([^"]+)"/.exec(checker);
	if (!decl) return `HTML no longer parses out of ${CHECKER}`;

	const pattern = armingPattern(CHECKER, fragment);
	const spelled = `^${decl[1].replaceAll(".", "\\.")}$`;
	return pattern === spelled
		? null
		: `hook matches '${pattern}', the checker judges '${spelled}'`;
}

const temps = registerTempCleanup();

const STUB_MARKER = "STUB-ROADMAP-CHECK-RAN";

/**
 * A git repo with one commit, plus a stubbed checker whose exit code is ours to
 * choose. `staged` is written and staged; nothing else is.
 */
function fixture(opts: {
	staged: Record<string, string>;
	checkerExit: number;
}): TempRepo {
	return stagedRepo(
		"roadmap-valid-gate-",
		temps,
		{
			[CHECKER]: `console.log("${STUB_MARKER}");\nprocess.exit(${opts.checkerExit});\n`,
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

const ROADMAP = "docs/reference-roadmap.html";

describe("the pre-commit roadmap-validity gate", () => {
	it("is wired into .husky/pre-commit", () => {
		expect(HOOK).toContain(coreCall("node", CHECKER));
	});

	it("supplies exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(CHECKER, [CHECKER]);
	});

	it("runs after the roadmap-pair check", () => {
		// Both positions are of the CALL line, never of a comment naming the
		// checker: `indexOf` on the raw text would happily compare one gate's
		// commentary against the other gate's call and still read as ordered.
		const lines = HOOK.split("\n");
		const callOf = (checker: string) =>
			lines.findIndex(
				(l) => l.includes(checker) && !l.trimStart().startsWith("#"),
			);
		expect(callOf(PAIR)).toBeGreaterThan(-1);
		expect(callOf(CHECKER)).toBeGreaterThan(callOf(PAIR));
	});

	it("arms on exactly the path the checker judges", () => {
		expect(parityGap(gateFragment())).toBeNull();
	});

	it("reports a gap when the arming pattern and the checker disagree", () => {
		expect(
			parityGap(gateFragment().replace("reference-roadmap", "roadmap")),
		).not.toBeNull();
	});

	it("runs the checker for a commit staging the roadmap", () => {
		const { root } = fixture({ staged: { [ROADMAP]: "x\n" }, checkerExit: 0 });

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fails the commit when the checker fails", () => {
		const { root } = fixture({ staged: { [ROADMAP]: "x\n" }, checkerExit: 1 });

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	// BROKEN (exit 2) is the checker unable to do its job — an unreadable index
	// or an unparseable roadmap — and must block the commit just as an ERROR does.
	it("fails the commit when the checker reports BROKEN", () => {
		const { root } = fixture({ staged: { [ROADMAP]: "x\n" }, checkerExit: 2 });

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit that leaves the roadmap alone", () => {
		const { root } = fixture({
			// Exit 1, so a gate that wrongly ran it fails loudly.
			staged: { "docs/roadmap-digest.md": "x\n", "app/page.tsx": "x\n" },
			checkerExit: 1,
		});

		const { code, output } = runGate(root);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	// The pattern is anchored at both ends, so a path merely containing the
	// roadmap's name is not the roadmap.
	it("does not fire on a path that only resembles the roadmap", () => {
		const { root } = fixture({
			staged: {
				[`vendor/${ROADMAP}`]: "x\n",
				[`${ROADMAP}.bak`]: "x\n",
			},
			checkerExit: 1,
		});

		expect(runGate(root).code).toBe(0);
	});

	it("fires on a deletion of the roadmap", () => {
		const { root, git } = fixture({ staged: {}, checkerExit: 1 });
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, ROADMAP), "x\n");
		git("add", "--", ROADMAP);
		git("commit", "-qm", "add roadmap");
		git("rm", "-q", "--", ROADMAP);

		const { code, output } = runGate(root);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
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
describe("mutations of the gate are caught by the cases above", () => {
	const mutate = (find: string | RegExp, replace: string): string => {
		const mutant = gateFragment().replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(gateFragment());
		return mutant;
	};

	it('stops failing the commit when `|| exit "$?"` is dropped', () => {
		const { root } = fixture({ staged: { [ROADMAP]: "x\n" }, checkerExit: 1 });

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
			staged: { [`vendor/${ROADMAP}`]: "x\n" },
			checkerExit: 1,
		});

		const { code, output } = runGate(
			root,
			mutate(armingPattern(CHECKER), armingPattern(CHECKER).replace(/^\^/, "")),
		);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("stops firing at all when the arming pattern names another file", () => {
		const { root } = fixture({ staged: { [ROADMAP]: "x\n" }, checkerExit: 1 });

		expect(
			runGate(root, mutate("reference-roadmap\\.html", "roadmap-digest\\.md"))
				.code,
		).toBe(0);
	});
});

/*
 * The CI half (mantahostels#974). Not a second gate on the commit — it runs after
 * the push — but it is the only thing that ever sees a break arriving by
 * a route the hook cannot: a `--no-verify` commit. An auto-resolving merge was a
 * second such route until mantahostels#1679 wired `.husky/pre-merge-commit`, which git DOES
 * run for one, to the whole pre-commit stack.
 *
 * Pinned statically because a workflow cannot be run from here. Index mode in a
 * scheduled run has no commit in flight and SKIPs, so a step without `--tree`
 * would be green and vacuous.
 */
describe("the scheduled roadmap-validity check", () => {
	const ciWorkflow = fs.readFileSync(
		path.join(ROOT, ".github/workflows/roadmap-digest.yml"),
		"utf8",
	);

	/**
	 * The whole step block that runs `checker`, comments stripped, bounded by the
	 * `- name:` markers either side rather than by a line count.
	 */
	function stepBlockFor(workflow: string, checker: string): string[] | null {
		const lines = workflow
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#"));
		const at = lines.findIndex((l) => l.includes(checker));
		if (at === -1) return null;

		const isStepStart = (l: string) => /^\s*- (name|uses):/.test(l);
		let from = at;
		while (from > 0 && !isStepStart(lines[from])) from--;
		let to = at + 1;
		while (to < lines.length && !isStepStart(lines[to])) to++;
		return lines.slice(from, to);
	}

	const step = stepBlockFor(ciWorkflow, CHECKER);

	it("runs the checker in the Document guards job", () => {
		expect(step).not.toBeNull();
	});

	it("asks for tree mode, index mode having nothing to judge on a schedule", () => {
		expect(step?.join("\n")).toContain(`node ${CHECKER} --tree`);
	});

	it("runs even after an earlier guard has failed", () => {
		expect(step?.join("\n")).toContain("!cancelled()");
	});

	/* scripts/bisect-step.sh replays this job locally, commit by commit, so a
	 * step missing there makes a bisect over a documents-red walk past the very
	 * commit that caused it. */
	it("is replayed by bisect-step.sh, which mirrors the job", () => {
		const bisect = fs.readFileSync(
			path.join(ROOT, "scripts/bisect-step.sh"),
			"utf8",
		);
		expect(bisect).toContain(`"$node_bin" ${CHECKER} --tree`);
	});
});
