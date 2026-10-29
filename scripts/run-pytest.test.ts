// @vitest-environment node
/*
 * The `npm run test:py` wrapper that leaves pytest's pre-push marker (mantahostels#1256).
 *
 * Run in process through runInProcessAsync (§X3), its python3 a fake injected at
 * WFC_PYTHON (§N7: the fake feeds chosen hand-offs) — all but the last case,
 * which spawns the wrapper as a script against a real pytest, and the module
 * cases on `lib/pytest-child.js`'s `runPytest`, which fire the ceiling on an
 * event (#3520).
 *
 * `.husky/pre-push` and `npm run push:check` read the certificate it leaves:
 * loosen a case and a red or dead run leaves one the push gate counts as
 * attesting.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshSandbox, ledger } from "./lib/arbiter-testkit";
import { runInProcessAsync } from "./lib/run-in-process";

const require = createRequire(import.meta.url);
const { readMarkers } = require("./lib/test-pass-marker.js");
const { CEILING_ENV, DEADLINE_ENV } = require("./lib/suite-ceiling.js");
const { pythonSpawnRemedy } = require("./lib/python-bin.js");
const { runPytest } = require("./lib/pytest-child.js");

const SCRIPT = path.join(__dirname, "run-pytest.js");

const dirs: string[] = [];

/* Each wait on an event here polls every 50 ms for up to 5 s, half the 10 s
 * test timeout, so an event that never comes fails on the case's own
 * assertion, not the timeout. */
const POLL_MS = 50;
const POLL_TRIES = 100;

/** Whether this machine can run the wrapper's real child: pytest plus xdist. */
function hasPytest(): boolean {
	return (
		spawnSync("python3", ["-m", "pytest", "-n", "0", "--version"], {
			encoding: "utf8",
		}).status === 0
	);
}

/** A git repo with one commit, so `readTreeSnapshot` and `repoRoot` both
 * answer: at `at`, else a fresh temp dir. */
function repo(at?: string) {
	const dir =
		at ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runpy-")));
	if (!at) dirs.push(dir);
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
	pid: number;
	deadline: string | null;
	grandchild?: number;
}

interface Hang {
	/** What it writes where the plugin keeps the tests in flight. */
	inflight?: unknown;
	/** Whether it forks a child of its own before hanging. */
	grandchild?: boolean;
}

/**
 * A stand-in for python, run as `python -m pytest …`: records its arguments,
 * the environment it was handed, the stdout it inherited and the deadline
 * file it found, writes `result` where the plugin would have written its
 * verdict, and exits on `status` — killing itself where `status` is null.
 * Given `hang`, it never exits at all, as a pytest past the ceiling.
 */
function fakePytest(
	result: unknown,
	status: number | null = 0,
	hang?: Hang,
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
const hang = ${JSON.stringify(hang ?? null)};
const deadlineFile = process.env.${DEADLINE_ENV};
const result = ${JSON.stringify(scopeOut)};
if (result !== null) fs.writeFileSync(process.env.WFC_PYTEST_SCOPE_OUT, result);
if (hang?.inflight !== undefined)
	fs.writeFileSync(process.env.WFC_PYTEST_INFLIGHT_OUT, JSON.stringify(hang.inflight));
// The wrapper writes the deadline once pytest has a pid; wait on that write
// rather than on the order of two processes starting (#3516). A hanging fake
// skips it, as it would spend the ceiling.
for (let i = 0; !hang && deadlineFile && !fs.existsSync(deadlineFile) && i < ${POLL_TRIES}; i++)
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${POLL_MS});
const grandchild = hang?.grandchild
	? require("node:child_process").spawn("sleep", ["60"], { stdio: "ignore" }).pid
	: undefined;
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({
	args: process.argv.slice(2),
	env: { PYTHONPATH: process.env.PYTHONPATH, WFC_PYTEST_SCOPE_OUT: process.env.WFC_PYTEST_SCOPE_OUT },
	stdout: { dev, ino },
	pid: process.pid,
	deadline: deadlineFile && fs.existsSync(deadlineFile) ? fs.readFileSync(deadlineFile, "utf8") : null,
	grandchild,
}) + "\\n");
if (hang) setInterval(() => {}, 1000);
else ${status === null ? 'process.kill(process.pid, "SIGKILL");' : `process.exitCode = ${status};`}
`,
		{ mode: 0o755 },
	);
	const readCalls = (): PytestCall[] =>
		fs.existsSync(callsFile)
			? fs
					.readFileSync(callsFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	return [bin, readCalls];
}

/** The wrapper run as `npm run test:py` runs it, rooted at `root`. */
function wrap(
	python: string,
	root: string,
	args: string[] = [],
	env: Record<string, string> = {},
) {
	return runInProcessAsync(SCRIPT, args, {
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
	it("passes the worker count and the plugin, then the caller's own arguments", async () => {
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, repo(), ["-k", "corpus"]);

		expect(readCalls()[0]?.args).toEqual([
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
	it("puts the host's scripts/ then the wrapper's own directory on PYTHONPATH, since conftest has not run yet when the plugin loads", async () => {
		const [python, readCalls] = fakePytest(undefined, 0);
		const root = repo();
		await wrap(python, root);

		const [call] = readCalls();
		const entries = call?.env.PYTHONPATH.split(path.delimiter) ?? [];
		const host = entries.indexOf(path.join(root, "scripts"));
		const own = entries.indexOf(__dirname);
		expect(host).toBeGreaterThanOrEqual(0);
		expect(own).toBeGreaterThan(host);
		expect(call?.env.WFC_PYTEST_SCOPE_OUT).toBeTruthy();
	});

	it("gives the child the terminal, so pytest's output is unchanged", async () => {
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, repo());
		const { dev, ino } = fs.fstatSync(1);
		expect(readCalls()[0]?.stdout).toEqual({ dev, ino });
	});
});

// A bare run under `landing` hands pytest the session's touched tests alone (#2934).
describe("a bare run under landing", () => {
	const Landing = { WFC_MODULES: "landing", CLAUDE_CODE_SESSION_ID: "" };

	/** The run ledger's lines at `root`. */
	const readLedger = (root: string) => {
		const file = path.join(root, ".claude/tmp/markers/.test-runs.jsonl");
		return fs.existsSync(file)
			? fs
					.readFileSync(file, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	};

	/** `repo(at)` holding a module, its test and an unrelated test, committed. */
	function pyRepo(at?: string) {
		const root = repo(at);
		fs.mkdirSync(path.join(root, "scripts"));
		for (const [f, text] of Object.entries({
			"scripts/scan.py": "X = 1\n",
			"scripts/test_scan.py": "import scan\n",
			"scripts/test_other.py": "import os\n",
			"README.md": "# r\n",
		}))
			fs.writeFileSync(path.join(root, f), text);
		for (const args of [
			["add", "."],
			["commit", "-qm", "files"],
		])
			spawnSync("git", args, { cwd: root });
		return root;
	}

	it("hands pytest exactly the touched test files", async () => {
		const root = pyRepo();
		fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
		const [python, readCalls] = fakePytest({ passed: true, scope: scope() }, 0);
		const r = await wrap(python, root, [], Landing);

		expect(readCalls()[0]?.args).toEqual([
			"-m",
			"pytest",
			"-n",
			"2",
			"-p",
			"pytest_pass_plugin",
			"scripts/test_scan.py",
		]);
		expect(r.stdout).toContain("TOUCHED TESTS ONLY");
		expect(r.status).toBe(0);
	});

	it("spawns nothing, exits 0 with the lander line and records no marker where nothing is touched", async () => {
		const root = pyRepo();
		fs.appendFileSync(path.join(root, "README.md"), "more\n");
		const [python, readCalls] = fakePytest({ passed: true, scope: scope() }, 0);
		const r = await wrap(python, root, [], Landing);

		expect(readCalls()).toEqual([]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("NO TOUCHED TESTS");
		expect(r.stdout).toContain("The lander runs the full suite");
		expect(readMarkers({ root })).toEqual([]);
		expect(readLedger(root)).toMatchObject([
			{ kind: "touched", suite: "pytest", resolvedFiles: 0 },
		]);
	});

	it("writes a touched ledger line carrying its file count on a touched run", async () => {
		const root = pyRepo();
		fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		await wrap(python, root, [], Landing);

		expect(readLedger(root)).toMatchObject([
			{ kind: "touched", suite: "pytest", resolvedFiles: 1 },
		]);
	});

	/* The write ledger, in the sandbox's config dir, says which dirt is whose. */
	describe("with a session id, in the shared tree", () => {
		const sb = freshSandbox();
		const Own = { ...Landing, CLAUDE_CODE_SESSION_ID: "me" };

		/** `pyRepo` at the sandbox, `scan.py` edited by this session and a
		 * neighbour's edit and new test beside it. */
		function sharedTree() {
			const root = pyRepo(fs.realpathSync(sb.repo));
			fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
			ledger.recordWrite(path.join(root, "scripts/scan.py"), "me");
			fs.appendFileSync(path.join(root, "scripts/test_other.py"), "X = 1\n");
			fs.writeFileSync(path.join(root, "scripts/test_new.py"), "import os\n");
			return root;
		}

		it("selects neither a neighbour's uncommitted edit nor its untracked test (#2958)", async () => {
			const root = sharedTree();
			const [python, readCalls] = fakePytest(
				{ passed: true, scope: scope() },
				0,
			);
			const r = await wrap(python, root, [], Own);

			expect(r.status).toBe(0);
			expect(readCalls()[0]?.args.slice(6)).toEqual(["scripts/test_scan.py"]);
		});

		it("still selects an untracked test of its own", async () => {
			const root = sharedTree();
			fs.writeFileSync(path.join(root, "scripts/test_mine.py"), "import os\n");
			ledger.recordWrite(path.join(root, "scripts/test_mine.py"), "me");
			const [python, readCalls] = fakePytest(
				{ passed: true, scope: scope() },
				0,
			);
			await wrap(python, root, [], Own);

			expect(readCalls()[0]?.args.slice(6)).toEqual([
				"scripts/test_mine.py",
				"scripts/test_scan.py",
			]);
		});
	});

	it("refuses, spawning nothing, where the changed paths cannot be read", async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "runpy-nogit-")),
		);
		dirs.push(root);
		const [python, readCalls] = fakePytest({ passed: true, scope: scope() }, 0);
		const r = await wrap(python, root, [], Landing);

		expect(readCalls()).toEqual([]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("NARROWING FAILED, SO NOTHING RAN");
	});

	it("refuses, spawning nothing, where the session's own work cannot be read", async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "runpy-nogit-")),
		);
		dirs.push(root);
		const [python, readCalls] = fakePytest({ passed: true, scope: scope() }, 0);
		const r = await wrap(python, root, [], {
			...Landing,
			CLAUDE_CODE_SESSION_ID: "me",
		});

		expect(readCalls()).toEqual([]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("this session's own work could not be read");
	});

	it("runs the whole suite as before with landing off", async () => {
		const root = pyRepo();
		fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
		const [python, readCalls] = fakePytest(undefined, 0);
		const r = await wrap(python, root, [], {
			...Landing,
			WFC_MODULES: "suites",
		});

		expect(readCalls()[0]?.args.slice(6)).toEqual([]);
		expect(r.stdout).not.toContain("TOUCHED TESTS");
	});

	it("runs the whole suite on `--full`, handing pytest no `--full` (#3508)", async () => {
		const root = pyRepo();
		const [python, readCalls] = fakePytest(undefined, 0);
		const r = await wrap(python, root, ["--full"], Landing);

		expect(readCalls()[0]?.args.slice(6)).toEqual([]);
		expect(r.stdout).not.toContain("TOUCHED TESTS");
	});

	it("hands pytest a `--full` that has other words beside it", async () => {
		const root = pyRepo();
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, root, ["--full", "-k", "corpus"], Landing);

		expect(readCalls()[0]?.args.slice(6)).toEqual(["--full", "-k", "corpus"]);
	});

	it("passes typed arguments through unchanged", async () => {
		const root = pyRepo();
		fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, root, ["-k", "corpus"], Landing);

		expect(readCalls()[0]?.args.slice(6)).toEqual(["-k", "corpus"]);
	});
});

describe("the exit code", () => {
	it("is the child's own, so a red pytest run is still red", async () => {
		const [python] = fakePytest({ passed: false, scope: null }, 1);
		expect((await wrap(python, repo())).status).toBe(1);
	});

	it("is zero on a green run", async () => {
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		expect((await wrap(python, repo())).status).toBe(0);
	});

	it("is 1 where the child was killed by a signal and has no status", async () => {
		const [python] = fakePytest(undefined, null);
		expect((await wrap(python, repo())).status).toBe(1);
	});
});

describe("the marker it records", () => {
	it("stamps HEAD, the scope and the suite on a green run", async () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		await wrap(python, root);

		const markers = readMarkers({ root });
		expect(markers).toHaveLength(1);
		expect(markers[0].suite).toBe("pytest");
		expect(markers[0].scope.modulesTotal).toBe(20);
		expect(markers[0].sha).toMatch(/^[0-9a-f]{40}$/);
		expect(markers[0].dirtyAtStart).toBe(false);
		// pytest has no `--isolated` path: every run reads the shared tree.
		expect(markers[0].isolated).toBe(false);
		expect(markers[0].treeAtEnd).toMatch(/^[0-9a-f]{40}$/);
	});

	it("records nothing on a red run", async () => {
		const root = repo();
		const [python] = fakePytest({ passed: false, scope: scope() }, 1);
		await wrap(python, root);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("records nothing where pytest exited non-zero, however green the plugin said it was", async () => {
		const root = repo();
		// `pytest_terminal_summary` runs before teardown and interpreter
		// shutdown, so an INTERNALERROR after it — or earlyoom killing python
		// between the two — leaves `passed: true` behind a non-zero exit.
		const [python] = fakePytest({ passed: true, scope: scope() }, 3);
		expect((await wrap(python, root)).status).toBe(3);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("records nothing where the plugin never wrote a verdict", async () => {
		const root = repo();
		const [python] = fakePytest(undefined, 0);
		await wrap(python, root);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("records a certificate whose scope the plugin could not read, as unknown", async () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: null }, 0);
		await wrap(python, root);

		const [marker] = readMarkers({ root });
		expect(marker.suite).toBe("pytest");
		expect(marker.scope).toBeUndefined();
	});

	it("notices the tree was dirty when the run began", async () => {
		const root = repo();
		fs.writeFileSync(path.join(root, "tracked.txt"), "x");
		spawnSync("git", ["add", "tracked.txt"], { cwd: root });
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		await wrap(python, root);

		const [marker] = readMarkers({ root });
		expect(marker.dirtyAtStart).toBe(true);
		expect(marker.dirtyCount).toBe(1);
	});
});

describe("what it says out loud", () => {
	it("names a pytest it could not run at all", async () => {
		const root = repo();
		const r = await wrap(path.join(root, "no-such-python"), root);
		expect(r.stderr).toContain("pytest could not be run");
		expect(r.stderr).toContain("ENOENT");
		expect(r.stderr).toContain("no-such-python");
		expect(r.stderr).toContain("WFC_PYTHON");
		expect(r.stderr).toContain("requirements-dev.txt");
		expect(r.status).toBe(1);
	});

	it("tells a python it may not execute from a missing one", async () => {
		const root = repo();
		const python = path.join(root, "unexecutable-python");
		fs.writeFileSync(python, "#!/bin/sh\n", { mode: 0o644 });
		const r = await wrap(python, root);
		expect(r.stderr).toContain("EACCES");
		expect(r.stderr).toContain("not executable by you");
		expect(r.stderr).not.toContain("Install python3");
		expect(r.status).toBe(1);
	});

	// EAGAIN cannot be provoked without exhausting the machine's process
	// table, so each code's advice is pinned on the remedy itself.
	const Remedies = [
		["ENOENT", "Install python3"],
		["EACCES", "not executable by you"],
		["EAGAIN", "retry once other runs have ended"],
	];
	it.each(Remedies)(
		"advises on %s with its own remedy alone (#3120)",
		(code, remedy) => {
			const said = pythonSpawnRemedy(
				Object.assign(new Error(`spawn python3 ${code}`), { code }),
			);
			expect(said).toContain(remedy);
			for (const [, other] of Remedies)
				if (other !== remedy) expect(said).not.toContain(other);
		},
	);

	it("offers no remedy for a spawn failure none fits", () => {
		expect(
			pythonSpawnRemedy(
				Object.assign(new Error("spawn python3 EMFILE"), { code: "EMFILE" }),
			),
		).toBe("");
	});

	it("prints what a narrowed run covered, at the terminal rather than at the push", async () => {
		const [python] = fakePytest(
			{
				passed: true,
				scope: scope({ modulesRun: 1, nameFilter: "-k corpus" }),
			},
			0,
		);
		const said = (await wrap(python, repo())).stdout;
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
			const checkout = path.join(__dirname, "..");
			// spawn-kept: a real fd — pytest inherits stdio, writing past runInProcess.
			const r = spawnSync(process.execPath, [SCRIPT, "--collect-only", "-q"], {
				encoding: "utf8",
				cwd: checkout,
				env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
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
	const parseCostLines = (stdout: string) =>
		stdout.split("\n").filter((l) => l.startsWith("RUN COST:"));

	it("names a new file over budget in worker-seconds, marks a pre-existing one, and skips an unchanged file", async () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(timed(root)), 0);
		const r = await wrap(python, root, [], noCi);

		expect(r.status).toBe(0);
		const lines = parseCostLines(r.stdout);
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

	it("prints after a red run too, and the exit code stays the suite's own", async () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(timed(root), false), 1);
		const r = await wrap(python, root, [], noCi);

		expect(r.status).toBe(1);
		expect(parseCostLines(r.stdout)[0]).toContain(
			"scripts/test_new.py took 42.3",
		);
	});

	it("turns timings it cannot read into one fail-open line, and the suite's green stands", async () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(null), 0);
		const r = await wrap(python, root, [], noCi);

		expect(r.status).toBe(0);
		expect(parseCostLines(r.stdout)).toEqual([
			expect.stringMatching(
				/^RUN COST: the report failed and printed nothing else; the suite's verdict stands/,
			),
		]);
		expect(readMarkers({ root })).toHaveLength(1);
	});

	it("prints nothing where the plugin handed over no timings", async () => {
		const root = changedRepo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		expect(parseCostLines((await wrap(python, root, [], noCi)).stdout)).toEqual(
			[],
		);
	});
});

describe("the hand-off file", () => {
	it("is deleted whether or not it parsed, and an unreadable one records nothing", async () => {
		const root = repo();
		const [python, readCalls] = fakePytest("{not json", 0);
		expect((await wrap(python, root)).status).toBe(0);

		const handOff = readCalls()[0]?.env.WFC_PYTEST_SCOPE_OUT ?? "";
		expect(handOff).not.toBe("");
		expect(fs.existsSync(path.dirname(handOff))).toBe(false);
		expect(readMarkers({ root })).toEqual([]);
	});

	it("is deleted after a verdict is read from it", async () => {
		const [python, readCalls] = fakePytest({ passed: true, scope: scope() }, 0);
		await wrap(python, repo());
		const handOff = readCalls()[0]?.env.WFC_PYTEST_SCOPE_OUT ?? "";
		expect(handOff).not.toBe("");
		expect(fs.existsSync(path.dirname(handOff))).toBe(false);
	});
});

// The fake hangs past the ceiling. Each case waits on the kill itself,
// not on elapsed time (docs/practice/test-design-and-reliability.md).
describe("the suite ceiling (#2702)", () => {
	/** Lowered still, but far past any fake's exit. */
	const FarCeiling = "60000";
	const lowered = (dir: string) => ({
		[CEILING_ENV]: "1000",
		[DEADLINE_ENV]: path.join(dir, "deadline"),
	});

	/** Whether `pid` has gone, polled since init reaps it on its own clock. */
	async function gone(pid: number): Promise<boolean> {
		for (let i = 0; i < POLL_TRIES; i++) {
			try {
				process.kill(pid, 0);
			} catch {
				return true;
			}
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		return false;
	}

	/**
	 * `runPytest` with its ceiling fired once the hanging fake has recorded
	 * its call, so the kill never races node's start (#3520). Unrecorded once
	 * the poll runs out, it fires anyway, for the assertions to name what is
	 * missing.
	 */
	async function killedOnceRecorded(
		python: string,
		readCalls: () => PytestCall[],
		root: string,
	) {
		for (const [key, value] of Object.entries({
			...lowered(root),
			WFC_PYTHON: python,
		}))
			vi.stubEnv(key, value);
		/* A line read mid-append is no record yet. */
		const recorded = () => {
			try {
				return readCalls().length > 0;
			} catch {
				return false;
			}
		};
		const schedule = (fire: () => void) => {
			let tries = 0;
			const poll = () => {
				if (recorded() || ++tries >= POLL_TRIES) fire();
				else timer = setTimeout(poll, POLL_MS);
			};
			let timer = setTimeout(poll, 0);
			return () => clearTimeout(timer);
		};
		/* runInProcessAsync captures a whole program's streams; this is one
		 * module call. */
		const stderr: Buffer[] = [];
		const realWriteSync = fs.writeSync;
		const spy = vi
			.spyOn(fs, "writeSync")
			.mockImplementation((fd, data, ...rest) => {
				if (fd !== 2)
					// biome-ignore lint/suspicious/noExplicitAny: passthrough to the real overloaded call
					return (realWriteSync as any)(fd, data, ...rest);
				// writeFd hands over a Buffer and the offset it has written up to.
				const chunk = (data as unknown as Buffer).subarray(
					(rest[0] as number) ?? 0,
				);
				stderr.push(chunk);
				return chunk.length;
			});
		try {
			const result = await runPytest([], root, {
				handOff: path.join(root, "scope.json"),
				inflightFile: path.join(root, "inflight.json"),
				schedule,
			});
			return { ...result, stderr: Buffer.concat(stderr).toString("utf8") };
		} finally {
			spy.mockRestore();
		}
	}

	it("kills pytest and its children and forces the run red, though the plugin said green", async () => {
		const root = repo();
		const [python, readCalls] = fakePytest(
			{ passed: true, scope: scope() },
			0,
			{
				grandchild: true,
				inflight: { open: [], finished: 0, collected: 0 },
			},
		);
		const r = await killedOnceRecorded(python, readCalls, root);

		expect(r.forcedRed).toBe(true);
		expect(r.stderr).toContain("SUITE CEILING");
		expect(fs.existsSync(lowered(root)[DEADLINE_ENV])).toBe(false);
		const [call] = readCalls();
		expect(call?.pid).toBeTypeOf("number");
		expect(call?.grandchild).toBeTypeOf("number");
		expect(await gone(call?.pid as number)).toBe(true);
		expect(await gone(call?.grandchild as number)).toBe(true);
	});

	it("names the tests pytest reported in flight with their stage, how many never started and how many finished", async () => {
		const root = repo();
		const [python, readCalls] = fakePytest(undefined, 0, {
			inflight: {
				open: [{ nodeid: "scripts/test_slow.py::test_crawls", stage: "call" }],
				finished: 41,
				collected: 50,
			},
		});
		const r = await killedOnceRecorded(python, readCalls, root);

		expect(r.stderr).toMatch(/at the 1\.0s ceiling \(#2667\)/);
		expect(r.stderr).toContain(
			"In flight:\n  scripts/test_slow.py::test_crawls — call",
		);
		expect(r.stderr).toContain("Never started: 8 test(s).");
		expect(r.stderr).toContain("Finished: 41 test(s).");
	});

	it("says the never-started count is unavailable where pytest reported no collected count", async () => {
		const root = repo();
		const [python, readCalls] = fakePytest(undefined, 0, {
			inflight: { open: [], finished: 3, collected: null },
		});
		const r = await killedOnceRecorded(python, readCalls, root);

		expect(r.stderr).toContain("Never started: unavailable");
		expect(r.stderr).toContain("Finished: 3 test(s).");
	});

	/* The whole wrapper on the real 1 s timer, which none of these can lose: a
	 * fake killed before it starts writes no verdict and reports no tests in
	 * flight. RESIDUAL: such a kill leaves the green case unable to tell a
	 * green verdict refused from none written. */
	it("exits 1 and records no marker on a ceiling kill, though the plugin said green", async () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0, {});
		const r = await wrap(python, root, [], lowered(root));

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("SUITE CEILING");
		expect(readMarkers({ root })).toEqual([]);
	});

	it("says the list is unavailable where pytest reported none", async () => {
		const root = repo();
		const [python] = fakePytest(undefined, 0, {});
		const r = await wrap(python, root, [], lowered(root));

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("so the list is unavailable");
		expect(r.stderr).not.toContain("In flight:");
	});

	it("writes the deadline and pytest's group where the environment names a file, and drops it once the run settles", async () => {
		const root = repo();
		// No kill to race the fake's record (#3516).
		const env = {
			[CEILING_ENV]: FarCeiling,
			[DEADLINE_ENV]: path.join(root, "deadline"),
		};
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, root, [], env);

		const [call] = readCalls();
		expect(call?.deadline).toMatch(new RegExp(`^\\d+ ${call?.pid}\\n$`));
		expect(fs.existsSync(env[DEADLINE_ENV])).toBe(false);
	});

	it("leaves a run that closes inside the ceiling its own verdict", async () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		const r = await wrap(python, root, [], { [CEILING_ENV]: FarCeiling });

		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("SUITE CEILING");
		expect(readMarkers({ root })).toHaveLength(1);
	});
});

describe("the task cap (#3401)", () => {
	const { probeUserScope } = require("./lib/user-scope.js");

	/** This process's test-run scopes the manager still has. */
	const units = () =>
		spawnSync(
			"systemctl",
			[
				"--user",
				"list-units",
				"--all",
				"--no-legend",
				`wfc-test-${process.pid}-*`,
			],
			{ encoding: "utf8" },
		).stdout.trim();
	const running = (needle: string) =>
		(spawnSync("pgrep", ["-f", needle], { encoding: "utf8" }).stdout ?? "")
			.split("\n")
			.filter(Boolean);

	it.skipIf(probeUserScope().length === 0)(
		"stops a fork chain at the cap, fails the run naming it, and leaves nothing in the scope running",
		async () => {
			const root = repo();
			const dir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "forkchain-")),
			);
			dirs.push(dir);
			/* Each link starts the next, then sleeps; at the cap a fork is
			 * refused and the chain stops growing. The first leaves pytest's
			 * process group, so only the scope's kill can reach the chain. */
			const link = path.join(dir, "link.sh");
			fs.writeFileSync(link, '#!/bin/sh\n"$0" &\nsleep 30\n', {
				mode: 0o755,
			});
			const python = path.join(dir, "python3");
			fs.writeFileSync(
				python,
				`#!/bin/sh\nsetsid ${JSON.stringify(link)} &\nsleep 1\n`,
				{ mode: 0o755 },
			);

			const r = await wrap(python, root, ["-q"], { WFC_RUN_TASKS_MAX: "16" });

			expect(r.status).toBe(1);
			expect(r.stderr).toContain("TASK CAP");
			expect(r.stderr).toContain("cap at 16 tasks");
			expect(readMarkers({ root })).toHaveLength(0);
			/* cgroup.kill's SIGKILLs land asynchronously; 5 s is a guess. */
			for (let i = 0; i < 50 && (running(dir).length > 0 || units()); i++)
				await new Promise((done) => setTimeout(done, 100));
			expect(running(dir)).toEqual([]);
			expect(units()).toBe("");
		},
	);
});
