// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandPath } from "./lib/command-path-testkit";
import { RUFF_INSTALL } from "./lib/formatters.js";
import {
	cutGateFragment,
	expectFixtureSupplies,
	newRepo,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	LIB,
	LIB_COMMANDS,
	ROOT,
	writeCheckerDelegates,
} from "./lib/precommit-gate-testkit";
import {
	PLUGIN_SELECT,
	REAL_RUFF,
	readStubCalls,
	writeRuffStub,
} from "./lib/ruff-testkit";

const temps = registerTempCleanup();

const ANCHOR = "check-ruff-introduced.js";
const gateFragment = () => cutGateFragment(ANCHOR);
const CHECKER = "scripts/check-ruff-introduced.js";
const CONFIG_READER = "lib/formatters.js";

const ARGS_FILE = "ruff-args.txt";

const NEEDED = ["sh", "node", ...LIB_COMMANDS];

function linkNeeded(bin: string): void {
	for (const cmd of NEEDED) {
		const abs = commandPath(cmd);
		fs.symlinkSync(abs, path.join(bin, cmd));
	}
}

function fixture(opts: {
	staged: Record<string, string>;
	committed?: Record<string, string>;
	ruffExit?: number;
	stub?: boolean;
	workflow?: string;
}): TempRepo & { bin: string; isolated: boolean } {
	const repo = stagedRepo(
		"ruff-gate-",
		temps,
		opts.committed ?? {},
		opts.staged,
	);
	const { root } = repo;

	const bin = path.join(root, "stub-bin");
	fs.mkdirSync(bin, { recursive: true });
	if (opts.stub === false) {
		linkNeeded(bin);
	} else {
		writeRuffStub(
			path.join(bin, "ruff"),
			path.join(root, ARGS_FILE),
			opts.ruffExit,
		);
	}
	writeCheckerDelegates(root, [path.basename(CHECKER), CONFIG_READER]);
	if (opts.workflow !== undefined) {
		const workflows = path.join(root, ".github", "workflows");
		fs.mkdirSync(workflows, { recursive: true });
		fs.writeFileSync(path.join(workflows, "lint.yml"), opts.workflow);
	}

	return { ...repo, bin, isolated: opts.stub === false };
}

function runGate(
	repo: { root: string; bin: string; isolated?: boolean },
	pluginRoot = "",
): {
	code: number;
	output: string;
	args: string[];
	invoked: boolean;
} {
	let code = 0;
	let output = "";
	const script = `exec 2>&1\n${LIB}\n${gateFragment()}\n:\n`;
	const search = repo.isolated
		? repo.bin
		: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`;
	try {
		output = execFileSync("sh", ["-c", script], {
			cwd: repo.root,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: search,
				WFC_PLUGIN_ROOT: pluginRoot,
				CLAUDE_PROJECT_DIR: repo.root,
				WFC_RUFF: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		code = err.status ?? 1;
		output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	const calls = readStubCalls(path.join(repo.root, ARGS_FILE));
	return { code, output, args: calls.flat(), invoked: calls.length > 0 };
}

const CI = fs.readFileSync(
	path.join(ROOT, ".github", "workflows", "ci.yml"),
	"utf8",
);

const PY = "scripts/thing.py";
const OUTSIDE = "scripts/thing.js";
const BODY = "import os\n\nprint(os.getcwd())\n";
const OLD = "# FINDING F401 `os` imported but unused\n";
const NEW = "# FINDING F821 Undefined name `x`\n";

describe("the pre-commit ruff gate", () => {
	it("does not run ruff when the commit stages no Python file", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n", "docs/x.md": "# x\n" },
			ruffExit: 1,
		});
		const { code, invoked } = runGate(repo);
		expect(invoked).toBe(false);
		expect(code).toBe(0);
	});

	it("runs ruff on a staged .py and passes when it is green", () => {
		const repo = fixture({ staged: { [PY]: BODY }, ruffExit: 0 });
		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(code).toBe(0);
	});

	it("fires on a .py ANYWHERE, not only under scripts/", () => {
		const elsewhere = "tools/one_off.py";
		const repo = fixture({ staged: { [elsewhere]: BODY }, ruffExit: 0 });
		expect(runGate(repo).args).toContain(elsewhere);
	});

	it("refuses a finding the commit introduces, naming it and offering ruff check --fix as the way out", () => {
		const repo = fixture({
			committed: { [PY]: `${OLD}${BODY}` },
			staged: { [PY]: `${OLD}${NEW}${BODY}` },
		});
		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		expect(output).toMatch(/F821 Undefined name `x`/);
		expect(output).toMatch(/the ruff gate refused this commit's own/);
		expect(output).toMatch(/ruff check --fix <path>/);
		expect(output).toMatch(/never delete the code to pass/);
		expect(output).toMatch(
			/Vendored or third-party code alone goes in `ruffExclude` in \.claude\/workflow-core\.json: it is not this repo's code to fix/,
		);
		expect(output).not.toMatch(/research instrument/);
		expect(output).not.toMatch(/F401/);
	});

	it("prints no fix-the-findings remedy when its checker exits 2 on a ruff that cannot lint (#3812)", () => {
		const repo = fixture({ staged: { [PY]: BODY }, ruffExit: 3 });
		const { code, output } = runGate(repo);
		expect(code).toBe(2);
		expect(output).toMatch(/BROKEN: ruff exited 3/);
		expect(output).toMatch(
			/the ruff gate refused this commit, its checker unable to run/,
		);
		expect(output).toMatch(
			/This is the tool, not your change: repair what the line above names/,
		);
		expect(output).not.toMatch(/own Python paths/);
		expect(output).not.toMatch(/ruff check --fix/);
		expect(output).not.toMatch(/Fix the findings/);
		expect(output).not.toMatch(/ruffExclude/);
	});

	it("passes a one-line addition to a file whose findings predate the commit", () => {
		const repo = fixture({
			committed: { [PY]: `${OLD}${BODY}` },
			staged: { [PY]: `# one more line\n${OLD}${BODY}` },
		});
		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(code).toBe(0);
	});

	it("hands ruff only the commit's own Python paths", () => {
		const repo = fixture({
			staged: { [PY]: BODY, [OUTSIDE]: "const a = 1;\n" },
			ruffExit: 0,
		});
		const { args } = runGate(repo);
		expect(args).toContain(PY);
		expect(args).not.toContain(OUTSIDE);
	});

	it("reads the commit's staged paths, NOT the whole tree", () => {
		const tracked = "scripts/untouched.py";
		const repo = fixture({ staged: {}, ruffExit: 0 });
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(repo.root, tracked), BODY);
		repo.git("add", "--", tracked);
		repo.git("commit", "-qm", "tracked");

		fs.writeFileSync(path.join(repo.root, PY), BODY);
		repo.git("add", "--", PY);

		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(args).not.toContain(tracked);
		expect(code).toBe(0);
	});

	it("drops a deletion from a commit that ALSO stages a live .py", () => {
		const gone = "scripts/gone.py";
		const repo = fixture({ staged: {}, ruffExit: 0 });
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.root, gone),
			`# gone\n${"# distinct\n".repeat(12)}print(1)\n`,
		);
		repo.git("add", "--", gone);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--", gone);

		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(repo.root, PY), BODY);
		repo.git("add", "--", PY);

		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(args).not.toContain(gone);
		expect(code).toBe(0);
	});

	it("lints a staged .py the worktree no longer holds", () => {
		const repo = fixture({ staged: { [PY]: BODY }, ruffExit: 0 });
		fs.rmSync(path.join(repo.root, PY));
		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(code).toBe(0);
	});

	it("drops a path the commit UNTRACKS but leaves on disk", () => {
		const untracked = "scripts/retired.py";
		const repo = fixture({ staged: {}, ruffExit: 0 });
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.root, untracked),
			`# retired\n${"# distinct\n".repeat(12)}print(1)\n`,
		);
		repo.git("add", "--", untracked);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--cached", "--", untracked);

		fs.writeFileSync(path.join(repo.root, PY), BODY);
		repo.git("add", "--", PY);

		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(args).not.toContain(untracked);
		expect(code).toBe(0);
	});

	it("refuses a .py commit when ruff is not on PATH and no workflow runs ruff check, naming the install line (#1563)", () => {
		const repo = fixture({
			staged: { [PY]: BODY },
			stub: false,
			workflow: "      - run: ruff format --check .\n",
		});
		const { code, output } = runGate(repo);
		expect(code).toBe(2);
		expect(output).toMatch(
			/no workflow under \.github\/workflows\/ runs ruff check, so the ruff gate refused this commit/,
		);
		expect(output).toContain(`Install it: ${RUFF_INSTALL}`);
		expect(output).not.toMatch(/SKIPPED/);
	});

	it("warns and PASSES when ruff is not on PATH and a workflow runs ruff check, naming that workflow (#1563)", () => {
		const repo = fixture({
			staged: { [PY]: BODY },
			stub: false,
			workflow: "      - run: ruff check .\n",
		});
		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toMatch(/ruff is not on PATH — the ruff gate is SKIPPED/);
		expect(output).toMatch(/NOT blocked/);
		expect(output).toContain(
			`ruff check runs in .github/workflows/lint.yml, which can catch what this lets through when it next runs. Install it: ${RUFF_INSTALL}`,
		);
		expect(output).not.toMatch(/ci\.yml/);
	});

	it("refuses rather than skips when the missing-ruff probe crashes", () => {
		const repo = fixture({
			staged: { [PY]: BODY },
			stub: false,
			workflow: "      - run: ruff check .\n",
		});
		fs.writeFileSync(
			path.join(repo.root, "scripts", CONFIG_READER),
			"process.exit(3);\n",
		);
		const { code, output } = runGate(repo);
		expect(code).toBe(2);
		expect(output).toMatch(
			/the ruff probe failed, so the ruff gate refused this commit/,
		);
	});

	it("says nothing about a missing binary on a commit staging no Python", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n" },
			stub: false,
		});
		expect(runGate(repo).output).not.toMatch(/SKIPPED/);
	});

	it("hands ruff no rule selection, matching check:py", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		expect(pkg.scripts["check:py"]).toBe(
			"ruff check . && ruff format --check .",
		);
		const repo = fixture({
			committed: { [PY]: `${OLD}${BODY}` },
			staged: { [PY]: `${OLD}${BODY}\n` },
		});
		for (const a of runGate(repo).args)
			expect(a).not.toMatch(/^--(extend-)?(select|ignore|fixable)\b/);
		const invocation =
			/node "\$\{WFC_PLUGIN_ROOT:-\.\}"\/scripts\/check-ruff-introduced\.js ([^|]*)\|\| \{/.exec(
				gateFragment(),
			);
		expect(
			invocation,
			"the gate no longer invokes the checker on a `||` line",
		).not.toBeNull();
		expect((invocation as RegExpExecArray)[1].trim()).toBe(
			`\${ruff_cfg:+--config "$ruff_cfg"}`,
		);
	});

	it("supplies its fixture exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(ANCHOR, [CHECKER, `scripts/${CONFIG_READER}`]);
	});
});

describe("the ruff config an adopter's gate reads (#106)", () => {
	function plugin(): string {
		const { root } = newRepo("ruff-plugin-", temps);
		fs.writeFileSync(path.join(root, "ruff.toml"), '[lint]\nselect = ["F"]\n');
		writeCheckerDelegates(root, [path.basename(CHECKER), CONFIG_READER]);
		return root;
	}

	it("passes the plugin's ruff.toml where the host has no ruff config", () => {
		const repo = fixture({ staged: { [PY]: BODY } });
		const at = plugin();
		const { args } = runGate(repo, at);
		expect(args[args.indexOf("--config") + 1]).toBe(path.join(at, "ruff.toml"));
		expect(args).toContain(PY);
	});

	it("keeps the path whole when the plugin root holds a space", () => {
		const repo = fixture({ staged: { [PY]: BODY } });
		const at = path.join(plugin(), "with space");
		fs.mkdirSync(at);
		fs.writeFileSync(path.join(at, "ruff.toml"), "[lint]\n");
		writeCheckerDelegates(at, [path.basename(CHECKER), CONFIG_READER]);
		const { args } = runGate(repo, at);
		expect(args[args.indexOf("--config") + 1]).toBe(path.join(at, "ruff.toml"));
	});

	for (const [name, file, body] of [
		["ruff.toml", "ruff.toml", "[lint]\n"],
		[".ruff.toml", ".ruff.toml", "[lint]\n"],
		[
			"a [tool.ruff] table in pyproject.toml",
			"pyproject.toml",
			"[tool.ruff]\n",
		],
	]) {
		it(`defers to the host's own ${name}`, () => {
			const repo = fixture({ staged: { [PY]: BODY } });
			fs.writeFileSync(path.join(repo.root, file), body);
			expect(runGate(repo, plugin()).args).not.toContain("--config");
		});
	}

	it("passes no --config when the plugin root carries no ruff.toml", () => {
		const repo = fixture({ staged: { [PY]: BODY } });
		const { root: bare } = newRepo("ruff-bare-plugin-", temps);
		expect(runGate(repo, bare).args).not.toContain("--config");
	});
});

describe.skipIf(!REAL_RUFF)("with the real ruff", () => {
	function real(opts: {
		committed?: Record<string, string>;
		staged: Record<string, string>;
	}) {
		const repo = fixture(opts);
		fs.rmSync(path.join(repo.bin, "ruff"));
		fs.writeFileSync(path.join(repo.root, "ruff.toml"), PLUGIN_SELECT);
		return repo;
	}
	const inherited = "import os\n\nprint(1)\n";

	it("passes a one-line addition to a file with a pre-existing F401", () => {
		const repo = real({
			committed: { [PY]: inherited },
			staged: { [PY]: `# added\n${inherited}` },
		});
		const { code, output } = runGate(repo);
		expect(output).toMatch(/no ruff finding introduced/);
		expect(code).toBe(0);
	});

	it("refuses a new F821, naming the undefined name", () => {
		const repo = real({
			committed: { [PY]: inherited },
			staged: { [PY]: `${inherited}print(undefined_name)\n` },
		});
		const { code, output } = runGate(repo);
		expect(output).toMatch(/F821 Undefined name `undefined_name`/);
		expect(code).toBe(1);
	});
});

describe("the CI half of the same gate", () => {
	const step = (): string => {
		const m = /- name: Ruff\n((?:.*\n)*?)\n/.exec(CI);
		expect(m, "the Ruff step no longer parses out of ci.yml").not.toBeNull();
		return (m as RegExpExecArray)[1];
	};

	it("runs the same npm script the local by-hand route does", () => {
		expect(step()).toContain("npm run check:py");
	});

	it("hard-fails, carrying no continue-on-error and no absent-binary escape", () => {
		expect(step()).not.toContain("continue-on-error");
		expect(step()).not.toMatch(/command -v ruff/);
	});

	it("sits in the python job, which already paid for the pip install", () => {
		const python = CI.slice(CI.indexOf("\n  python:"));
		expect(python).toContain("- name: Ruff");
		expect(python).toContain(
			'python3 -m pip install --require-hashes --only-binary ":all:" -r requirements-dev.txt',
		);
		expect(python.indexOf("Install dependencies")).toBeLessThan(
			python.indexOf("- name: Ruff"),
		);
	});
});

describe("the ruff adoption's own invariants", () => {
	const requirements = fs.readFileSync(
		path.join(ROOT, "requirements-dev.in"),
		"utf8",
	);

	it("pins ruff exactly, as every other Python dependency here is pinned", () => {
		expect(requirements).toMatch(/^ruff==\d+\.\d+\.\d+$/m);
	});

	it("configures ruff in ruff.toml, the one place the rule set lives", () => {
		const cfg = fs.readFileSync(path.join(ROOT, "ruff.toml"), "utf8");
		const select = /select\s*=\s*\[([^\]]*)\]/.exec(cfg);
		expect(select, "ruff.toml no longer states a lint select").not.toBeNull();
		const codes = (select as RegExpExecArray)[1]
			.split(",")
			.map((c) => c.trim().replace(/"/g, ""))
			.filter(Boolean);
		expect(codes).toContain("F");
	});

	it("gates `ruff format` beside the lint, in the hook and in CI (#1332)", () => {
		const hook = fs.readFileSync(
			path.join(ROOT, ".husky", "pre-commit"),
			"utf8",
		);
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		expect(hook).toMatch(
			/^\s*with_lines "\$fmt_skip" node "\$\{WFC_PLUGIN_ROOT:-\.\}"\/scripts\/check-format-staged\.js/m,
		);
		expect(pkg.scripts["check:py"]).toMatch(/\bruff format --check \./);
		expect(CI).toMatch(/run: npm run check:py/);
	});
});
