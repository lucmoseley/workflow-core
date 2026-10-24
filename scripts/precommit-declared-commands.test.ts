// @vitest-environment node
/*
 * The four .husky/pre-commit gates that run an adopter's declared command —
 * `commands.check_staged`, `commands.typecheck`, `commands.lint` and
 * `commands.test` in `.claude/workflow-core.json` (#2, #740). The test gate
 * skips a command that writes the test-pass marker.
 *
 * The fixture copies the real readers into a throwaway repo, and stands a stub
 * on PATH for `eslint`, the one binary a gate names itself.
 *
 * These gates run in every adopter's `.husky/pre-commit`: loosen a case and a
 * red declared check or test commits unrefused, or a fresh adopter with no
 * command declared cannot commit at all.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import { HOOK, LIB, ROOT } from "./lib/precommit-gate-testkit";
import { copyRequireClosure } from "./lib/require-closure";

const temps = registerTempCleanup();

/** From the column-zero `if` above `anchor`'s line to the `fi` closing `last`'s block. */
function cut(anchor: string, last = anchor): string {
	const lines = HOOK.split("\n");
	const at = (needle: string) =>
		lines.findIndex(
			(l) => l.includes(needle) && !l.trimStart().startsWith("#"),
		);
	let start = at(anchor);
	expect(start, `no ${anchor} in .husky/pre-commit`).toBeGreaterThan(-1);
	while (!lines[start].startsWith("if ")) start--;
	const end = lines.findIndex((l, i) => i > at(last) && l === "fi");
	return lines.slice(start, end + 1).join("\n");
}

const GATES = {
	check_staged: cut("command check_staged"),
	typecheck: cut("command typecheck"),
	lint: cut("command lint"),
	test: cut("test-gate.js commit"),
};

function fixture(config: object | null): string {
	const { root, git } = newRepo("declared-commands-", temps);
	copyRequireClosure(root, ROOT, [
		"scripts/lib/workflow-core-config.js",
		"scripts/lib/host-root.js",
		"scripts/lib/caught.js",
		"scripts/lib/test-gate.js",
		"scripts/lib/commit-key.js",
		"scripts/lib/isolated-worktree.js",
	]);
	if (config) {
		fs.mkdirSync(path.join(root, ".claude"));
		fs.writeFileSync(
			path.join(root, ".claude/workflow-core.json"),
			JSON.stringify(config),
		);
	}
	fs.mkdirSync(path.join(root, "bin"));
	fs.writeFileSync(
		path.join(root, "bin/eslint"),
		"#!/bin/sh\ntouch RAN-lint\n",
		{
			mode: 0o755,
		},
	);
	fs.mkdirSync(path.join(root, "app"));
	fs.writeFileSync(path.join(root, "app/x.ts"), "export {};\n");
	git("add", "app/x.ts");
	return root;
}

function run(
	root: string,
	gate: string,
	searchPath = `${path.join(root, "bin")}:${process.env.PATH}`,
) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: searchPath,
		RAN_DIR: root,
	};
	delete env.CLAUDE_PROJECT_DIR;
	// `sh -e`, as husky runs the hook, with a trailing no-op so a gate that
	// fell through without its own `exit` still reads as passing.
	const r = spawnSync("sh", ["-ec", `{\n${LIB}\n${gate}\n:\n} 2>&1`], {
		cwd: root,
		env,
		encoding: "utf8",
	});
	// Each command leaves a file behind: the typecheck gate holds a green
	// command's output back, so stdout cannot say whether it ran.
	return {
		code: r.status,
		out: r.stdout,
		ran: (name: string) => fs.existsSync(path.join(root, `RAN-${name}`)),
	};
}

const declared = {
	check_staged: "touch RAN-check_staged",
	typecheck: "touch RAN-typecheck",
	lint: "switches the gate on; it runs eslint itself",
	// The test gate runs in a throwaway worktree (#1766), so its marker is rooted.
	test: 'touch "$RAN_DIR/RAN-test"',
};

describe.each(Object.keys(GATES) as (keyof typeof GATES)[])(
	"the pre-commit %s gate",
	(name) => {
		it("exits 0 with its one skip line, running nothing, where the command is undeclared", () => {
			const { code, out, ran } = run(fixture({}), GATES[name]);
			expect(code).toBe(0);
			expect(ran(name)).toBe(false);
			expect(out).toBe(
				`SKIP: commands.${name} is undeclared in .claude/workflow-core.json\n`,
			);
		});

		it("runs where the command is declared", () => {
			const { code, out, ran } = run(
				fixture({ commands: { [name]: declared[name] } }),
				GATES[name],
			);
			expect(code).toBe(0);
			expect(ran(name)).toBe(true);
			expect(out).not.toContain("SKIP:");
		});

		it("refuses the commit on a contract the reader does not read, as BROKEN naming the contract, and runs no command", () => {
			const { code, out, ran } = run(
				fixture({ contract: 9, commands: { [name]: declared[name] } }),
				GATES[name],
			);
			expect(code).toBe(1);
			expect(out).toMatch(/^BROKEN: .*declares contract 9/);
			expect(ran(name)).toBe(false);
		});
	},
);

it("fails the commit where the declared check_staged command fails", () => {
	const { code } = run(
		fixture({ commands: { check_staged: "exit 3" } }),
		GATES.check_staged,
	);
	expect(code).toBe(1);
});

it("reports a red declared typecheck without blocking the commit", () => {
	const { code, out } = run(
		fixture({ commands: { typecheck: "echo tsc-said-no; exit 1" } }),
		GATES.typecheck,
	);
	expect(code).toBe(0);
	expect(out).toContain("tsc-said-no");
	expect(out).toContain("is RED — reporting only");
});

it("skips the declared lint gate, saying so, where eslint is not on PATH", () => {
	const root = fixture({ commands: { lint: declared.lint } });
	const { code, out, ran } = run(
		root,
		GATES.lint,
		`${path.dirname(process.execPath)}:/usr/bin:/bin`,
	);
	expect(code).toBe(0);
	expect(out).toBe(
		"SKIP: commands.lint is declared, but eslint is not on PATH\n",
	);
	expect(ran("lint")).toBe(false);
});

it("refuses the commit where the declared test command is red, printing its output", () => {
	const { code, out } = run(
		fixture({ commands: { test: "echo 'not ok 1 - contract'; exit 1" } }),
		GATES.test,
	);
	expect(code).toBe(1);
	expect(out).toContain("not ok 1 - contract");
	expect(out).toContain("the declared test command is RED");
});

/* The comment is what names the runner: the fixture has no run-vitest.js. */
const MINTING = 'touch "$RAN_DIR/RAN-test" # scripts/run-vitest.js';

it("leaves a test command that writes the test-pass marker to pre-push, running nothing", () => {
	const root = fixture({ commands: { test: MINTING } });
	const { code, out, ran } = run(root, GATES.test);
	expect(code).toBe(0);
	expect(ran("test")).toBe(false);
	expect(out).toBe(
		'SKIP: commands.test is gated at push by the test-pass marker — module "suites" is on and it runs scripts/run-vitest.js\n',
	);
});

it("runs that same command at commit where suites is off, since no push reads its marker", () => {
	const root = fixture({ commands: { test: MINTING } });
	const { code, ran } = run(root, `WFC_MODULES=\n${GATES.test}`);
	expect(code).toBe(0);
	expect(ran("test")).toBe(true);
});
