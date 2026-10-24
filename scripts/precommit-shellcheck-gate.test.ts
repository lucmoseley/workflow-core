// @vitest-environment node

/*
 * The pre-commit shellcheck gate (mantahostels#1134), exercised as the shell it is.
 *
 * `.husky/pre-commit` runs shellcheck only when the commit stages a shell file,
 * as scripts/lib/formatters.js picks them (#1828), hands it exactly those
 * paths, and fails the commit when shellcheck exits non-zero.
 *
 * shellcheck itself is stubbed as a script on PATH, so both exit codes are ours
 * to drive and no case depends on the repo's real findings. The CI half, the
 * whole-repo run in `ci.yml`'s Lint and tests job, is pinned too.
 *
 * Both halves are hard gates: loosen a case and a shellcheck finding in a guard
 * or husky hook — the shell every other gate runs in — lands unrefused.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	cutGateFragment,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	holdLock,
	LIB,
	LIB_COMMANDS,
	ROOT,
} from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

// Anchored on the shell variable holding the path list, not on any flag: the
// cutter must survive a mutation to the flags the cases below assert, or
// removing one would break every case by throwing rather than by failing the
// single case that guards it.
const gateFragment = () => cutGateFragment("shellcheck -x");

/** Where the stub records the argv it was handed, one path per line. */
const ARGS_FILE = "shellcheck-args.txt";

/**
 * What an isolated fixture's PATH must hold: the commands the cut fragment
 * and the library's arming read shell out to, plus `sh` itself —
 * execFileSync resolves the shell against the CHILD's PATH, so omitting it
 * fails the spawn with no output at all rather than failing the gate.
 */
const NEEDED = ["sh", "node", ...LIB_COMMANDS];

/**
 * Populates `bin` with a symlink to each of NEEDED, so a PATH of `bin` alone
 * runs the fragment with NO shellcheck reachable.
 *
 * Built up rather than subtracted from `process.env.PATH`: subtracting every
 * directory that holds a `shellcheck` removes ~/.local/bin here but /usr/bin on
 * ubuntu-latest, taking git and grep with it — so the absent-binary case would
 * pass or fail on the host rather than on the gate.
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
 * A git repo with one commit and `staged` written and staged, plus — unless
 * `stub` is false — a stubbed `shellcheck` on PATH whose exit code is ours.
 * `noFlock` leaves flock off PATH; `flockExit` stubs a flock that only exits.
 * Either absent binary makes the fixture `isolated`: its bin is the whole PATH.
 */
type GateRepo = TempRepo & { bin: string; isolated: boolean; lockDir: string };

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
			`#!/bin/sh\nprintf '%s\\n' "$@" >>"${path.join(root, ARGS_FILE)}"\nexit ${opts.shellcheckExit ?? 0}\n`,
		);
		fs.chmodSync(stub, 0o755);
	}
	if (opts.flockExit !== undefined) {
		const stub = path.join(bin, "flock");
		fs.writeFileSync(stub, `#!/bin/sh\nexit ${opts.flockExit}\n`);
		fs.chmodSync(stub, 0o755);
	}
	// The gate's lock lives under TMPDIR, so each fixture takes its own and no
	// case contends with a real commit's shellcheck.
	const lockDir = path.join(root, "locks");
	fs.mkdirSync(lockDir);

	return { ...repo, bin, isolated, lockDir };
}

function gateLaunch(repo: GateRepo): {
	script: string;
	env: NodeJS.ProcessEnv;
} {
	// A trailing no-op stands in for the rest of the hook, which really does
	// continue past this gate. Without it the fragment's own exit status is
	// shellcheck's, and the `|| { … exit 1; }` block could be deleted with every
	// case still green.
	// `exec 2>&1` because every message this gate prints goes to stderr, which
	// execFileSync surfaces only on a non-zero exit — the warn-and-pass case
	// would otherwise assert against an empty string and pass whatever the hook
	// printed.
	const script = `exec 2>&1\n${LIB}\n${gateFragment()}\n:\n`;
	// An isolated fixture withheld the stub, so its bin holds only git and grep
	// and must stand ALONE as PATH — appending the real one would hand the
	// fragment the machine's own shellcheck back.
	const search = repo.isolated
		? repo.bin
		: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`;
	return {
		script,
		env: {
			...process.env,
			PATH: search,
			TMPDIR: repo.lockDir,
			WFC_PLUGIN_ROOT: ROOT,
		},
	};
}

function stubArgs(repo: GateRepo): string[] {
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
	return { code, output, args: stubArgs(repo) };
}

/**
 * runGate in the background, for a case that must act while the gate waits:
 * `whenSaid` runs once the output matches `cue`.
 */
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
			resolve({ code: code ?? 1, output, args: stubArgs(repo) }),
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
			// Red, so a gate that fired anyway would fail the case rather than
			// passing by luck.
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
		// `git ls-files 'scripts/*.sh'` in check:sh matches slashes, so the libs
		// are in its file set; a gate anchored on `^scripts/[^/]*\.sh$` would
		// silently never fire on the three files 13 guards source.
		const repo = fixture({
			staged: { "scripts/lib/guard-thing.sh": BODY },
			shellcheckExit: 0,
		});
		expect(runGate(repo).args).toContain("scripts/lib/guard-thing.sh");
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
		// A commit staging only a deletion never opens the gate at all, so that
		// case would pass with no --diff-filter on the path list. Forcing the
		// gate open with a live file is what makes the filter load-bearing:
		// without it shellcheck is handed a path with no file behind it.
		const gone = "scripts/guard-gone.sh";
		const repo = fixture({ staged: {}, shellcheckExit: 0 });
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		// Deliberately unlike BODY. Two identical short files read to git as one
		// RENAME rather than a delete plus an add, and a rename stages no
		// deletion at all — so the case would pass with the filter gone.
		fs.writeFileSync(
			path.join(repo.root, gone),
			`#!/bin/sh\n${"echo distinct\n".repeat(12)}`,
		);
		repo.git("add", "--", gone);
		repo.git("commit", "-qm", "add");
		// `git rm` takes the now-empty directory with it.
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
		// `stub: false` is what makes this a test. With the stub present the
		// SKIPPED branch is unreachable whatever the gate does, so the case would
		// stay green with the whole file-set guard deleted.
		const repo = fixture({
			staged: { [OUTSIDE]: "const a = 1;\n" },
			stub: false,
		});
		expect(runGate(repo).output).not.toMatch(/SKIPPED/);
	});

	it("reads the commit's staged paths, NOT every tracked shell file", () => {
		// Every other fixture's only tracked .sh IS its staged one, so swapping
		// the path list for check:sh's own `git ls-files 'scripts/*.sh'` leaves
		// them all green — this case is the only thing pinning scoped-not-whole-
		// repo (mantahostels#1134).
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
		// shellcheck has no --no-error-on-unmatched-pattern, so without the
		// gate's `[ -f ]` filter it fails the commit on "does not exist" — a
		// non-finding error that reads as a lint failure.
		const repo = fixture({ staged: { [GUARD]: BODY }, shellcheckExit: 0 });
		fs.rmSync(path.join(repo.root, GUARD));
		const { code, args } = runGate(repo);
		expect(args).not.toContain(GUARD);
		expect(code).toBe(0);
	});

	it("carries check:sh's flags and excludes only SC2329 and SC2016 on either side", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		const script: string = pkg.scripts["check:sh"];
		const fragment = gateFragment();
		const exclude = "--exclude=SC2329,SC2016";
		for (const flag of ["-x", "--severity=style", exclude]) {
			expect(script, `check:sh lost ${flag}`).toContain(flag);
			expect(fragment, `the gate lost ${flag}`).toContain(flag);
		}
		// #1315 Q2 excluded these two by code; any other false finding takes an
		// inline disable, and a sourced script silences SC2148 with its own
		// `# shellcheck shell=` line (#753).
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
			execFileSync("sh", ["-c", `exec 2>&1\n${LIB}\n${gateFragment()}\n:\n`], {
				cwd: repo.root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${repo.bin}${path.delimiter}${process.env.PATH ?? ""}`,
					WFC_PLUGIN_ROOT: "/nonexistent",
				},
			});
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
		const lock = path.join(repo.lockDir, "wfc-shellcheck.lock");
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
		// A directory where the lock file goes: the open fails, not the lock.
		fs.mkdirSync(path.join(repo.lockDir, "wfc-shellcheck.lock"));
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

	it("keeps the whole-repo run in the existing Lint and tests job", () => {
		// The pre-commit gate reads only the paths a commit names, so nothing but
		// this step ever re-checks a guard whose sourced lib changed under it.
		// Matched inside the step rather than as `run: npm run check:sh`: since
		// #124 the step is a block that installs the pinned shellcheck first and
		// invokes the script under its own PATH.
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
		// Vitest's adopter first-commit tests run the real pre-commit shellcheck
		// gate; left on the image's 0.9.0 they went red on an info finding the
		// pinned 0.11.0 does not raise (#1295).
		const step = /- name: Shellcheck\n((?:.*\n)*?) {6}- name:/.exec(ci);
		expect(
			step,
			"the Shellcheck step no longer parses out of ci.yml",
		).not.toBeNull();
		expect((step as RegExpExecArray)[1]).toMatch(/>> "\$GITHUB_PATH"/);
	});
});
