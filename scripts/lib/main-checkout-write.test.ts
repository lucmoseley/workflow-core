// @vitest-environment node
/*
 * guard-main-checkout-write at the hook input contract (#4248): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a write to the main checkout's tracked tree is refused once it is
 * cut over, naming the worktree; the worktree's own files and gitignored
 * stores stay writable. Driven through runCore on the testkit's split
 * checkout, so the dispatcher's root and tree come from a real worktree pair.
 *
 * Loosen it and a session's edit lands uncommitted in the main checkout, which
 * the levelling fast-forward then refuses on.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

let at: { main: string; worktree: string };

freshSandbox((sb) => {
	at = splitCheckout(path.join(sb.dir, "split"));
	fs.writeFileSync(path.join(at.main, ".gitignore"), ".claude/\n");
});

beforeEach(() => {
	vi.stubEnv("WFC_MODULES", "landing");
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "pipe" });

const run = (
	name: string,
	tool: string,
	input: Record<string, unknown>,
	from: { worktree?: string; cwd?: string } = { worktree: at.worktree },
) =>
	runCore(name, toolCall(tool, input), { root: at.main, ...from }).output
		?.permissionDecisionReason ?? null;

const refusal = (
	tool: string,
	input: Record<string, unknown>,
	from?: { worktree?: string; cwd?: string },
) => run("guard-main-checkout-write", tool, input, from);

const edit = (file: string) =>
	refusal("Edit", { file_path: file, old_string: "a", new_string: "b" });

describe("a cut-over main checkout refuses writes to its tree (#4248)", () => {
	it("refuses an Edit of a tracked main-checkout file, naming the worktree's copy", () => {
		const reason = edit(path.join(at.main, "a.md"));
		expect(reason).toContain("writes a.md in the main checkout");
		expect(reason).toContain(path.join(at.worktree, "a.md"));
	});

	it("allows the same Edit in the session's worktree", () => {
		expect(edit(path.join(at.worktree, "a.md"))).toBeNull();
	});

	it("refuses a Write of a new file git would not ignore", () => {
		expect(
			refusal("Write", {
				file_path: path.join(at.main, "docs", "new.md"),
				content: "x",
			}),
		).toContain("writes docs/new.md in the main checkout");
	});

	it("allows a Write into a gitignored store under it", () => {
		expect(
			refusal("Write", {
				file_path: path.join(at.main, ".claude", "tmp", "x.json"),
				content: "{}",
			}),
		).toBeNull();
	});

	it("refuses a Bash redirect into a tracked file, and one reached through a cd", () => {
		expect(
			refusal("Bash", { command: `echo x > ${path.join(at.main, "a.md")}` }),
		).toContain("writes a.md");
		expect(
			refusal("Bash", { command: `cd ${at.main} && echo x | tee a.md` }),
		).toContain("writes a.md");
	});

	it("refuses a git write there and allows a read", () => {
		expect(
			refusal("Bash", { command: `git -C ${at.main} commit -m x` }),
		).toContain("writes the main checkout's index, HEAD or files");
		expect(refusal("Bash", { command: `git -C ${at.main} status` })).toBeNull();
		expect(
			refusal("Bash", { command: `git -C ${at.main} stash list` }),
		).toBeNull();
	});

	it("sends a session whose cwd is the main checkout to its own worktree, or the cut", () => {
		const reason = refusal(
			"Bash",
			{ command: `git -C ${at.main} reset --hard` },
			{ cwd: at.main },
		);
		expect(reason).toContain(
			`\`cd\` into your own worktree under ${path.join(at.main, ".claude", "worktrees")}/ where you have one`,
		);
		expect(reason).toContain("session-checkout.js cut <session-name>");
	});

	it("names the worktree to a session in one, whatever tree `-C` names", () => {
		expect(
			refusal("Bash", { command: `git -C ${at.main} reset --hard` }),
		).toContain(`as \`git -C ${at.worktree} …\``);
	});

	it("leaves the branch move to this core, the pin standing down", () => {
		const command = `git -C ${at.main} checkout -b x`;
		expect(run("guard-branch", "Bash", { command })).toBeNull();
		expect(refusal("Bash", { command })).toContain(
			"writes the main checkout's index, HEAD or files",
		);
	});
});

describe("taking a tracked main-checkout file back to HEAD is allowed (#4449)", () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(at.main, "sub"), { recursive: true });
	});

	it.each([
		"restore --source=HEAD --staged --worktree -- a.md",
		"restore --source HEAD a.md",
		"restore -s HEAD a.md",
		"restore -WsHEAD a.md",
		"restore -s @ -- a.md b.md",
		"checkout HEAD -- a.md",
	])("allows `git %s`", (args) => {
		expect(
			refusal("Bash", { command: `git -C ${at.main} ${args}` }),
		).toBeNull();
	});

	it.each([
		"restore --source=landing a.md",
		"restore -s landing a.md",
		"restore -Ws landing a.md",
		"restore --staged",
		"checkout landing -- a.md",
		"checkout landing",
		"checkout --",
		"restore a.md",
		"restore -- a.md",
		"checkout -- a.md",
		"restore --source=HEAD .",
		"restore --source=HEAD -- sub",
		"restore --source=HEAD -- '*.md'",
		"restore --source=HEAD -- :/a.md",
		"checkout HEAD -- .",
	])(
		"still refuses `git %s`, which names no file by name to take back to HEAD",
		(args) => {
			expect(
				refusal("Bash", { command: `git -C ${at.main} ${args}` }),
			).toContain("writes the main checkout's index, HEAD or files");
		},
	);

	it("names that restore in an edit's refusal", () => {
		expect(edit(path.join(at.main, "a.md"))).toContain(
			`git -C ${at.main} restore --source=HEAD --staged --worktree -- a.md`,
		);
	});
});

describe("an interpreter on no script file, run from the main checkout, is refused (#4469)", () => {
	const fromMain = (command: string) =>
		refusal("Bash", { command }, { cwd: at.main });
	const Refused = "runs an interpreter on a program that is no file";

	it("refuses a heredoc-fed python3 whose cwd is the main checkout", () => {
		const reason = fromMain(
			"python3 - <<'EOF'\nopen('a.md','w').write('x')\nEOF",
		);
		expect(reason).toContain(`${Refused}, in the main checkout`);
		expect(reason).toContain("`cd` into your own worktree");
	});

	it("refuses every inline, stdin and flag spelling there", () => {
		for (const command of [
			`node -e "require('fs').writeFileSync('a.md','x')"`,
			"node - <<'EOF'\nx\nEOF",
			`python3 -c "open('a.md','w').write('x')"`,
			`python3 -uc "open('a.md','w')"`,
			`python3 -W ignore -c "open('a.md','w')"`,
			"python3 <<< 'x'",
			`echo "open('a.md','w')" | python3 -`,
			"cat x.py | python3",
			"python3 < x.py",
			"python3 -m x",
			`bash -c "echo x > a.md"`,
			"sh <<'EOF'\nx\nEOF",
		])
			expect(fromMain(command), command).toContain(Refused);
	});

	it("refuses one behind a wrapper, in a subshell or a substitution", () => {
		for (const command of [
			`env FOO=1 python3 -c 'x'`,
			`timeout 5 python3 -c 'x'`,
			`nohup node -e 'x'`,
			`(python3 -c 'x')`,
			`echo $(python3 -c 'x')`,
		])
			expect(fromMain(command), command).toContain(Refused);
	});

	it("refuses one a session in its worktree reaches through `cd`", () => {
		const reason = refusal("Bash", {
			command: `cd ${at.main} && python3 - <<'EOF'\nopen('a.md','w')\nEOF`,
		});
		expect(reason).toContain(`${Refused}, in the main checkout`);
		expect(reason).toContain(`Your session's worktree is ${at.worktree}`);
	});

	it("allows it in the session's worktree, and in a gitignored store", () => {
		expect(
			refusal("Bash", { command: "python3 - <<'EOF'\nprint(1)\nEOF" }),
		).toBeNull();
		const store = path.join(at.main, ".claude", "tmp");
		fs.mkdirSync(store, { recursive: true });
		expect(
			refusal("Bash", { command: `python3 -c 'print(1)'` }, { cwd: store }),
		).toBeNull();
	});

	it("allows a script file run there, fed a heredoc or not", () => {
		fs.mkdirSync(path.join(at.main, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(at.main, "scripts", "x.js"), "");
		expect(fromMain("node scripts/x.js cut s")).toBeNull();
		expect(fromMain("node scripts/x.js <<'EOF'\ndata\nEOF")).toBeNull();
	});
});

describe("before the cutover, or with `landing` off, it refuses nothing (#4248)", () => {
	it("allows an Edit of the main checkout while its main tracks landing", () => {
		git(at.main, "config", "branch.main.merge", "refs/heads/landing");
		expect(edit(path.join(at.main, "a.md"))).toBeNull();
	});

	it("allows it with the `landing` module off", () => {
		vi.stubEnv("WFC_MODULES", "");
		expect(edit(path.join(at.main, "a.md"))).toBeNull();
	});
});
