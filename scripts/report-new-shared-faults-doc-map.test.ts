// @vitest-environment node
/*
 * report-new-shared-faults.js's doc-map limb (mantahostels#1824). It runs the real
 * check-doc-map.js throughout: a stub would only prove the program can shell
 * out, not that readDocMapEnvelope's throwaway detached worktree redirects
 * check-doc-map.js's own `git ls-files` call and its literal `HEAD` reads.
 * Loosen a case and a commit's new doc-map fault goes unannounced after it
 * lands, or a killed run's worktree stays registered in the repository.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDataFile } from "./lib/doc-map-testkit";
import {
	newRepo,
	registerTempCleanup,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	CHECKERS_ENV,
	run,
	SCRIPT,
} from "./lib/report-new-shared-faults-testkit";

const temps = registerTempCleanup();

const LEFTOVER_ROOT_ENV = "WFC_SHARED_FAULT_TMP";

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
		// The route in names the checker that ran, which exists beside this file.
		expect(fs.existsSync(path.join(__dirname, "check-doc-map.js"))).toBe(true);
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

		beforeEach(() => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "report-leftovers-"));
			temps.push(root);
			vi.stubEnv(LEFTOVER_ROOT_ENV, root);
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

		/** The next run, reduced to its sweep: run() sweeps before it resolves
		 * its ref, and stops at one that does not resolve, so no tree or
		 * check-doc-map.js reading is paid for to reach it. */
		function sweepOnly(root: string) {
			expect(run("no-such-ref", { checkers: {}, cwd: root }).code).toBe(2);
		}

		it("leaves a registered worktree and its temp trees behind when killed, and the next run removes both", async () => {
			const repo = docMapRepo("report-new-shared-faults-kill-");
			const head = repo.git("rev-parse", "HEAD").toString().trim();
			const pid = await killMidWorktree(head, repo.root);

			expect(readRegistered(repo).length).toBeGreaterThan(0);
			expect(readLeftovers(`tree-${pid}-`).length).toBe(2);

			sweepOnly(repo.root);

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

			/* A full run, its pid this process's: the one registration left also
			 * proves the run removed the doc-map worktree it made itself. */
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

			sweepOnly(repo.root);

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
			const repo = newRepo("report-new-shared-faults-aged-", temps);

			// This process's pid, so only the age can condemn it: the backstop
			// STALE_MS exists for the run whose pid has since been reused.
			const aged = path.join(leftoverRoot(), `tree-${process.pid}-aged`);
			fs.mkdirSync(aged, { recursive: true });
			const longAgo = Date.now() / 1000 - 25 * 60 * 60;
			fs.utimesSync(aged, longAgo, longAgo);

			sweepOnly(repo.root);

			expect(fs.existsSync(aged)).toBe(false);
		}, 30_000);

		it("lists only its own leftover root, never os.tmpdir(), over a populated directory (mantahostels#1883)", () => {
			const repo = docMapRepo("report-new-shared-faults-sweep-reads-");
			/* A populated root, so a sweep that lists each entry's contents
			 * shows up as extra listings. Live names (this process), and names
			 * that are not ours at all. */
			const gone = deadPid();
			for (let i = 0; i < 20; i++) {
				fs.mkdirSync(path.join(leftoverRoot(), `tree-${process.pid}-live${i}`));
				fs.mkdirSync(path.join(leftoverRoot(), `dm-${process.pid}-live${i}`));
				fs.mkdirSync(path.join(leftoverRoot(), `not-ours-${gone}-${i}`));
			}

			/* No output shows what a listing costs, so the listings are counted:
			 * the cost of listing os.tmpdir() is measured in the subject's
			 * leftover header. Listings under the repo's own .git (the
			 * worktree registrations) are git's admin, not the temp dir. */
			const gitDir = path.resolve(repo.root, ".git");
			const readdir = vi.spyOn(fs, "readdirSync");
			const opendir = vi.spyOn(fs, "opendirSync");
			let listed: string[];
			try {
				sweepOnly(repo.root);
				listed = [...readdir.mock.calls, ...opendir.mock.calls]
					.map(([dir]) => path.resolve(String(dir)))
					.filter((dir) => !dir.startsWith(gitDir + path.sep));
			} finally {
				readdir.mockRestore();
				opendir.mockRestore();
			}

			expect(listed).toEqual([path.resolve(leftoverRoot())]);
		});
	});
});
