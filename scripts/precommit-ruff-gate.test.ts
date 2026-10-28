// @vitest-environment node

/*
 * The pre-commit ruff gate (mantahostels#1135), exercised as the shell it is.
 *
 * `.husky/pre-commit` runs only when the commit stages a `.py` file, calls
 * scripts/check-ruff-introduced.js, and fails the commit when a path's staged
 * blob carries a finding its HEAD blob lacks (#122). How the checker judges
 * that is scripts/check-ruff-introduced.test.ts's; this suite owns the shell.
 *
 * ruff itself is stubbed on PATH by lib/ruff-testkit.ts, so every finding is
 * ours to place; one block runs the real ruff where it is installed. The config
 * an adopter's gate reads (#106) and the CI half in `ci.yml` are pinned too.
 *
 * Both halves are hard gates: loosen a case and a Python finding a commit
 * introduces lands unrefused, or the gate refuses findings the commit inherited.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

// Anchored on the checker's name, not on any flag or message: the cutter must
// survive a mutation to anything the cases below assert, or removing one would
// break every case by throwing rather than by failing the single case that
// guards it.
const ANCHOR = "check-ruff-introduced.js";
const gateFragment = () => cutGateFragment(ANCHOR);
const CHECKER = "scripts/check-ruff-introduced.js";
/** Where the gate reads the plugin's ruff config from (#1354). */
const CONFIG_READER = "lib/formatters.js";

/** Where the stub records the argv it was handed, one path per line. */
const ARGS_FILE = "ruff-args.txt";

/**
 * What an isolated fixture's PATH must hold: the commands the cut fragment
 * and the library's arming read shell out to, `node` for the missing-ruff
 * probe, plus `sh` itself —
 * execFileSync resolves the shell against the CHILD's PATH, so omitting it
 * fails the spawn with no output at all rather than failing the gate.
 */
const NEEDED = ["sh", "node", ...LIB_COMMANDS];

/**
 * Populates `bin` with a symlink to each of NEEDED, so a PATH of `bin` alone
 * runs the fragment with NO ruff reachable.
 *
 * Built up rather than subtracted from `process.env.PATH`: ruff lives in
 * ~/miniforge3/bin here, which is also where python3 and git may live, so
 * subtracting every directory holding a `ruff` would decide the absent-binary
 * case on the host's layout rather than on the gate.
 */
function linkNeeded(bin: string): void {
	for (const cmd of NEEDED) {
		const abs = execFileSync("sh", ["-c", `command -v ${cmd}`], {
			encoding: "utf8",
		}).trim();
		fs.symlinkSync(abs, path.join(bin, cmd));
	}
}

/**
 * A git repo with `committed` in its one commit and `staged` written and
 * staged, the scripts the gate calls, a `workflow` as its one CI file where
 * given, and — unless `stub` is false — a stubbed `ruff` on PATH, exiting
 * `ruffExit` or 0.
 *
 * The stub records its argv even when handed none, which is what lets the
 * whole-tree cases below tell "not invoked" from "invoked bare".
 */
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
	// A trailing no-op stands in for the rest of the hook, which really does
	// continue past this gate. Without it the fragment's own exit status is
	// ruff's, and the `|| { … exit 1; }` block could be deleted with every case
	// still green.
	// `exec 2>&1` because every message this gate prints goes to stderr, which
	// execFileSync surfaces only on a non-zero exit — the warn-and-pass case
	// would otherwise assert against an empty string and pass whatever the hook
	// printed.
	const script = `exec 2>&1\n${LIB}\n${gateFragment()}\n:\n`;
	// An isolated fixture withheld the stub, so its bin holds only the NEEDED
	// commands and must stand ALONE as PATH — appending the real one would hand
	// the fragment the machine's own ruff back.
	const search = repo.isolated
		? repo.bin
		: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`;
	try {
		output = execFileSync("sh", ["-c", script], {
			cwd: repo.root,
			encoding: "utf8",
			// Pinned, never inherited: a WFC_PLUGIN_ROOT leaking in from the
			// session would hand every case the adopter branch (#106), a
			// CLAUDE_PROJECT_DIR would read this repo's config rather than the
			// fixture's, and a WFC_RUFF would bypass the stub.
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

/** ci.yml, read once — two describes below assert against it. */
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
			// Red, so a gate that fired anyway would fail the case rather than
			// passing by luck.
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
		// Every tracked .py sits under scripts/ today, so a gate anchored on
		// `^scripts/.*\.py$` would pass every case here while silently never
		// firing on the first Python file added anywhere else.
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

	it("passes a one-line addition to a file whose findings predate the commit", () => {
		// The added line sits ABOVE the finding, so a line-keyed comparison
		// would read the moved finding as new.
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
		// This is the only case pinning scoped-not-whole-tree. Every other
		// fixture's only tracked .py IS its staged one, so judging every tracked
		// path leaves them all green — and a whole-tree run in the shared tree
		// fails this commit on a parallel session's half-written script
		// (mantahostels#1135).
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
		// A commit staging only a deletion never opens the gate at all, so that
		// case would pass with no --diff-filter on the path list. Forcing the
		// gate open with a live file is what makes the filter load-bearing:
		// without it ruff is handed a path with no file behind it.
		const gone = "scripts/gone.py";
		const repo = fixture({ staged: {}, ruffExit: 0 });
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		// Deliberately unlike BODY. Two identical short files read to git as one
		// RENAME rather than a delete plus an add, and a rename stages no
		// deletion at all — so the case would pass with the filter gone.
		fs.writeFileSync(
			path.join(repo.root, gone),
			`# gone\n${"# distinct\n".repeat(12)}print(1)\n`,
		);
		repo.git("add", "--", gone);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--", gone);

		// `git rm` took the now-empty scripts/ with it.
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(repo.root, PY), BODY);
		repo.git("add", "--", PY);

		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(args).not.toContain(gone);
		expect(code).toBe(0);
	});

	// The checker lints the staged blob, so a path gone from the worktree is
	// still in the commit and still judged (#1504's review).
	it("lints a staged .py the worktree no longer holds", () => {
		const repo = fixture({ staged: { [PY]: BODY }, ruffExit: 0 });
		fs.rmSync(path.join(repo.root, PY));
		const { code, args } = runGate(repo);
		expect(args).toContain(PY);
		expect(code).toBe(0);
	});

	it("drops a path the commit UNTRACKS but leaves on disk", () => {
		// armed_live's A/M match on the path list, and the only case that can
		// see it: `git rm --cached` stages a deletion while the file stays in the
		// worktree, which ruff's `--index` read would keep. Without the
		// filter ruff is handed a script this commit is REMOVING from the repo,
		// and a finding in it blocks the removal.
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
		expect(code).toBe(1);
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
		expect(code).toBe(1);
		expect(output).toMatch(
			/the ruff probe failed, so the ruff gate refused this commit/,
		);
	});

	it("says nothing about a missing binary on a commit staging no Python", () => {
		// `stub: false` is what makes this a test. With the stub present the
		// SKIPPED branch is unreachable whatever the gate does, so the case would
		// stay green with the whole file-set condition deleted.
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n" },
			stub: false,
		});
		expect(runGate(repo).output).not.toMatch(/SKIPPED/);
	});

	it("hands ruff no rule selection, matching check:py", () => {
		// ruff.toml holds the rule set, so neither half carries a --select; a
		// rule flag on one side without the other is exactly the divergence this
		// pins.
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
		// The plugin's --config and nothing else between the checker and the
		// `|| { … }` failure block.
		const invocation =
			/node "\$\{WFC_PLUGIN_ROOT:-\.\}"\/scripts\/check-ruff-introduced\.js ([^|]*)\|\| \{/.exec(
				gateFragment(),
			);
		expect(
			invocation,
			"the gate no longer invokes the checker on a `||` line",
		).not.toBeNull();
		expect((invocation as RegExpExecArray)[1].trim()).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
			'${ruff_cfg:+--config "$ruff_cfg"}',
		);
	});

	it("supplies its fixture exactly the scripts the gate invokes", () => {
		expectFixtureSupplies(ANCHOR, [CHECKER, `scripts/${CONFIG_READER}`]);
	});
});

describe("the ruff config an adopter's gate reads (#106)", () => {
	/** A plugin root holding a ruff.toml and the gate's scripts, as a release tree does. */
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
	/** A fixture whose PATH reaches the machine's ruff, not the stub. */
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
	// Bounded by the step's own trailing blank line, not by the next `- name:`:
	// the comment block introducing the step AFTER this one sits between the two,
	// and swallowing it would let this step's assertions read a neighbour's prose.
	const step = (): string => {
		const m = /- name: Ruff\n((?:.*\n)*?)\n/.exec(CI);
		expect(m, "the Ruff step no longer parses out of ci.yml").not.toBeNull();
		return (m as RegExpExecArray)[1];
	};

	it("runs the same npm script the local by-hand route does", () => {
		// The pre-commit gate reads only the paths a commit names, so this step is
		// the only thing that ever re-checks a file a neighbouring commit changed
		// under it.
		expect(step()).toContain("npm run check:py");
	});

	it("hard-fails, carrying no continue-on-error and no absent-binary escape", () => {
		// Deliberately unlike the pre-commit half, which warns and passes: a
		// runner that has run the pip install has ruff, so a missing binary there
		// is a broken install, not a fresh machine (mantahostels#1135).
		expect(step()).not.toContain("continue-on-error");
		expect(step()).not.toMatch(/command -v ruff/);
	});

	it("sits in the python job, which already paid for the pip install", () => {
		// A Ruff job of its own would repeat the checkout and pip install for a
		// 0.05 s check; it needs no install step only because it is downstream
		// of that job's `Install dependencies` (mantahostels#1135).
		const python = CI.slice(CI.indexOf("\n  python:"));
		expect(python).toContain("- name: Ruff");
		expect(python).toMatch(/pip install .*-r requirements-dev\.txt/);
		// Ahead of Pytest is not required, but AFTER `Install dependencies` is:
		// ruff is pinned in requirements-dev.txt like everything else here.
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
		// scripts/test_requirements_pinned.py fails when a pin and the installed
		// version disagree, and the supply-chain auditor credits a version only
		// from an `==` in the requirements-dev.txt compiled from this file
		// (mantahostels#930). A range here would silently drop ruff out of both.
		expect(requirements).toMatch(/^ruff==\d+\.\d+\.\d+$/m);
	});

	it("configures ruff in ruff.toml, the one place the rule set lives", () => {
		const cfg = fs.readFileSync(path.join(ROOT, "ruff.toml"), "utf8");
		// Parsed loosely rather than with a TOML reader: the assertion is that the
		// select is stated HERE, so neither gate needs a --select of its own.
		const select = /select\s*=\s*\[([^\]]*)\]/.exec(cfg);
		expect(select, "ruff.toml no longer states a lint select").not.toBeNull();
		const codes = (select as RegExpExecArray)[1]
			.split(",")
			.map((c) => c.trim().replace(/"/g, ""))
			.filter(Boolean);
		// F is the whole reason ruff is here: it is what found the 20 undefined
		// names in measure-context-buckets/extract.py that pytest never could.
		expect(codes).toContain("F");
	});

	it("gates `ruff format` beside the lint, in the hook and in CI (#1332)", () => {
		// The formatter mantahostels#1135 declined and #1315 Q3 adopted. The hook
		// reaches it through check-format-staged.js, whose own suite owns how;
		// CI's Ruff step runs check:py, so the format check rides that one script.
		const hook = fs.readFileSync(
			path.join(ROOT, ".husky", "pre-commit"),
			"utf8",
		);
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		expect(hook).toMatch(
			/^\s*node "\$\{WFC_PLUGIN_ROOT:-\.\}"\/scripts\/check-format-staged\.js/m,
		);
		expect(pkg.scripts["check:py"]).toMatch(/\bruff format --check \./);
		expect(CI).toMatch(/run: npm run check:py/);
	});
});
