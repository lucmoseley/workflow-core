// @vitest-environment node

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandPath } from "./lib/command-path-testkit";
import {
	cutGateFragment,
	gateTmpdir,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	HOOK_BOUND_LIB,
	holdLock,
	LIB,
	LIB_COMMANDS,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { shellQuote } from "./lib/sh-quote.js";

const temps = registerTempCleanup();

const gateFragment = () => cutGateFragment("shellcheck -x");

const ARGS_FILE = "shellcheck-args.txt";

const NEEDED = ["sh", "node", ...LIB_COMMANDS];

function linkNeeded(bin: string): void {
	for (const cmd of NEEDED) {
		const abs = commandPath(cmd);
		fs.symlinkSync(abs, path.join(bin, cmd));
	}
}

type GateRepo = TempRepo & { bin: string; isolated: boolean };

function fixture(opts: {
	staged: Record<string, string>;
	shellcheckExit?: number;
	stub?: boolean;
	noFlock?: boolean;
	flockExit?: number;
}): GateRepo {
	const repo = stagedRepo("shellcheck-gate-", temps, {}, opts.staged);
	const { root } = repo;

	const bin = path.join(root, "stub-bin");
	fs.mkdirSync(bin, { recursive: true });
	const isolated = opts.stub === false || opts.noFlock === true;
	if (isolated) linkNeeded(bin);
	if (opts.stub !== false) {
		const stub = path.join(bin, "shellcheck");
		fs.writeFileSync(
			stub,
			`#!/bin/sh\nprintf '%s\\n' "$@" >>${shellQuote(path.join(root, ARGS_FILE))}\nexit ${opts.shellcheckExit ?? 0}\n`,
		);
		fs.chmodSync(stub, 0o755);
	}
	if (opts.flockExit !== undefined) {
		const stub = path.join(bin, "flock");
		fs.writeFileSync(stub, `#!/bin/sh\nexit ${opts.flockExit}\n`);
		fs.chmodSync(stub, 0o755);
	}
	return { ...repo, bin, isolated };
}

function gateLaunch(repo: GateRepo): {
	script: string;
	env: NodeJS.ProcessEnv;
} {
	const script = `exec 2>&1\n${HOOK_BOUND_LIB}\n${LIB}\n${gateFragment()}\n:\n`;
	const search = repo.isolated
		? repo.bin
		: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`;
	return {
		script,
		env: {
			...process.env,
			PATH: search,
			TMPDIR: gateTmpdir(repo.root),
			WFC_PLUGIN_ROOT: ROOT,
		},
	};
}

function readStubArgs(repo: GateRepo): string[] {
	const argsPath = path.join(repo.root, ARGS_FILE);
	return fs.existsSync(argsPath)
		? fs.readFileSync(argsPath, "utf8").split("\n").filter(Boolean)
		: [];
}

function runGate(repo: GateRepo): {
	code: number;
	output: string;
	args: string[];
} {
	let code = 0;
	let output = "";
	const { script, env } = gateLaunch(repo);
	try {
		output = execFileSync("sh", ["-c", script], {
			cwd: repo.root,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		code = err.status ?? 1;
		output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	return { code, output, args: readStubArgs(repo) };
}

function runGateAsync(
	repo: GateRepo,
	cue: RegExp,
	whenSaid: () => void,
): Promise<{ code: number; output: string; args: string[] }> {
	const { script, env } = gateLaunch(repo);
	const child = spawn("sh", ["-c", script], { cwd: repo.root, env });
	let output = "";
	let said = false;
	return new Promise((resolve) => {
		child.stdout.on("data", (d) => {
			output += d;
			if (!said && cue.test(output)) {
				said = true;
				whenSaid();
			}
		});
		child.on("close", (code) =>
			resolve({ code: code ?? 1, output, args: readStubArgs(repo) }),
		);
	});
}

const GUARD = "scripts/guard-thing.sh";
const OUTSIDE = "scripts/thing.js";
const BODY = "#!/bin/sh\ntrue\n";

describe("the pre-commit shellcheck gate", () => {
	it("does not run shellcheck when the commit stages no shell file", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n", "docs/x.md": "# x\n" },
			shellcheckExit: 1,
		});
		const { code, args } = runGate(repo);
		expect(args).toEqual([]);
		expect(code).toBe(0);
	});

	it("runs shellcheck on a staged scripts/*.sh and passes when it is green", () => {
		const repo = fixture({ staged: { [GUARD]: BODY }, shellcheckExit: 0 });
		const { code, args } = runGate(repo);
		expect(args).toContain(GUARD);
		expect(code).toBe(0);
	});

	it("runs on a staged husky hook, which lives outside scripts/", () => {
		const repo = fixture({
			staged: { ".husky/pre-push": BODY },
			shellcheckExit: 0,
		});
		expect(runGate(repo).args).toContain(".husky/pre-push");
	});

	it("runs on scripts/lib/*.sh, matching check:sh's own subdirectory reach", () => {
		const repo = fixture({
			staged: { "scripts/lib/guard-thing.sh": BODY },
			shellcheckExit: 0,
		});
		expect(runGate(repo).args).toContain("scripts/lib/guard-thing.sh");
	});

	it("hands shellcheck a staged path holding a space as one argument (#5542)", () => {
		const spaced = "scripts/two words.sh";
		const repo = fixture({ staged: { [spaced]: BODY }, shellcheckExit: 0 });
		expect(runGate(repo).args).toContain(spaced);
	});

	it("fails the commit when shellcheck exits non-zero", () => {
		const repo = fixture({ staged: { [GUARD]: BODY }, shellcheckExit: 1 });
		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		expect(output).toMatch(/shellcheck failed on this commit's own/);
	});

	it("hands shellcheck only the commit's own shell paths", () => {
		const repo = fixture({
			staged: { [GUARD]: BODY, [OUTSIDE]: "const a = 1;\n" },
			shellcheckExit: 0,
		});
		const { args } = runGate(repo);
		expect(args).toContain(GUARD);
		expect(args).not.toContain(OUTSIDE);
	});

	it("drops a deletion from a commit that ALSO stages a live shell file", () => {
		const gone = "scripts/guard-gone.sh";
		const repo = fixture({ staged: {}, shellcheckExit: 0 });
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.root, gone),
			`#!/bin/sh\n${"echo distinct\n".repeat(12)}`,
		);
		repo.git("add", "--", gone);
		repo.git("commit", "-qm", "add");
		repo.git("rm", "-q", "--", gone);

		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(repo.root, GUARD), BODY);
		repo.git("add", "--", GUARD);

		const { code, args } = runGate(repo);
		expect(args).toContain(GUARD);
		expect(args).not.toContain(gone);
		expect(code).toBe(0);
	});

	it("warns and PASSES when shellcheck is not on PATH", () => {
		const repo = fixture({ staged: { [GUARD]: BODY }, stub: false });
		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).toMatch(/shellcheck is not on PATH — its gate is SKIPPED/);
		expect(output).toMatch(/NOT blocked/);
	});

	it("says nothing about a missing binary on a commit staging no shell file", () => {
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n" },
			stub: false,
		});
		expect(runGate(repo).output).not.toMatch(/SKIPPED/);
	});

	it("reads the commit's staged paths, NOT every tracked shell file", () => {
		const tracked = "scripts/guard-untouched.sh";
		const repo = fixture({ staged: {}, shellcheckExit: 0 });
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(repo.root, tracked), BODY);
		repo.git("add", "--", tracked);
		repo.git("commit", "-qm", "tracked");

		fs.writeFileSync(path.join(repo.root, GUARD), BODY);
		repo.git("add", "--", GUARD);

		const { code, args } = runGate(repo);
		expect(args).toContain(GUARD);
		expect(args).not.toContain(tracked);
		expect(code).toBe(0);
	});

	it("skips a path staged and then deleted from the worktree", () => {
		const repo = fixture({ staged: { [GUARD]: BODY }, shellcheckExit: 0 });
		fs.rmSync(path.join(repo.root, GUARD));
		const { code, args } = runGate(repo);
		expect(args).not.toContain(GUARD);
		expect(code).toBe(0);
	});

	it("carries check:sh's flags and excludes only SC2016 on either side", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		const script: string = pkg.scripts["check:sh"];
		const fragment = gateFragment();
		const exclude = "--exclude=SC2016";
		for (const flag of ["-x", "--severity=style", exclude]) {
			expect(script, `check:sh lost ${flag}`).toContain(flag);
			expect(fragment, `the gate lost ${flag}`).toContain(flag);
		}
		const exclusions = (s: string) =>
			[...s.matchAll(/\s(-e\s+\S+|--exclude[=\s]\S+)/g)].map((m) => m[1]);
		expect(exclusions(script), "check:sh excludes another code").toEqual([
			exclude,
		]);
		expect(exclusions(fragment), "the gate excludes another code").toEqual([
			exclude,
		]);
	});

	it("runs on shell outside scripts/, by extension or shebang, and on no vendored file (#1828)", () => {
		const repo = fixture({
			staged: {
				"tools/a.sh": BODY,
				"bin/run": "#!/usr/bin/env bash\ntrue\n",
				"bin/tool": "#!/usr/bin/env node\n",
				".gitattributes": "vendor/** linguist-vendored\n",
				"vendor/v.sh": BODY,
			},
			shellcheckExit: 0,
		});
		const { code, args } = runGate(repo);
		expect(args.filter((a) => !a.startsWith("-"))).toEqual([
			"bin/run",
			"tools/a.sh",
		]);
		expect(code).toBe(0);
	});

	it("refuses the commit where the lister cannot run", () => {
		const repo = fixture({ staged: { [GUARD]: BODY }, shellcheckExit: 0 });
		let code = 0;
		let output = "";
		try {
			execFileSync(
				"sh",
				["-c", `exec 2>&1\n${HOOK_BOUND_LIB}\n${LIB}\n${gateFragment()}\n:\n`],
				{
					cwd: repo.root,
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`,
						WFC_PLUGIN_ROOT: "/nonexistent",
					},
				},
			);
		} catch (e) {
			const err = e as { status?: number; stdout?: string };
			code = err.status ?? 1;
			output = err.stdout ?? "";
		}
		expect(code).toBe(1);
		expect(output).toMatch(/could not list this commit's shell files/);
	});
});

describe("the gate's serialisation across commits (#2579)", () => {
	it("waits for a neighbour holding the lock, then runs shellcheck", async () => {
		const repo = fixture({ staged: { [GUARD]: BODY }, shellcheckExit: 0 });
		const lock = path.join(gateTmpdir(repo.root), "wfc-shellcheck.lock");
		const held = holdLock(lock);
		try {
			const { code, output, args } = await runGateAsync(
				repo,
				/another run holds .*wfc-shellcheck\.lock/,
				held.release,
			);
			expect(output).toMatch(/another run holds .*wfc-shellcheck\.lock/);
			expect(output).not.toMatch(/unserialised/);
			expect(args).toContain(GUARD);
			expect(code).toBe(0);
		} finally {
			held.release();
		}
	});

	it("runs shellcheck unserialised once the wait times out, still failing on a finding", () => {
		const repo = fixture({
			staged: { [GUARD]: BODY },
			shellcheckExit: 1,
			flockExit: 1,
		});
		const { code, output, args } = runGate(repo);
		expect(output).toMatch(/running shellcheck unserialised/);
		expect(args).toContain(GUARD);
		expect(code).toBe(1);
	});

	it("runs shellcheck unserialised where the lock file will not open", () => {
		const repo = fixture({ staged: { [GUARD]: BODY }, shellcheckExit: 0 });
		fs.mkdirSync(path.join(gateTmpdir(repo.root), "wfc-shellcheck.lock"));
		const { code, output, args } = runGate(repo);
		expect(output).toMatch(/cannot open .*wfc-shellcheck\.lock/);
		expect(output).not.toMatch(/shellcheck failed/);
		expect(args).toContain(GUARD);
		expect(code).toBe(0);
	});

	it("still fails the commit on a finding when flock is missing", () => {
		const repo = fixture({
			staged: { [GUARD]: BODY },
			shellcheckExit: 1,
			noFlock: true,
		});
		expect(fs.existsSync(path.join(repo.bin, "flock"))).toBe(false);
		const { code, args } = runGate(repo);
		expect(args).toContain(GUARD);
		expect(code).toBe(1);
	});
});

describe("the CI half of the same gate", () => {
	const ci = fs.readFileSync(
		path.join(ROOT, ".github", "workflows", "ci.yml"),
		"utf8",
	);

	it("keeps the whole-repo run in the Lint and types job", () => {
		const step = /- name: Shellcheck\n((?:.*\n)*?) {6}- name:/.exec(ci);
		expect(
			step,
			"the Shellcheck step no longer parses out of ci.yml",
		).not.toBeNull();
		expect((step as RegExpExecArray)[1]).toContain("npm run check:sh");
	});

	it("hard-fails, carrying no continue-on-error", () => {
		const step = /- name: Shellcheck\n((?:.*\n)*?) {6}- name:/.exec(ci);
		expect(
			step,
			"the Shellcheck step no longer parses out of ci.yml",
		).not.toBeNull();
		expect((step as RegExpExecArray)[1]).not.toContain("continue-on-error");
	});

	it("puts the pinned binary on $GITHUB_PATH, so later steps run it too", () => {
		const action = fs.readFileSync(
			path.join(ROOT, ".github", "actions", "shellcheck", "action.yml"),
			"utf8",
		);
		expect(action).toMatch(/>> "\$GITHUB_PATH"/);
		expect(ci, "the lint job installs it").toMatch(
			/- name: Install shellcheck\n.*\n {8}uses: \.\/\.github\/actions\/shellcheck\n/,
		);
		expect(ci, "the Vitest job installs it").toMatch(
			/- name: Install test tools\n.*\n {8}uses: \.\/\.github\/actions\/test-tools\n/,
		);
		expect(
			fs.readFileSync(
				path.join(ROOT, ".github", "actions", "test-tools", "action.yml"),
				"utf8",
			),
		).toMatch(/uses: \.\/\.github\/actions\/shellcheck\n/);
		expect(ci.indexOf("- name: Install shellcheck")).toBeLessThan(
			ci.indexOf("- name: Shellcheck\n"),
		);
	});
});
