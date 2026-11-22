// @vitest-environment node

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
import { GATES } from "./lib/precommit-gates.js";

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

function fixture(opts: {
	checker: string;
	checkerExit: number;
	committed?: Record<string, string>;
	staged?: Record<string, string>;
	dirty?: Record<string, string>;
	newFaultsExit?: number;
}): TempRepo {
	const checker = `console.log("${STUB_MARKER}");
const fs = require("node:fs");
// Echo the file arguments the digest gate stages out. A flag or a rev is not
// one, and reading it would kill the stub before its chosen exit code.
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
	for (const [rel, body] of Object.entries(opts.dirty ?? {}))
		write(repo.root, rel, body);
	return repo;
}

function runGate(
	cwd: string,
	fragment: string,
): { code: number; output: string } {
	try {
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

	it("fails the commit when the checker reports BROKEN", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 2,
			committed: PAIR,
			staged: { [ROADMAP]: "v1.1\n" },
		});

		const { code, output } = runGate(root, fragment());
		expect(code).toBe(2);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit touching neither file", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
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

	it("reads the unstaged half of the pair from the index too", () => {
		const { root } = fixture({
			checker: DIGEST_CHECKER,
			checkerExit: 0,
			committed: PAIR,
			staged: { [ROADMAP]: "INDEX\n" },
		});

		expect(runGate(root, fragment()).output).toContain("ARG v1.0 committed");
	});

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

describe("the pre-commit guard-registry row", () => {
	const row = GATES.find((g) => g.script === REGISTRY_CHECKER);
	const arms = (p: string) =>
		row !== undefined && "pattern" in row.arm && row.arm.pattern.test(p);

	it("is a gating row of the dispatcher", () => {
		expect(row?.policy).toBe("gate");
	});

	it.each([
		"docs/doc-map.md",
		".claude/skills/tdd/SKILL.md",
		"scripts/guard-dispatch.js",
		".husky/pre-commit",
		"AGENTS.md",
		"CLAUDE.md",
	])("arms on a commit staging %s", (staged) => {
		expect(arms(staged)).toBe(true);
	});

	it.each([
		"app/page.tsx",
		"public/robots.txt",
		"docs-archive/x.md",
		"vendor/MYCLAUDE.md",
	])("does not arm on %s", (staged) => {
		expect(arms(staged)).toBe(false);
	});
});

describe("mutations of the digest-version gate are caught by the cases above", () => {
	const mutate = (
		checker: string,
		find: string | RegExp,
		replace: string,
	): string => {
		const original = cutGateScript(checker);
		const mutant = original.replace(find, replace);
		expect(mutant, `mutation '${find}' did not apply`).not.toBe(original);
		return mutant;
	};

	const dropFilter = (checker: string): string =>
		mutate(checker, gateHead(checker), "if true; then\n");

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
});
