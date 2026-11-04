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

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import {
	commitOverSequencer,
	cutPostCommitBlock,
} from "./lib/precommit-gate-testkit";
import {
	CHECKERS_ENV,
	lines,
	run,
	SCRIPT,
} from "./lib/report-new-shared-faults-testkit";
import { runInProcess } from "./lib/run-in-process";
import { COSTS } from "./lib/shared-fault-costs";

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

	/* Adding a checker to the diff and adding it to the notice are one act, not
	 * two (mantahostels#1750): a profile the diff knows but the notice does not
	 * cost throws rather than print an `undefined` clause. doc-map's own line is
	 * the pointer-fault case's. */
	it("carries a cost line for every lib/fault-profiles.js profile it reads by --root", () => {
		const { PROFILES } = require("./lib/fault-profiles.js") as {
			PROFILES: Record<string, unknown>;
		};
		const { repo, child } = repoWithOneAddedFault("report-notice-every-");
		const stub = writeStubChecker();
		const profiles = Object.keys(PROFILES).filter((p) => p !== "doc-map");

		const { code, out, err } = run(child, {
			checkers: Object.fromEntries(profiles.map((p) => [p, stub])),
			cwd: repo.root,
		});

		expect(err).toEqual([]);
		expect(code).toBe(1);
		for (const profile of profiles)
			expect(out.join("\n")).toMatch(
				new RegExp(`^  ${profile} \\(.+\\) — a red here .+:$`, "m"),
			);
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
 * A row's `why` states whether .husky/pre-commit runs its checker `--against`
 * (#4221). doc-map is direction-gated by its own staged-vs-HEAD block.
 */
describe("each COSTS row's direction-gate claim", () => {
	const OwnDirectionGate = new Set(["doc-map"]);
	const hook = fs.readFileSync(
		path.join(REPO_ROOT, ".husky", "pre-commit"),
		"utf8",
	);
	const scriptOf = (full: string) => {
		const m = /scripts\/([\w-]+\.js)/.exec(full);
		if (!m?.[1]) throw new Error(`no checker script in ${full}`);
		return m[1];
	};
	const cases = Object.entries(COSTS).map(([profile, { why, full }]) => {
		const script = scriptOf(full);
		const runs = hook
			.split("\n")
			.filter(
				(l) =>
					!l.trimStart().startsWith("#") && l.includes(`scripts/${script}`),
			);
		return { profile, why, script, runs };
	});

	it.each(cases)(
		"$profile's why names the direction gate the hook runs $script with",
		({ profile, why, runs }) => {
			expect(runs.length).toBeGreaterThan(0);
			const claimsGate = why.includes("direction-gated");
			if (OwnDirectionGate.has(profile)) {
				expect(claimsGate).toBe(true);
				return;
			}
			expect(runs.some((l) => l.includes("--against"))).toBe(claimsGate);
		},
	);
});

/*
 * HOOK PARITY (mantahostels#1825): .husky/post-commit's own text is read and its fault
 * block is CUT AND RUN, the way precommit-doc-map-gate.test.ts exercises the
 * pre-commit fragment.
 *
 * The cases stub `scripts/report-new-shared-faults.js` inside a throwaway repo:
 * what is under test is the hook's guarding, not the script's answer.
 */
describe(".husky/post-commit's fault-notice block", () => {
	const hookText = fs.readFileSync(
		path.join(REPO_ROOT, ".husky", "post-commit"),
		"utf8",
	);

	/** A throwaway repo with one commit and, optionally, a stub reporter at the
	 * path the hook looks for. */
	function hookRepo(prefix: string, stub?: string) {
		const repo = newRepo(prefix, temps);
		fs.writeFileSync(path.join(repo.root, "a.txt"), "a");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "one");
		if (stub !== undefined) {
			fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
			fs.writeFileSync(
				path.join(repo.root, "scripts", "report-new-shared-faults.js"),
				stub,
			);
		}
		return repo;
	}

	/**
	 * Runs the cut block in `cwd`, under the shell and the environment husky and
	 * git actually give it.
	 *
	 * `sh -e`, NOT `sh`: .husky/_/h:18 runs every hook as `sh -e "$s"`, where an
	 * unprotected `out=$(...)` aborts the shell the moment the command inside
	 * exits non-zero — and this script's non-zero exits are its faults-found (1)
	 * and could-not-answer (2), the only two runs that print anything. A plain
	 * `sh` here passes against a block that cannot work in production.
	 */
	function runBlock(cwd: string, env: Record<string, string> = {}) {
		const r = spawnSync(
			"sh",
			[
				"-e",
				"-c",
				`${cutPostCommitBlock("report_new_shared_faults")}\nreport_new_shared_faults\nprintf "reached-end\\n"`,
			],
			{
				cwd,
				encoding: "utf8",
				// The relative index path git exports into every hook.
				env: { ...process.env, GIT_INDEX_FILE: ".git/index", ...env },
			},
		);
		return {
			code: r.status ?? -1,
			// The trailing marker proves the block RETURNED rather than taking the
			// shell down with it.
			reachedEnd: r.stdout.includes("reached-end"),
			out: r.stdout.replace("reached-end\n", ""),
			err: r.stderr,
		};
	}

	function expectSurvived(r: { code: number; reachedEnd: boolean }) {
		expect(r.reachedEnd).toBe(true);
		expect(r.code).toBe(0);
	}

	it("reports on the commit WFC_COMMITTED_SHA names, whatever HEAD has moved to (#3746)", () => {
		const repo = hookRepo(
			"post-commit-notice-named-",
			'process.stdout.write(process.argv[2] + "\\n");\n',
		);
		const mine = repo.git("rev-parse", "HEAD").toString().trim();
		repo.git("commit", "-q", "--allow-empty", "-m", "a neighbour's");

		const r = runBlock(repo.root, { WFC_COMMITTED_SHA: mine });

		expect(r.out).toBe(`${mine}\n`);
		expectSurvived(r);
	});

	it("calls scripts/report-new-shared-faults.js, and CALLS the function it defines", () => {
		const uncommented = hookText
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#"));
		const text = uncommented.join("\n");

		expect(text).toContain("report-new-shared-faults.js");
		// A bare `report_new_shared_faults` at column zero: the INVOCATION, not
		// the `report_new_shared_faults() {` that defines it.
		expect(uncommented).toContain("report_new_shared_faults");
	});

	it("prints what the script printed on stdout", () => {
		const repo = hookRepo(
			"post-commit-prints-",
			`process.stdout.write("a fault notice\\n"); process.exit(1);\n`,
		);

		const r = runBlock(repo.root);

		expect(r.out).toContain("a fault notice");
		// Returns 0 whatever the script did — git ignores post-commit's status.
		expectSurvived(r);
	});

	it("says nothing where the script printed nothing", () => {
		const repo = hookRepo("post-commit-silent-", "process.exit(0);\n");

		const r = runBlock(repo.root);

		expect(r.out).toBe("");
		expect(r.err).toBe("");
		expectSurvived(r);
	});

	it("says nothing where the script is missing altogether", () => {
		const repo = hookRepo("post-commit-missing-");

		const r = runBlock(repo.root);

		expect(r.out).toBe("");
		expect(r.err).toBe("");
		expectSurvived(r);
	});

	it("swallows a crashing script — no stack trace after a landed commit", () => {
		const repo = hookRepo(
			"post-commit-crash-",
			`throw new Error("reporter exploded");\n`,
		);

		const r = runBlock(repo.root);

		expect(r.out).toBe("");
		expect(r.err).not.toContain("reporter exploded");
		expectSurvived(r);
	});

	/* The other half of the crash case: exit 2 is the script SAYING it could not
	 * answer, which mantahostels#1750 wants rather than the silence a clean run gives. */
	it("prints the script's stderr on its exit 2, the could-not-answer code", () => {
		const repo = hookRepo(
			"post-commit-unanswerable-",
			`process.stderr.write("could not read the parent\\n"); process.exit(2);\n`,
		);

		const r = runBlock(repo.root);

		expect(`${r.out}${r.err}`).toContain("could not read the parent");
		expectSurvived(r);
	});

	it("unsets the relative GIT_INDEX_FILE git exports into every hook", () => {
		const repo = hookRepo(
			"post-commit-env-",
			`process.stdout.write("GIT_INDEX_FILE=" + (process.env.GIT_INDEX_FILE ?? "<unset>") + "\\n");\n`,
		);

		const r = runBlock(repo.root);

		expect(r.out).toContain("GIT_INDEX_FILE=<unset>");
		expectSurvived(r);
	});

	/* Every sentinel the block lists, one case each: what an in-progress
	 * rebase, cherry-pick, revert or bisect leave in the git dir. `sequencer`,
	 * a multi-commit revert's, is below. */
	it.each([
		["rebase-merge", "dir"],
		["rebase-apply", "dir"],
		["CHERRY_PICK_HEAD", "file"],
		["REVERT_HEAD", "file"],
		["BISECT_LOG", "file"],
	])(
		"stays quiet while %s is in the git dir, rather than attributing a replayed range one commit at a time",
		(sentinel, kind) => {
			const repo = hookRepo(
				`post-commit-replay-${sentinel}-`,
				`process.stdout.write("a fault notice\\n"); process.exit(1);\n`,
			);
			const at = path.join(repo.root, ".git", sentinel);
			if (kind === "dir") fs.mkdirSync(at);
			else fs.writeFileSync(at, "\n");

			const r = runBlock(repo.root);

			expect(r.out).toBe("");
			expectSurvived(r);
		},
	);

	it.each([
		["stays quiet mid revert sequence", true, ""],
		["prints over a leftover sequencer (#3298)", false, "a fault notice\n"],
	])("%s", (_name, live, expected) => {
		const repo = hookRepo(
			"post-commit-sequencer-",
			`process.stdout.write("a fault notice\\n"); process.exit(1);\n`,
		);
		commitOverSequencer(repo.root, live);

		const r = runBlock(repo.root);

		expect(r.out).toBe(expected);
		expectSurvived(r);
	});

	/* The inverse: with no sentinel present the same fixture DOES print. */
	it("prints where no replay is in progress", () => {
		const repo = hookRepo(
			"post-commit-no-replay-",
			`process.stdout.write("a fault notice\\n"); process.exit(1);\n`,
		);

		expect(runBlock(repo.root).out).toContain("a fault notice");
	});

	/* Two halves, and the `git status` one alone is not enough: mktemp writes
	 * OUTSIDE the repository by construction, so deleting the `rm -f` leaves the
	 * porcelain assertion green. A private TMPDIR is what makes the leak
	 * visible. */
	it("removes its temp file, in the repository and out of it", () => {
		const repo = hookRepo(
			"post-commit-no-writes-",
			`process.stdout.write("a fault notice\\n"); process.exit(1);\n`,
		);
		const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "post-commit-tmp-"));
		temps.push(tmpdir);
		const before = repo.git("status", "--porcelain").toString();

		const r = runBlock(repo.root, { TMPDIR: tmpdir });

		expect(r.out).toContain("a fault notice");
		expect(fs.readdirSync(tmpdir)).toEqual([]);

		expect(repo.git("status", "--porcelain").toString()).toBe(before);
	});
});
