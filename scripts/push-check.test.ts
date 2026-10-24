// @vitest-environment node
/*
 * Pins `npm run push:check`: its 0/1/2 verdict on whether green runs cover
 * every commit the next push sends, each suite answering for itself, and who it
 * names to answer for an uncovered commit (#814, #1213).
 *
 * Driven in-process over real throwaway repositories with a real `origin/main`,
 * because the range it judges is git's own merge-base, not a list a fixture
 * could hand it.
 *
 * Every session runs it before a push (docs/agents/guard-registry.md §Conventions): loosen a case
 * and a push goes out over commits no suite covered, or a session reruns the
 * whole suite for a neighbour's commits.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { storePath } from "./lib/test-pass-marker.js";

const req = createRequire(__filename);
const { projectSlug } = req("./lib/project-slug.js");
const { procStartOf } = req("./lib/arbiter-proc.js");

const SCRIPT = path.join(__dirname, "push-check.js");

const dirs: string[] = [];

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** A repository whose `origin/main` is its root commit. */
function repo(
	config: Record<string, unknown> = {
		commands: { test: "node scripts/run-vitest.js" },
	},
) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "push-check-")),
	);
	dirs.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "t");
	git(dir, "commit", "-q", "--allow-empty", "-m", "root");
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude/workflow-core.json"),
		JSON.stringify(config),
	);
	return dir;
}

function commitTouching(dir: string, ...paths: string[]) {
	for (const rel of paths) {
		fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), `${rel} ${Math.random()}\n`);
	}
	git(dir, "add", "--", ...paths);
	git(dir, "commit", "-q", "-m", "c");
	return git(dir, "rev-parse", "HEAD");
}

const writeStore = (dir: string, ...entries: unknown[]) =>
	fs.writeFileSync(
		storePath(dir),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);

const SCOPE = {
	modulesRun: 2,
	modulesTotal: 123,
	tests: 40,
	passed: 40,
	skipped: 0,
	failed: 0,
	nameFilter: null,
	fileFilters: [],
	changed: "x",
	admissible: true,
};

/** An admissible narrowed green on `sha`, selected for `paths` and reading them alone. */
const narrowedOn = (
	dir: string,
	sha: string,
	paths: string[],
	{ at, suite = "vitest" }: { at: string; suite?: string },
) => ({
	sha,
	at,
	suite,
	dirtyAtStart: false,
	foreign: [],
	scope: SCOPE,
	treeAtEnd: git(dir, "rev-parse", `${sha}^{tree}`),
	closure: paths,
	changedPaths: paths,
});

/* The arbiter's state lives under a config dir of the test's own, and the
 * pusher is session `me`. */
const home = (dir: string) => path.join(dir, ".claude-home");

const run = (cwd: string, env: Record<string, string | undefined> = {}) =>
	runInProcess(SCRIPT, [], {
		cwd,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: cwd,
			CLAUDE_CONFIG_DIR: home(cwd),
			CLAUDE_CODE_SESSION_ID: "me",
			...env,
		},
	});

/** `session`'s commit ledger, as `.husky/post-commit` writes it (#766). */
function ledger(dir: string, session: string, ...shas: string[]) {
	const file = path.join(
		home(dir),
		"projects",
		projectSlug(dir),
		"commits",
		`${session}.txt`,
	);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, shas.map((s) => `${s}\n`).join(""));
}

/** A sessions-registry entry on this process: live, or ended by a start time
 * that does not match. */
function register(dir: string, session: string, isLive: boolean) {
	const sessions = path.join(home(dir), "sessions");
	fs.mkdirSync(sessions, { recursive: true });
	fs.writeFileSync(
		path.join(sessions, `${session}.json`),
		JSON.stringify({
			pid: process.pid,
			sessionId: session,
			procStart: isLive ? procStartOf(process.pid) : "999999999",
			name: `${session}-name`,
		}),
	);
}

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("push:check", () => {
	it("exits 0 where greens from two sessions cover the range, naming both runs", () => {
		const dir = repo();
		const c1 = commitTouching(dir, "a.js");
		const c2 = commitTouching(dir, "b.js");
		writeStore(
			dir,
			narrowedOn(dir, c1, ["a.js"], { at: "RUN-A" }),
			narrowedOn(dir, c2, ["b.js"], { at: "RUN-B" }),
		);
		const r = run(dir);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`..${c2.slice(0, 12)} is covered — push.`);
		expect(r.stdout).toContain("RUN-A");
		expect(r.stdout).toContain("RUN-B");
	});

	it("exits 1 where a run is owed, naming each uncovered file, its commit and the command", () => {
		const dir = repo();
		const c1 = commitTouching(dir, "a.js");
		const c2 = commitTouching(dir, "b.js");
		writeStore(dir, narrowedOn(dir, c1, ["a.js"], { at: "RUN-A" }));
		const r = run(dir);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("NO GREEN VITEST RUN COVERS 1 FILE(S)");
		expect(r.stdout).toContain(`b.js — commit ${c2.slice(0, 12)}`);
		expect(r.stdout).toContain("Run `npm run test` for that, then push.");
	});

	it("exits 0 where main is at origin/main", () => {
		const dir = repo();
		const r = run(dir);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("nothing to push");
	});

	it("measures the range from origin/landing where the landing module is on (#2408)", () => {
		const dir = repo();
		commitTouching(dir, "a.js");
		git(dir, "update-ref", "refs/remotes/origin/landing", "HEAD");
		const r = run(dir, { WFC_MODULES: "suites,landing" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("its merge-base with origin/landing");
	});

	it("exits 2 where it cannot judge, saying why", () => {
		const dir = repo();
		commitTouching(dir, "a.js");
		git(dir, "update-ref", "-d", "refs/remotes/origin/main");
		const r = run(dir);
		expect(r.status).toBe(2);
		expect(r.stdout).toContain("could not judge");
		expect(r.stdout).toContain("origin/main");
	});

	it("prints the pre-push check's skip line and exits 0 where the suites module is off", () => {
		const dir = repo();
		commitTouching(dir, "a.js");
		const r = run(dir, { WFC_MODULES: undefined });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(
			'SKIP: module "suites" is off — .claude/workflow-core.json does not list it under "modules"\n',
		);
	});

	it("prints the same skip line where the tests are gated at commit", () => {
		const dir = repo({ commands: { test: "node --test" } });
		const r = run(dir);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("SKIP: commands.test is gated at commit");
	});

	it("answers each suite for itself: a vitest green never covers a pytest gap", () => {
		const dir = repo();
		const c1 = commitTouching(dir, "pipe.py");
		writeStore(dir, narrowedOn(dir, c1, ["pipe.py"], { at: "V" }));
		const r = run(dir);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("✓  VITEST");
		expect(r.stdout).toContain("NO GREEN PYTEST RUN COVERS 1 FILE(S)");
		writeStore(dir, narrowedOn(dir, c1, ["pipe.py"], { at: "V" }), {
			...narrowedOn(dir, c1, ["pipe.py"], { at: "P", suite: "pytest" }),
			/* pytest has no admissible tier: its green is a full run. */
			scope: { ...SCOPE, modulesRun: 123, changed: false, admissible: false },
			closure: "*",
		});
		expect(run(dir).status).toBe(0);
	});
});

describe("push:check names who answers for an uncovered commit (#1213)", () => {
	/** main at four commits, a.js–d.js, the first covered by a green. */
	function fourCommits() {
		const dir = repo();
		const shas = ["a.js", "b.js", "c.js", "d.js"].map((p) =>
			commitTouching(dir, p),
		);
		writeStore(
			dir,
			narrowedOn(dir, shas[0] as string, ["a.js"], { at: "RUN-A" }),
		);
		return { dir, shas: shas as [string, string, string, string] };
	}

	it("names a live neighbour that made the commit and gives no run command for it", () => {
		const { dir, shas } = fourCommits();
		ledger(dir, "me", shas[1], shas[2]);
		ledger(dir, "nb", shas[3]);
		register(dir, "nb", true);
		const r = run(dir);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain(
			`${shas[3].slice(0, 12)}: made by nb-name, still live — its own green covers them, so run nothing for them (#1213).`,
		);
		expect(r.stdout).toContain(
			"Run `npm run test` for the other 2 file(s), from your own commits or no session's, then push.",
		);
		expect(r.stdout).not.toContain("--adopt");
	});

	it("hands back one adoption run over every ended session's uncovered paths", () => {
		const { dir, shas } = fourCommits();
		ledger(dir, "gone1", shas[1]);
		ledger(dir, "gone2", shas[2], shas[3]);
		register(dir, "gone1", false);
		const r = run(dir);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain(
			`${shas[1].slice(0, 12)}, ${shas[2].slice(0, 12)}, ${shas[3].slice(0, 12)}: made by session(s) that have ended — adopt them with one run, then push (#1213):`,
		);
		expect(r.stdout).toMatch(
			/\n {5}npm run test -- --adopt [bcd]\.js [bcd]\.js [bcd]\.js\n/,
		);
		expect(r.stdout.match(/--adopt/g)).toHaveLength(1);
		expect(r.stdout).not.toContain("Run `npm run test`");
	});

	it("advises `npm run test` for unledgered commits and the pusher's own", () => {
		const { dir, shas } = fourCommits();
		ledger(dir, "me", shas[1]);
		const r = run(dir);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("Run `npm run test` for that, then push.");
		expect(r.stdout).not.toContain("#1213");
	});

	it("advises `npm run test` with no session id, whose bare run does not narrow (#1156)", () => {
		const { dir, shas } = fourCommits();
		ledger(dir, "gone", shas[3]);
		const r = run(dir, { CLAUDE_CODE_SESSION_ID: undefined });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("Run `npm run test` for that, then push.");
		expect(r.stdout).not.toContain("--adopt");
	});

	it("splits a mixed range three ways, shell-quoting an adopted path", () => {
		const dir = repo();
		const own = commitTouching(dir, "own.js");
		const theirs = commitTouching(dir, "theirs.js");
		const orphan = commitTouching(dir, "docs/an orphan.md");
		commitTouching(dir, "nobody.js");
		ledger(dir, "me", own);
		ledger(dir, "nb", theirs);
		ledger(dir, "gone", orphan);
		register(dir, "nb", true);
		register(dir, "gone", false);
		const r = run(dir);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("NO GREEN VITEST RUN COVERS 4 FILE(S)");
		expect(r.stdout).toContain("for the other 2 file(s)");
		expect(r.stdout).toContain(`${theirs.slice(0, 12)}: made by nb-name`);
		expect(r.stdout).toContain(
			"     npm run test -- --adopt 'docs/an orphan.md'\n",
		);
	});

	it("adopts where the sessions registry will not read, saying why", () => {
		const { dir, shas } = fourCommits();
		ledger(dir, "nb", shas[1], shas[2], shas[3]);
		fs.mkdirSync(home(dir), { recursive: true });
		fs.writeFileSync(path.join(home(dir), "sessions"), "not a directory");
		const r = run(dir);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain(
			"or that an unreadable sessions registry cannot call live",
		);
		expect(r.stdout).toContain("--adopt");
	});

	it("is covered once the adoption run's green lands, and only for the paths it named", () => {
		const { dir, shas } = fourCommits();
		ledger(dir, "gone", shas[1], shas[2], shas[3]);
		const adopted = (paths: string[]) => ({
			...narrowedOn(dir, shas[3], paths, { at: "ADOPT" }),
			scope: { ...SCOPE, changed: null },
			argv: ["--adopt", ...paths],
		});
		writeStore(
			dir,
			narrowedOn(dir, shas[0], ["a.js"], { at: "RUN-A" }),
			adopted(["b.js", "c.js"]),
		);
		const partial = run(dir);
		expect(partial.status).toBe(1);
		expect(partial.stdout).toContain("NO GREEN VITEST RUN COVERS 1 FILE(S)");
		expect(partial.stdout).toContain("npm run test -- --adopt d.js\n");
		writeStore(
			dir,
			narrowedOn(dir, shas[0], ["a.js"], { at: "RUN-A" }),
			adopted(["b.js", "c.js", "d.js"]),
		);
		expect(run(dir).status).toBe(0);
	});
});

describe("push:check names the tests to re-run where a green holds test by test (#1860)", () => {
	it("exits 1 naming only the test a neighbour's commit voided, with a command running it alone, then 0 once it is re-run", () => {
		const dir = repo();
		fs.mkdirSync(path.join(dir, "docs"));
		fs.writeFileSync(
			path.join(dir, "docs/test-read-edges.json"),
			JSON.stringify({
				edges: {
					"docs/wide-only.md": ["wide.test.ts"],
					"narrow.js": ["narrow.test.ts", "wide.test.ts"],
				},
			}),
		);
		commitTouching(
			dir,
			"narrow.js",
			"narrow.test.ts",
			"wide.test.ts",
			"docs/wide-only.md",
		);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "manifest");
		const base = git(dir, "rev-parse", "HEAD");
		const scratch = commitTouching(dir, "narrow.js");
		git(dir, "reset", "-q", "--hard", base);
		const theirs = commitTouching(dir, "docs/wide-only.md");
		git(dir, "update-ref", "refs/remotes/origin/main", theirs);
		git(dir, "checkout", "-q", scratch, "--", "narrow.js");
		git(dir, "commit", "-q", "-m", "mine");
		const mine = git(dir, "rev-parse", "HEAD");
		ledger(dir, "me", mine);
		const perTest = ({
			sha,
			tree,
			selected,
			changedPaths,
			at,
		}: {
			sha: string;
			tree: string;
			selected: string[];
			changedPaths: string[];
			at: string;
		}) => ({
			...narrowedOn(dir, sha, [], { at }),
			treeAtEnd: tree,
			closure: selected,
			selected,
			changedPaths,
			imports: Object.fromEntries(selected.map((t) => [t, []])),
			roots: [],
		});
		const session = perTest({
			sha: base,
			tree: git(dir, "rev-parse", `${scratch}^{tree}`),
			selected: ["narrow.test.ts", "wide.test.ts"],
			changedPaths: ["narrow.js"],
			at: "S",
		});
		writeStore(dir, session);
		const owed = run(dir);
		expect(owed.status).toBe(1);
		expect(owed.stdout).toContain(`narrow.js — commit ${mine.slice(0, 12)}`);
		expect(owed.stdout).toContain("npm run test -- --retest wide.test.ts");
		expect(owed.stdout).not.toContain("narrow.test.ts");
		const retest = perTest({
			sha: mine,
			tree: git(dir, "rev-parse", `${mine}^{tree}`),
			selected: ["wide.test.ts"],
			changedPaths: [],
			at: "R",
		});
		writeStore(dir, session, retest);
		expect(run(dir).status).toBe(0);
	});
});
