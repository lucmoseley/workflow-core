// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandPath } from "./command-path-testkit";
import {
	registerTempCleanup,
	stagedRepo,
	writeFiles,
} from "./precommit-gate-harness";
import { CORE_ROOT, LIB, LIB_COMMANDS, ROOT } from "./precommit-gate-testkit";
import { shellQuote } from "./sh-quote.js";

const temps = registerTempCleanup();

interface Run {
	code: number;
	output: string;
}

function run(
	script: string,
	opts: {
		committed?: Record<string, string>;
		staged?: Record<string, string>;
		dirty?: Record<string, string>;
		env?: NodeJS.ProcessEnv;
	} = {},
): Run {
	const { root } = stagedRepo(
		"precommit-gate-",
		temps,
		opts.committed ?? {},
		opts.staged ?? {},
	);
	writeFiles(root, opts.dirty ?? {});

	try {
		return {
			code: 0,
			output: execFileSync("sh", ["-ec", `{\n${LIB}\n${script}\n} 2>&1`], {
				cwd: root,
				encoding: "utf8",
				env: opts.env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		};
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

const checker = (code: number) =>
	`const fs = require("node:fs");
console.log("CHECK-RAN");
for (const a of process.argv.slice(2)) {
	if (a.startsWith("-")) continue;
	console.log("ARG " + (fs.existsSync(a) ? fs.readFileSync(a, "utf8").trim() : "ABSENT"));
}
process.exit(${code});
`;

describe("gate_tmpdir", () => {
	it("removes every directory it handed out, however the hook leaves", () => {
		const { output } = run(
			`gate_tmpdir; a="$GATE_DIR"
gate_tmpdir; b="$GATE_DIR"
echo "DIRS $a $b"
exit 3`,
		);

		const [, a, b] = /DIRS (\S+) (\S+)/.exec(output) as RegExpExecArray;
		expect(a).not.toBe(b);
		expect(fs.existsSync(a)).toBe(false);
		expect(fs.existsSync(b)).toBe(false);
	});

	it.each([
		["HUP", 129],
		["INT", 130],
		["TERM", 143],
	])("removes every directory on SIG%s, exiting %i", (signal, status) => {
		const { code, output } = run(
			`gate_tmpdir
echo "DIR[$GATE_DIR]"
kill -${signal} $$
echo SURVIVED`,
		);

		const dir = /DIR\[(.+)\]/.exec(output)?.[1] as string;
		expect(output).not.toContain("SURVIVED");
		expect(code).toBe(status);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("registers the directory in the caller's shell, not a subshell", () => {
		const { output } = run(`gate_tmpdir; echo "LIST[$GATE_TMPDIRS]"`);

		expect(output).toMatch(/LIST\[\S+\n\]/);
	});

	it("removes a directory whose path contains a space", () => {
		const holder = fs.mkdtempSync(path.join(os.tmpdir(), "gate space-"));
		temps.push(holder);
		const victim = path.join(holder, "keep");
		fs.mkdirSync(victim);

		const { output } = run(
			`export TMPDIR=${shellQuote(holder)}
gate_tmpdir
echo "DIR[$GATE_DIR]"`,
		);

		const dir = /DIR\[(.+)\]/.exec(output)?.[1] as string;
		expect(dir.startsWith(holder)).toBe(true);
		expect(fs.existsSync(dir)).toBe(false);
		expect(fs.existsSync(victim)).toBe(true);
	});
});

describe("gate_stage_out", () => {
	it("copies the INDEX bytes, never the working tree's", () => {
		const { output } = run(
			`gate_tmpdir
gate_stage_out "$GATE_DIR" docs/a.md
cat "$GATE_DIR/a.md"`,
			{
				committed: { "docs/a.md": "old\n" },
				staged: { "docs/a.md": "INDEX\n" },
				dirty: { "docs/a.md": "NEIGHBOURS-HALF-SAVED\n" },
			},
		);

		expect(output).toContain("INDEX");
		expect(output).not.toContain("NEIGHBOUR");
	});

	it("reports a required path absent from the index", () => {
		const { output } = run(
			`gate_tmpdir
if gate_stage_out "$GATE_DIR" docs/gone.md; then echo READABLE; else echo MISSING; fi`,
			{ committed: { "docs/a.md": "a\n" } },
		);

		expect(output).toContain("MISSING");
	});

	it("drops an `opt:` path instead of failing, leaving no partial copy", () => {
		const { output } = run(
			`gate_tmpdir
if gate_stage_out "$GATE_DIR" docs/a.md opt:docs/gone.json; then echo READABLE; else echo MISSING; fi
ls "$GATE_DIR"`,
			{ committed: { "docs/a.md": "a\n" } },
		);

		expect(output).toContain("READABLE");
		expect(output).toContain("a.md");
		expect(output).not.toContain("gone.json");
	});

	it("leaves only the paths that failed in GATE_MISSING", () => {
		const { output } = run(
			`gate_tmpdir
gate_stage_out "$GATE_DIR" docs/a.md docs/gone.md opt:docs/also-gone.json || true
gate_skip_missing demo`,
			{ committed: { "docs/a.md": "a\n" } },
		);

		expect(output).toContain("not readable from the index: docs/gone.md.");
		expect(output).not.toContain("docs/a.md");
		expect(output).not.toContain("also-gone");
	});
});

describe("staged_gate", () => {
	const call = (mode: string, exit: string, advice = "") =>
		`staged_gate demo ${mode} ${exit} 'docs/a.md' 'node check.js "$sg_dir/a.md"' ${shellQuote(advice)}`;

	const withChecker = (code: number) => ({
		committed: { "check.js": checker(code), "docs/a.md": "old\n" },
		staged: { "docs/a.md": "INDEX\n" },
	});

	it("passes a green check silently in hold mode", () => {
		const r = run(call("hold", "status"), withChecker(0));

		expect(r.code).toBe(0);
		expect(r.output).toBe("");
	});

	it("lets a green check speak in live mode", () => {
		expect(run(call("live", "status"), withChecker(0)).output).toContain(
			"CHECK-RAN",
		);
	});

	it("replays the held output and the advice on a failure", () => {
		const r = run(
			call("hold", "status", "  Fix: do the thing."),
			withChecker(1),
		);

		expect(r.code).toBe(1);
		expect(r.output).toContain("CHECK-RAN");
		expect(r.output).toContain("Fix: do the thing.");
	});

	it("refuses with the checker's own code, keeping BROKEN distinguishable", () => {
		expect(run(call("hold", "status"), withChecker(2)).code).toBe(2);
	});

	it("refuses with the literal code when one is declared", () => {
		expect(run(call("hold", "1"), withChecker(2)).code).toBe(1);
	});

	it("warns and passes when the blob is not in the index, naming the check and the path, without running", () => {
		const r = run(call("hold", "status"), {
			committed: { "check.js": checker(1) },
		});

		expect(r.code).toBe(0);
		expect(r.output).toContain("skipped the demo check");
		expect(r.output).toContain("docs/a.md");
		expect(r.output).not.toContain("CHECK-RAN");
	});

	it("returns cleanly from a green check rather than tripping sh -e", () => {
		const r = run(
			`${call("hold", "status")}\necho REACHED-THE-NEXT-GATE`,
			withChecker(0),
		);

		expect(r.code).toBe(0);
		expect(r.output).toContain("REACHED-THE-NEXT-GATE");
	});
});

describe("armed (#1504)", () => {
	const arms = (pattern: string) =>
		`if armed ${shellQuote(pattern)}; then echo ARMED; else echo UNARMED; fi`;

	it("arms on a file moved OUT of the gate's prefix (mantahostels#2903, #1483)", () => {
		const { output } = run(`git mv docs/a.md elsewhere.md\n${arms("^docs/")}`, {
			committed: { "docs/a.md": "a\n" },
		});
		expect(output).toContain("ARMED");
		expect(output).not.toContain("UNARMED");
	});

	it("does not arm on a move with neither end in the prefix", () => {
		const { output } = run(`git mv notes/a.md notes/b.md\n${arms("^docs/")}`, {
			committed: { "notes/a.md": "a\n" },
		});
		expect(output).toContain("UNARMED");
	});

	it("arms on a non-ASCII path under the prefix (mantahostels#2869)", () => {
		const { output } = run(arms("^docs/"), {
			staged: { "docs/café.md": "x\n" },
		});
		expect(output).toContain("ARMED");
		expect(output).not.toContain("UNARMED");
	});

	it("does not arm on a non-ASCII path outside the prefix", () => {
		const { output } = run(arms("^docs/"), {
			staged: { "notes/café.md": "x\n" },
		});
		expect(output).toContain("UNARMED");
	});

	it("sets armed_paths to the matching paths alone", () => {
		const { output } = run(
			`armed '^docs/'; printf 'PATHS[%s]\\n' "$armed_paths"`,
			{ staged: { "docs/a.md": "x\n", "app/b.ts": "x\n" } },
		);
		expect(output).toContain("PATHS[docs/a.md]");
	});

	it("reads the staged list once per hook run", () => {
		const { output } = run(
			`armed '^docs/' || :
echo x > late.md; git add late.md
${arms("^late")}`,
			{ staged: { "docs/a.md": "x\n" } },
		);
		expect(output).toContain("UNARMED");
	});

	it("refuses the commit when git cannot read the staged list", () => {
		const { code, output } = run(
			`echo junk > bad-index
GIT_INDEX_FILE="$PWD/bad-index"; export GIT_INDEX_FILE
${arms("^docs/")}
echo REACHED`,
		);
		expect(code).toBe(1);
		expect(output).toContain("could not read this commit's staged paths");
		expect(output).not.toContain("REACHED");
	});
});

describe("armed_live and tool_gate (#1504)", () => {
	it("drops a deletion, an untracked-but-kept path and a path gone from the worktree", () => {
		const { output } = run(
			`git rm -q docs/gone.md
git rm -q --cached docs/kept.md
rm docs/vanished.md
armed '^docs/'
printf 'LIVE[%s]\\n' "$(armed_live)"`,
			{
				committed: { "docs/gone.md": "g\n", "docs/kept.md": "k\n" },
				staged: { "docs/live.md": "x\n", "docs/vanished.md": "v\n" },
			},
		);
		expect(output).toContain("LIVE[docs/live.md]");
	});

	it("keeps a staged path gone from the worktree under --index, and still drops a deletion", () => {
		const { output } = run(
			`git rm -q docs/gone.md
rm docs/vanished.md
armed '^docs/'
printf 'INDEX[%s]\\n' "$(armed_live --index | tr '\\n' ' ')"`,
			{
				committed: { "docs/gone.md": "g\n" },
				staged: { "docs/live.md": "x\n", "docs/vanished.md": "v\n" },
			},
		);
		expect(output).toContain("INDEX[docs/live.md docs/vanished.md ]");
	});

	it("never calls the tool with an empty list, and says nothing about a missing binary then", () => {
		const { output } = run(
			`git rm -q docs/gone.md
armed '^docs/'
if tool_gate no-such-linter "x"; then echo RUN; else echo PASSED; fi`,
			{ committed: { "docs/gone.md": "g\n" } },
		);
		expect(output).toContain("PASSED");
		expect(output).not.toContain("SKIPPED");
	});

	it("skips a missing binary with the one wording, naming the install hint", () => {
		const { code, output } = run(
			`armed '^docs/'
if tool_gate no-such-linter "fetch it from the release page."; then echo RUN; fi`,
			{ staged: { "docs/a.md": "x\n" } },
		);
		expect(code).toBe(0);
		expect(output).toContain(
			"pre-commit: no-such-linter is not on PATH — its gate is SKIPPED, this commit is NOT blocked.",
		);
		expect(output).toContain(
			"npm install does not supply it; fetch it from the release page.",
		);
		expect(output).not.toContain("RUN");
		expect(output).not.toMatch(/what this lets through/);
	});

	const noShellcheck = (): NodeJS.ProcessEnv => {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "no-shellcheck-"));
		temps.push(bin);
		for (const cmd of ["sh", "node", ...LIB_COMMANDS]) {
			const abs = commandPath(cmd);
			fs.symlinkSync(abs, path.join(bin, cmd));
		}
		return { ...process.env, PATH: bin, WFC_PLUGIN_ROOT: ROOT };
	};

	it("names the workflow that runs a missing tool, through npm scripts too (#1629)", () => {
		const { code, output } = run(
			`armed '^docs/'
if tool_gate shellcheck "x"; then echo RUN; fi`,
			{
				committed: {
					".github/workflows/lint.yml": "      - run: npm run check:sh\n",
					"package.json": JSON.stringify({
						scripts: { "check:sh": "shellcheck scripts/*.sh" },
					}),
				},
				staged: { "docs/a.md": "x\n" },
				env: noShellcheck(),
			},
		);
		expect(code).toBe(0);
		expect(output).toContain(
			"shellcheck runs in .github/workflows/lint.yml, which can catch what this lets through when it next runs.",
		);
		expect(output).not.toContain("RUN");
	});

	it("says no workflow runs a missing tool where none does, never naming ci.yml (#1629)", () => {
		const { code, output } = run(
			`armed '^docs/'
if tool_gate shellcheck "x"; then echo RUN; fi`,
			{ staged: { "docs/a.md": "x\n" }, env: noShellcheck() },
		);
		expect(code).toBe(0);
		expect(output).toContain(
			"No workflow under .github/workflows/ runs shellcheck, so nothing catches what this lets through.",
		);
		expect(output).not.toMatch(/ci\.yml/);
	});

	it("says it could not read the workflows where ci-runs.js crashes, rather than naming none (#1629)", () => {
		const plugin = fs.mkdtempSync(path.join(os.tmpdir(), "crashing-plugin-"));
		temps.push(plugin);
		fs.mkdirSync(path.join(plugin, "scripts", "lib"), { recursive: true });
		fs.writeFileSync(
			path.join(plugin, "scripts", "lib", "ci-runs.js"),
			"process.exit(3);\n",
		);
		const { code, output } = run(
			`armed '^docs/'
if tool_gate shellcheck "x"; then echo RUN; fi`,
			{
				staged: { "docs/a.md": "x\n" },
				env: { ...noShellcheck(), WFC_PLUGIN_ROOT: plugin },
			},
		);
		expect(code).toBe(0);
		expect(output).toContain(
			"Could not read which workflows run shellcheck: scripts/lib/ci-runs.js failed.",
		);
		expect(output).not.toMatch(/No workflow under/);
	});

	it("sets tool_paths and runs where the binary is on PATH", () => {
		const { output } = run(
			`armed '^docs/'
if tool_gate sh "x"; then echo "RUN[$tool_paths]"; fi`,
			{ staged: { "docs/a.md": "x\n" } },
		);
		expect(output).toContain("RUN[docs/a.md]");
	});
});

describe("declared_cmd (#1504)", () => {
	const reader = (code: number) =>
		`declared_cmd sh -c 'echo "touch RAN"; [ ${code} -ne 1 ] || echo "SKIP: undeclared" >&2; exit ${code}'`;

	it("runs the printed command on the reader's 0", () => {
		const { code, output } = run(
			`if ${reader(0)}; then echo "RUN[$declared_command]"; fi`,
		);
		expect(code).toBe(0);
		expect(output).toContain("RUN[touch RAN]");
	});

	it("skips with the reader's own SKIP line on its 1", () => {
		const { code, output } = run(
			`if ${reader(1)}; then echo RUN; fi\necho PASSED`,
		);
		expect(code).toBe(0);
		expect(output).toContain("SKIP: undeclared");
		expect(output).toContain("PASSED");
		expect(output).not.toContain("RUN");
	});

	it.each([2, 124, 137])(
		"refuses the commit on the reader's %i, a reader killed at hook-bound.sh's limit among them (#4187)",
		(status) => {
			const { code, output } = run(
				`if ${reader(status)}; then echo RUN; fi\necho PASSED`,
			);
			expect(code).toBe(1);
			expect(output).not.toContain("RUN");
			expect(output).not.toContain("PASSED");
		},
	);
});

describe("the library and the hook", () => {
	it("is sourced by .husky/pre-commit, above the first gate", () => {
		const hook = fs.readFileSync(
			path.join(ROOT, ".husky", "pre-commit"),
			"utf8",
		);
		const source = hook.indexOf(`. ${CORE_ROOT}scripts/lib/precommit-gate.sh`);

		expect(source).toBeGreaterThan(-1);
		expect(source).toBeLessThan(hook.indexOf("if declared_cmd "));
		expect(source).toBeLessThan(hook.indexOf("if armed "));
	});
});
