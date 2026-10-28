// @vitest-environment node
/*
 * lib/local-tester.js against a fixture repo (#2403).
 *
 * Loosen it and the lander can land a sha it never tested, test a session's
 * unsaved edit, reinstall on every batch, or run a suite past a shut gate.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	fileLedger,
	heartbeatWriter,
	landerFiles,
	remoteGit,
	runLander,
} from "./lander.js";
import { localTester, readLiveLanders, suiteSlot } from "./local-tester.js";
import { pidLock } from "./pid-lock.js";
import { queueJoin, queueTurn } from "./suite-queue.js";

/** A part-suite's carried weight (#2931). */
const PART_WEIGHT = { resolvedFiles: 2, wholeSlot: false };
/* A whole suite's lander charge (#3323). */
const WHOLE = { chargeMb: 1150 };

let tmp: string;
let work: string;
let remote: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/* A runner that runs each `*.check.js` and prints vitest's FAIL line for each
 * one that throws. */
const RUNNER = `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
let red = false;
for (const f of process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(".").filter((n) => n.endsWith(".check.js"))) {
	try { execFileSync("node", [f], { stdio: "ignore" }); console.log(" ✓ " + f); }
	catch { red = true; console.log(" FAIL  " + f + " > it fails"); }
}
process.exit(red ? 1 : 0);
`;

const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
	fs.writeFileSync(path.join(work, rel), text);
};

const config = (extra: object = {}) =>
	write(
		".claude/workflow-core.json",
		JSON.stringify({
			contract: 1,
			commands: { test: "node run.js" },
			...extra,
		}),
	);

const commit = (message: string) => {
	git(work, "add", "-A");
	git(
		work,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		message,
	);
	return git(work, "rev-parse", "HEAD");
};

const admitted = () => {
	const log: string[] = [];
	return {
		log,
		admit: async () => {
			log.push("hold");
			return {
				ok: true as const,
				spawned: () => log.push("spawned"),
				release: () => log.push("release"),
			};
		},
	};
};

/* Git runs for real; npm is recorded and stands in for an install. */
const recordingExec = () => {
	const npm: string[] = [];
	return {
		npm,
		exec: (bin: string, args: string[], cwd: string) => {
			if (bin === "npm") {
				npm.push(cwd);
				fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
				return;
			}
			execFileSync(bin, args, { cwd, stdio: "ignore" });
		},
	};
};

let passing: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-tester-"));
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, "init", "-q", "--bare", "-b", "main", remote);
	git(tmp, "clone", "-q", remote, work);
	write("run.js", RUNNER);
	write("a.check.js", "");
	write(".gitignore", ".claude/worktrees/\n.claude/tmp/\nnode_modules/\n");
	config();
	passing = commit("passing");
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("returns green at a passing sha and red naming the failing file at a failing one", async () => {
	write("b.check.js", "throw new Error('no')");
	const failing = commit("failing");
	const { admit } = admitted();
	const tester = localTester({ root: work, admit, exec: recordingExec().exec });

	expect(await tester.verdict(passing)).toEqual({ kind: "green" });
	expect(await tester.verdict(failing)).toEqual({
		kind: "red",
		files: ["b.check.js"],
	});
	expect(await tester.verdict(passing)).toEqual({ kind: "green" });
});

it("tests the sha, never the shared tree's unsaved edits", async () => {
	write("a.check.js", "throw new Error('unsaved')");
	const { admit } = admitted();
	const tester = localTester({ root: work, admit, exec: recordingExec().exec });

	expect(await tester.verdict(passing)).toEqual({ kind: "green" });
});

/* A suite that exits 1 where any of `names` reaches it, each set to `work`. A
 * red run names no file, so a suite handed one reads unknown. */
const probeVerdict = (names: string[]) => {
	const set = names.map((n) => `e.${n}`).join(" || ");
	config({
		commands: {
			test: `node -e 'const e = process.env; process.exit(${set} ? 1 : 0)'`,
		},
	});
	const probing = commit("probes the env");
	for (const n of names) vi.stubEnv(n, work);
	return localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
	}).verdict(probing);
};

it("runs the suite rooted by its directory alone, as CI does (#2410, #2476)", async () => {
	expect(
		await probeVerdict([
			"CLAUDE_PROJECT_DIR",
			"CLAUDE_PLUGIN_ROOT",
			"WFC_REPO_ROOT",
			"WFC_DISPATCH_ROOT",
		]),
	).toEqual({ kind: "green" });
});

it("hands the suite a variable it does not strip, so the env probe can fail", async () => {
	expect(await probeVerdict(["WFC_PROBE_KEPT"])).toMatchObject({
		kind: "unknown",
	});
});

it("returns unknown, never green, where it cannot check out, install or start", async () => {
	const { admit } = admitted();
	const tester = localTester({ root: work, admit, exec: recordingExec().exec });
	expect(await tester.verdict("0".repeat(40))).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/^checkout failed/),
	});

	write("package-lock.json", "{}");
	const locked = commit("locked");
	const broken = localTester({
		root: work,
		admit,
		exec: (bin, args, cwd) => {
			if (bin === "npm") throw new Error("npm ci exploded");
			execFileSync(bin, args, { cwd, stdio: "ignore" });
		},
	});
	expect(await broken.verdict(locked)).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/^install failed: .*npm ci exploded/),
	});

	config({ commands: { test: "./no-such-runner" } });
	const unstartable = commit("unstartable");
	expect(await tester.verdict(unstartable)).toEqual({
		kind: "unknown",
		reason: "./no-such-runner exited 127 naming no failing file in the tree",
	});

	config({ commands: { test: "exit 1" } });
	const crashing = commit("crashing");
	expect(await tester.verdict(crashing)).toEqual({
		kind: "unknown",
		reason: "exit 1 exited 1 naming no failing file in the tree",
	});

	config({ commands: {} });
	const undeclared = commit("undeclared");
	expect(await tester.verdict(undeclared)).toEqual({
		kind: "unknown",
		reason: "no test command is declared",
	});
});

it("installs once per lockfile, again only when it changes", async () => {
	write("package-lock.json", '{"v":1}');
	const first = commit("lock v1");
	write("c.check.js", "");
	const sameLock = commit("same lock");
	write("package-lock.json", '{"v":2}');
	const changed = commit("lock v2");
	const { npm, exec } = recordingExec();
	const tester = localTester({ root: work, admit: admitted().admit, exec });

	await tester.verdict(first);
	expect(npm).toHaveLength(1);
	await tester.verdict(sameLock);
	expect(npm).toHaveLength(1);
	await tester.verdict(changed);
	expect(npm).toHaveLength(2);
});

it("runs the declared full_test over test, and the Python suite only where the config routes Python tests", async () => {
	const pytest = path.join(tmp, "fake-pytest.js");
	const ran = path.join(tmp, "pytest-ran");
	fs.writeFileSync(
		pytest,
		`require("node:fs").appendFileSync(${JSON.stringify(ran)}, "ran\\n");`,
	);
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
		pytest,
	});

	expect(await tester.verdict(passing)).toEqual({ kind: "green" });
	expect(fs.existsSync(ran)).toBe(false);

	config({
		commands: { test: "exit 1", full_test: "node run.js" },
		pythonRoutes: { "**/test_*.py": "test", "**/*.py": "program" },
	});
	const routed = commit("routes python");
	expect(await tester.verdict(routed)).toEqual({ kind: "green" });
	expect(fs.readFileSync(ran, "utf8")).toBe("ran\n");
});

// #2188 (CodeQL js/shell-command-injection-from-environment): the runner's
// path once went into `sh -c` unquoted.
it("runs the Python suite from a plugin path with a space in it", async () => {
	const pytest = path.join(tmp, "a plugin", "fake-pytest.js");
	const ran = path.join(tmp, "pytest-ran");
	fs.mkdirSync(path.dirname(pytest));
	fs.writeFileSync(
		pytest,
		`require("node:fs").appendFileSync(${JSON.stringify(ran)}, "ran\\n");`,
	);
	config({
		commands: { test: "true" },
		pythonRoutes: { "**/test_*.py": "test" },
	});
	const routed = commit("routes python");
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
		pytest,
	});
	expect(await tester.verdict(routed)).toEqual({ kind: "green" });
	expect(fs.readFileSync(ran, "utf8")).toBe("ran\n");
});

it("asks the Python runner for the whole suite (#3508)", async () => {
	const pytest = path.join(tmp, "fake-pytest.js");
	const ran = path.join(tmp, "pytest-argv");
	fs.writeFileSync(
		pytest,
		`require("node:fs").appendFileSync(${JSON.stringify(ran)}, process.argv.slice(2).join(" ") + "\\n");`,
	);
	config({
		commands: { test: "true" },
		pythonRoutes: { "**/test_*.py": "test" },
	});
	const routed = commit("routes python");
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
		pytest,
	});
	expect(await tester.verdict(routed)).toEqual({ kind: "green" });
	expect(fs.readFileSync(ran, "utf8")).toBe("--full\n");
});

it("holds one slot for the run and releases it, and never runs past a shut gate", async () => {
	const { log, admit } = admitted();
	await localTester({ root: work, admit, exec: recordingExec().exec }).verdict(
		passing,
	);
	expect(log[0]).toBe("hold");
	expect(log.at(-1)).toBe("release");
	expect(log.filter((l) => l === "release")).toHaveLength(1);

	const ran = path.join(tmp, "ran");
	config({ commands: { test: `touch ${ran}` } });
	const touching = commit("touching");
	const shut = await localTester({
		root: work,
		admit: () =>
			suiteSlot({
				...WHOLE,
				gate: () => ({ limb: "count" }),
				memory: () => ({ ok: true, mb: Number.MAX_SAFE_INTEGER }),
				timeoutMs: 30,
				pollMs: 10,
				queueDir: tmp,
			}),
		exec: recordingExec().exec,
	}).verdict(touching);
	expect(shut).toMatchObject({
		kind: "unknown",
		reason: expect.stringMatching(/^no suite slot/),
	});
	expect(fs.existsSync(ran)).toBe(false);
	expect(
		fs.readdirSync(tmp).filter((f) => f.startsWith("wfc-suite-queue-")),
	).toEqual([]);
});

it("admits only with the gate open, its turn come and the memory there", async () => {
	const open = {
		...WHOLE,
		gate: () => null,
		queueDir: tmp,
		timeoutMs: 30,
		pollMs: 10,
	};
	expect(
		await suiteSlot({ ...open, memory: () => ({ ok: true, mb: 0 }) }),
	).toMatchObject({ ok: false });
	expect(
		await suiteSlot({ ...open, memory: () => ({ ok: false, error: "gone" }) }),
	).toMatchObject({
		ok: false,
		reason: expect.stringContaining("memory unread: gone"),
	});

	const slot = await suiteSlot({
		...open,
		memory: () => ({ ok: true, mb: Number.MAX_SAFE_INTEGER }),
	});
	expect(slot.ok).toBe(true);
	const readMarkers = () =>
		fs.readdirSync(tmp).filter((f) => f.startsWith("wfc-suite-queue-"));
	expect(readMarkers()).toHaveLength(1);
	if (slot.ok) slot.release();
	expect(readMarkers()).toEqual([]);
});

it("refuses at the ceiling on the limb the guard named, never running anyway (#2542, #2714)", async () => {
	const slotAndStderr = async (
		denial: { limb: "count" } | { limb: "memory"; mb: number; rungMb: number },
	) => {
		const lines: string[] = [];
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((s: string | Uint8Array) => {
				lines.push(String(s));
				return true;
			});
		try {
			const slot = await suiteSlot({
				...WHOLE,
				gate: () => denial,
				memory: () => ({ ok: true, mb: Number.MAX_SAFE_INTEGER }),
				timeoutMs: 30,
				pollMs: 10,
				queueDir: tmp,
			});
			return { slot, text: lines.join("") };
		} finally {
			stderr.mockRestore();
		}
	};

	const count = await slotAndStderr({ limb: "count" });
	expect(count.slot.ok).toBe(false);
	expect(count.text).not.toMatch(/running anyway/);
	expect(count.text).toMatch(
		/lander: gate still denies on its count cap after \d+s, the queue's \d+-minute wait bound — refused, not run/,
	);

	const memory = await slotAndStderr({ limb: "memory", mb: 900, rungMb: 3250 });
	expect(memory.slot.ok).toBe(false);
	expect(memory.text).toMatch(/lander: gate still denies on memory/);
});

it("stamps its slot admitted, so no waiter's turn comes until its suite spawns (#2650)", async () => {
	const slot = await suiteSlot({
		...WHOLE,
		gate: () => null,
		queueDir: tmp,
		memory: () => ({ ok: true, mb: Number.MAX_SAFE_INTEGER }),
	});
	expect(slot.ok).toBe(true);
	/* Past Linux's pid_max, so never a live process. A part-suite's turn
	 * ignores whole suites ahead, so only the lander's stamp can hold it. */
	const rival = 2_000_000_000;
	queueJoin({ queueDir: tmp, pid: rival, weight: PART_WEIGHT });
	const rivalTurn = () =>
		queueTurn({ queueDir: tmp, pid: rival, alive: () => true });
	expect(rivalTurn()).toBe(false);
	if (slot.ok) slot.spawned();
	expect(rivalTurn()).toBe(true);
	if (slot.ok) slot.release();
});

it("yields to a waiter whose turn came true on the same poll, launching only once it spawns (#2650)", async () => {
	const rival = path.join(tmp, `wfc-suite-queue-${process.ppid}.json`);
	const stamp = (fields: object) =>
		fs.writeFileSync(
			rival,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(rival, "utf8")),
				...fields,
			}),
		);
	const readdir = fs.readdirSync;
	let reads = 0;
	/* Read 1 is the lander's turn, read 2 its admission's re-read: the rival
	 * joins behind before the first and stamps admitted before the second. */
	const spy = vi.spyOn(fs, "readdirSync").mockImplementation(((
		dir: fs.PathLike,
		...rest: unknown[]
	) => {
		if (dir === tmp) {
			reads += 1;
			if (reads === 1)
				queueJoin({
					queueDir: tmp,
					pid: process.ppid,
					weight: PART_WEIGHT,
					clock: () => Date.now() + 1,
				});
			if (reads === 2) {
				stamp({ admitted: true });
				setTimeout(() => stamp({ spawned: true }), 50);
			}
		}
		return (readdir as (...a: unknown[]) => unknown)(dir, ...rest);
	}) as typeof fs.readdirSync);
	const lines: string[] = [];
	const stderr = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((s: string | Uint8Array) => {
			lines.push(String(s));
			return true;
		});
	try {
		const slot = await suiteSlot({
			...WHOLE,
			gate: () => null,
			queueDir: tmp,
			pollMs: 10,
			memory: () => ({ ok: true, mb: Number.MAX_SAFE_INTEGER }),
		});
		expect(slot.ok).toBe(true);
		expect(JSON.parse(fs.readFileSync(rival, "utf8")).spawned).toBe(true);
		expect(lines.join("")).toMatch(/lander: another launch was admitted/);
		if (slot.ok) slot.release();
	} finally {
		spy.mockRestore();
		stderr.mockRestore();
	}
});

it("shows session admission the held slot as a lander (#2416)", async () => {
	const slot = await suiteSlot({
		...WHOLE,
		gate: () => null,
		queueDir: tmp,
		memory: () => ({ ok: true, mb: Number.MAX_SAFE_INTEGER }),
	});
	expect(readLiveLanders({ queueDir: tmp })).toEqual([
		{ pid: process.pid, chargeMb: 1150 },
	]);
	if (slot.ok) slot.release();
	expect(readLiveLanders({ queueDir: tmp })).toEqual([]);
});

it("charges a whole suite 1,150 MB and a named-file rerun 600 on the marker (#3323)", async () => {
	const charged: unknown[] = [];
	const tester = localTester({
		root: work,
		admit: async (charge) => {
			const slot = await suiteSlot({
				...charge,
				gate: () => null,
				queueDir: tmp,
				memory: () => ({ ok: true, mb: Number.MAX_SAFE_INTEGER }),
			});
			charged.push(readLiveLanders({ queueDir: tmp })[0]?.chargeMb);
			return slot;
		},
		exec: recordingExec().exec,
	});
	await tester.verdict(passing);
	await tester.verdict(passing, ["a.check.js"]);
	expect(charged).toEqual([1150, 600]);
});

it("opens the gate's memory rung at 2,250 MB for a whole suite and 1,700 for a named-file rerun (#3323)", async () => {
	const at = (mb: number, chargeMb: number) =>
		suiteSlot({
			chargeMb,
			gate: () => null,
			queueDir: tmp,
			timeoutMs: 30,
			pollMs: 10,
			memory: () => ({ ok: true, mb }),
		});
	const release = (slot: Awaited<ReturnType<typeof suiteSlot>>) => {
		if (slot.ok) slot.release();
		return slot.ok;
	};
	expect(await at(2249, 1150)).toMatchObject({
		ok: false,
		reason: expect.stringContaining("2249 MB available against 2250 MB"),
	});
	expect(release(await at(2250, 1150))).toBe(true);
	expect(await at(1699, 600)).toMatchObject({
		ok: false,
		reason: expect.stringContaining("against 1700 MB"),
	});
	expect(release(await at(1700, 600))).toBe(true);
});

it("appends each run's kind, file count and tree-PSS peak to the lander run record (#3323)", async () => {
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
		treePss: () => 700 * 1024,
	});
	await tester.verdict(passing);
	await tester.verdict(passing, ["a.check.js"]);
	const record = fs
		.readFileSync(
			path.join(work, ".claude", "tmp", "markers", ".lander-runs.jsonl"),
			"utf8",
		)
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	expect(record).toMatchObject([
		{ sha: passing, kind: "whole", files: 0, shards: 1, peakMb: 700 },
		{ sha: passing, kind: "named", files: 1, shards: 1, peakMb: 700 },
	]);
});

it("names the failing files vitest and pytest print", async () => {
	const lines = [
		" \u001b[31mFAIL\u001b[39m  scripts/a.test.ts > suite > it",
		" FAIL  scripts/a.test.ts > suite > other",
		" FAIL  scripts/b.test.ts [ scripts/b.test.ts ]",
		" ✓ scripts/c.test.ts (3 tests)",
		"FAILED scripts/test_d.py::test_x - AssertionError",
		"ERROR scripts/test_e.py - ImportError",
	];
	write(
		"fail.js",
		`console.log(${JSON.stringify(lines.join("\n"))}); process.exit(1);`,
	);
	for (const f of [
		"scripts/a.test.ts",
		"scripts/b.test.ts",
		"scripts/test_d.py",
		"scripts/test_e.py",
	])
		write(f, "");
	config({ commands: { test: "node fail.js" } });
	const printing = commit("printing");
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
	});

	expect(await tester.verdict(printing)).toEqual({
		kind: "red",
		files: [
			"scripts/a.test.ts",
			"scripts/b.test.ts",
			"scripts/test_d.py",
			"scripts/test_e.py",
		],
	});
});

it("names only failing files the tree holds, a test's printed fixture output naming none (#2410)", async () => {
	const printed = (names: string[]) =>
		`console.log(${JSON.stringify(names.map((n) => ` FAIL  ${n} > it`).join("\n"))}); process.exit(1);`;
	write("scripts/real.test.ts", "");
	write(
		"fail.js",
		printed(["scripts/real.test.ts", "scripts/fixture.test.ts"]),
	);
	config({ commands: { test: "node fail.js" } });
	const mixed = commit("mixed");
	write("fail.js", printed(["scripts/fixture.test.ts"]));
	const phantom = commit("phantom");
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
	});

	expect(await tester.verdict(mixed)).toEqual({
		kind: "red",
		files: ["scripts/real.test.ts"],
	});
	expect(await tester.verdict(phantom)).toEqual({
		kind: "unknown",
		reason: "node fail.js exited 1 naming no failing file in the tree",
	});
});

/* A runner taking vitest's `--shard=k/n`: the kth of every n `*.check.js`
 * files by name, each run's files logged to `shards.log`; with no shard, all
 * of them. */
const SHARDED_RUNNER = `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const flag = process.argv.find((a) => a.startsWith("--shard="));
const [k, n] = flag ? flag.slice(8).split("/").map(Number) : [1, 1];
const files = fs.readdirSync(".").filter((f) => f.endsWith(".check.js")).sort().filter((_, i) => i % n === k - 1);
fs.appendFileSync("../shards.log", (flag ?? "whole") + " " + files.join(",") + "\\n");
let red = false;
for (const f of files) {
	try { execFileSync("node", [f], { stdio: "ignore" }); }
	catch { red = true; console.log(" FAIL  " + f + " > it fails"); }
}
process.exit(red ? 1 : 0);
`;

it("splits the whole run into fullTestShards shards, each in a slot of its own, red where either is (#2996)", async () => {
	write("shard.js", SHARDED_RUNNER);
	write("b.check.js", "throw new Error('red');");
	config({
		commands: { test: "node shard.js" },
		fullTestShards: 2,
	});
	const sharded = commit("sharded");
	const { log, admit } = admitted();
	const tester = localTester({ root: work, admit, exec: recordingExec().exec });

	expect(await tester.verdict(sharded)).toEqual({
		kind: "red",
		files: ["b.check.js"],
	});
	expect(log).toEqual([
		"hold",
		"spawned",
		"release",
		"hold",
		"spawned",
		"release",
	]);
	const shardsLog = path.join(work, ".claude", "worktrees", "shards.log");
	expect(fs.readFileSync(shardsLog, "utf8")).toBe(
		"--shard=1/2 a.check.js\n--shard=2/2 b.check.js\n",
	);

	fs.rmSync(shardsLog);
	expect(await tester.verdict(sharded, ["b.check.js"])).toMatchObject({
		kind: "red",
	});
	expect(fs.readFileSync(shardsLog, "utf8")).toBe(
		"whole a.check.js,b.check.js\n",
	);
});

it("runs the Python suite after the last shard alone, where Python is routed (#2996)", async () => {
	write("shard.js", SHARDED_RUNNER);
	const pytest = path.join(tmp, "fake-pytest.js");
	fs.writeFileSync(
		pytest,
		`require("node:fs").appendFileSync("../shards.log", "python\\n");`,
	);
	config({
		commands: { test: "node shard.js" },
		fullTestShards: 2,
		pythonRoutes: { "**/test_*.py": "test", "**/*.py": "program" },
	});
	const routed = commit("sharded python");

	expect(
		await localTester({
			root: work,
			admit: admitted().admit,
			exec: recordingExec().exec,
			pytest,
		}).verdict(routed),
	).toEqual({ kind: "green" });
	expect(
		fs.readFileSync(
			path.join(work, ".claude", "worktrees", "shards.log"),
			"utf8",
		),
	).toBe("--shard=1/2 a.check.js\n--shard=2/2 \npython\n");
});

it("names an earlier shard's failing files where a later one reaches no verdict, never calling it red (#2996)", async () => {
	write(
		"halves.js",
		`if (process.argv.includes("--shard=1/2")) { console.log(" FAIL  a.check.js > it fails"); process.exit(1); }
console.error("SUITE CEILING — killed 840s after vitest spawned"); process.exit(1);`,
	);
	config({ commands: { test: "node halves.js" }, fullTestShards: 2 });
	const halves = commit("red then killed");

	expect(
		await localTester({
			root: work,
			admit: admitted().admit,
			exec: recordingExec().exec,
		}).verdict(halves),
	).toEqual({
		kind: "unknown",
		reason:
			"node halves.js --shard=2/2 exited 1 killed: SUITE CEILING — killed 840s after vitest spawned, after a.check.js failed",
	});
});

it("names the shard that reached no verdict, and runs no later shard (#2996)", async () => {
	write(
		"ceiling.js",
		`console.error("SUITE CEILING — killed 840s after vitest spawned"); process.exit(1);`,
	);
	config({ commands: { test: "node ceiling.js" }, fullTestShards: 2 });
	const killed = commit("killed shard");
	const { log, admit } = admitted();

	expect(
		await localTester({
			root: work,
			admit,
			exec: recordingExec().exec,
		}).verdict(killed),
	).toEqual({
		kind: "unknown",
		reason:
			"node ceiling.js --shard=1/2 exited 1 killed: SUITE CEILING — killed 840s after vitest spawned",
	});
	expect(log.filter((l) => l === "hold")).toHaveLength(1);
});

it("names the suite ceiling as no verdict, never red, where the ceiling killed the run (#2696)", async () => {
	write(
		"ceiling.js",
		`console.error("SUITE CEILING — killed 840s after vitest spawned"); process.exit(1);`,
	);
	config({ commands: { test: "node ceiling.js" } });
	const killed = commit("killed");
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
	});

	expect(await tester.verdict(killed)).toEqual({
		kind: "unknown",
		reason:
			"node ceiling.js exited 1 killed: SUITE CEILING — killed 840s after vitest spawned",
	});
});

it("reruns only the named files, sending a Python one to pytest only where Python is routed", async () => {
	const pytest = path.join(tmp, "fake-pytest.js");
	const ran = path.join(tmp, "pytest-args");
	fs.writeFileSync(
		pytest,
		`require("node:fs").appendFileSync(${JSON.stringify(ran)}, process.argv.slice(2).join(" ") + "\\n");`,
	);
	write("b.check.js", "throw new Error('no')");
	write("test_x.py", "");
	const unrouted = commit("unrouted");
	const tester = localTester({
		root: work,
		admit: admitted().admit,
		exec: recordingExec().exec,
		pytest,
	});

	expect(await tester.verdict(unrouted, ["a.check.js", "test_x.py"])).toEqual({
		kind: "green",
	});
	expect(fs.existsSync(ran)).toBe(false);

	config({ pythonRoutes: { "**/test_*.py": "test" } });
	const routed = commit("routed");
	expect(await tester.verdict(routed, ["a.check.js", "test_x.py"])).toEqual({
		kind: "green",
	});
	expect(fs.readFileSync(ran, "utf8")).toBe("test_x.py\n");
});

it("lands a green fixture batch on main, plugged into the lander", async () => {
	git(work, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	write("c.check.js", "");
	const batch = commit("batch");
	git(work, "push", "-q", "origin", "HEAD:landing");
	const files = landerFiles(work);
	fs.mkdirSync(path.dirname(files.pid), { recursive: true });

	const origin = remoteGit(work);
	const ledgeredAtPush: boolean[] = [];
	/* A variable, not a literal: a green batch files no ticket, and the red
	 * path's tracker (#2404) is only typed where that lander is. */
	const deps = {
		tracker: { fileFixTicket: () => "", holdQueue: () => "" },
		git: {
			...origin,
			pushMain: (sha: string) => {
				ledgeredAtPush.push(fileLedger(files.ledger).has(sha));
				origin.pushMain(sha);
			},
		},
		tester: localTester({
			root: work,
			admit: admitted().admit,
			exec: recordingExec().exec,
		}),
		ledger: fileLedger(files.ledger),
		noVerdict: fileLedger(files.noVerdict),
		lock: pidLock(files.pid, "local-tester.test.ts"),
		beat: heartbeatWriter(files.heartbeat),
	};
	await runLander(deps);

	expect(git(remote, "rev-parse", "main")).toBe(batch);
	expect(ledgeredAtPush).toEqual([true]);
});
