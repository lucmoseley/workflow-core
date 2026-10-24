// @vitest-environment node
/*
 * .husky/commit-msg refuses a commit whose subject runs over 72 characters
 * (#2332, through scripts/check-commit-subject.sh). A case loosened here lets
 * a long subject land on one route while the others refuse it; a case
 * tightened refuses a revert, merge or fixup subject git wrote itself.
 *
 * Each case commits through the real hook in a throwaway repo, since the
 * routes differ in what git hands the hook: `-m` text, a `-F` file, or the
 * editor's file with git's `#` template block in it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-commit-subject.sh");
const RULE = fs
	.readFileSync(
		path.join(ROOT, "docs", "agents", "rules", "commit-message.txt"),
		"utf8",
	)
	.trimEnd();

let dir: string;
let hooks: string;

const git = (args: string[], env: NodeJS.ProcessEnv = {}) => {
	const r = spawnSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const head = () => git(["rev-parse", "HEAD"]).out.trim();

const subject = (n: number, fill = "x") => `Add ${fill.repeat(n - 4)}`;

/** Stages a fresh change, so every commit has something to record. */
let change = 0;
const stage = () => {
	change += 1;
	fs.writeFileSync(path.join(dir, "a.md"), `a ${change}\n`);
	git(["add", "a.md"]);
};

const viaM = (message: string) => {
	stage();
	return git(["commit", "-q", "-m", message]);
};
const viaF = (message: string) => {
	stage();
	const file = path.join(hooks, "msg.txt");
	fs.writeFileSync(file, message);
	return git(["commit", "-q", "-F", file]);
};
const viaEditor = (message: string) => {
	stage();
	const file = path.join(hooks, "msg.txt");
	fs.writeFileSync(file, message);
	const editor = path.join(hooks, "editor.sh");
	fs.writeFileSync(
		editor,
		`#!/bin/sh\ncat ${JSON.stringify(file)} "$1" > "$1.new" && mv "$1.new" "$1"\n`,
		{ mode: 0o755 },
	);
	return git(["commit", "-q"], { GIT_EDITOR: editor });
};

const expectRefused = (
	r: { status: number | null; out: string },
	s: string,
) => {
	expect(r.status).toBe(1);
	expect(r.out).toContain(
		`subject is ${[...s].length} characters, over the 72-character limit`,
	);
	expect(r.out).toContain(`Subject: ${s}`);
	expect(r.out).toContain(RULE);
};

beforeEach(() => {
	dir = mkScratchDir("commit-subject-");
	hooks = mkScratchDir("commit-subject-hooks-");
	initGitRepo(dir, hooks);
	/* Husky runs its hook files through sh; git's own copy is not executable. */
	fs.writeFileSync(
		path.join(hooks, "commit-msg"),
		`#!/bin/sh\nexec sh ${JSON.stringify(path.join(ROOT, ".husky", "commit-msg"))} "$1"\n`,
		{ mode: 0o755 },
	);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe(".husky/commit-msg refuses a subject over 72 characters (#2332)", () => {
	it.each([
		["-m", viaM],
		["-F", viaF],
		["the editor", viaEditor],
	])(
		"refuses a 73-character subject on %s, committing nothing",
		(_route, via) => {
			const before = head();
			expectRefused(via(`${subject(73)}\n\nWhy, in the body.\n`), subject(73));
			expect(head()).toBe(before);
		},
	);

	it("passes a 72-character subject", () => {
		expect(viaM(subject(72)).status).toBe(0);
	});

	it("counts characters, not bytes, so a 72-character subject holding em dashes passes", () => {
		const s = subject(72, "—");
		expect(Buffer.byteLength(s)).toBeGreaterThan(72);
		expect(viaM(s).status).toBe(0);
		expectRefused(viaM(subject(73, "—")), subject(73, "—"));
	});

	it.each([
		`Revert "${subject(80)}"`,
		`Reapply "${subject(80)}"`,
		`Merge branch '${"x".repeat(80)}' into main`,
		`fixup! ${subject(80)}`,
		`squash! ${subject(80)}`,
		`amend! ${subject(80)}`,
	])("passes the git-generated subject %s", (s) => {
		expect(viaM(s).status).toBe(0);
	});

	it("skips leading # comment and blank lines to find the subject", () => {
		const r = viaEditor(`# a note\n\n${subject(72)}\n\nBody.\n`);
		expect(r.status, r.out).toBe(0);
		expectRefused(viaEditor(`# a note\n\n${subject(73)}\n`), subject(73));
	});

	it.each([
		["-m", viaM],
		["-F", viaF],
	])(
		"measures a subject opening on #N on %s, which git keeps",
		(_route, via) => {
			const s = `#2332 ${subject(73 - 6)}`;
			expectRefused(via(`${s}\n\nBody.\n`), s);
		},
	);

	it("measures a typed subject that opens on Merge but is no git merge form", () => {
		const s = `Merge ${subject(73 - 6)}`;
		expectRefused(viaM(s), s);
	});

	it("measures the subject alone, not a long body line", () => {
		expect(viaM(`${subject(40)}\n\n${"y".repeat(200)}\n`).status).toBe(0);
	});

	it("refuses rather than passing a message file it cannot read", () => {
		const r = spawnSync("bash", [SCRIPT, "/nonexistent/COMMIT_EDITMSG", "t"], {
			encoding: "utf8",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("cannot read the commit message file");
	});
});
