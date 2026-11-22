// @vitest-environment node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { tmpRootWithMarkers } from "./lib/admission-testkit";
import { freshSandbox, ledger } from "./lib/arbiter-testkit";
import { keptSpawn } from "./lib/kept-spawn.js";
import { runInProcessAsync } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { restoreStderr, spyStderr } from "./lib/write-fd-testkit";

const require = createRequire(import.meta.url);
const { readFailures, readMarkers } = require("./lib/test-pass-marker.js");
const { CEILING_ENV, DEADLINE_ENV } = require("./lib/suite-ceiling.js");
const { pythonSpawnRemedy } = require("./lib/python-bin.js");
const { runPytest, ceilingKillRow } = require("./lib/pytest-child.js");

const SCRIPT = path.join(__dirname, "run-pytest.js");

const dirs: string[] = [];

// #3520 guess: 100 polls span half the 10 s test timeout
const POLL_MS = 50;
const POLL_TRIES = 100;

function hasPytest(): boolean {
	return (
		spawnSync("python3", ["-m", "pytest", "-n", "0", "--version"], {
			encoding: "utf8",
		}).status === 0
	);
}

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
	inflight?: unknown;
	grandchild?: boolean;
}

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

function wrap(
	python: string,
	root: string,
	args: string[] = ["--full"],
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

describe("a bare run", () => {
	const Bare = { WFC_MODULES: "", CLAUDE_CODE_SESSION_ID: "" };

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
		const r = await wrap(python, root, [], Bare);

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
		const r = await wrap(python, root, [], Bare);

		expect(readCalls()).toEqual([]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("NO TOUCHED TESTS");
		expect(r.stdout).toContain("The lander runs the full suite");
		expect(readMarkers({ root })).toEqual([]);
		expect(readLedger(root)).toMatchObject([
			{
				kind: "touched",
				suite: "pytest",
				resolvedFiles: 0,
				touchedBase: "merge-base",
			},
		]);
	});

	it("writes a touched ledger line carrying its file count on a touched run", async () => {
		const root = pyRepo();
		fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		await wrap(python, root, [], Bare);

		expect(readLedger(root)).toMatchObject([
			{ kind: "touched", suite: "pytest", resolvedFiles: 1 },
		]);
	});

	describe("selects from HEAD only inside a live commit-gate seat (#5320, #5273)", () => {
		function branch() {
			const root = pyRepo();
			spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], {
				cwd: root,
			});
			fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
			spawnSync("git", ["commit", "-qam", "own"], { cwd: root });
			fs.appendFileSync(path.join(root, "scripts/test_other.py"), "# edit\n");
			return root;
		}
		function tempRoot(holder: number) {
			const dir = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "runpy-tmp-")),
			);
			dirs.push(dir);
			return tmpRootWithMarkers(dir, [], [{ pid: holder, spawned: true }]);
		}

		it("takes `head` inside a fixture gate seat, and its certificate's scope names it", async () => {
			const root = branch();
			const [python, readCalls] = fakePytest(
				{ passed: true, scope: scope() },
				0,
			);
			const r = await wrap(python, root, [], {
				...Bare,
				TMPDIR: tempRoot(process.pid),
			});
			expect(readCalls()[0]?.args.slice(-1)).toEqual(["scripts/test_other.py"]);
			expect(r.stdout).toContain("this commit's changes over HEAD");
			expect(readMarkers({ root })[0].scope).toMatchObject({
				touched: true,
				touchedBase: "head",
			});
		});

		it("records `head` on a gate run's ceiling kill, which carries no scope (#5321)", async () => {
			const root = branch();
			const [python] = fakePytest({ passed: true, scope: scope() }, 0, {});
			await wrap(python, root, [], {
				...Bare,
				TMPDIR: tempRoot(process.pid),
				[CEILING_ENV]: "1000",
				[DEADLINE_ENV]: path.join(root, "deadline"),
			});
			expect(readFailures({ root })).toEqual([
				expect.objectContaining({ ceilingKill: true, touchedBase: "head" }),
			]);
		});

		it("takes `merge-base` with only the seat's variable set and a live seat outside its ancestry", async () => {
			const root = branch();
			const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
			onTestFinished(() => {
				stranger.kill();
			});
			const tmp = tempRoot(stranger.pid as number);
			const [python, readCalls] = fakePytest(
				{ passed: true, scope: scope() },
				0,
			);
			const r = await wrap(python, root, [], {
				...Bare,
				TMPDIR: tmp,
				WFC_GATE_SEAT: path.join(tmp, "inherited.json"),
			});
			expect(readCalls()[0]?.args.slice(-2)).toEqual([
				"scripts/test_other.py",
				"scripts/test_scan.py",
			]);
			expect(r.stdout).toContain("your own work since");
			expect(readMarkers({ root })[0].scope).toMatchObject({
				touched: true,
				touchedBase: "merge-base",
			});
		});
	});

	describe("with a checker-only file in the session's diff (#4967)", () => {
		const Anchors = "scripts/instruction-surface-anchors.json";
		const Reader = "scripts/test_anchors.py";
		function regenerated() {
			const root = pyRepo();
			fs.mkdirSync(path.join(root, "docs"));
			for (const [f, text] of Object.entries({
				"docs/test-read-edges.json": '{ "edges": {} }\n',
				[Anchors]: "{}\n",
				"scripts/check-instruction-surface.test.ts": "export {};\n",
				[Reader]: 'ANCHORS = HERE / "instruction-surface-anchors.json"\n',
			}))
				fs.writeFileSync(path.join(root, f), text);
			for (const args of [
				["add", "."],
				["commit", "-qm", "anchors"],
			])
				spawnSync("git", args, { cwd: root });
			fs.appendFileSync(path.join(root, Anchors), "\n");
			return root;
		}

		it("spawns nothing where only the anchors file changed, and its ledger line lists the reader left out", async () => {
			const root = regenerated();
			const [python, readCalls] = fakePytest(
				{ passed: true, scope: scope() },
				0,
			);
			const r = await wrap(python, root, [], Bare);

			expect(readCalls()).toEqual([]);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("LEFT TO THE LANDER — 1 test file(s)");
			expect(r.stdout).toMatch(/NO TOUCHED TESTS.*left to the lander above/);
			expect(readLedger(root)).toMatchObject([
				{
					kind: "touched",
					suite: "pytest",
					resolvedFiles: 0,
					leftOut: [Reader],
				},
			]);
		});

		it("lists the reader left out on the record of a run that ran another test", async () => {
			const root = regenerated();
			fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
			const [python, readCalls] = fakePytest(
				{ passed: true, scope: scope() },
				0,
			);
			await wrap(python, root, [], Bare);

			expect(readCalls()[0]?.args.at(-1)).toBe("scripts/test_scan.py");
			expect(readCalls()[0]?.args).not.toContain(Reader);
			expect(readMarkers({ root })).toMatchObject([
				{ scope: { touched: true, leftOut: [Reader] } },
			]);
			expect(readLedger(root)).toMatchObject([
				{ kind: "touched", resolvedFiles: 1, leftOut: [Reader] },
			]);
		});
	});

	describe("with a session id, in the shared tree", () => {
		const sb = freshSandbox();
		const Own = { ...Bare, CLAUDE_CODE_SESSION_ID: "me" };

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
		const r = await wrap(python, root, [], Bare);

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
			...Bare,
			CLAUDE_CODE_SESSION_ID: "me",
		});

		expect(readCalls()).toEqual([]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("this session's own work could not be read");
	});

	it("runs the whole suite on `--full`, handing pytest no `--full` (#3508)", async () => {
		const root = pyRepo();
		const [python, readCalls] = fakePytest(undefined, 0);
		const r = await wrap(python, root, ["--full"], Bare);

		expect(readCalls()[0]?.args.slice(6)).toEqual([]);
		expect(r.stdout).not.toContain("TOUCHED TESTS");
	});

	it("hands pytest a `--full` that has other words beside it", async () => {
		const root = pyRepo();
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, root, ["--full", "-k", "corpus"], Bare);

		expect(readCalls()[0]?.args.slice(6)).toEqual(["--full", "-k", "corpus"]);
	});

	it("passes typed arguments through unchanged", async () => {
		const root = pyRepo();
		fs.appendFileSync(path.join(root, "scripts/scan.py"), "Y = 2\n");
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, root, ["-k", "corpus"], Bare);

		expect(readCalls()[0]?.args.slice(6)).toEqual(["-k", "corpus"]);
	});
});

describe("the exit code", () => {
	it.each([1, 5])(
		"is 1 where pytest exits %i, so a red run is red on one listed code (#4779)",
		async (code) => {
			const [python] = fakePytest({ passed: false, scope: null }, code);
			expect((await wrap(python, repo())).status).toBe(1);
		},
	);

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
		const [python] = fakePytest({ passed: true, scope: scope() }, 3);
		expect((await wrap(python, root)).status).toBe(1);
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

	it("prints what a narrowed run covered, at the terminal", async () => {
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
		expect(said).toContain("-k corpus");
		expect(said).not.toContain("-t -k");
	});

	it.skipIf(!hasPytest())(
		"runs as a script, passing its arguments through to a real pytest",
		() => {
			const checkout = path.join(__dirname, "..");
			const r = keptSpawn("fd").spawnSync(
				process.execPath,
				[SCRIPT, "--collect-only", "-q"],
				{
					encoding: "utf8",
					cwd: checkout,
					env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
				},
			);
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toContain("test_pytest_pass_plugin.py");
		},
		60_000,
	);
});

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
		const r = await wrap(python, root, ["--full"], noCi);

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

	it("prints after a red run too, and the exit code stays red", async () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(timed(root), false), 1);
		const r = await wrap(python, root, ["--full"], noCi);

		expect(r.status).toBe(1);
		expect(parseCostLines(r.stdout)[0]).toContain(
			"scripts/test_new.py took 42.3",
		);
	});

	it("turns timings it cannot read into one fail-open line, and the suite's green stands", async () => {
		const root = changedRepo();
		const [python] = fakePytest(handOff(null), 0);
		const r = await wrap(python, root, ["--full"], noCi);

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
		expect(
			parseCostLines((await wrap(python, root, ["--full"], noCi)).stdout),
		).toEqual([]);
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

describe("the suite ceiling (#2702)", () => {
	const FarCeiling = "60000";
	const lowered = (dir: string) => ({
		[CEILING_ENV]: "1000",
		[DEADLINE_ENV]: path.join(dir, "deadline"),
	});

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
		const stderr = spyStderr();
		try {
			const result = await runPytest([], root, {
				handOff: path.join(root, "scope.json"),
				inflightFile: path.join(root, "inflight.json"),
				schedule,
			});
			return {
				...result,
				stderr: stderr.mock.calls.map(([text]) => text).join(""),
			};
		} finally {
			restoreStderr();
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
		expect(r.ceilingKill).toMatchObject({
			ceilingMs: 1000,
			inflight: {
				open: [{ nodeid: "scripts/test_slow.py::test_crawls", stage: "call" }],
				finished: 41,
				collected: 50,
			},
		});
	});

	it("gives a kill's fail-store row the ceiling, its duration, the tests in flight with their stage and the never-started and finished counts (#4776)", () => {
		const row = ceilingKillRow(
			{
				at: "2026-11-10T12:00:01.002Z",
				ceilingMs: 1000,
				elapsedMs: 1002,
				inflight: {
					open: [
						{ nodeid: "scripts/test_slow.py::test_crawls", stage: "call" },
					],
					finished: 41,
					collected: 50,
				},
			},
			{
				sha: "a".repeat(40),
				startedAtMs: Date.parse("2026-11-10T12:00:00Z"),
				argv: ["scripts"],
				sessionId: null,
				lander: false,
				touchedBase: null,
			},
		);

		expect(row).toEqual({
			sha: "a".repeat(40),
			at: "2026-11-10T12:00:01.002Z",
			suite: "pytest",
			startedAt: "2026-11-10T12:00:00.000Z",
			durationMs: 1002,
			ceilingKill: true,
			ceilingMs: 1000,
			testsInFlight: [
				{ nodeid: "scripts/test_slow.py::test_crawls", stage: "call" },
			],
			testsFinished: 41,
			testsNeverStarted: 8,
			argv: ["scripts"],
			sessionId: null,
		});
	});

	it("carries a touched run's base on its kill's row, which has no scope (#5321)", () => {
		const row = ceilingKillRow(
			{
				at: "2026-11-10T12:00:01Z",
				ceilingMs: 1000,
				elapsedMs: 1000,
				inflight: null,
			},
			{
				sha: "a".repeat(40),
				startedAtMs: Date.parse("2026-11-10T12:00:00Z"),
				argv: [],
				sessionId: null,
				lander: false,
				touchedBase: "head",
			},
		);
		expect(row.touchedBase).toBe("head");
	});

	it("leaves a kill's row with no tests named where pytest reported none in flight", () => {
		const row = ceilingKillRow(
			{
				at: "2026-11-10T12:00:01Z",
				ceilingMs: 1000,
				elapsedMs: 1001,
				inflight: null,
			},
			{
				sha: "a".repeat(40),
				startedAtMs: 0,
				argv: [],
				sessionId: null,
				lander: true,
				touchedBase: null,
			},
		);

		expect(row).toMatchObject({
			testsInFlight: null,
			testsNeverStarted: null,
			testsFinished: null,
			lander: true,
		});
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

	it("exits 1 and records no marker on a ceiling kill, though the plugin said green", async () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0, {});
		const r = await wrap(python, root, ["--full"], lowered(root));

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("SUITE CEILING");
		expect(readMarkers({ root })).toEqual([]);
		expect(readFailures({ root })).toEqual([
			expect.objectContaining({
				suite: "pytest",
				ceilingKill: true,
				ceilingMs: 1000,
			}),
		]);
	});

	it("says the list is unavailable where pytest reported none", async () => {
		const root = repo();
		const [python] = fakePytest(undefined, 0, {});
		const r = await wrap(python, root, ["--full"], lowered(root));

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("so the list is unavailable");
		expect(r.stderr).not.toContain("In flight:");
	});

	it("writes the deadline and pytest's group where the environment names a file, and drops it once the run settles", async () => {
		const root = repo();
		const env = {
			[CEILING_ENV]: FarCeiling,
			[DEADLINE_ENV]: path.join(root, "deadline"),
		};
		const [python, readCalls] = fakePytest(undefined, 0);
		await wrap(python, root, ["--full"], env);

		const [call] = readCalls();
		expect(call?.deadline).toMatch(new RegExp(`^\\d+ ${call?.pid}\\n$`));
		expect(fs.existsSync(env[DEADLINE_ENV])).toBe(false);
	});

	it("leaves a run that closes inside the ceiling its own verdict", async () => {
		const root = repo();
		const [python] = fakePytest({ passed: true, scope: scope() }, 0);
		const r = await wrap(python, root, ["--full"], {
			[CEILING_ENV]: FarCeiling,
		});

		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("SUITE CEILING");
		expect(readMarkers({ root })).toHaveLength(1);
	});
});

describe("the task cap (#3401)", () => {
	const { probeUserScope } = require("./lib/user-scope.js");

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
			const link = path.join(dir, "link.sh");
			fs.writeFileSync(link, '#!/bin/sh\n"$0" &\nsleep 30\n', {
				mode: 0o755,
			});
			const python = path.join(dir, "python3");
			fs.writeFileSync(
				python,
				`#!/bin/sh\nsetsid ${shellQuote(link)} &\nsleep 1\n`,
				{ mode: 0o755 },
			);

			const r = await wrap(python, root, ["-q"], { WFC_RUN_TASKS_MAX: "16" });

			expect(r.status).toBe(1);
			expect(r.stderr).toContain("TASK CAP");
			expect(r.stderr).toContain("cap at 16 tasks");
			expect(readMarkers({ root })).toHaveLength(0);
			for (let i = 0; i < 50 && (running(dir).length > 0 || units()); i++)
				await new Promise((done) => setTimeout(done, 100));
			expect(running(dir)).toEqual([]);
			expect(units()).toBe("");
		},
	);
});
