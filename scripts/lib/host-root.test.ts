// @vitest-environment node
/*
 * Pins `worktreeRoot()` (#2940): a test run launched inside a linked worktree
 * reads that worktree's files, though the harness points `CLAUDE_PROJECT_DIR`
 * at the shared tree. The seam's cases read `a.md` through the resolved root,
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
import { defineTemplate, mkScratchDir, trioTemplate } from "./git-fixture";
import { runInProcessAsync } from "./run-in-process";

const SEAM = path.join(__dirname, "host-root.js");
const RUN_VITEST = path.join(__dirname, "..", "run-vitest.js");
const RUN_PYTEST = path.join(__dirname, "..", "run-pytest.js");

const template = defineTemplate(trioTemplate());

describe("worktreeRoot", () => {
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
	const readThrough = (
		expr: string,
		cwd: string,
		projectDir: string | undefined,
	) => {
		const { CLAUDE_PROJECT_DIR: _, ...env } = process.env;
		const r = spawnSync(
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
