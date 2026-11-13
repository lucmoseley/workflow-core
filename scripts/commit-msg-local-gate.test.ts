// @vitest-environment node
/*
 * .husky/commit-msg sources the adopter's own `.husky/commit-msg.local` last
 * (#5142).
 *
 * Breaking it costs every adopter's own commit-msg refusals: they stop firing
 * silently, or one whose script has gone missing passes every commit.
 *
 * Each case commits through the real hook in a throwaway repo, run from the
 * plugin root as an adopter's shim runs it. The scan's own cases are
 * scripts/precommit-local-gate.test.ts's, over scripts/lib/local-hook.sh.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommitMsgHook } from "./lib/commit-msg-testkit";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";

const ROOT = path.join(__dirname, "..");

let dir: string;
let hooks: string;

// CLAUDE_PROJECT_DIR is the fixture, never a session's live checkout (#3311).
const git = (args: string[]) => {
	const r = spawnSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WFC_PLUGIN_ROOT: ROOT },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const readHead = () => git(["rev-parse", "HEAD"]).out.trim();

let change = 0;
const commit = (message: string) => {
	change += 1;
	fs.writeFileSync(path.join(dir, "a.md"), `a ${change}\n`);
	git(["add", "a.md"]);
	return git(["commit", "-q", "-m", message]);
};

/** The refusal's way out, which every missing-script case must print. */
const WAY_OUT =
	"Every commit is refused until it exists or the local file stops naming it";

const writeLocal = (body: string) =>
	fs.writeFileSync(path.join(dir, ".husky", "commit-msg.local"), body);

beforeEach(() => {
	dir = mkScratchDir("commit-msg-local-");
	hooks = mkScratchDir("commit-msg-local-hooks-");
	initGitRepo(dir, hooks);
	fs.mkdirSync(path.join(dir, ".husky"));
	installCommitMsgHook(hooks);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe(".husky/commit-msg's commit-msg.local seam (#5142)", () => {
	it("changes nothing where the file is absent", () => {
		expect(commit("Add a line").status).toBe(0);
	});

	it("refuses on the adopter's own refusal, reading the message file from $1", () => {
		writeLocal(
			'if grep -q WIP "$1"; then echo "local: no WIP commits" >&2; exit 1; fi\n',
		);
		const before = readHead();
		const refused = commit("WIP add a line");
		expect(refused.status).toBe(1);
		expect(refused.out).toContain("local: no WIP commits");
		expect(readHead()).toBe(before);
		expect(commit("Add a line").status).toBe(0);
	});

	it("refuses on a bare failing command, the hook being `sh -e`", () => {
		writeLocal("false\necho after >&2\n");
		const r = commit("Add a line");
		expect(r.status).toBe(1);
		expect(r.out).not.toContain("after");
	});

	it("runs only after the core's own refusals pass", () => {
		writeLocal('echo "local ran" >&2\n');
		const r = commit(`Add ${"x".repeat(80)}`);
		expect(r.status).toBe(1);
		expect(r.out).toContain("over the 72-character limit");
		expect(r.out).not.toContain("local ran");
	});

	it("refuses every commit on a script it names that the repo lacks, naming it (#426)", () => {
		writeLocal('node scripts/gone.js "$1"\n');
		const r = commit("Add a line");
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"commit-msg: .husky/commit-msg.local calls a script this repo does not have:",
		);
		expect(r.out).toContain("  scripts/gone.js");
		expect(r.out).toContain(WAY_OUT);
	});

	it("passes a script the repo has, and skips one under $WFC_PLUGIN_ROOT", () => {
		fs.mkdirSync(path.join(dir, "scripts"));
		fs.writeFileSync(path.join(dir, "scripts", "mine.sh"), "exit 0\n");
		writeLocal(
			'sh scripts/mine.sh "$1"\n[ -e "$WFC_PLUGIN_ROOT"/scripts/absent.sh ] || :\n',
		);
		const r = commit("Add a line");
		expect(r.out).not.toContain(WAY_OUT);
		expect(r.status).toBe(0);
	});

	it("runs on a replay with $route naming it, while the core's checks stay stood down", () => {
		writeLocal('echo "local route=$route" >&2\n');
		/* A cherry-pick's `--continue`: CHERRY_PICK_HEAD at commit-msg (scripts/lib/commit-route.sh). */
		fs.writeFileSync(
			path.join(dir, ".git", "CHERRY_PICK_HEAD"),
			`${readHead()}\n`,
		);
		const r = commit(`Add ${"x".repeat(80)}`);
		expect(r.out).toContain("local route=cherry-pick");
		expect(r.out).not.toContain("over the 72-character limit");
		expect(r.status).toBe(0);
	});
});
