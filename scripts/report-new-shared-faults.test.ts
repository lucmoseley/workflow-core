// @vitest-environment node
/*
 * report-new-shared-faults.js (mantahostels#1823) — the sha-vs-parent generalisation of
 * checker-new-faults.js's staged-vs-HEAD set difference (mantahostels#1753).
 *
 * The program is run in-process against throwaway git repos built by
 * newRepo(), its checker table replaced by STUB checkers (WFC_SHARED_FAULT_CHECKERS)
 * whose envelope varies by commit — the fixture repo's own history supplies
 * the two sides, which is what proves the sha and its parent (not some other
 * pair) were the ones actually compared. The guard-registry cases' fixture
 * repos carry no docs/doc-map.md, so the doc-map limb stands down in them.
 *
 * check-doc-map.js (mantahostels#1824's extension) is tested against the real
 * checker in its own file, report-new-shared-faults-doc-map.test.ts.
 *
 * It runs from `.husky/post-commit` after every commit, the notice of faults a
 * commit added to the whole-repo checks: loosen a case and a new fault goes
 * unannounced, or a session is blamed for one it inherited.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	hookEnv,
	linkedCommit,
	plantSentinel,
	quietPrograms,
	REPLAY_SENTINELS,
	type Result,
	rowOf,
	runPostCommit,
	STEPS,
	stubProgram,
} from "./lib/post-commit-testkit";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import { commitOverSequencer } from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";
import {
	CHECKERS_ENV,
	lines,
	run,
	SCRIPT,
} from "./lib/report-new-shared-faults-testkit";
import { runInProcess } from "./lib/run-in-process";
import { NOTICES } from "./lib/shared-fault-notices";

const temps = registerTempCleanup();

const REPO_ROOT = path.join(__dirname, "..");

/** Runs the real CLI against THIS repo's own git history;
 * the cases below pick refs whose answer cannot drift with this
 * repo's ongoing history (a bad ref, and the repo's one root commit).
 * isolation-exempt: hostRoot() pinned to this real repo is the point — the
 * cases picked (a bad ref, the root commit) read no live state, so nothing
 * a CLAUDE_PROJECT_DIR redirect would protect is ever touched (#160). */
function runCli(...args: string[]) {
	const r = runInProcess(SCRIPT, args, {
		cwd: REPO_ROOT,
		env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },
	});
	return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A stub checker.js: prints <root>/envelope.json verbatim, or `{"findings":[]}`
 * where the commit being read carries none. */
function writeStubChecker(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-stub-checker-"));
	temps.push(dir);
	const script = path.join(dir, "checker.js");
	fs.writeFileSync(
		script,
		`
const fs = require("node:fs");
const path = require("node:path");
const rootIdx = process.argv.indexOf("--root");
const root = process.argv[rootIdx + 1];
const envPath = path.join(root, "envelope.json");
process.stdout.write(fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : '{"findings":[]}');
process.exit(0);
`,
	);
	return script;
}

/** A stub checker.js that always fails to produce a usable envelope. */
function writeBrokenChecker(mode: "throw" | "garbage"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-stub-broken-"));
	temps.push(dir);
	const script = path.join(dir, "checker.js");
	fs.writeFileSync(
		script,
		mode === "throw"
			? `throw new Error("stub checker exploded");\n`
			: `process.stdout.write("not json {");\nprocess.exit(0);\n`,
	);
	return script;
}

const fail = (over: Record<string, unknown> = {}) => ({
	severity: "FAIL",
	tag: "UNPRINTED-RULE",
	message: `${over.file ?? "x.txt"}:1 — no wired emitter prints this fragment.`,
	kind: "UNPRINTED-RULE",
	file: "x.txt",
	rule: 'rule id "x"',
	...over,
});

function commitEnvelope(
	repo: ReturnType<typeof newRepo>,
	envelope: unknown,
	message: string,
): string {
	fs.writeFileSync(
		path.join(repo.root, "envelope.json"),
		JSON.stringify(envelope),
	);
	repo.git("add", "-A");
	repo.git("commit", "-q", "-m", message);
	return repo.git("rev-parse", "HEAD").toString().trim();
}

describe("report-new-shared-faults", () => {
	it("reports a fault the commit added and not one it inherited", () => {
		const repo = newRepo("report-new-shared-faults-added-", temps);
		commitEnvelope(repo, { findings: [fail()] }, "base");
		const child = commitEnvelope(
			repo,
			{ findings: [fail(), fail({ file: "y.txt", rule: 'rule id "y"' })] },
			"adds y",
		);

		const stub = writeStubChecker();
		const { code, out, err } = run(child, {
			checkers: { "guard-registry": stub },
			cwd: repo.root,
		});

		expect(err).toEqual([]);
		expect(code).toBe(1);
		const text = out.join("\n");
		expect(text).toContain("y.txt");
		expect(text).not.toContain("x.txt:1");
	});

	it("stays silent on a fault the commit only inherited", () => {
		const repo = newRepo("report-new-shared-faults-inherited-", temps);
		commitEnvelope(repo, { findings: [fail()] }, "base");
		fs.writeFileSync(path.join(repo.root, "unrelated.txt"), "x");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "unrelated change");
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		const stub = writeStubChecker();
		const { code, out, err } = run(child, {
			checkers: { "guard-registry": stub },
			cwd: repo.root,
		});

		expect(err).toEqual([]);
		expect(out).toEqual([]);
		expect(code).toBe(0);
	});

	it("reports the one it added, not the one it repaired", () => {
		const repo = newRepo("report-new-shared-faults-mixed-", temps);
		commitEnvelope(
			repo,
			{
				findings: [
					fail({ file: "a.txt", rule: 'rule id "a"' }),
					fail({ file: "b.txt", rule: 'rule id "b"' }),
				],
			},
			"base",
		);
		const child = commitEnvelope(
			repo,
			{
				// a.txt repaired (dropped), b.txt inherited, c.txt added
				findings: [
					fail({ file: "b.txt", rule: 'rule id "b"' }),
					fail({ file: "c.txt", rule: 'rule id "c"' }),
				],
			},
			"repairs a, adds c",
		);

		const stub = writeStubChecker();
		const { code, out } = run(child, {
			checkers: { "guard-registry": stub },
			cwd: repo.root,
		});

		expect(code).toBe(1);
		const text = out.join("\n");
		expect(text).toContain("c.txt");
		expect(text).not.toContain("a.txt");
		expect(text).not.toContain("b.txt");
	});

	it("names what could not be read where the checker throws", () => {
		const repo = newRepo("report-new-shared-faults-throws-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const child = commitEnvelope(repo, { findings: [fail()] }, "adds a fault");

		const broken = writeBrokenChecker("throw");
		const { code, out, err } = run(child, {
			checkers: { "guard-registry": broken },
			cwd: repo.root,
		});

		expect(code).toBe(2);
		expect(out).toEqual([]);
		expect(err.join("\n")).toContain("guard-registry");
	});

	it("names what could not be read where the checker emits invalid JSON", () => {
		const repo = newRepo("report-new-shared-faults-garbage-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const child = commitEnvelope(repo, { findings: [fail()] }, "adds a fault");

		const broken = writeBrokenChecker("garbage");
		const { code, out, err } = run(child, {
			checkers: { "guard-registry": broken },
			cwd: repo.root,
		});

		expect(code).toBe(2);
		expect(out).toEqual([]);
		expect(err.join("\n")).toMatch(/invalid --json/);
	});

	it("runs each checker on the parent as the baseline side and on the commit as the index side (#4297)", () => {
		const repo = newRepo("report-new-shared-faults-side-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const child = commitEnvelope(
			repo,
			{ findings: [], side: "commit" },
			"marks the commit's tree",
		);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-side-checker-"));
		temps.push(dir);
		const checker = path.join(dir, "checker.js");
		fs.writeFileSync(
			checker,
			`
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[process.argv.indexOf("--root") + 1];
const tree = JSON.parse(fs.readFileSync(path.join(root, "envelope.json"), "utf8")).side ?? "parent";
fs.appendFileSync(${JSON.stringify(path.join(dir, "sides"))}, tree + " " + process.env.WFC_CHECK_SIDE + "\\n");
process.stdout.write('{"findings":[]}');
`,
		);

		const { code, err } = run(child, {
			checkers: { "guard-registry": checker, "host-root": checker },
			cwd: repo.root,
		});

		expect(err).toEqual([]);
		expect(code).toBe(0);
		expect(
			lines(fs.readFileSync(path.join(dir, "sides"), "utf8")).sort(),
		).toEqual([
			"commit index",
			"commit index",
			"parent baseline",
			"parent baseline",
		]);
	});

	it("exits 2 naming the failure, never 1, where the checkers' runs as a whole cannot be read", () => {
		const repo = newRepo("report-new-shared-faults-runs-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const child = commitEnvelope(repo, { findings: [fail()] }, "adds x");
		/* Each side's output under the per-child cap, the four together past
		 * the 64 MB the runs' combined result may take (lib/child-buffer.js). */
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-big-checker-"));
		temps.push(dir);
		const checker = path.join(dir, "checker.js");
		fs.writeFileSync(
			checker,
			`process.stdout.write('{"findings":[],"pad":"' + "x".repeat(17e6) + '"}');\n`,
		);

		const { code, out, err } = run(child, {
			checkers: { "guard-registry": checker, "host-root": checker },
			cwd: repo.root,
		});

		expect(code).toBe(2);
		expect(out).toEqual([]);
		expect(err).toEqual([
			expect.stringMatching(
				/^report-new-shared-faults: could not run the checkers — /,
			),
		]);
	});

	it("reports a root commit as having nothing to compare, never every fault as new", () => {
		const repo = newRepo("report-new-shared-faults-root-", temps);
		const root = commitEnvelope(
			repo,
			{ findings: [fail()] },
			"the only commit",
		);

		// A checker that would throw if it were ever invoked: proves the root
		// commit short-circuits before either side is read.
		const broken = writeBrokenChecker("throw");
		const { code, out, err } = run(root, {
			checkers: { "guard-registry": broken },
			cwd: repo.root,
		});

		expect(code).toBe(0);
		expect(err).toEqual([]);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("no parent");
	});

	it("compares a merge commit against its first parent only, and says so", () => {
		const repo = newRepo("report-new-shared-faults-merge-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const defaultBranch = repo
			.git("rev-parse", "--abbrev-ref", "HEAD")
			.toString()
			.trim();

		// topic is the ONLY branch that ever touches envelope.json, so a trivial
		// merge carries topic's fault into the merge tree wholesale — a diff
		// against the WRONG parent (topic) would then read as silent. Only a
		// diff against the RIGHT parent (main, which never touched the file)
		// reports the fault, which is what makes this test able to fail.
		repo.git("checkout", "-q", "-b", "topic");
		commitEnvelope(
			repo,
			{ findings: [fail({ file: "topic.txt", rule: 'rule id "topic"' })] },
			"topic adds a fault",
		);
		const topicTip = repo.git("rev-parse", "HEAD").toString().trim();

		repo.git("checkout", "-q", defaultBranch);
		fs.writeFileSync(path.join(repo.root, "main-only.txt"), "y");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "main work");
		const mainTip = repo.git("rev-parse", "HEAD").toString().trim();

		repo.git("merge", "-q", "--no-ff", "topic", "-m", "merge topic");
		const merge = repo.git("rev-parse", "HEAD").toString().trim();

		const stub = writeStubChecker();
		const { code, out, err } = run(merge, {
			checkers: { "guard-registry": stub },
			cwd: repo.root,
		});

		expect(err).toEqual([]);
		const text = out.join("\n");
		expect(text).toContain("is a merge");
		expect(text).toContain(mainTip);
		expect(text).not.toContain(topicTip);
		expect(code).toBe(1);
		expect(text).toContain("topic.txt");
	});

	it("refuses (code 2) over reporting faults where one profile's checker is unreadable, even when another profile found a real fault", () => {
		const repo = newRepo("report-new-shared-faults-priority-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const child = commitEnvelope(repo, { findings: [fail()] }, "adds a fault");

		const stub = writeStubChecker();
		const broken = writeBrokenChecker("throw");
		const { code, out, err } = run(child, {
			checkers: { "guard-registry": stub, "guard-test-isolation": broken },
			cwd: repo.root,
		});

		// the readable profile's fault still prints — it just isn't the story
		// the exit code tells, per report-new-shared-faults.js's own comment on
		// this precedence.
		expect(out.join("\n")).toContain("x.txt");
		expect(err.join("\n")).toContain("guard-test-isolation");
		expect(code).toBe(2);
	});

	it("as a subprocess: refuses a ref that does not resolve, naming it", () => {
		const { code, out, err } = runCli("not-a-real-ref-xyz");

		expect(code).toBe(2);
		expect(out).toBe("");
		expect(err).toContain("not-a-real-ref-xyz");
		expect(err).toContain("does not resolve to a commit");
	});

	it("as a subprocess: reports this repo's own root commit as having nothing to compare", () => {
		const root = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		}).trim();
		// This repo has exactly one root commit; two would make `root` a
		// multi-line list and this ref lookup meaningless.
		expect(root.split("\n")).toHaveLength(1);

		const { code, out, err } = runCli(root);

		expect(code).toBe(0);
		expect(err).toBe("");
		expect(out.trim()).toContain("no parent");
		expect(out.trim()).toContain(root);
	});

	it("pins the real check-guard-registry.js --json envelope shape", () => {
		const envelope = JSON.parse(
			runInProcess(path.join(__dirname, "check-guard-registry.js"), [
				"--root",
				REPO_ROOT,
				"--json",
			]).stdout,
		);

		expect(envelope).toMatchObject({ checker: "guard-registry" });
		expect(Array.isArray((envelope as { findings: unknown }).findings)).toBe(
			true,
		);
	});
});

/*
 * The notice's SHAPE (mantahostels#1825, mantahostels#1750).
 *
 * Every case here drives `run()` with the same stub checker the block at the
 * top of this file uses, because the framing is written from the diff's result
 * and not from any checker's own text.
 */
describe("the notice the session reads", () => {
	/** A repo whose child commit adds exactly one guard-registry fault. */
	function repoWithOneAddedFault(prefix: string) {
		const repo = newRepo(prefix, temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const child = commitEnvelope(
			repo,
			{ findings: [fail({ file: "CLAUDE.md", rule: 'rule id "x"' })] },
			"adds one fault",
		);
		return { repo, child };
	}

	it("names the sha, the checker, the fault and what the red costs, and says it never blocks", () => {
		const { repo, child } = repoWithOneAddedFault("report-notice-shape-");

		const { code, out } = run(child, {
			checkers: { "guard-registry": writeStubChecker() },
			cwd: repo.root,
		});
		const text = out.join("\n");

		expect(code).toBe(1);
		expect(text).toContain(child);
		expect(text).toContain("guard-registry");
		expect(text).toContain("CLAUDE.md");
		expect(text).toContain("warns every other session's commit touching docs/");
		expect(text).toContain("REPORTS and never blocks");
		// The route in, so the one-line summary is not a dead end (story 10).
		expect(text).toContain("In full, WARNs and context included: node");
		expect(text).toContain(
			`Re-read this notice after a later commit: node scripts/report-new-shared-faults.js ${child}`,
		);
	});

	it("writes no framing at all on a clean commit", () => {
		const repo = newRepo("report-notice-clean-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		fs.writeFileSync(path.join(repo.root, "unrelated.txt"), "x");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "clean");
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		const { code, out, err } = run(child, {
			checkers: { "guard-registry": writeStubChecker() },
			cwd: repo.root,
		});

		expect(out).toEqual([]);
		expect(err).toEqual([]);
		expect(code).toBe(0);
	});

	it("degrades to the one merge line, unframed, on a merge that added nothing", () => {
		const repo = newRepo("report-notice-clean-merge-", temps);
		commitEnvelope(repo, { findings: [] }, "base");
		const defaultBranch = repo
			.git("rev-parse", "--abbrev-ref", "HEAD")
			.toString()
			.trim();

		repo.git("checkout", "-q", "-b", "topic");
		fs.writeFileSync(path.join(repo.root, "topic-only.txt"), "t");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "topic work, no fault");

		repo.git("checkout", "-q", defaultBranch);
		fs.writeFileSync(path.join(repo.root, "main-only.txt"), "m");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "main work");
		repo.git("merge", "-q", "--no-ff", "topic", "-m", "merge topic");
		const merge = repo.git("rev-parse", "HEAD").toString().trim();

		const { code, out } = run(merge, {
			checkers: { "guard-registry": writeStubChecker() },
			cwd: repo.root,
		});

		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("is a merge");
		expect(out.join("\n")).not.toContain("REPORTS and never blocks");
	});

	/* The route in must go somewhere the notice has not already been. Re-running
	 * this script on the same sha reprints the same bytes, so `full` names the
	 * checker itself. */
	it("offers a route in that exists and is not a reprint of itself", () => {
		const { PROFILES } = require("./lib/fault-profiles.js") as {
			PROFILES: Record<string, unknown>;
		};
		const { repo, child } = repoWithOneAddedFault("report-notice-route-");
		const stub = writeStubChecker();
		const { out } = run(child, {
			checkers: Object.fromEntries(
				Object.keys(PROFILES)
					.filter((p) => p !== "doc-map")
					.map((p) => [p, stub]),
			),
			cwd: repo.root,
		});

		const routes = out.flatMap(
			(l) => l.match(/In full, WARNs and context included: (.*)$/)?.[1] ?? [],
		);
		expect(routes).toHaveLength(Object.keys(PROFILES).length - 1);
		for (const full of routes) {
			const script = full.replace(/^node /, "");
			expect(
				fs.existsSync(path.join(REPO_ROOT, script)),
				`a route in names ${script}, which does not exist`,
			).toBe(true);
			expect(full).not.toContain("report-new-shared-faults");
		}
	});

	/* Its own table, not a stub one: a checker it reads that the diff has no
	 * profile for would throw after every commit. */
	it("reads every checker in its real table as a profile the diff knows", () => {
		const repo = newRepo("report-notice-real-table-", temps);
		fs.writeFileSync(path.join(repo.root, "a.txt"), "a");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "base");
		fs.writeFileSync(path.join(repo.root, "a.txt"), "b");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "edit");
		const env: Record<string, string | undefined> = {
			...process.env,
			CLAUDE_PROJECT_DIR: repo.root,
		};
		delete env[CHECKERS_ENV];

		const r = runInProcess(SCRIPT, ["HEAD"], { cwd: repo.root, env });

		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	}, 30_000);
});

/**
 * The real notice table, not a stub one: a profile with no row goes
 * unannounced (#4246), and a row's gate claim must be the flag the hook, or
 * its dispatcher's row, runs its checker with (#4221). doc-map's own row
 * compares staged with HEAD itself, running its checker with no flag.
 */
describe("lib/shared-fault-notices.js's NOTICES", () => {
	const OwnGateBlock = new Set(["doc-map"]);
	const hook = fs.readFileSync(
		path.join(REPO_ROOT, ".husky", "pre-commit"),
		"utf8",
	);

	it("has a row for exactly the profiles lib/fault-profiles.js declares", () => {
		const { PROFILES } = require("./lib/fault-profiles.js") as {
			PROFILES: Record<string, unknown>;
		};
		expect(Object.keys(NOTICES).sort()).toEqual(Object.keys(PROFILES).sort());
	});

	const cases = Object.entries(NOTICES).map(([profile, { script, gate }]) => {
		const name = path.basename(script);
		/* A dispatcher row's run is its args (#5172); an own-gate profile's row
		 * is the one it names. */
		const row =
			GATES.find((g) => g.script === `scripts/${name}`) ??
			(OwnGateBlock.has(profile)
				? GATES.find((g) => g.id === profile)
				: undefined);
		const runs = row
			? [row.args.join(" ")]
			: hook
					.split("\n")
					.filter(
						(l) =>
							!l.trimStart().startsWith("#") && l.includes(`scripts/${name}`),
					);
		return { profile, gate, name, runs };
	});

	it.each(cases)(
		"$profile's gate is the flag the hook runs $name with",
		({ profile, gate, runs }) => {
			expect(runs.length).toBeGreaterThan(0);
			if (OwnGateBlock.has(profile)) {
				expect(gate).toBe("against");
				return;
			}
			const flags = new Set(
				runs.flatMap((l) => l.match(/--(against|index)\b/)?.[1] ?? []),
			);
			expect([...flags]).toEqual([gate]);
		},
	);
});

/*
 * THE POST-COMMIT STEP (mantahostels#1825, #5208): lib/post-commit-steps.js's
 * newSharedFaultsRow, and its new-shared-faults row in lib/post-commit-rows.js
 * run through dispatch() on the real route where the gating is the point.
 *
 * The cases stand a program in for this one through its PROGRAM export
 * (lib/post-commit-testkit.ts): what is under test is the step's guarding,
 * not the program's answer — but for the linked-worktree case, which runs the
 * real one.
 */
describe(".husky/post-commit's fault-notice step", () => {
	/** A throwaway repo with one commit. */
	function hookRepo(prefix: string) {
		const repo = newRepo(prefix, temps);
		fs.writeFileSync(path.join(repo.root, "a.txt"), "a");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "one");
		return repo;
	}

	const Notice: Result = { exit: 1, stdout: "a fault notice\n", stderr: "" };

	/** The step on `cwd`, the program answering `answer`. */
	function runStep(cwd: string, answer: Result, env: NodeJS.ProcessEnv = {}) {
		const program = stubProgram("report-new-shared-faults.js", () => answer);
		const r = STEPS.newSharedFaultsRow({ cwd, env: hookEnv(env) });
		// Exit 0 whatever the program did — git ignores post-commit's status.
		expect(r.exit).toBe(0);
		return { ...r, program };
	}

	/** The whole registry on `cwd`, the program printing NOTICE, the rest quiet. */
	async function runRegistry(cwd: string) {
		quietPrograms();
		stubProgram("report-new-shared-faults.js", () => Notice);
		const r = await runPostCommit({ cwd, env: hookEnv() });
		expect(r.exit).toBe(0);
		return r;
	}

	it("is wired: its registry row runs it, standing down on the post-commit stand-down set", () => {
		const row = rowOf("new-shared-faults");
		expect(row.run).toBe(STEPS.newSharedFaultsRow);
		expect(row.when).toEqual({ unlessRoutes: ["post-commit-stand-down"] });
	});

	it("prints what the program printed on stdout, run on this commit", () => {
		const repo = hookRepo("post-commit-prints-");

		const r = runStep(repo.root, Notice);

		expect(r.stdout).toBe("a fault notice\n");
		expect(r.program.mock.calls[0][0].args).toEqual([
			repo.git("rev-parse", "HEAD").toString().trim(),
		]);
	});

	it("says nothing where the program printed nothing", () => {
		const repo = hookRepo("post-commit-silent-");

		expect(
			runStep(repo.root, { exit: 0, stdout: "", stderr: "" }),
		).toMatchObject({ stdout: "", stderr: "" });
	});

	it("swallows a program that crashed rather than reported — no stack trace after a landed commit", () => {
		const repo = hookRepo("post-commit-crash-");

		const r = runStep(repo.root, {
			exit: 1,
			stdout: "",
			stderr:
				"Error: reporter exploded\n    at Object.<anonymous> (x.js:1:7)\n",
		});

		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
	});

	it("names a program that throws in one line, never its stack, and the steps after it still run", async () => {
		const repo = hookRepo("post-commit-throw-");
		const quiet = quietPrograms();
		stubProgram("report-new-shared-faults.js", () => {
			throw new Error("reporter exploded");
		});

		const r = await runPostCommit({ cwd: repo.root, env: hookEnv() });

		expect(r.exit).toBe(0);
		expect(r.stderr).toBe(
			"post-commit: the new-shared-faults step threw: reporter exploded\n",
		);
		expect(quiet.check).toHaveBeenCalledTimes(2);
	});

	/* The other half of the crash case: exit 2 is the program SAYING it could
	 * not answer, which mantahostels#1750 wants rather than the silence a clean
	 * run gives — on the hook's stdout, as the block's `cat` put it. */
	it("prints the program's stderr on its exit 2, the could-not-answer code", () => {
		const repo = hookRepo("post-commit-unanswerable-");

		const r = runStep(repo.root, {
			exit: 2,
			stdout: "",
			stderr: "could not read the parent\n",
		});

		expect(r.stdout).toBe("could not read the parent\n");
	});

	it("hands the program none of the git redirects, the relative GIT_INDEX_FILE git exports into every hook among them", () => {
		const repo = hookRepo("post-commit-env-");

		const { program } = runStep(repo.root, Notice, {
			GIT_DIR: ".git",
			GIT_WORK_TREE: ".",
		});

		const handed = program.mock.calls[0][0].env;
		for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"])
			expect(handed[k], k).toBeUndefined();
	});

	/* Every sentinel the stand-down set reads, one case each: what an
	 * in-progress rebase, cherry-pick, revert or bisect leave in the git dir.
	 * `sequencer`, a multi-commit revert's, is below. */
	it.each(REPLAY_SENTINELS)(
		"stays quiet while %s is in the git dir, rather than attributing a replayed range one commit at a time",
		async (sentinel, kind) => {
			const repo = hookRepo(`post-commit-replay-${sentinel}-`);
			plantSentinel(repo.root, sentinel, kind);

			expect((await runRegistry(repo.root)).stdout).not.toContain(
				"a fault notice",
			);
		},
	);

	it.each([
		["stays quiet mid revert sequence", true, false],
		["prints over a leftover sequencer (#3298)", false, true],
	])("%s", async (_name, live, prints) => {
		const repo = hookRepo("post-commit-sequencer-");
		commitOverSequencer(repo.root, live);

		const r = await runRegistry(repo.root);

		expect(r.stdout.includes("a fault notice\n")).toBe(prints);
	});

	/* The inverse: with no sentinel present the same fixture DOES print. */
	it("prints where no replay is in progress", async () => {
		const repo = hookRepo("post-commit-no-replay-");

		expect((await runRegistry(repo.root)).stdout).toContain("a fault notice\n");
	});

	/*
	 * The real program, under the redirects git hands a linked worktree's
	 * post-commit hook: its checker's own `git ls-files`, run from a
	 * materialised tree that is no repository, lists nothing and so finds the
	 * worktree's file — where one still carrying the hook's GIT_DIR and
	 * GIT_INDEX_FILE would list the hook's index and find nothing.
	 */
	it("reads a linked worktree's commit from a clean environment, never the hook's index", () => {
		const repo = hookRepo("post-commit-linked-");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "post-commit-linked-"));
		temps.push(dir);
		const { wt, env, redirects } = linkedCommit(repo.root, dir);
		expect(redirects.GIT_INDEX_FILE).toBeTruthy();
		const probe = path.join(dir, "git-probe-checker.js");
		fs.writeFileSync(
			probe,
			`const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[process.argv.indexOf("--root") + 1];
const listed = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
const known = new Set(listed.status === 0 ? listed.stdout.split("\\n") : []);
const docs = path.join(root, "docs");
const files = fs.existsSync(docs) ? fs.readdirSync(docs).map((f) => "docs/" + f) : [];
const findings = files.filter((f) => !known.has(f)).map((f) => (${fail.toString()})({ file: f }));
process.stdout.write(JSON.stringify({ findings }));
`,
		);

		const r = STEPS.newSharedFaultsRow({
			cwd: wt,
			env: {
				...env,
				// hook-root.sh's answer for a linked worktree: the main tree.
				CLAUDE_PROJECT_DIR: repo.root,
				[CHECKERS_ENV]: JSON.stringify({ "guard-registry": probe }),
			},
		});

		expect(r.exit).toBe(0);
		expect(r.stdout, "the probe's git read no hook index").toContain(
			"docs/wt.md",
		);
	});
});
