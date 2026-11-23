// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coreFile } from "./lib/core-path-testkit";
import {
	hookEnv,
	linkedCommit,
	plantSentinel,
	programs,
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

// isolation-exempt: #160
function runCli(...args: string[]) {
	const r = runInProcess(SCRIPT, args, {
		cwd: REPO_ROOT,
		env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },
	});
	return { code: r.status, out: r.stdout, err: r.stderr };
}

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

describe("the notice the session reads", () => {
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
		expect(text).toContain("In full, WARNs and context included: node");
		expect(text).toContain(
			`Re-read this notice after a later commit: node ${coreFile("scripts/report-new-shared-faults.js")} ${child}`,
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
				fs.existsSync(path.resolve(REPO_ROOT, script)),
				`a route in names ${script}, which does not exist`,
			).toBe(true);
			expect(full).not.toContain("report-new-shared-faults");
		}
	});

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

describe(".husky/post-commit's fault-notice step", () => {
	function hookRepo(prefix: string) {
		const repo = newRepo(prefix, temps);
		fs.writeFileSync(path.join(repo.root, "a.txt"), "a");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "one");
		return repo;
	}

	const Notice: Result = { exit: 1, stdout: "a fault notice\n", stderr: "" };

	function runStep(cwd: string, answer: Result, env: NodeJS.ProcessEnv = {}) {
		const program = stubProgram("report-new-shared-faults.js", () => answer);
		const r = STEPS.newSharedFaultsRow(
			STEPS.buildRunIo({ cwd, env: hookEnv(env) }),
			programs,
		);
		expect(r.exit).toBe(0);
		return { ...r, program };
	}

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

	it("prints the program's stderr on its exit 2, the could-not-answer code (lucmoseley/mantahostels#1750)", () => {
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

	it("prints where no replay is in progress", async () => {
		const repo = hookRepo("post-commit-no-replay-");

		expect((await runRegistry(repo.root)).stdout).toContain("a fault notice\n");
	});

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

		const r = STEPS.newSharedFaultsRow(
			STEPS.buildRunIo({
				cwd: wt,
				env: {
					...env,
					CLAUDE_PROJECT_DIR: repo.root,
					[CHECKERS_ENV]: JSON.stringify({ "guard-registry": probe }),
				},
			}),
			programs,
		);

		expect(r.exit).toBe(0);
		expect(r.stdout, "the probe's git read no hook index").toContain(
			"docs/wt.md",
		);
	});
});
