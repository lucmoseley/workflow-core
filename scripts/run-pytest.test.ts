// @vitest-environment node
/*
 * The `npm run test:py` wrapper that leaves pytest's pre-push marker (mantahostels#1256).
 *
 * Run in process through runInProcess (§X3), its python3 a fake injected at
 * WFC_PYTHON (§N7: the fake feeds chosen hand-offs) — all but the last case,
 * which spawns the wrapper as a script against a real pytest.
 *
 * `.husky/pre-push` and `npm run push:check` read the marker it leaves: loosen
 * a case and a red or dead pytest run is recorded green, so a push is counted
 * covered for Python tests that never passed on its sha.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const require = createRequire(import.meta.url);
const { readMarkers } = require("./lib/test-pass-marker.js");

const SCRIPT = path.join(__dirname, "run-pytest.js");

const dirs: string[] = [];

/** Whether this machine can run the wrapper's real child: pytest plus xdist. */
function hasPytest(): boolean {
	return (
		spawnSync("python3", ["-m", "pytest", "-n", "0", "--version"], {
			encoding: "utf8",
		}).status === 0
	);
}

/** A git repo with one commit, so `snapshot` and `repoRoot` both answer. */
function repo() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runpy-")));
	dirs.push(dir);
	for (const args of [
		["init", "-q"],
		["config", "user.email", "t@example.com"],
		["config", "user.name", "t"],
		["commit", "-q", "--allow-empty", "-m", "root"],
	])
		spawnSync("git", args, { cwd: dir });
	return dir;
}

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const scope = (over: Record<string, unknown> = {}) => ({
	modulesRun: 20,
	modulesTotal: 20,
	tests: 616,
	passed: 616,
	skipped: 0,
	failed: 0,
	nameFilter: null,
	fileFilters: [],
	...over,
});

interface PytestCall {
	args: string[];
	env: { PYTHONPATH: string; WFC_PYTEST_SCOPE_OUT?: string };
	stdout: { dev: number; ino: number };
}

/**
 * A stand-in for python, run as `python -m pytest …`: records its arguments,
 * the environment it was handed and the stdout it inherited, writes `result`
 * where the plugin would have written its verdict, and exits on `status` —
 * killing itself where `status` is null.
 */
function fakePytest(
	result: unknown,
	status: number | null = 0,
): [string, () => PytestCall[]] {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "fakepy-")),
	);
	dirs.push(dir);
	const callsFile = path.join(dir, "calls.jsonl");
	const bin = path.join(dir, "python3");
	let scopeOut: string | null = null;
	if (result !== undefined)
		scopeOut = typeof result === "string" ? result : JSON.stringify(result);
	fs.writeFileSync(
		bin,
		`#!${process.execPath}
const fs = require("node:fs");
const { dev, ino } = fs.fstatSync(1);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({
	args: process.argv.slice(2),
	env: { PYTHONPATH: process.env.PYTHONPATH, WFC_PYTEST_SCOPE_OUT: process.env.WFC_PYTEST_SCOPE_OUT },
	stdout: { dev, ino },
}) + "\\n");
const result = ${JSON.stringify(scopeOut)};
if (result !== null) fs.writeFileSync(process.env.WFC_PYTEST_SCOPE_OUT, result);
${status === null ? 'process.kill(process.pid, "SIGKILL");' : `process.exitCode = ${status};`}
`,
		{ mode: 0o755 },
	);
	const calls = (): PytestCall[] =>
		fs.existsSync(callsFile)
			? fs
					.readFileSync(callsFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	return [bin, calls];
}

/** The wrapper run as `npm run test:py` runs it, rooted at `root`. */
function wrap(
	python: string,
	root: string,
	args: string[] = [],
	env: Record<string, string> = {},
) {
	return runInProcess(SCRIPT, args, {
		cwd: root,
		env: {
			...process.env,
			WFC_PYTHON: python,
			CLAUDE_PROJECT_DIR: root,
			...env,
		},
	});
}

describe("what it hands pytest", () => {
	it("passes the worker count and the plugin, then the caller's own arguments", () => {
		const [python, calls] = fakePytest(undefined, 0);
		wrap(python, repo(), ["-k", "corpus"]);

		expect(calls()[0]?.args).toEqual([
			"-m",
			"pytest",
			"-n",
			"2",
			"-p",
			"pytest_pass_plugin",
			"-k",
			"corpus",
		]);
	});

	// `root` is a temp repo here, so the host's `scripts/` and the wrapper's own
	// directory differ, as in a plugin install, where only the second holds the
	// plugin (#1285).
	it("puts the host's scripts/ then the wrapper's own directory on PYTHONPATH, since conftest has not run yet when the plugin loads", () => {
		const [python, calls] = fakePytest(undefined, 0);
		const root = repo();
		wrap(python, root);

		const [call] = calls();
		const entries = call?.env.PYTHONPATH.split(path.delimiter) ?? [];
		const host = entries.indexOf(path.join(root, "scripts"));
		const own = entries.indexOf(__dirname);
		expect(host).toBeGreaterThanOrEqual(0);
		expect(own).toBeGreaterThan(host);
		expect(call?.env.WFC_PYTEST_SCOPE_OUT).toBeTruthy();
	});

	it("gives the child the terminal, so pytest's output is unchanged", () => {
		const [python, calls] = fakePytest(undefined, 0);
		wrap(python, repo());
		const { dev, ino } = fs.fstatSync(1);
		expect(calls()[0]?.stdout).toEqual({ dev, ino });
	});
});

describe("the exit code", () => {
	it("is the child's own, so a red pytest run is still red", () => {
		const [python] = fakePytest({ passed: false, scope: null }, 1);
		expect(wrap(python, repo()).status).toBe(1);
	});

	it("is zero on a green run", () => {
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		expect(wrap(python, repo()).status).toBe(0);
	});

	it("is 1 where the child was killed by a signal and has no status", () => {
		const [python] = fakePytest(undefined, null);
		expect(wrap(python, repo()).status).toBe(1);
	});
});

describe("the marker it records", () => {
	it("stamps HEAD, the scope and the suite on a green run", () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		wrap(python, root);

		const markers = readMarkers({ root });
		expect(markers).toHaveLength(1);
		expect(markers[0].suite).toBe("pytest");
		expect(markers[0].scope.modulesTotal).toBe(20);
		expect(markers[0].sha).toMatch(/^[0-9a-f]{40}$/);
		expect(markers[0].dirtyAtStart).toBe(false);
		// pytest has no `--isolated` path: every run reads the shared tree, so
		// this is always false rather than unknown.
		expect(markers[0].isolated).toBe(false);
		expect(markers[0].treeAtEnd).toMatch(/^[0-9a-f]{40}$/);
	});

	it("records nothing on a red run", () => {
		const root = repo();
		const [python] = fakePytest({ passed: false, scope: scope() }, 1);
		wrap(python, root);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("records nothing where pytest exited non-zero, however green the plugin said it was", () => {
		const root = repo();
		// `pytest_terminal_summary` runs before teardown and interpreter
		// shutdown, so an INTERNALERROR after it — or earlyoom killing python
		// between the two — leaves `passed: true` behind a non-zero exit.
		const [python] = fakePytest({ passed: true, scope: scope() }, 3);
		expect(wrap(python, root).status).toBe(3);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("records nothing where the plugin never wrote a verdict", () => {
		const root = repo();
		const [python] = fakePytest(undefined, 0);
		wrap(python, root);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("records a green whose scope the plugin could not read, as unknown", () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: null }, 0);
		wrap(python, root);

		const [marker] = readMarkers({ root });
		expect(marker.suite).toBe("pytest");
		expect(marker.scope).toBeUndefined();
	});

	it("notices the tree was dirty when the run began", () => {
		const root = repo();
		fs.writeFileSync(path.join(root, "tracked.txt"), "x");
		spawnSync("git", ["add", "tracked.txt"], { cwd: root });
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		wrap(python, root);

		const [marker] = readMarkers({ root });
		expect(marker.dirtyAtStart).toBe(true);
		expect(marker.dirtyCount).toBe(1);
	});
});

describe("what it says out loud", () => {
	it("names a pytest it could not run at all, which the shell used to report", () => {
		const root = repo();
		const r = wrap(path.join(root, "no-such-python"), root);
		expect(r.stderr).toContain("pytest could not be run");
		expect(r.stderr).toContain("ENOENT");
		expect(r.stderr).toContain("no-such-python");
		expect(r.stderr).toContain("WFC_PYTHON");
		expect(r.stderr).toContain("requirements-dev.txt");
		expect(r.status).toBe(1);
	});

	it("prints what a narrowed run covered, at the terminal rather than at the push", () => {
		const [python] = fakePytest(
			{
				passed: true,
				scope: scope({ modulesRun: 1, nameFilter: "-k corpus" }),
			},
			0,
		);
		const said = wrap(python, repo()).stdout;
		expect(said).toContain("FILTERED RUN");
		expect(said).toContain("1 of 20 files");
		// pytest's filter arrives carrying its own flag; vitest's `-t` prefix
		// would print `-t -k corpus`.
		expect(said).toContain("-k corpus");
		expect(said).not.toContain("-t -k");
	});

	// Needs a real pytest WITH xdist, since the wrapper passes `-n 2`. The dev
	// machine has both from requirements-dev.txt; the `Lint and tests` CI job has
	// neither — it is a Node job with no setup-python and no pip install. It is
	// skipped there because the `Python` job drives the same wrapper as a
	// process for real, via `npm run test:py`.
	it.skipIf(!hasPytest())(
		"runs as a script, passing its arguments through to a real pytest",
		() => {
			// `--collect-only` runs no tests and records no marker.
			const r = spawnSync(process.execPath, [SCRIPT, "--collect-only", "-q"], {
				encoding: "utf8",
				cwd: path.join(__dirname, ".."),
			});
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toContain("test_pytest_pass_plugin.py");
		},
		60_000,
	);
});

// Timings come through the fake's hand-off (base §X9). `repo()` has no
// origin/main, so the base is HEAD.
describe("the run-cost report (#1884)", () => {
	function changedRepo() {
		const root = repo();
		const scripts = path.join(root, "scripts");
		fs.mkdirSync(scripts);
		for (const name of ["test_old.py", "test_same.py"])
			fs.writeFileSync(path.join(scripts, name), "");
		spawnSync("git", ["add", "."], { cwd: root });
		spawnSync("git", ["commit", "-qm", "base"], { cwd: root });
		fs.writeFileSync(path.join(scripts, "test_old.py"), "# edited");
		for (const name of ["test_new.py", "test_quick.py"])
			fs.writeFileSync(path.join(scripts, name), "");
		return root;
	}

	const timed = (root: string) =>
		Object.fromEntries(
			Object.entries({
				"test_new.py": 42.25,
				"test_old.py": 12,
				"test_quick.py": 0.5,
				"test_same.py": 99,
			}).map(([file, s]) => [path.join(root, "scripts", file), s]),
		);
	const handOff = (fileSeconds: unknown, passed = true) => ({
		passed,
		scope: scope(),
		fileSeconds,
	});
	const noCi = { CI: "" };
	const costLines = (stdout: string) =>
		stdout.split("\n").filter((l) => l.startsWith("RUN COST:"));

	it("names a new file over budget in worker-seconds, marks a pre-existing one, and skips an unchanged file", () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(timed(root)), 0);
		const r = wrap(python, root, [], noCi);

		expect(r.status).toBe(0);
		const lines = costLines(r.stdout);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(
			/^RUN COST: scripts\/test_new\.py took 42\.3 worker-seconds, over the 10 s budget — new since HEAD/,
		);
		expect(lines[1]).toMatch(
			/^RUN COST: scripts\/test_old\.py took 12\.0 worker-seconds, .* pre-existing at HEAD/,
		);
		expect(lines[2]).toMatch(/^RUN COST: 2 of 3 new or changed test file/);
		expect(r.stdout).not.toContain("test_same.py");
	});

	it("prints after a red run too, and the exit code stays the suite's own", () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(timed(root), false), 1);
		const r = wrap(python, root, [], noCi);

		expect(r.status).toBe(1);
		expect(costLines(r.stdout)[0]).toContain("scripts/test_new.py took 42.3");
	});

	it("turns timings it cannot read into one fail-open line, and the suite's green stands", () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(null), 0);
		const r = wrap(python, root, [], noCi);

		expect(r.status).toBe(0);
		expect(costLines(r.stdout)).toEqual([
			expect.stringMatching(
				/^RUN COST: the report failed and printed nothing else; the suite's verdict stands/,
			),
		]);
		expect(readMarkers({ root })).toHaveLength(1);
	});

	it("prints nothing where the plugin handed over no timings", () => {
		const root = changedRepo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		expect(costLines(wrap(python, root, [], noCi).stdout)).toEqual([]);
	});
});

describe("the hand-off file", () => {
	it("is deleted whether or not it parsed, and an unreadable one records nothing", () => {
		const root = repo();
		const [python, calls] = fakePytest("{not json", 0);
		expect(wrap(python, root).status).toBe(0);

		const handOff = calls()[0]?.env.WFC_PYTEST_SCOPE_OUT ?? "";
		expect(handOff).not.toBe("");
		expect(fs.existsSync(path.dirname(handOff))).toBe(false);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("is deleted after a verdict is read from it", () => {
		const [python, calls] = fakePytest({ passed: true, scope: scope() }, 0);
		wrap(python, repo());
		const handOff = calls()[0]?.env.WFC_PYTEST_SCOPE_OUT ?? "";
		expect(handOff).not.toBe("");
		expect(fs.existsSync(path.dirname(handOff))).toBe(false);
	});
});
