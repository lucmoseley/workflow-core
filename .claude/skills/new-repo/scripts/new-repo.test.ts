// @vitest-environment node
/*
 * new-repo.js, driven from outside end to end, asserting the world it leaves —
 * GitHub-side state, the clone, its files and the report — never a step's
 * internals (#707 Q2: the script carries no test hook).
 *
 * HOME is a temporary folder, so `~/<name>` is a fixture. GitHub is a STATEFUL
 * `gh` stub keeping repos, labels and issues as files: `repo create` makes a
 * bare repo, and HOME's gitconfig rewrites https://github.com/ onto it, so the
 * clone's origin reads as GitHub while every push lands locally. The real
 * init-adopter.js and file-issue.js run against it, the former with
 * --no-plugin-install. No network call (#707 Q1).
 *
 * SPAWNED, NOT RUN IN PROCESS (§X3's timeout shape): a run commits through the
 * new repo's real hook stack, so each carries a 170 s timeout of its own. A
 * case that reaches that commit is skipped without gitleaks, whose secret scan
 * the stack runs. The two --resume groups, in new-repo-resume.test.ts and
 * new-repo-copy-resume.test.ts, resume with the hooks off, save the
 * hook-refusal case, and reach a hooked clean run's end state (#1150).
 *
 * The founder runs the script through /new-repo and approves one confirmed
 * run: loosen a case and that run can leave a GitHub repo, clone or
 * `~/.bashrc` block half-made, or a resume that cannot finish it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	HOOKS,
	renderHookShim,
} from "../../../../scripts/lib/adopter-skeleton.js";
import {
	BASHRC,
	buildLiveBlock,
	gitConfig,
	HAS_GITLEAKS,
	IDEA,
	IGNORE_BLOCK,
	MAINTENANCE_OFF,
	newRepoSuite,
	pinned,
	readIgnoredScratch,
	sandbox,
	statusOf,
	TIDES_BLOCK,
} from "./new-repo-testkit";

newRepoSuite();

describe("new-repo.js on an empty project", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"takes it from nothing to a pushed, adopted private repo holding one unassigned map, and a second run finds every step done (#2460)",
		() => {
			const s = sandbox();
			const r = s.run();
			expect(r.stderr).toBe("");
			expect(r.status, r.stdout).toBe(0);

			for (const step of [
				"preflight",
				"github repo",
				"clone",
				"bashrc",
				"init-adopter",
				"first map",
				"project",
				"plugin reads",
				"commit",
				"push",
			])
				expect(statusOf(r.stdout, step), step).toBe("done");
			// The newest vX.Y.Z by semver, not by string order.
			expect(r.stdout).toContain("core v1.10.0");
			// init-adopter's probe lines, on a tracker with no issue yet (#734).
			expect(
				r.stdout.slice(
					r.stdout.indexOf("init-adopter   done — pinned to v1.10.0"),
					r.stdout.indexOf("first map "),
				),
			).toContain(
				[
					"  probe    sub-issues, dependencies: not probed — the tracker has no issue yet",
					"  probe    repos/lucmoseley/tides/actions/runs?per_page=1: reachable",
					"  probe    repos/lucmoseley/tides/pulls?per_page=1: reachable",
					"",
				].join("\n"),
			);
			// The gates and rules run the pin, not the core's checkout (#736).
			const pin = pinned(s.home, "v1.10.0");
			expect(
				fs.readFileSync(path.join(s.clone, ".claude/workflow-core.md"), "utf8"),
			).toContain(`node ${pin}/scripts/`);
			// The hooks name no pin at all: each resolves the core at run time (#1839).
			for (const hook of HOOKS)
				expect(
					fs.readFileSync(path.join(s.clone, ".husky", hook), "utf8"),
				).toBe(renderHookShim(hook));

			// Appended after the three existing blocks, which are left as they were.
			expect(fs.readFileSync(s.rc, "utf8")).toBe(`${BASHRC}\n${TIDES_BLOCK}\n`);
			const start = `${BASHRC}\n`.split("\n").length;
			const [backup] = s.readBackups();
			expect(s.readBackups()).toHaveLength(1);
			expect(fs.readFileSync(path.join(s.home, backup), "utf8")).toBe(BASHRC);
			expect(r.stdout).toContain(
				`bashrc         done — ${s.rc} lines ${start}-${start + 4}, backed up to ${path.join(s.home, backup)}\n${TIDES_BLOCK.replace(/^/gm, "  ")}\n`,
			);
			expect(r.stdout).not.toContain("warning:");

			const gh = s.readState();
			expect(gh.private).toBe(true);
			expect(gh.issues).toHaveLength(1);
			const [map] = gh.issues;
			expect(map.number).toBe(1);
			expect(map.title).toBe("tides: a tide-table app");
			expect(map.labels.sort()).toEqual(["takes:wayfinder", "wayfinder:map"]);
			expect(map.assignees).toEqual([]);
			expect(map.body).toMatch(
				/## Destination\n\nNot named yet — the first session grills it\n/,
			);
			expect(map.body).toContain(IDEA);
			expect(map.body).toContain(
				"/wayfinder Chart the map on #1. It holds my idea and no destination yet: fill that issue as the map rather than creating a new one.",
			);
			expect(map.body).not.toContain("commands.test");
			expect(map.body).toMatch(/^Standalone: /m);

			// The report ends on the new-tab line for this plan and the prompt.
			const tail = r.stdout.trimEnd().split("\n").slice(-4);
			expect(tail[0]).toBe("Open a new terminal tab and run: td2");
			// Not a workflow-core checkout, so no self-plugin setup (#2440).
			expect(r.stdout).not.toContain("Once per machine");
			expect(tail[3]).toBe(
				"/wayfinder Chart the map on #1. It holds my idea and no destination yet: fill that issue as the map rather than creating a new one.",
			);

			expect(s.git("config", "--get", "remote.origin.url")).toBe(
				"https://github.com/lucmoseley/tides.git",
			);
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
			// Whole-tree, so a path init writes outside the skeleton pathspec shows here.
			expect(s.git("status", "--porcelain", "--untracked-files=all")).toBe(
				"?? .claude/settings.local.json",
			);
			expect(readIgnoredScratch(s)).toBe(
				"private/x\n.claude/tmp/x\n.claude/worktrees/x\n",
			);
			expect(s.git("show", "HEAD:.gitignore")).toBe(IGNORE_BLOCK.trimEnd());

			const config = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, ".claude/workflow-core.json"),
					"utf8",
				),
			);
			expect(config.modules ?? []).toEqual([]);
			expect(config.commands ?? {}).toEqual({});
			const claude = fs.readFileSync(path.join(s.clone, "CLAUDE.md"), "utf8");
			expect(claude).toContain(
				"tides — A tide-table app for surfers, for the founder's own surf trips. Founder: Test Founder.",
			);
			expect(claude).toContain(
				"State: pre-launch — the way is being charted on #1 (tides: a tide-table app).",
			);

			// The local standards file is its header and an empty primitives
			// table, committed through the hook stack that runs the table
			// checker (#3466).
			expect(s.git("show", "HEAD:docs/code-standards.md")).toBe(
				[
					"# Code standards — tides",
					"",
					"This repo's own choices beside the plugin's standards base, which holds every rule and its §-id. `/code-review`'s Standards axis reads both.",
					"",
					"## Primitives",
					"",
					"This repo's own primitives, beside the base's table. None yet.",
					"",
					"| Job | Primitive | Exemplar | Rule | Enforcing check |",
					"|---|---|---|---|---|",
				].join("\n"),
			);

			// The Read rules are this machine's: written, never committed.
			const local = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, ".claude/settings.local.json"),
					"utf8",
				),
			);
			expect(local.permissions.allow).toEqual(
				[".claude", ".claude2", ".claude3"].map(
					(d) => `Read(/${s.home}/${d}/plugins/cache/**)`,
				),
			);
			expect(s.git("ls-files", ".claude/settings.local.json")).toBe("");
			const saved = JSON.parse(
				fs.readFileSync(path.join(s.clone, ".git/new-repo.json"), "utf8"),
			);
			expect(saved.repo).toBe("lucmoseley/tides");
			expect(saved.idea).toBe(IDEA);
			expect(s.git("ls-files", ".git")).toBe("");

			for (const again of [s.run(), s.resume()]) {
				expect(again.status, again.stdout).toBe(0);
				for (const step of [
					"github repo",
					"clone",
					"bashrc",
					"first map",
					"project",
					"plugin reads",
					"commit",
					"push",
				])
					expect(statusOf(again.stdout, step), step).toBe("skipped");
			}
			expect(s.readState().issues).toHaveLength(1);
			expect(fs.readFileSync(s.rc, "utf8")).toBe(`${BASHRC}\n${TIDES_BLOCK}\n`);
			expect(s.readBackups()).toHaveLength(1);
		},
		340_000,
	);

	it.skipIf(!HAS_GITLEAKS)(
		"commits the skeleton where a global gitignore hides .claude/settings.local.json, which stopped the #725 live trial",
		() => {
			const s = sandbox({ globalIgnore: "**/.claude/settings.local.json\n" });
			const r = s.run();
			expect(r.status, r.stdout + r.stderr).toBe(0);
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(s.git("ls-files", ".claude/settings.local.json")).toBe("");
			expect(s.git("status", "--porcelain", "--untracked-files=all")).toBe("");
		},
		340_000,
	);

	it("--dry-run runs every preflight check, prints each planned step, and writes nothing", () => {
		const s = sandbox();
		const r = s.run("--dry-run");
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(statusOf(r.stdout, "preflight")).toBe("done");
		for (const step of [
			"github repo",
			"clone",
			"bashrc",
			"init-adopter",
			"first map",
			"project",
			"plugin reads",
			"commit",
			"push",
		])
			expect(statusOf(r.stdout, step), step).toBe("would");
		expect(r.stdout).toContain(
			`--marketplace-ref v1.10.0 --plugin-root ${pinned(s.home, "v1.10.0")}`,
		);
		expect(r.stdout).toMatch(/^modules {8}none$/m);
		expect(r.stdout).toContain(
			[
				"  # --- tides, one alias per plan ---",
				"  alias td1='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude claude agents)'",
				"  alias td2='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude2 claude agents)'",
				"  alias td3='(cd ~/tides && CLAUDE_CONFIG_DIR=$HOME/.claude3 claude agents)'",
				"  # --- end tides block ---",
			].join("\n"),
		);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(BASHRC);
		expect(s.readBackups()).toEqual([]);
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(s.clone)).toBe(false);
		expect(fs.readdirSync(path.join(s.sb, "github"))).toEqual([]);
		expect(
			s
				.readCalls()
				.map((c) => c.slice(0, 2).join(" "))
				.sort(),
		).toEqual([
			"api repos/lucmoseley/workflow-core/tags",
			"auth status",
			"repo view",
		]);
	});
});

describe("new-repo.js test sandbox", () => {
	it("keeps the suite's maintenance switch-off with the hooks off and on (#1655)", () => {
		expect(gitConfig(sandbox({ hooks: false }).env)).toEqual({
			...MAINTENANCE_OFF,
			"core.hooksPath": "/dev/null",
		});
		expect(gitConfig(sandbox({ hooks: true }).env)).toEqual({
			...MAINTENANCE_OFF,
			"core.hooksPath": "",
		});
	});

	it("keeps maintenance switched off on the receiving side of a local push (#1655)", () => {
		const s = sandbox({ hooks: false });
		const bare = path.join(s.sb, "github/probe.git");
		const git = (cwd: string, ...a: string[]) =>
			execFileSync("git", a, { cwd, encoding: "utf8", env: s.env });
		git(s.sb, "init", "-q", "--bare", bare);
		// The bare repo's own hook runs, the env's hooksPath being stripped too.
		fs.writeFileSync(
			path.join(bare, "hooks/pre-receive"),
			`#!/bin/sh\nfor k in ${Object.keys(MAINTENANCE_OFF).join(" ")}; do echo "$k=$(git config --get $k)" >&2; done\nexit 1\n`,
			{ mode: 0o755 },
		);
		const work = path.join(s.sb, "probe");
		git(s.sb, "init", "-q", work);
		git(work, "commit", "-q", "--allow-empty", "-m", "probe");
		const r = spawnSync("git", ["push", bare, "main"], {
			cwd: work,
			encoding: "utf8",
			env: s.env,
		});
		for (const [k, v] of Object.entries(MAINTENANCE_OFF))
			expect(r.stderr).toMatch(new RegExp(`^remote: ${k}=${v} *$`, "m"));
	});
});

describe("new-repo.js preflight: a run that will fail creates nothing", () => {
	it("refuses, exit 2, where the core has no release tag, offering a release cut as the manual step, and never falls back to a directory", () => {
		const s = sandbox({ tags: ["nightly", "v2"] });
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toMatch(
			/^preflight {6}STOPPED — lucmoseley\/workflow-core has no vX\.Y\.Z release tag/m,
		);
		expect(r.stdout).toContain(
			"Manual step: cut a workflow-core release first",
		);
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(s.clone)).toBe(false);
	});

	it("refuses, exit 2, a name that belongs to a repo this script did not make", () => {
		const s = sandbox();
		fs.mkdirSync(path.join(s.sb, "github/lucmoseley"), { recursive: true });
		const bare = path.join(s.sb, "github/lucmoseley/tides.git");
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
		const seed = path.join(s.sb, "seed");
		execFileSync("git", ["init", "-q", "-b", "main", seed]);
		execFileSync("git", [
			"-C",
			seed,
			"-c",
			"user.name=x",
			"-c",
			"user.email=x@x",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"theirs",
		]);
		execFileSync("git", ["-C", seed, "push", "-q", bare, "main"]);
		fs.writeFileSync(
			path.join(s.sb, "github/lucmoseley/tides.json"),
			JSON.stringify({ private: true, labels: [], issues: [] }),
		);
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toContain(
			"Manual step: that name belongs to a repo this script did not make — pick another name or delete it on GitHub yourself\nThen start again: /new-repo",
		);
		expect(fs.existsSync(s.clone)).toBe(false);
		expect(
			s.readCalls().some((c) => c[0] === "repo" && c[1] === "create"),
		).toBe(false);
	});

	it("refuses, exit 2, where ~/<name> is taken by something that is not its clone", () => {
		const s = sandbox();
		fs.mkdirSync(s.clone);
		fs.writeFileSync(path.join(s.clone, "notes.txt"), "mine\n");
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toMatch(
			/STOPPED — ~\/tides exists and is not this script's clone/,
		);
		expect(r.stdout).toContain(
			"Manual step: move ~/tides aside, or pick another name",
		);
		expect(s.readState()).toBeNull();
		expect(fs.readFileSync(path.join(s.clone, "notes.txt"), "utf8")).toBe(
			"mine\n",
		);
	});

	it("refuses, exit 2, with gh logged out, before reading anything else, naming gh auth login as the way out", () => {
		const s = sandbox();
		fs.writeFileSync(path.join(s.sb, "fail/auth"), "");
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toContain(
			"Manual step: log gh in: run `gh auth login` in a terminal",
		);
		expect(s.readCalls()).toEqual([["auth", "status"]]);
	});
});

describe("new-repo.js after a part-way stop", () => {
	it("refuses, exit 2, where ~/<name> is its clone but the GitHub repo is gone", () => {
		const s = sandbox();
		fs.mkdirSync(path.join(s.clone, ".git"), { recursive: true });
		fs.writeFileSync(
			path.join(s.clone, ".git/new-repo.json"),
			JSON.stringify({ repo: "lucmoseley/tides" }),
		);
		const r = s.run();
		expect(r.status).toBe(2);
		expect(r.stdout).toMatch(
			/^preflight {6}STOPPED — ~\/tides holds this script's clone, but lucmoseley\/tides is gone from GitHub$/m,
		);
		expect(r.stdout).toContain(
			"Manual step: delete ~/tides too and start fresh\nThen start again: /new-repo",
		);
		expect(r.stdout).not.toContain("--resume");
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(path.join(s.clone, ".git/new-repo.json"))).toBe(true);
	});

	it.skipIf(!HAS_GITLEAKS)(
		"stops at exit 1 when an issue create lands but reports failure, and --resume keeps the lowest map, closing every duplicate",
		() => {
			const s = sandbox();
			fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
			const r = s.run();
			expect(r.status, r.stdout).toBe(1);
			expect(statusOf(r.stdout, "first map")).toBe("STOPPED");
			expect(r.stdout).toContain(
				"Re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			expect(r.stdout).not.toContain("Manual step:");
			expect(s.readState().issues).toHaveLength(1);

			/* Two more failed runs each filed a map before this one. */
			fs.rmSync(path.join(s.sb, "fail/issue-create"));
			const gh = s.readState();
			gh.issues.push(
				{ ...gh.issues[0], number: 2 },
				{ ...gh.issues[0], number: 3 },
			);
			fs.writeFileSync(
				path.join(s.sb, "github/lucmoseley/tides.json"),
				JSON.stringify(gh),
			);

			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			expect(again.stdout).toMatch(/^first map {6}repaired — #1$/m);
			const [kept, ...dups] = s.readState().issues;
			expect(kept.state).toBe("OPEN");
			expect(kept.body).toContain("/wayfinder Chart the map on #1.");
			for (const dup of dups) {
				expect(dup.state).toBe("CLOSED");
				expect(dup.comments).toEqual([
					"duplicate of #1, filed by a failed new-repo run",
				]);
			}
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
		},
		340_000,
	);
});

describe("new-repo.js and the ~/.bashrc launch block", () => {
	it.each([
		["an alias", `${BASHRC}alias td2='ls'\n`, "td2 is taken (alias)"],
		["a function", `${BASHRC}td3() { :; }\n`, "td3 is taken (function)"],
		[
			"a file on PATH",
			`${BASHRC}export PATH="$HOME/bin:$PATH"\n`,
			"td1 is taken (file)",
		],
	])(
		"refuses, exit 2, a prefix whose alias would shadow %s, and creates nothing",
		(_, bashrc, clash) => {
			const s = sandbox({ bashrc });
			fs.mkdirSync(path.join(s.home, "bin"));
			fs.writeFileSync(path.join(s.home, "bin/td1"), "#!/bin/sh\n", {
				mode: 0o755,
			});
			const r = s.run();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toContain(
				`preflight      STOPPED — the prefix "td" clashes: ${clash}`,
			);
			expect(r.stdout).toContain("Manual step: pick another prefix");
			expect(s.readState()).toBeNull();
			expect(fs.existsSync(s.clone)).toBe(false);
			expect(fs.readFileSync(s.rc, "utf8")).toBe(bashrc);
			expect(s.readBackups()).toEqual([]);
		},
	);

	it("checks the numbered aliases only, never the bare prefix", () => {
		const s = sandbox({ bashrc: `${BASHRC}alias td='ls'\n` });
		const r = s.run("--dry-run");
		expect(r.status, r.stdout).toBe(0);
		expect(statusOf(r.stdout, "bashrc")).toBe("would");
	});

	it("refuses, exit 2, where ~/.bashrc already fails bash -n, and creates nothing", () => {
		const s = sandbox({ bashrc: `${BASHRC}if true; then\n` });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`preflight      STOPPED — ${s.rc} fails \`bash -n\``,
		);
		expect(r.stdout).toContain(
			`Manual step: fix ${s.rc} until \`bash -n ~/.bashrc\` passes`,
		);
		expect(s.readState()).toBeNull();
		expect(s.readBackups()).toEqual([]);
	});

	it("refuses, exit 2, a block whose opening marker is never closed, naming the file and line and offering the end marker as the way out", () => {
		const bashrc = `${BASHRC}# --- tides, one alias per plan ---\nalias td1='ls'\n`;
		const s = sandbox({ bashrc });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			`STOPPED — ${s.rc} opens the tides block at line ${BASHRC.split("\n").length} and never closes it`,
		);
		expect(r.stdout).toContain(
			"Manual step: add `# --- end tides block ---` below that block's last alias, or delete its opening line",
		);
		expect(s.readState()).toBeNull();
	});

	it("backs ~/.bashrc up before writing, and restores it and stops, exit 2, when bash -n fails after, quoting the complaint of bash -n and naming the backup", () => {
		const s = sandbox({ failBashN: true });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(statusOf(r.stdout, "bashrc")).toBe("STOPPED");
		expect(r.stdout).toContain("syntax error near unexpected token");
		const [backup] = s.readBackups();
		expect(s.readBackups()).toHaveLength(1);
		expect(r.stdout).toContain(`is restored from ${path.join(s.home, backup)}`);
		expect(r.stdout).toContain(
			`Manual step: read \`bash -n\`'s complaint above and settle ${s.rc} by hand`,
		);
		expect(fs.readFileSync(path.join(s.home, backup), "utf8")).toBe(BASHRC);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(BASHRC);
		// Stopped before init: the clone holds no skeleton.
		expect(fs.existsSync(path.join(s.clone, "CLAUDE.md"))).toBe(false);
	});

	it("leaves a block already present untouched, warning where it differs with the block it would write, and never checks its own aliases as clashes", () => {
		const old = buildLiveBlock("tides", "td");
		const bashrc = `${BASHRC}\n${old}\n`;
		const s = sandbox({ bashrc });
		// Stop the run once the step is past, at the map, short of the commit.
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.run();
		expect(r.status, r.stdout).toBe(1);
		const start = `${BASHRC}\n`.split("\n").length;
		expect(r.stdout).toContain(
			`bashrc         skipped — kept as found — ${s.rc} lines ${start}-${start + 5}\n${old.replace(/^/gm, "  ")}\n  warning: the tides block in ${s.rc} differs from what this run would write, and is kept. This run would write:\n${TIDES_BLOCK.replace(/^/gm, "  ")}\n`,
		);
		expect(fs.readFileSync(s.rc, "utf8")).toBe(bashrc);
		expect(s.readBackups()).toEqual([]);
	}, 170_000);

	it("reads a block differing only by trailing whitespace as already written", () => {
		const s = sandbox({
			bashrc: `${BASHRC}\n${TIDES_BLOCK.replace(/\n/g, "  \n")}\n`,
		});
		const r = s.run("--dry-run");
		expect(r.status, r.stdout).toBe(0);
		expect(r.stdout).toMatch(/^bashrc {9}skipped — already done — /m);
		expect(r.stdout).not.toContain("warning:");
	});

	it.skipIf(!HAS_GITLEAKS)(
		"never names a launch alias that a block kept as found does not define",
		() => {
			const old = [
				"# --- tides, one alias per plan ---",
				"alias td1='(cd ~/tides && claude agents)'",
				"# --- end tides block ---",
			].join("\n");
			const s = sandbox({ bashrc: `${BASHRC}\n${old}\n` });
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			expect(r.stdout).toContain(
				"Open a new terminal tab and start a session in ~/tides: the kept ~/.bashrc block defines no td2",
			);
			expect(r.stdout).not.toContain("and run: td2");
		},
		170_000,
	);
});
