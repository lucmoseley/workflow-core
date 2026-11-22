// @vitest-environment node

import { execFileSync, type spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDataFile } from "./lib/doc-map-testkit";
import { keptSpawn } from "./lib/kept-spawn.js";
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

describe("check-doc-map.js's pointer-count fault, sha vs parent", () => {
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
		expect(text).toContain("doc-map (whole-repo assertion");
		expect(text).toContain("fails the scheduled sweeps");
		expect(text).toContain("pointerFaults:");
		expect(text).toContain("B1");
		expect(text).toContain("pointer says 2 path(s), the sidecar holds 1");
		expect(text).toContain(
			"In full, WARNs and context included: node scripts/check-doc-map.js",
		);
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

	it("scopes each reading's git ls-files to its own commit, not always the live checkout", () => {
		const repo = newRepo("report-new-shared-faults-dm-scope-", temps);
		writeDocMapFixture(repo.root, 1);
		repo.git("add", "-A");
		repo.git("commit", "-qm", "base: every doc registered");

		fs.writeFileSync(path.join(repo.root, "docs", "extra.md"), "z\n");
		repo.git("add", "-A");
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

		function deadPid(): number {
			const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
			return r.pid as number;
		}

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

		async function killMidWorktree(ref: string, root: string) {
			for (let attempt = 0; attempt < 8; attempt++) {
				const child = keptSpawn("signal").spawn(
					process.execPath,
					[SCRIPT, ref],
					{
						cwd: root,
						env: {
							...process.env,
							CLAUDE_PROJECT_DIR: root,
							[CHECKERS_ENV]: "{}",
						},
						stdio: "ignore",
					},
				);
				const pid = child.pid as number;
				const killed = await killOnceWorktreeExists(child, pid);
				await new Promise((r) => child.on("exit", r));
				if (killed && readLeftovers(`dm-${pid}-`).length > 0) return pid;
			}
			throw new Error("no attempt landed a SIGKILL while the worktree existed");
		}

		function readRegistered(repo: TempRepo) {
			return repo
				.git("worktree", "list", "--porcelain")
				.toString()
				.split("\n")
				.filter((l) => l.startsWith("worktree "))
				.map((l) => l.slice("worktree ".length))
				.filter((w) => path.dirname(w) === leftoverRoot());
		}

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

			const foreign = path.join(leftoverRoot(), `somebody-elses-${gone}-dir`);
			fs.mkdirSync(foreign, { recursive: true });
			temps.push(foreign);

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

			const aged = path.join(leftoverRoot(), `tree-${process.pid}-aged`);
			fs.mkdirSync(aged, { recursive: true });
			const longAgo = Date.now() / 1000 - 25 * 60 * 60;
			fs.utimesSync(aged, longAgo, longAgo);

			sweepOnly(repo.root);

			expect(fs.existsSync(aged)).toBe(false);
		}, 30_000);

		it("lists only its own leftover root, never os.tmpdir(), over a populated directory (mantahostels#1883)", () => {
			const repo = docMapRepo("report-new-shared-faults-sweep-reads-");
			const gone = deadPid();
			for (let i = 0; i < 20; i++) {
				fs.mkdirSync(path.join(leftoverRoot(), `tree-${process.pid}-live${i}`));
				fs.mkdirSync(path.join(leftoverRoot(), `dm-${process.pid}-live${i}`));
				fs.mkdirSync(path.join(leftoverRoot(), `not-ours-${gone}-${i}`));
			}

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
