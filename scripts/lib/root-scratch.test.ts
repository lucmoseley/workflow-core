// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { defineTemplate } from "./git-fixture";
import {
	type CoreRun,
	runCore,
	splitCheckout,
	toolCall,
} from "./guard-core-testkit";
import { runInProcess } from "./run-in-process.js";

let dir: string;
let repo: string;

beforeAll(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "root-scratch-")),
	);
	repo = path.join(dir, "repo");
	fs.mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
	fs.writeFileSync(
		path.join(repo, ".gitignore"),
		[
			".claude/tmp/",
			".codereview-nagged-*",
			".sweep-autofire",
			".roadmap-baseline*.html",
			".card-close-baseline*.html",
			".concision-pass-*",
			".codereview-pass-*",
			".hook-ran-*",
			".rule-injected-*",
			"",
		].join("\n"),
	);
	fs.writeFileSync(path.join(repo, ".mcp.json"), "{}\n");
	fs.writeFileSync(path.join(repo, ".envrc.dev"), "\n");
	execFileSync("git", ["add", ".gitignore", ".mcp.json", ".envrc.dev"], {
		cwd: repo,
	});
	execFileSync(
		"git",
		["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"],
		{ cwd: repo },
	);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Verdict {
	refusal: string | null;
}

const refusalOf = (output: CoreRun["output"]) =>
	output?.permissionDecision === "deny"
		? (output.permissionDecisionReason ?? null)
		: null;

function run(
	command: string,
	cwd = repo,
	session = "mine",
	agent?: string,
): Verdict {
	const { output } = runCore(
		"guard-root-scratch",
		toolCall(
			"Bash",
			{ command },
			{
				session_id: session,
				...(agent === undefined ? {} : { agent_id: agent }),
			},
		),
		{ root: repo, cwd },
	);
	return { refusal: refusalOf(output) };
}

const denies = (command: string) => run(command).refusal !== null;

describe("the lines its refusal takes from the rule store (#4129)", () => {
	it("carries whatever the two fragments say", () => {
		const rules = path.join(dir, "rules");
		fs.mkdirSync(rules, { recursive: true });
		fs.writeFileSync(
			path.join(rules, "scratch-dir-sanctioned.txt"),
			"SCRATCH.\n",
		);
		fs.writeFileSync(path.join(rules, "self-spelt-escape.txt"), "ESCAPE.\n");
		vi.stubEnv("WFC_RULES_DIR", rules);
		const { refusal } = run("echo x > .stray-4129");
		expect(refusal).toContain("and nowhere else — SCRATCH. Same command");
		expect(refusal).toContain("none is wanted: ESCAPE.");
	});

	it("still refuses, naming the file, where the store cannot give them", () => {
		vi.stubEnv("WFC_RULES_DIR", path.join(dir, "no-such-store"));
		const { refusal } = run("echo x > .stray-4129");
		expect(refusal).toContain("agents/rules/scratch-dir-sanctioned.txt");
		expect(refusal).toContain("agents/rules/self-spelt-escape.txt");
	});
});

function runTool(tool: "Write" | "Edit" | "NotebookEdit", target: string) {
	const { output } = runCore(
		"guard-root-scratch",
		toolCall(
			tool,
			tool === "NotebookEdit"
				? { notebook_path: target, new_source: "" }
				: { file_path: target, content: "x" },
			{ session_id: "mine" },
		),
		{ root: repo },
	);
	return refusalOf(output);
}

describe("a git that cannot answer", () => {
	it("allows the write where git names no tree for the session, recorded (mantahostels#103 §6)", () => {
		const bare = fs.mkdtempSync(path.join(dir, "no-git-"));
		const { output, logs } = runCore(
			"guard-root-scratch",
			{
				session_id: "mine",
				tool_name: "Bash",
				tool_input: { command: "echo x > .i2340.out" },
			},
			{ root: bare },
		);
		expect(output).toBeNull();
		expect(logs.join("\n")).toMatch(
			/git names no top level for .*no-git-.* — allowed unchecked/,
		);
	});
});

describe("a Write, Edit or NotebookEdit into a repo-root dotfile (mantahostels#3380)", () => {
	it("refuses a Write, naming the sanctioned absolute path", () => {
		const refusal = runTool(
			"Write",
			`${repo}/.concision-design-review-3094.md`,
		);
		expect(refusal).toContain("Same write, sanctioned path");
		expect(refusal).toContain(
			`${repo}/.claude/tmp/concision-design-review-3094.md`,
		);
		expect(refusal).not.toContain("… >");
		expect(refusal).toContain("| dd of=.concision-design-review-3094.md");
	});

	it.each(["Edit", "NotebookEdit"] as const)(
		"refuses %s, naming a move rather than a path that does not exist",
		(tool) => {
			const refusal = runTool(tool, `${repo}/.i3380.ipynb`);
			expect(refusal).toContain("mv .i3380.ipynb .claude/tmp/i3380.ipynb");
			expect(refusal).not.toContain("Same write");
		},
	);

	it("refuses a RELATIVE file path, resolved against the working directory, offering the same write at a sanctioned path", () => {
		expect(runTool("Write", ".i3380.md")).toContain("Same write");
	});

	it.each([
		[".codereview-nagged-abc", "a gitignored marker"],
		[".hook-ran-guard-x-mine", "a hook breadcrumb"],
		[".rule-injected-warn.x-mine", "a rule-injection latch"],
		[".mcp.json", "a tracked root dotfile"],
		[".claude/tmp/note.md", "the sanctioned directory"],
		["docs/research/out.md", "a path with a directory"],
		["notes.md", "an undotted root file"],
	])("stays silent on %s — %s", (name) => {
		expect(runTool("Write", `${repo}/${name}`)).toBeNull();
		expect(runTool("Edit", `${repo}/${name}`)).toBeNull();
	});

	it("stays silent on a dotfile outside the repo", () => {
		expect(runTool("Write", path.join(dir, ".i3380.md"))).toBeNull();
	});

	it("allows a Bash payload with an empty command, which the alternation must not misread", () => {
		expect(run("").refusal).toBeNull();
	});

	it("keeps the Bash spelling on a Bash refusal", () => {
		const { refusal } = run("echo x > .i3380.out");
		expect(refusal).toContain("Same command, sanctioned spelling");
		expect(refusal).not.toContain("Same write");
	});
});

describe("a redirect into a repo-root dotfile", () => {
	it.each([
		[
			"gh issue edit 2340 --add-assignee @me > .claim2340.tmp",
			"#2321's most-repeated stray one-liner",
		],
		[
			"for i in 1 2 3 4 5 6; do timeout 300 git commit -qm x > .c2226.out; done",
			"#2321's loop-wrapped redirect",
		],
		["gh issue view 2340 > .i2340.out", "the plain spaced form"],
		["gh issue view 2340 >.i2340.out", "glued to the operator"],
		["node scripts/x.js >> .log2340.out", "an append"],
		["node scripts/x.js 2> .err2340.out", "a leading file descriptor"],
		["node scripts/x.js > '.i2340.out'", "a quoted target"],
		["node scripts/x.js > ./.i2340.out", "spelled through the current dir"],
		["ls && cat f | grep x > .out2340.txt", "at the end of a pipeline"],
		["echo hi > .i2340.out 2>&1", "with a descriptor dup after it"],
		[
			"for c in a b; do node scripts/$c.js > .a2357.$c.json; done",
			"built from a loop variable — #2372 ruled the bet worth taking",
		],
		[`node scripts/x.js > .a2357.${"$"}{c}.json`, "a braced expansion"],
		[
			'node scripts/x.js > ".a$(date +%s).out"',
			"a QUOTED command substitution",
		],
		[
			'node scripts/x.js > ".a`date +%s`.out"',
			"a QUOTED backtick substitution",
		],
		[
			'node scripts/x.js > ".a2357.$c.json"',
			"a double-quoted target whose span the split blanked",
		],
	])("%s — %s", (command) => {
		expect(denies(command)).toBe(true);
	});

	it.each([
		["gh issue view 2340 > .i2340.out", "the plain form"],
		["gh issue view 2340 > ./.i2340.out", "spelled through the current dir"],
	])(
		"names the stray and a sanctioned spelling that resolves — %s",
		(command) => {
			const { refusal } = run(command);
			expect(refusal).toContain(".i2340.out");
			expect(refusal).toContain("\n    .claude/tmp/i2340.out\n");
			expect(refusal).not.toContain("//");
		},
	);

	it("names the stray and a resolving spelling for an ABSOLUTE target", () => {
		const { refusal } = run(`echo x > ${repo}/.i2340.out`);
		expect(refusal).toContain("\n    .claude/tmp/i2340.out\n");
	});

	it("normalises `/./` on the JUDGED path only, never on the original", () => {
		const { refusal } = run(`echo x > "${repo}/.a$(cat /./f).out"`);
		expect(refusal).toContain("\n    .claude/tmp/a$(cat /./f).out\n");
	});

	it("suggests the spelling the session WROTE, not the synthetic name", () => {
		const { refusal } = run(
			"for c in a b; do node scripts/$c.js > .a2357.$c.json; done",
		);
		expect(refusal).toContain("\n    .claude/tmp/a2357.$c.json\n");
		expect(refusal).not.toContain("a2357.X.json");
	});

	it.each([
		["node scripts/x.js > .tmp.$$.out", "the shell's oldest scratch idiom"],
		["node scripts/x.js > .out.$1.log", "a positional parameter"],
		["node scripts/x.js > .rc.$?.txt", "an exit status"],
	])("reads a SPECIAL parameter too — %s", (command) => {
		expect(denies(command)).toBe(true);
	});

	it.each([
		['node scripts/x.js > ".a`date +%s`.out"', 1],
		['node scripts/x.js > ".a``b.out"', 2],
	])(
		"fences a target so the markdown still closes — %s",
		(command, longest: number) => {
			const { refusal } = run(command);
			const target = command.slice(command.indexOf('"') + 1, -1);
			const fence = "`".repeat(longest + 1);
			expect(refusal).toContain(
				longest > 0
					? `${fence} ${target} ${fence}`
					: `${fence}${target}${fence}`,
			);
		},
	);
});

describe("a write by another spelling the shared reader reads (#1827)", () => {
	it.each([
		["gh issue view 1827 | tee .i1827.out", "tee"],
		["gh issue view 1827 | tee -a .i1827.out", "tee appending"],
		["cp /tmp/x .i1827.out", "a cp destination"],
		["mv /tmp/x .i1827.out", "an mv destination"],
		["cp -t . /tmp/.i1827.out", "a cp -t into the root"],
		["cp /tmp/.i1827.out ./", "a cp into ./"],
		["sed -i s/a/b/ .i1827.out", "an in-place sed"],
		["tee .i1827.out <<'EOF'\nbody\nEOF", "tee fed by a heredoc"],
	])("refuses %s — %s", (command) => {
		expect(denies(command)).toBe(true);
	});

	it.each([
		["mv .i1827.out .claude/tmp/i1827.out", "an mv OUT of the root"],
		["cp .i1827.out .claude/tmp/", "a cp from a root file"],
		["rm .i1827.out", "a deletion"],
		["cat .i1827.out | tee .claude/tmp/x", "tee into the sanctioned directory"],
	])("stays silent on %s — %s", (command) => {
		expect(denies(command)).toBe(false);
	});

	it("allows the dd escape its refusal names", () => {
		const { refusal } = run("echo '{}' > .markdownlintrc");
		const recipe = refusal?.match(/^ {4}(printf .*\| dd of=.*)$/m)?.[1];
		expect(recipe).toBeDefined();
		expect(denies(recipe ?? "")).toBe(false);
	});
});

describe("what it stays silent on", () => {
	const mainRepo = defineTemplate((d) => {
		execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: d });
	});

	it.each([
		[
			"node scripts/x.js > .claude/tmp/i2340.out",
			"the sanctioned directory itself",
		],
		["echo done > .codereview-nagged-abc", "a gitignored marker file"],
		["echo 1 > .sweep-autofire", "the sweep counter, also gitignored"],
		["git config -l > .mcp.json", "a tracked root dotfile"],
		["echo x > .gitignore", "the tracked file the ignore limb reads"],
		["node scripts/x.js > docs/research/out.md", "a path with a directory"],
		[
			"node scripts/x.js > .claude/skills/x/SKILL.md",
			"a dot-prefixed DIRECTORY's contents, which is a chosen location",
		],
		["node scripts/x.js > out2340.txt", "an undotted root file"],
		["gh issue view 2340 > /tmp/i2340.out", "outside the repo entirely"],
		["node x.js 2>&1", "a descriptor dup, which writes no file"],
		['[[ "$a" > .i2340.out ]]', "a string comparison inside a conditional"],
		["node scripts/x.js < .i2340.out", "a read, not a write"],
		["gh issue view 2340", "no redirect at all"],
		["node scripts/x.js > .a$(date +%s).out", "a bare command substitution"],
		["node scripts/x.js > .a`date +%s`.out", "a bare backtick substitution"],
	])("%s — %s", (command) => {
		expect(denies(command)).toBe(false);
	});

	it.each([
		['node scripts/x.js > ".envrc.$e"', "a plain variable"],
		[`node scripts/x.js > ".envrc.\${b[\${c}]}"`, "a nested expansion"],
	])(
		"stays silent where a TRACKED file matches the variable-built name — %s",
		(command) => {
			expect(denies(command)).toBe(false);
		},
	);

	it("stays silent on a dotfile at the root of a DIFFERENT repo", () => {
		const other = mainRepo.instantiate(path.join(dir, "other"));
		expect(run("echo x > .i2340.out", other).refusal).toBeNull();
	});

	it.each([
		[
			'gh issue view 2340 > "$CLAUDE_JOB_DIR/tmp/i2340.out"',
			"a variable holding a whole directory, so the name keeps a slash",
		],
		[
			"node scripts/x.js > .roadmap-baseline-$CLAUDE_CODE_SESSION_ID.html",
			"a roadmap-edit baseline, gitignored on a suffix-constrained pattern",
		],
		[
			"node scripts/x.js > .card-close-baseline-$CLAUDE_CODE_SESSION_ID.html",
			"a card-close baseline, same shape",
		],
		[
			"echo base=abc > .concision-pass-$CLAUDE_CODE_SESSION_ID",
			"a concision-pass marker",
		],
		[
			"echo base=abc > .codereview-pass-$CLAUDE_CODE_SESSION_ID",
			"a code-review marker",
		],
	])("%s — %s", (command) => {
		expect(denies(command)).toBe(false);
	});
});

describe("the two legitimate root writes the deny now refuses", () => {
	it("refuses a mutation test's throwaway config file, and names the escape", () => {
		const { refusal } = run("echo '{}' > .markdownlintrc");
		expect(refusal).not.toBeNull();
		expect(refusal).toContain("| dd of=.markdownlintrc");
	});

	it("refuses a tsconfig whose relative paths only resolve at the root, offering the dd escape and the .claude/tmp spelling", () => {
		const { refusal } = run(
			"cat > .tsconfig-checkjs.tmp.json <<'EOF'\n{}\nEOF",
		);
		expect(refusal).not.toBeNull();
		expect(refusal).toContain("| dd of=.tsconfig-checkjs.tmp.json");
		expect(refusal).toContain("\n    .claude/tmp/tsconfig-checkjs.tmp.json\n");
	});
});

describe("the once-a-session bound, deliberately gone", () => {
	const marker = ".rule-injected-warn.root-scratch-main-mine";

	it("refuses a second stray in the same session in full, naming that stray and its sanctioned spelling", () => {
		expect(denies("echo x > .i2401.out")).toBe(true);
		const { refusal } = run("echo x > .claim2401.out");
		expect(refusal).not.toBeNull();
		expect(refusal).toContain(".claim2401.out");
		expect(refusal).toContain("\n    .claude/tmp/claim2401.out\n");
	});

	it("refuses a subagent's stray and the parent's next one alike", () => {
		expect(
			run("echo x > .i2401.out", repo, "mine", "sub").refusal,
		).not.toBeNull();
		expect(denies("echo x > .claim2401.out")).toBe(true);
	});

	it("writes no latch marker at all", () => {
		expect(denies("echo x > .i2401.out")).toBe(true);
		expect(fs.existsSync(path.join(repo, ".claude/tmp/markers", marker))).toBe(
			false,
		);
		expect(
			fs.readdirSync(repo).filter((f) => f.startsWith(".rule-injected")),
		).toEqual([]);
	});
});

describe("the context-budget scan against this core as it stands (mantahostels#2446)", () => {
	it("raises no DEAD-LATCH for it", () => {
		const root = path.resolve(__dirname, "..", "..");
		const r = runInProcess(
			path.join(root, "scripts", "check-context-budget.js"),
			["--json"],
			{ cwd: root },
		);
		const findings = JSON.parse(r.stdout).findings as {
			tag: string;
			surface: string;
		}[];
		expect(
			findings.filter(
				(f) =>
					f.tag === "DEAD-LATCH" &&
					f.surface.includes("scripts/lib/root-scratch.js"),
			),
		).toEqual([]);
	});
});

describe("the cases a mutant must not survive (#2789)", () => {
	it("allows a stray in a sibling directory whose path is as long as the root's", () => {
		const sibling = `${repo.slice(0, -1)}Z`;
		fs.mkdirSync(sibling, { recursive: true });
		expect(runTool("Write", `${sibling}/.stray.md`)).toBeNull();
	});

	it("refuses a root stray spelt through a /./ segment", () => {
		expect(runTool("Write", `${repo}/./.stray.md`)).toContain(".stray.md");
	});

	it("shell-quotes an apostrophe in the name it hands back", () => {
		expect(runTool("Write", `${repo}/.it's.md`)).toContain(
			"dd of='.it'\\''s.md'",
		);
	});

	it("refuses a redirect standing alone, with no command before it", () => {
		expect(denies("> .stray.md")).toBe(true);
	});
});

describe("a stray from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});

	const ignoring = (root: string) =>
		fs.appendFileSync(path.join(root, ".gitignore"), ".i4242.out\n");

	const refused = () =>
		refusalOf(
			runCore(
				"guard-root-scratch",
				toolCall("Write", {
					file_path: path.join(at.worktree, ".i4242.out"),
					content: "x\n",
				}),
				{ root: at.main, worktree: at.worktree },
			).output,
		);

	it("refuses a dotfile at the worktree's root, naming its own .claude/tmp/, though the main checkout ignores it", () => {
		ignoring(at.main);
		expect(refused()).toContain(`${at.worktree}/.claude/tmp/i4242.out`);
	});

	it("allows the dotfile the worktree's .gitignore claims, though the main checkout's does not", () => {
		ignoring(at.worktree);
		expect(refused()).toBeNull();
	});
});
