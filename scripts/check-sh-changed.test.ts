// @vitest-environment node

/*
 * check-sh-changed.test.ts — check-sh-changed.sh, the `check:sh:changed` script
 * (#1015), shellchecks only the shell files that differ from HEAD. A red case
 * here fails CI's Vitest step.
 *
 * Scope cases stub shellcheck as an argv recorder on PATH, because CI's Vitest
 * step has no shellcheck on PATH (ci.yml fetches it for its own step only).
 *
 * It is the in-session route sessions use in place of the full `check:sh`:
 * loosen a case and a changed shell file goes unchecked while the run reads
 * green, or its flags drift from `check:sh`'s.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	gateTmpdir,
	newRepo,
	registerTempCleanup,
} from "./lib/precommit-gate-harness";
import { holdLock, ROOT } from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();
const SCRIPT = path.join(ROOT, "scripts", "check-sh-changed.sh");
const ARGS_FILE = "shellcheck-args.txt";

const HAS_SHELLCHECK =
	spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status === 0;

const readCommandPath = (cmd: string) =>
	execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim();

function fixture() {
	const { root, git } = newRepo("check-sh-changed-", temps);
	fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
	fs.mkdirSync(path.join(root, ".husky"));
	fs.writeFileSync(path.join(root, "scripts", "a.sh"), "#!/bin/sh\necho a\n");
	fs.writeFileSync(path.join(root, "scripts", "b.sh"), "#!/bin/sh\necho b\n");
	fs.writeFileSync(path.join(root, ".husky", "pre-commit"), "#!/bin/sh\n");
	fs.writeFileSync(path.join(root, "README.md"), "x\n");
	git("add", ".");
	git("commit", "-qm", "init");
	// The stub is itself shell, by its shebang; untracked, it would be checked.
	fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "stub-bin/\n");
	const bin = path.join(root, "stub-bin");
	fs.mkdirSync(bin);
	return { root, git, bin };
}

function stub(root: string, bin: string, code = 0) {
	const at = path.join(bin, "shellcheck");
	fs.writeFileSync(
		at,
		`#!/bin/sh\nprintf '%s\\n' "$@" > '${path.join(root, ARGS_FILE)}'\nexit ${code}\n`,
	);
	fs.chmodSync(at, 0o755);
}

function run(root: string, searchPath: string) {
	const r = spawnSync(readCommandPath("bash"), [SCRIPT], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, PATH: searchPath, TMPDIR: gateTmpdir(root) },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The paths the stub was handed, flags dropped. Null where it never ran. */
const readCheckedArgs = (root: string) => {
	const f = path.join(root, ARGS_FILE);
	if (!fs.existsSync(f)) return null;
	return fs
		.readFileSync(f, "utf8")
		.split("\n")
		.filter((a) => a && !a.startsWith("-"));
};

describe("which files it hands shellcheck", () => {
	it("checks one modified script and nothing unchanged", () => {
		const { root, bin } = fixture();
		stub(root, bin);
		fs.appendFileSync(path.join(root, "scripts", "a.sh"), "echo more\n");
		const r = run(root, `${bin}:${process.env.PATH}`);
		expect(r.status).toBe(0);
		expect(readCheckedArgs(root)).toEqual(["scripts/a.sh"]);
	});

	it("passes check:sh's flags", () => {
		const { root, bin } = fixture();
		stub(root, bin);
		fs.appendFileSync(path.join(root, "scripts", "a.sh"), "echo more\n");
		run(root, `${bin}:${process.env.PATH}`);
		const argv = fs.readFileSync(path.join(root, ARGS_FILE), "utf8");
		const pkg = JSON.parse(
			fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
		);
		// The binary is the LAST `shellcheck` word, the lock's name coming first.
		const words: string[] = pkg.scripts["check:sh"].split(/\s+/);
		const at = words.lastIndexOf("shellcheck");
		const flags = words.slice(at + 1, at + 4);
		expect(flags.every((f: string) => f.startsWith("-"))).toBe(true);
		expect(argv.split("\n").slice(0, 3)).toEqual(flags);
	});

	it("checks staged, unstaged, untracked-new, nested and hook paths together", () => {
		const { root, git, bin } = fixture();
		stub(root, bin);
		fs.appendFileSync(path.join(root, "scripts", "a.sh"), "echo staged\n");
		git("add", "scripts/a.sh");
		fs.appendFileSync(path.join(root, ".husky", "pre-commit"), "echo hi\n");
		fs.writeFileSync(path.join(root, "scripts", "lib", "new.sh"), "echo n\n");
		fs.appendFileSync(path.join(root, "README.md"), "not shell\n");
		const r = run(root, `${bin}:${process.env.PATH}`);
		expect(r.status).toBe(0);
		expect(readCheckedArgs(root)).toEqual([
			".husky/pre-commit",
			"scripts/a.sh",
			"scripts/lib/new.sh",
		]);
	});

	it("checks changed shell outside scripts/, by extension or shebang, and no other file (#1828)", () => {
		const { root, git, bin } = fixture();
		stub(root, bin);
		fs.mkdirSync(path.join(root, "tools"));
		fs.writeFileSync(path.join(root, "tools", "c.sh"), "echo c\n");
		fs.writeFileSync(path.join(root, "tools", "run"), "#!/usr/bin/env bash\n");
		fs.writeFileSync(path.join(root, "tools", "notes"), "plain\n");
		fs.mkdirSync(path.join(root, "vendor"));
		fs.writeFileSync(path.join(root, "vendor", "v.sh"), "echo v\n");
		fs.writeFileSync(
			path.join(root, ".gitattributes"),
			"vendor/** linguist-vendored\n",
		);
		git("add", "tools/c.sh");
		const r = run(root, `${bin}:${process.env.PATH}`);
		expect(r.status).toBe(0);
		expect(readCheckedArgs(root)).toEqual(["tools/c.sh", "tools/run"]);
	});

	it("leaves out a script deleted from the worktree", () => {
		const { root, bin } = fixture();
		stub(root, bin);
		fs.rmSync(path.join(root, "scripts", "b.sh"));
		const r = run(root, `${bin}:${process.env.PATH}`);
		expect(r.status).toBe(0);
		expect(readCheckedArgs(root)).toBeNull();
	});

	it("passes shellcheck's failure through", () => {
		const { root, bin } = fixture();
		stub(root, bin, 1);
		fs.appendFileSync(path.join(root, "scripts", "a.sh"), "echo more\n");
		expect(run(root, `${bin}:${process.env.PATH}`).status).toBe(1);
	});
});

it("waits on the shellcheck lock a neighbour holds, and says so (#2627)", async () => {
	const { root, bin } = fixture();
	stub(root, bin);
	fs.appendFileSync(path.join(root, "scripts", "a.sh"), "echo more\n");
	const lock = path.join(gateTmpdir(root), "wfc-shellcheck.lock");
	const held = holdLock(lock);
	try {
		const child = spawn(readCommandPath("bash"), [SCRIPT], {
			cwd: root,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				TMPDIR: gateTmpdir(root),
			},
		});
		let out = "";
		const cue = /check:sh:changed: another run holds .*wfc-shellcheck\.lock/;
		const status = await new Promise<number | null>((resolve) => {
			child.stderr.on("data", (d) => {
				out += d;
				if (cue.test(out)) held.release();
			});
			child.on("close", resolve);
		});
		expect(out).toMatch(cue);
		expect(out).not.toMatch(/unserialised/);
		expect(readCheckedArgs(root)).toEqual(["scripts/a.sh"]);
		expect(status).toBe(0);
	} finally {
		held.release();
	}
});

describe("when nothing is checked", () => {
	it("says nothing differs and exits 0, never invoking shellcheck", () => {
		const { root, bin } = fixture();
		stub(root, bin);
		const r = run(root, `${bin}:${process.env.PATH}`);
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/no shell file differs from HEAD/);
		expect(readCheckedArgs(root)).toBeNull();
	});

	it("fails, not passes, when shellcheck is absent, with exit 127 and a pointer to the shellcheck-not-installed rule", () => {
		const { root, bin } = fixture();
		// Built up rather than subtracted from PATH: ~/.local/bin holds both
		// shellcheck and tools the script needs (precommit-actionlint-gate.test.ts).
		for (const cmd of ["git", "sort", "dirname", "node"]) {
			fs.symlinkSync(readCommandPath(cmd), path.join(bin, cmd));
		}
		fs.appendFileSync(path.join(root, "scripts", "a.sh"), "echo more\n");
		const r = run(root, bin);
		expect(r.status).toBe(127);
		expect(r.out).toMatch(/shellcheck is not on PATH/);
		expect(r.out).toMatch(/shellcheck-not-installed\.txt/);
	});
});

it.skipIf(!HAS_SHELLCHECK)(
	"reports a warning planted in the changed file",
	() => {
		const { root } = fixture();
		// SC2154 is warning-tier: a variable referenced but never assigned.
		fs.appendFileSync(
			path.join(root, "scripts", "a.sh"),
			'echo "$never_set"\n',
		);
		const r = run(root, process.env.PATH ?? "");
		expect(r.status).not.toBe(0);
		expect(r.out).toMatch(/SC2154/);
		expect(r.out).not.toMatch(/b\.sh/);
	},
);
