// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: `--against HEAD`'s shape, `--touched-by` and the landing gate.
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from check-guard-registry.test.ts, whose cost was pre-existing (#4294).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	ANCHORS,
	build,
	committedRepo,
	hooksWiring,
	ownClaims,
	region,
	removeTemps,
	reviewEnv,
	reviewIn,
	run,
	SELF_PLUGIN_HOOKS,
	TWO_GUARDS,
	templateOf,
	temps,
} from "./lib/guard-registry-testkit";
import { expectFixtureSupplies } from "./lib/precommit-gate-harness";
import { runInProcess } from "./lib/run-in-process";

afterEach(removeTemps);

describe("--against HEAD, the shape .husky/pre-commit's guard-registry gate runs (mantahostels#2077)", () => {
	/*
	 * Unlike every fixture above, this one is a real git repository: --against
	 * materialises both sides with `git archive`/`git write-tree`, so there has
	 * to be a HEAD to read and an index to diff it against. run()'s cwd,
	 * the fixture, is what makes those subprocesses see this repo rather than
	 * the one hosting the test.
	 */
	const kept =
		"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.";
	/*
	 * A BROKEN-CLAIM already at HEAD, not fixed by any case below. runAgainst()
	 * only materialises and diffs the HEAD baseline when the staged side ALREADY
	 * has a gating fault (lib/check.js's `if (gating.length || …)`) — a genuinely
	 * clean baseline would skip that whole path, and the "passes" case below
	 * would then go green whether or not the fixture's scripts/lib/ copy actually
	 * works. Carrying one inherited fault throughout forces the real
	 * materialise/diff to run in every case.
	 */
	const preexisting =
		"- A pre-existing gap. **Enforced** (#1): `scripts/guard-preexisting.sh` denies it.";
	const clean = region(kept, preexisting);
	const cleanFiles = {
		"scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n",
		[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
	};

	it("reports the fault a staged change adds over a clean HEAD", () => {
		const root = committedRepo({ claude: clean, files: cleanFiles });
		// Staged, not committed: HEAD stays the clean baseline reread() diffs
		// against. The new bullet goes INSIDE the region, not after its closing
		// delimiter — outside it, the scanner would never see it at all.
		fs.writeFileSync(
			path.join(root, "CLAUDE.md"),
			region(
				kept,
				preexisting,
				"- A new rule. **Enforced** (#2077): `scripts/guard-nope.sh` denies it.",
			),
		);
		execFileSync("git", ["add", "-A"], { cwd: root });

		const r = run(root, ["--against", "HEAD"]);
		expect(r.code).toBe(1);
		// Only the new BROKEN-CLAIM gates — the pre-existing one at HEAD is
		// inherited, and reports as a WARN rather than sitting in this list.
		expect(r.kinds).toEqual(["NEW-FAULT"]);
		// The underlying BROKEN-CLAIM's own message rides inside the NEW-FAULT
		// finding's message.
		expect(r.json.findings[0].message).toContain("does not exist");
	});

	it("passes when the staged tree adds no fault HEAD did not already carry", () => {
		const root = committedRepo({ claude: clean, files: cleanFiles });
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "note.md"), "unrelated\n");
		execFileSync("git", ["add", "-A"], { cwd: root });

		const r = run(root, ["--against", "HEAD"]);
		expect(r.code).toBe(0);
		expect(r.kinds).toEqual([]);
	});

	it("reports the materialised side's gitignore filter as not run, never FAILED OPEN (#710)", () => {
		const root = committedRepo({ claude: clean, files: cleanFiles });
		/* spawn-kept: a real fd — the re-exec streams its report to fd 2, which
		 * the in-process run() cannot capture. */
		const r = spawnSync(
			"node",
			[
				path.join(root, "scripts", "check-guard-registry.js"),
				"--against",
				"HEAD",
			],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: root,
					WFC_RULES_DIR: "",
					WFC_RULES_FALLBACK_DIR: "",
				},
			},
		);
		expect(r.status).toBe(0);
		expect(r.stderr + r.stdout).toContain("Gitignore filter: not run");
		expect(r.stderr + r.stdout).not.toContain("FAILED OPEN");
	});
});

/*
 * Pure bookkeeping, not a --against exercise: expectFixtureSupplies reads only
 * what `.husky/pre-commit`'s own fragment spawns as a runnable
 * (`node|bash|sh scripts/x.js`), which is `check-guard-registry.js` alone — the
 * checker's own `require()`s of lib/fault-profiles.js/lib/fault-diff.js are
 * invisible to that scan, so this asserts nothing about whether build() copies
 * them. It duplicates scripts/precommit-ci-gates.test.ts's identical assertion
 * for the same gate.
 */
describe("the pre-commit anchor's own supply set (mantahostels#2077)", () => {
	it("supplies exactly the script the pre-commit anchor invokes", () => {
		expectFixtureSupplies("scripts/check-guard-registry.js", [
			"scripts/check-guard-registry.js",
		]);
	});
});

describe("--touched-by <rev>, the post-commit notice (#2375)", () => {
	/* Two guards, one sourcing a library, anchored and committed, so each
	 * case's own commit is the one under judgement. */
	function anchoredRepo() {
		const root = committedRepo(TWO_GUARDS, (r) => reviewIn(r));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		/* null deletes the file; the commit takes `rel` and `also` alone. */
		const commit = (rel: string, body: string | null, also: string[] = []) => {
			if (body === null) fs.rmSync(path.join(root, rel));
			else fs.writeFileSync(path.join(root, rel), body);
			git("add", "-A", "--", rel, ...also);
			git("commit", "-qm", `change ${rel}`, "--", rel, ...also);
		};
		return { root, commit };
	}

	const touched = (root: string) =>
		run(root, ["--touched-by", "HEAD", "--root", root]);

	it("names a guard whose library the commit changed, through it, with its rule and the --review line", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/lib/deny.sh", "deny() { exit 0; }\n");
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => [w.kind, w.guard])).toEqual([
			["STALE-PROSE", "scripts/guard-branch.sh"],
		]);
		expect(r.report).toContain(
			"STALE-PROSE  scripts/guard-branch.sh (through scripts/lib/deny.sh)",
		);
		expect(r.report).toContain("rule:  CLAUDE.md:");
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
	});

	it("is OK where the commit re-anchored what it changed", () => {
		const { root, commit } = anchoredRepo();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-amend.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		reviewIn(root, ["scripts/guard-amend.sh"], ownClaims(root));
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n", [ANCHORS]);
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings).toEqual([]);
	});

	it("leaves a guard stale from before to the full run, where this commit did not touch it", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n");
		commit(
			"CLAUDE.md",
			`${fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")}\n`,
		);
		expect(touched(root).json.warnings).toEqual([]);
		expect(run(root).json.warnings.map((w) => w.guard)).toEqual([
			"scripts/guard-amend.sh",
		]);
	});

	it("names a guard the commit re-anchored on disk but left its anchor out of", () => {
		const { root, commit } = anchoredRepo();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-amend.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		reviewIn(root, ["scripts/guard-amend.sh"]);
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n");
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.guard)).toEqual([
			"scripts/guard-amend.sh",
		]);
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
		expect(r.report).toContain(`and commit ${ANCHORS}`);
	});

	it("names an anchored guard the commit deleted, and --review <path> drops its anchor", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/guard-amend.sh", null);
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => [w.kind, w.guard])).toEqual([
			["GUARD-GONE", "scripts/guard-amend.sh"],
		]);
		expect(r.report).toContain("rule:  CLAUDE.md:");
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
		expect(reviewIn(root, ["scripts/guard-amend.sh"])).toContain(
			"dropped scripts/guard-amend.sh — file does not exist",
		);
		expect(
			Object.keys(
				JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8")),
			),
		).toEqual(["scripts/guard-branch.sh"]);
	});

	it("is BROKEN, in the words .husky/post-commit prints aloud, past its git ceiling (#2210)", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n");
		const r = run(root, ["--touched-by", "HEAD", "--root", root], {
			cwd: root,
			env: { WFC_TOUCHED_BY_CEILING_MS: "1" },
		});
		expect(r.code).toBe(2);
		expect(JSON.stringify(r.json)).toMatch(
			/--touched-by passed its \S+ ceiling/,
		);
	});

	it("is BROKEN where the anchors the commit carries are not a JSON object", () => {
		const { root, commit } = anchoredRepo();
		commit(ANCHORS, "[]\n");
		const r = touched(root);
		expect(r.code).toBe(2);
		expect(JSON.stringify(r.json)).toContain(
			`${ANCHORS} at HEAD is not a JSON object; restore it, re-anchor with  node scripts/check-guard-registry.js --review`,
		);
	});

	it("names a guard through the library it runs from a variable (#2487)", () => {
		const guard = "scripts/guard-rewrite.sh";
		const lib = "scripts/lib/rewrite.js";
		const root = committedRepo({
			claude: region(
				`- One rewrite per dispatch. **Enforced** (#2013): \`${guard}\` rewrites it.`,
			),
			files: {
				// The shape: lib="$here/lib/x.js" … node "$lib".
				[guard]:
					'#!/bin/bash\nhere="$(dirname "$0")"\nlib="$here/lib/rewrite.js"\nnode "$lib"\n',
				[lib]: "module.exports = {};\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(guard),
			},
		});
		reviewIn(root);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		git("add", "--", ANCHORS);
		git("commit", "-qm", "anchor", "--", ANCHORS);
		fs.appendFileSync(path.join(root, lib), "\n// changed\n");
		git("commit", "-qm", "change the lib", "--", lib);

		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => [w.kind, w.guard])).toEqual([
			["STALE-PROSE", guard],
		]);
		expect(r.report).toContain(`STALE-PROSE  ${guard} (through ${lib})`);
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
	});

	it("refuses --review beside it", () => {
		const root = build({ claude: region() });
		const r = runInProcess(
			path.join(root, "scripts", "check-guard-registry.js"),
			["--touched-by", "HEAD", "--review"],
			{ env: reviewEnv(root), cwd: root },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("does not combine with --review");
	});
});

describe("scripts/landing-registry-gate.js judges a push to landing on landing's tree (#3074)", () => {
	/* The #2617 template: two guards anchored and committed at X. A real
	 * spawn, since the gate streams the checker's report to fd 2. */
	let template = "";
	const claims = {
		CLAUDE_CODE_SESSION_ID: "self-session",
		WFC_ANCHOR_LOCKS: "[]",
	};
	beforeAll(() => {
		const built = committedRepo(TWO_GUARDS, (r) => {
			reviewIn(r, [], claims);
			fs.copyFileSync(
				path.join(__dirname, "landing-registry-gate.js"),
				path.join(r, "scripts", "landing-registry-gate.js"),
			);
		});
		temps.splice(temps.indexOf(built), 1);
		template = built;
	});
	afterAll(() => fs.rmSync(template, { recursive: true, force: true }));

	function repo() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
		temps.push(root);
		fs.cpSync(template, root, { recursive: true });
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		const commit = (files: Record<string, string>, msg: string) => {
			for (const [rel, body] of Object.entries(files))
				fs.writeFileSync(path.join(root, rel), body);
			git("add", "-A");
			git("commit", "-qm", msg);
			return git("rev-parse", "HEAD");
		};
		const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
		return { root, git, commit, read };
	}

	const push = (
		root: string,
		{ sha, tip, to = "landing" }: { sha: string; tip: string; to?: string },
		modules = "landing",
		locks: unknown[] = [],
	) =>
		/* spawn-kept: a real fd — the gate hands the checker it spawns the real
		 * fd 2, where these cases read its report. */
		spawnSync(
			"node",
			[path.join(root, "scripts", "landing-registry-gate.js")],
			{
				cwd: root,
				encoding: "utf8",
				input: `refs/heads/main ${sha} refs/heads/${to} ${tip}\n`,
				env: {
					...process.env,
					...claims,
					WFC_ANCHOR_LOCKS: JSON.stringify(locks),
					CLAUDE_PROJECT_DIR: root,
					WFC_RULES_DIR: "",
					WFC_RULES_FALLBACK_DIR: "",
					WFC_MODULES: modules,
				},
			},
		);
	const preCommit = (root: string) =>
		run(root, ["--against", "HEAD"], { env: claims });

	it("refuses an anchors write computed on base A and committed onto base B, which A's pre-commit passes, naming the row and the re-anchor command", () => {
		const { root, git, commit, read } = repo();
		const x = git("rev-parse", "HEAD");
		// Base A: X with guard-branch's library changed and the whole file re-anchored.
		fs.writeFileSync(
			path.join(root, "scripts/lib/deny.sh"),
			"deny() { exit 0; }\n",
		);
		reviewIn(root, [], ownClaims(root));
		git("add", "-A");
		expect(preCommit(root).code).toBe(0);
		const anchorsOnA = read(ANCHORS);
		git("reset", "-q", "--hard", x);
		// Base B, landing's tip: guard-amend changed and re-anchored there.
		commit({ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" }, "amend");
		reviewIn(root, ["scripts/guard-amend.sh"], claims);
		const tip = commit({}, "re-anchor amend");
		const sha = commit(
			{
				[ANCHORS]: anchorsOnA,
				"scripts/lib/deny.sh": "deny() { exit 0; }\n",
			},
			"A's re-anchor onto B",
		);
		const r = push(root, { sha, tip });
		expect(r.status, r.stderr).toBe(2);
		expect(r.stderr).toContain("STALE-PROSE  scripts/guard-amend.sh");
		expect(r.stderr).toContain(
			"node scripts/check-guard-registry.js --review scripts/guard-amend.sh",
		);
		expect(r.stderr).toContain(`git worktree add --detach <dir> ${sha}`);
		expect(r.stderr).toContain(`pre-push: refused — ${sha}`);
	});

	it("refuses the twin of a commit that moved a row already stale on a diverged branch, onto a landing where it was fresh, naming the row and the re-anchor command", () => {
		const { root, git, commit } = repo();
		const tip = git("rev-parse", "HEAD");
		// The diverged local branch: guard-branch stale there already.
		commit(
			{
				"scripts/guard-branch.sh":
					'#!/bin/sh\nsource "$(dirname "$0")/lib/deny.sh"\nexit 3\n',
			},
			"diverge",
		);
		fs.writeFileSync(
			path.join(root, "scripts/lib/deny.sh"),
			"deny() { exit 0; }\n",
		);
		git("add", "-A");
		expect(preCommit(root).code).toBe(0);
		const local = commit({}, "move a row stale here");
		git("checkout", "-q", "-b", "landing", tip);
		git("cherry-pick", local);
		const sha = git("rev-parse", "HEAD");
		const r = push(root, { sha, tip });
		expect(r.status, r.stderr).toBe(2);
		expect(r.stderr).toContain("STALE-PROSE  scripts/guard-branch.sh");
		expect(r.stderr).toContain(
			"node scripts/check-guard-registry.js --review scripts/guard-branch.sh",
		);
	});

	it("refuses a row whose guard a live neighbour holds dirty in the shared tree, whose bytes the push does not carry", () => {
		const { root, git, commit } = repo();
		const tip = git("rev-parse", "HEAD");
		const sha = commit(
			{ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" },
			"stale",
		);
		fs.writeFileSync(
			path.join(root, "scripts/guard-amend.sh"),
			"#!/bin/sh\nexit 4\n",
		);
		const r = push(root, { sha, tip }, "landing", [
			{
				path: "scripts/guard-amend.sh",
				sessionId: "neighbour-session",
				pid: 4242,
				alive: true,
				claimedAt: new Date().toISOString(),
			},
		]);
		expect(r.status, r.stderr).toBe(2);
		expect(r.stderr).not.toContain("not refusing");
		expect(r.stderr).toContain("STALE-PROSE  scripts/guard-amend.sh");
	});

	it("passes a push whose tree carries only the stale rows landing's tip already has", () => {
		const { root, commit } = repo();
		const tip = commit(
			{ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" },
			"stale on landing",
		);
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		const sha = commit({ "docs/note.md": "unrelated\n" }, "unrelated");
		const r = push(root, { sha, tip });
		expect(r.status, r.stderr).toBe(0);
	});

	it("does nothing with the landing module off", () => {
		const { root, git, commit } = repo();
		const tip = git("rev-parse", "HEAD");
		const sha = commit(
			{ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" },
			"stale",
		);
		const r = push(root, { sha, tip }, "suites");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("passes, printed, a push that creates landing", () => {
		const { root, commit } = repo();
		const sha = commit(
			{ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" },
			"stale",
		);
		const r = push(root, { sha, tip: "0".repeat(40) });
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toContain("creates landing");
	});
});

describe("scripts/landing-registry-gate.js judges a push to a queue ref on main's tree (#4458)", () => {
	const claims = {
		CLAUDE_CODE_SESSION_ID: "self-session",
		WFC_ANCHOR_LOCKS: "[]",
	};
	const repo = templateOf(() =>
		committedRepo(TWO_GUARDS, (r) => {
			reviewIn(r, [], claims);
			fs.copyFileSync(
				path.join(__dirname, "landing-registry-gate.js"),
				path.join(r, "scripts", "landing-registry-gate.js"),
			);
		}),
	);
	const Zero = "0".repeat(40);

	/** The fixture with `stale` committed on its first commit, which
	 * `origin/main` names unless `main` is false. */
	function staleOnTip({ main = true } = {}) {
		const root = repo();
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
		const tip = git("rev-parse", "HEAD");
		if (main) git("update-ref", "refs/remotes/origin/main", tip);
		fs.writeFileSync(
			path.join(root, "scripts/guard-amend.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		git("add", "-A");
		git("commit", "-qm", "stale");
		return { root, tip, sha: git("rev-parse", "HEAD") };
	}

	const push = (
		root: string,
		line: string,
		inherited: Record<string, string> = {},
	) =>
		/* spawn-kept: a real fd — the gate hands the checker it spawns the real
		 * fd 2, where these cases read its report. */
		spawnSync(
			"node",
			[path.join(root, "scripts", "landing-registry-gate.js")],
			{
				cwd: root,
				encoding: "utf8",
				input: `${line}\n`,
				env: {
					...process.env,
					...claims,
					CLAUDE_PROJECT_DIR: root,
					WFC_RULES_DIR: "",
					WFC_RULES_FALLBACK_DIR: "",
					WFC_MODULES: "landing",
					...inherited,
				},
			},
		);

	it("refuses a push creating a queue ref whose tree expires a row fresh on origin/main's tip, naming main", () => {
		const { root, tip, sha } = staleOnTip();
		const r = push(root, `HEAD ${sha} refs/heads/queue/wt-a ${Zero}`);
		expect(r.status, r.stderr).toBe(2);
		expect(r.stderr).toContain("STALE-PROSE  scripts/guard-amend.sh");
		expect(r.stderr).toContain(
			`pre-push: refused — ${sha} expires guard-registry row(s) on main's tree at ${tip}`,
		);
	});

	it("judges a fast-forward of a queue ref against main's tip, not the ref's own", () => {
		const { root, tip, sha } = staleOnTip();
		/* The ref's remote sha already carries the stale row; main's does not. */
		const r = push(root, `HEAD ${sha} refs/heads/queue/wt-a ${sha}`);
		expect(r.status, r.stderr).toBe(2);
		expect(r.stderr).toContain(`on main's tree at ${tip},`);
	});

	it("refuses a queue push's fault under an inherited lander revert and revert base that carry it", () => {
		const { root, tip, sha } = staleOnTip();
		/* The pushed sha carries the stale row itself, so as a revert base it
		 * would excuse the fault. */
		const r = push(root, `HEAD ${sha} refs/heads/queue/wt-a ${Zero}`, {
			WFC_LANDER_REVERT_BASE: sha,
			WFC_LANDER_REVERT: sha,
		});
		expect(r.status, r.stderr).toBe(2);
		expect(r.stderr).toContain(`on main's tree at ${tip},`);
	});

	it("passes, printed, a queue push in a clone holding no origin/main", () => {
		const { root, sha } = staleOnTip({ main: false });
		const r = push(root, `HEAD ${sha} refs/heads/queue/wt-a ${Zero}`);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toContain("holds no origin/main to judge queue/wt-a");
	});

	it.each([
		"refs/heads/lander/batch",
		"refs/heads/dropped/wt-a",
		"refs/heads/queue",
	])("leaves a push to %s unjudged", (ref) => {
		const { root, sha } = staleOnTip();
		const r = push(root, `HEAD ${sha} ${ref} ${Zero}`);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toBe("");
	});

	it("leaves a queue ref's deletion unjudged", () => {
		const { root, sha } = staleOnTip();
		const r = push(root, `(delete) ${Zero} refs/heads/queue/wt-a ${sha}`);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toBe("");
	});
});
