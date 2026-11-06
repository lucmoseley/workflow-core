// @vitest-environment node
/*
 * Pins `worktreeRoot()` (#2940): a test run launched inside a linked worktree
 * reads that worktree's files, though `CLAUDE_PROJECT_DIR` may name the shared
 * tree. Pins `resolveCommitHost()` too (#3830): a script answers the
 * host `hook-root.sh` hands a hook, whatever its shell inherited. Pins
 * `sessionTree()` (#4234): a hook input's cwd in a linked worktree names that
 * worktree, though the hook itself runs in the shared tree. The seam's cases read `a.md` through the resolved root,
 * the worktree's copy differing from the shared tree's; the runners' cases
 * read the worktree's own config.
 *
 * Break it and a test run inside a worktree passes or fails on the shared
 * tree's files.
 *
 * The seam's cases are spawned, not required in-process: it reads
 * `CLAUDE_PROJECT_DIR` and memoises on cwd, and the suite's own process must
 * keep both. The runners' run through `runInProcessAsync`, which restores
 * both after the call.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	trioTemplate,
} from "./git-fixture";
import { runInProcessAsync } from "./run-in-process";

const SEAM = path.join(__dirname, "host-root.js");
const RUN_VITEST = path.join(__dirname, "..", "run-vitest.js");
const RUN_PYTEST = path.join(__dirname, "..", "run-pytest.js");

const template = defineTemplate(trioTemplate());

describe("the host seam", () => {
	let dir: string;
	let at: { shared: string; elsewhere: string; wt: string };

	beforeEach(() => {
		dir = mkScratchDir("host-root-");
		template.instantiate(dir);
		at = {
			shared: fs.realpathSync(path.join(dir, "shared")),
			elsewhere: fs.realpathSync(path.join(dir, "elsewhere")),
			wt: fs.realpathSync(path.join(dir, "wt")),
		};
		fs.writeFileSync(path.join(at.wt, "a.md"), "worktree\n");
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	/** `a.md` as read through the root `expr` names, evaluated in a child at `cwd`. */
	const spawnThrough = (
		expr: string,
		cwd: string,
		projectDir: string | undefined,
	) => {
		const { CLAUDE_PROJECT_DIR: _, ...env } = process.env;
		return spawnSync(
			process.execPath,
			[
				"-e",
				`process.stdout.write(require("fs").readFileSync(require("path").join(${expr}, "a.md"), "utf8"))`,
			],
			{
				cwd,
				encoding: "utf8",
				env: projectDir ? { ...env, CLAUDE_PROJECT_DIR: projectDir } : env,
			},
		);
	};
	const readThrough = (
		expr: string,
		cwd: string,
		projectDir: string | undefined,
	) => {
		const r = spawnThrough(expr, cwd, projectDir);
		expect(r.stderr).toBe("");
		return r.stdout;
	};
	const readFrom = (cwd: string, projectDir: string | undefined) =>
		readThrough(
			`require(${JSON.stringify(SEAM)}).worktreeRoot()`,
			cwd,
			projectDir,
		);

	it("reads a linked worktree's own file when CLAUDE_PROJECT_DIR names the shared tree (#2940)", () => {
		expect(readFrom(at.wt, at.shared)).toBe("worktree\n");
	});

	it("reads the worktree's file from a subdirectory of it (#2940)", () => {
		const sub = path.join(at.wt, "sub");
		fs.mkdirSync(sub);
		expect(readFrom(sub, at.shared)).toBe("worktree\n");
	});

	it("keeps the shared tree when launched there", () => {
		expect(readFrom(at.shared, at.shared)).toBe("a\n");
	});

	it("keeps CLAUDE_PROJECT_DIR when launched in an unrelated repository", () => {
		fs.writeFileSync(path.join(at.elsewhere, "a.md"), "elsewhere\n");
		expect(readFrom(at.elsewhere, at.shared)).toBe("a\n");
	});

	it("reads the worktree with CLAUDE_PROJECT_DIR unset", () => {
		expect(readFrom(at.wt, undefined)).toBe("worktree\n");
	});

	it("judges the worktree against a host the caller declares, over CLAUDE_PROJECT_DIR (#3327)", () => {
		fs.writeFileSync(path.join(at.elsewhere, "a.md"), "elsewhere\n");
		expect(
			readThrough(
				`require(${JSON.stringify(SEAM)}).worktreeRoot(undefined, { host: ${JSON.stringify(at.shared)} })`,
				at.wt,
				at.elsewhere,
			),
		).toBe("worktree\n");
	});

	it("keeps a declared host when launched in an unrelated repository with CLAUDE_PROJECT_DIR unset (#3327)", () => {
		fs.writeFileSync(path.join(at.elsewhere, "a.md"), "elsewhere\n");
		expect(
			readThrough(
				`require(${JSON.stringify(SEAM)}).worktreeRoot(undefined, { host: ${JSON.stringify(`${at.shared}/`)} })`,
				at.elsewhere,
				undefined,
			),
		).toBe("a\n");
	});

	describe("hostRoot, one store for a worktree session's hooks and Bash (#4493)", () => {
		const readFromHost = (cwd: string, projectDir: string | undefined) =>
			readThrough(
				`require(${JSON.stringify(SEAM)}).hostRoot()`,
				cwd,
				projectDir,
			);

		it("answers the main checkout for a CLAUDE_PROJECT_DIR naming a linked worktree", () => {
			expect(readFromHost(at.wt, at.wt)).toBe("a\n");
		});

		it("answers the same main checkout with CLAUDE_PROJECT_DIR unset, from that worktree", () => {
			expect(readFromHost(at.wt, undefined)).toBe("a\n");
		});

		it("keeps a CLAUDE_PROJECT_DIR naming an unrelated main checkout", () => {
			fs.writeFileSync(path.join(at.elsewhere, "a.md"), "elsewhere\n");
			expect(readFromHost(at.wt, at.elsewhere)).toBe("elsewhere\n");
		});
	});

	describe("sessionTree, the tree a hook input's cwd names (#4234)", () => {
		/** `a.md` through the session tree of `input`, from a hook run in the
		 * shared tree with CLAUDE_PROJECT_DIR on it. */
		const readFromSession = (input: Record<string, string>) =>
			readThrough(
				`require(${JSON.stringify(SEAM)}).sessionTree(${JSON.stringify(input)})`,
				at.shared,
				at.shared,
			);

		it("answers the linked worktree for a cwd inside it", () => {
			const sub = path.join(at.wt, "sub");
			fs.mkdirSync(sub);
			expect(readFromSession({ cwd: sub })).toBe("worktree\n");
		});

		it("answers the shared tree for a cwd that is the shared tree", () => {
			expect(readFromSession({ cwd: at.shared })).toBe("a\n");
		});

		it("answers the process's tree for an input naming no cwd", () => {
			expect(
				readThrough(
					`require(${JSON.stringify(SEAM)}).sessionTree({})`,
					at.wt,
					at.shared,
				),
			).toBe("worktree\n");
		});

		it("answers null for a cwd outside any repository, never the shared tree", () => {
			const outside = mkDirOutsideRepo("session-tree-");
			try {
				const r = spawnSync(
					process.execPath,
					[
						"-e",
						`process.stdout.write(String(require(${JSON.stringify(SEAM)}).sessionTree({ cwd: ${JSON.stringify(outside)} })))`,
					],
					{
						cwd: at.shared,
						encoding: "utf8",
						env: { ...process.env, CLAUDE_PROJECT_DIR: at.shared },
					},
				);
				expect(r.stdout).toBe("null");
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});
	});

	describe("resolveCommitHost, the JS half of hook-root.sh (#3830)", () => {
		const readFromCommitHost = (cwd: string, projectDir: string | undefined) =>
			readThrough(
				`require(${JSON.stringify(SEAM)}).resolveCommitHost()`,
				cwd,
				projectDir,
			);

		it("answers the shared tree from a linked worktree with CLAUDE_PROJECT_DIR unset", () => {
			expect(readFromCommitHost(at.wt, undefined)).toBe("a\n");
		});

		it("answers the shared tree where CLAUDE_PROJECT_DIR names another repository", () => {
			fs.writeFileSync(path.join(at.elsewhere, "a.md"), "elsewhere\n");
			expect(readFromCommitHost(at.wt, at.elsewhere)).toBe("a\n");
		});

		it("answers the main checkout for a CLAUDE_PROJECT_DIR sharing the common dir, the worktree itself included (#4493)", () => {
			expect(readFromCommitHost(at.wt, at.shared)).toBe("a\n");
			expect(readFromCommitHost(at.wt, at.wt)).toBe("a\n");
		});

		it("answers the top level of a plain checkout whose git directory sits elsewhere under the name .git", () => {
			const tree = path.join(dir, "septree");
			fs.mkdirSync(path.join(dir, "sep"));
			spawnSync("git", [
				"init",
				"-q",
				`--separate-git-dir=${path.join(dir, "sep", ".git")}`,
				tree,
			]);
			fs.writeFileSync(path.join(tree, "a.md"), "septree\n");
			expect(readFromCommitHost(tree, undefined)).toBe("septree\n");
		});

		/* The answer there may be a store the hook never reads (#3830, #3906). */
		it("answers the working directory in a bare repository, which has no top level, and says so on stderr", () => {
			const bare = path.join(dir, "bare.git");
			spawnSync("git", ["init", "-q", "--bare", bare]);
			fs.writeFileSync(path.join(bare, "a.md"), "bare\n");
			const r = spawnThrough(
				`require(${JSON.stringify(SEAM)}).resolveCommitHost()`,
				bare,
				undefined,
			);
			expect(r.stdout).toBe("bare\n");
			expect(r.stderr).toContain(
				`host-root: git named no top level for ${fs.realpathSync(bare)}`,
			);
		});

		it("says so on stderr from inside a git directory, where the answer is no store a hook reads", () => {
			const inside = path.join(at.shared, ".git");
			fs.writeFileSync(path.join(inside, "a.md"), "inside\n");
			const r = spawnThrough(
				`require(${JSON.stringify(SEAM)}).resolveCommitHost()`,
				inside,
				undefined,
			);
			expect(r.stdout).toBe("inside\n");
			expect(r.stderr).toContain("host-root: git named no top level");
		});
	});

	/* Each runner, launched bare in the worktree, finds `landing` on in the
	 * worktree's own config, which the shared tree lacks, and so selects its
	 * touched tests: none, spawning nothing. Rooted on the shared tree, it
	 * would read `landing` off and run as typed. In process, so the runner's
	 * root is computed afresh under the call's cwd and env. */
	const runBare = async (script: string) => {
		fs.mkdirSync(path.join(at.wt, ".claude"));
		fs.writeFileSync(
			path.join(at.wt, ".claude", "workflow-core.json"),
			JSON.stringify({
				contract: 1,
				founder: "t",
				modules: ["suites", "landing"],
			}),
		);
		const { WFC_MODULES: _m, ...env } = process.env;
		return runInProcessAsync(script, [], {
			cwd: at.wt,
			env: {
				...env,
				CLAUDE_PROJECT_DIR: at.shared,
				CLAUDE_CODE_SESSION_ID: "",
			},
		});
	};

	it.each([
		["run-vitest.js", RUN_VITEST],
		["run-pytest.js", RUN_PYTEST],
	])(
		"roots %s on the worktree it is launched in (#2940)",
		async (_, script) => {
			const r = await runBare(script);
			expect(r.stdout).toContain("NO TOUCHED TESTS");
			expect(r.status).toBe(0);
		},
	);
});
