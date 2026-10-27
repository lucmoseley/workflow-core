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
 * The check_staged gate also refuses, before it runs, a command that runs
 * `biome check --staged` (#2775). The gate's classifier, infer-commands.js
 * check-staged, also runs here as a program through run-in-process.
 *
 * These gates run in every adopter's `.husky/pre-commit`: loosen a case and a
 * red declared check or test commits unrefused, or a fresh adopter with no
 * command declared cannot commit at all.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BIOME_STAGED_COMMAND } from "./lib/infer-commands.js";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import { HOOK, LIB, ROOT } from "./lib/precommit-gate-testkit";
import { copyRequireClosure } from "./lib/require-closure";
import { runInProcess } from "./lib/run-in-process";

const temps = registerTempCleanup();
const INFER = path.join(ROOT, "scripts", "lib", "infer-commands.js");

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
		"scripts/lib/infer-commands.js",
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

it("skips the declared typecheck at once, saying so, where its no-wait try finds the type-check slot held (#3278)", () => {
	const command = '[ "$WFC_TSC_NO_WAIT" = 1 ] && exit 75; touch RAN-typecheck';
	const { code, out, ran } = run(
		fixture({ commands: { typecheck: command } }),
		GATES.typecheck,
	);
	expect(code).toBe(0);
	expect(ran("typecheck")).toBe(false);
	expect(out).toBe(
		`pre-commit: the type-check slot is held — ${command} skipped, not waited for, as this commit holds .git/index.lock (#3278). ci.yml's Typecheck step is the gate.\n`,
	);
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
		'SKIP: commands.test is gated at push by certificates — module "suites" is on and it runs scripts/run-vitest.js\n',
	);
});

it("runs that same command at commit where suites is off, since no push reads its marker", () => {
	const root = fixture({ commands: { test: MINTING } });
	const { code, ran } = run(root, `WFC_MODULES=\n${GATES.test}`);
	expect(code).toBe(0);
	expect(ran("test")).toBe(true);
});

/* A stand-in `biome` (or any command) that leaves the gate's marker, and on
 * `--write` rewrites the staged file. */
const MARKER_STUB =
	'#!/bin/sh\ntouch RAN-check_staged\ncase " $* " in *" --write "*) echo rewritten > app/x.ts ;; esac\n';

function biomeFixture(
	checkStaged: string,
	pkg: object = {},
): { root: string; run: () => ReturnType<typeof run> } {
	const root = fixture({ commands: { check_staged: checkStaged } });
	fs.writeFileSync(path.join(root, "bin/biome"), MARKER_STUB, { mode: 0o755 });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
	return { root, run: () => run(root, GATES.check_staged) };
}

const declaresBiome = (script: string) => ({
	scripts: { "check:staged": script },
	devDependencies: { "@biomejs/biome": "2.0.0" },
});

const MAPPED = `${BIOME_STAGED_COMMAND} --no-errors-on-unmatched`;

/* With the classifier gone, a gate that spent node on it would refuse. */
function withoutClassifier(root: string): void {
	fs.rmSync(path.join(root, "scripts/lib/infer-commands.js"));
}

describe("the pre-commit check_staged gate on a biome check --staged command (#2775)", () => {
	it("refuses an npm run whose script maps, naming the mapped command, before the script runs", () => {
		const { run: commit } = biomeFixture(
			"npm run check:staged",
			declaresBiome("biome check --staged --no-errors-on-unmatched"),
		);
		const { code, out, ran } = commit();
		expect(code).toBe(1);
		expect(out).toContain(
			'pre-commit: check_staged "npm run check:staged" (.claude/workflow-core.json) runs biome check --staged through package.json script "check:staged"',
		);
		expect(out).toContain(`Declare check_staged instead as '${MAPPED}'.`);
		expect(ran("check_staged")).toBe(false);
	});

	it("refuses a write-flag script the same way, leaving its worktree file unwritten", () => {
		const { root, run: commit } = biomeFixture(
			"npm run check:staged",
			declaresBiome("biome check --staged --write --no-errors-on-unmatched"),
		);
		const { code, out, ran } = commit();
		expect(code).toBe(1);
		expect(out).toContain("auto-fix on commit dropped");
		expect(out).toContain(`Declare check_staged instead as '${MAPPED}'.`);
		expect(ran("check_staged")).toBe(false);
		expect(fs.readFileSync(path.join(root, "app/x.ts"), "utf8")).toBe(
			"export {};\n",
		);
	});

	it("refuses a pnpm run whose script maps, as the npm one", () => {
		const { run: commit } = biomeFixture(
			"pnpm run check:staged",
			declaresBiome("biome check --staged --no-errors-on-unmatched"),
		);
		const { code, out, ran } = commit();
		expect(code).toBe(1);
		expect(out).toContain(`Declare check_staged instead as '${MAPPED}'.`);
		expect(ran("check_staged")).toBe(false);
	});

	it("refuses a declared check_staged that is itself biome check --staged", () => {
		const { run: commit } = biomeFixture(
			"biome check --staged --no-errors-on-unmatched",
			declaresBiome("unused"),
		);
		const { code, out, ran } = commit();
		expect(code).toBe(1);
		expect(out).toContain(`Declare check_staged instead as '${MAPPED}'.`);
		expect(ran("check_staged")).toBe(false);
	});

	it("runs a biome-staged.js command unclassified", () => {
		const { root } = biomeFixture(MAPPED);
		withoutClassifier(root);
		fs.writeFileSync(
			path.join(root, "scripts/biome-staged.js"),
			'require("node:fs").writeFileSync("RAN-check_staged", "");\n',
		);
		const { code, out, ran } = run(
			root,
			`export WFC_PLUGIN_ROOT=.\n${GATES.check_staged}`,
		);
		expect(code, out).toBe(0);
		expect(ran("check_staged"), out).toBe(true);
	});

	it.each(["eslint --max-warnings=0 app", "./scripts/my-check.sh"])(
		"runs the unrelated %s as before, unclassified",
		(command) => {
			const { root } = biomeFixture(command);
			withoutClassifier(root);
			fs.writeFileSync(path.join(root, "bin/eslint"), MARKER_STUB, {
				mode: 0o755,
			});
			fs.writeFileSync(path.join(root, "scripts/my-check.sh"), MARKER_STUB, {
				mode: 0o755,
			});
			const { code, out, ran } = run(root, GATES.check_staged);
			expect(code, out).toBe(0);
			expect(ran("check_staged"), out).toBe(true);
		},
	);

	it("runs an npm run whose script runs no biome check --staged", () => {
		const { run: commit } = biomeFixture("npm run check:staged", {
			scripts: { "check:staged": "touch RAN-check_staged" },
		});
		const { code, out, ran } = commit();
		expect(code, out).toBe(0);
		expect(ran("check_staged"), out).toBe(true);
	});
});

describe("infer-commands.js check-staged", () => {
	it("exits 1 on a package.json that does not parse, naming the hook's way out rather than init's --command (#3192)", () => {
		const { root } = biomeFixture("npm run check:staged");
		fs.writeFileSync(path.join(root, "package.json"), "{ not json");
		const r = runInProcess(INFER, ["check-staged", "npm run check:staged"], {
			cwd: root,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			'pre-commit: check_staged "npm run check:staged" (.claude/workflow-core.json) cannot be checked: package.json does not parse (',
		);
		expect(r.stderr).toContain(
			`Fix it, or declare check_staged in .claude/workflow-core.json as 'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js <flags>' or another command whose text contains neither 'run' nor 'biome'`,
		);
		expect(r.stderr).not.toContain("--command");
	});

	it("exits 2 on a missing command, printing the usage", () => {
		const { root } = biomeFixture("npm run check:staged");
		const r = runInProcess(INFER, ["check-staged"], { cwd: root });
		expect(r.status).toBe(2);
		expect(r.stderr).toBe("usage: infer-commands.js check-staged <command>\n");
	});
});
