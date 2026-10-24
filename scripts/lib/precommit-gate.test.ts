// @vitest-environment node
/*
 * scripts/lib/precommit-gate.sh — the staged-gate module, against a fake
 * checker (mantahostels#1793).
 *
 * The per-gate suites next door prove each gate's own arming pattern and paths.
 *
 * Every case runs the REAL library text under `sh -e`, as husky runs the hook,
 * in a throwaway git repo — the shared tree's index is repo-global (mantahostels#63) and
 * must never be staged into by a test.
 *
 * `.husky/pre-commit` sources the module and runs every staged gate through
 * it, so a loosened case can let a gate skip the commit it should judge — its
 * finding landing on `main` unrefused — or refuse every commit at once.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	registerTempCleanup,
	stagedRepo,
	writeFiles,
} from "./precommit-gate-harness";
import { CORE_ROOT, LIB, LIB_COMMANDS, ROOT } from "./precommit-gate-testkit";

const temps = registerTempCleanup();

interface Run {
	code: number;
	output: string;
}

/**
 * Runs `script` after the library, in a repo holding one commit.
 *
 * `staged` is written and staged; `dirty` is written AFTER staging, so the
 * index and the working tree disagree on purpose.
 */
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

/** A node script that prints its arguments' contents and exits `code`. */
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

	/* The rejected draft was `dir="$(gate_tmpdir)"`, whose body runs in a
	 * command-substitution subshell: the append to GATE_TMPDIRS is lost there, so
	 * the trap has nothing to remove and the directory outlives the hook. */
	it("registers the directory in the caller's shell, not a subshell", () => {
		const { output } = run(`gate_tmpdir; echo "LIST[$GATE_TMPDIRS]"`);

		expect(output).toMatch(/LIST\[\S+\n\]/);
	});

	/* `mktemp -d` honours TMPDIR, so a TMPDIR holding a space would split one
	 * directory into two words if the list were whitespace-separated — `rm -rf`
	 * on an unrelated path, and the real directory leaked. */
	it("removes a directory whose path contains a space", () => {
		const holder = fs.mkdtempSync(path.join(os.tmpdir(), "gate space-"));
		temps.push(holder);
		const victim = path.join(holder, "keep");
		fs.mkdirSync(victim);

		const { output } = run(
			`export TMPDIR="${holder}"
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

	/* An `opt:` path is one whose ABSENCE the checker reads correctly — the
	 * superseded gate's needle file, where a truncated copy would reach it as
	 * corrupt JSON and report the wrong fault. */
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

	/* The skip line is the only notice anyone gets that a gate stopped gating, so
	 * it names the paths that actually failed — not the whole list, which would
	 * send a reader off to check files that are fine. */
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
		`staged_gate demo ${mode} ${exit} 'docs/a.md' 'node check.js "$sg_dir/a.md"' ${JSON.stringify(advice)}`;

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

	/* Apparatus missing is not a finding: the gate warns and passes, leaving it
	 * to the scheduled sweeps, rather than making a legitimate deletion
	 * uncommittable. */
	it("warns and passes when the blob is not in the index, naming the check and the path, without running", () => {
		const r = run(call("hold", "status"), {
			committed: { "check.js": checker(1) },
		});

		expect(r.code).toBe(0);
		expect(r.output).toContain("skipped the demo check");
		expect(r.output).toContain("docs/a.md");
		expect(r.output).not.toContain("CHECK-RAN");
	});

	/* The green path has to RETURN, not fall off the end of a false test: under
	 * `sh -e` a function ending on an AND-OR list whose test failed returns 1 and
	 * aborts the hook, refusing a commit every gate had passed. */
	it("returns cleanly from a green check rather than tripping sh -e", () => {
		const r = run(
			`${call("hold", "status")}\necho REACHED-THE-NEXT-GATE`,
			withChecker(0),
		);

		expect(r.code).toBe(0);
		expect(r.output).toContain("REACHED-THE-NEXT-GATE");
	});
});

describe("gate_direction", () => {
	const call =
		'if gate_direction demo "#1" node cmp.js; then echo PASSED; else echo REFUSED; fi';

	const cmp = (code: number, stdout = "", stderr = "") => ({
		committed: {
			"cmp.js":
				`${stdout ? `console.log(${JSON.stringify(stdout)});\n` : ""}` +
				`${stderr ? `console.error(${JSON.stringify(stderr)});\n` : ""}` +
				`process.exit(${code});\n`,
		},
	});

	const notAnAnswer = "could not tell inherited demo faults";
	const addsThem = "are NOT in HEAD";
	const diagnostics = "diagnostics, not findings";

	it("refuses when the comparison script is not there at all, as a failure to answer, not as new faults", () => {
		const r = run(call);

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(notAnAnswer);
		expect(r.output).not.toContain(addsThem);
		expect(r.output).not.toContain("already in HEAD");
	});

	it("refuses a comparison that will not parse, as a failure to answer, not as new faults", () => {
		const r = run(call, { committed: { "cmp.js": "function (\n" } });

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(notAnAnswer);
		expect(r.output).not.toContain(addsThem);
	});

	/* The stack trace is the crash's, so it must reach the session labelled as
	 * diagnostics rather than as the faults this commit added. */
	it("refuses a comparison that throws before it runs, saying it could not tell inherited faults, and labels the trace", () => {
		const r = run(call, {
			committed: { "cmp.js": 'throw new Error("boom at require time");\n' },
		});

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(notAnAnswer);
		expect(r.output).not.toContain(addsThem);
		expect(r.output).toContain(diagnostics);
		expect(r.output).toContain("boom at require time");
	});

	it("refuses and names the faults this commit adds", () => {
		const r = run(call, cmp(1, "dead: docs/x.md"));

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(addsThem);
		expect(r.output).toContain("docs/x.md");
		expect(r.output).not.toContain(notAnAnswer);
	});

	/* EXIT 1 OBLIGES A FAULT LIST (mantahostels#2026): a 1 that named nothing on either
	 * stream has answered nothing, and must not refuse under wording that says
	 * the commit added faults it never listed. */
	it("refuses a silent exit 1 as a failure to answer, not as new faults, with no diagnostics block", () => {
		const r = run(call, cmp(1));

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(notAnAnswer);
		expect(r.output).not.toContain(addsThem);
		// A comparison that wrote nothing gets no diagnostics block: the `-s`
		// test, not a `-f` one, the file existing on every run.
		expect(r.output).not.toContain(diagnostics);
	});

	it("passes the commit when every fault is inherited", () => {
		const r = run(call, cmp(0));

		expect(r.output).toContain("PASSED");
		expect(r.output).toContain("already in HEAD");
		expect(r.output).not.toContain(diagnostics);
	});

	/* THE VERDICT IS THE EXIT STATUS, NEVER THE TEXT: the rejected draft tested
	 * the comparison's stdout, which refuses every commit a chatty clean run
	 * should have passed. */
	it("passes a clean comparison that printed something anyway", () => {
		const r = run(call, cmp(0, "nothing new here"));

		expect(r.output).toContain("PASSED");
		expect(r.output).toContain("already in HEAD");
	});

	/* The pass limb replays stderr too (mantahostels#2026). */
	it("passes a clean comparison that wrote to stderr, and replays it", () => {
		const r = run(call, cmp(0, "", "warning: sidecar is stale"));

		expect(r.output).toContain("PASSED");
		expect(r.output).toContain("already in HEAD");
		expect(r.output).toContain(diagnostics);
		expect(r.output).toContain("sidecar is stale");
	});

	/* THE COMPOSITION, pinned by the VERDICT LINE (mantahostels#2314). The two halves are
	 * tested apart — lib/fault-diff.test.ts proves the comparison exits 2 on a
	 * crash, and the cases above prove what this gate does with each code — so
	 * nothing here would notice if the gate started reading a 2 as an answer.
	 * The cmp.js is the real shape: it runs the shared CLI, whose writes are
	 * wrapped so it prints part of a fault list and then crashes, as no stdio
	 * the gate hands it can fail on cue. */
	it("refuses a comparison that crashes mid-list as a failure to answer, not as new faults, under a diagnostics block", () => {
		const seam = JSON.stringify(
			path.join(ROOT, "scripts", "lib", "fault-diff.js"),
		);
		const r = run(call, {
			committed: {
				"cmp.js": `const fs = require("node:fs");
fs.writeFileSync("staged.json", JSON.stringify({ findings: ["docs/a.md dead"] }));
fs.writeFileSync("baseline.json", JSON.stringify({ findings: [] }));
const inner = fs.writeSync;
let stderrFailed = false;
fs.writeSync = (fd, data, ...rest) => {
	if (fd === 1) {
		inner(1, String(data).slice(0, 16));
		throw new Error("stdout went away mid-list");
	}
	if (fd === 2 && !stderrFailed) {
		stderrFailed = true;
		throw new Error("stderr went away too");
	}
	return inner(fd, data, ...rest);
};
require(${seam}).runCli("demo", "staged.json", "baseline.json", {
	keys: (k) => k === "findings",
	identity: (i) => i,
});
`,
			},
		});

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(notAnAnswer);
		expect(r.output).not.toContain(addsThem);
		expect(r.output).toContain(diagnostics);
		expect(r.output).toContain("crashed before it finished the fault list");
	});

	it("refuses a comparison that cannot answer", () => {
		const r = run(call, cmp(2, "envelope unreadable"));

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(notAnAnswer);
		expect(r.output).not.toContain("already in HEAD");
	});

	/* Both streams on the one limb (mantahostels#2026): the fault list is indented under the
	 * "NOT in HEAD" heading, and the noise sits below its own heading rather
	 * than inside that list. */
	it("keeps a noisy stderr out of the fault list it refuses on", () => {
		const r = run(call, cmp(1, "dead: docs/x.md", "note: cache miss"));

		expect(r.output).toContain("REFUSED");
		expect(r.output).toContain(addsThem);
		expect(r.output).toContain("  dead: docs/x.md");
		expect(r.output).toContain(diagnostics);
		expect(r.output).toContain("  | note: cache miss");
		expect(r.output).not.toContain("  note: cache miss\n");
	});
});

describe("armed (#1504)", () => {
	const arms = (pattern: string) =>
		`if armed '${pattern}'; then echo ARMED; else echo UNARMED; fi`;

	/* git's rename detection reports a `git mv` as one R entry naming the NEW
	 * path alone; the read takes --no-renames so the old path is back. */
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

	/* A bare --name-only renders this path as `"docs/caf\303\251.md"`, which
	 * no prefix pattern matches. */
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

	it("matches -F's literal paths whole, and arms nothing on an empty list", () => {
		const { output } = run(
			`if armed -F "docs/a.md"; then echo WHOLE; fi
if armed -F "docs/a"; then echo PART; fi
if armed -F ""; then echo EMPTY; fi`,
			{ staged: { "docs/a.md": "x\n" } },
		);
		expect(output).toContain("WHOLE");
		expect(output).not.toContain("PART");
		expect(output).not.toContain("EMPTY");
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
		// ci-runs.js knows no such tool, so no CI line is printed.
		expect(output).not.toMatch(/what this lets through/);
	});

	/**
	 * An env whose PATH holds only what the library and ci-runs.js need, and
	 * whose plugin root is this checkout, where ci-runs.js lives.
	 */
	const noShellcheck = (): NodeJS.ProcessEnv => {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "no-shellcheck-"));
		temps.push(bin);
		for (const cmd of ["sh", "node", ...LIB_COMMANDS]) {
			const abs = execFileSync("sh", ["-c", `command -v ${cmd}`], {
				encoding: "utf8",
			}).trim();
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

	it("refuses the commit on the reader's 2", () => {
		const { code, output } = run(
			`if ${reader(2)}; then echo RUN; fi\necho PASSED`,
		);
		expect(code).toBe(1);
		expect(output).not.toContain("RUN");
		expect(output).not.toContain("PASSED");
	});
});

describe("the library and the hook", () => {
	/* Sourced ABOVE the first gate, not merely somewhere: below one, that gate
	 * aborts on an undefined command — fail-closed, but it refuses every commit
	 * in scope with an error nobody would trace back to a source line. Nothing
	 * else catches it: cutGateScript inlines the library, so every gate suite
	 * would stay green with the source line deleted outright. */
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
