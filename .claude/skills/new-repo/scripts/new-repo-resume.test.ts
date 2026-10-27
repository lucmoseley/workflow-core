// @vitest-environment node
/*
 * new-repo.js run again over a saved one: the argument checks against what a
 * run saved, and --resume from each step a run can stop after. Split from
 * new-repo.test.ts, whose header says how a run is driven and what a loosened
 * case costs (#3258).
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from new-repo.test.ts, whose cost was pre-existing (#3258).
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BASHRC,
	builtThrough,
	cleanRun,
	gitConfig,
	HAS_GITLEAKS,
	MAINTENANCE_OFF,
	newRepoSuite,
	readEndState,
	readWorld,
	resumeFinishes,
	SAVED,
	STEPS,
	sandbox,
	statusOf,
	stepIndex,
	worlds,
} from "./new-repo-testkit";

newRepoSuite();

describe("new-repo.js checks its arguments against the saved ones", () => {
	it("refuses, exit 2, an argument differing from the saved one, naming each difference, and acts on nothing", () => {
		const s = builtThrough("clone");
		const before = s.readCalls().length;
		fs.writeFileSync(path.join(s.inputs, "title"), "tides: something else\n");
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`preflight      STOPPED — the arguments differ from those ~/tides/.git/new-repo.json saved: --title-file gives "tides: something else" where "tides: a tide-table app" was saved\n`,
		);
		expect(r.stdout).toContain(
			"Manual step: drop the differing arguments — `--resume tides` alone reuses every saved one\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
		);

		fs.writeFileSync(path.join(s.inputs, "other-idea"), "Something else.\n");
		const beside = s.resume(
			"--prefix",
			"tx",
			"--idea-file",
			path.join(s.inputs, "other-idea"),
		);
		expect(beside.status, beside.stdout).toBe(2);
		expect(beside.stdout).toContain(
			`saved: --prefix gives "tx" where "td" was saved; --idea-file's text differs from the saved idea\n`,
		);
		expect(s.readCalls()).toHaveLength(before);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(BASHRC);

		const same = s.resume("--prefix", "td", "--dry-run");
		expect(same.status, same.stdout).toBe(0);
	});

	it("refuses, exit 2, --resume into a clone renamed by hand, whose saved name is another", () => {
		const s = builtThrough("clone");
		fs.writeFileSync(
			path.join(s.clone, ".git/new-repo.json"),
			JSON.stringify({ ...SAVED, name: "tides-old" }),
		);
		const r = s.resume("--dry-run");
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`saved: --resume gives "tides" where "tides-old" was saved\n`,
		);
	});

	it("refuses, exit 2, --resume where the run never reached its clone, and sends the founder back to /new-repo", () => {
		const s = sandbox();
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"preflight      STOPPED — there is nothing to resume: ~/tides/.git/new-repo.json is missing or incomplete\n",
		);
		expect(r.stdout).toContain(
			"Manual step: a run that stopped before its clone existed saved nothing — start it again with every argument\nThen start again: /new-repo\n",
		);
		expect(s.readCalls()).toEqual([]);
	});
});

describe.skipIf(!HAS_GITLEAKS)(
	"new-repo.js --resume after a part-way stop",
	() => {
		let goldenEnd: ReturnType<typeof readEndState>;
		let world: ReturnType<typeof worlds>;
		beforeAll(() => {
			const clean = cleanRun(false);
			goldenEnd = clean.goldenEnd;
			world = worlds(clean.golden, false);
		}, 340_000);
		afterAll(() => world?.drop());

		it("keeps the suite's maintenance switch-off as a world's hooks go off and back on (#1655)", () => {
			const s = world.at("clone");
			expect(gitConfig(s.env)).toEqual({
				...MAINTENANCE_OFF,
				"core.hooksPath": "/dev/null",
			});
			world.at("clone", { hooks: true });
			expect(gitConfig(s.env)).toEqual({
				...MAINTENANCE_OFF,
				"core.hooksPath": "",
			});
		});

		it("leaves the same end state from a clean run with the hooks off as with them on, as every case below relies on", () => {
			const s = sandbox({ hooks: false });
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			expect(readEndState(s)).toEqual(goldenEnd);
		}, 170_000);

		it.each(STEPS.map(([step]) => step))(
			"finishes from the world as left after %s, reaching a clean run's end state, as its dry run foretold",
			(step) => {
				const { s, r, past } = resumeFinishes(
					world.at(step),
					step,
					goldenEnd,
					false,
				);
				expect(r.stdout).toContain("Open a new terminal tab and run: td2\n");
				expect(s.readBackups()).toHaveLength(
					past >= stepIndex("bashrc") ? 0 : 1,
				);
			},
			170_000,
		);

		it("stops, exit 2, on a hook refusing the skeleton commit, printing its output word for word, and --resume finishes once it is fixed", () => {
			const s = world.at("plugin reads", { hooks: true });
			/* A copied repo's own gate (#694 item 6), which the core's wiring
			 * gate refuses until its header says what it does. */
			const gate = path.join(s.clone, ".husky/pre-commit.local");
			fs.writeFileSync(gate, ":\n");
			const r = s.resume();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toMatch(
				/^commit {9}STOPPED — a hook refused the skeleton commit$/m,
			);
			expect(r.stdout).toContain(
				"UNANNOTATED  .husky/pre-commit.local:1\n  wiring:  wired at git\n",
			);
			expect(r.stdout).toContain("FAIL: 1 fault(s) this commit adds\n");
			expect(r.stdout).toContain(
				"Manual step: open a new tab, run `td1`, fix it in that session, then re-run from workflow-core: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			expect(() => s.git("rev-parse", "--verify", "-q", "HEAD")).toThrow();

			fs.writeFileSync(
				gate,
				"# shellcheck shell=sh\n# IMPLICIT: runs tides's own checks on every commit\n# JUSTIFIED: fail-safe — the source repo's checks keep running\n# DEFEAT: none\n:\n",
			);
			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			expect(statusOf(again.stdout, "commit")).toBe("done");
			expect(statusOf(again.stdout, "push")).toBe("done");
			expect(s.git("ls-files", ".husky/pre-commit.local")).toBe(
				".husky/pre-commit.local",
			);
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
		}, 340_000);

		it("foretells a commit and a push where the core has changed init's output since the skeleton commit, as the resume then makes them (#762)", () => {
			const s = world.at("push");
			/* A skeleton an older core rendered: init rewrites this core-owned
			 * file on every run, from this checkout. */
			const rules = path.join(s.clone, ".claude/workflow-core.md");
			fs.appendFileSync(rules, "\nA line an older core rendered.\n");
			s.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", "older");
			s.git("-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "main");
			const before = readWorld(s);
			const dry = s.resume("--dry-run");
			expect(dry.status, dry.stdout).toBe(0);
			expect(readWorld(s)).toEqual(before);
			expect(fs.readdirSync(path.join(s.sb, "tmp"))).toEqual([]);
			expect(statusOf(dry.stdout, "commit")).toBe("would");
			expect(statusOf(dry.stdout, "push")).toBe("would");
			const r = s.resume();
			expect(r.status, r.stdout).toBe(0);
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(statusOf(r.stdout, "push")).toBe("done");
			expect(fs.readFileSync(rules, "utf8")).not.toContain("an older core");
		}, 340_000);

		it("finishes from the #725 trial's index: every skeleton path intent-added but the settings file a global gitignore hides", () => {
			const s = world.at("plugin reads");
			fs.mkdirSync(path.join(s.home, ".config/git"), { recursive: true });
			fs.writeFileSync(
				path.join(s.home, ".config/git/ignore"),
				"**/.claude/settings.local.json\n",
			);
			s.git(
				"add",
				"-N",
				"--",
				"CLAUDE.md",
				"AGENTS.md",
				".claude",
				"docs",
				".husky",
			);
			const r = s.resume();
			expect(r.status, r.stdout).toBe(0);
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(s.git("ls-files", ".claude/settings.local.json")).toBe("");
			expect(s.git("status", "--porcelain", "--untracked-files=all")).toBe("");
		}, 340_000);

		it("stops, exit 2, where git add refuses the skeleton paths, printing git's message and the manual step", () => {
			const s = world.at("plugin reads");
			const lock = path.join(s.clone, ".git/index.lock");
			fs.writeFileSync(lock, "");
			const r = s.resume();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toMatch(
				/^commit {9}STOPPED — git add refused the skeleton paths$/m,
			);
			expect(r.stdout).toContain("index.lock");
			expect(r.stdout).toContain(
				"Manual step: open a new tab, run `td1`, fix it in that session, then re-run from workflow-core: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			fs.rmSync(lock);
			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			expect(statusOf(again.stdout, "commit")).toBe("done");
		}, 340_000);

		it("stops, exit 2, on a rejected push, naming the manual step and the --resume command", () => {
			const s = world.at("commit");
			fs.writeFileSync(
				path.join(s.sb, "github/lucmoseley/tides.git/hooks/pre-receive"),
				'#!/bin/sh\necho "tides server: main is closed to pushes" >&2\nexit 1\n',
				{ mode: 0o755 },
			);
			const r = s.resume();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toMatch(/^push {11}STOPPED — the push was rejected$/m);
			expect(r.stdout).toContain("tides server: main is closed to pushes");
			expect(r.stdout).toContain(
				"Manual step: read the rejection above and settle it in ~/tides\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			expect(() =>
				s.git("rev-parse", "--verify", "-q", "origin/main"),
			).toThrow();
		}, 170_000);
	},
);
