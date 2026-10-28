// @vitest-environment node
/*
 * lib/scratch-git.js, a PreToolUse dispatcher core (#3162), refuses running
 * an untracked shell script that writes git state before turning on errexit
 * and nounset — the route by which a review probe's failed `cd` committed on
 * the shared `main` and emptied its ref (the incident comment on #3098).
 *
 * The first case is that incident's shape: a helper the script sources is
 * missing, so its scratch directory variable is unset and every git command
 * runs in the repository the session started in. Do not thin it out.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over real
 * git and the production host ports: one host repository and one sibling,
 * built once, each holding a tracked script the core must never read. Each
 * case writes its own script. Each refusal costs a real `git ls-files`, which
 * is most of the file's time; a run at load 41 on 8 cores took 10.2 s, 4.4 s
 * of it in the cases.
 *
 * Loosen a fire case and a probe's failed `cd` reaches the shared `.git/`
 * again; widen it and a script that reads git, or fails closed, is refused.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCore, toolCall } from "./guard-core-testkit";

let dir: string;
let repo: string;
let sibling: string;
let outside: string;
let n = 0;

/** A repository at `at` with `tracked.sh` committed in it. */
function trackedRepo(at: string) {
	fs.mkdirSync(path.join(at, ".claude", "tmp"), { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: at, stdio: "ignore" });
	git("init", "-q", "-b", "main", ".");
	// This checkout's core.hooksPath is absolute, so a scratch repo would
	// otherwise run the real Husky gates (mantahostels#100's finding).
	git("config", "core.hooksPath", path.join(dir, "no-hooks"));
	fs.writeFileSync(path.join(at, ".gitignore"), ".claude/tmp/\n");
	fs.writeFileSync(
		path.join(at, "tracked.sh"),
		"#!/bin/bash\ngit commit -qm release\n",
	);
	git("add", "--", ".gitignore", "tracked.sh");
	git(
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		"base",
	);
}

beforeAll(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scratch-git-")));
	repo = path.join(dir, "repo");
	sibling = path.join(dir, "sibling");
	outside = path.join(dir, "outside");
	trackedRepo(repo);
	trackedRepo(sibling);
	fs.mkdirSync(outside);
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh script under `where`, named `.sh` unless `name` says otherwise. */
function script(body: string, where = ".claude/tmp", name?: string) {
	const rel = path.join(where, name ?? `probe${++n}.sh`);
	const abs = path.isAbsolute(rel) ? rel : path.join(repo, rel);
	fs.writeFileSync(abs, body, { mode: 0o755 });
	return rel;
}

function refusal(command: string): string | null {
	const { output } = runCore(
		"guard-scratch-git",
		toolCall("Bash", { command }),
		{ root: repo },
	);
	return output?.permissionDecision === "deny"
		? (output.permissionDecisionReason ?? null)
		: null;
}

/** The line a refusal says the script reached unguarded. */
const reached = (command: string) =>
	/it reaches `([^`]*)`/.exec(refusal(command) ?? "")?.[1] ?? null;

const INCIDENT = `#!/bin/bash
here=$(dirname "$0")
source "$here/lib.sh"
cd "$SCRATCH"
git commit -qm A
: > .git/refs/heads/main
`;

const UNGUARDED = "cd /x\ngit commit -qm A\n";

describe("refuses a git-writing script that does not fail closed, naming the line it reaches", () => {
	it("refuses the incident's probe at its `source` of a missing helper, handing over `set -eu` and `mktemp -d` (#3162; the #3098 incident comment)", () => {
		const why = refusal(`bash ${script(INCIDENT)}`);
		expect(why).toContain("set -eu");
		expect(why).toContain('it reaches `source "$here/lib.sh"`');
		expect(why).toContain("mktemp -d");
	});

	it("refuses a script outside every repository, since its git still runs in the start directory", () => {
		expect(reached(`sh ${script("cd /nowhere\ngit init -q\n", outside)}`)).toBe(
			"cd /nowhere",
		);
	});

	it('refuses errexit alone, as an unset `$D` leaves `cd "$D"` in the start directory', () => {
		expect(reached(`bash ${script('set -e\ncd "$D"\ngit add -A\n')}`)).toBe(
			'cd "$D"',
		);
	});

	it("refuses nounset alone, as a failed `cd` runs on", () => {
		expect(reached(`bash ${script("set -u\ncd /x\ngit reset --hard\n")}`)).toBe(
			"cd /x",
		);
	});

	it("refuses flags turned on only after the first `cd`", () => {
		expect(reached(`bash ${script("cd /x\nset -eu\ngit commit -m x\n")}`)).toBe(
			"cd /x",
		);
	});

	it("refuses flags a later `set +e` or `set +o nounset` turns back off", () => {
		expect(
			reached(`bash ${script("set -eu\nset +e\ncd /x\ngit commit -m x\n")}`),
		).toBe("cd /x");
		expect(
			reached(`bash ${script("set -eu\nset +o nounset\ngit add -A\n")}`),
		).toBe("git add -A");
	});

	it.each([
		["a `.git/` removal", "rm .git/index"],
		["a ref emptied with no space after `>`", ": >.git/refs/heads/main"],
		["the whole `.git` removed", "rm -rf .git"],
		["an object write", "git hash-object -w f"],
		["a tree write", "git write-tree"],
		["a reflog expiry", "git reflog expire --all"],
		["a `--git-dir` given as its own word", "git --git-dir x commit -m x"],
		[
			"a global `-C` and `-c`",
			'git -C "$R" -c core.x=1 update-ref refs/x HEAD',
		],
	])("refuses %s, naming it", (_label, line) => {
		expect(reached(`bash ${script(`${line}\n`)}`)).toBe(line);
	});

	it("refuses a script run directly by its shell shebang", () => {
		const s = script(`#!/usr/bin/env bash\n${UNGUARDED}`);
		expect(reached(`./${s}`)).toBe("cd /x");
	});

	it("refuses a script sourced into the session's own shell, by either spelling", () => {
		const s = script(UNGUARDED);
		expect(reached(`source ${s}`)).toBe("cd /x");
		expect(reached(`. ${s}`)).toBe("cd /x");
	});

	it("refuses a relative script path after a `cd` the command makes", () => {
		const s = script(UNGUARDED);
		expect(reached(`cd .claude/tmp && bash ${path.basename(s)}`)).toBe("cd /x");
	});

	it("refuses a shebang's flags where an interpreter is named, which ignores them", () => {
		const s = script(`#!/bin/bash -eu\n${UNGUARDED}`);
		expect(reached(`bash ${s}`)).toBe("cd /x");
		expect(refusal(`./${s}`)).toBeNull();
	});

	it.each([
		["timeout 60 bash"],
		["timeout -s KILL 5m bash"],
		["env X=1 bash"],
		["nohup bash"],
		["nice -n 5 bash"],
		["command bash"],
		["sudo -u me bash"],
		["xargs -n 1 bash"],
	])("refuses a script behind a `%s` prefix", (prefix) => {
		expect(reached(`${prefix} ${script(UNGUARDED)}`)).toBe("cd /x");
	});

	it("refuses a script a shell reads from a `<` redirect", () => {
		const s = script(UNGUARDED);
		expect(reached(`bash < ${s}`)).toBe("cd /x");
		expect(reached(`bash -s < ${s}`)).toBe("cd /x");
	});

	it("refuses a script run inside a shell's `-c` text", () => {
		expect(reached(`bash -c "bash ${script(UNGUARDED)}"`)).toBe("cd /x");
	});
});

describe("allows a script that fails closed, writes no git state, or is reviewed code", () => {
	it.each([
		["set -eu", "set -eu\ncd /x\ngit commit -qm A\n"],
		["set -euo pipefail", "#!/bin/bash\nset -euo pipefail\ncd /x\ngit init\n"],
		["set -o errexit -o nounset", "set -o errexit -o nounset\ngit add -A\n"],
		["two set lines", "set -e\nset -u\ngit commit -m x\n"],
		["only read-only git", "cd /x\ngit log --oneline\ngit status\ngit diff\n"],
		["`.github/` and `.gitignore` paths", "cd /x\ncat .github/x .gitignore\n"],
		["no git at all", "cd /x\necho done\n"],
	])("allows a script with %s", (_label, body) => {
		expect(refusal(`bash ${script(body)}`)).toBeNull();
	});

	it("allows flags on the interpreter's own words", () => {
		const s = script(INCIDENT);
		expect(refusal(`bash -eu ${s}`)).toBeNull();
		expect(refusal(`bash -e -u ${s}`)).toBeNull();
		expect(refusal(`bash -o errexit -o nounset ${s}`)).toBeNull();
	});

	it("allows a script the host repository tracks", () => {
		expect(refusal("bash tracked.sh")).toBeNull();
	});

	it("allows a script a sibling repository tracks, asked from its own directory", () => {
		expect(refusal(`bash ${path.join(sibling, "tracked.sh")}`)).toBeNull();
	});

	it("allows a command that reads the script rather than running it", () => {
		const s = script(INCIDENT);
		expect(refusal(`cat ${s}`)).toBeNull();
		expect(refusal(`grep git ${s}`)).toBeNull();
	});

	it("allows a shell's `-c` text that runs no script file", () => {
		expect(refusal("bash -c 'cd /x; git commit -qm A'")).toBeNull();
	});

	it("allows a non-shell script run directly", () => {
		const s = script(
			"#!/usr/bin/env node\n// git commit -qm A\n",
			".claude/tmp",
			`n${++n}.js`,
		);
		expect(refusal(`./${s}`)).toBeNull();
	});

	it("allows a script that does not exist", () => {
		expect(refusal("bash .claude/tmp/absent.sh")).toBeNull();
	});

	it("allows a script word it cannot read, never guessing at the next one", () => {
		const s = script(UNGUARDED);
		expect(refusal(`bash $X ${s}`)).toBeNull();
		expect(refusal(`bash .claude/tmp/absent.sh ${s}`)).toBeNull();
	});
});
