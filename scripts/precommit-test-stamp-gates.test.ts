// @vitest-environment node
// #5569

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
	CORE_ROOT,
	coreCall,
	cutHookBlock as cut,
	HOOK,
} from "./lib/precommit-gate-testkit";
import {
	fixture,
	GATES_END,
	IN_HOOK,
	PUSH,
} from "./lib/precommit-test-stamp-testkit";

it("refuses a red pre-lock gate with exit 3 and its output, starting no suite and writing nothing, the hook's own stamp included (#1763)", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, "stub-gate-red"), "");
	f.edit("a.txt", "changed\n");
	f.edit("new.txt", "new\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt,new.txt"]);
	expect(r.runs).toEqual([]);
	expect(r.out).toContain("gate: a lint finding in a.txt,new.txt");
	expect(r.out).toContain(
		"a pre-commit gate refused this commit (exit 1), so 'sh stub.sh' never started. Nothing written.",
	);
	expect(r.out).not.toContain("before the commit takes the index lock");
	expect(fs.existsSync(path.join(f.gitDir, "wfc-precommit-stamp"))).toBe(false);
	expect(r.leftInGitDir).toEqual([]);
	expect(r.otherWorktrees).toEqual([]);
});

it("runs the gates before the pre-lock suite and again in the lock, where only the test gate stands down (#1763)", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt", "lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	const gatesAt = r.out.indexOf(
		"running the pre-commit hook's gates but its slow ones, before 'sh stub.sh'",
	);
	expect(gatesAt, r.out).toBeGreaterThan(-1);
	expect(gatesAt).toBeLessThan(
		r.out.indexOf("before the commit takes the index lock"),
	);
	expect(r.out).not.toContain(IN_HOOK);
	expect(r.leftInGitDir).toEqual([]);
});

it.each([
	["gated at push", PUSH],
	["with no test command", JSON.stringify({ commands: {} })],
])(
	"runs the gates in the lock alone where the test is %s (#1763)",
	(_kind, config) => {
		const f = fixture({ config });
		f.edit("a.txt", "changed\n");
		const r = f.commitPaths();
		expect(r.code, r.out).toBe(0);
		expect(r.gateRuns).toEqual(["lock=1 staged=a.txt"]);
		expect(r.out).not.toContain("running the pre-commit hook's gates");
	},
);

it("runs the gates in the lock alone where the hook has no line ending them, saying so, and the suite still runs before the lock (#1763)", () => {
	const f = fixture();
	const hook = path.join(f.root, ".husky/pre-commit");
	fs.writeFileSync(
		hook,
		fs.readFileSync(hook, "utf8").replace(`${GATES_END}\n`, ""),
	);
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.gateRuns).toEqual(["lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		`no early gate run — ${hook} has no line marking where its gates end, an older hook than this script. The commit's hook runs its gates after 'sh stub.sh', in the lock.`,
	);
});

it("runs the core's gates before the pre-lock suite where the repo's hook is the core's shim, reaching the core as the shim does (#5288)", () => {
	const f = fixture({ adopter: true });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt", "lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		"running the pre-commit hook's gates but its slow ones, before 'sh stub.sh'",
	);
	expect(r.out).not.toContain("no early gate run");
});

it("refuses a red gate before the pre-lock suite where the repo's hook is the core's shim (#5288)", () => {
	const f = fixture({ adopter: true });
	fs.writeFileSync(path.join(f.root, "stub-gate-red"), "");
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt"]);
	expect(r.runs).toEqual([]);
});

it("refuses before the pre-lock suite where the repo's hook is the core's shim and no core resolves for it (#5288)", () => {
	const f = fixture({ adopter: true });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths({ unsetCore: true });
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.gateRuns).toEqual([]);
	expect(r.runs).toEqual([]);
	expect(r.out).toContain(
		"this repo's pre-commit hook is workflow-core's shim, and no core resolves for it to run (resolve-core: no workflow-core directory",
	);
	expect(r.out).toContain("'sh stub.sh' never started. Nothing written.");
});

it("runs the gates once, in the lock, on a plain git commit (#1763)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code, r.out).toBe(0);
	expect(r.gateRuns).toEqual(["lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
});

it("ends the live hook's early gates on one line directly above its test gate, below every other core gate, with no switch to stop there (#1763)", () => {
	const lines = HOOK.replaceAll(CORE_ROOT, "").split("\n");
	expect(lines.filter((l) => l === GATES_END)).toHaveLength(1);
	const end = lines.indexOf(GATES_END);
	const above = lines.slice(0, end).join("\n");
	const below = lines.slice(end + 1);
	for (const gate of [
		"node scripts/check-ruff-introduced.js",
		"node scripts/check-format-staged.js",
	])
		expect(above).toContain(gate);
	expect(below.find((l) => !/^\s*(#|$)/.test(l))).toBe(
		"if ! lander_batch && ! lander_tested && declared_cmd node scripts/lib/test-gate.js commit; then",
	);
	const runners = new Set(
		below.join("\n").match(/\b(?:node|bash|sh) scripts\/\S+/g) ?? [],
	);
	expect([...runners].sort()).toEqual([
		"node scripts/lib/commit-key.js",
		"node scripts/lib/isolated-worktree.js",
		"node scripts/lib/test-gate.js",
		"node scripts/mutation-hold-gate.js",
		"node scripts/queue-run.js",
	]);
	expect(below.join("\n")).toContain("/wfc-precommit-stamp");
	expect(above).not.toContain("wfc-precommit-stamp");
	expect(
		cut(
			`if ! lander_batch && ! lander_tested && declared_cmd ${coreCall("node", "scripts/lib/test-gate.js")} commit`,
			"fi",
		).replaceAll(CORE_ROOT, ""),
	).not.toMatch(/\$\{?_*[A-Z]/);
});
