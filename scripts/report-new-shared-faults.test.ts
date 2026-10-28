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
 * check-doc-map.js (mantahostels#1824's extension) gets its OWN describe block below,
 * which runs the real checker throughout — a stub would only prove this file
 * can shell out, not that readDocMapEnvelope's throwaway detached worktree
 * actually redirects check-doc-map.js's own `git ls-files` call and its
 * literal `HEAD` reads.
 *
 * It runs from `.husky/post-commit` after every commit, the notice of faults a
 * commit added to the whole-repo checks: loosen a case and a new fault goes
 * unannounced, or a session is blamed for one it inherited.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyDataFile } from "./lib/doc-map-testkit";
import {
	newRepo,
	registerTempCleanup,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import { commitOverSequencer, cutInReplay } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process";

const temps = registerTempCleanup();

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "report-new-shared-faults.js");
const LEFTOVER_ROOT_ENV = "WFC_SHARED_FAULT_TMP";
const CHECKERS_ENV = "WFC_SHARED_FAULT_CHECKERS";

const lines = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);

function run(
	ref: string,
	{ checkers, cwd }: { checkers: Record<string, string>; cwd: string },
) {
	const r = runInProcess(SCRIPT, [ref], {
		cwd,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: cwd,
			[CHECKERS_ENV]: JSON.stringify(checkers),
		},
	});
	return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}

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
 * check-doc-map.js (mantahostels#1824) — the third checker report-new-shared-faults.js
 * diffs, and the only one that doesn't take --root (readDocMapEnvelope's own
 * docstring in report-new-shared-faults.js).
 *
 * The fixture map is precommit-doc-map-gate.test.ts's "pointer count
 * disagreeing with its sidecar" fixture (assertion 11, mantahostels#1474): a one-entry
 * Section B pointer ("Restated in: <n> paths") whose stated count either does
 * or doesn't match docs/doc-map-restatements.json's B1 entry.
 */
describe("check-doc-map.js's pointer-count fault, sha vs parent", () => {
	/** The map plus its five sidecars. */
	const sidecars = [
		"doc-map-restatements.json",
		"doc-map-superseded.json",
		"doc-map-retired-vocabulary.json",
		"doc-map-restatement-allowlist.json",
		"doc-map-high-water.json",
	];

	const mapText = [
		"# Doc map",
		"",
		"v1.0 · 26 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"| --- | --- | --- |",
		"| `docs/doc-map.md` | the map | `stable` |",
		"| `docs/notes.md` | a doc | `stable` |",
		"| `docs/doc-map-restatements.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-superseded.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-retired-vocabulary.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-restatement-allowlist.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-high-water.json` | a sidecar | `source-of-truth` |",
		"| `docs/doc-map-classes.json` | the class sidecar | `source-of-truth` |",
		"",
		"## Section B — figure registry",
		"",
		"### B1 · A figure",
		"",
		"- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.",
		"- **Settled at #1**",
		"",
	].join("\n");

	/** Writes the map (with `stated` substituted) plus its sidecars and notes.md
	 * into `root`'s docs/ dir. Does not stage or commit — the caller decides
	 * when. */
	function writeDocMapFixture(root: string, stated: number) {
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "docs", "doc-map.md"),
			mapText.replace("<n> paths", `${stated} path${stated === 1 ? "" : "s"}`),
		);
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "x\n");
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-restatements.json"),
			JSON.stringify({ B1: { paths: [{ path: "docs/notes.md" }] } }),
		);
		for (const name of sidecars.slice(1))
			fs.writeFileSync(path.join(root, "docs", name), emptyDataFile(name));
		/* The class sidecar is the coverage register (mantahostels#1849) — a repo without
		 * one is BROKEN, so the fixture owes it a key per registered path.
		 * Written in register-doc.js's canonical form (mantahostels#3353) — sorted keys, tab
		 * indent, one trailing newline — so it doesn't itself trip
		 * SIDECAR-NOT-CANONICAL. */
		const classEntries = Object.fromEntries(
			[
				"docs/doc-map.md",
				"docs/notes.md",
				...sidecars.map((n) => `docs/${n}`),
				"docs/doc-map-classes.json",
			].map((p) => [
				p,
				{
					section: "Docs",
					class: "source-of-truth",
					classQualifier: null,
					role: null,
					route: null,
					consumes: null,
					...(p.endsWith(".md") ? { reader: "agent" } : {}),
				},
			]),
		);
		const sortedClassEntries = Object.fromEntries(
			Object.keys(classEntries)
				.sort()
				.map((k) => [k, classEntries[k]]),
		);
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-classes.json"),
			`${JSON.stringify(sortedClassEntries, null, "\t")}\n`,
		);
	}

	/** `checkers: {}` keeps this describe block to doc-map alone. */
	const runDocMap = (ref: string, root: string) =>
		run(ref, { checkers: {}, cwd: root });

	it("reports the pointer fault the commit added, not one it inherited", () => {
		const repo = newRepo("report-new-shared-faults-dm-added-", temps);
		writeDocMapFixture(repo.root, 1);
		repo.git("add", "-A");
		repo.git("commit", "-qm", "clean map");

		writeDocMapFixture(repo.root, 2);
		repo.git("add", "-A");
		repo.git("commit", "-qm", "map now disagrees with its sidecar");
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		const { code, out, err } = runDocMap(child, repo.root);

		expect(err).toEqual([]);
		expect(code).toBe(1);
		const text = out.join("\n");
		// The profile now heads its own line, carrying mantahostels#1750's cost clause, with
		// its fault items indented under it (mantahostels#1825).
		expect(text).toContain("doc-map (whole-repo assertion");
		expect(text).toContain("fails the scheduled sweeps");
		expect(text).toContain("pointerFaults:");
		expect(text).toContain("B1");
		expect(text).toContain("pointer says 2 path(s), the sidecar holds 1");
		expect(text).toContain(
			"In full, WARNs and context included: node scripts/check-doc-map.js",
		);
	});

	it("stays silent on a pointer fault the commit only inherited", () => {
		const repo = newRepo("report-new-shared-faults-dm-inherited-", temps);
		writeDocMapFixture(repo.root, 2);
		repo.git("add", "-A");
		repo.git("commit", "-qm", "map disagrees with its sidecar from the start");

		fs.writeFileSync(path.join(repo.root, "docs", "notes.md"), "y\n");
		repo.git("add", "-A");
		repo.git("commit", "-qm", "unrelated edit to notes.md");
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		const { code, out, err } = runDocMap(child, repo.root);

		expect(err).toEqual([]);
		expect(out).toEqual([]);
		expect(code).toBe(0);
	});

	it("stands the doc-map limb down where the repo carries no map at all", () => {
		/* ABSENT is not UNREADABLE. A repo forked from this core that never took
		 * the map has nothing to compare. The case below still reports a map that
		 * IS there and will not read (#11). */
		const repo = newRepo("report-new-shared-faults-dm-absent-", temps);
		fs.writeFileSync(path.join(repo.root, "a.txt"), "x\n");
		repo.git("add", "-A");
		repo.git("commit", "-qm", "base");
		fs.writeFileSync(path.join(repo.root, "a.txt"), "y\n");
		repo.git("add", "-A");
		repo.git("commit", "-qm", "edit");
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		const { code, out, err } = runDocMap(child, repo.root);

		expect(err).toEqual([]);
		expect(out).toEqual([]);
		expect(code).toBe(0);
	});

	it("names the sidecar it could not read where one is missing on a side, rather than staying silent", () => {
		const repo = newRepo("report-new-shared-faults-dm-missing-sidecar-", temps);
		writeDocMapFixture(repo.root, 1);
		// The high-water mark is absent at the parent commit — a commit that
		// only ever inherited the checker's own BROKEN-on-absence behaviour must
		// still be reported as unreadable, not silently treated as clean.
		fs.rmSync(path.join(repo.root, "docs", "doc-map-high-water.json"));
		repo.git("add", "-A");
		repo.git("commit", "-qm", "no high-water mark yet");

		writeDocMapFixture(repo.root, 1);
		repo.git("add", "-A");
		repo.git("commit", "-qm", "adds the high-water mark");
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		const { code, out, err } = runDocMap(child, repo.root);

		expect(code).toBe(2);
		expect(out).toEqual([]);
		expect(err.join("\n")).toContain("doc-map");
		expect(err.join("\n")).toContain("doc-map-high-water.json");
	});

	it("reads the real check-doc-map.js envelope of a clean map on both sides as nothing new, not as unreadable", () => {
		const repo = newRepo("report-new-shared-faults-dm-shape-", temps);
		writeDocMapFixture(repo.root, 1);
		repo.git("add", "-A");
		repo.git("commit", "-qm", "clean map");
		fs.writeFileSync(path.join(repo.root, "docs", "notes.md"), "y\n");
		repo.git("add", "-A");
		repo.git("commit", "-qm", "still clean");
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		expect(runDocMap(child, repo.root)).toEqual({ code: 0, out: [], err: [] });
	});

	/*
	 * check-doc-map.js asks `git ls-files` for its scope, with no flag to
	 * redirect it, so the reading of the PARENT is only the parent's where the
	 * program's detached worktree scopes that call. An unregistered doc the
	 * child adds is then new: a parent reading that answered from the live
	 * checkout — the child throughout, git never checks the parent out — would
	 * carry the same fault and call it inherited.
	 */
	it("scopes each reading's git ls-files to its own commit, not always the live checkout", () => {
		const repo = newRepo("report-new-shared-faults-dm-scope-", temps);
		writeDocMapFixture(repo.root, 1);
		repo.git("add", "-A");
		repo.git("commit", "-qm", "base: every doc registered");

		fs.writeFileSync(path.join(repo.root, "docs", "extra.md"), "z\n");
		repo.git("add", "-A");
		/* Committed long ago, past the pairing grace window that would soften a
		 * fresh doc's missing registration to a WARN. */
		execFileSync(
			"git",
			["commit", "-qm", "adds a doc the map does not register"],
			{
				cwd: repo.root,
				env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
			},
		);
		const child = repo.git("rev-parse", "HEAD").toString().trim();

		const { code, out, err } = runDocMap(child, repo.root);

		expect(err).toEqual([]);
		expect(code).toBe(1);
		expect(out.join("\n")).toContain("docs/extra.md");
	});

	/*
	 * THE KILL PATH (mantahostels#1883) — why it needs covering at all is in
	 * report-new-shared-faults.js's own §Leftovers comment.
	 *
	 * These cases SIGKILL a real run and then assert on `git worktree list`
	 * and the leftover directory rather than stubbing the cleanup, which would
	 * only prove the sweep can be called.
	 *
	 * Nested inside this describe for writeDocMapFixture — the worktree is
	 * readDocMapEnvelope's, so the kill has to land in a run that reads a doc map.
	 *
	 * Each case gets a leftover root of its own, redirected through
	 * LEFTOVER_ROOT_ENV: the production root is shared, and every neighbour
	 * session's post-commit run sweeps it, so a neighbour committing mid-case
	 * would sweep the very leftovers being asserted on.
	 */
	describe("what a SIGKILL leaves, and the next run's sweep", () => {
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		let previousRoot: string | undefined;

		beforeEach(() => {
			previousRoot = process.env[LEFTOVER_ROOT_ENV];
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-leftovers-"));
			temps.push(root);
			process.env[LEFTOVER_ROOT_ENV] = root;
		});

		afterEach(() => {
			if (previousRoot === undefined) delete process.env[LEFTOVER_ROOT_ENV];
			else process.env[LEFTOVER_ROOT_ENV] = previousRoot;
		});

		const leftoverRoot = () => process.env[LEFTOVER_ROOT_ENV] as string;

		const readLeftovers = (stem: string) =>
			fs.existsSync(leftoverRoot())
				? fs.readdirSync(leftoverRoot()).filter((b) => b.startsWith(stem))
				: [];

		/** The pid of a process spawned and waited on here — gone, barring the
		 * pid reuse STALE_MS exists to cover. */
		function deadPid(): number {
			const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
			return r.pid as number;
		}

		/** A fixture repo with one clean doc-map commit on top of another, so
		 * both of run()'s readDocMapEnvelope calls have something to read. */
		function docMapRepo(prefix: string) {
			const repo = newRepo(prefix, temps);
			writeDocMapFixture(repo.root, 1);
			repo.git("add", "-A");
			repo.git("commit", "-qm", "clean map");
			writeDocMapFixture(repo.root, 1);
			fs.writeFileSync(path.join(repo.root, "docs", "notes.md"), "y\n");
			repo.git("add", "-A");
			repo.git("commit", "-qm", "still clean");
			return repo;
		}

		/** SIGKILLs the run the instant its doc-map worktree exists; false if it
		 * exited first. */
		async function killOnceWorktreeExists(
			child: ReturnType<typeof spawn>,
			pid: number,
		) {
			while (child.exitCode === null && child.signalCode === null) {
				if (readLeftovers(`dm-${pid}-`).length > 0) {
					child.kill("SIGKILL");
					return true;
				}
				await sleep(2);
			}
			return false;
		}

		/**
		 * Spawns a real run and SIGKILLs it the instant its doc-map worktree
		 * exists, returning the dead run's pid. The worktree lives only for the
		 * length of one check-doc-map.js spawn, so a missed window is retried
		 * rather than slept through — and the case fails loudly if none of the
		 * attempts lands, instead of passing on a kill that hit nothing.
		 */
		async function killMidWorktree(ref: string, root: string) {
			for (let attempt = 0; attempt < 8; attempt++) {
				// spawn-kept: a signal — the run is SIGKILLed mid-worktree.
				const child = spawn(process.execPath, [SCRIPT, ref], {
					cwd: root,
					env: {
						...process.env,
						CLAUDE_PROJECT_DIR: root,
						[CHECKERS_ENV]: "{}",
					},
					stdio: "ignore",
				});
				const pid = child.pid as number;
				const killed = await killOnceWorktreeExists(child, pid);
				await new Promise((r) => child.on("exit", r));
				if (killed && readLeftovers(`dm-${pid}-`).length > 0) return pid;
			}
			throw new Error("no attempt landed a SIGKILL while the worktree existed");
		}

		/** The worktree paths `repo` has registered under the leftover root, read
		 * from git itself rather than from the directory listing — an
		 * unregistered directory is litter, a registered one is a write to the
		 * repository that outlives the process (mantahostels#1750's user story 20). */
		function readRegistered(repo: TempRepo) {
			return repo
				.git("worktree", "list", "--porcelain")
				.toString()
				.split("\n")
				.filter((l) => l.startsWith("worktree "))
				.map((l) => l.slice("worktree ".length))
				.filter((w) => path.dirname(w) === leftoverRoot());
		}

		it("leaves a registered worktree and its temp trees behind when killed, and the next run removes both", async () => {
			const repo = docMapRepo("report-new-shared-faults-kill-");
			const head = repo.git("rev-parse", "HEAD").toString().trim();
			const pid = await killMidWorktree(head, repo.root);

			expect(readRegistered(repo).length).toBeGreaterThan(0);
			expect(readLeftovers(`tree-${pid}-`).length).toBe(2);

			run(head, { checkers: {}, cwd: repo.root });

			expect(readRegistered(repo)).toEqual([]);
			expect(readLeftovers(`dm-${pid}-`)).toEqual([]);
			expect(readLeftovers(`tree-${pid}-`)).toEqual([]);
		}, 60_000);

		it("leaves a live run's worktree and trees alone, so two concurrent runs cannot sweep each other", () => {
			const repo = docMapRepo("report-new-shared-faults-concurrent-");
			const head = repo.git("rev-parse", "HEAD").toString().trim();

			// This test process stands in for the concurrent run: its pid is live.
			const liveTree = path.join(leftoverRoot(), `tree-${process.pid}-live`);
			const liveWorktree = path.join(leftoverRoot(), `dm-${process.pid}-live`);
			fs.mkdirSync(leftoverRoot(), { recursive: true });
			fs.mkdirSync(liveTree, { recursive: true });
			temps.push(liveTree);
			repo.git("worktree", "add", "--detach", "--quiet", liveWorktree, head);

			run(head, { checkers: {}, cwd: repo.root });

			expect(fs.existsSync(liveTree)).toBe(true);
			expect(readRegistered(repo)).toEqual([liveWorktree]);
			repo.git("worktree", "remove", "--force", liveWorktree);
		}, 30_000);

		it("removes nothing it did not name itself — a foreign temp dir, and a worktree outside its own directory", () => {
			const repo = docMapRepo("report-new-shared-faults-foreign-");
			const head = repo.git("rev-parse", "HEAD").toString().trim();
			const gone = deadPid();

			// Same directory, a name that is not one of ours.
			const foreign = path.join(leftoverRoot(), `somebody-elses-${gone}-dir`);
			fs.mkdirSync(foreign, { recursive: true });
			temps.push(foreign);

			// Our own name, but registered from somewhere else — a session's
			// throwaway worktree is not this script's to remove.
			const outside = fs.mkdtempSync(
				path.join(os.tmpdir(), "report-not-ours-"),
			);
			temps.push(outside);
			const elsewhere = path.join(outside, `dm-${gone}-x`);
			repo.git("worktree", "add", "--detach", "--quiet", elsewhere, head);

			run(head, { checkers: {}, cwd: repo.root });

			expect(fs.existsSync(foreign)).toBe(true);
			expect(repo.git("worktree", "list", "--porcelain").toString()).toContain(
				elsewhere,
			);
			repo.git("worktree", "remove", "--force", elsewhere);
		}, 30_000);

		it("leaves a dead run's worktree DIRECTORY to git, even when the worktree sweep cannot run", () => {
			// A host root that is not a checkout: `git rev-parse --git-common-dir`
			// fails, so the worktree sweep throws and only the tree sweep runs,
			// before the ref fails to resolve. The worktree directory must
			// survive that, or a registration git could still have removed
			// cleanly becomes a dangling one.
			const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "report-no-git-"));
			temps.push(notARepo);
			const gone = deadPid();
			const staleTree = path.join(leftoverRoot(), `tree-${gone}-x`);
			const staleWorktree = path.join(leftoverRoot(), `dm-${gone}-x`);
			fs.mkdirSync(staleTree, { recursive: true });
			fs.mkdirSync(staleWorktree, { recursive: true });

			const { code, err } = run("HEAD", { checkers: {}, cwd: notARepo });

			expect(code).toBe(2);
			expect(err.join("\n")).toContain("does not resolve to a commit");
			expect(fs.existsSync(staleTree)).toBe(false);
			expect(fs.existsSync(staleWorktree)).toBe(true);
		});

		it("sweeps a leftover older than the age backstop even though its pid is live", () => {
			const repo = docMapRepo("report-new-shared-faults-aged-");
			const head = repo.git("rev-parse", "HEAD").toString().trim();

			// This process's pid, so only the age can condemn it: the backstop
			// STALE_MS exists for the run whose pid has since been reused.
			const aged = path.join(leftoverRoot(), `tree-${process.pid}-aged`);
			fs.mkdirSync(aged, { recursive: true });
			const longAgo = Date.now() / 1000 - 25 * 60 * 60;
			fs.utimesSync(aged, longAgo, longAgo);

			run(head, { checkers: {}, cwd: repo.root });

			expect(fs.existsSync(aged)).toBe(false);
		}, 30_000);

		it("costs a small fraction of the seconds the report itself takes, over a populated directory", () => {
			const repo = docMapRepo("report-new-shared-faults-sweep-cost-");
			// A populated root, so the per-entry statSync + process.kill loop is
			// what is timed and not an empty readdir. Live names (this process),
			// and names that are not ours at all.
			const gone = deadPid();
			for (let i = 0; i < 20; i++) {
				fs.mkdirSync(path.join(leftoverRoot(), `tree-${process.pid}-live${i}`));
				fs.mkdirSync(path.join(leftoverRoot(), `dm-${process.pid}-live${i}`));
				fs.mkdirSync(path.join(leftoverRoot(), `not-ours-${gone}-${i}`));
			}

			/* A ref that does not resolve, so the run is the sweep and one
			 * failing `git rev-list`, and stops before any checker or tree. */
			const started = process.hrtime.bigint();
			const { code } = run("no-such-ref", { checkers: {}, cwd: repo.root });
			const ms = Number(process.hrtime.bigint() - started) / 1e6;

			expect(code).toBe(2);
			/* The bound is loose against a machine running several
			 * sessions' suites at once, and its job is to catch a readdir of
			 * os.tmpdir() creeping back in: /tmp here holds ~225,000 entries and
			 * costs ~400 ms to list. */
			expect(ms).toBeLessThan(250);
		});
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
		// mantahostels#1750's cost line for this checker: who the red now refuses.
		expect(text).toContain("refuses every other session's commit touching");
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

	/** The `name() { … }` shell function, verbatim: from its opening line to the
	 * next `}` at column zero. */
	function cutFunction(name: string): string {
		const hookLines = hookText.split("\n");
		const start = hookLines.findIndex((l) => l.startsWith(`${name}() {`));
		if (start === -1)
			throw new Error(`.husky/post-commit defines no ${name}()`);
		const end = hookLines.findIndex((l, i) => i > start && l === "}");
		if (end === -1)
			throw new Error(`.husky/post-commit's ${name}() is unclosed`);
		return hookLines.slice(start, end + 1).join("\n");
	}

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
				`${cutInReplay()}\n${cutFunction("report_new_shared_faults")}\nreport_new_shared_faults\nprintf "reached-end\\n"`,
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
