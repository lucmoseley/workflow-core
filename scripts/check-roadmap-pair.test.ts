// @vitest-environment node
/*
 * Pins that check-roadmap-pair.js refuses a commit staging the roadmap HTML
 * without its digest, and only warns on the digest alone. The guard's own
 * commit cites no ticket; mantahostels#155 settled the exit codes its checker
 * family uses.
 *
 * check-roadmap-pair.js reads the git index, so it is exercised inside a
 * throwaway repository rather than against this one — a test that staged files
 * here would fight the working tree it is running in.
 *
 * It is a hard gate in .husky/pre-commit: loosen a case and an interrupted
 * edit loop lands a roadmap whose digest describes another version.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-roadmap-pair.js");
const HTML = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const stage = (file: string, body: string) => {
	fs.writeFileSync(path.join(repo, file), body);
	git("add", file);
};

const check = (env: NodeJS.ProcessEnv = process.env) => {
	const r = runInProcess(SCRIPT, [], { cwd: repo, env });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "pair-test-"));
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	fs.mkdirSync(path.join(repo, "docs"));
	stage(HTML, "roadmap v1\n");
	stage(DIGEST, "digest v1\n");
	git("commit", "-qm", "init");
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-roadmap-pair", () => {
	// The whole point: this is the state an interrupted roadmap edit leaves behind.
	it("refuses a commit staging the roadmap HTML without the digest, offering gen-roadmap-digest.js as the way out", () => {
		stage(HTML, "roadmap v2\n");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("is staged without");
		// the failure has to carry the way out, or it just becomes --no-verify habit
		expect(r.stderr).toContain("gen-roadmap-digest.js");
	});

	/* An adopter has no .claude/skills/ of its own: the skill ships in the
	 * plugin, which the gate runs from an install or, in the #2067 trial, from
	 * a source checkout outside the adopter (#2234). */
	it.each([
		["an installed plugin", false],
		["a source checkout of the core", true],
	])(
		"prints a generator command that runs as printed in an adopter of %s (#2234)",
		(_, checkout) => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pair-root-"));
			try {
				fs.symlinkSync(
					path.resolve(__dirname, "../.claude"),
					path.join(root, ".claude"),
				);
				if (checkout) fs.writeFileSync(path.join(root, "package.json"), "{}");
				stage(
					HTML,
					fs.readFileSync(path.resolve(__dirname, "..", HTML), "utf8"),
				);
				const r = check({ ...process.env, WFC_SCRIPT_ROOT: root });
				const printed = r.stderr.match(/^ {2}node .*\\\n.*$/m)?.[0];
				expect(printed).toContain(
					`node ${root}/.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js`,
				);
				const run = spawnSync("bash", ["-c", printed ?? "false"], {
					cwd: repo,
					encoding: "utf8",
				});
				expect(run.status, run.stderr).toBe(0);
				const wrote = runInProcess(
					path.resolve(
						__dirname,
						"../.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js",
					),
					[HTML, "--stdout"],
					{ cwd: repo },
				).stdout;
				expect(fs.readFileSync(path.join(repo, DIGEST), "utf8")).toBe(wrote);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		},
	);

	// --no-verify is denied outright (mantahostels#975), so a message offering it as
	// "the explicit way out" would send a session straight at a deny.
	it("does not offer --no-verify as the way out", () => {
		stage(HTML, "roadmap v2\n");
		const r = check();
		expect(r.stderr).not.toMatch(/--no-verify is the explicit way out/);
		expect(r.stderr).toContain("do not reach for --no-verify");
	});

	it("allows the pair staged together", () => {
		stage(HTML, "roadmap v2\n");
		stage(DIGEST, "digest v2\n");
		expect(check().status).toBe(0);
	});

	it("allows the digest alone but warns — a catch-up regeneration is legitimate", () => {
		stage(DIGEST, "digest v2\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN");
	});

	/* Reports OK rather than saying nothing: every checker in the family ends on
	 * a summary line naming its outcome (mantahostels#155 — the checker
	 * family's exit-code and severity model — decision 4), and this one runs at
	 * .husky/pre-commit alongside check-user-settings-drift.js, which has always
	 * printed its own OK there. What matters at the hook is the exit code. */
	it("ignores commits that touch neither file", () => {
		stage("docs/other.md", "unrelated\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("FAIL");
		expect(r.stderr).not.toContain("WARN");
		expect(r.stderr).toContain("OK:");
	});

	it("is not fooled by an unstaged roadmap change in the working tree", () => {
		fs.writeFileSync(path.join(repo, HTML), "roadmap v2\n");
		stage("docs/other.md", "unrelated\n");
		expect(check().status).toBe(0);
	});
});
