// @vitest-environment node
/*
 * The `npm run test` wrapper that tees the suite's stdout/stderr to a durable
 * log (mantahostels#1943), and decides what vitest is handed and when: the
 * `--changed` selection over the read graph (mantahostels#2095), the queue
 * for a suite slot (mantahostels#2024), the stall watchdog, `--isolated`,
 * `--adopt` (#1213), and whether a filtered run meets the push gate
 * (mantahostels#2146, mantahostels#2207).
 *
 * `spawnFn` is a fake EventEmitter-based child, so every case here asserts
 * what the wrapper does with a run's output rather than paying for a real
 * vitest invocation.
 *
 * SO THIS FILE DOES NOT REACH ITS OWN SUBJECT through
 * `scripts/lib/run-in-process.js`, which §X3 asks a `scripts/` test to use: the
 * wrapper's whole subject IS what it does with a child's streams, which a
 * black-box run cannot observe. The ONE place that seam is used is the
 * attribution case below, which runs a DIFFERENT script — the ledger's writer.
 * What the wrapper delegates to its libraries is asserted through their
 * exports where a whole run would only obscure it: lib/changed-selection.js
 * (the selection, its base and its escalation, mantahostels#3208),
 * lib/own-selection.js (`attributeDirty`, `ownSelection`) and
 * lib/isolated-worktree.js. Everything of the wrapper's own goes through
 * `main` (#1371). The npm-swallowed-flag cases launch it through a real
 * `npm run` instead, since npm's own handling of a flag written before `--` is
 * the subject (#2284).
 *
 * Every `npm run test` and `npm run test:changed` runs through it, and the
 * certificate it leaves is what `.husky/pre-push` and `npm run push:check`
 * read: loosen a case and a run that tested less than it says attests
 * a push, a red run's failure text is lost to a pipe, or suites pile
 * onto the memory-capped machine instead of queueing.
 */

import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { defineTemplate, initGitRepo, mkScratchDir } from "./lib/git-fixture";
import { writeEnviron } from "./lib/proc-fake";
import { isDead } from "./lib/process-fixture";
import { stubLaunch } from "./lib/suite-handoff-testkit";
import { WHOLE_SLOT_BOUND } from "./lib/whole-slot-bound";

const require = createRequire(import.meta.url);

const { REFUSAL_NAMED_MAX } = require("./lib/dirty-tree.js");
const { dirPath } = require("./lib/test-log.js");
const { main } = require("./run-vitest.js");
const { launchEnv, readLaunch } = require("./lib/suite-handoff.js");
const { DEADLINE_ENV, sweepAtStart } = require("./lib/suite-ceiling.js");

/* The wrapper's own flags and the filter an empty selection runs under,
 * spelled as a caller types them. */
const SHARED_FLAG = "--shared";
const FULL_FLAG = "--full";
const EMPTY_SELECTION_FILTER = "wfc-empty-selection";

/** The checkout, so the live manifest can be read from where it actually is. */
const REPO_ROOT = path.resolve(__dirname, "..");
/* A guess: the ceiling on a case that waits for a real child process, well
 * past the few seconds one takes on a loaded machine. */
const REAL_CHILD_TIMEOUT_MS = 20_000;

const dirs: string[] = [];

/** A read-graph render that fails, as git refusing to list the tree would. */
const renderFails = () => {
	throw new Error("render failed");
};

/** A git repo with one commit, so `readHeadSha` and `repoRoot` both answer. */
function repo() {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "runvitest-")),
	);
	dirs.push(dir);
	for (const args of [
		["init", "-q"],
		["config", "user.email", "t@example.com"],
		["config", "user.name", "t"],
		["commit", "-q", "--allow-empty", "-m", "root"],
	])
		require("node:child_process").spawnSync("git", args, { cwd: dir });
	return dir;
}

/** `dir` declaring `commands`, which a message naming one reads off the root
 * the wrapper was handed (#3334). */
function declaringCommands(dir: string, commands: Record<string, string>) {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude/workflow-core.json"),
		JSON.stringify({ commands }),
	);
	for (const args of [
		["add", "-f", ".claude/workflow-core.json"],
		["commit", "-q", "-m", "commands"],
	])
		require("node:child_process").spawnSync("git", args, { cwd: dir });
	return dir;
}

/** A whole-slot bound's worth of test files (#2931). */
const WHOLE_SLOT_TESTS = Array.from(
	{ length: WHOLE_SLOT_BOUND },
	(_, i) => `t/f${i}.test.ts`,
);

/** `dir`, a `repo()` by default, tracking WHOLE_SLOT_TESTS. */
function wholeRepo(dir = repo()) {
	fs.mkdirSync(path.join(dir, "t"));
	for (const file of WHOLE_SLOT_TESTS)
		fs.writeFileSync(path.join(dir, file), "");
	for (const args of [
		["add", "t"],
		["commit", "-q", "-m", "tests"],
	])
		require("node:child_process").spawnSync("git", args, { cwd: dir });
	return dir;
}

/* A session running this suite exports its id, which would route every bare
 * `main([])` below into #812's overlay worktree; a case wanting one passes
 * `sessionId` itself. */
beforeEach(() => {
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
});

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const readJsonl = (file: string) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

/** A queue directory of its own, cleaned up with the rest. */
function qdir() {
	const d = mkScratchDir("queue-");
	dirs.push(d);
	return d;
}

interface FakeChildOptions {
	stdoutChunks?: string[];
	stderrChunks?: string[];
	code?: number | null;
	/* Emitted before close, as Node does for a child that never spawns. */
	error?: Error;
}

/** An `err` or `out` that keeps what is written to it. */
function sink() {
	const text: string[] = [];
	return { text, write: (s: string) => text.push(s) };
}

/** Stands in for the vitest child: emits output, then closes. */
function fakeChild({
	stdoutChunks = [],
	stderrChunks = [],
	code = 0,
	error,
}: FakeChildOptions = {}) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	queueMicrotask(() => {
		if (error) child.emit("error", error);
		for (const c of stdoutChunks) child.stdout.write(c);
		for (const c of stderrChunks) child.stderr.write(c);
		child.stdout.end();
		child.stderr.end();
		child.emit("close", code);
	});
	return child;
}

/** A child that never closes until it is killed, recording the signals sent to it. */
function parkedChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: (signal?: string) => boolean;
		signals: string[];
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.signals = [];
	child.kill = (signal = "SIGTERM") => {
		child.signals.push(signal);
		/* A real SIGKILL closes the child; the fake must too, or `main`
		 * never resolves and no assertion after it is reached. */
		child.stdout.end();
		child.stderr.end();
		child.emit("close", null);
		return true;
	};
	return child;
}

function spawnReturning(opts: FakeChildOptions) {
	const calls: unknown[][] = [];
	return {
		spawnFn: (...args: unknown[]) => {
			calls.push(args);
			return fakeChild(opts);
		},
		calls,
	};
}

/**
 * A minimal fs stub whose write stream buffers into `chunks`. The stream is
 * an EventEmitter, matching a real `fs.WriteStream` closely enough for
 * `stream?.on?.("error", …)` to attach for real rather than silently no-op.
 */
function fakeFs(base: typeof fs = fs) {
	const written: Record<string, Buffer[]> = {};
	const streams: EventEmitter[] = [];
	return {
		written,
		streams,
		mkdirSync: base.mkdirSync.bind(base),
		readdirSync: base.readdirSync.bind(base),
		statSync: base.statSync.bind(base),
		unlinkSync: base.unlinkSync.bind(base),
		createWriteStream: (file: string) => {
			written[file] = [];
			const emitter = new EventEmitter() as EventEmitter & {
				write: (chunk: Buffer | string) => boolean;
				end: () => void;
			};
			emitter.write = (chunk) => {
				written[file].push(Buffer.from(chunk));
				return true;
			};
			emitter.end = () => emitter.emit("close");
			streams.push(emitter);
			return emitter;
		},
	};
}

describe("the exit code", () => {
	it("is the child's own", async () => {
		const { spawnFn } = spawnReturning({ code: 3 });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await expect(
				main([SHARED_FLAG], { spawnFn, root: repo(), fs: fakeFs() }),
			).resolves.toBe(3);
		} finally {
			stdout.mockRestore();
		}
	});

	it("is 1 where the child was killed by a signal and has no code", async () => {
		const { spawnFn } = spawnReturning({ code: null });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await expect(
				main([SHARED_FLAG], { spawnFn, root: repo(), fs: fakeFs() }),
			).resolves.toBe(1);
		} finally {
			stdout.mockRestore();
		}
	});

	it("is unchanged even where the log stream errors mid-run, after it opened fine, and names the error on stderr", async () => {
		const { spawnFn } = spawnReturning({
			stdoutChunks: ["line one\n"],
			code: 5,
		});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const said = sink();
		const io = fakeFs();
		try {
			const result = main([SHARED_FLAG], {
				spawnFn,
				root: repo(),
				fs: io,
				err: said,
			});
			// Synchronous window before the fake child's queued microtask fires:
			// createWriteStream has already run, the real stream a late ENOSPC or
			// EIO would break has not been asked to do anything yet.
			io.streams[0]?.emit("error", new Error("ENOSPC"));
			await expect(result).resolves.toBe(5);
			expect(stdout.mock.calls.map((c) => String(c[0])).join("")).not.toContain(
				"TEST LOG:",
			);
			// §N5: fail open, and say so — the failure is not silent.
			expect(said.text.join("")).toContain("ENOSPC");
		} finally {
			stdout.mockRestore();
		}
	});

	it("is unchanged even where the log cannot be opened at all, and says so on stderr", async () => {
		const { spawnFn } = spawnReturning({ code: 0 });
		const brokenFs = {
			mkdirSync: () => {
				throw new Error("EACCES");
			},
			createWriteStream: () => {
				throw new Error("unreachable");
			},
			readdirSync: fs.readdirSync.bind(fs),
			statSync: fs.statSync.bind(fs),
			unlinkSync: fs.unlinkSync.bind(fs),
		};
		const said = sink();
		expect(
			await main([SHARED_FLAG], {
				spawnFn,
				root: repo(),
				fs: brokenFs,
				err: said,
			}),
		).toBe(0);
		expect(said.text.join("")).toContain("EACCES");
	});
});

describe("the tee", () => {
	it("forwards every stdout/stderr chunk to this process's own streams, unchanged", async () => {
		const { spawnFn } = spawnReturning({
			stdoutChunks: ["line one\n", "line two\n"],
			stderrChunks: ["oh no\n"],
			code: 1,
		});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			await main([SHARED_FLAG], { spawnFn, root: repo(), fs: fakeFs() });
			const said = stdout.mock.calls.map((c) => String(c[0])).join("");
			expect(said).toContain("line one\n");
			expect(said).toContain("line two\n");
			expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain(
				"oh no\n",
			);
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});

	it("writes the same bytes to the log file", async () => {
		const { spawnFn } = spawnReturning({
			stdoutChunks: ["FAIL src/thing.test.ts\n", "assertion diff here\n"],
			code: 1,
		});
		const io = fakeFs();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await main([SHARED_FLAG], { spawnFn, root: repo(), fs: io });
		} finally {
			stdout.mockRestore();
		}
		const files = Object.keys(io.written);
		expect(files).toHaveLength(1);
		const content = Buffer.concat(io.written[files[0]]).toString();
		expect(content).toContain("FAIL src/thing.test.ts");
		expect(content).toContain("assertion diff here");
	});

	it("announces the log's path on stdout, so it is not write-only (mantahostels#1942's lesson)", async () => {
		const { spawnFn } = spawnReturning({ code: 0 });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await main([SHARED_FLAG], { spawnFn, root: repo(), fs: fakeFs() });
			expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain(
				"TEST LOG:",
			);
		} finally {
			stdout.mockRestore();
		}
	});

	it("announces no TEST LOG: on stdout where none was opened — the failure goes to stderr instead", async () => {
		const { spawnFn } = spawnReturning({ code: 0 });
		const brokenFs = {
			mkdirSync: () => {
				throw new Error("EACCES");
			},
			createWriteStream: () => {
				throw new Error("unreachable");
			},
			readdirSync: fs.readdirSync.bind(fs),
			statSync: fs.statSync.bind(fs),
			unlinkSync: fs.unlinkSync.bind(fs),
		};
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const said = sink();
		try {
			await main([SHARED_FLAG], {
				spawnFn,
				root: repo(),
				fs: brokenFs,
				err: said,
			});
			expect(stdout.mock.calls.map((c) => String(c[0])).join("")).not.toContain(
				"TEST LOG:",
			);
			expect(said.text.join("")).toContain("not written");
		} finally {
			stdout.mockRestore();
		}
	});
});

describe("what it hands vitest", () => {
	it("passes 'run' then the caller's own arguments", async () => {
		const { spawnFn, calls } = spawnReturning({ code: 0 });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await main(["-t", "corpus"], {
				spawnFn,
				root: repo(),
				fs: fakeFs(),
			});
		} finally {
			stdout.mockRestore();
		}
		const [, args] = calls[0] as [string, string[], unknown];
		expect(args).toEqual(["run", "-t", "corpus"]);
	});
});

describe("`--queue`, which waits for the suite-count cap (mantahostels#2024)", () => {
	/** Swallows the wrapper's own progress lines. */
	const quiet = { write: () => true };

	const run = async (argv: string[], extra: Record<string, unknown>) => {
		const { spawnFn, calls } = spawnReturning({ code: 0 });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await main(argv, {
				spawnFn,
				root: repo(),
				fs: fakeFs(),
				out: quiet,
				// A queue directory of its own: unset, `queueJoin`/`queueTurn` fall
				// back to the real `os.tmpdir()` and queue for real behind whatever
				// a genuine `--queue` run on this machine left there (mantahostels#2033).
				queueDir: qdir(),
				...extra,
			});
		} finally {
			stdout.mockRestore();
		}
		return calls;
	};

	it("consumes the flag rather than handing it to vitest", async () => {
		const calls = await run(["--queue", "-t", "corpus"], {
			gate: () => false,
		});
		const [, args] = calls[0] as [string, string[], unknown];
		expect(args).toEqual(["run", "-t", "corpus"]);
	});

	it("does not wait at all when the gate is already open", async () => {
		const sleepFn = vi.fn(() => Promise.resolve());
		await run(["--queue", SHARED_FLAG], { gate: () => false, sleepFn });
		expect(sleepFn).not.toHaveBeenCalled();
	});

	it("polls until the gate opens, then runs", async () => {
		let closed = 3;
		const sleepFn = vi.fn(() => Promise.resolve());
		const calls = await run(["--queue", SHARED_FLAG], {
			gate: () => closed-- > 0,
			sleepFn,
		});
		expect(sleepFn).toHaveBeenCalledTimes(3);
		expect(calls).toHaveLength(1);
	});

	/* A whole suite run past the bound would run beside another (#2714). */
	it("refuses a whole suite, spawning nothing, once the timeout is reached on the count cap", async () => {
		const queueLog = path.join(qdir(), "exits.jsonl");
		const said: string[] = [];
		const calls = await run(["--queue", SHARED_FLAG], {
			root: wholeRepo(),
			gate: () => ({ limb: "count" }),
			sleepFn: () => Promise.resolve(),
			timeoutMs: -1,
			out: { write: (s: string) => said.push(s) },
			queueLog,
		});
		expect(calls).toHaveLength(0);
		expect(readJsonl(queueLog)).toMatchObject([
			{ reason: "refused", limb: "count" },
		]);
		expect(said.join("")).toMatch(/wait bound — refused, not run/);
	});

	it("puts on its exit line the older part-suites its turn passed (#3115)", async () => {
		const queueDir = qdir();
		const queueLog = path.join(queueDir, "exits.jsonl");
		fs.writeFileSync(
			path.join(queueDir, "wfc-suite-queue-1.json"),
			JSON.stringify({
				pid: 1,
				at: Date.now() - 1000,
				part: true,
				memoryHeld: true,
			}),
		);
		const calls = await run(["--queue", SHARED_FLAG, "scripts/a.test.ts"], {
			gate: () => false,
			alive: () => true,
			queueDir,
			queueLog,
		});
		expect(calls).toHaveLength(1);
		expect(readJsonl(queueLog)).toMatchObject([
			{ reason: "opened", passed: 1 },
		]);
	});

	/* A part-suite takes no whole-suite slot (#2558), so the count cap at the
	 * bound runs it anyway. */
	it("runs a part-suite anyway once the timeout is reached on the count cap", async () => {
		const calls = await run(["--queue", SHARED_FLAG, "scripts/a.test.ts"], {
			gate: () => ({ limb: "count" }),
			sleepFn: () => Promise.resolve(),
			timeoutMs: -1,
		});
		expect(calls).toHaveLength(1);
	});

	/* Where the memory rung holds it, the suite would land short of its rung,
	 * where earlyoom kills live sessions (#2421). */
	it("refuses, spawning nothing and leaving the queue, once the timeout is reached on the memory rung", async () => {
		const queueDir = qdir();
		const queueLog = path.join(queueDir, "exits.jsonl");
		const said: string[] = [];
		const { spawnFn, calls } = spawnReturning({ code: 0 });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		let code: number;
		try {
			code = await main(["--queue", SHARED_FLAG], {
				spawnFn,
				root: repo(),
				fs: fakeFs(),
				out: { write: (s: string) => said.push(s) },
				queueDir,
				queueLog,
				gate: () => ({ limb: "memory", mb: 900, rungMb: 3250 }),
				sleepFn: () => Promise.resolve(),
				timeoutMs: -1,
			});
		} finally {
			stdout.mockRestore();
		}
		expect(calls).toHaveLength(0);
		expect(code).not.toBe(0);
		expect(
			fs.readdirSync(queueDir).filter((f) => f.startsWith("wfc-suite-queue-")),
		).toEqual([]);
		expect(readJsonl(queueLog)).toMatchObject([
			{ reason: "refused", limb: "memory" },
		]);
		expect(said.join("")).toMatch(/gate still denies on memory/);
	});

	it("re-reads the load after the gate opens, and spawns nothing on a refusal (#834)", async () => {
		const order: string[] = [];
		let closed = 1;
		const calls = await run(["--queue", SHARED_FLAG], {
			gate: () => {
				order.push("gate");
				return closed-- > 0;
			},
			sleepFn: () => Promise.resolve(),
			loadHold: () => {
				order.push("load");
				return Promise.resolve(false);
			},
		});
		expect(order).toEqual(["gate", "gate", "load"]);
		expect(calls).toHaveLength(0);
	});

	it("reads the gate again after the load hold, before it runs (#2622)", async () => {
		const order: string[] = [];
		const calls = await run(["--queue", SHARED_FLAG], {
			gate: () => {
				order.push("gate");
				return false;
			},
			loadHold: () => {
				order.push("load");
				return Promise.resolve(true);
			},
		});
		expect(order).toEqual(["gate", "load", "gate"]);
		expect(calls).toHaveLength(1);
	});

	it("runs once the re-read admits", async () => {
		const calls = await run(["--queue", SHARED_FLAG], {
			gate: () => false,
			loadHold: () => Promise.resolve(true),
		});
		expect(calls).toHaveLength(1);
	});

	describe("inside a `queue-run.js --seat` seat (#2918)", () => {
		const { queueJoin, queueSpawned } = require("./lib/suite-queue.js");
		/** A spawned part seat held by pid 20, this process's parent. */
		const seated = (extra: Record<string, unknown> = {}) => {
			const queueDir = qdir();
			const seat = queueJoin({
				queueDir,
				pid: 20,
				weight: { resolvedFiles: 1, wholeSlot: false },
			});
			queueSpawned(seat);
			return {
				queueDir,
				queueLog: path.join(queueDir, "exits.jsonl"),
				env: { WFC_SUITE_SEAT: seat },
				alive: () => true,
				parentOf: (pid: number) => (pid === process.pid ? 20 : 1),
				...extra,
			};
		};
		const readQueueMarkers = (dir: string) =>
			fs.readdirSync(dir).filter((f) => f.startsWith("wfc-suite-queue-"));

		it("runs a part-suite past the count cap, its marker gone and no exit line written", async () => {
			const o = seated({ gate: () => ({ limb: "count" }) });
			const calls = await run(["--queue", SHARED_FLAG, "scripts/a.test.ts"], o);
			expect(calls).toHaveLength(1);
			expect(readQueueMarkers(o.queueDir)).toEqual(["wfc-suite-queue-20.json"]);
			expect(fs.existsSync(o.queueLog)).toBe(false);
		});

		/* A launch admitted and unspawned holds every other turn, so no two
		 * pass the rung on one `ps` reading (#2622). */
		it("stamps its marker admitted before it spawns", async () => {
			const o = seated({ gate: () => false });
			let stamped: unknown;
			const { spawnFn, calls } = spawnReturning({ code: 0 });
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			try {
				await main(["--queue", SHARED_FLAG, "scripts/a.test.ts"], {
					spawnFn: (...args: Parameters<typeof spawnFn>) => {
						stamped = JSON.parse(
							fs.readFileSync(
								path.join(o.queueDir, `wfc-suite-queue-${process.pid}.json`),
								"utf8",
							),
						);
						return spawnFn(...args);
					},
					root: repo(),
					fs: fakeFs(),
					out: quiet,
					...o,
				});
			} finally {
				stdout.mockRestore();
			}
			expect(calls).toHaveLength(1);
			expect(stamped).toMatchObject({ admitted: true, part: true });
		});

		it("logs a wait the memory rung held, as kind `seat` (#2911)", async () => {
			let held = 2;
			let now = 0;
			const o = seated({
				gate: () =>
					held-- > 0 ? { limb: "memory", mb: 900, rungMb: 3250 } : false,
				sleepFn: () => {
					now += 10_000;
					return Promise.resolve();
				},
				clock: () => now,
			});
			const calls = await run(["--queue", SHARED_FLAG, "scripts/a.test.ts"], o);
			expect(calls).toHaveLength(1);
			expect(readJsonl(o.queueLog)).toMatchObject([
				{ reason: "opened", kind: "seat", waitS: 20 },
			]);
		});

		it("stamps its marker memoryHeld while the rung holds it (#3058)", async () => {
			let held = 1;
			const readOwnMarker = () =>
				JSON.parse(
					fs.readFileSync(
						path.join(o.queueDir, `wfc-suite-queue-${process.pid}.json`),
						"utf8",
					),
				);
			const stamps: unknown[] = [];
			const o = seated({
				gate: () =>
					held-- > 0 ? { limb: "memory", mb: 900, rungMb: 3250 } : false,
				sleepFn: () => {
					stamps.push(readOwnMarker().memoryHeld);
					return Promise.resolve();
				},
			});
			const calls = await run(["--queue", SHARED_FLAG, "scripts/a.test.ts"], o);
			expect(calls).toHaveLength(1);
			expect(stamps).toEqual([true]);
		});

		it("still waits on the memory rung, and refuses at the bound", async () => {
			const said: string[] = [];
			const o = seated({
				gate: () => ({ limb: "memory", mb: 900, rungMb: 3250 }),
				sleepFn: () => Promise.resolve(),
				timeoutMs: -1,
				out: { write: (s: string) => said.push(s) },
			});
			const calls = await run(["--queue", SHARED_FLAG, "scripts/a.test.ts"], o);
			expect(calls).toHaveLength(0);
			expect(said.join("")).toMatch(/gate still denies on memory/);
			expect(readQueueMarkers(o.queueDir)).toEqual(["wfc-suite-queue-20.json"]);
			expect(readJsonl(o.queueLog)).toMatchObject([
				{ reason: "refused", kind: "seat", limb: "memory" },
			]);
		});

		it("queues a whole suite as any other, the seat being part", async () => {
			const o = seated({ root: wholeRepo(), gate: () => false });
			const calls = await run(["--queue", SHARED_FLAG], o);
			expect(calls).toHaveLength(1);
			expect(readJsonl(o.queueLog)).toMatchObject([{ reason: "opened" }]);
		});
	});

	describe("the exit log, one line per queue exit (#1215)", () => {
		const logIn = () => path.join(qdir(), "exits.jsonl");

		it("logs an open gate with its wait, kind and session", async () => {
			const queueLog = logIn();
			let closed = 2;
			await run(["--queue", SHARED_FLAG], {
				gate: () => closed-- > 0,
				sleepFn: () => Promise.resolve(),
				queueLog,
				sessionId: "sess-open",
			});
			const [line, ...more] = readJsonl(queueLog);
			expect(more).toEqual([]);
			expect(line).toMatchObject({
				reason: "opened",
				kind: "bare",
				session: "sess-open",
				empty: false,
				pid: process.pid,
			});
			expect(line.waitS).toBe(0);
			expect(Number.isNaN(Date.parse(line.at))).toBe(false);
		});

		it("logs a part-suite's timeout that ran anyway, naming the count limb", async () => {
			const queueLog = logIn();
			await run(["--queue", SHARED_FLAG, "scripts/a.test.ts"], {
				gate: () => ({ limb: "count" }),
				sleepFn: () => Promise.resolve(),
				timeoutMs: -1,
				queueLog,
			});
			expect(readJsonl(queueLog)).toMatchObject([
				{ reason: "timeout", limb: "count", session: null, empty: false },
			]);
		});

		it("names the launch's kind", async () => {
			const queueLog = logIn();
			await run(["--queue", "-t", "corpus"], { gate: () => false, queueLog });
			expect(readJsonl(queueLog).map((l) => l.kind)).toEqual(["named"]);
		});

		it("never costs the run when the log cannot be written", async () => {
			const queueLog = path.join(qdir(), "missing", "exits.jsonl");
			const said: string[] = [];
			const calls = await run(["--queue", SHARED_FLAG], {
				gate: () => false,
				queueLog,
				err: { write: (line: string) => said.push(line) },
			});
			expect(calls).toHaveLength(1);
			expect(fs.existsSync(queueLog)).toBe(false);
			expect(said.join("")).toMatch(/this exit was not logged/);
		});
	});
});

describe("the queue's ordering, so waiters do not stampede (mantahostels#2024)", () => {
	/* Held to the end of the run, not dropped at launch: dropped early, the next
	 * waiter takes its turn during the gap before vitest is visible to the gate. */
	it("holds its place until the run finishes", async () => {
		const queueDir = qdir();
		const seen: number[] = [];
		const { spawnFn: inner } = spawnReturning({ code: 0 });
		const atSpawn: number[] = [];
		const admittedAtSpawn: unknown[] = [];
		const spawnFn = ((...args: unknown[]) => {
			const names = fs.readdirSync(queueDir);
			atSpawn.push(names.length);
			for (const name of names)
				admittedAtSpawn.push(
					JSON.parse(fs.readFileSync(path.join(queueDir, name), "utf8"))
						.admitted,
				);
			return (inner as (...a: unknown[]) => unknown)(...args);
		}) as typeof inner;
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await main(["--queue", SHARED_FLAG], {
				spawnFn,
				root: repo(),
				fs: fakeFs(),
				out: { write: () => true },
				queueDir,
				pid: 11,
				clock: () => 100,
				gate: () => {
					seen.push(fs.readdirSync(queueDir).length);
					return false;
				},
			});
		} finally {
			stdout.mockRestore();
		}
		expect(seen).toEqual([1]);
		expect(atSpawn).toEqual([1]);
		// Admitted before the launch, so no other waiter's turn comes (#2578).
		expect(admittedAtSpawn).toEqual([true]);
		expect(fs.readdirSync(queueDir)).toEqual([]);
	});
});

describe("a waiter that is KILLED, not resolved (mantahostels#2034)", {
	timeout: REAL_CHILD_TIMEOUT_MS,
}, () => {
	/*
	 * No injected fake reaches a real signal: Node runs no pending `.finally()`
	 * on SIGTERM, so only a killed process shows whether its marker goes.
	 */
	const holder = (queueDir: string) => `
		const { main } = require(${JSON.stringify(path.resolve("scripts/run-vitest.js"))});
		let told = false;
		main(["--queue", "--full=coverage"], {
			queueDir: ${JSON.stringify(queueDir)},
			queueLog: null,
			out: { write: () => true },
			gate: () => {
				if (!told) process.stdout.write("joined\\n");
				told = true;
				return true;
			},
			sleepFn: () => new Promise((r) => setTimeout(r, 50)),
		});
	`;

	const spawnHolder = (queueDir: string) =>
		new Promise<import("node:child_process").ChildProcess>((resolve) => {
			const child = realSpawn(process.execPath, ["-e", holder(queueDir)], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			child.stdout?.on("data", () => resolve(child));
		});

	it("removes its marker when it is SIGTERMed", async () => {
		const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "killq-"));
		dirs.push(queueDir);
		const child = await spawnHolder(queueDir);
		expect(fs.readdirSync(queueDir)).toHaveLength(1);

		await new Promise<void>((resolve) => {
			child.on("exit", () => resolve());
			child.kill("SIGTERM");
		});

		expect(fs.readdirSync(queueDir)).toEqual([]);
	});

	it("removes its marker when it is SIGINTed", async () => {
		const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "killq-"));
		dirs.push(queueDir);
		const child = await spawnHolder(queueDir);

		await new Promise<void>((resolve) => {
			child.on("exit", () => resolve());
			child.kill("SIGINT");
		});

		expect(fs.readdirSync(queueDir)).toEqual([]);
	});

	it("logs its exit when it is SIGTERMed mid-wait", async () => {
		const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), "killq-"));
		dirs.push(queueDir);
		const queueLog = path.join(queueDir, "exits.jsonl");
		const waiter = `
			const { main } = require(${JSON.stringify(path.resolve("scripts/run-vitest.js"))});
			let told = false;
			main(["--queue", "--full=coverage"], {
				queueDir: ${JSON.stringify(queueDir)},
				queueLog: ${JSON.stringify(queueLog)},
				out: { write: () => true },
				gate: () => {
					if (!told) process.stdout.write("waiting\\n");
					told = true;
					return true;
				},
				sleepFn: () => new Promise((r) => setTimeout(r, 50)),
			});
		`;
		const child = await new Promise<import("node:child_process").ChildProcess>(
			(resolve) => {
				const c = realSpawn(process.execPath, ["-e", waiter], {
					stdio: ["ignore", "pipe", "inherit"],
					env: { ...process.env, CLAUDE_CODE_SESSION_ID: "sess-kill" },
				});
				c.stdout?.on("data", () => resolve(c));
			},
		);
		const code = await new Promise<number | null>((resolve) => {
			child.on("exit", (c) => resolve(c));
			child.kill("SIGTERM");
		});

		expect(code).toBe(143);
		expect(readJsonl(queueLog)).toMatchObject([
			{
				reason: "killed",
				signal: "SIGTERM",
				kind: "full",
				session: "sess-kill",
				empty: false,
				pid: child.pid,
			},
		]);
	});
});

describe("a real subprocess, piped and read slowly", {
	timeout: REAL_CHILD_TIMEOUT_MS,
}, () => {
	/*
	 * No injected fake can stand in for whether THIS process's own stdout — a
	 * real pipe here, exactly as `| head` or `| grep` gives it in production —
	 * survives run-vitest.js exiting. `WFC_RUN_VITEST_BIN` points the real
	 * script at a stand-in "vitest" rather than paying for a real suite.
	 */
	it("delivers every byte before the process exits, even where the reader lags behind", async () => {
		// No git repo needed: `CLAUDE_PROJECT_DIR` below makes this temp dir the
		// host root the child resolves, and `repoRoot()` answers null outside a
		// git tree, so the log store lands here too.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runvitest-real-"));
		dirs.push(dir);
		const bin = path.join(dir, "fake-vitest.js");
		const body = Array.from({ length: 4000 }, (_, i) =>
			`line ${i}`.padEnd(120, "x"),
		).join("\n");
		// `exitCode`, not `exit()`, so the stand-in cannot drop its own tail.
		fs.writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				`process.stdout.write(${JSON.stringify(`${body}\n`)});`,
				'process.stdout.write("MARKER_END_OF_OUTPUT\\n");',
				"process.exitCode = 7;",
				"",
			].join("\n"),
		);
		fs.chmodSync(bin, 0o755);

		const child = realSpawn(
			process.execPath,
			// `--shared`: bare argv escalates, and mantahostels#2278's isolated-by-default
			// would then want a worktree, which a non-git temp root cannot give.
			[path.join(__dirname, "run-vitest.js"), SHARED_FLAG],
			{
				env: {
					...process.env,
					WFC_RUN_VITEST_BIN: bin,
					// #154: against the real root, the child's log would evict a real
					// suite's output from the live store.
					CLAUDE_PROJECT_DIR: dir,
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);

		// `close` is registered first: a buggy `exit()` closes the child inside
		// the 300ms pause below, and an EventEmitter never replays a fired event,
		// so a later listener would show the truncation as a timeout.
		const closed = new Promise<number | null>((resolve) => {
			child.on("close", resolve);
		});

		// A slow reader: pause immediately, so run-vitest.js's own writes queue
		// up against this process's end of the pipe exactly as they would
		// behind a slow `| head` — then only start draining well after the
		// child has had time to exit, if it were going to exit early.
		// Attaching a `data` listener puts a stream into flowing mode by
		// itself — `pause()` has to come AFTER, or it is immediately undone.
		let received = "";
		child.stdout.on("data", (chunk: Buffer) => {
			received += chunk.toString();
		});
		child.stdout.pause();
		await new Promise((r) => setTimeout(r, 300));
		child.stdout.resume();

		const code = await closed;
		// Whatever Node still had queued for delivery at 'close' finishes
		// arriving on this same tick's microtasks/immediates.
		await new Promise((r) => setImmediate(r));

		expect(code).toBe(7);
		expect(received).toContain("MARKER_END_OF_OUTPUT");
		expect(received).toContain("TEST LOG:");
		// Both limbs: the count alone misses a second write site reaching the
		// live store, the live-store check alone a child that wrote no log.
		expect(
			fs.readdirSync(dirPath(dir)).filter((n) => n.endsWith(".log")),
		).toHaveLength(1);
		// Keyed on this child's pid, never a before/after count: a neighbour
		// suite writing or reaping mid-case would flake the count.
		// An isolated worktree has no log store at all, which is the same
		// evidence as an empty one.
		const liveStore = fs.existsSync(dirPath(REPO_ROOT))
			? fs.readdirSync(dirPath(REPO_ROOT))
			: [];
		expect(
			liveStore.filter((n) => n.endsWith(`-${child.pid}.log`)),
		).toHaveLength(0);
	});
});

describe("a runner flag npm swallowed, launched through `npm run` (#2284)", {
	timeout: REAL_CHILD_TIMEOUT_MS,
}, () => {
	function npmRun(args: string[], baked = "") {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runvitest-npm-"));
		dirs.push(dir);
		const ran = path.join(dir, "vitest-ran");
		const bin = path.join(dir, "fake-vitest.js");
		fs.writeFileSync(
			bin,
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(ran)}, "");\n`,
		);
		fs.chmodSync(bin, 0o755);
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				name: "fixture",
				scripts: {
					t: `node ${JSON.stringify(path.join(__dirname, "run-vitest.js"))}${baked}`,
				},
			}),
		);
		const child = realSpawn("npm", ["run", "t", ...args], {
			cwd: dir,
			env: { ...process.env, WFC_RUN_VITEST_BIN: bin, CLAUDE_PROJECT_DIR: dir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.stdout.resume();
		return new Promise<{ code: number | null; stderr: string; ran: boolean }>(
			(resolve) => {
				child.on("close", (code) =>
					resolve({ code, stderr, ran: fs.existsSync(ran) }),
				);
			},
		);
	}

	it("refuses a --queue written without --, naming the form that queues, and runs nothing", async () => {
		const result = await npmRun(["--queue"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("\n  npm run t -- --queue\n");
		expect(result.ran).toBe(false);
	});

	it("puts a swallowed flag's value back after it, past the words the script bakes in", async () => {
		const result = await npmRun(["--retest", "a.test.ts"], " --changed");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("\n  npm run t -- --retest a.test.ts\n");
		expect(result.ran).toBe(false);
	});

	it.each([
		[["--changed", "--adopt", "x"], "--changed and --adopt"],
		[["--adopt", "x", "--retest", "a.test.ts"], "--adopt and --retest"],
		[["--retest", "a.test.ts", "--changed"], "--retest and --changed"],
	])(
		"refuses %j, naming its selection flags in argv order, and runs nothing (#2764)",
		async (args, named) => {
			const result = await npmRun(["--", ...args]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`${named} each pick the run's tests`);
			expect(result.ran).toBe(false);
		},
	);

	it("runs a flag written after --, which npm passes through", async () => {
		const result = await npmRun(["--", SHARED_FLAG]);
		expect(result.stderr).not.toContain("NPM TOOK");
		expect(result.ran).toBe(true);
	});
});

/*
 * The stall watchdog (mantahostels#1910's follow-on). The fault cannot be reproduced in
 * process, so the child is a fake that emits nothing and never closes.
 */
describe("the stall watchdog", () => {
	const { readFailures } = require("./lib/test-pass-marker.js");

	/** Runs `main` against a parked child with a 20 ms ceiling. */
	async function parked(root: string, inflightFile?: string) {
		const child = parkedChild();
		const err = sink();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			const code = await main([SHARED_FLAG], {
				spawnFn: () => child,
				root,
				stall: 20,
				err,
				...(inflightFile ? { inflightFile } : {}),
			});
			return { code, said: err.text.join(""), child };
		} finally {
			stdout.mockRestore();
		}
	}

	it("kills a run that has emitted nothing, and fails it as SUITE STALLED", async () => {
		const root = repo();

		const { code, said, child } = await parked(root);

		expect(child.signals).toEqual(["SIGKILL"]);
		expect(code).toBe(1);
		expect(said).toContain("SUITE STALLED");
	});

	it("names the module that started and never finished", async () => {
		const root = repo();
		const at = path.join(root, "run.inflight.json");
		fs.writeFileSync(
			at,
			JSON.stringify({
				open: [
					{
						module: path.join(root, "slow.test.ts"),
						stage: "running its tests",
					},
				],
				finished: [],
			}),
		);

		const { said } = await parked(root, at);

		expect(said).toContain("slow.test.ts — running its tests");
	});

	it("says so plainly when nothing was recorded, rather than implying an empty run", async () => {
		const root = repo();

		const { said } = await parked(root);

		expect(said).toContain("No module was recorded as in flight");
	});

	it("points at the blocking call rather than at worker settings", async () => {
		const root = repo();

		const { said } = await parked(root);

		expect(said).toContain("STOPPED run, not a slow one");
		expect(said).toContain("WFC_TEST_STALL_MS");
	});

	it("does not fire while the child is still producing output", async () => {
		const root = repo();
		const child = parkedChild();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		/* 25 ms beats against a 400 ms ceiling, run for four of them — 16x, wide
		 * enough that ordinary scheduling jitter cannot read as a stall. Not
		 * derived from concurrent-suite contention, which mantahostels#2015 now rules out. */
		const beat = setInterval(() => child.stdout.write("."), 25);
		const run = main([SHARED_FLAG], { spawnFn: () => child, root, stall: 400 });
		await new Promise((r) => setTimeout(r, 120));
		clearInterval(beat);
		const midway = [...child.signals];
		child.stdout.end();
		child.stderr.end();
		child.emit("close", 0);
		const code = await run;
		stderr.mockRestore();
		stdout.mockRestore();

		expect(midway).toEqual([]);
		expect(code).toBe(0);
	});

	/* A killed child normally reports code null, which the wrapper already fails
	 * on; this pins the separate limb. */
	it("fails a stalled run even where the child reports success", async () => {
		const root = repo();
		const child = parkedChild();
		child.kill = () => {
			child.signals.push("SIGKILL");
			child.stdout.end();
			child.stderr.end();
			child.emit("close", 0);
			return true;
		};
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const code = await main([SHARED_FLAG], {
			spawnFn: () => child,
			root,
			stall: 20,
		});
		stderr.mockRestore();
		stdout.mockRestore();

		expect(code).toBe(1);
	});

	/** Runs `main` against a parked child whose in-flight record is touched
	 * every 25 ms for `beatFor` ms, then left alone. */
	function beating(stall: number, beatFor: number) {
		const root = repo();
		const at = path.join(root, "run.inflight.json");
		fs.writeFileSync(at, JSON.stringify({ open: [], finished: [] }));
		const child = parkedChild();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const beat = setInterval(() => {
			const t = new Date();
			fs.utimesSync(at, t, t);
		}, 25);
		const quiet = setTimeout(() => clearInterval(beat), beatFor);
		const run = main([SHARED_FLAG], {
			spawnFn: () => child,
			root,
			stall,
			inflightFile: at,
		});
		const done = () => {
			clearInterval(beat);
			clearTimeout(quiet);
			stderr.mockRestore();
			stdout.mockRestore();
		};
		return { child, run, done };
	}

	/* #1149: a long file prints nothing until it ends, so the reporter's beats
	 * on the in-flight record must hold the watchdog off on their own. Same 16x
	 * margin as the output case above. */
	it("does not fire while the in-flight record keeps being touched", async () => {
		const { child, run, done } = beating(400, 1200);
		await new Promise((r) => setTimeout(r, 1200));
		const midway = [...child.signals];
		child.stdout.end();
		child.stderr.end();
		child.emit("close", 0);
		const code = await run;
		done();

		expect(midway).toEqual([]);
		expect(code).toBe(0);
	});

	it("still fires once the beats stop", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
		try {
			const { child, run, done } = beating(100, 300);
			await vi.advanceTimersByTimeAsync(299);
			const midway = [...child.signals];
			await vi.advanceTimersByTimeAsync(200);
			const code = await run;
			done();

			expect(midway).toEqual([]);
			expect(child.signals).toEqual(["SIGKILL"]);
			expect(code).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("says so when the kill cannot be recorded, rather than reading as no kill", async () => {
		const root = repo();
		fs.mkdirSync(path.join(root, ".claude", "tmp"), { recursive: true });
		fs.writeFileSync(path.join(root, ".claude", "tmp", "markers"), "");

		const { code, said } = await parked(root);

		expect(code).toBe(1);
		expect(said).toContain("This kill was not recorded");
	});

	it("records the kill as a stalled red, naming what was in flight and what finished", async () => {
		const root = repo();
		const at = path.join(root, "run.inflight.json");
		const slow = path.join(root, "slow.test.ts");
		const done = path.join(root, "done.test.ts");
		fs.writeFileSync(
			at,
			JSON.stringify({
				open: [{ module: slow, stage: "running its tests" }],
				finished: [done],
			}),
		);

		await parked(root, at);

		const reds = readFailures({ root });
		expect(reds).toHaveLength(1);
		expect(reds[0]).toMatchObject({
			stalled: true,
			stallMs: 20,
			inflight: [{ module: slow, stage: "running its tests" }],
			finished: [done],
		});
		/* No scope, so no reader of reds takes it for a verdict on a file. */
		expect(reds[0].scope).toBeUndefined();
	});

	it("is disabled by a zero ceiling", async () => {
		const root = repo();
		const child = parkedChild();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const run = main([SHARED_FLAG], { spawnFn: () => child, root, stall: 0 });
		await new Promise((r) => setTimeout(r, 120));
		const midway = [...child.signals];
		child.stdout.end();
		child.stderr.end();
		child.emit("close", 0);
		await run;
		stderr.mockRestore();
		stdout.mockRestore();

		expect(midway).toEqual([]);
	});
});

describe("the stall ceiling from the environment", () => {
	const stallEnv = "WFC_TEST_STALL_MS";
	/* The ceiling an unset, empty or unreadable variable leaves in force. */
	const defaultMs = 300_000;
	/* What the last `killedAfter` printed to stderr. */
	let said = "";

	/**
	 * `main` against a parked child, its ceiling read from the variable alone,
	 * on a fake clock: whether the child is killed `ms` after it spawned.
	 */
	async function killedAfter(ms: number) {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const err = sink();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const child = parkedChild();
		let spawned = () => {
			/* replaced by the promise's resolve below */
		};
		const up = new Promise<void>((resolve) => {
			spawned = resolve;
		});
		const root = repo();
		try {
			const run = main([SHARED_FLAG], {
				spawnFn: () => {
					spawned();
					return child;
				},
				root,
				inflightFile: path.join(root, "run.inflight.json"),
				err,
			});
			await up;
			await vi.advanceTimersByTimeAsync(ms);
			const killed = child.signals.length > 0;
			if (!killed) child.emit("close", 0);
			await run;
			said = err.text.join("");
			return killed;
		} finally {
			vi.useRealTimers();
			stdout.mockRestore();
		}
	}

	it("defaults where the variable is unset or empty", async () => {
		for (const value of [undefined, ""]) {
			// Stubbing undefined deletes WFC_TEST_STALL_MS, so an ambient value —
			// the bench runs every suite at 0 (#1603) — cannot leak into the
			// unset case.
			vi.stubEnv(stallEnv, value);
			expect(await killedAfter(defaultMs - 1)).toBe(false);
			expect(await killedAfter(defaultMs)).toBe(true);
		}
	});

	it("takes a number that is given", async () => {
		vi.stubEnv(stallEnv, "1000");
		expect(await killedAfter(999)).toBe(false);
		expect(await killedAfter(1000)).toBe(true);
	});

	/* The suite ceiling, which zero never disables, is what ends this run. */
	it("takes zero, which disables the watchdog", async () => {
		vi.stubEnv(stallEnv, "0");
		await killedAfter(defaultMs * 10);
		expect(said).not.toContain("SUITE STALLED");
		expect(said).toContain("SUITE CEILING");
	});

	/* A typo must not read as zero: that would silently remove the protection
	 * rather than the ceiling the author was reaching for. */
	it("ignores a value that is not a number, rather than disarming", async () => {
		for (const value of ["five minutes", "-1"]) {
			vi.stubEnv(stallEnv, value);
			expect(await killedAfter(defaultMs - 1)).toBe(false);
			expect(await killedAfter(defaultMs)).toBe(true);
		}
	});
});

/*
 * The suite ceiling (#2696, ruled at #2667): every run is killed a fixed time
 * after vitest spawns, whatever its output, with its whole process group.
 */
describe("the suite ceiling", () => {
	const { readFailures } = require("./lib/test-pass-marker.js");
	const {
		CEILING_CLOSE,
		CEILING_ENV,
		CEILING_MS,
	} = require("./lib/suite-ceiling.js");

	/** `main` against `child`, its output captured; resolves on its exit. */
	async function run(
		root: string,
		child: ReturnType<typeof parkedChild>,
		opts: { stall: number; ceiling: number; inflightFile?: string },
		argv = [SHARED_FLAG],
	) {
		const err = sink();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			const code = await main(argv, {
				spawnFn: () => child,
				root,
				err,
				...opts,
			});
			return { code, said: err.text.join("") };
		} finally {
			stdout.mockRestore();
		}
	}

	/** A parked child that prints a dot every 5 ms until it is killed. */
	function printingChild() {
		const child = parkedChild();
		const dots = setInterval(() => child.stdout.write("."), 5);
		child.on("close", () => clearInterval(dots));
		return child;
	}

	it("kills a run that keeps printing past it and fails it, its report naming the ceiling and that no setting raises it", async () => {
		const root = repo();
		const child = printingChild();

		const { code, said } = await run(root, child, {
			stall: 60_000,
			ceiling: 100,
		});

		expect(child.signals).toEqual(["SIGKILL"]);
		expect(code).toBe(1);
		expect(said).toMatch(
			/SUITE CEILING — killed \d+\.\ds after vitest spawned, at the 0\.1s ceiling \(#2667\)/,
		);
		expect(said).toContain(CEILING_CLOSE.join("\n"));
		expect(said).not.toContain("SUITE STALLED");
	});

	it("names the files in flight, then those never started, then how many finished", async () => {
		const root = repo();
		const at = path.join(root, "run.inflight.json");
		const [a, b, c, d] = ["a", "b", "c", "d"].map((n) =>
			path.join(root, `${n}.test.ts`),
		);
		fs.writeFileSync(
			at,
			JSON.stringify({
				open: [{ module: b, stage: "running its tests" }],
				finished: [a],
				scheduled: [a, b, c, d],
			}),
		);

		const { said } = await run(root, printingChild(), {
			stall: 60_000,
			ceiling: 50,
			inflightFile: at,
		});

		const order = [
			"b.test.ts — running its tests",
			"Never started: 2",
			"c.test.ts",
			"d.test.ts",
			"Finished: 1 file(s).",
		].map((line) => said.indexOf(line));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((x, y) => x - y)).toEqual(order);
	});

	it("says so where no schedule was recorded, rather than naming none", async () => {
		const { said } = await run(repo(), printingChild(), {
			stall: 60_000,
			ceiling: 50,
		});

		expect(said).toContain("No schedule was recorded");
	});

	it("writes no certificate and one fail record of its own kind", async () => {
		const root = repo();
		const at = path.join(root, "run.inflight.json");
		const slow = path.join(root, "slow.test.ts");
		const left = path.join(root, "left.test.ts");
		fs.writeFileSync(
			at,
			JSON.stringify({
				open: [{ module: slow, stage: "loading" }],
				finished: [],
				scheduled: [slow, left],
			}),
		);

		await run(root, printingChild(), {
			stall: 60_000,
			ceiling: 50,
			inflightFile: at,
		});

		const reds = readFailures({ root });
		expect(reds).toHaveLength(1);
		expect(reds[0]).toMatchObject({
			ceilingKill: true,
			ceilingMs: 50,
			inflight: [{ module: slow, stage: "loading" }],
			finished: [],
			neverStarted: [left],
		});
		expect(reds[0].stalled).toBeUndefined();
		expect(reds[0].scope).toBeUndefined();
		expect(typeof reds[0].startedAt).toBe("string");
		expect(typeof reds[0].durationMs).toBe("number");
		expect(reds[0].argv).toEqual(expect.any(Array));
		/* Linux's /proc answers; elsewhere the reading is left off. */
		expect(reds[0].machine).toMatchObject({ load1: expect.anything() });
	});

	it("records a whole run's `full` on its kill, which carries no scope (#3237)", async () => {
		const root = repo();
		await run(root, printingChild(), { stall: 60_000, ceiling: 50 }, [
			"--full=push-gate",
			SHARED_FLAG,
		]);

		const reds = readFailures({ root });
		expect(reds).toHaveLength(1);
		expect(reds[0]).toMatchObject({ ceilingKill: true, full: "flag" });
	});

	it("settles at 1 where `close` never arrives, and lets go of the pipes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const child = parkedChild();
		/* A descendant outside the group holds the pipes: no `close`. */
		child.kill = (signal = "SIGTERM") => {
			child.signals.push(signal);
			return true;
		};
		try {
			const done = main([SHARED_FLAG], {
				spawnFn: () => child,
				root: repo(),
				stall: 0,
				ceiling: 50,
			});
			await vi.advanceTimersByTimeAsync(50 + 10_000);

			expect(await done).toBe(1);
			expect([child.stdout.destroyed, child.stderr.destroyed]).toEqual([
				true,
				true,
			]);
		} finally {
			vi.useRealTimers();
			stderr.mockRestore();
			stdout.mockRestore();
		}
	});

	it("leaves the silence watchdog firing first on a silent run", async () => {
		const root = repo();

		const { code, said } = await run(root, parkedChild(), {
			stall: 20,
			ceiling: 60_000,
		});

		expect(code).toBe(1);
		expect(said).toContain("SUITE STALLED");
		expect(said).not.toContain("SUITE CEILING");
		expect(readFailures({ root })).toMatchObject([{ stalled: true }]);
	});

	it("still kills a silent run where the watchdog is off", async () => {
		const child = parkedChild();

		const { code, said } = await run(repo(), child, { stall: 0, ceiling: 50 });

		expect(child.signals).toEqual(["SIGKILL"]);
		expect(code).toBe(1);
		expect(said).toContain("SUITE CEILING");
	});

	describe("from the environment", () => {
		/** Whether a silent child is killed `ms` after it spawned, the
		 * watchdog off and the ceiling read from the environment alone. */
		async function killedAfter(ms: number) {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const child = parkedChild();
			let spawned = () => {
				/* replaced by the promise's resolve below */
			};
			const up = new Promise<void>((resolve) => {
				spawned = resolve;
			});
			const root = repo();
			try {
				const done = main([SHARED_FLAG], {
					spawnFn: () => {
						spawned();
						return child;
					},
					root,
					stall: 0,
					inflightFile: path.join(root, "run.inflight.json"),
				});
				await up;
				await vi.advanceTimersByTimeAsync(ms);
				const killed = child.signals.length > 0;
				if (!killed) child.emit("close", 0);
				await done;
				return killed;
			} finally {
				vi.useRealTimers();
				stderr.mockRestore();
				stdout.mockRestore();
			}
		}

		it("takes a lower value", async () => {
			vi.stubEnv(CEILING_ENV, "1000");
			expect(await killedAfter(999)).toBe(false);
			expect(await killedAfter(1000)).toBe(true);
		});

		/* Nothing may raise the ceiling or turn it off (#2667). */
		it.each([String(CEILING_MS * 2), "0", "fourteen minutes", "-1"])(
			"keeps the ceiling in force against %s",
			async (value) => {
				vi.stubEnv(CEILING_ENV, value);
				expect(await killedAfter(CEILING_MS - 1)).toBe(false);
				expect(await killedAfter(CEILING_MS)).toBe(true);
			},
		);
	});

	/* These cross the real clock: what is pinned is a real kill of a real
	 * process group, which no fake clock reaches. */
	describe("on real processes", { timeout: REAL_CHILD_TIMEOUT_MS }, () => {
		/** A stand-in vitest: a shell that starts a sleeping grandchild in its
		 * own group, records both pids and the deadline file, then prints until
		 * it is killed. */
		function standIn(dir: string, deadlineFile: string) {
			const bin = path.join(dir, "fake-vitest.sh");
			fs.writeFileSync(
				bin,
				[
					"#!/bin/sh",
					`sleep 300 & echo $! > "${dir}/grandchild"`,
					`echo $$ > "${dir}/child"`,
					/* The runner writes the deadline just after the spawn. */
					`while [ ! -s "${deadlineFile}" ]; do sleep 0.01; done`,
					`cp "${deadlineFile}" "${dir}/deadline-seen"`,
					`touch "${dir}/ready"`,
					"while :; do echo .; sleep 0.05; done",
					"",
				].join("\n"),
			);
			fs.chmodSync(bin, 0o755);
			return bin;
		}

		it("kills the whole group, a grandchild included, and drops its deadline", async () => {
			const root = repo();
			const deadlineFile = path.join(root, "deadline");
			vi.stubEnv(DEADLINE_ENV, deadlineFile);
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const bin = standIn(root, deadlineFile);
			let code: number;
			try {
				/* The ceiling is long enough for the shell to start its grandchild
				 * first; `ready` proves it did before the kill. */
				code = await main([SHARED_FLAG], {
					root,
					bin,
					stall: 0,
					ceiling: 3000,
					expand: () => null,
					inflightFile: path.join(root, "run.inflight.json"),
				});
			} finally {
				stderr.mockRestore();
				stdout.mockRestore();
			}
			/* Fails rather than hangs where the kill beat the shell's start. */
			expect(fs.existsSync(path.join(root, "ready"))).toBe(true);

			const child = Number(fs.readFileSync(path.join(root, "child"), "utf8"));
			const grandchild = Number(
				fs.readFileSync(path.join(root, "grandchild"), "utf8"),
			);
			const [deadline, pgid] = fs
				.readFileSync(path.join(root, "deadline-seen"), "utf8")
				.trim()
				.split(" ")
				.map(Number);
			expect(code).toBe(1);
			expect(pgid).toBe(child);
			expect(Number.isInteger(deadline)).toBe(true);
			expect(fs.existsSync(deadlineFile)).toBe(false);
			/* Killed, though reaping an orphan can trail the kill; how long
			 * that takes under load is unmeasured, so 10 s is a guess. */
			const by = Date.now() + 10_000;
			while (!(isDead(child) && isDead(grandchild)) && Date.now() < by)
				await new Promise((r) => setTimeout(r, 50));
			expect([isDead(child), isDead(grandchild)]).toEqual([true, true]);
		});
	});
});

/* #3494: where no user scope is made, a worker that left vitest's group and
 * hangs in a synchronous call outlives the group kill, reparented to init,
 * unless the run's environ sweep finds it. A plain spawn is the path
 * spawnInRunScope falls back to when the user manager does not answer. */
describe("a reparented worker with no user scope", {
	timeout: REAL_CHILD_TIMEOUT_MS,
}, () => {
	/** A stand-in vitest that starts such a worker, records both pids, then
	 * parks silent. */
	function standIn(root: string) {
		const bin = path.join(root, "fake-vitest.sh");
		fs.writeFileSync(
			bin,
			[
				"#!/bin/sh",
				/* Not the group's leader, so setsid execs in place: $! is the
				 * worker, in a session and group of its own. Off vitest's
				 * pipes, so the run settles without waiting on it. */
				`setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "${root}/worker.tmp"`,
				`echo $$ > "${root}/child"`,
				`mv "${root}/worker.tmp" "${root}/worker"`,
				"exec sleep 300",
				"",
			].join("\n"),
		);
		fs.chmodSync(bin, 0o755);
		return bin;
	}

	const pidIn = (root: string, name: string) =>
		Number(fs.readFileSync(path.join(root, name), "utf8"));

	/** Whether `pid` died within 10 s, SIGKILLed here where it did not.
	 * Reaping an orphan can trail the kill; 10 s and its 50 ms poll are
	 * guesses. */
	async function diedWithin(pid: number) {
		const by = Date.now() + 10_000;
		while (!isDead(pid) && Date.now() < by)
			await new Promise((r) => setTimeout(r, 50));
		const alive = !isDead(pid);
		if (alive) process.kill(pid, "SIGKILL");
		return !alive;
	}

	it("kills it after a stall kill", async () => {
		const root = repo();
		const bin = standIn(root);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		let code: number;
		try {
			code = await main([SHARED_FLAG], {
				root,
				bin,
				spawnFn: realSpawn,
				/* A guess: long enough for the shell to start the worker. */
				stall: 1000,
				expand: () => null,
				inflightFile: path.join(root, "run.inflight.json"),
			});
		} finally {
			stderr.mockRestore();
			stdout.mockRestore();
		}
		expect(code).toBe(1);
		expect(isDead(pidIn(root, "child"))).toBe(true);
		expect(await diedWithin(pidIn(root, "worker"))).toBe(true);
	});

	/** The wrapper in a process of its own over the stand-in, with
	 * `killCarrierSource` as its carrier kill where given, resolved once the
	 * worker has started; `stderr` collects what the wrapper writes there. */
	async function launchWrapper(root: string, killCarrierSource = "") {
		const wrapper = realSpawn(
			process.execPath,
			[
				"-e",
				`require(${JSON.stringify(path.resolve("scripts/run-vitest.js"))}).main(
					[${JSON.stringify(SHARED_FLAG)}],
					{
						root: ${JSON.stringify(root)},
						bin: ${JSON.stringify(standIn(root))},
						spawnFn: require("node:child_process").spawn,
						stall: 0,
						expand: () => null,
						out: { write: () => true },
						err: { write: () => true },
						inflightFile: ${JSON.stringify(path.join(root, "run.inflight.json"))},
						${killCarrierSource && `killCarrier: ${killCarrierSource},`}
					},
				);`,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		wrapper.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const ready = path.join(root, "worker");
		/* As long as the stall case's guess allows the shell to start. */
		const by = Date.now() + 10_000;
		while (!fs.existsSync(ready) && Date.now() < by)
			await new Promise((r) => setTimeout(r, 50));
		return {
			stderr: () => stderr,
			kill: (signal: NodeJS.Signals) =>
				new Promise<void>((resolve) => {
					wrapper.on("close", () => resolve());
					wrapper.kill(signal);
				}),
		};
	}

	/* A harness kill of the wrapper: vitest leads a group of its own, so the
	 * harness's group kill never reaches it, and only the wrapper's own
	 * signal handler can. */
	it("kills it when the wrapper is SIGTERMed", async () => {
		const root = repo();
		await (await launchWrapper(root)).kill("SIGTERM");
		expect(await diedWithin(pidIn(root, "worker"))).toBe(true);
	});

	it("names a carrier kill that fails on a SIGTERM (#3528)", async () => {
		const root = repo();
		/* Refuses every carrier kill; the group kill is not the port's. */
		const wrapper = await launchWrapper(
			root,
			`() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }`,
		);
		await wrapper.kill("SIGTERM");
		const worker = pidIn(root, "worker");
		const child = pidIn(root, "child");
		for (const pid of [worker, child])
			if (!isDead(pid)) process.kill(pid, "SIGKILL");
		expect(wrapper.stderr()).toMatch(
			/a process of this run could not be killed \(EPERM\)/,
		);
	});

	/* A SIGKILL runs no handler: the next run's start sweep, which the next
	 * session start's reaper shares, is what reaches it. */
	it("leaves it to the next run's sweep when the wrapper is SIGKILLed (#3528)", async () => {
		const root = repo();
		await (await launchWrapper(root)).kill("SIGKILL");
		const ours = new Set([pidIn(root, "worker"), pidIn(root, "child")]);
		let said = "";
		sweepAtStart({
			err: {
				write: (s: string) => {
					said += s;
				},
			},
			/* Only this case's, and a neighbour's sweep may have beaten it to
			 * them: either way they are gone. */
			kill: (pid: number, signal: NodeJS.Signals) => {
				if (!ours.has(pid))
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				process.kill(pid, signal);
			},
		});
		expect(said).not.toMatch(/could not be killed/);
		expect(await diedWithin(pidIn(root, "worker"))).toBe(true);
	});
});

it("names what the start sweep killed and what it could not (#3528)", () => {
	const proc = path.join(repo(), "proc");
	writeEnviron(proc, 300, ["WFC_INFLIGHT_OWNER=900"]);
	writeEnviron(proc, 301, ["WFC_INFLIGHT_OWNER=900"]);
	let said = "";
	sweepAtStart({
		proc,
		alive: () => false,
		err: {
			write: (s: string) => {
				said += s;
			},
		},
		kill: (pid: number) => {
			if (pid === 301)
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
		},
	});
	expect(said).toBe(
		"killed 1 process(es) left by a killed run (wrapper pid 900).\n" +
			"a process of a killed run could not be killed (EPERM); it may still hold memory.\n",
	);
});

describe("the per-run in-flight file", () => {
	/** Captures the env the wrapper hands its child. */
	function envFrom(root: string) {
		let seen: Record<string, string> | null = null;
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		queueMicrotask(() => {
			child.stdout.end();
			child.stderr.end();
			child.emit("close", 0);
		});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const run = main([SHARED_FLAG], {
			spawnFn: (
				_bin: string,
				_args: string[],
				opts: { env: Record<string, string> },
			) => {
				seen = opts.env;
				return child;
			},
			root,
		}).then(() => {
			stdout.mockRestore();
			return seen;
		});
		return run;
	}

	/* One shared filename would let a neighbour's run end delete the rows a
	 * parked run's report is built from — the contended case the watchdog is
	 * for. */
	it("names a file of this run's own for the reporter to write", async () => {
		const inflight = require("./lib/test-inflight.js");

		const env = (await envFrom(repo())) as Record<string, string>;

		expect(env[inflight.INFLIGHT_ENV]).toContain(String(process.pid));
		expect(env[inflight.INFLIGHT_ENV]).not.toBe(
			path.join(repo(), ".claude", "tmp", "markers", ".test-inflight.json"),
		);
	});

	it("keeps its deadline file from a runner a test drives inside vitest (#2704)", async () => {
		const root = repo();
		vi.stubEnv(DEADLINE_ENV, path.join(root, "deadline"));

		const env = (await envFrom(root)) as Record<string, string>;

		expect(env).not.toHaveProperty(DEADLINE_ENV);
	});
});

/** A git and vitest whose answers change when `move()` is called. */
const world = (
	before: { changed: string[]; selects: string[] },
	after: { changed: string[]; selects: string[] },
) => {
	let moved = false;
	const listed: string[][] = [];
	const fn = (file: string, args: string[]) => {
		const now = moved ? after : before;
		if (file === "git") {
			if (args[0] === "rev-parse") return moved ? "bbb\n" : "aaa\n";
			if (args[0] === "diff") return `${now.changed.join("\n")}\n`;
			return "";
		}
		listed.push(args);
		return `${now.selects.join("\n")}\n`;
	};
	return {
		fn,
		listed,
		move: () => {
			moved = true;
		},
	};
};

/**
 * A git and vitest whose diff empties when `move()` is called. Pre-queue
 * probe: a test. Re-check: none. The run's own selection, after a
 * neighbour's commit: a test again.
 */
const refillWorld = () => {
	let listed = 0;
	let moved = false;
	const fn = (_file: string, args: string[]) => {
		if (args[0] === "rev-parse") return moved ? "bbb\n" : "aaa\n";
		if (args[0] === "diff")
			return moved ? "docs/fixture-untested.md\n" : "docs/fixture-doc.md\n";
		listed += 1;
		return listed === 2 ? "\n" : "a.test.ts\n";
	};
	return {
		fn,
		move: () => {
			moved = true;
		},
	};
};

/**
 * A git and vitest whose HEAD `move()` moves, leaving a bare default's diff
 * on a doc no test reads, so a queued run's re-check leaves the queue.
 */
const leavingWorld = () => {
	let moved = false;
	/* Each call's answer before the move, then after it. */
	const answers: Record<string, [string, string]> = {
		HEAD: ["aaa\n", "bbb\n"],
		diff: ["a.test.ts\n", "docs/fixture-untested.md\n"],
		list: ["a.test.ts\n", "\n"],
	};
	const rest = fakeExec();
	const fn = (file: string, args: string[], opts: { cwd: string }) => {
		const key =
			args[0] === "rev-parse" && args.includes("HEAD") ? "HEAD" : args[0];
		const answer = key === undefined ? undefined : answers[key];
		return answer ? answer[moved ? 1 : 0] : rest(file, args, opts);
	};
	return {
		fn,
		move: () => {
			moved = true;
		},
	};
};

/**
 * A git and vitest where `push()` moves `pushed`, origin/main by default. HEAD
 * never moves, so only a read of that ref sees the push; the diff and listing
 * answer by merge-base, so only a fresh one empties them.
 */
const pushWorld = (ref = "origin/main") => {
	let pushed = false;
	const diffs: Record<string, string> = {
		staleBase: "docs/fixture-doc.md",
		pushedBase: "docs/fixture-untested.md",
	};
	const answers = new Map<string, (args: string[]) => string>([
		[
			"rev-parse",
			(args) =>
				args.includes(ref)
					? `${pushed ? "pushedTip" : "staleTip"}\n`
					: "head\n",
		],
		["merge-base", () => `${pushed ? "pushedBase" : "staleBase"}\n`],
		["diff", (args) => `${diffs[args.at(-1) ?? ""] ?? "scripts/lib/x.js"}\n`],
	]);
	const fn = (_file: string, args: string[]) => {
		const answer = answers.get(args[0] ?? "");
		if (answer) return answer(args);
		/* `vitest list --changed <base>`. */
		return args.includes("staleBase") ? "a.test.ts\n" : "\n";
	};
	return {
		fn,
		push: () => {
			pushed = true;
		},
	};
};

describe("the run-cost report after the suite's summary (#1883)", () => {
	const { TIMINGS_ENV } = require("./lib/test-file-timings.js");
	/* Pinned on the report's side by `run-cost-report.test.ts`. */
	const costPrefix = "RUN COST:";

	/* Built once and only read: the wrapper diffs it and writes nothing to it.
	 * `old` and `reader` are committed; `old` is then edited and `new` left
	 * untracked, so `reader` is a file the run only selected as a reader. */
	let tree: string;
	beforeAll(() => {
		tree = repo();
		/* Kept past each case's cleanup. */
		dirs.pop();
		const git = (...args: string[]) =>
			require("node:child_process").spawnSync("git", args, { cwd: tree });
		fs.writeFileSync(path.join(tree, "old.test.ts"), "// old\n");
		fs.writeFileSync(path.join(tree, "reader.test.ts"), "// reader\n");
		git("add", ".");
		git("commit", "-q", "-m", "tests");
		fs.writeFileSync(path.join(tree, "old.test.ts"), "// old, edited\n");
		fs.writeFileSync(path.join(tree, "new.test.ts"), "// new\n");
	});
	afterAll(() => fs.rmSync(tree, { recursive: true, force: true }));

	/** A child that leaves `written` where the wrapper names the timings
	 * file, as the in-flight reporter does at the run's end — the seam the
	 * figures come in through, never a real slow file (§X9). */
	function spawnTiming(written: string | null, code: number) {
		return (
			_bin: string,
			_args: string[],
			opts: { env: Record<string, string> },
		) => {
			if (written !== null) fs.writeFileSync(opts.env[TIMINGS_ENV], written);
			return fakeChild({ stdoutChunks: ["Test Files  3 passed\n"], code });
		};
	}

	async function run(written: string | null, code = 0) {
		const io = fakeFs();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		let result: number;
		let said: string;
		try {
			result = await main([SHARED_FLAG], {
				spawnFn: spawnTiming(written, code),
				root: tree,
				fs: io,
				timingsFile: path.join(qdir(), "timings.json"),
			});
			said = stdout.mock.calls.map((c) => String(c[0])).join("");
		} finally {
			stdout.mockRestore();
		}
		const log = Object.values(io.written)
			.map((chunks) => Buffer.concat(chunks).toString())
			.join("");
		const costLines = said
			.split("\n")
			.filter((line) => line.startsWith(costPrefix));
		return { result, said, log, costLines };
	}

	const timed = (seconds: Record<string, number>) =>
		JSON.stringify(
			Object.fromEntries(
				Object.entries(seconds).map(([f, s]) => [path.join(tree, f), s]),
			),
		);

	beforeEach(() => {
		vi.stubEnv("CI", "");
	});

	it.each([0, 3])(
		"names a new file over budget and marks a pre-existing one, the exit staying the suite's %i",
		async (code) => {
			const { result, said, log, costLines } = await run(
				timed({ "new.test.ts": 12, "old.test.ts": 15, "reader.test.ts": 30 }),
				code,
			);
			expect(result).toBe(code);
			expect(costLines).toHaveLength(3);
			expect(costLines[0]).toMatch(/old\.test\.ts took 15\.0 s.*pre-existing/);
			expect(costLines[1]).toMatch(
				/new\.test\.ts took 12\.0 s.*new since HEAD/,
			);
			expect(costLines[2]).toContain("2 of 2 new or changed test file(s)");
			expect(said.indexOf("Test Files")).toBeLessThan(said.indexOf(costPrefix));
			for (const line of costLines) expect(log).toContain(line);
		},
	);

	it("never names a file the run selected only as a reader", async () => {
		const { costLines } = await run(timed({ "reader.test.ts": 30 }));
		expect(costLines).toEqual([]);
	});

	it("prints nothing where the reporter left no timings", async () => {
		const { result, costLines } = await run(null);
		expect(result).toBe(0);
		expect(costLines).toEqual([]);
	});

	it("prints one fail-open line on timings it cannot read, the exit staying the suite's", async () => {
		const { result, costLines } = await run("not json", 0);
		expect(result).toBe(0);
		expect(costLines).toHaveLength(1);
		expect(costLines[0]).toContain("the suite's verdict stands");
	});

	it("prints nothing under CI", async () => {
		vi.stubEnv("CI", "true");
		const { costLines } = await run(timed({ "new.test.ts": 12 }));
		expect(costLines).toEqual([]);
	});
});

describe("`--changed`, expanded against the read graph (mantahostels#2095)", () => {
	const {
		changedFlag,
		expandChanged,
		PACKAGE_JSON,
	} = require("./lib/changed-selection.js");
	const { isFullRun, EDGES_FILE } = require("./lib/test-pass-marker.js");
	/** The full-suite cost the package.json warning quotes. */
	const fullSuiteCost = /~\d+s wall run/;

	/**
	 * A stand-in for the two commands the expansion shells out to: `git diff`
	 * answers with `changed`, `vitest list` with `selects`.
	 */
	function exec({
		changed = [] as string[],
		selects = [] as string[],
		throws = false,
	}) {
		const calls: string[][] = [];
		const fn = (file: string, args: string[]) => {
			calls.push([file, ...args]);
			if (throws) throw new Error("boom");
			return `${(args[0] === "diff" ? changed : selects).join("\n")}\n`;
		};
		return { fn, calls };
	}

	/** The expansion under test, wired to a fake git, vitest and manifest. */
	const plan = (
		argv: string[],
		edges: Record<string, string[]>,
		io: ReturnType<typeof exec>,
		err: { write: (s: string) => unknown } = { write: () => true },
	) =>
		expandChanged(argv, {
			root: "/repo",
			bin: "/repo/node_modules/.bin/vitest",
			execFn: io.fn,
			loadEdges: () => edges,
			err,
		});

	describe("finding the flag", () => {
		it("reads a bare --changed as taking no ref", () => {
			expect(changedFlag(["--changed"])).toEqual({
				at: 0,
				span: 1,
				ref: null,
			});
		});

		it("takes the following word as the ref", () => {
			expect(changedFlag(["--reporter", "dot", "--changed", "HEAD~2"])).toEqual(
				{ at: 2, span: 2, ref: "HEAD~2" },
			);
		});

		it("does not swallow a following FLAG as the ref", () => {
			expect(changedFlag(["--changed", "--reporter"])).toEqual({
				at: 0,
				span: 1,
				ref: null,
			});
		});

		it("reads the --changed=<ref> spelling", () => {
			expect(changedFlag(["--changed=origin/main"])).toEqual({
				at: 0,
				span: 1,
				ref: "origin/main",
			});
		});

		it("is null where argv carries no --changed at all", () => {
			expect(changedFlag(["run", "-t", "corpus"])).toBeNull();
		});
	});

	it("leaves an argv without --changed entirely alone", () => {
		expect(plan(["-t", "corpus"], {}, exec({}))).toBeNull();
	});

	it("adds the runtime readers of a changed document to vitest's own selection", () => {
		const got = plan(
			["--changed"],
			{ "docs/fixture-map.md": ["a.test.ts", "b.test.ts"] },
			exec({ changed: ["docs/fixture-map.md"], selects: [] }),
		);
		expect(got.own).toEqual([]);
		expect(got.added).toEqual(["a.test.ts", "b.test.ts"]);
		expect(got.files).toEqual(["a.test.ts", "b.test.ts"]);
	});

	it("does not double-count a file vitest already selected", () => {
		const got = plan(
			["--changed"],
			{ "docs/fixture-map.md": ["a.test.ts", "b.test.ts"] },
			exec({ changed: ["docs/fixture-map.md"], selects: ["a.test.ts"] }),
		);
		expect(got.own).toEqual(["a.test.ts"]);
		expect(got.added).toEqual(["b.test.ts"]);
		expect(got.files).toEqual(["a.test.ts", "b.test.ts"]);
	});

	it("changes nothing about the ordinary path: a source file with no manifest entry selects exactly what vitest selected", () => {
		const got = plan(
			["--changed"],
			{ "docs/fixture-map.md": ["a.test.ts"] },
			exec({
				changed: ["scripts/thing.js"],
				selects: ["scripts/thing.test.ts"],
			}),
		);
		expect(got.added).toEqual([]);
		expect(got.files).toEqual(["scripts/thing.test.ts"]);
	});

	it("names the added files and the document each one reads, apart from vitest's own count", () => {
		const got = plan(
			["--changed"],
			{ "docs/fixture-doc.md": ["b.test.ts"] },
			exec({ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] }),
		);
		expect(got.banner).toContain("1 from vitest's import graph");
		expect(got.banner).toContain("1 added from the read graph");
		expect(got.banner).toContain("+ b.test.ts — reads docs/fixture-doc.md");
		expect(got.banner).not.toContain("+ a.test.ts");
	});

	it("counts the readers it does not list, rather than printing all of them", () => {
		const many = Array.from({ length: 20 }, (_, i) => `t${i}.test.ts`);
		const got = plan(
			["--changed"],
			{ "docs/fixture-doc.md": many },
			exec({ changed: ["docs/fixture-doc.md"] }),
		);
		expect(got.banner).toContain("… and 8 more");
		expect(got.files).toHaveLength(20);
	});

	it("hands vitest the file list in place of the flag, keeping every other argument", () => {
		const got = plan(
			["--reporter", "dot", "--changed", "HEAD~1", "--bail", "1"],
			{ "docs/fixture-doc.md": ["b.test.ts"] },
			exec({ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] }),
		);
		expect(got.argv).toEqual([
			"--reporter",
			"dot",
			"--bail",
			"1",
			"--passWithNoTests",
			"a.test.ts",
			"b.test.ts",
		]);
		expect(got.argv).not.toContain("--changed");
		expect(got.argv).not.toContain("HEAD~1");
	});

	it("asks git and vitest about the same ref, keeping renames and deletions on git's side", () => {
		const io = exec({ changed: [], selects: [] });
		plan(["--changed", "HEAD~3"], {}, io);
		expect(io.calls[0]).toEqual([
			"git",
			"diff",
			"--name-only",
			"--no-renames",
			"HEAD~3",
		]);
		expect(io.calls[1]).toEqual([
			"/repo/node_modules/.bin/vitest",
			"list",
			"--changed",
			"HEAD~3",
			"--filesOnly",
		]);
	});

	it("says so and runs nothing where the diff reaches no test file at all", () => {
		const got = plan(
			["--changed"],
			{},
			exec({ changed: ["docs/fixture-untested.md"] }),
		);
		expect(got.files).toEqual([]);
		expect(got.banner).toContain("Nothing to run");
	});

	describe("the package.json warning (mantahostels#2132)", () => {
		it("warns, naming the whole-suite consequence and its wall cost, where the diff touches package.json", () => {
			const got = plan(
				["--changed"],
				{ "docs/fixture-doc.md": ["b.test.ts"] },
				exec({
					changed: [PACKAGE_JSON, "docs/fixture-doc.md"],
					selects: ["a.test.ts"],
				}),
			);
			expect(got.banner).toContain("package.json");
			expect(got.banner).toContain("whole suite");
			expect(got.banner).toMatch(fullSuiteCost);
		});

		it("says nothing where the diff does not touch package.json", () => {
			const got = plan(
				["--changed"],
				{ "docs/fixture-doc.md": ["b.test.ts"] },
				exec({ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] }),
			);
			expect(got.banner).not.toContain("package.json");
		});

		it("does not change the selection, only the banner", () => {
			const withPkg = plan(
				["--changed"],
				{ "docs/fixture-doc.md": ["b.test.ts"] },
				exec({
					changed: [PACKAGE_JSON, "docs/fixture-doc.md"],
					selects: ["a.test.ts"],
				}),
			);
			const without = plan(
				["--changed"],
				{ "docs/fixture-doc.md": ["b.test.ts"] },
				exec({ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] }),
			);
			expect(withPkg.files).toEqual(without.files);
			expect(withPkg.argv).toEqual(without.argv);
		});

		it("still warns where the diff reaches no test file at all", () => {
			const got = plan(["--changed"], {}, exec({ changed: [PACKAGE_JSON] }));
			expect(got.banner).toContain("package.json");
			expect(got.banner).toContain("Nothing to run");
		});
	});

	it("falls open to today's behaviour where the manifest cannot be read, and says which command fixes it", () => {
		const said: string[] = [];
		const got = expandChanged(["--changed"], {
			root: "/repo",
			execFn: exec({}).fn,
			loadEdges: () => {
				throw new Error("ENOENT");
			},
			err: { write: (s: string) => said.push(s) },
		});
		expect(got).toBeNull();
		expect(said.join("")).toContain("npm run gen:test-read-edges");
		expect(said.join("")).not.toContain("package.json");
	});

	it("says nothing about package.json where the manifest cannot be read but the diff does not touch it either", () => {
		const said: string[] = [];
		const got = expandChanged(["--changed"], {
			root: "/repo",
			execFn: exec({ changed: ["docs/fixture-doc.md"] }).fn,
			loadEdges: () => {
				throw new Error("ENOENT");
			},
			err: { write: (s: string) => said.push(s) },
		});
		expect(got).toBeNull();
		expect(said.join("")).not.toContain("package.json");
	});

	it("still says the manifest is unreadable even where the diff itself cannot be read either (mantahostels#2151)", () => {
		const said: string[] = [];
		const got = expandChanged(["--changed"], {
			root: "/repo",
			execFn: exec({ throws: true }).fn,
			loadEdges: () => {
				throw new Error("ENOENT");
			},
			err: { write: (s: string) => said.push(s) },
		});
		expect(got).toBeNull();
		expect(said.join("")).not.toContain("package.json");
		expect(said.join("")).toContain("npm run gen:test-read-edges");
	});

	it("still warns on package.json where the manifest itself cannot be read, naming its wall cost and offering npm run gen:test-read-edges (mantahostels#2151)", () => {
		const said: string[] = [];
		const got = expandChanged(["--changed"], {
			root: "/repo",
			execFn: exec({ changed: [PACKAGE_JSON] }).fn,
			loadEdges: () => {
				throw new Error("ENOENT");
			},
			err: { write: (s: string) => said.push(s) },
		});
		expect(got).toBeNull();
		expect(said.join("")).toContain("package.json");
		expect(said.join("")).toMatch(fullSuiteCost);
		expect(said.join("")).toContain("npm run gen:test-read-edges");
	});

	it("throws, naming the cause, where git or vitest will not answer (#2698)", () => {
		expect(() => plan(["--changed"], {}, exec({ throws: true }))).toThrow(
			"--changed could not be expanded",
		);
	});

	it("still records NO full certificate: the union lands in fileFilters (mantahostels#1230)", () => {
		const got = plan(
			["--changed"],
			{ "docs/fixture-doc.md": ["b.test.ts"] },
			exec({ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] }),
		);
		expect(
			isFullRun({
				scope: {
					nameFilter: null,
					fileFilters: got.files,
					changed: null,
					modulesRun: 2,
					modulesTotal: 2,
				},
			}),
		).toBe(false);
	});

	it("selects the live manifest's readers of a tracked document — not 0, and not the whole suite", () => {
		/* The MANIFEST's path is spelled out, so the extractor records this file
		   as the reader of it that it really is — an edge reached through a
		   constant is the indirect read the lexical pass cannot see. The
		   DOCUMENT is looked up rather than named, so no false edge is recorded
		   for a file this test never opens (mantahostels#2095). */
		expect(EDGES_FILE).toBe("docs/test-read-edges.json");

		const edges = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "docs/test-read-edges.json"),
				"utf8",
			),
		).edges;
		const doc = Object.keys(edges).sort(
			(a, b) => edges[b].length - edges[a].length,
		)[0];
		if (!doc) throw new Error("the live manifest records no readers at all");
		const got = plan(
			["--changed"],
			edges,
			exec({ changed: [doc], selects: [] }),
		);
		expect(got.files).toEqual(edges[doc]);
		expect(got.files.length).toBeGreaterThan(0);
		/* The toEqual above already pins plan(); this pins the manifest, whose
		   most-read document must not be read by every reader. Bounded by the
		   manifest, not a literal, which that document's growth tripped (#564). */
		const distinctReaders = new Set(Object.values(edges).flat());
		expect(got.files.length).toBeLessThan(distinctReaders.size);
	});

	it("hands the union to vitest through main, with the flag gone", async () => {
		const { spawnFn, calls } = spawnReturning({ code: 0 });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await main(["--changed"], {
				spawnFn,
				root: repo(),
				fs: fakeFs(),
				execFn: exec({
					changed: ["docs/fixture-doc.md"],
					selects: ["a.test.ts"],
				}).fn,
				loadEdges: () => ({ "docs/fixture-doc.md": ["b.test.ts"] }),
				out: { write: () => true },
			});
		} finally {
			stdout.mockRestore();
		}
		const [, args] = calls[0] as [string, string[], unknown];
		expect(args).toEqual([
			"run",
			"--passWithNoTests",
			"a.test.ts",
			"b.test.ts",
		]);
	});

	it("runs on a filter matching nothing where the union is empty, so a certificate is still written (#189 §6)", async () => {
		const { spawnFn, calls } = spawnReturning({ code: 0 });
		await expect(
			main(["--changed"], {
				spawnFn,
				root: repo(),
				fs: fakeFs(),
				execFn: exec({ changed: ["docs/fixture-untested.md"] }).fn,
				loadEdges: () => ({}),
				out: { write: () => true },
			}),
		).resolves.toBe(0);
		const [, args] = calls[0] as [string, string[], unknown];
		expect(args).toEqual(["run", "--passWithNoTests", EMPTY_SELECTION_FILTER]);
	});

	describe("under --queue, selected before the queue is joined (#1016)", () => {
		/** One launch, with the queue's writes and the gate's reads counted. */
		const launch = async (
			argv: string[],
			{
				changed = [] as string[],
				selects = [] as string[],
				edges = {} as Record<string, string[]>,
				gateRead = undefined as ((command: string) => null) | undefined,
				root = repo(),
			} = {},
		) => {
			const { spawnFn, calls } = spawnReturning({ code: 0 });
			const joined = vi.fn();
			const gate = vi.fn(() => false);
			const out: string[] = [];
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			let code: number;
			try {
				code = await main(argv, {
					spawnFn,
					root,
					fs: fakeFs(),
					execFn: exec({ changed, selects }).fn,
					loadEdges: () => edges,
					renderEdges: () => ({}),
					out: { write: (s: string) => out.push(s) },
					queueDir: qdir(),
					queueFs: { ...fs, writeFileSync: joined },
					...(gateRead ? { gateRead } : { gate }),
				});
			} finally {
				stdout.mockRestore();
			}
			const [, args, opts] = (calls[0] ?? []) as [
				string,
				string[],
				{ env: Record<string, string> },
			];
			return { code, joined, gate, out: out.join(""), args, env: opts?.env };
		};

		it("never joins the queue where the selection is empty, and says what to run instead", async () => {
			const got = await launch(["--queue", "--changed"], {
				changed: ["docs/fixture-untested.md"],
				root: declaringCommands(repo(), { push_check: "npm run push:check" }),
			});
			expect(got.joined).not.toHaveBeenCalled();
			expect(got.gate).not.toHaveBeenCalled();
			expect(got.code).toBe(0);
			expect(got.out).toMatch(/skips the queue/);
			expect(got.out).toMatch(
				/npm run push:check` says whether a certificate attests your push/,
			);
		});

		it("names the lander, not push:check, where the selection is empty under `landing` (#2961)", async () => {
			vi.stubEnv("WFC_MODULES", `${process.env.WFC_MODULES},landing`);
			const got = await launch(["--queue", "--changed"], {
				changed: ["docs/fixture-untested.md"],
			});
			expect(got.code).toBe(0);
			expect(got.out).toMatch(
				/skips the queue \(#1016\)\. module "landing" is on — the lander runs the full suite/,
			);
			expect(got.out).not.toMatch(/push:check|attests your push/);
		});

		it("hands the child what an unqueued empty run does, so its certificate reads the same", async () => {
			const queued = await launch(["--queue", "--changed"], {
				changed: ["docs/fixture-untested.md"],
			});
			const unqueued = await launch(["--changed"], {
				changed: ["docs/fixture-untested.md"],
			});
			expect(queued.args).toEqual([
				"run",
				"--passWithNoTests",
				EMPTY_SELECTION_FILTER,
			]);
			expect(queued.args).toEqual(unqueued.args);
			// The same child but for the launch's own argv, which names --queue.
			const readLaunchSansArgv = (env: Record<string, string>) => {
				const { argv: _argv, ...recorded } = readLaunch(env);
				const rest = Object.fromEntries(
					Object.entries(env).filter(([k]) => !(k in launchEnv({}))),
				);
				return { launch: recorded, rest };
			};
			expect(readLaunchSansArgv(queued.env)).toEqual(
				readLaunchSansArgv(unqueued.env),
			);
		});

		it("skips the queue for the narrowed default too", async () => {
			const got = await launch(["--queue", SHARED_FLAG], {
				changed: ["docs/fixture-untested.md"],
			});
			expect(got.joined).not.toHaveBeenCalled();
			expect(got.args).toEqual([
				"run",
				"--passWithNoTests",
				EMPTY_SELECTION_FILTER,
			]);
		});

		it("still queues, then runs, a selection that is not empty", async () => {
			const got = await launch(["--queue", "--changed"], {
				changed: ["docs/fixture-doc.md"],
				selects: ["a.test.ts"],
			});
			expect(got.joined).toHaveBeenCalledTimes(1);
			expect(got.gate).toHaveBeenCalled();
			expect(got.out).not.toMatch(/skips the queue/);
			expect(got.args).toEqual(["run", "--passWithNoTests", "a.test.ts"]);
		});

		it("runs only its selection where npm's argv carries a second bare -- before --queue (#2181)", async () => {
			const runs = {
				retest: ["--retest", "a.test.ts", "--", "--queue"],
				adopt: ["--adopt", "docs/fixture-doc.md", "--", "--queue"],
				changed: ["--changed", "HEAD~1", "--", "--queue"],
			};
			for (const [source, argv] of Object.entries(runs)) {
				const got = await launch(argv, {
					changed: ["docs/fixture-doc.md"],
					selects: ["a.test.ts"],
				});
				expect(got.joined, source).toHaveBeenCalledTimes(1);
				/* A `--retest` is a touched run, its one file one worker (#2935). */
				expect(got.args, source).toEqual([
					"run",
					...(source === "retest" ? ["--maxWorkers=1"] : []),
					"--passWithNoTests",
					"a.test.ts",
					"--",
				]);
			}
		});

		/* The gate prices a named run by the workers its files can occupy, so
		 * its poll must carry the files, or a one-file run waits for a whole
		 * suite's rung (#2558). */
		it("queues a run naming its own test files, the gate asked about those files", async () => {
			const gateRead = vi.fn((_command: string) => null);
			const got = await launch(["--queue", "a.test.ts", "-t", "two words"], {
				gateRead,
			});
			expect(got.joined).toHaveBeenCalledTimes(1);
			expect(gateRead).toHaveBeenCalledWith(
				"npm run test -- a.test.ts -t 'two words'",
				{ resolvedFiles: 1, wholeSlot: false },
				0,
			);
			expect(got.args).toContain("a.test.ts");
		});

		it("still queues a --full run, which selects nothing to probe", async () => {
			const got = await launch([
				"--queue",
				SHARED_FLAG,
				`${FULL_FLAG}=coverage`,
			]);
			expect(got.joined).toHaveBeenCalledTimes(1);
			expect(got.out).not.toMatch(/skips the queue/);
		});

		describe("and re-checked while it waits (#1158)", () => {
			/**
			 * A `--queue --changed` launch that waits two polls at a closed gate,
			 * the world moving at the first unless `still`. Answers what it said
			 * and how many vitest listings it made: the pre-queue probe and the
			 * run's own selection are two, so a third is the re-check's.
			 */
			const queued = async (
				w: ReturnType<typeof world>,
				{ edges = {}, still = false } = {},
			) => {
				const { spawnFn } = spawnReturning({ code: 0 });
				const out: string[] = [];
				let polls = 0;
				const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
				try {
					await main(["--queue", "--changed"], {
						spawnFn,
						root: repo(),
						fs: fakeFs(),
						execFn: w.fn,
						loadEdges: () => edges,
						renderEdges: () => ({}),
						out: { write: (line: string) => out.push(line) },
						err: { write: () => true },
						queueDir: qdir(),
						gate: () => polls < 2,
						sleepFn: () => {
							polls += 1;
							if (!still) w.move();
							return Promise.resolve();
						},
					});
				} finally {
					stdout.mockRestore();
				}
				return { said: out.join(""), listings: w.listed.length };
			};

			it("runs no probe while HEAD and origin/main stand still", async () => {
				const w = world(
					{ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] },
					{ changed: [], selects: [] },
				);
				const got = await queued(w, { still: true });
				expect(got.listings).toBe(2);
				expect(got.said).not.toMatch(/leaves the queue/);
			});

			it("leaves the queue, naming what emptied, once a move leaves the diff reaching no test", async () => {
				const w = world(
					{ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] },
					{ changed: ["docs/fixture-untested.md"], selects: [] },
				);
				const got = await queued(w);
				expect(got.said).toMatch(
					/the diff against HEAD reaches no test file, so this run leaves the queue/,
				);
			});

			it("skips the probe where a moved diff still touches code or a manifest reader", async () => {
				for (const [changed, edges] of [
					[["scripts/lib/x.js"], {}],
					[["docs/read.md"], { "docs/read.md": ["a.test.ts"] }],
				] as const) {
					const w = world(
						{ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] },
						{ changed: [...changed], selects: [] },
					);
					const got = await queued(w, { edges });
					expect(got.listings).toBe(2);
					expect(got.said).not.toMatch(/leaves the queue/);
				}
			});

			it("joins the queue again, and waits for the gate, where a commit refills the selection after it left", async () => {
				const w = refillWorld();
				const { spawnFn, calls } = spawnReturning({ code: 0 });
				const joined = vi.fn();
				let polls = 0;
				const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
				try {
					await main(["--queue", "--changed"], {
						spawnFn,
						root: repo(),
						fs: fakeFs(),
						execFn: w.fn,
						loadEdges: () => ({}),
						renderEdges: () => ({}),
						out: { write: () => true },
						err: { write: () => true },
						queueDir: qdir(),
						queueFs: { ...fs, writeFileSync: joined },
						gate: () => polls < 3,
						sleepFn: () => {
							polls += 1;
							w.move();
							return Promise.resolve();
						},
					});
				} finally {
					stdout.mockRestore();
				}
				expect(joined).toHaveBeenCalledTimes(2);
				expect(calls).toHaveLength(1);
				expect(calls[0]?.[1]).toEqual([
					"run",
					"--passWithNoTests",
					"a.test.ts",
				]);
			});

			it("logs the leave as an empty exit, and the rejoined wait as a line of its own (#1215)", async () => {
				const w = refillWorld();
				const { spawnFn } = spawnReturning({ code: 0 });
				const queueLog = path.join(qdir(), "exits.jsonl");
				let polls = 0;
				const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
				try {
					await main(["--queue", "--changed"], {
						spawnFn,
						root: repo(),
						fs: fakeFs(),
						execFn: w.fn,
						loadEdges: () => ({}),
						renderEdges: () => ({}),
						out: { write: () => true },
						err: { write: () => true },
						queueDir: qdir(),
						queueFs: { ...fs, writeFileSync: vi.fn() },
						queueLog,
						gate: () => polls < 3,
						sleepFn: () => {
							polls += 1;
							w.move();
							return Promise.resolve();
						},
					});
				} finally {
					stdout.mockRestore();
				}
				expect(readJsonl(queueLog)).toMatchObject([
					{ reason: "left", empty: true, kind: "changed" },
					{ reason: "opened", empty: false, kind: "changed", slotFree: false },
				]);
			});

			it("leaves a shut queue and runs the empty selection once its diff empties mid-wait", async () => {
				const w = world(
					{ changed: ["docs/fixture-doc.md"], selects: ["a.test.ts"] },
					{ changed: ["docs/fixture-untested.md"], selects: [] },
				);
				const { spawnFn, calls } = spawnReturning({ code: 0 });
				const loadHold = vi.fn(() => Promise.resolve(true));
				const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
				try {
					await main(["--queue", "--changed"], {
						spawnFn,
						root: repo(),
						fs: fakeFs(),
						execFn: w.fn,
						loadEdges: () => ({}),
						renderEdges: () => ({}),
						out: { write: () => true },
						err: { write: () => true },
						queueDir: qdir(),
						queueFs: { ...fs, writeFileSync: vi.fn() },
						gate: () => true,
						sleepFn: () => {
							w.move();
							return Promise.resolve();
						},
						loadHold,
					});
				} finally {
					stdout.mockRestore();
				}
				expect(loadHold).not.toHaveBeenCalled();
				expect(calls[0]?.[1]).toEqual([
					"run",
					"--passWithNoTests",
					EMPTY_SELECTION_FILTER,
				]);
			});

			/* Under `landing` the bare run is a touched one (#2930), whose stale
			 * base reaches `a.test.ts` only through the read graph, and whose
			 * emptied selection spawns nothing. */
			it.each([
				["origin/main", "roadmap"],
				["origin/landing", "landing"],
			])(
				"leaves on the bare default, before the gate opens, once a push moves %s to a base the diff empties against (modules: %s, #2408)",
				async (ref, modules) => {
					vi.stubEnv("WFC_MODULES", modules);
					const landing = modules === "landing";
					const root = repo();
					if (landing) fs.writeFileSync(path.join(root, "a.test.ts"), "");
					const edges = () =>
						landing ? { "docs/fixture-doc.md": ["a.test.ts"] } : {};
					const w = pushWorld(ref);
					const { spawnFn, calls } = spawnReturning({ code: 0 });
					const loadHold = vi.fn(() => Promise.resolve(true));
					const out: string[] = [];
					let polls = 0;
					const stdout = vi
						.spyOn(process.stdout, "write")
						.mockReturnValue(true);
					try {
						await main(["--queue", SHARED_FLAG], {
							spawnFn,
							root,
							fs: fakeFs(),
							execFn: w.fn,
							loadEdges: edges,
							renderEdges: edges,
							out: { write: (s: string) => out.push(s) },
							err: { write: () => true },
							queueDir: qdir(),
							queueFs: { ...fs, writeFileSync: vi.fn() },
							gate: () => polls < 5,
							sleepFn: () => {
								polls += 1;
								w.push();
								return Promise.resolve();
							},
							loadHold,
						});
					} finally {
						stdout.mockRestore();
					}
					expect(out.join("")).toMatch(
						/diff against pushedBase reaches no test file/,
					);
					expect(loadHold).not.toHaveBeenCalled();
					if (landing) expect(calls).toEqual([]);
					else
						expect(calls[0]?.[1]).toEqual([
							"run",
							"--passWithNoTests",
							EMPTY_SELECTION_FILTER,
						]);
				},
			);
		});
	});
});

describe("whether a filtered run meets the push gate (mantahostels#2146, mantahostels#2207)", () => {
	const { expandChanged } = require("./lib/changed-selection.js");
	const { EDGES_FILE } = require("./lib/test-pass-marker.js");

	/** Fake `git diff` and `vitest list`, both answering with one test file. */
	const exec = () => (_file: string, args: string[]) =>
		`${(args[0] === "diff" ? ["docs/thing.md"] : ["a.test.ts"]).join("\n")}\n`;

	const plan = (argv: string[], fresh: boolean) =>
		expandChanged(argv, {
			root: "/repo",
			bin: "/repo/node_modules/.bin/vitest",
			execFn: exec(),
			loadEdges: () => ({}),
			renderEdges: fresh ? () => ({}) : renderFails,
			err: { write: () => true },
		});

	it("meets the gate where the read graph renders", () => {
		const got = plan(["--changed"], true);
		expect(got.admissible).toBe(true);
		expect(got.banner).toContain("MEETS THE PUSH GATE");
	});

	it("says its certificate attests the commit made from this tree without a re-run, and retires the commit-then-re-run recipe (#189 §8)", () => {
		const got = plan(["--changed"], true);
		expect(got.banner).toContain("each test reading it still holds");
		expect(got.banner).toContain(
			"it attests the commit you make from this tree without a re-run",
		);
		expect(got.banner).not.toContain("--full=");
		expect(got.banner).not.toContain("commit first");
		expect(got.banner).not.toContain("the new commit's parent");
	});

	it("hands the diff the selection was computed from back to the caller, and the base it diffed against (#189 §7)", () => {
		const got = plan(["--changed"], true);
		expect(got.changed).toEqual(["docs/thing.md"]);
		/* The stub's rev-parse answers no sha, so the ref stands as named. */
		expect(got.base).toBe("HEAD");
		expect(plan(["--changed", "e".repeat(40)], true).base).toBe("e".repeat(40));
	});

	it("resolves a named ref to the sha it stood at, so a moved HEAD cannot shift the base (#189 §7)", () => {
		const sha = "f".repeat(40);
		const got = expandChanged(["--changed", "HEAD~1"], {
			root: "/repo",
			bin: "/repo/node_modules/.bin/vitest",
			execFn: (_file: string, args: string[]) => {
				if (args[0] === "rev-parse") return `${sha}\n`;
				if (args[0] === "diff") return "docs/thing.md\n";
				return "a.test.ts\n";
			},
			loadEdges: () => ({}),
			renderEdges: () => ({}),
			err: { write: () => true },
		});
		expect(got.base).toBe(sha);
	});

	it("does not where the read graph will not render, and says why (#998)", () => {
		const got = plan(["--changed"], false);
		expect(got.admissible).toBe(false);
		expect(got.banner).toContain("NOT ADMISSIBLE");
		expect(got.banner).toContain("render failed");
		expect(got.banner).toContain(EDGES_FILE);
	});

	it("still meets it where --changed was given a ref, which is the same command", () => {
		expect(plan(["--changed", "HEAD~3"], true).admissible).toBe(true);
	});

	it("refuses anything narrowed past the diff, recognised flag or not", () => {
		for (const extra of [["-t", "some name"], ["--project=x"]]) {
			const got = plan(["--changed", ...extra], true);
			expect(got.admissible).toBe(false);
			expect(got.banner).toContain("narrowed past the diff");
		}
	});

	it("names no push check and no --changed re-run under `landing`, the lander being the gate (#2961)", () => {
		vi.stubEnv("WFC_MODULES", `${process.env.WFC_MODULES},landing`);
		for (const [argv, fresh] of [
			[["--changed"], true],
			[["--changed", "-t", "some name"], true],
			[["--changed"], false],
			[["--adopt", "docs/thing.md"], true],
			[["--adopt"], true],
			[["--retest", "a.test.ts"], true],
		] as const) {
			const got = plan([...argv], fresh);
			expect(got.banner).toContain(
				'NO PUSH GATE — module "landing" is on — the lander runs the full suite',
			);
			expect(got.banner).not.toMatch(
				/MEETS THE PUSH GATE|ADMISSIBLE|push:check/,
			);
			expect(got.banner).not.toContain("re-run with");
		}
	});

	it("names no push gate where `suites` is off either (#2961)", () => {
		vi.stubEnv("WFC_MODULES", "");
		const got = plan(["--changed"], true);
		expect(got.banner).toContain('NO PUSH GATE — module "suites" is off');
		expect(got.banner).not.toContain("MEETS THE PUSH GATE");
	});

	/* A positional is not an exception to the rule above: `changedFlag` reads it
	 * as --changed's ref, matching vitest, so it never reaches this test. */
	it("refuses a flag that narrows nothing, rather than maintaining a safe list", () => {
		expect(plan(["--changed", "--reporter=dot"], true).admissible).toBe(false);
	});

	/* Every case above injects the render, so without this the default wire
	 * would survive being replaced by one that never throws. */
	it("renders the real read graph by default, and a tree git cannot list attests nothing", () => {
		const got = expandChanged(["--changed"], {
			root: fs.mkdtempSync(path.join(os.tmpdir(), "no-manifest-")),
			bin: "/repo/node_modules/.bin/vitest",
			execFn: exec(),
			loadEdges: () => ({}),
			err: { write: () => true },
		});
		expect(got.admissible).toBe(false);
	});

	/* #959's refusal (#981): a neighbour stages a document an unedited test
	 * already names, so the tree renders an edge the committed manifest lacks. */
	it("selects an unedited test through an edge only the live render holds, and stays admissible (#998)", () => {
		const dir = repo();
		const { render } = require("./lib/read-edges-render.js");
		const git = (...a: string[]) =>
			require("node:child_process").execFileSync("git", a, { cwd: dir });
		const put = (file: string, body: string) => {
			fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
			fs.writeFileSync(path.join(dir, file), body);
		};
		put("scripts/reader.test.ts", 'process.cwd(); read("docs/new.md");');
		put(EDGES_FILE, render(dir).text);
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		expect(
			JSON.parse(fs.readFileSync(path.join(dir, EDGES_FILE), "utf8")).edges,
		).toEqual({});
		put("docs/new.md", "a neighbour's staged document\n");
		git("add", "docs/new.md");

		const got = expandChanged(["--changed"], {
			root: dir,
			bin: path.join(dir, "node_modules", ".bin", "vitest"),
			/* Real git; vitest's own graph selects nothing. */
			execFn: (file: string, args: string[], opts: unknown) =>
				file === "git"
					? require("node:child_process").execFileSync(file, args, opts)
					: "",
			err: { write: () => true },
		});
		expect(got.added).toEqual(["scripts/reader.test.ts"]);
		expect(got.admissible).toBe(true);
		expect(got.banner).toContain(
			"+ scripts/reader.test.ts — reads docs/new.md",
		);
	});

	it("says an empty selection meets the gate on the instruments alone, and owes no full run (#189 §6)", () => {
		const got = expandChanged(["--changed"], {
			root: "/repo",
			bin: "/repo/node_modules/.bin/vitest",
			execFn: () => "\n",
			loadEdges: () => ({}),
			renderEdges: () => ({}),
			err: { write: () => true },
		});
		expect(got.banner).toContain("MEETS THE PUSH GATE");
		expect(got.banner).toContain("Nothing to run.");
		expect(got.banner).not.toContain("--full=<cause>");
	});

	/** The env the wrapper hands vitest for a plan of the given verdict. */
	async function envFor(admissible: boolean | null) {
		let seen: Record<string, string> | null = null;
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		queueMicrotask(() => {
			child.stdout.end();
			child.stderr.end();
			child.emit("close", 0);
		});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await main([SHARED_FLAG], {
			root: repo(),
			expand:
				admissible === null
					? () => null
					: () => ({
							argv: ["a.test.ts"],
							files: ["a.test.ts"],
							own: ["a.test.ts"],
							added: [],
							admissible,
							banner: "selection\n",
						}),
			spawnFn: (
				_bin: string,
				_args: string[],
				opts: { env: Record<string, string> },
			) => {
				seen = opts.env;
				return child;
			},
		});
		stdout.mockRestore();
		return seen as unknown as Record<string, string>;
	}

	it("carries the verdict across the spawn, which is the only way the reporter learns it", async () => {
		expect(readLaunch(await envFor(true)).admissible).toBe(true);
	});

	it("clears the flag rather than omitting it, so an outer run cannot lend it", async () => {
		const got = await underOuterLaunch({ admissible: true }, async () => [
			await envFor(false),
			await envFor(null),
		]);
		for (const env of got) expect(readLaunch(env).admissible).toBe(false);
	});
});

/** `body` run under an outer run's launch record, as a nested launch inherits it. */
async function underOuterLaunch<T>(
	launch: Record<string, unknown>,
	body: () => Promise<T>,
): Promise<T> {
	stubLaunch(launch);
	return await body();
}

/** The env `main` hands the vitest child for `argv`. */
async function childEnv(argv: string[], extra: Record<string, unknown> = {}) {
	let seen: Record<string, string> | null = null;
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	try {
		await main(argv, {
			root: repo(),
			fs: fakeFs(),
			spawnFn: (
				_bin: string,
				_args: string[],
				opts: { env: Record<string, string> },
			) => {
				seen = opts.env;
				return fakeChild();
			},
			...extra,
		});
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
	}
	return seen as unknown as Record<string, string>;
}

/*
 * How the child is told it is reading a frozen `--isolated` worktree
 * (mantahostels#2187) — the marker fields themselves are `markerFrom`'s to test.
 */
describe("--isolated's env flag on the spawned child (mantahostels#2187)", () => {
	it("sets the flag on a run in the frozen worktree", async () => {
		expect(readLaunch(await childEnv(["--full=coverage"])).isolated).toBe(true);
	});

	it("clears it rather than omitting it on a shared-tree run", async () => {
		const got = await underOuterLaunch({ isolated: true }, async () => [
			await childEnv([SHARED_FLAG, "--full=coverage"]),
			await childEnv([SHARED_FLAG, "-t", "x"]),
		]);
		for (const env of got) expect(readLaunch(env).isolated).toBe(false);
	});
});

/*
 * Why a full run was full (mantahostels#3207). Every reason but a typed
 * `--full`'s is the default flip's (mantahostels#3154).
 */
describe("--full's reason on the spawned child (mantahostels#3207)", () => {
	it("sets flag where the session typed --full itself", async () => {
		expect(
			readLaunch(await childEnv([SHARED_FLAG, "--full=coverage"])).full,
		).toBe("flag");
	});

	it("clears it rather than omitting it on a run that is not full", async () => {
		const env = await underOuterLaunch({ full: "flag" }, () =>
			childEnv([SHARED_FLAG, "-t", "x"]),
		);
		expect(readLaunch(env).full).toBeNull();
	});
});

/*
 * The DENOMINATOR flag (mantahostels#2303): which command started the run, as against
 * `admissible`'s verdict on whether it may stand in for a whole-suite one.
 */
describe("the test:changed route flag on the spawned child (mantahostels#2303)", () => {
	/** The env the wrapper hands vitest for this argv and this expansion. */
	async function envFor(
		argv: string[],
		expand: () => Record<string, unknown> | null,
	) {
		let seen: Record<string, string> | null = null;
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		queueMicrotask(() => {
			child.stdout.end();
			child.stderr.end();
			child.emit("close", 0);
		});
		await main([SHARED_FLAG, ...argv], {
			root: repo(),
			expand,
			/* The injected seam rather than a spy on the real stream: a spy
			 * survives a rejecting `main` and leaves the rest of this file
			 * writing into a mock. */
			out: { write: () => true },
			spawnFn: (
				_bin: string,
				_args: string[],
				opts: { env: Record<string, string> },
			) => {
				seen = opts.env;
				return child;
			},
		});
		return seen as unknown as Record<string, string>;
	}

	const planned = (admissible: boolean) => () => ({
		argv: ["a.test.ts"],
		files: ["a.test.ts"],
		own: ["a.test.ts"],
		added: [],
		admissible,
		banner: "selection\n",
	});

	it("sets the flag on a --changed launch that met the gate", async () => {
		const env = await envFor(["--changed"], planned(true));
		expect(readLaunch(env).viaChanged).toBe(true);
		expect(readLaunch(env).admissible).toBe(true);
	});

	it("sets it on a --changed launch that did NOT meet the gate", async () => {
		const env = await envFor(["--changed"], planned(false));
		expect(readLaunch(env).viaChanged).toBe(true);
		expect(readLaunch(env).admissible).toBe(false);
	});

	it("sets it where the manifest could not be read, which reads off argv alone", async () => {
		const env = await envFor(["--changed"], () => null);
		expect(readLaunch(env).viaChanged).toBe(true);
		expect(readLaunch(env).admissible).toBe(false);
	});

	it("clears it rather than omitting it on an argv carrying no --changed", async () => {
		const env = await underOuterLaunch({ viaChanged: true }, () =>
			envFor([], () => null),
		);
		expect(readLaunch(env).viaChanged).toBe(false);
	});

	it("takes the ref, in either spelling, as part of the command", async () => {
		expect(
			readLaunch(await envFor(["--changed", "HEAD~1"], planned(true)))
				.viaChanged,
		).toBe(true);
		expect(
			readLaunch(await envFor(["--changed=HEAD~1"], planned(true))).viaChanged,
		).toBe(true);
	});

	it("clears it where argv narrows the run past the diff", async () => {
		expect(
			readLaunch(await envFor(["--changed", "-t", "spawn"], planned(false)))
				.viaChanged,
		).toBe(false);
		/* A path AFTER the ref is the narrowing. A path in the ref's own slot is
		 * the ref — `--changed a.test.ts` asks for the diff since a commit-ish
		 * spelled that way, in vitest's parse and in this launcher's. */
		expect(
			readLaunch(
				await envFor(["--changed", "HEAD~1", "a.test.ts"], planned(false)),
			).viaChanged,
		).toBe(false);
	});
});

/*
 * Each field is set by a different caller on the way to the spawn, so a route
 * that drops one shows here and nowhere a single-field case looks.
 */
describe("the launch record each route hands the child (#1596)", () => {
	it("hands the child every field an explicit --changed run sets, the plan's diff and base included", async () => {
		const plan = () => ({
			argv: ["a.test.ts"],
			files: ["a.test.ts"],
			own: ["a.test.ts"],
			added: [],
			admissible: true,
			changed: ["lib/a.js"],
			base: "abc123",
			banner: "selection\n",
		});
		const argv = [SHARED_FLAG, "--changed", "HEAD~1"];
		expect(readLaunch(await childEnv(argv, { expand: plan }))).toEqual({
			admissible: true,
			isolated: false,
			viaChanged: true,
			touched: false,
			full: null,
			fullCause: null,
			argv,
			resolvedFiles: 1,
			wholeSlot: false,
			changedPaths: ["lib/a.js"],
			base: "abc123",
		});
	});

	/* Its failures are classed against its base, so on the `HEAD` fallback,
	 * which holds the session's own commits, it records none, as a full run
	 * does (#3660). No pushed ref here, so the default fell back to `HEAD`. */
	it("hands the child the default's narrowing with the test:changed flag cleared and no base on the HEAD fallback (#3660)", async () => {
		const env = await childEnv([SHARED_FLAG], {
			execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
			loadEdges: () => ({}),
			renderEdges: () => ({}),
			sessionId: "",
		});
		expect(readLaunch(env)).toEqual({
			admissible: true,
			isolated: false,
			viaChanged: false,
			touched: false,
			full: null,
			fullCause: null,
			argv: [SHARED_FLAG],
			resolvedFiles: 1,
			wholeSlot: false,
			changedPaths: ["a.test.ts"],
			base: null,
		});
	});

	it("hands the child the default's merge-base where one resolved (#3660)", async () => {
		const env = await childEnv([SHARED_FLAG], {
			execFn: fakeExec({
				hasOrigin: true,
				mergeBase: "d".repeat(40),
				diff: ["a.test.ts"],
				list: ["a.test.ts"],
			}),
			loadEdges: () => ({}),
			renderEdges: () => ({}),
			sessionId: "",
		});
		expect(readLaunch(env)).toMatchObject({
			viaChanged: false,
			full: null,
			base: "d".repeat(40),
		});
	});

	/* A bare `--changed` plans against `HEAD`, which holds the session's own
	 * commits, so it records the default's base instead (#3678). */
	it.each([
		["the merge-base where one resolved", true, "merge-base-sha"],
		["no base on the HEAD fallback", false, null],
	])(
		"hands a bare --changed %s, never its plan's HEAD (#3678)",
		async (_what, hasOrigin, base) => {
			const env = await childEnv([SHARED_FLAG, "--changed"], {
				execFn: fakeExec({ hasOrigin }),
				expand: () => ({
					argv: ["a.test.ts"],
					files: ["a.test.ts"],
					own: ["a.test.ts"],
					added: [],
					admissible: true,
					changed: ["lib/a.js"],
					base: "head-sha",
					banner: "selection\n",
				}),
			});
			expect(readLaunch(env)).toMatchObject({
				viaChanged: true,
				changedPaths: ["lib/a.js"],
				base,
			});
		},
	);

	it("hands the child the typed flag and its cause on a --full=<cause> run, isolated", async () => {
		const argv = ["--full=coverage"];
		expect(readLaunch(await childEnv(argv))).toEqual({
			admissible: false,
			isolated: true,
			viaChanged: false,
			touched: false,
			full: "flag",
			fullCause: "coverage",
			argv,
			resolvedFiles: 0,
			wholeSlot: false,
			changedPaths: null,
			base: null,
		});
	});

	/* A full red is classed against its base (#3646), so both whole-suite
	 * routes carry the one their launch resolved — and none where it fell
	 * back to `HEAD`, as the case above does with no pushed ref. */
	it("hands the child the resolved base on a typed --full (#3646)", async () => {
		const env = await childEnv([SHARED_FLAG, "--full=coverage"], {
			execFn: fakeExec({ hasOrigin: true }),
		});
		expect(readLaunch(env)).toMatchObject({
			full: "flag",
			changedPaths: null,
			base: "merge-base-sha",
		});
	});

	it("hands the child the default's base on its escalation to the whole suite (#3646)", async () => {
		const env = await childEnv([SHARED_FLAG], {
			execFn: fakeExec({ hasOrigin: true, diff: ["a.test.ts"] }),
			loadEdges: () => ({}),
			renderEdges: renderFails,
			sessionId: "",
		});
		expect(readLaunch(env)).toMatchObject({
			full: "stale-manifest",
			changedPaths: null,
			base: "merge-base-sha",
		});
	});

	it("hands the child no base on an escalation whose default fell back to HEAD (#3646)", async () => {
		const env = await childEnv([SHARED_FLAG], {
			execFn: fakeExec({ diff: ["a.test.ts"] }),
			loadEdges: () => ({}),
			renderEdges: renderFails,
			sessionId: "",
		});
		expect(readLaunch(env)).toMatchObject({
			full: "stale-manifest",
			base: null,
		});
	});

	/* A full run is weighed against its own repo's suite, never the core's. */
	it.each([
		["a small repo's", repo, false],
		["a whole-slot repo's", wholeRepo, true],
	])(
		"hands the child %s whole-suite count and slot (#2931)",
		async (_what, make, wholeSlot) => {
			const root = make();
			const yieldCpu = vi.fn();
			const env = await childEnv([SHARED_FLAG, "--full=coverage"], {
				root,
				yieldCpu,
			});
			expect(readLaunch(env)).toMatchObject({
				resolvedFiles: wholeSlot ? WHOLE_SLOT_BOUND : 0,
				wholeSlot,
			});
			/* Only a run outside the whole slot may yield its CPU (#2955). */
			expect(yieldCpu).toHaveBeenCalledTimes(wholeSlot ? 0 : 1);
		},
	);

	it("weighs a run whole, saying so on err, where its suite will not list (#2931)", async () => {
		const err: string[] = [];
		const env = await childEnv([SHARED_FLAG, "--full=coverage"], {
			err: { write: (s: string) => err.push(s) },
			execFn: (file: string, args: string[], opts: unknown) => {
				if (args[0] === "ls-files") throw new Error("index locked");
				return require("node:child_process").execFileSync(file, args, opts);
			},
		});
		expect(err.join("")).toContain(
			"run-vitest: the suite could not be listed (Error: index locked) — this run is weighed whole (#2931).",
		);
		expect(readLaunch(env)).toMatchObject({
			resolvedFiles: null,
			wholeSlot: true,
		});
	});

	it("weighs a run whole where vitest will not list its suite (#2960)", async () => {
		const root = wholeRepo();
		fs.writeFileSync(
			path.join(root, "vitest.config.mjs"),
			"export default {};\n",
		);
		const err: string[] = [];
		const env = await childEnv([SHARED_FLAG, "--full=coverage"], {
			root,
			err: { write: (s: string) => err.push(s) },
			execFn: (file: string, args: string[], opts: unknown) => {
				if (args[0] === "list") throw new Error("vitest list failed");
				return require("node:child_process").execFileSync(file, args, opts);
			},
		});
		expect(err.join("")).toContain(
			"run-vitest: the suite could not be listed (Error: vitest list failed) — this run is weighed whole (#2931).",
		);
		expect(readLaunch(env)).toMatchObject({
			resolvedFiles: null,
			wholeSlot: true,
		});
	});

	it("hands the child isolated and nothing else set on an --isolated run", async () => {
		const argv = ["--isolated", "-t", "x"];
		expect(readLaunch(await childEnv(argv))).toEqual({
			admissible: false,
			isolated: true,
			viaChanged: false,
			touched: false,
			full: null,
			fullCause: null,
			argv,
			resolvedFiles: 0,
			wholeSlot: false,
			changedPaths: null,
			base: null,
		});
	});
});

describe("the package.json bail-out, narrowed for an allow-listed key set (mantahostels#2160)", () => {
	const { expandChanged, PACKAGE_JSON } = require("./lib/changed-selection.js");
	/** The full-suite cost the package.json warning quotes. */
	const fullSuiteCost = /~\d+s wall run/;

	/** Where the scratch config is written in these cases. */
	const probePath = "/tmp/wfc-vitest-probe-test.mts";

	/**
	 * The three commands the expansion can shell out to: `git diff` answers with
	 * `changed`, `git show` with the OLD side of the manifest under test, and
	 * `vitest list` with `selects`.
	 */
	function exec({
		changed = [] as string[],
		selects = [] as string[],
		old = {} as unknown,
		showThrows = false,
	}) {
		const calls: string[][] = [];
		const fn = (file: string, args: string[]) => {
			calls.push([file, ...args]);
			if (args[0] === "diff") return `${changed.join("\n")}\n`;
			if (args[0] === "show") {
				if (showThrows) throw new Error("fatal: path does not exist");
				return typeof old === "string" ? old : JSON.stringify(old);
			}
			return `${selects.join("\n")}\n`;
		};
		return { fn, calls };
	}

	/** The working tree's own package.json, and the scratch config's writes. */
	function files(
		now: unknown,
		{ readThrows = false, writeThrows = false } = {},
	) {
		const written: Record<string, string> = {};
		const unlinked: string[] = [];
		return {
			written,
			unlinked,
			readFileSync: () => {
				if (readThrows) throw new Error("EACCES");
				return typeof now === "string" ? now : JSON.stringify(now);
			},
			writeFileSync: (file: string, content: string) => {
				if (writeThrows) throw new Error("EACCES");
				written[file] = content;
			},
			unlinkSync: (file: string) => {
				unlinked.push(file);
			},
		};
	}

	/** The expansion under test, wired to a fake git, vitest, tree and manifest. */
	const plan = (
		io: ReturnType<typeof exec>,
		fsImpl: ReturnType<typeof files>,
		edges: Record<string, string[]> = {},
		argv: string[] = ["--changed"],
	) =>
		expandChanged(argv, {
			root: "/repo",
			bin: "/repo/node_modules/.bin/vitest",
			execFn: io.fn,
			fs: fsImpl,
			probeConfig: probePath,
			loadEdges: () => edges,
			err: { write: () => true },
		});

	/** A `scripts`-only edit: the shape mantahostels#2099 measured at 236 of 236 files. */
	const scriptsOnly = () => ({
		io: exec({
			changed: [PACKAGE_JSON],
			selects: ["a.test.ts"],
			old: { name: "m", scripts: { test: "old" } },
		}),
		fs: files({ name: "m", scripts: { test: "new" } }),
	});

	/**
	 * A diff whose only package.json change is `key`, and the plan it produces.
	 */
	const withKey = (key: string, value: unknown = { added: true }) => {
		const io = exec({
			changed: [PACKAGE_JSON],
			selects: ["a.test.ts"],
			old: { name: "m" },
		});
		const fsImpl = files({ name: "m", [key]: value });
		return { got: plan(io, fsImpl), io, fs: fsImpl };
	};

	/** The `vitest list` call the probe made. */
	const listCall = (io: ReturnType<typeof exec>) =>
		io.calls.find((c) => c[1] === "list") as string[];

	/* The keys it narrows on, and keys it must not: a widening to any key in the
	 * second list fails here. A widening to a key named in neither passes, so a
	 * key added to the allow-list is added to the first list too. */
	it.each([
		"scripts",
		"comments",
		"name",
		"version",
		"engines",
		"type",
		"browserslist",
	])("narrows on a change to %s alone", (key) => {
		expect(withKey(key).got.narrowed).toBe(true);
	});

	it.each([
		"dependencies",
		"devDependencies",
		"overrides",
		"private",
		"packageManager",
		"bin",
	])("never narrows on a change to %s", (key) => {
		expect(withKey(key).got.narrowed).toBe(false);
	});

	it("hands the probe a --config override where every changed key is allow-listed", () => {
		const { io, fs: fsImpl } = scriptsOnly();
		const got = plan(io, fsImpl);
		expect(got.narrowed).toBe(true);
		expect(listCall(io)).toEqual([
			"/repo/node_modules/.bin/vitest",
			"list",
			"--changed",
			"--filesOnly",
			"--config",
			probePath,
		]);
		expect(Object.keys(fsImpl.written)).toEqual([probePath]);
	});

	it("writes an override that SPREADS the real config and FILTERS its own triggers, rather than replacing them", () => {
		const { io, fs: fsImpl } = scriptsOnly();
		plan(io, fsImpl);
		const source = fsImpl.written[probePath];
		expect(source).toContain("...base");
		expect(source).toContain("...base.test");
		expect(source).toContain('import base from "../repo/vitest.config.ts"');
		expect(source).toContain("base.test?.forceRerunTriggers ?? fallback");
		expect(source).toContain(".filter(");
		expect(source).toContain('"**/package.json/**"');
		expect(source).toContain("{vitest,vite}.config.");
	});

	/** The scratch config a `scripts`-only probe writes, wherever it is put. */
	const written = (probeConfig?: string) => {
		const { io, fs: fsImpl } = scriptsOnly();
		expandChanged(["--changed"], {
			root: "/repo",
			bin: "/repo/node_modules/.bin/vitest",
			execFn: io.fn,
			fs: fsImpl,
			...(probeConfig ? { probeConfig } : {}),
			loadEdges: () => ({}),
			err: { write: () => true },
		});
		return fsImpl.written;
	};

	it("falls back to vitest's own default triggers, dropping only the package.json glob", () => {
		const source = written(probePath)[probePath];
		expect(source).toContain(
			'const fallback = ["**/package.json/**","**/{vitest,vite}.config.*/**"];',
		);
		expect(source).toContain('const drop = "**/package.json/**";');
	});

	it("imports the real config by a specifier that resolves from wherever the scratch file sits", () => {
		expect(written("/tmp/x/probe.mts")["/tmp/x/probe.mts"]).toContain(
			'"../../repo/vitest.config.ts"',
		);
		/* A bare `vitest.config.ts` would resolve as a PACKAGE specifier. */
		expect(written("/repo/probe.mts")["/repo/probe.mts"]).toContain(
			'"./vitest.config.ts"',
		);
	});

	it("scopes the scratch file to this process, like the in-flight file", () => {
		expect(Object.keys(written())).toEqual([
			path.join(os.tmpdir(), `wfc-vitest-probe-${process.pid}.mts`),
		]);
	});

	it("removes the scratch file once the probe has answered", () => {
		const { io, fs: fsImpl } = scriptsOnly();
		plan(io, fsImpl);
		expect(fsImpl.unlinked).toEqual([probePath]);
	});

	it("removes it even where the probe throws", () => {
		const io = exec({
			changed: [PACKAGE_JSON],
			old: { scripts: { test: "old" } },
		});
		const fsImpl = files({ scripts: { test: "new" } });
		const throwing = {
			fn: (file: string, args: string[]) => {
				if (args[0] === "list") throw new Error("boom");
				return io.fn(file, args);
			},
			calls: io.calls,
		};
		expect(() => plan(throwing, fsImpl)).toThrow("boom");
		expect(fsImpl.unlinked).toEqual([probePath]);
	});

	for (const key of ["dependencies", "devDependencies", "overrides"])
		it(`still selects the whole suite where the diff touches ${key}`, () => {
			const { got, io } = withKey(key, { left: "1.0.0" });
			expect(got.narrowed).toBe(false);
			expect(listCall(io)).not.toContain("--config");
		});

	it("still selects the whole suite for a key nobody has allow-listed", () => {
		const { got, io } = withKey("workspaces", ["packages/*"]);
		expect(got.narrowed).toBe(false);
		expect(listCall(io)).not.toContain("--config");
	});

	it("counts a REMOVED key as changed, not only an added or edited one", () => {
		const io = exec({
			changed: [PACKAGE_JSON],
			old: { name: "m", dependencies: { left: "1.0.0" } },
		});
		expect(plan(io, files({ name: "m" })).narrowed).toBe(false);
	});

	it("narrows on an allow-listed key edited alongside an unrelated file", () => {
		const io = exec({
			changed: [PACKAGE_JSON, "docs/fixture-doc.md"],
			selects: ["a.test.ts"],
			old: { comments: { a: "old" } },
		});
		expect(plan(io, files({ comments: { a: "new" } })).narrowed).toBe(true);
	});

	it("narrows a whitespace- or key-order-only edit: no parsed key actually changed", () => {
		const io = exec({
			changed: [PACKAGE_JSON],
			selects: ["a.test.ts"],
			old: { name: "m", scripts: { test: "x" } },
		});
		expect(
			plan(io, files({ scripts: { test: "x" }, name: "m" })).narrowed,
		).toBe(true);
	});

	it("never lets the probe's --config reach the real `vitest run` invocation", () => {
		const { io, fs: fsImpl } = scriptsOnly();
		const got = plan(io, fsImpl);
		expect(got.narrowed).toBe(true);
		expect(got.argv).not.toContain("--config");
		expect(got.argv).not.toContain(probePath);
	});

	it("fails closed where the old side cannot be read", () => {
		const io = exec({
			changed: [PACKAGE_JSON],
			old: {},
			showThrows: true,
		});
		expect(plan(io, files({ scripts: {} })).narrowed).toBe(false);
	});

	it("fails closed where the working tree cannot be read", () => {
		const io = exec({ changed: [PACKAGE_JSON], old: { scripts: {} } });
		expect(
			plan(io, files({ scripts: {} }, { readThrows: true })).narrowed,
		).toBe(false);
	});

	for (const [side, io, fsImpl] of [
		[
			"old",
			exec({ changed: [PACKAGE_JSON], old: "{ not json" }),
			files({ scripts: {} }),
		],
		[
			"new",
			exec({ changed: [PACKAGE_JSON], old: { scripts: {} } }),
			files("{ not json"),
		],
	] as [string, ReturnType<typeof exec>, ReturnType<typeof files>][])
		it(`fails closed where the ${side} side will not parse`, () => {
			expect(plan(io, fsImpl).narrowed).toBe(false);
		});

	it("fails closed where the scratch config cannot be written, and passes no --config", () => {
		const io = exec({
			changed: [PACKAGE_JSON],
			selects: ["a.test.ts"],
			old: { scripts: { test: "old" } },
		});
		const got = plan(
			io,
			files({ scripts: { test: "new" } }, { writeThrows: true }),
		);
		expect(got.narrowed).toBe(false);
		expect(listCall(io)).not.toContain("--config");
	});

	it("asks git nothing about package.json where the diff does not touch it", () => {
		const io = exec({
			changed: ["docs/fixture-doc.md"],
			selects: ["a.test.ts"],
		});
		const got = plan(io, files({}));
		expect(got.narrowed).toBe(false);
		expect(io.calls.some((c) => c[1] === "show")).toBe(false);
		expect(listCall(io)).not.toContain("--config");
	});

	it("reads the old side at the ref --changed was given", () => {
		const io = exec({
			changed: [PACKAGE_JSON],
			old: { scripts: { test: "old" } },
		});
		plan(io, files({ scripts: { test: "new" } }), {}, ["--changed", "HEAD~3"]);
		expect(io.calls.find((c) => c[1] === "show")).toEqual([
			"git",
			"show",
			`HEAD~3:${PACKAGE_JSON}`,
		]);
	});

	it("keeps the read-edge union, which is what makes narrowing on `scripts` safe", () => {
		const io = exec({
			changed: [PACKAGE_JSON],
			selects: ["a.test.ts"],
			old: { scripts: { test: "old" } },
		});
		const got = plan(io, files({ scripts: { test: "new" } }), {
			[PACKAGE_JSON]: ["gate.test.ts"],
		});
		expect(got.narrowed).toBe(true);
		expect(got.added).toEqual(["gate.test.ts"]);
		expect(got.files).toEqual(["a.test.ts", "gate.test.ts"]);
	});

	it("finds package.json readers in the LIVE manifest, which is the other half of why `scripts` is safe to narrow on", () => {
		const edges = JSON.parse(
			fs.readFileSync(
				path.join(REPO_ROOT, "docs/test-read-edges.json"),
				"utf8",
			),
		).edges;
		expect(edges[PACKAGE_JSON]?.length).toBeGreaterThan(0);
	});

	describe("what the banner claims", () => {
		it("drops the whole-suite claim on a run that was narrowed", () => {
			const { io, fs: fsImpl } = scriptsOnly();
			const got = plan(io, fsImpl);
			expect(got.banner).not.toContain("selects effectively the");
			expect(got.banner).not.toMatch(fullSuiteCost);
			expect(got.banner).toContain("allow-list");
		});

		it("keeps it on a run that was not", () => {
			const { got } = withKey("dependencies", { left: "1.0.0" });
			expect(got.banner).toContain("selects effectively the");
			expect(got.banner).toMatch(fullSuiteCost);
		});
	});
});

/** `lines` as a listing prints them, or a throw of `message` where `failed`. */
const listingOf = (lines: string[], failed: boolean, message: string) => {
	if (failed) throw new Error(message);
	return lines.length > 0 ? `${lines.join("\n")}\n` : "\n";
};

type Answer = (args: string[], opts: { cwd: string }) => string;

/**
 * A `git`/`vitest` stand-in answering by the call's first argument from
 * `answers` — a `rev-parse` under the key "origin/main", and only where it
 * names origin/main — and through the real binary for every other call.
 */
const execAnswering =
	(answers: Record<string, Answer>) =>
	(file: string, args: string[], opts: { cwd: string }) => {
		const key =
			args[0] === "rev-parse" && args.includes("origin/main")
				? "origin/main"
				: (args[0] ?? "");
		const answer = Object.hasOwn(answers, key) ? answers[key] : undefined;
		if (answer) return answer(args, opts);
		return require("node:child_process").execFileSync(file, args, opts);
	};

/**
 * A `git`/`vitest` stand-in that answers the calls the default flip
 * makes itself — `rev-parse --verify --quiet origin/main`, `merge-base`,
 * `diff --name-only` and `vitest list` — and falls through to the real
 * binary for everything else (worktree add/remove, status, prune),
 * so it composes with a real repo fixture rather than replacing one.
 */
function fakeExec({
	hasOrigin = false,
	mergeBase = "merge-base-sha",
	diff = [] as string[],
	list = [] as string[],
	failDiff = false,
	failList = false,
} = {}) {
	return execAnswering({
		"origin/main": () => {
			if (!hasOrigin) throw new Error("unknown revision or path");
			return `${mergeBase}\n`;
		},
		"merge-base": () => `${mergeBase}\n`,
		diff: () => listingOf(diff, failDiff, "git diff failed"),
		list: () => listingOf(list, failList, "vitest list failed"),
	});
}

describe("`--isolated`, which runs against a frozen tree (mantahostels#2169)", () => {
	const { attributeDirty } = require("./lib/own-selection.js");
	const {
		createIsolated,
		removeIsolated,
		sweepIsolated,
	} = require("./lib/isolated-worktree.js");
	const isolatedFlag = "--isolated";
	/* Where the throwaway worktrees go, as lib/isolated-worktree.js puts them. */
	const worktreeDir = path.join(".claude", "worktrees");
	const { repoRoot } = require("./lib/test-pass-marker.js");
	const arbiterProc = require("./lib/arbiter-proc.js");

	/**
	 * `initGitRepo` (scripts/lib/git-fixture.ts) plus the one thing an isolated
	 * run needs from a real checkout: a `node_modules` for `createIsolated` to
	 * link. A file inside it, so a symlink that got REPLACED by a copy would be
	 * visible. Built once per worker and copied out (mantahostels#2197) rather than
	 * `git init` per call, matching the 13 other files already on this helper.
	 * Two things about the copy are untested by the helper's own suite:
	 * these tests go on to `git worktree add` inside the instance themselves,
	 * after instantiate()'s own leak check has already run, so that check has
	 * never been exercised against a worktree created this way; and
	 * `node_modules` here is a real directory inside a copied template, also
	 * new. Both are unproblematic so far, but neither has been exercised
	 * against a leak.
	 */
	const repoWithDepsTemplate = defineTemplate((dir) => {
		const hooks = path.join(dir, "no-hooks");
		fs.mkdirSync(hooks);
		const repoDir = path.join(dir, "repo");
		initGitRepo(repoDir, hooks);
		const bin = path.join(repoDir, "node_modules", ".bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "vitest"), "#!\n");
		// A second `SHARED_ARTEFACTS` member, gitignored the same way `.husky/_`
		// is in the real checkout, so a test can pin the mechanism generalises
		// past `node_modules` rather than special-casing it (mantahostels#2213). `.husky`
		// itself needs a TRACKED file to exist in a fresh worktree at all — in
		// the real checkout that's the committed hook scripts; here it's this
		// placeholder — so the untracked `_/h` beside it has a parent directory
		// to land in.
		const husky = path.join(repoDir, ".husky");
		fs.mkdirSync(husky, { recursive: true });
		fs.writeFileSync(path.join(husky, "pre-commit"), "#!\n");
		const { execFileSync } = require("node:child_process");
		execFileSync("git", ["add", ".husky/pre-commit"], { cwd: repoDir });
		execFileSync("git", ["commit", "-qm", "husky"], { cwd: repoDir });
		const underscore = path.join(husky, "_");
		fs.mkdirSync(underscore, { recursive: true });
		fs.writeFileSync(path.join(underscore, "h"), "#!\n");
	});

	function repoWithDeps() {
		// mkScratchDir realpaths its base, which repoRoot() below needs:
		// it resolves via `git rev-parse`, which resolves symlinks, so a path
		// reached through one would mismatch it.
		const instance = mkScratchDir("runvitest-deps-");
		dirs.push(instance);
		repoWithDepsTemplate.instantiate(instance);
		return path.join(instance, "repo");
	}

	/** A ledger stub: what this session wrote, and who else holds a claim. */
	function ledgerOf(written: string[] | null, locks: unknown[] = []) {
		return {
			readWritesBy: () => written,
			readLocks: () => locks,
			subjectPath: (p: string) => p,
		};
	}

	const worktreeOf = (dir: string, pid: number) =>
		path.join(dir, worktreeDir, `isolated-${pid}`);

	const gitIn = (cwd: string, args: string[]): string =>
		require("node:child_process").execFileSync("git", args, {
			cwd,
			encoding: "utf8",
		});

	describe("the worktree it runs in", () => {
		it("is detached at HEAD, spawns vitest there, and has every shared artefact linked in", async () => {
			const dir = repoWithDeps();
			const seen: { cwd?: string; existed?: boolean; huskyExisted?: boolean } =
				{};
			const out = sink();
			const err = sink();
			const code = await main(["--full=coverage"], {
				root: dir,
				pid: 4242,
				ledger: ledgerOf([]),
				out,
				err,
				fs: fakeFs(),
				spawnFn: (_bin: string, _args: string[], opts: { cwd: string }) => {
					seen.cwd = opts.cwd;
					seen.existed = fs.existsSync(
						path.join(opts.cwd, "node_modules", ".bin", "vitest"),
					);
					seen.huskyExisted = fs.existsSync(
						path.join(opts.cwd, ".husky", "_", "h"),
					);
					return fakeChild({ code: 0 });
				},
			});

			expect(code).toBe(0);
			expect(seen.cwd).toBe(worktreeOf(dir, 4242));
			// Through the symlink: the run resolves the canonical checkout's deps.
			expect(seen.existed).toBe(true);
			expect(seen.huskyExisted).toBe(true);
			const head = require("node:child_process")
				.execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: dir,
					encoding: "utf8",
				})
				.trim();
			expect(out.text.join("")).toContain(head);
		});

		it("is removed on the red path as well as the green", async () => {
			for (const code of [0, 1]) {
				const dir = repoWithDeps();
				const exit = await main(["--full=coverage"], {
					root: dir,
					pid: 4243,
					ledger: ledgerOf([]),
					out: sink(),
					err: sink(),
					fs: fakeFs(),
					spawnFn: () => fakeChild({ code }),
				});
				expect(exit).toBe(code);
				expect(fs.existsSync(worktreeOf(dir, 4243))).toBe(false);
				const list = require("node:child_process").execFileSync(
					"git",
					["worktree", "list"],
					{ cwd: dir, encoding: "utf8" },
				);
				expect(list).not.toContain("isolated-4243");
			}
		});

		it("leaves the canonical checkout's node_modules intact", () => {
			const dir = repoWithDeps();
			const made = createIsolated(dir, { pid: 4244 });
			expect(made.error).toBe(null);
			removeIsolated(dir, made.dir, { err: sink() });
			// This assertion does not discriminate the unlink-first ordering
			// (mantahostels#2169).
			expect(
				fs.existsSync(path.join(dir, "node_modules", ".bin", "vitest")),
			).toBe(true);
			expect(fs.existsSync(made.dir)).toBe(false);
		});

		it("leaves the canonical checkout's .husky/_/h intact", () => {
			const dir = repoWithDeps();
			const made = createIsolated(dir, { pid: 4265 });
			expect(made.error).toBe(null);
			removeIsolated(dir, made.dir, { err: sink() });
			expect(fs.existsSync(path.join(dir, ".husky", "_", "h"))).toBe(true);
			expect(fs.existsSync(made.dir)).toBe(false);
		});

		/** `dir` with `links` committed as its `worktreeLinks`, and each of `onDisk` written untracked. */
		function declaring(dir: string, links: string[], onDisk: string[]) {
			fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, ".claude/workflow-core.json"),
				JSON.stringify({ worktreeLinks: links }),
			);
			gitIn(dir, ["add", "-f", ".claude/workflow-core.json"]);
			gitIn(dir, ["commit", "-qm", "links"]);
			for (const rel of onDisk) {
				fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
				fs.writeFileSync(path.join(dir, rel), "canonical\n");
			}
		}

		it("links a declared path the checkout has, makes nothing for one it lacks, and keeps the worktree's own copy of one HEAD tracks (#1767)", () => {
			const dir = repoWithDeps();
			fs.writeFileSync(path.join(dir, "tracked.txt"), "committed\n");
			gitIn(dir, ["add", "tracked.txt"]);
			declaring(dir, [".env", "absent/x", "tracked.txt"], [".env"]);
			fs.writeFileSync(path.join(dir, "tracked.txt"), "unsaved\n");
			const made = createIsolated(dir, { pid: 4266 });
			expect(made.error).toBe(null);
			if (made.dir === null) return;
			expect(fs.lstatSync(path.join(made.dir, ".env")).isSymbolicLink()).toBe(
				true,
			);
			expect(fs.existsSync(path.join(made.dir, "absent"))).toBe(false);
			expect(fs.readFileSync(path.join(made.dir, "tracked.txt"), "utf8")).toBe(
				"committed\n",
			);
			removeIsolated(dir, made.dir, { err: sink() });
			expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(
				"canonical\n",
			);
			expect(fs.existsSync(made.dir)).toBe(false);
		});

		it("unlinks no declared path that resolves through another link, so the canonical link it names survives teardown (#1767)", () => {
			const dir = repoWithDeps();
			// A venv's interpreter is itself a symlink in the canonical checkout.
			declaring(dir, ["venv"], ["venv/bin/python3.12"]);
			const python = path.join(dir, "venv/bin/python");
			fs.symlinkSync("python3.12", python);
			const made = createIsolated(dir, { pid: 4267 });
			expect(made.error).toBe(null);
			if (made.dir === null) return;
			// The suite rewrites its own copy of the config, so teardown's list
			// names a path inside the linked venv ahead of the link itself.
			fs.writeFileSync(
				path.join(made.dir, ".claude/workflow-core.json"),
				JSON.stringify({ worktreeLinks: ["venv/bin/python", "venv"] }),
			);
			removeIsolated(dir, made.dir, { err: sink() });
			expect(fs.lstatSync(python).isSymbolicLink()).toBe(true);
			expect(fs.existsSync(made.dir)).toBe(false);
		});

		it("refuses a worktree where HEAD tracks a path under a shared artefact, rather than running without it", () => {
			const dir = repoWithDeps();
			fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
			fs.writeFileSync(path.join(dir, "node_modules", "pinned.js"), "\n");
			gitIn(dir, ["add", "-f", "node_modules/pinned.js"]);
			gitIn(dir, ["commit", "-qm", "pinned"]);
			const made = createIsolated(dir, { pid: 4268, err: sink() });
			expect(made.error).toContain("could not link node_modules");
			expect(fs.existsSync(worktreeOf(dir, 4268))).toBe(false);
		});
	});

	describe("the certificate it records", () => {
		it("is rooted at the canonical checkout, not the worktree", () => {
			const dir = repoWithDeps();
			const made = createIsolated(dir, { pid: 4245 });
			// `repoRoot` resolves the parent of the COMMON git dir, so a certificate
			// written from inside the worktree lands in the store a later push
			// reads.
			expect(repoRoot(made.dir)).toBe(dir);
			expect(repoRoot(made.dir)).not.toBe(made.dir);
			removeIsolated(dir, made.dir, { err: sink() });
		});

		it("reads headMovedDuringRun false while a neighbour commits", () => {
			const { readTreeSnapshot, drift } = require("./lib/tree-drift.js");
			const { markerFrom } = require("./lib/test-pass-marker.js");
			const dir = repoWithDeps();
			const made = createIsolated(dir, { pid: 4246 });

			const before = readTreeSnapshot(made.dir);
			const beforeShared = readTreeSnapshot(dir);
			gitIn(dir, [
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"a neighbour's commit",
			]);

			const isolated = markerFrom(
				before,
				readTreeSnapshot(made.dir),
				drift(before, readTreeSnapshot(made.dir)),
				{ held: [] },
			);
			const shared = markerFrom(
				beforeShared,
				readTreeSnapshot(dir),
				drift(beforeShared, readTreeSnapshot(dir)),
				{ held: [] },
			);

			expect(isolated.headMovedDuringRun).toBe(false);
			// The same commit, watched from the shared tree, DOES move HEAD.
			expect(shared.headMovedDuringRun).toBe(true);
			expect(isolated.sha).not.toBe(shared.sha);
			removeIsolated(dir, made.dir, { err: sink() });
		});

		it("hands the child the worktree's own globalSetup, not the canonical one", async () => {
			// AC 3 turns on `scripts/vitest-tree-watch.ts` resolving its ROOT from
			// the WORKTREE copy of itself. The certificate assertions above hand-build
			// their snapshots and would pass even if the child were handed the
			// canonical root, so this pins the wiring they assume (mantahostels#2169).
			const dir = repoWithDeps();
			fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
			fs.writeFileSync(path.join(dir, "scripts", "vitest-tree-watch.ts"), "");
			gitIn(dir, ["add", "scripts/vitest-tree-watch.ts"]);
			gitIn(dir, ["commit", "-q", "-m", "watch"]);

			const seen: { cwd?: string; bin?: string } = {};
			await main(["--full=coverage"], {
				root: dir,
				pid: 4260,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (bin: string, _a: string[], opts: { cwd: string }) => {
					seen.cwd = opts.cwd;
					seen.bin = bin;
					// vitest resolves `globalSetup` against its own root, which is the
					// cwd it was spawned in — so this is the file it would load, and
					// `ROOT = resolve(dirname(thatFile), "..")` is the worktree.
					const watch = path.join(opts.cwd, "scripts", "vitest-tree-watch.ts");
					expect(fs.existsSync(watch)).toBe(true);
					expect(path.resolve(path.dirname(watch), "..")).toBe(opts.cwd);
					return fakeChild({ code: 0 });
				},
			});

			expect(seen.cwd).toBe(worktreeOf(dir, 4260));
			expect(seen.bin).toBe(
				path.join(worktreeOf(dir, 4260), "node_modules", ".bin", "vitest"),
			);
		});

		it("names the sha it is frozen at, not the tip a neighbour just moved", async () => {
			// THE WINDOW IS BETWEEN `worktree add` AND THE BANNER, so the neighbour
			// has to commit there — moving canonical HEAD from a `spawnFn` is too
			// late, and a test written that way passes with the bug in (mantahostels#2169
			// review's mutation run).
			const dir = repoWithDeps();
			const out = sink();
			const frozen = gitIn(dir, ["rev-parse", "HEAD"]).trim();
			const realExec = require("node:child_process").execFileSync;
			await main(["--full=coverage"], {
				root: dir,
				pid: 4261,
				ledger: ledgerOf([]),
				out,
				err: sink(),
				fs: fakeFs(),
				execFn: (file: string, args: string[], opts: object) => {
					const result = realExec(file, args, opts);
					if (args[0] === "worktree" && args[1] === "add")
						gitIn(dir, ["commit", "-q", "--allow-empty", "-m", "neighbour"]);
					return result;
				},
				spawnFn: () => fakeChild({ code: 0 }),
			});
			const moved = gitIn(dir, ["rev-parse", "HEAD"]).trim();
			expect(moved).not.toBe(frozen);
			expect(out.text.join("")).toContain(frozen);
			expect(out.text.join("")).not.toContain(moved);
		});
	});

	describe("the dirty-tree refusal", () => {
		it("names this session's own uncommitted files and runs nothing", async () => {
			const dir = repoWithDeps();
			fs.writeFileSync(path.join(dir, "kept.txt"), "one\n");
			const cp = require("node:child_process");
			cp.execFileSync("git", ["add", "kept.txt"], { cwd: dir });
			cp.execFileSync("git", ["commit", "-q", "-m", "kept"], { cwd: dir });
			fs.writeFileSync(path.join(dir, "kept.txt"), "two\n");

			let spawned = false;
			const err = sink();
			const code = await main(["--full=coverage"], {
				root: dir,
				pid: 4247,
				sessionId: "mine",
				ledger: ledgerOf(["kept.txt"]),
				out: sink(),
				err,
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});

			expect(code).toBe(1);
			expect(spawned).toBe(false);
			expect(err.text.join("")).toContain("kept.txt");
			expect(err.text.join("")).toContain("REFUSED");
			expect(fs.existsSync(worktreeOf(dir, 4247))).toBe(false);
		});

		it("only warns about dirt this session did not make, and runs", async () => {
			const dir = repoWithDeps();
			const cp = require("node:child_process");
			fs.writeFileSync(path.join(dir, "theirs.txt"), "one\n");
			cp.execFileSync("git", ["add", "theirs.txt"], { cwd: dir });
			cp.execFileSync("git", ["commit", "-q", "-m", "theirs"], { cwd: dir });
			fs.writeFileSync(path.join(dir, "theirs.txt"), "two\n");

			let spawned = false;
			const err = sink();
			const code = await main(["--full=coverage"], {
				root: dir,
				pid: 4248,
				sessionId: "mine",
				// A NON-EMPTY ledger that does not hold `theirs.txt`: an empty one
				// short-circuits into the unnamed-session branch and would prove
				// only the fallback (mantahostels#2169).
				ledger: ledgerOf(["something-else.ts"]),
				out: sink(),
				err,
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});

			expect(code).toBe(0);
			expect(spawned).toBe(true);
			expect(err.text.join("")).toContain("not attributable");
		});

		it("refuses over a file this session CREATED and never committed, naming it", async () => {
			// `git status -uno` drops an untracked file, so without the separate
			// untracked read `--isolated` runs straight past a file this session
			// created — no refusal, not even the neighbour warning (mantahostels#2169).
			const dir = repoWithDeps();
			fs.writeFileSync(path.join(dir, "brand-new.test.ts"), "//\n");

			let spawned = false;
			const err = sink();
			const code = await main(["--full=coverage"], {
				root: dir,
				pid: 4263,
				sessionId: "mine",
				ledger: ledgerOf(["brand-new.test.ts"]),
				out: sink(),
				err,
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});

			expect(code).toBe(1);
			expect(spawned).toBe(false);
			expect(err.text.join("")).toContain("brand-new.test.ts");
		});

		it("still ignores untracked scratch this session never wrote", async () => {
			// The other half: this tree carries hundreds of untracked files, so an
			// untracked path enters the refusal only through the write ledger.
			const dir = repoWithDeps();
			fs.writeFileSync(path.join(dir, "someone-elses-scratch.md"), "x\n");
			let spawned = false;
			const code = await main(["--full=coverage"], {
				root: dir,
				pid: 4264,
				sessionId: "mine",
				ledger: ledgerOf(["unrelated.ts"]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});
			expect(code).toBe(0);
			expect(spawned).toBe(true);
		});

		it("refuses rather than guessing when git will not answer", async () => {
			const err = sink();
			let spawned = false;
			const code = await main(["--full=coverage"], {
				root: repoWithDeps(),
				pid: 4249,
				execFn: () => {
					throw new Error("no git here");
				},
				out: sink(),
				err,
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});
			expect(code).toBe(1);
			expect(spawned).toBe(false);
			expect(err.text.join("")).toContain("REFUSED");
		});
	});

	describe("attribution", () => {
		it("bills nothing to a session that cannot be named", () => {
			expect(attributeDirty(["a", "b"], { ledger: ledgerOf(null) })).toEqual({
				mine: [],
				theirs: ["a", "b"],
				quoted: [],
			});
		});

		it("subtracts a path a live neighbour holds", () => {
			const lock = {
				sessionId: "other",
				path: "shared.ts",
				pid: process.pid,
				procStart: arbiterProc.readProcStartOf(process.pid),
				bootId: arbiterProc.readCurrentBootId(),
			};
			expect(
				attributeDirty(["shared.ts", "solo.ts"], {
					sessionId: "mine",
					ledger: ledgerOf(["shared.ts", "solo.ts"], [lock]),
				}),
			).toEqual({ mine: ["solo.ts"], theirs: ["shared.ts"], quoted: [] });
		});

		it("subtracts a path whose own hunks have all landed, and nothing where that read throws (#2539)", () => {
			const landed = {
				...ledgerOf(["landed.ts", "pending.ts"]),
				readLandedBy: () => new Set(["landed.ts"]),
			};
			expect(
				attributeDirty(["landed.ts", "pending.ts", "never.ts"], {
					sessionId: "mine",
					ledger: landed,
				}),
			).toEqual({
				mine: ["pending.ts"],
				theirs: ["landed.ts", "never.ts"],
				quoted: [],
			});

			const unread = {
				...ledgerOf(["landed.ts"]),
				readLandedBy: () => {
					throw new Error("store unreadable");
				},
			};
			expect(
				attributeDirty(["landed.ts"], { sessionId: "mine", ledger: unread })
					.mine,
			).toEqual(["landed.ts"]);
		});

		/*
		 * lib/claimed-bash-write.js credits an uncontended CODE target at
		 * `PreToolUse` (mantahostels#2778), so a path that reached the tree by `sed -i` or a
		 * redirect is `mine` and refuses under `--isolated` rather than warning
		 * as `theirs`.
		 *
		 * Through the REAL hook entry and the REAL store, because a stub ledger
		 * could not tell the two apart: what needs pinning is that the writer
		 * and this reader agree on where the ledger lives and how it spells a
		 * path. The entry goes through `runInProcess` (§X3), whose `env` option
		 * covers that call. The hand-rolled environment wrap below covers what
		 * the seam cannot: `attributeDirty` is a plain function call in this
		 * process, and the store resolves its paths off those two variables at
		 * call time.
		 */
		/* The CODE-glob gate that picks which targets are credited is pinned in
		 * lib/claimed-bash-write.test.ts; what is driven here is the ledger the
		 * core writes and this function reads. */
		it("bills a credited Bash-route code write to `mine` (mantahostels#2778)", () => {
			const home = fs.realpathSync(
				fs.mkdtempSync(path.join(os.tmpdir(), "runvitest-credit-")),
			);
			dirs.push(home);
			const projectDir = path.join(home, "repo");
			fs.mkdirSync(projectDir, { recursive: true });
			const env = {
				...process.env,
				CLAUDE_PROJECT_DIR: projectDir,
				CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			};
			const credited = require("./lib/run-in-process.js").runInProcess(
				path.join(__dirname, "guard-dispatch.js"),
				[],
				{
					cwd: projectDir,
					env,
					stdin: JSON.stringify({
						session_id: "bash-session",
						hook_event_name: "PreToolUse",
						tool_name: "Bash",
						tool_input: { command: "echo x > scripts/bash-written.ts" },
					}),
				},
			);
			// Crediting refuses nothing and prints nothing, so a non-zero exit
			// or a word on stdout is a fault in the fixture, not a verdict.
			expect(credited.status).toBe(0);
			expect(credited.stdout).toBe("");
			const saved = {
				project: process.env.CLAUDE_PROJECT_DIR,
				config: process.env.CLAUDE_CONFIG_DIR,
			};
			process.env.CLAUDE_PROJECT_DIR = projectDir;
			process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
			try {
				expect(
					attributeDirty(["scripts/bash-written.ts", "scripts/never.ts"], {
						sessionId: "bash-session",
						ledger: require("./lib/arbiter-store.js"),
					}),
				).toEqual({
					mine: ["scripts/bash-written.ts"],
					theirs: ["scripts/never.ts"],
					quoted: [],
				});
			} finally {
				for (const [key, value] of [
					["CLAUDE_PROJECT_DIR", saved.project],
					["CLAUDE_CONFIG_DIR", saved.config],
				] as const)
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
			}
		});

		describe("a staged rename (#1791)", () => {
			it("bills the source with a destination this session wrote", () => {
				expect(
					attributeDirty(["new.ts", "old.ts", "gone.ts"], {
						sessionId: "mine",
						ledger: ledgerOf(["new.ts"]),
						renames: [{ path: "new.ts", source: "old.ts" }],
					}),
				).toEqual({
					mine: ["new.ts", "old.ts"],
					theirs: ["gone.ts"],
					quoted: [],
				});
			});

			it("bills the destination with a source this session's Bash deleted", () => {
				expect(
					attributeDirty(["new.ts", "old.ts"], {
						sessionId: "mine",
						ledger: {
							...ledgerOf([]),
							readSelectsBy: () => [{ path: "old.ts", at: 2000 }],
						},
						renames: [{ path: "new.ts", source: "old.ts" }],
						committedAt: () => 1000,
					}),
				).toEqual({
					mine: ["new.ts", "old.ts"],
					theirs: [],
					quoted: ["old.ts"],
				});
			});

			it("leaves the source theirs where the destination is not this session's", () => {
				expect(
					attributeDirty(["new.ts", "old.ts", "w.ts"], {
						sessionId: "mine",
						ledger: ledgerOf(["w.ts"]),
						renames: [{ path: "new.ts", source: "old.ts" }],
					}),
				).toEqual({ mine: ["w.ts"], theirs: ["new.ts", "old.ts"], quoted: [] });
			});
		});

		describe("a quoted path (#1220)", () => {
			const quotes = (entries: { path: string; at: number }[]) => ({
				...ledgerOf([]),
				readSelectsBy: () => entries,
			});

			it("is mine where quoted after its last commit, and named as quoted", () => {
				expect(
					attributeDirty(["q.ts", "other.ts"], {
						sessionId: "mine",
						ledger: quotes([{ path: "q.ts", at: 2000 }]),
						committedAt: () => 1000,
					}),
				).toEqual({ mine: ["q.ts"], theirs: ["other.ts"], quoted: ["q.ts"] });
			});

			it("is theirs where quoted before its last commit", () => {
				expect(
					attributeDirty(["q.ts"], {
						sessionId: "mine",
						ledger: quotes([{ path: "q.ts", at: 500 }]),
						committedAt: () => 1000,
					}),
				).toEqual({ mine: [], theirs: ["q.ts"], quoted: [] });
			});

			it("counts for nothing without committedAt, the --isolated refusal's call", () => {
				expect(
					attributeDirty(["q.ts"], {
						sessionId: "mine",
						ledger: quotes([{ path: "q.ts", at: 2000 }]),
					}),
				).toEqual({ mine: [], theirs: ["q.ts"], quoted: [] });
			});

			it("is theirs where a live neighbour holds it", () => {
				const lock = {
					sessionId: "other",
					path: "q.ts",
					pid: process.pid,
					procStart: arbiterProc.readProcStartOf(process.pid),
					bootId: arbiterProc.readCurrentBootId(),
				};
				expect(
					attributeDirty(["q.ts"], {
						sessionId: "mine",
						ledger: {
							...quotes([{ path: "q.ts", at: 2000 }]),
							readLocks: () => [lock],
						},
						committedAt: () => 0,
					}),
				).toEqual({ mine: [], theirs: ["q.ts"], quoted: [] });
			});

			it("asks committedAt only of a dirty path the write ledger lacks", () => {
				const asked: string[] = [];
				attributeDirty(["q.ts", "w.ts"], {
					sessionId: "mine",
					ledger: {
						...quotes([
							{ path: "q.ts", at: 1 },
							{ path: "w.ts", at: 1 },
							{ path: "clean.ts", at: 1 },
						]),
						readWritesBy: () => ["w.ts"],
					},
					committedAt: (p: string) => {
						asked.push(p);
						return 0;
					},
				});
				expect(asked).toEqual(["q.ts"]);
			});
		});
	});

	describe("argv shapes that would defeat the freeze", () => {
		it("refuses a bare --changed, which selects nothing at HEAD", async () => {
			let spawned = false;
			const err = sink();
			const code = await main([isolatedFlag, "--changed"], {
				root: repoWithDeps(),
				pid: 4262,
				ledger: ledgerOf([]),
				out: sink(),
				err,
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});
			expect(code).toBe(1);
			expect(spawned).toBe(false);
			expect(err.text.join("")).toContain("REFUSED");
		});

		/** An `--isolated` launch of `argv` in a fresh repo: what it said, and
		 * whether it spawned. */
		async function launched(argv: (dir: string) => string[]) {
			const dir = repoWithDeps();
			let spawned = false;
			const err = sink();
			const code = await main([isolatedFlag, ...argv(dir)], {
				root: dir,
				pid: 4263,
				ledger: ledgerOf([]),
				out: sink(),
				err,
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});
			return { code, spawned, said: err.text.join("") };
		}

		it("allows --changed with a ref, which still diffs", async () => {
			for (const argv of [["--changed", "HEAD"], ["--changed=HEAD"]]) {
				const run = await launched(() => argv);
				expect(run.said).not.toContain("REFUSED");
				expect(run.spawned).toBe(true);
			}
		});

		it("refuses an absolute path into the canonical checkout, naming it", async () => {
			let file = "";
			const run = await launched((dir) => {
				file = path.join(dir, "scripts/a.test.ts");
				return [file];
			});
			expect(run.code).toBe(1);
			expect(run.spawned).toBe(false);
			expect(run.said).toContain("REFUSED");
			expect(run.said).toContain(file);
		});

		it("leaves a relative path and an absolute one outside the repo alone", async () => {
			const run = await launched(() => [
				"scripts/a.test.ts",
				"/elsewhere/b.test.ts",
			]);
			expect(run.said).not.toContain("REFUSED");
			expect(run.spawned).toBe(true);
		});
	});

	describe("the leftover sweep", () => {
		it("removes a worktree whose process is gone and spares one still running", () => {
			const dir = repoWithDeps();
			const gone = createIsolated(dir, { pid: 4250 });
			const live = createIsolated(dir, { pid: 4251 });
			expect(gone.error).toBe(null);
			expect(live.error).toBe(null);

			const removed = sweepIsolated(dir, {
				err: sink(),
				alive: (pid: number) => pid === 4251,
			});

			expect(removed).toEqual(["isolated-4250"]);
			expect(fs.existsSync(gone.dir)).toBe(false);
			expect(fs.existsSync(live.dir)).toBe(true);
			removeIsolated(dir, live.dir, { err: sink() });
		});

		it("clears debris named for THIS process's own pid", () => {
			// A pid is not an identity over time (mantahostels#2034). Sparing it would fail
			// `git worktree add` on an existing path and refuse the suite outright
			// — over a directory a dead predecessor left (mantahostels#2169).
			const dir = repoWithDeps();
			const own = createIsolated(dir, { pid: process.pid });
			expect(own.error).toBe(null);

			const removed = sweepIsolated(dir, { err: sink() });

			expect(removed).toEqual([`isolated-${process.pid}`]);
			expect(fs.existsSync(own.dir)).toBe(false);
		});

		it("drops the git record of a worktree whose directory is gone", () => {
			// readdirSync cannot see this case at all, so without the prune the
			// entry stands in `git worktree list` for ever (mantahostels#2169).
			const dir = repoWithDeps();
			const made = createIsolated(dir, { pid: 4253 });
			fs.rmSync(made.dir, { recursive: true, force: true });
			expect(gitIn(dir, ["worktree", "list"])).toContain("isolated-4253");

			sweepIsolated(dir, { err: sink() });

			expect(gitIn(dir, ["worktree", "list"])).not.toContain("isolated-4253");
		});
	});

	describe("the flag itself", () => {
		it("never reaches vitest", async () => {
			const dir = repoWithDeps();
			let args: string[] = [];
			await main([isolatedFlag], {
				root: dir,
				pid: 4252,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, a: string[]) => {
					args = a;
					return fakeChild({ code: 0 });
				},
			});
			expect(args).not.toContain(isolatedFlag);
		});
	});

	describe("`--full`, the expand half of mantahostels#2278's default flip (mantahostels#3206)", () => {
		const fullWithCause = `${FULL_FLAG}=coverage`;
		it("never reaches vitest", async () => {
			const dir = repoWithDeps();
			let args: string[] = [];
			await main([fullWithCause], {
				root: dir,
				pid: 4266,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, a: string[]) => {
					args = a;
					return fakeChild({ code: 0 });
				},
			});
			expect(args).not.toContain(FULL_FLAG);
			expect(args).not.toContain(fullWithCause);
		});

		it('writes the certificate\'s scope carrying full: "flag" (mantahostels#3207)', async () => {
			const dir = repoWithDeps();
			let env: Record<string, string> = {};
			await main([fullWithCause], {
				root: dir,
				pid: 4268,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (
					_bin: string,
					_a: string[],
					opts: { env: Record<string, string> },
				) => {
					env = opts.env;
					return fakeChild({ code: 0 });
				},
			});
			expect(readLaunch(env).full).toBe("flag");
			expect(readLaunch(env).fullCause).toBe("coverage");
		});

		/* Distinct from "never reaches vitest" above, which only pins that the
		 * flag is stripped: this pins that `--full` and a bare run take ONE
		 * spawn path. The fixture writes no `docs/test-read-edges.json`, so the
		 * bare run escalates on `stale-manifest` and the two argvs coincide at
		 * `["run"]`. */
		it("spawns what a bare run spawns — one spawn path, not merely an argv stripped of --full", async () => {
			const dir = repoWithDeps();
			let bare: string[] = [];
			let full: string[] = [];
			await main([], {
				root: dir,
				pid: 4254,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, a: string[]) => {
					bare = a;
					return fakeChild({ code: 0 });
				},
			});
			await main([fullWithCause], {
				root: dir,
				pid: 4255,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, a: string[]) => {
					full = a;
					return fakeChild({ code: 0 });
				},
			});
			expect(full).toEqual(bare);
		});

		it("isolates on --full alone, exactly as a bare run does", async () => {
			const dir = repoWithDeps();
			let cwd = "";
			await main([fullWithCause], {
				root: dir,
				pid: 4267,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
					cwd = opts.cwd;
					return fakeChild({ code: 0 });
				},
			});
			expect(cwd).toBe(worktreeOf(dir, 4267));
		});

		it("composes with --queue", async () => {
			const dir = repoWithDeps();
			let args: string[] = [];
			await main(["--queue", fullWithCause], {
				root: dir,
				pid: 4256,
				ledger: ledgerOf([]),
				gate: () => false,
				queueDir: qdir(),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, a: string[]) => {
					args = a;
					return fakeChild({ code: 0 });
				},
			});
			expect(args).not.toContain(FULL_FLAG);
			expect(args).not.toContain(fullWithCause);
			expect(args).not.toContain("--queue");
		});

		it("composes with --isolated", async () => {
			const dir = repoWithDeps();
			let cwd = "";
			await main([isolatedFlag, fullWithCause], {
				root: dir,
				pid: 4257,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
					cwd = opts.cwd;
					return fakeChild({ code: 0 });
				},
			});
			expect(cwd).toBe(worktreeOf(dir, 4257));
		});

		it("composes with --shared, which escapes isolation exactly as it does without --full", async () => {
			const dir = repoWithDeps();
			let cwd = "";
			await main([SHARED_FLAG, fullWithCause], {
				root: dir,
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
					cwd = opts.cwd;
					return fakeChild({ code: 0 });
				},
			});
			expect(cwd).toBe(dir);
		});

		it("REFUSES a bare --full, naming no reason, and never spawns vitest (#182)", async () => {
			const dir = repoWithDeps();
			let spawned = false;
			const code = await main([FULL_FLAG], {
				root: dir,
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});
			expect(code).toBe(1);
			expect(spawned).toBe(false);
		});

		it("REFUSES --full=<cause> outside the six values, naming the bad word, and never spawns vitest (#182)", async () => {
			const dir = repoWithDeps();
			let spawned = false;
			const errChunks: string[] = [];
			const code = await main([`${FULL_FLAG}=bogus`], {
				root: dir,
				out: sink(),
				err: { write: (s: string) => errChunks.push(s) },
				fs: fakeFs(),
				spawnFn: () => {
					spawned = true;
					return fakeChild({ code: 0 });
				},
			});
			expect(code).toBe(1);
			expect(spawned).toBe(false);
			expect(errChunks.join("")).toContain("bogus");
		});

		it("names the six causes in the refusal", async () => {
			const { FULL_CAUSES } = require("./lib/test-pass-marker.js");
			const dir = repoWithDeps();
			const errChunks: string[] = [];
			await main([FULL_FLAG], {
				root: dir,
				out: sink(),
				err: { write: (s: string) => errChunks.push(s) },
				fs: fakeFs(),
				spawnFn: () => fakeChild({ code: 0 }),
			});
			const text = errChunks.join("");
			for (const cause of FULL_CAUSES) expect(text).toContain(cause);
		});

		it("carries the diff the selection was computed from to the child, and nothing on a full run (#189)", async () => {
			const envOf = async (argv: string[], expand?: unknown) => {
				let env: Record<string, string> = {};
				await main(argv, {
					root: repoWithDeps(),
					out: sink(),
					err: sink(),
					fs: fakeFs(),
					...(expand ? { expand } : {}),
					spawnFn: (
						_bin: string,
						_a: string[],
						opts: { env: Record<string, string> },
					) => {
						env = opts.env;
						return fakeChild({ code: 0 });
					},
				});
				return env;
			};
			const fullEnv = await envOf([`${FULL_FLAG}=coverage`]);
			expect(readLaunch(fullEnv).changedPaths).toBeNull();
			expect(readLaunch(fullEnv).base).toBeNull();
			const narrowed = await envOf(["--changed", "HEAD"], () => ({
				argv: ["--passWithNoTests", "a.test.ts"],
				files: ["a.test.ts"],
				own: ["a.test.ts"],
				added: [],
				admissible: true,
				narrowed: false,
				changed: ["scripts/a.js", "docs/x.md"],
				base: "b".repeat(40),
				banner: "",
			}));
			expect(readLaunch(narrowed).changedPaths).toEqual([
				"scripts/a.js",
				"docs/x.md",
			]);
			expect(readLaunch(narrowed).base).toBe("b".repeat(40));
		});

		it("accepts each of the six causes and carries it to the child's env (#182)", async () => {
			const { FULL_CAUSES } = require("./lib/test-pass-marker.js");
			for (const cause of FULL_CAUSES) {
				const dir = repoWithDeps();
				let env: Record<string, string> = {};
				await main([`${FULL_FLAG}=${cause}`], {
					root: dir,
					out: sink(),
					err: sink(),
					fs: fakeFs(),
					spawnFn: (
						_bin: string,
						_a: string[],
						opts: { env: Record<string, string> },
					) => {
						env = opts.env;
						return fakeChild({ code: 0 });
					},
				});
				expect(readLaunch(env).fullCause).toBe(cause);
			}
		});

		it("leaves a countable record of a refused launch, naming the refused word and why, rooted at the run's own tree (#182)", async () => {
			const { readMarkers, FAIL_STORE } = require("./lib/test-pass-marker.js");
			const dir = repoWithDeps();
			await main([`${FULL_FLAG}=bogus`], {
				root: dir,
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: () => fakeChild({ code: 0 }),
			});
			const markers = readMarkers({ root: dir, store: FAIL_STORE });
			const refusal = markers.find((m: { refused?: boolean }) => m.refused);
			expect(refusal).toMatchObject({
				refused: true,
				refusedWhy: "full-cause",
				refusedWord: `${FULL_FLAG}=bogus`,
			});
		});
	});

	describe("the frozen worktree and the --shared escape, through `main` (mantahostels#2278)", () => {
		it("runs a bare run's escalation to the whole suite in the frozen worktree (mantahostels#3208)", async () => {
			const dir = repoWithDeps();
			let cwd = "";
			await main([], {
				root: dir,
				pid: 4271,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
					cwd = opts.cwd;
					return fakeChild({ code: 0 });
				},
			});
			expect(cwd).toBe(worktreeOf(dir, 4271));
		});

		it("--shared escapes the frozen worktree back to the shared tree", async () => {
			const dir = repoWithDeps();
			let cwd = "";
			await main([SHARED_FLAG], {
				root: dir,
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
					cwd = opts.cwd;
					return fakeChild({ code: 0 });
				},
			});
			expect(cwd).toBe(dir);
		});

		it("--shared wins even against an explicit --isolated, where the run executes", async () => {
			const dir = repoWithDeps();
			let cwd = "";
			await main([isolatedFlag, SHARED_FLAG], {
				root: dir,
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
					cwd = opts.cwd;
					return fakeChild({ code: 0 });
				},
			});
			expect(cwd).toBe(dir);
		});

		it("--isolated runs a narrowed run in the frozen worktree", async () => {
			const dir = repoWithDeps();
			let cwd = "";
			await main([isolatedFlag, "-t", "corpus"], {
				root: dir,
				pid: 4272,
				ledger: ledgerOf([]),
				out: sink(),
				err: sink(),
				fs: fakeFs(),
				spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
					cwd = opts.cwd;
					return fakeChild({ code: 0 });
				},
			});
			expect(cwd).toBe(worktreeOf(dir, 4272));
		});
	});

	describe("the default flip: bare argv narrows to the diff, escalating where that's worthless (mantahostels#3208)", () => {
		const {
			readDefaultChangedBase,
			findDefaultEscalationReason,
		} = require("./lib/changed-selection.js");

		describe("`readDefaultChangedBase`", () => {
			it("falls back to HEAD where origin/main does not exist", () => {
				expect(
					readDefaultChangedBase(repo(), fakeExec({ hasOrigin: false })),
				).toBe("HEAD");
			});

			it("resolves the merge-base where origin/main exists", () => {
				expect(
					readDefaultChangedBase(
						repo(),
						fakeExec({ hasOrigin: true, mergeBase: "abc123" }),
					),
				).toBe("abc123");
			});

			it("takes the merge-base with origin/landing where the landing module is on (#2408)", () => {
				vi.stubEnv("WFC_MODULES", "landing");
				const read: string[][] = [];
				const execFn = (_file: string, args: string[]) => {
					read.push(args);
					return args[0] === "merge-base" ? "landing-base\n" : "tip\n";
				};
				expect(readDefaultChangedBase(repo(), execFn)).toBe("landing-base");
				expect(read).toEqual([
					["rev-parse", "--verify", "--quiet", "origin/landing"],
					["merge-base", "HEAD", "origin/landing"],
				]);
			});

			it("falls back to HEAD where the merge-base itself cannot be resolved", () => {
				const execFn = (file: string, args: string[], opts: unknown) => {
					if (args[0] === "rev-parse" && args.includes("origin/main"))
						return "origin-sha\n";
					if (args[0] === "merge-base") throw new Error("no common ancestor");
					return require("node:child_process").execFileSync(file, args, opts);
				};
				expect(readDefaultChangedBase(repo(), execFn)).toBe("HEAD");
			});
		});

		describe("`findDefaultEscalationReason`", () => {
			it("is null where the read graph renders and the diff narrows cleanly", () => {
				expect(
					findDefaultEscalationReason(repo(), "HEAD", {
						execFn: fakeExec({ diff: ["a.test.ts"] }),
						loadEdges: () => ({}),
						renderEdges: () => ({}),
					}),
				).toBe(null);
			});

			it("is stale-manifest where the read graph will not render (#998)", () => {
				expect(
					findDefaultEscalationReason(repo(), "HEAD", {
						execFn: fakeExec({ diff: ["a.test.ts"] }),
						renderEdges: renderFails,
					}),
				).toBe("stale-manifest");
			});

			it("is stale-manifest where the committed manifest cannot be read", () => {
				expect(
					findDefaultEscalationReason(repo(), "HEAD", {
						execFn: fakeExec({ diff: ["a.test.ts"] }),
						renderEdges: () => ({}),
					}),
				).toBe("stale-manifest");
			});

			it("is dependency-root where package.json changed outside the allow-list", () => {
				expect(
					findDefaultEscalationReason(repo(), "HEAD", {
						// `packageJsonNarrowable` cannot classify the diff without a
						// readable old side, so a failing `git show` is unnarrowable —
						// exactly like a real dependencies/devDependencies bump.
						execFn: fakeExec({ diff: ["package.json"] }),
						loadEdges: () => ({}),
						renderEdges: () => ({}),
					}),
				).toBe("dependency-root");
			});

			it("throws the diff's own error where the diff itself cannot be read (#2698)", () => {
				expect(() =>
					findDefaultEscalationReason(repo(), "HEAD", {
						execFn: fakeExec({ failDiff: true }),
						loadEdges: () => ({}),
						renderEdges: () => ({}),
					}),
				).toThrow("git diff failed");
			});
		});

		describe("through `main`, on the shared tree", () => {
			it("hands vitest the read-graph selection and marks it admissible", async () => {
				const dir = repo();
				let args: string[] = [];
				let env: Record<string, string> = {};
				const code = await main([], {
					root: dir,
					execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out: { write: () => true },
					err: { write: () => true },
					spawnFn: (
						_bin: string,
						a: string[],
						opts: { env: Record<string, string> },
					) => {
						args = a;
						env = opts.env;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(args).toContain("a.test.ts");
				expect(readLaunch(env).admissible).toBe(true);
				expect(readLaunch(env).full).toBeNull();
			});

			it("renders the read graph once for the escalation check and the selection", async () => {
				let renders = 0;
				await main([], {
					root: repo(),
					execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
					loadEdges: () => ({}),
					renderEdges: () => {
						renders += 1;
						return {};
					},
					out: { write: () => true },
					err: { write: () => true },
					spawnFn: () => fakeChild({ code: 0 }),
				});
				expect(renders).toBe(1);
			});

			it("runs on a filter matching nothing, for the certificate, and names no --full where the diff selects no test (#189 §6)", async () => {
				const dir = repo();
				let args: string[] = [];
				const out = {
					text: [] as string[],
					write: (s: string) => out.text.push(s),
				};
				const code = await main([], {
					root: dir,
					execFn: fakeExec({ diff: [], list: [] }),
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out,
					err: { write: () => true },
					spawnFn: (_bin: string, a: string[]) => {
						args = a;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(args).toContain(EMPTY_SELECTION_FILTER);
				expect(args).toContain("--passWithNoTests");
				expect(out.text.join("")).not.toContain("--full");
				expect(out.text.join("")).toContain("MEETS THE PUSH GATE");
			});

			it("selects from the range to origin/main on a clean tree with commits past it", async () => {
				const dir = repo();
				let args: string[] = [];
				let diffArgs: string[] = [];
				const execFn = execAnswering({
					"origin/main": () => "old-sha\n",
					"merge-base": () => "old-sha\n",
					diff: (a) => {
						diffArgs = a;
						return "b.test.ts\n";
					},
					list: () => "b.test.ts\n",
				});
				const code = await main([], {
					root: dir,
					execFn,
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out: { write: () => true },
					err: { write: () => true },
					spawnFn: (_bin: string, a: string[]) => {
						args = a;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(args).toContain("b.test.ts");
				expect(diffArgs).toContain("old-sha");
			});

			for (const [reason, exec] of [
				["stale-manifest", () => fakeExec({ diff: ["a.test.ts"] })],
				["dependency-root", () => fakeExec({ diff: ["package.json"] })],
			] as const) {
				it(`escalates to the whole suite on ${reason}, isolated`, async () => {
					const dir = repoWithDeps();
					let cwd = "";
					let env: Record<string, string> = {};
					const out = {
						text: [] as string[],
						write: (s: string) => out.text.push(s),
					};
					const code = await main([], {
						root: dir,
						pid: 5301 + reason.length,
						ledger: ledgerOf([]),
						execFn: exec(),
						loadEdges: () => ({}),
						renderEdges: reason === "stale-manifest" ? renderFails : () => ({}),
						out,
						err: sink(),
						fs: fakeFs(),
						spawnFn: (
							_bin: string,
							_a: string[],
							opts: { cwd: string; env: Record<string, string> },
						) => {
							cwd = opts.cwd;
							env = opts.env;
							return fakeChild({ code: 0 });
						},
					});
					expect(code).toBe(0);
					expect(cwd).toBe(worktreeOf(dir, 5301 + reason.length));
					expect(readLaunch(env).full).toBe(reason);
					expect(out.text.join("")).toContain(reason);
					expect(out.text.join("")).toContain("--changed");
				});
			}

			it("--shared keeps an escalation on the shared tree", async () => {
				const dir = repo();
				let cwd = "";
				const code = await main([SHARED_FLAG], {
					root: dir,
					execFn: fakeExec({ diff: ["a.test.ts"] }),
					loadEdges: () => ({}),
					renderEdges: renderFails,
					out: { write: () => true },
					err: { write: () => true },
					spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
						cwd = opts.cwd;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(cwd).toBe(dir);
			});

			/* Admitted beside a held slot on its narrowed probe, a run whose plan
			 * then takes the whole slot must not run there (#2931); one whose
			 * whole suite stays under the bound runs straight through. */
			it.each([
				["re-queues whole", wholeRepo, 2, true],
				["runs at once", repo, 1, false],
			] as const)(
				"%s a queued part-suite whose admitted run escalates (#2931)",
				async (_what, make, joins, wholeSlot) => {
					let renders = 0;
					const joined = vi.fn();
					const gateRead = vi.fn((_command: string, _weight: unknown) => null);
					const spawned: Record<string, string>[] = [];
					const err: string[] = [];
					const code = await main(["--queue", SHARED_FLAG], {
						root: make(),
						execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
						loadEdges: () => ({}),
						renderEdges: () => (renders++ === 0 ? {} : renderFails()),
						out: { write: () => true },
						err: { write: (s: string) => err.push(s) },
						fs: fakeFs(),
						queueDir: qdir(),
						queueFs: { ...fs, writeFileSync: joined },
						gateRead,
						spawnFn: (
							_bin: string,
							_a: string[],
							opts: { env: Record<string, string> },
						) => {
							spawned.push(opts.env);
							return fakeChild({ code: 0 });
						},
					});
					expect(code).toBe(0);
					expect(joined).toHaveBeenCalledTimes(joins);
					expect(spawned).toHaveLength(1);
					expect(gateRead.mock.calls.at(0)?.[1]).toMatchObject({
						wholeSlot: false,
					});
					expect(gateRead.mock.calls.at(-1)?.[1]).toMatchObject({
						wholeSlot,
					});
					expect(err.join("").includes("joining the queue again, whole")).toBe(
						wholeSlot,
					);
					expect(readLaunch(spawned[0])).toMatchObject({
						full: "stale-manifest",
						wholeSlot,
					});
				},
			);

			/* Node closes an unspawnable child with the negative errno, -2 for
			 * ENOENT, the value REQUEUE_WHOLE also holds (#3140). Admitted as a
			 * part-suite, or already re-queued whole by an escalation, it exits
			 * at its first spawn. */
			it.each([
				["admitted as a part-suite", repo, 1],
				["re-queued whole", wholeRepo, 2],
			] as const)(
				"exits 1 at its first spawn, naming the binary, where a queued run %s cannot spawn vitest (#3140)",
				async (_what, make, joins) => {
					let renders = 0;
					const joined = vi.fn();
					let spawns = 0;
					const err = sink();
					const code = await main(["--queue", SHARED_FLAG], {
						root: make(),
						execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
						loadEdges: () => ({}),
						renderEdges: () => (renders++ === 0 ? {} : renderFails()),
						out: { write: () => true },
						err,
						fs: fakeFs(),
						queueDir: qdir(),
						queueFs: { ...fs, writeFileSync: joined },
						gateRead: () => null,
						/* A second spawn is the re-admission; it succeeds so a
						 * regression fails here rather than loop. */
						spawnFn: (bin: string) =>
							spawns++ > 0
								? fakeChild({ code: 0 })
								: fakeChild({
										error: new Error(`spawn ${bin} ENOENT`),
										code: -2,
									}),
					});
					const said = err.text.join("");
					expect(code).toBe(1);
					expect(spawns).toBe(1);
					expect(joined).toHaveBeenCalledTimes(joins);
					expect(said).toMatch(
						/vitest could not be run from \S*vitest: Error: spawn \S*vitest ENOENT/,
					);
				},
			);

			/* `runOnce` weighs the plan in hand on every tree (#2931). */
			it("re-queues whole a queued part-suite whose admitted run escalates into a worktree (#2931)", async () => {
				const dir = wholeRepo(repoWithDeps());
				let renders = 0;
				const joined = vi.fn();
				const gateRead = vi.fn((_command: string, _weight: unknown) => null);
				const spawned: { cwd: string; env: Record<string, string> }[] = [];
				const err = sink();
				const code = await main(["--queue"], {
					root: dir,
					pid: 5331,
					ledger: ledgerOf([]),
					execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
					loadEdges: () => ({}),
					renderEdges: () => (renders++ === 0 ? {} : renderFails()),
					out: sink(),
					err,
					fs: fakeFs(),
					queueDir: qdir(),
					queueFs: { ...fs, writeFileSync: joined },
					gateRead,
					spawnFn: (
						_bin: string,
						_a: string[],
						opts: { cwd: string; env: Record<string, string> },
					) => {
						spawned.push(opts);
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(joined).toHaveBeenCalledTimes(2);
				expect(gateRead.mock.calls.at(0)?.[1]).toMatchObject({
					wholeSlot: false,
				});
				expect(gateRead.mock.calls.at(-1)?.[1]).toMatchObject({
					wholeSlot: true,
				});
				expect(err.text.join("")).toContain("joining the queue again, whole");
				expect(spawned).toHaveLength(1);
				expect(spawned[0]?.cwd).toBe(worktreeOf(dir, 5331));
				expect(readLaunch(spawned[0]?.env ?? {})).toMatchObject({
					full: "stale-manifest",
					wholeSlot: true,
				});
			});

			/* Left early, it holds no slot, so its escalation queues again rather
			 * than run whole (#1158, #2931). */
			it("queues again a run that left the queue early and then escalates, whole at the last (#2931)", async () => {
				const w = leavingWorld();
				let renders = 0;
				let polls = 0;
				const joined = vi.fn();
				const spawned: Record<string, string>[] = [];
				const err = sink();
				const code = await main(["--queue", SHARED_FLAG], {
					root: wholeRepo(),
					execFn: w.fn,
					loadEdges: () => ({}),
					/* The probe's and the re-check's render; the run's fails. */
					renderEdges: () => (renders++ < 2 ? {} : renderFails()),
					out: sink(),
					err,
					fs: fakeFs(),
					queueDir: qdir(),
					queueFs: { ...fs, writeFileSync: joined },
					gate: () => polls < 2,
					sleepFn: () => {
						polls += 1;
						w.move();
						return Promise.resolve();
					},
					spawnFn: (
						_bin: string,
						_a: string[],
						opts: { env: Record<string, string> },
					) => {
						spawned.push(opts.env);
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(joined).toHaveBeenCalledTimes(3);
				expect(err.text.join("")).toContain(
					"a commit refilled the selection after the re-check",
				);
				expect(err.text.join("")).toContain("joining the queue again, whole");
				expect(spawned).toHaveLength(1);
				expect(readLaunch(spawned[0] ?? {})).toMatchObject({
					full: "stale-manifest",
					wholeSlot: true,
				});
			});

			it("--isolated on the narrowed default is allowed, framed by a named ref rather than a bare --changed", async () => {
				const dir = repoWithDeps();
				let cwd = "";
				const code = await main([isolatedFlag], {
					root: dir,
					pid: 5321,
					ledger: ledgerOf([]),
					execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out: sink(),
					err: sink(),
					fs: fakeFs(),
					spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
						cwd = opts.cwd;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(cwd).toBe(worktreeOf(dir, 5321));
			});

			it("--isolated on the narrowed default probes the worktree, not the shared tree, preserving mantahostels#2169 (mantahostels#3251)", async () => {
				// The plan `runDefault` computes to decide escalate-or-not on
				// this path is necessarily against the shared root — the
				// worktree does not exist yet — so it must be discarded on
				// success, and the real selection recomputed once
				// `runIsolated` has resolved `root` to the frozen worktree.
				const dir = repoWithDeps();
				const listCwds: string[] = [];
				const diffCwds: string[] = [];
				const execFn = execAnswering({
					"origin/main": () => {
						throw new Error("unknown revision or path");
					},
					diff: (_args, opts) => {
						diffCwds.push(opts.cwd);
						return "a.test.ts\n";
					},
					list: (_args, opts) => {
						listCwds.push(opts.cwd);
						return "a.test.ts\n";
					},
				});
				let cwd = "";
				const code = await main([isolatedFlag], {
					root: dir,
					pid: 6002,
					ledger: ledgerOf([]),
					execFn,
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out: sink(),
					err: sink(),
					fs: fakeFs(),
					spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
						cwd = opts.cwd;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				const worktree = worktreeOf(dir, 6002);
				expect(cwd).toBe(worktree);
				// The decision probe runs against the shared root (git diff
				// against HEAD; runDefault's own `readDefaultChangedBase` call
				// also lands here) — the LAST diff/list call is the one that
				// actually selects the run's file list, and that one must be
				// against the worktree.
				expect(listCwds.at(-1)).toBe(worktree);
				expect(diffCwds.at(-1)).toBe(worktree);
			});

			it("an explicit --changed is untouched: no escalation banner, today's fail-open NOT ADMISSIBLE stands", async () => {
				const dir = repo();
				const out = {
					text: [] as string[],
					write: (s: string) => out.text.push(s),
				};
				const code = await main(["--changed"], {
					root: dir,
					execFn: fakeExec({ diff: ["a.test.ts"], list: ["a.test.ts"] }),
					loadEdges: () => ({}),
					renderEdges: renderFails,
					out,
					err: { write: () => true },
					spawnFn: () => fakeChild({ code: 0 }),
				});
				expect(code).toBe(0);
				expect(out.text.join("")).not.toContain("ESCALATED");
				expect(out.text.join("")).toContain("NOT ADMISSIBLE");
			});
		});

		describe("a failed narrowing is refused, never widened (#2698)", () => {
			const listThrowing = (error: Error) =>
				execAnswering({
					"origin/main": () => {
						throw new Error("unknown revision or path");
					},
					diff: () => "a.test.ts\n",
					list: () => {
						throw error;
					},
				});
			const timeout = Object.assign(new Error("spawnSync vitest ETIMEDOUT"), {
				code: "ETIMEDOUT",
			});
			const failures = [
				[
					"a failing diff",
					() => fakeExec({ failDiff: true }),
					"git diff failed",
				],
				[
					"a failing `vitest list`",
					() => fakeExec({ diff: ["a.test.ts"], failList: true }),
					"vitest list failed",
				],
				[
					"a `vitest list` timeout",
					() => listThrowing(timeout),
					"vitest list timed out after 120 s",
				],
				[
					"a thrown exception",
					() =>
						listThrowing(new TypeError("cannot read properties of undefined")),
					"cannot read properties of undefined",
				],
			] as const;
			const routes = [
				["shared", [SHARED_FLAG]],
				["isolated", [isolatedFlag]],
				["the queue", ["--queue", SHARED_FLAG]],
			] as const;

			/* The failure is met before the route matters, so each failure is
			 * driven once and each route with one failure. */
			const cases = [
				...failures.map((f) => [routes[0], f] as const),
				...routes.slice(1).map((r) => [r, failures[0]] as const),
			];
			for (const [[route, argv], [failure, exec, cause]] of cases)
				it(`refuses ${failure} on the ${route} route: its cause and the --full= line, nothing spawned, exit 1`, async () => {
					const dir = repoWithDeps();
					const queueDir = qdir();
					const out = sink();
					const err = sink();
					let spawned = 0;
					const code = await main([...argv], {
						root: dir,
						pid: 6101,
						ledger: ledgerOf([]),
						execFn: exec(),
						loadEdges: () => ({}),
						renderEdges: () => ({}),
						out,
						err,
						fs: fakeFs(),
						queueDir,
						queueLog: path.join(queueDir, "exits.jsonl"),
						spawnFn: () => {
							spawned += 1;
							return fakeChild({ code: 0 });
						},
					});
					expect(code).toBe(1);
					expect(spawned).toBe(0);
					const said = err.text.join("");
					expect(said).toContain("NARROWING FAILED, SO NOTHING RAN");
					expect(said).toContain(cause);
					expect(said).toContain("npm run test -- --full=<cause>");
					expect(out.text.join("")).not.toContain("ESCALATED");
					expect(
						fs
							.readdirSync(queueDir)
							.filter((f) => f.startsWith("wfc-suite-queue-")),
					).toEqual([]);
				});

			it("refuses on the queue's re-check, ending the wait and leaving the queue", async () => {
				const queueDir = qdir();
				let tip = 0;
				let lists = 0;
				const execFn = execAnswering({
					"origin/main": () => {
						throw new Error("unknown revision or path");
					},
					"rev-parse": () => `tip-${tip++}\n`,
					diff: () => "docs/x.md\n",
					list: () => {
						lists += 1;
						if (lists > 1) throw new Error("vitest list failed");
						return "a.test.ts\n";
					},
				});
				const err = sink();
				let spawned = 0;
				const code = await main(["--queue", SHARED_FLAG], {
					root: repo(),
					execFn,
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out: sink(),
					err,
					fs: fakeFs(),
					queueDir,
					queueLog: path.join(queueDir, "exits.jsonl"),
					gate: () => ({ limb: "count" }),
					sleepFn: () => Promise.resolve(),
					spawnFn: () => {
						spawned += 1;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(1);
				expect(spawned).toBe(0);
				expect(lists).toBeGreaterThan(1);
				expect(err.text.join("")).toContain("vitest list failed");
				expect(err.text.join("")).toContain("--full=<cause>");
				expect(
					fs
						.readdirSync(queueDir)
						.filter((f) => f.startsWith("wfc-suite-queue-")),
				).toEqual([]);
			});

			it("refuses an explicit --changed <ref> whose expansion fails, the same way", async () => {
				const err = sink();
				let spawned = 0;
				const code = await main(["--changed", "HEAD", SHARED_FLAG], {
					root: repo(),
					execFn: fakeExec({ failDiff: true }),
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out: sink(),
					err,
					spawnFn: () => {
						spawned += 1;
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(1);
				expect(spawned).toBe(0);
				expect(err.text.join("")).toContain(
					"--changed could not be expanded: git diff failed",
				);
				expect(err.text.join("")).toContain("--full=<cause>");
			});
		});

		describe("with a session id, in a worktree at HEAD carrying only the session's own files (#812)", () => {
			const { endOfRunTreeIdentity } = require("./lib/tree-drift.js");
			const { overlayFiles } = require("./lib/isolated-worktree.js");

			const headText = "committed\n";
			const sharedLinks = new Set(["node_modules", ".husky/_"]);

			/**
			 * A checkout dirty in every way a shared tree is: the session's own
			 * edit, deletion and new file; a file it once wrote that a live
			 * neighbour now holds; and an orphan nobody's ledger names.
			 */
			function dirtyCheckout() {
				const dir = repoWithDeps();
				const files = ["mine.txt", "gone.txt", "held.txt", "orphan.txt"];
				for (const f of files) fs.writeFileSync(path.join(dir, f), headText);
				gitIn(dir, ["add", ...files]);
				gitIn(dir, ["commit", "-q", "-m", "four files"]);
				fs.writeFileSync(path.join(dir, "mine.txt"), "mine\n");
				fs.rmSync(path.join(dir, "gone.txt"));
				fs.writeFileSync(path.join(dir, "brand-new.test.ts"), "//\n");
				fs.writeFileSync(path.join(dir, "held.txt"), "neighbour\n");
				fs.writeFileSync(path.join(dir, "orphan.txt"), "orphan\n");
				return dir;
			}

			const ledger = () =>
				ledgerOf(
					["mine.txt", "gone.txt", "brand-new.test.ts", "held.txt"],
					[
						{
							sessionId: "neighbour",
							path: "held.txt",
							pid: process.pid,
							procStart: arbiterProc.readProcStartOf(process.pid),
							bootId: arbiterProc.readCurrentBootId(),
						},
					],
				);

			/** Real git throughout, bar a missing origin and vitest's listing. */
			const execFn = (file: string, args: string[], opts: unknown) => {
				if (args[0] === "rev-parse" && args.includes("origin/main"))
					throw new Error("unknown revision or path");
				if (args[0] === "list") return "brand-new.test.ts\n";
				return require("node:child_process").execFileSync(file, args, opts);
			};

			/** What the spawned run could read, captured while its tree exists. */
			async function runSeeing(
				dir: string,
				argv: string[],
				extra: Record<string, unknown> = {},
			) {
				const seen = {
					cwd: "",
					env: {} as Record<string, string>,
					status: [] as string[],
					read: (() => null) as (f: string) => string | null,
					tree: null as string | null,
				};
				const out = sink();
				const err = sink();
				const code = await main(argv, {
					root: dir,
					ledger: ledger(),
					execFn,
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out,
					err,
					fs: fakeFs(),
					spawnFn: (
						_bin: string,
						_a: string[],
						opts: { cwd: string; env: Record<string, string> },
					) => {
						seen.cwd = opts.cwd;
						seen.env = opts.env;
						seen.status = gitIn(opts.cwd, ["status", "--porcelain", "-uall"])
							.split("\n")
							.filter(Boolean)
							.map((line) => line.slice(3))
							// The fixture leaves the linked-in artefacts unignored.
							.filter((p) => !sharedLinks.has(p))
							.sort();
						const contents = new Map(
							["mine.txt", "gone.txt", "held.txt", "orphan.txt"].map((f) => {
								const p = path.join(opts.cwd, f);
								return [
									f,
									fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null,
								];
							}),
						);
						seen.read = (f) => contents.get(f) ?? null;
						seen.tree = endOfRunTreeIdentity(opts.cwd);
						return fakeChild({ code: 0 });
					},
					...extra,
				});
				return { code, seen, out: out.text.join(""), err: err.text.join("") };
			}

			it("carries exactly the ledger-attributed files, and neither a neighbour's nor an orphan", async () => {
				const dir = dirtyCheckout();
				const { code, seen, err } = await runSeeing(dir, [], {
					pid: 5401,
					sessionId: "mine",
				});
				expect(code).toBe(0);
				expect(seen.cwd).toBe(worktreeOf(dir, 5401));
				expect(seen.status).toEqual([
					"brand-new.test.ts",
					"gone.txt",
					"mine.txt",
				]);
				expect(seen.read("mine.txt")).toBe("mine\n");
				expect(seen.read("gone.txt")).toBe(null);
				expect(seen.read("held.txt")).toBe(headText);
				expect(seen.read("orphan.txt")).toBe(headText);
				expect(err).toContain("2 uncommitted tracked file(s) not attributable");
				expect(fs.readFileSync(path.join(dir, "held.txt"), "utf8")).toBe(
					"neighbour\n",
				);
			});

			it("refuses a failed narrowing on the overlay route, spawning nothing and leaving no worktree (#2698)", async () => {
				const dir = dirtyCheckout();
				const { code, seen, err } = await runSeeing(dir, [], {
					pid: 5402,
					sessionId: "mine",
					execFn: (file: string, args: string[], opts: unknown) => {
						if (args[0] === "list") throw new Error("vitest list failed");
						return execFn(file, args, opts);
					},
				});
				expect(code).toBe(1);
				expect(seen.cwd).toBe("");
				expect(err).toContain("NARROWING FAILED, SO NOTHING RAN");
				expect(err).toContain("vitest list failed");
				expect(err).toContain("--full=<cause>");
				expect(fs.existsSync(worktreeOf(dir, 5402))).toBe(false);
			});

			/* Most runs take this route, so the report must diff the overlay,
			 * where the session's new test file is untracked (#1883). */
			it("names the session's new test file in the run-cost report", async () => {
				vi.stubEnv("CI", "");
				const { TIMINGS_ENV } = require("./lib/test-file-timings.js");
				const dir = dirtyCheckout();
				const out = sink();
				const code = await main([], {
					root: dir,
					pid: 5410,
					sessionId: "mine",
					ledger: ledger(),
					execFn,
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out,
					err: sink(),
					fs: fakeFs(),
					spawnFn: (
						_bin: string,
						_a: string[],
						opts: { cwd: string; env: Record<string, string> },
					) => {
						fs.writeFileSync(
							opts.env[TIMINGS_ENV],
							JSON.stringify({
								[path.join(opts.cwd, "brand-new.test.ts")]: 12,
							}),
						);
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(out.text.join("")).toMatch(
					/RUN COST: brand-new\.test\.ts took 12\.0 s.*new since/,
				);
			});

			it("leaves out a file the session renamed with git mv and then edited, or deleted with rm, but not a neighbour's deletion (#1791)", async () => {
				const dir = dirtyCheckout();
				const added = ["old.test.ts", "rm-gone.txt", "theirs-gone.txt"];
				for (const f of added) fs.writeFileSync(path.join(dir, f), headText);
				gitIn(dir, ["add", ...added]);
				gitIn(dir, ["commit", "-q", "-m", "three more"]);
				gitIn(dir, ["mv", "old.test.ts", "new.test.ts"]);
				fs.writeFileSync(path.join(dir, "new.test.ts"), "edited\n");
				fs.rmSync(path.join(dir, "rm-gone.txt"));
				fs.rmSync(path.join(dir, "theirs-gone.txt"));
				const present: Record<string, boolean> = {};
				const code = await main([], {
					root: dir,
					pid: 5409,
					sessionId: "mine",
					// `rm-gone.txt` as lib/claimed-bash-write.js notes an `rm`.
					ledger: {
						...ledgerOf(["new.test.ts"]),
						readSelectsBy: () => [
							{ path: "rm-gone.txt", at: Date.now() + 1000 },
						],
					},
					execFn,
					loadEdges: () => ({}),
					renderEdges: () => ({}),
					out: sink(),
					err: sink(),
					fs: fakeFs(),
					spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
						for (const f of ["new.test.ts", ...added])
							present[f] = fs.existsSync(path.join(opts.cwd, f));
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(present).toEqual({
					"old.test.ts": false,
					"new.test.ts": true,
					"rm-gone.txt": false,
					"theirs-gone.txt": true,
				});
			});

			it("records HEAD plus the session's own files, a new one included, as the tree it read", async () => {
				const dir = dirtyCheckout();
				const { seen } = await runSeeing(dir, [], {
					pid: 5402,
					sessionId: "mine",
				});
				expect(seen.tree).not.toBe(null);
				const differs = gitIn(dir, [
					"diff-tree",
					"-r",
					"--name-only",
					"HEAD^{tree}",
					seen.tree as string,
				])
					.split("\n")
					.filter(Boolean);
				expect(differs).toEqual(["brand-new.test.ts", "gone.txt", "mine.txt"]);
				expect(gitIn(dir, ["cat-file", "-p", `${seen.tree}:mine.txt`])).toBe(
					"mine\n",
				);
			});

			it("judges the narrowing inside the worktree, so a neighbour's dirty package.json escalates nothing", async () => {
				const dir = dirtyCheckout();
				const pkg = path.join(dir, "package.json");
				fs.writeFileSync(pkg, '{ "name": "x" }\n');
				gitIn(dir, ["add", "package.json"]);
				gitIn(dir, ["commit", "-q", "-m", "package"]);
				fs.writeFileSync(
					pkg,
					'{ "name": "x", "dependencies": { "left-pad": "1" } }\n',
				);
				const overlaid = await runSeeing(dir, [], {
					pid: 5403,
					sessionId: "mine",
				});
				expect(overlaid.out).not.toContain("ESCALATED");
				expect(readLaunch(overlaid.seen.env).full).toBeNull();
				// The same tree, read shared, does escalate — the case this guards.
				const shared = await runSeeing(dir, [SHARED_FLAG], {
					sessionId: "mine",
				});
				expect(readLaunch(shared.seen.env).full).toBe("dependency-root");
			});

			it("still refuses a full isolated run over the session's own uncommitted files, naming the one it modified", async () => {
				const dir = dirtyCheckout();
				const { code, seen, err } = await runSeeing(
					dir,
					[`${FULL_FLAG}=coverage`],
					{ pid: 5406, sessionId: "mine" },
				);
				expect(code).toBe(1);
				expect(seen.cwd).toBe("");
				expect(err).toContain("REFUSED");
				expect(err).toContain("mine.txt");
			});

			it("tears its worktree down on green and red, and sweeps a dead run's leftover", async () => {
				for (const code of [0, 1]) {
					const dir = dirtyCheckout();
					const leftover = createIsolated(dir, { pid: 5407 });
					expect(leftover.error).toBe(null);
					const exit = await main([], {
						root: dir,
						pid: 5408,
						sessionId: "mine",
						ledger: ledger(),
						alive: () => false,
						execFn,
						loadEdges: () => ({}),
						renderEdges: () => ({}),
						out: sink(),
						err: sink(),
						fs: fakeFs(),
						spawnFn: () => fakeChild({ code }),
					});
					expect(exit).toBe(code);
					expect(fs.existsSync(worktreeOf(dir, 5407))).toBe(false);
					expect(fs.existsSync(worktreeOf(dir, 5408))).toBe(false);
					const listed = gitIn(dir, ["worktree", "list"]);
					expect(listed).not.toContain(worktreeOf(dir, 5407));
					expect(listed).not.toContain(worktreeOf(dir, 5408));
				}
			});

			it("falls back to the shared tree, saying so, where the worktree cannot be built", async () => {
				const dir = dirtyCheckout();
				const { seen, err } = await runSeeing(dir, [], {
					pid: 5409,
					sessionId: "mine",
					worktreeFs: {
						...fs,
						symlinkSync: () => {
							throw new Error("EPERM");
						},
					},
				});
				expect(seen.cwd).toBe(dir);
				expect(err).toContain("reading the shared tree instead");
				expect(fs.existsSync(worktreeOf(dir, 5409))).toBe(false);
			});

			it("names the frozen worktree as its fallback under a typed --isolated, and takes it", async () => {
				const dir = dirtyCheckout();
				const { code, seen, err } = await runSeeing(dir, ["--isolated"], {
					pid: 5418,
					sessionId: "mine",
					worktreeFs: {
						...fs,
						symlinkSync: () => {
							throw new Error("EPERM");
						},
					},
				});
				expect(err).toContain("narrowed default: could not link ");
				expect(err).toContain("running in a frozen worktree instead");
				expect(code).toBe(1);
				expect(seen.cwd).toBe("");
			});

			it("falls back to the shared tree, tearing the worktree down, where a file will not copy in", async () => {
				const dir = dirtyCheckout();
				const { seen, err } = await runSeeing(dir, [], {
					pid: 5410,
					sessionId: "mine",
					worktreeFs: {
						...fs,
						copyFileSync: () => {
							throw new Error("ENOSPC");
						},
					},
				});
				expect(seen.cwd).toBe(dir);
				expect(err).toContain("could not copy");
				expect(fs.existsSync(worktreeOf(dir, 5410))).toBe(false);
			});

			it("links no shared artefact the checkout lacks, so a walk over its tree does not throw (#822)", async () => {
				const dir = dirtyCheckout();
				fs.rmSync(path.join(dir, ".husky", "_"), { recursive: true });
				const seen = { husky: true, deps: false, walk: "" };
				const { code } = await runSeeing(dir, [], {
					pid: 5412,
					sessionId: "mine",
					spawnFn: (_bin: string, _a: string[], opts: { cwd: string }) => {
						// `lstat`, not `exists`: a dangling link must count as an entry.
						seen.husky =
							fs.lstatSync(path.join(opts.cwd, ".husky", "_"), {
								throwIfNoEntry: false,
							}) !== undefined;
						seen.deps = fs.existsSync(
							path.join(opts.cwd, "node_modules", ".bin", "vitest"),
						);
						try {
							for (const entry of fs.readdirSync(opts.cwd, {
								recursive: true,
							}))
								fs.statSync(path.join(opts.cwd, String(entry)));
						} catch (error) {
							seen.walk = String(error);
						}
						return fakeChild({ code: 0 });
					},
				});
				expect(code).toBe(0);
				expect(seen.husky).toBe(false);
				expect(seen.deps).toBe(true);
				expect(seen.walk).toBe("");
			});

			it("tears the overlay down before an escalation, whose full run still refuses over the session's own files", async () => {
				const dir = dirtyCheckout();
				const { code, seen, out, err } = await runSeeing(dir, [], {
					pid: 5411,
					sessionId: "mine",
					renderEdges: renderFails,
				});
				expect(out).toContain("ESCALATED");
				expect(code).toBe(1);
				expect(seen.cwd).toBe("");
				expect(err).toContain("REFUSED");
				expect(fs.existsSync(worktreeOf(dir, 5411))).toBe(false);
				expect(gitIn(dir, ["worktree", "list"])).not.toContain(
					worktreeOf(dir, 5411),
				);
			});

			it("copies a symlink in as a link, never its target", () => {
				const root = mkScratchDir("runvitest-overlay-");
				const dir = mkScratchDir("runvitest-overlay-wt-");
				dirs.push(root, dir);
				gitIn(dir, ["init", "-q"]);
				fs.symlinkSync("elsewhere.txt", path.join(root, "link.txt"));
				expect(overlayFiles(root, dir, ["link.txt"])).toBe(null);
				const copied = path.join(dir, "link.txt");
				expect(fs.lstatSync(copied).isSymbolicLink()).toBe(true);
				expect(fs.readlinkSync(copied)).toBe("elsewhere.txt");
			});

			describe("`npm run test:changed`, in the same overlay (#1217)", () => {
				const readers = () => ({
					"mine.txt": ["mine.test.ts"],
					"held.txt": ["held.test.ts"],
					"orphan.txt": ["orphan.test.ts"],
				});

				it("selects and reads only the session's own files, and stays admissible", async () => {
					const dir = dirtyCheckout();
					const { code, seen } = await runSeeing(dir, ["--changed"], {
						pid: 5413,
						sessionId: "mine",
						renderEdges: readers,
					});
					expect(code).toBe(0);
					expect(seen.cwd).toBe(worktreeOf(dir, 5413));
					expect(seen.read("held.txt")).toBe(headText);
					expect(seen.read("orphan.txt")).toBe(headText);
					expect(readLaunch(seen.env).changedPaths.sort()).toEqual([
						"brand-new.test.ts",
						"gone.txt",
						"mine.txt",
					]);
					expect(readLaunch(seen.env).admissible).toBe(true);
					expect(readLaunch(seen.env).viaChanged).toBe(true);
					expect(fs.existsSync(worktreeOf(dir, 5413))).toBe(false);
				});

				/* Probed on one reader, it reads the whole bound's worth in the
				 * overlay, where `runOnce` weighs it again (#2931). */
				it("re-queues whole a queued run whose overlay plan takes the whole slot (#2931)", async () => {
					const dir = wholeRepo(dirtyCheckout());
					const joined = vi.fn();
					const gateRead = vi
						.fn<(command: string, weight: unknown) => null>()
						.mockReturnValue(null);
					const { code, seen, err } = await runSeeing(
						dir,
						["--queue", "--changed"],
						{
							pid: 5420,
							sessionId: "mine",
							renderEdges: () =>
								joined.mock.calls.length === 0
									? readers()
									: { ...readers(), "mine.txt": WHOLE_SLOT_TESTS },
							queueDir: qdir(),
							queueFs: { ...fs, writeFileSync: joined },
							gateRead,
						},
					);
					expect(code).toBe(0);
					expect(joined).toHaveBeenCalledTimes(2);
					expect(gateRead.mock.calls.at(0)?.[1]).toMatchObject({
						wholeSlot: false,
					});
					expect(gateRead.mock.calls.at(-1)?.[1]).toMatchObject({
						wholeSlot: true,
					});
					expect(err).toContain("joining the queue again, whole");
					expect(seen.cwd).toBe(worktreeOf(dir, 5420));
					expect(readLaunch(seen.env)).toMatchObject({ wholeSlot: true });
				});

				it("brings a stale manifest up to date before planning, so the run selects its readers and its certificate attests it (#1860)", async () => {
					const { EDGES_FILE } = require("./lib/test-pass-marker.js");
					const dir = dirtyCheckout();
					fs.mkdirSync(path.join(dir, "docs"));
					fs.writeFileSync(path.join(dir, EDGES_FILE), "stale\n");
					gitIn(dir, ["add", EDGES_FILE]);
					gitIn(dir, ["commit", "-q", "-m", "stale manifest"]);
					const argv: string[][] = [];
					const claimed: string[] = [];
					let env: Record<string, string> = {};
					const { out } = await runSeeing(dir, ["--changed"], {
						pid: 5419,
						sessionId: "mine",
						renderEdges: () => ({
							...readers(),
							[EDGES_FILE]: ["manifest.test.ts"],
						}),
						claimFn: (file: string) => {
							claimed.push(file);
							return { ok: true };
						},
						spawnFn: (
							_bin: string,
							a: string[],
							opts: { env: Record<string, string> },
						) => {
							argv.push(a);
							env = opts.env;
							return fakeChild({ code: 0 });
						},
					});
					expect(out).toContain("brought up to date");
					expect(claimed).toEqual([path.join(dir, EDGES_FILE)]);
					expect(fs.readFileSync(path.join(dir, EDGES_FILE), "utf8")).toContain(
						'"manifest.test.ts"',
					);
					expect(readLaunch(env).changedPaths).toContain(EDGES_FILE);
					expect(argv[0]).toContain("manifest.test.ts");
				});

				it("hands vitest the own readers, and no neighbour's", async () => {
					const dir = dirtyCheckout();
					const argv: string[][] = [];
					await runSeeing(dir, ["--changed"], {
						pid: 5414,
						sessionId: "mine",
						renderEdges: readers,
						spawnFn: (_bin: string, a: string[]) => {
							argv.push(a);
							return fakeChild({ code: 0 });
						},
					});
					expect(argv).toHaveLength(1);
					expect(argv[0]).toContain("mine.test.ts");
					expect(argv[0]).not.toContain("held.test.ts");
					expect(argv[0]).not.toContain("orphan.test.ts");
				});

				it("keeps a typed --isolated's refusal of a bare --changed", async () => {
					const dir = dirtyCheckout();
					const { code, seen, err } = await runSeeing(
						dir,
						["--changed", "--isolated"],
						{ pid: 5417, sessionId: "mine" },
					);
					expect(code).toBe(1);
					expect(seen.cwd).toBe("");
					expect(err).toContain("--isolated REFUSED: a bare `--changed`");
				});

				it("falls back to the shared tree, saying so, where the worktree cannot be built", async () => {
					const dir = dirtyCheckout();
					const { seen, err } = await runSeeing(dir, ["--changed"], {
						pid: 5416,
						sessionId: "mine",
						worktreeFs: {
							...fs,
							symlinkSync: () => {
								throw new Error("EPERM");
							},
						},
					});
					expect(seen.cwd).toBe(dir);
					expect(err).toContain("test:changed: ");
					expect(err).toContain("reading the shared tree instead");
				});
			});

			describe("a file an inline python/node program quoted, as the session's own (#1220)", () => {
				const quoting = (at: number) => ({
					...ledger(),
					readSelectsBy: () => [{ path: "orphan.txt", at }],
				});

				it("carries a path quoted since its last commit into the overlay, naming it", async () => {
					const dir = dirtyCheckout();
					const { seen, out } = await runSeeing(dir, ["--changed"], {
						pid: 5418,
						sessionId: "mine",
						ledger: quoting(Date.now() + 60_000),
					});
					expect(seen.read("orphan.txt")).toBe("orphan\n");
					expect(out).toContain(
						"1 of them only because an inline python/node program quoted them (#1220): orphan.txt",
					);
				});

				it("reads a path quoted before its last commit at HEAD's version", async () => {
					const dir = dirtyCheckout();
					const { seen, out } = await runSeeing(dir, [], {
						pid: 5419,
						sessionId: "mine",
						ledger: quoting(1),
					});
					expect(seen.read("orphan.txt")).toBe(headText);
					expect(out).not.toContain("(#1220)");
				});

				it("never lets a quote make --isolated refuse", async () => {
					const dir = dirtyCheckout();
					const { err } = await runSeeing(dir, ["--isolated", "x.test.ts"], {
						pid: 5420,
						sessionId: "mine",
						ledger: quoting(Date.now() + 60_000),
					});
					expect(err).toContain("REFUSED");
					expect(err).not.toContain("orphan.txt");
				});
			});
		});
	});

	describe("own work only: a bare run leaves a neighbour's commits to its own certificate (#1216)", () => {
		const { attestationOf } = require("./lib/test-pass-marker.js");

		/**
		 * Three unpushed commits past `origin/main`: the launcher's, a
		 * neighbour's, and one in no ledger.
		 */
		function ownRange(dir: string) {
			const commit = (f: string, text: string) => {
				fs.writeFileSync(path.join(dir, f), text);
				gitIn(dir, ["add", f]);
				gitIn(dir, ["commit", "-qm", f]);
				return gitIn(dir, ["rev-parse", "HEAD"]).trim();
			};
			gitIn(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
			const base = gitIn(dir, ["rev-parse", "HEAD"]).trim();
			const mine = commit("mine.js", "1\n");
			const theirs = commit("theirs.js", "1\n");
			const loose = commit("loose.js", "1\n");
			return { base, mine, theirs, loose };
		}

		const commitLedgerOf = (ledgers: Record<string, string[] | null>) => ({
			ledgerRoot: () => "/main",
			readCommitsBy: (id: string) => (id in ledgers ? ledgers[id] : []),
			readOwnersOf: (commits: string[]) =>
				new Map(
					Object.entries(ledgers).flatMap(([id, shas]) =>
						(shas ?? []).filter((s) => commits.includes(s)).map((s) => [s, id]),
					),
				),
		});

		/** Real git; `vitest list` answers `<x>.test.js` for each `<x>.js` it
		 * is asked about, by `related` config or by `--changed <ref>`. */
		const execFn = (file: string, args: string[], opts: { cwd: string }) => {
			if (args[0] !== "list")
				return require("node:child_process").execFileSync(file, args, opts);
			const changed = args.indexOf("--changed");
			/* A bare `--changed` is followed by a flag, and diffs against HEAD. */
			const ref = args[changed + 1];
			const asked: string[] =
				changed === -1
					? JSON.parse(
							(/related: (\[[^\]]*\])/.exec(
								fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"),
							) ?? [])[1] ?? "[]",
						).map((p: string) => path.relative(opts.cwd, p))
					: gitIn(opts.cwd, [
							"diff",
							"--name-only",
							ref?.startsWith("--") ? "HEAD" : ref,
						])
							.split("\n")
							.filter(Boolean);
			return `${asked
				.filter((p) => p.endsWith(".js"))
				.map((p) => p.replace(/\.js$/, ".test.js"))
				.join("\n")}\n`;
		};

		async function runSeeing(
			dir: string,
			argv: string[],
			extra: Record<string, unknown>,
		) {
			const seen = { args: [] as string[], env: {} as Record<string, string> };
			const out = sink();
			const code = await main(argv, {
				root: dir,
				execFn,
				loadEdges: () => ({}),
				renderEdges: () => ({}),
				out,
				err: sink(),
				fs: fakeFs(),
				spawnFn: (
					_bin: string,
					a: string[],
					opts: { env: Record<string, string> },
				) => {
					seen.args = a;
					seen.env = opts.env;
					return fakeChild({ code: 0 });
				},
				...extra,
			});
			return { code, ...seen, out: out.text.join("") };
		}

		it("selects none of the readers only a neighbour's commit reaches, and keeps an unledgered commit's", async () => {
			const dir = repo();
			const r = ownRange(dir);
			const run = await runSeeing(dir, [SHARED_FLAG], {
				sessionId: "me",
				commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
			});
			expect(run.code).toBe(0);
			expect(run.args).toContain("mine.test.js");
			expect(run.args).toContain("loose.test.js");
			expect(run.args).not.toContain("theirs.test.js");
			expect(readLaunch(run.env).changedPaths).toEqual(["loose.js", "mine.js"]);
			expect(run.out).toContain(
				`OWN WORK ONLY — 1 neighbour commit(s) in that range left to their own sessions' certificates`,
			);
			expect(run.out).toContain(r.theirs.slice(0, 12));
		});

		it("meets the gate, and composes with the neighbour's own certificate at the push", async () => {
			const dir = repo();
			const r = ownRange(dir);
			const run = await runSeeing(dir, [SHARED_FLAG], {
				sessionId: "me",
				commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
			});
			expect(readLaunch(run.env).admissible).toBe(true);
			const head = r.loose;
			const markerOver = (changedPaths: string[]) => ({
				sha: head,
				at: "2026-10-10T00:00:00.000Z",
				dirtyAtStart: false,
				dirtyCount: 0,
				headMovedDuringRun: false,
				foreign: [],
				scope: {
					modulesRun: 2,
					modulesTotal: 9,
					tests: 2,
					passed: 2,
					skipped: 0,
					failed: 0,
					nameFilter: null,
					fileFilters: [],
					changed: r.base,
					admissible: true,
				},
				changedPaths,
			});
			const mine = markerOver(readLaunch(run.env).changedPaths);
			const theirs = markerOver(["theirs.js"]);
			const vitestAttestation = (markers: unknown[]) => {
				const v = attestationOf(head, markers, { root: dir });
				if (!v.judged) throw new Error(v.why);
				return v.suites.find((s: { suite: string }) => s.suite === "vitest");
			};
			expect(vitestAttestation([mine]).attested).toBe(false);
			expect(vitestAttestation([mine, theirs]).attested).toBe(true);
		});

		it("narrows exactly as before with no session id, or a ledger that will not read", async () => {
			for (const extraFor of [
				(r: ReturnType<typeof ownRange>) => ({
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				}),
				() => ({
					sessionId: "me",
					commitLedger: commitLedgerOf({ me: null }),
				}),
			]) {
				const dir = repo();
				const r = ownRange(dir);
				const run = await runSeeing(dir, [SHARED_FLAG], extraFor(r));
				expect(run.args).toContain("theirs.test.js");
				expect(readLaunch(run.env).changedPaths).toEqual([
					"loose.js",
					"mine.js",
					"theirs.js",
				]);
				expect(run.out).not.toContain("OWN WORK ONLY");
			}
		});

		it("leaves an explicit `--changed <ref>` unnarrowed, the route for taking a neighbour's commit on", async () => {
			const dir = repo();
			const r = ownRange(dir);
			const run = await runSeeing(dir, ["--changed", r.base], {
				sessionId: "me",
				commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
			});
			expect(run.args).toContain("theirs.test.js");
			expect(readLaunch(run.env).changedPaths).toContain("theirs.js");
		});

		it("counts the neighbour commits an explicit `--changed <ref>` takes on, and names the own-work run (#2182)", async () => {
			const dir = declaringCommands(repo(), { test: "npm run test" });
			const r = ownRange(dir);
			const run = await runSeeing(dir, ["--changed", r.base], {
				sessionId: "me",
				commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
			});
			expect(run.code).toBe(0);
			expect(run.out).toContain(
				`NEIGHBOURS' COMMITS TAKEN ON — \`--changed ${r.base}\` takes on 1 neighbour commit(s) in its range`,
			);
			expect(run.out).toContain(r.theirs.slice(0, 12));
			expect(run.out).toContain("run `npm run test` (#2182)");
		});

		it("says nothing of neighbours where the range holds none of theirs", async () => {
			const dir = repo();
			const r = ownRange(dir);
			const run = await runSeeing(dir, ["--changed", r.base], {
				sessionId: "me",
				commitLedger: commitLedgerOf({ me: [r.mine] }),
			});
			expect(run.out).not.toContain("NEIGHBOURS' COMMITS");
		});

		describe("a bare `--changed` that selects nothing names the run testing unpushed own commits (#2182)", () => {
			const note = "UNPUSHED WORK NOT SELECTED";

			it("in the overlay, counting the launcher's and the unledgered commit", async () => {
				const dir = declaringCommands(repoWithDeps(), { test: "npm run test" });
				const r = ownRange(dir);
				const run = await runSeeing(dir, ["--changed"], {
					sessionId: "me",
					ledger: ledgerOf([]),
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(run.code).toBe(0);
				expect(run.out).toContain("Nothing to run.");
				expect(run.out).toContain(
					`${note} — \`--changed\` reads only uncommitted files, so none of your 2 unpushed commit(s) since ${r.base.slice(0, 12)} is tested here. \`npm run test\` tests them`,
				);
			});

			it("names the own-work run on the shared tree too", async () => {
				const dir = repo();
				const r = ownRange(dir);
				const run = await runSeeing(dir, [SHARED_FLAG, "--changed"], {
					sessionId: "me",
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(run.out).toContain(note);
			});

			it("not where it selects a test, nor with no unpushed commit of its own", async () => {
				const dir = repo();
				const r = ownRange(dir);
				fs.writeFileSync(path.join(dir, "mine.js"), "dirty\n");
				const selecting = await runSeeing(dir, [SHARED_FLAG, "--changed"], {
					sessionId: "me",
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(selecting.args).toContain("mine.test.js");
				expect(selecting.out).not.toContain(note);
				gitIn(dir, ["checkout", "--", "mine.js"]);
				gitIn(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
				const pushed = await runSeeing(dir, [SHARED_FLAG, "--changed"], {
					sessionId: "me",
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(pushed.out).not.toContain(note);
			});
		});

		it("never escalates on a neighbour's package.json commit", async () => {
			const dir = repo();
			fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
			gitIn(dir, ["add", "package.json"]);
			gitIn(dir, ["commit", "-qm", "package.json"]);
			const r = ownRange(dir);
			fs.writeFileSync(
				path.join(dir, "package.json"),
				'{ "dependencies": { "x": "1" } }\n',
			);
			gitIn(dir, ["commit", "-qam", "bump"]);
			const bump = gitIn(dir, ["rev-parse", "HEAD"]).trim();
			const run = await runSeeing(dir, [SHARED_FLAG], {
				sessionId: "me",
				commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs, bump] }),
			});
			expect(run.out).not.toContain("DEFAULT ESCALATED");
			expect(readLaunch(run.env).changedPaths).not.toContain("package.json");
		});

		it("reads the range inside the overlay worktree too (#812)", async () => {
			const dir = repoWithDeps();
			const r = ownRange(dir);
			const run = await runSeeing(dir, [], {
				sessionId: "me",
				ledger: ledgerOf([]),
				commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
			});
			expect(run.code).toBe(0);
			expect(run.args).toContain("mine.test.js");
			expect(run.args).not.toContain("theirs.test.js");
		});

		describe("selects exactly the own set the re-run guard judges attestation on (#1218)", () => {
			const { ownSelection } = require("./lib/own-selection.js");

			async function bothOver(dir: string, seams: Record<string, unknown>) {
				const run = await runSeeing(dir, [], { sessionId: "me", ...seams });
				expect(run.code).toBe(0);
				return {
					run: readLaunch(run.env).changedPaths,
					guard: ownSelection(dir, "me", seams),
				};
			}

			it("with nothing of its own uncommitted, beside a neighbour's half-written file", async () => {
				const dir = repoWithDeps();
				const r = ownRange(dir);
				/* The overlay leaves it out, so the guard, reading the shared
				 * tree, must too. */
				fs.writeFileSync(path.join(dir, "theirs.js"), "half-written\n");
				const { run, guard } = await bothOver(dir, {
					ledger: ledgerOf([]),
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(guard).toEqual({
					base: r.base,
					tip: r.loose,
					mine: [],
					uncommitted: [],
					net: ["loose.js", "mine.js", "theirs.js"],
					scoped: { paths: run, dropped: [r.theirs] },
					unread: null,
				});
			});

			it("with a file an inline program quoted, which the overlay carries (#1220)", async () => {
				const dir = repoWithDeps();
				const r = ownRange(dir);
				fs.writeFileSync(path.join(dir, "quoted.js"), "new\n");
				const { run, guard } = await bothOver(dir, {
					ledger: {
						...ledgerOf([]),
						readSelectsBy: () => [{ path: "quoted.js", at: Date.now() }],
					},
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(run).toContain("quoted.js");
				expect(guard?.mine).toEqual(["quoted.js"]);
			});

			it("with a new file of its own the overlay carries", async () => {
				const dir = repoWithDeps();
				const r = ownRange(dir);
				fs.writeFileSync(path.join(dir, "fresh.js"), "new\n");
				const { run, guard } = await bothOver(dir, {
					ledger: ledgerOf(["fresh.js"]),
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(run).toContain("fresh.js");
				expect(guard.mine).toEqual(["fresh.js"]);
				expect(guard.scoped).toEqual({ paths: run, dropped: [r.theirs] });
			});
		});
		describe("the queue's probes, on the run's own set (#1221)", () => {
			/** Past `origin/main`: an own commit no test reads, then a neighbour's
			 * one a test imports. */
			function untestedOwnRange(dir: string) {
				const commit = (f: string) => {
					fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
					fs.writeFileSync(path.join(dir, f), "1\n");
					gitIn(dir, ["add", f]);
					gitIn(dir, ["commit", "-qm", f]);
					return gitIn(dir, ["rev-parse", "HEAD"]).trim();
				};
				gitIn(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
				const base = gitIn(dir, ["rev-parse", "HEAD"]).trim();
				const mine = commit("docs/own.md");
				const theirs = commit("theirs.js");
				return { base, mine, theirs, commit };
			}

			/**
			 * What the pre-queue probe answers, read off a queued launch at an open
			 * gate: null where it joined the queue, else what it says reaches no
			 * test file.
			 */
			const probe = async (
				dir: string,
				argv: string[],
				{ shared = false, ...extra }: Record<string, unknown> = {},
			) => {
				const joined = vi.fn();
				const run = await runSeeing(
					dir,
					["--queue", ...(shared ? [SHARED_FLAG] : []), ...argv],
					{
						ledger: ledgerOf([]),
						sessionId: "me",
						queueDir: qdir(),
						queueFs: { ...fs, writeFileSync: joined },
						queueLog: null,
						gate: () => false,
						...extra,
					},
				);
				if (joined.mock.calls.length > 0) return null;
				return (
					/--queue: (.*) reaches no test file, so this run skips the queue/.exec(
						run.out,
					)?.[1] ?? "neither queued nor skipped"
				);
			};

			/** A queued launch that must never reach the queue. */
			async function queuedLaunch(
				dir: string,
				argv: string[],
				extra: Record<string, unknown>,
			) {
				const queueLog = path.join(qdir(), "exits.jsonl");
				const joined = vi.fn();
				const gate = vi.fn(() => true);
				const run = await runSeeing(dir, ["--queue", ...argv], {
					sessionId: "me",
					ledger: ledgerOf([]),
					queueDir: qdir(),
					queueFs: { ...fs, writeFileSync: joined },
					gate,
					queueLog,
					...extra,
				});
				expect(joined).not.toHaveBeenCalled();
				expect(gate).not.toHaveBeenCalled();
				expect(run.args).toContain(EMPTY_SELECTION_FILTER);
				return { ...run, exits: readJsonl(queueLog) };
			}

			it("lets a bare run whose own work selects nothing skip the queue, and logs it as an empty exit", async () => {
				const dir = repoWithDeps();
				const r = untestedOwnRange(dir);
				/* A neighbour's new file, which the shared tree's probe counts. */
				fs.writeFileSync(path.join(dir, "half.js"), "half-written\n");
				const commitLedger = commitLedgerOf({ me: [r.mine], them: [r.theirs] });
				expect(
					await probe(dir, [], { commitLedger, sessionId: "" }),
				).toBeNull();
				expect(await probe(dir, [], { commitLedger, shared: true })).toBeNull();

				const run = await queuedLaunch(dir, [], { commitLedger });
				expect(run.out).toContain(
					`--queue: this session's own work since ${r.base} reaches no test file, so this run skips the queue`,
				);
				expect(run.exits).toMatchObject([
					{
						reason: "left",
						kind: "bare",
						session: "me",
						empty: true,
						waitS: 0,
						skipped: true,
					},
				]);
			});

			it("lets a test:changed with only a neighbour's files dirty skip the queue", async () => {
				const dir = repoWithDeps();
				const r = untestedOwnRange(dir);
				fs.writeFileSync(path.join(dir, "theirs.js"), "half-written\n");
				expect(await probe(dir, ["--changed"], { shared: true })).toBeNull();

				const run = await queuedLaunch(dir, ["--changed"], {
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				});
				expect(run.out).toContain(
					"--queue: this session's own uncommitted work reaches no test file",
				);
				expect(run.out).toContain("UNPUSHED WORK NOT SELECTED");
				expect(run.exits).toMatchObject([
					{ reason: "left", kind: "changed", empty: true, skipped: true },
				]);
			});

			it("counts an own new file a test reads, which the shared tree's diff lists not at all", async () => {
				const dir = repoWithDeps();
				const r = untestedOwnRange(dir);
				fs.writeFileSync(path.join(dir, "docs/new.md"), "new\n");
				const seams = {
					ledger: ledgerOf(["docs/new.md"]),
					commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
					renderEdges: () => ({ "docs/new.md": ["reader.test.js"] }),
				};
				expect(await probe(dir, ["--changed"], seams)).toBeNull();
				expect(await probe(dir, [], seams)).toBeNull();
				expect(
					await probe(dir, ["--changed"], { ...seams, shared: true }),
				).toMatch(/^the diff against /);
			});

			it("says so where the own set will not read, and probes the shared tree's diff instead", async () => {
				const dir = repoWithDeps();
				untestedOwnRange(dir);
				const err = sink();
				expect(
					await probe(dir, ["--changed"], {
						err,
						execFn: (file: string, args: string[], opts: { cwd: string }) => {
							if (args[0] === "status") throw new Error("git status failed");
							return execFn(file, args, opts);
						},
					}),
				).toMatch(/^the diff against /);
				expect(err.text.join("")).toContain(
					"this session's own work could not be read",
				);
			});

			/* The own set's re-check, against the shared tree's: once origin/main
			 * moves past this session's tested commit mid-wait, only its untested
			 * one is left to it, while the shared diff still holds a neighbour's
			 * code. */
			it("re-checks on the own set once origin/main moves, leaving where only untested own work is left", async () => {
				const dir = repoWithDeps();
				const r = untestedOwnRange(dir);
				gitIn(dir, ["reset", "-q", "--hard", r.base]);
				const mine = r.commit("mine.js");
				const own = r.commit("docs/own.md");
				const theirs = r.commit("theirs.js");
				const launch = (argv: string[]) => {
					gitIn(dir, ["update-ref", "refs/remotes/origin/main", r.base]);
					let polls = 0;
					return runSeeing(dir, ["--queue", ...argv], {
						sessionId: "me",
						ledger: ledgerOf([]),
						commitLedger: commitLedgerOf({ me: [mine, own], them: [theirs] }),
						queueDir: qdir(),
						queueLog: null,
						gate: () => polls < 2,
						sleepFn: () => {
							if (polls++ === 0)
								gitIn(dir, ["update-ref", "refs/remotes/origin/main", mine]);
							return Promise.resolve();
						},
					});
				};
				expect((await launch([])).out).toMatch(
					`this session's own work since ${mine} reaches no test file, so this run leaves the queue`,
				);
				expect((await launch([SHARED_FLAG])).out).not.toMatch(
					/leaves the queue/,
				);
			});
		});
		it("leaves the neighbour's commit out of an explicit --isolated run the overlay fell back from", async () => {
			const dir = repoWithDeps();
			const r = ownRange(dir);
			let adds = 0;
			const run = await runSeeing(dir, ["--isolated"], {
				sessionId: "me",
				ledger: ledgerOf([]),
				commitLedger: commitLedgerOf({ me: [r.mine], them: [r.theirs] }),
				execFn: (file: string, args: string[], opts: { cwd: string }) => {
					if (args[0] === "worktree" && args[1] === "add" && adds++ === 0)
						throw new Error("worktree add failed");
					return execFn(file, args, opts);
				},
			});
			expect(adds).toBe(2);
			expect(run.code).toBe(0);
			expect(run.args).toContain("mine.test.js");
			expect(run.args).not.toContain("theirs.test.js");
		});

		/* The shared route's cases are the launch record's own (#3660). */
		it.each([
			["the overlay", [], 0],
			["the worktree an --isolated overlay fell back to", ["--isolated"], 1],
			/* A bare `--changed` takes the same base on its overlay (#3678). */
			["a bare --changed's overlay", ["--changed"], 0],
		])(
			"records the merge-base on %s, and no base on the HEAD fallback (#3660)",
			async (_route, argv, failedAdds) => {
				const based = async (pushed: boolean) => {
					const dir = repoWithDeps();
					const r = ownRange(dir);
					if (!pushed)
						gitIn(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
					let adds = 0;
					const run = await runSeeing(dir, argv, {
						sessionId: "me",
						ledger: ledgerOf([]),
						commitLedger: commitLedgerOf({ me: [r.mine] }),
						execFn: (file: string, args: string[], opts: { cwd: string }) => {
							if (
								args[0] === "worktree" &&
								args[1] === "add" &&
								adds++ < failedAdds
							)
								throw new Error("worktree add failed");
							return execFn(file, args, opts);
						},
					});
					expect(run.code).toBe(0);
					return { base: r.base, recorded: readLaunch(run.env).base };
				};
				const merged = await based(true);
				expect(merged.recorded).toBe(merged.base);
				expect((await based(false)).recorded).toBeNull();
			},
		);
	});

	describe("what the refusal says, by how many files it names", () => {
		/** The refusal a full run prints over `paths`, each this session's own
		 * new file. */
		async function isolatedRefusal(paths: string[]) {
			const dir = repoWithDeps();
			for (const p of paths) fs.writeFileSync(path.join(dir, p), "new\n");
			const err = sink();
			const code = await main(["--full=coverage"], {
				root: dir,
				pid: 4264,
				sessionId: "mine",
				ledger: ledgerOf(paths),
				out: sink(),
				err,
				fs: fakeFs(),
				spawnFn: () => fakeChild({ code: 0 }),
			});
			expect(code).toBe(1);
			return err.text.join("");
		}

		it("hands over `git status` rather than a truncated pathspec", async () => {
			const many = Array.from(
				{ length: REFUSAL_NAMED_MAX + 4 },
				(_, i) => `f${i}.ts`,
			);
			const text = await isolatedRefusal(many);
			expect(text).toContain("and 4 more");
			expect(text).not.toContain("git commit -m");
		});

		/* The cap itself, not a count that happens to sit above it. The Stop
		 * guard truncates at the same shared number and pins the same boundary,
		 * so a caller left on a private literal fails here the moment that
		 * number moves (mantahostels#2231). */
		it("names every path at exactly the cap, and truncates one past it", async () => {
			const at = Array.from(
				{ length: REFUSAL_NAMED_MAX },
				(_, i) => `f${i}.ts`,
			);
			const full = await isolatedRefusal(at);
			expect(full).not.toContain("more");
			expect(full).toContain("git commit -m");
			expect(await isolatedRefusal([...at, "over.ts"])).toContain("and 1 more");
		});

		it("never offers `-uno` as the recovery, which hides its untracked half", async () => {
			// The set this refusal counts includes untracked paths (attributeDirty's
			// `untracked` arm), so the one flag that drops them cannot recover it —
			// a truncated refusal would be unrecoverable by its own recipe (mantahostels#2196).
			const many = Array.from({ length: 14 }, (_, i) => `f${i}.ts`);
			const text = await isolatedRefusal(many);
			expect(text).toContain("git status --porcelain`");
			expect(text).not.toContain("--porcelain -uno");
		});

		it("prints the whole commit recipe for a set it can name, quoted", async () => {
			// The positive half of the rule above: without it the recipe branch
			// could be deleted outright and only the negative assertion would stay
			// green (mantahostels#2169).
			const text = await isolatedRefusal(["a.ts", "one two.ts"]);
			expect(text).toContain(
				`git commit -m "<why, in plain language>" -- a.ts 'one two.ts'`,
			);
		});
	});
});

describe("`--adopt`, the adoption run push:check hands back (#1213)", () => {
	const { expandChanged } = require("./lib/changed-selection.js");

	/** A fake fs keeping what the probe writes, and a fake git/vitest whose
	 * `vitest list` answers one test file. */
	function harness(edges: Record<string, string[]> = {}) {
		const written = new Map<string, string>();
		const calls: string[][] = [];
		const fsFake = {
			readFileSync: () => "",
			writeFileSync: (f: string, text: string) => {
				written.set(f, text);
			},
			unlinkSync: (f: string) => written.delete(f),
		};
		let listed = "scripts/a.test.ts\n";
		const execFn = (_file: string, args: string[]) => {
			calls.push(args);
			if (args[0] !== "list") return "";
			if (listed === "throw") throw new Error("Unknown option `--adopt`");
			return listed;
		};
		const err: string[] = [];
		const plan = (argv: string[], render = () => ({})) =>
			expandChanged(argv, {
				root: "/repo",
				bin: "/repo/node_modules/.bin/vitest",
				execFn,
				fs: fsFake,
				probeConfig: "/tmp/probe.mts",
				loadEdges: () => edges,
				renderEdges: render,
				err: { write: (t: string) => err.push(t) },
			});
		return {
			plan,
			calls,
			written,
			fsFake,
			err,
			list: (out: string) => {
				listed = out;
			},
		};
	}

	it("selects the named paths' readers, attests exactly those paths, and meets the gate", () => {
		const h = harness({ "docs/x.md": ["scripts/reader.test.ts"] });
		let config = "";
		h.fsFake.writeFileSync = (_f: string, text: string) => {
			config = text;
		};
		const got = h.plan(["--adopt", "lib/a.js", "docs/x.md", "lib/a.js"]);
		expect(got.changed).toEqual(["lib/a.js", "docs/x.md"]);
		expect(got.files).toEqual(["scripts/a.test.ts", "scripts/reader.test.ts"]);
		expect(got.admissible).toBe(true);
		expect(got.base).toBeNull();
		expect(got.banner).toContain(
			"MEETS THE PUSH GATE FOR THE 2 ADOPTED PATH(S)",
		);
		expect(got.argv).not.toContain("--adopt");
		expect(got.argv).not.toContain("lib/a.js");
		expect(config).toContain('related: ["/repo/lib/a.js","/repo/docs/x.md"]');
		const list = h.calls.find((a) => a[0] === "list");
		expect(list).toEqual(["list", "--filesOnly", "--config", "/tmp/probe.mts"]);
		expect(h.calls.some((a) => a[0] === "diff")).toBe(false);
	});

	it("removes its scratch config", () => {
		const h = harness();
		h.plan(["--adopt", "lib/a.js"]);
		expect(h.written.size).toBe(0);
	});

	it("does not meet the gate with another word beside it, with no path, or where the read graph will not render", () => {
		const h = harness();
		const extra = h.plan(["--adopt", "lib/a.js", "-t", "foo"]);
		expect(extra.admissible).toBe(false);
		expect(extra.banner).toContain("re-run with `--adopt <paths>` alone");
		const none = h.plan(["--adopt"]);
		expect(none.admissible).toBe(false);
		expect(none.banner).toContain("`--adopt` names no path");
		expect(h.plan(["--adopt", "lib/a.js"], renderFails).admissible).toBe(false);
	});

	it("throws the listing's own error where the listing throws (#2698)", () => {
		const h = harness();
		h.list("throw");
		expect(() => h.plan(["--adopt", "lib/a.js"])).toThrow(
			"--adopt could not be expanded: Unknown option `--adopt`",
		);
		expect(h.written.size).toBe(0);
	});

	it("skips the queue on an empty selection, naming the adopted path list where a diff names its base (#1016)", async () => {
		const probeConfig = path.join(mkScratchDir("adopt-probe-"), "probe.mts");
		dirs.push(path.dirname(probeConfig));
		const joined = vi.fn();
		const out: string[] = [];
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			await main(["--queue", SHARED_FLAG, "--adopt", "docs/x.md"], {
				root: repo(),
				fs: fakeFs(),
				spawnFn: spawnReturning({}).spawnFn,
				execFn: () => "",
				loadEdges: () => ({}),
				renderEdges: () => ({}),
				probeConfig,
				out: { write: (line: string) => out.push(line) },
				queueDir: qdir(),
				queueFs: { ...fs, writeFileSync: joined },
				queueLog: null,
			});
		} finally {
			stdout.mockRestore();
		}
		expect(joined).not.toHaveBeenCalled();
		expect(out.join("")).toContain(
			"--queue: the adopted path list reaches no test file, so this run skips the queue",
		);
		expect(fs.existsSync(probeConfig)).toBe(false);
	});

	it("hands the spawned child the adopted paths and the gate flag, and no base", async () => {
		const h = harness();
		const { spawnFn, calls } = spawnReturning({});
		await main([SHARED_FLAG, "--adopt", "lib/a.js"], {
			root: repo(),
			expand: (argv: string[]) => h.plan(argv),
			out: { write: () => true },
			spawnFn,
		});
		const [, args, opts] = calls[0] as [
			string,
			string[],
			{ env: Record<string, string> },
		];
		const seen = opts.env;
		expect(readLaunch(seen).admissible).toBe(true);
		expect(readLaunch(seen).changedPaths).toEqual(["lib/a.js"]);
		expect(readLaunch(seen).base).toBeNull();
		expect(args).toContain("scripts/a.test.ts");
		expect(args).not.toContain("--adopt");
	});

	/** One `main` launch of an adoption, queued or not, with what it spawned,
	 * whether it joined the queue and what it wrote to stderr. */
	async function adoptLaunch(
		argv: string[],
		loadEdges: () => Record<string, string[]>,
		{ code = 0, closed = 0 } = {},
	) {
		let shut = closed;
		const sleepFn = vi.fn(() => Promise.resolve());
		const probeConfig = path.join(mkScratchDir("adopt-queue-"), "probe.mts");
		dirs.push(path.dirname(probeConfig));
		const { spawnFn, calls } = spawnReturning({ code });
		const joined = vi.fn();
		const err: string[] = [];
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		try {
			const got = await main(argv, {
				spawnFn,
				root: repo(),
				fs: fakeFs(),
				execFn: (_f: string, words: string[]) =>
					words[0] === "list" ? "scripts/a.test.ts\n" : "",
				loadEdges,
				renderEdges: () => ({}),
				probeConfig,
				out: { write: () => true },
				err: { write: (s: string) => err.push(s) },
				queueDir: qdir(),
				queueFs: { ...fs, writeFileSync: joined },
				queueLog: null,
				gate: () => shut-- > 0,
				sleepFn,
			});
			const [, args, opts] = (calls[0] ?? []) as [
				string,
				string[],
				{ env: Record<string, string> },
			];
			return {
				code: got,
				joined,
				sleepFn,
				args,
				env: opts?.env,
				err: err.join(""),
			};
		} finally {
			stdout.mockRestore();
		}
	}

	it("waits its turn with --queue after its paths, then runs the adoption and nothing else (#2715)", async () => {
		const got = await adoptLaunch(
			["--adopt", "docs/x.md", "--queue"],
			() => ({ "docs/x.md": ["scripts/reader.test.ts"] }),
			{ closed: 2 },
		);
		expect(got.code).toBe(0);
		expect(got.joined).toHaveBeenCalledTimes(1);
		expect(got.sleepFn).toHaveBeenCalledTimes(2);
		expect(got.args).toEqual([
			"run",
			"--passWithNoTests",
			"scripts/a.test.ts",
			"scripts/reader.test.ts",
		]);
		expect(readLaunch(got.env).admissible).toBe(true);
		expect(readLaunch(got.env).changedPaths).toEqual(["docs/x.md"]);
	});

	it("refuses, spawning nothing, where the manifest cannot be read, rather than handing vitest `--adopt` (#2715)", async () => {
		for (const argv of [
			["--adopt", "docs/x.md"],
			["--adopt", "docs/x.md", "--queue"],
		]) {
			const got = await adoptLaunch(argv, () => {
				throw new Error("ENOENT");
			});
			expect(got.code, argv.join(" ")).toBe(1);
			expect(got.args, argv.join(" ")).toBeUndefined();
			expect(got.err).toContain("NARROWING FAILED, SO NOTHING RAN");
			expect(got.err).toContain("npm run gen:test-read-edges");
		}
	});

	it("passes the spawned vitest's non-zero exit back", async () => {
		const got = await adoptLaunch(["--adopt", "docs/x.md"], () => ({}), {
			code: 1,
		});
		expect(got.code).toBe(1);
	});
});

describe("`--retest`, the re-run push:check hands back (#1860)", () => {
	const { expandChanged } = require("./lib/changed-selection.js");
	const { isFullRunArgv, launchRoute } = require("./lib/launch-route.js");

	const calls: string[][] = [];
	const plan = (argv: string[], render: () => unknown = () => ({})) =>
		expandChanged(argv, {
			root: "/repo",
			bin: "/repo/node_modules/.bin/vitest",
			execFn: (_file: string, args: string[]) => {
				calls.push(args);
				return "";
			},
			fs: {
				readFileSync: () => "",
				writeFileSync: () => undefined,
				unlinkSync: () => undefined,
			},
			probeConfig: "/tmp/probe.mts",
			loadEdges: () => ({}),
			renderEdges: render,
			err: { write: () => undefined },
		});

	it("runs the named tests alone, attests no path an unrun test reads, and meets the gate", () => {
		calls.length = 0;
		const got = plan(["--retest", "b.test.ts", "a.test.ts", "b.test.ts"]);
		expect(got.files).toEqual(["a.test.ts", "b.test.ts"]);
		expect(got.changed).toEqual([]);
		expect(got.admissible).toBe(true);
		expect(got.banner).toContain("MEETS THE PUSH GATE FOR THE 2 NAMED TEST(S)");
		expect(got.argv).not.toContain("--retest");
		expect(calls).toEqual([]);
	});

	it("never reads the manifest, so an unreadable one still runs the named tests rather than handing vitest `--retest` (#2715)", () => {
		const got = expandChanged(["--retest", "a.test.ts"], {
			root: "/repo",
			execFn: () => "",
			loadEdges: () => {
				throw new Error("ENOENT");
			},
			renderEdges: () => ({}),
			err: { write: () => undefined },
		});
		expect(got.argv).toEqual(["--passWithNoTests", "a.test.ts"]);
		expect(got.admissible).toBe(true);
	});

	it("does not meet the gate naming a word that is no test file, beside another flag, or where the read graph will not render", () => {
		const word = plan(["--retest", "a.test.ts", "lib/a.js"]);
		expect(word.admissible).toBe(false);
		expect(word.banner).toContain("names a word that is not a test file");
		expect(plan(["--retest", "a.test.ts", "-t", "foo"]).admissible).toBe(false);
		expect(plan(["--retest", "a.test.ts", "--"]).admissible).toBe(false);
		expect(plan(["--retest", "a.test.ts"], renderFails).admissible).toBe(false);
	});

	it("is never a full run, and takes the session's overlay", () => {
		expect(isFullRunArgv(["--retest", "a.test.ts"])).toBe(false);
		const route = launchRoute(["--retest", "a.test.ts"], "s");
		expect(route).toMatchObject({ tree: "overlay", source: "retest" });
	});
});

describe("the read-edge manifest an overlay run brings up to date first (#1860)", () => {
	const { freshenManifest } = require("./lib/manifest-freshen.js");
	const { EDGES_FILE } = require("./lib/test-pass-marker.js");

	function trees(overlay: string | null, shared: string | null) {
		const root = mkScratchDir("freshen-overlay-");
		const home = mkScratchDir("freshen-home-");
		dirs.push(root, home);
		for (const [dir, text] of [
			[root, overlay],
			[home, shared],
		] as const) {
			fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
			if (text !== null) fs.writeFileSync(path.join(dir, EDGES_FILE), text);
		}
		return { root, home };
	}
	const read = (dir: string) =>
		fs.readFileSync(path.join(dir, EDGES_FILE), "utf8");
	const rendered = { "docs/a.md": ["a.test.ts"] };
	type Claim = { ok: true } | { ok: false; why: string };

	function freshen(
		at: { root: string; home: string },
		claim: () => Claim = () => ({ ok: true }),
	) {
		const out: string[] = [];
		const err: string[] = [];
		const claimed: unknown[][] = [];
		freshenManifest(rendered, {
			...at,
			session: "me",
			claimFn: (...args: unknown[]) => {
				claimed.push(args);
				return claim();
			},
			out: { write: (t: string) => out.push(t) },
			err: { write: (t: string) => err.push(t) },
		});
		return { out: out.join(""), err: err.join(""), claimed };
	}

	it("writes both copies under the session's claim where the shared copy holds what the overlay was given", () => {
		const at = trees("stale", "stale");
		const got = freshen(at);
		expect(read(at.root)).toContain('"docs/a.md"');
		expect(read(at.home)).toBe(read(at.root));
		expect(got.claimed).toEqual([
			[path.join(at.home, EDGES_FILE), "me", at.home],
		]);
		expect(got.out).toContain("brought up to date");
	});

	it("leaves the shared copy alone, saying so, where a neighbour's edit sits in it or the claim is refused", () => {
		const edited = trees("stale", "a neighbour's edit");
		expect(freshen(edited).err).toContain(
			"holds an edit this run was not given",
		);
		expect(read(edited.home)).toBe("a neighbour's edit");
		expect(read(edited.root)).toContain('"docs/a.md"');
		const held = trees("stale", "stale");
		expect(
			freshen(held, () => ({ ok: false, why: "held by X" })).err,
		).toContain("held by X");
		expect(read(held.home)).toBe("stale");
	});

	it("writes nothing and takes no claim where the overlay's copy is already current", () => {
		const at = trees("stale", "stale");
		freshen(at);
		const again = freshen(at);
		expect(again.claimed).toEqual([]);
		expect(again.out + again.err).toBe("");
	});
});

describe("under `landing`, the bare run takes only the touched tests (#2930)", () => {
	/* `lib/a.js` imported by `lib/a.test.ts` and by a helper `lib/h.js`, which
	 * `lib/chain.test.ts` imports; `package.json` a dependency-graph root. */
	function landingRepo() {
		const dir = repo();
		const files: Record<string, string> = {
			"lib/a.js": "module.exports = 1;\n",
			"lib/a.test.ts": 'import a from "./a.js";\n',
			"lib/h.js": 'module.exports = require("./a.js");\n',
			"lib/chain.test.ts": 'const h = require("./h.js");\n',
			"package.json": '{ "name": "x" }\n',
		};
		for (const [f, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
			fs.writeFileSync(path.join(dir, f), text);
		}
		const git = (...args: string[]) =>
			require("node:child_process").execFileSync("git", args, {
				cwd: dir,
				stdio: "ignore",
			});
		git("add", ".");
		git("commit", "-qm", "units");
		return dir;
	}

	const launch = async (
		dir: string,
		edges: () => Record<string, string[]> = () => ({}),
		argv: string[] = [],
		extra: Record<string, unknown> = {},
	) => {
		vi.stubEnv("WFC_MODULES", "landing");
		const out = {
			text: "",
			write: (s: string) => {
				out.text += s;
			},
		};
		const spawned: { args: string[]; env: Record<string, string> }[] = [];
		const code = await main(argv, {
			root: dir,
			loadEdges: edges,
			renderEdges: edges,
			out,
			err: { write: () => true },
			spawnFn: (
				_bin: string,
				args: string[],
				opts: { env: Record<string, string> },
			) => {
				spawned.push({ args, env: opts.env });
				return fakeChild({ code: 0 });
			},
			...extra,
		});
		return { code, out: out.text, spawned };
	};

	it("launches exactly the resolved files, no transitive importer, and never escalates on a dependency root", async () => {
		const dir = landingRepo();
		fs.appendFileSync(path.join(dir, "lib/a.js"), "// edit\n");
		fs.writeFileSync(path.join(dir, "package.json"), '{ "name": "y" }\n');
		const { code, out, spawned } = await launch(dir);
		expect(code).toBe(0);
		expect(spawned).toHaveLength(1);
		const { args, env } = spawned[0];
		expect(args).toEqual([
			"run",
			"--maxWorkers=1",
			"--passWithNoTests",
			"lib/a.test.ts",
		]);
		expect(readLaunch(env)).toMatchObject({
			touched: true,
			admissible: false,
			full: null,
		});
		expect(out).toContain("TOUCHED TESTS ONLY");
		expect(out).not.toContain("ESCALATED");
	});

	/* min(resolved files, whole-suite workers): the flag is added below 5,
	 * where the config's own 5 would fork idle workers (#2935). */
	it.each([
		[["lib/a.test.ts", "lib/chain.test.ts"], ["--maxWorkers=2"]],
		[Array.from({ length: 5 }, (_, i) => `lib/t${i}.test.ts`), []],
		[["-t", "foo"], []],
		[["--maxWorkers=1", "lib/a.test.ts", "lib/chain.test.ts"], []],
	])("a run of %j adds the workers flag %j (#2935)", async (argv, flag) => {
		const dir = landingRepo();
		fs.appendFileSync(path.join(dir, "lib/a.test.ts"), "// edit\n");
		const { spawned } = await launch(dir, () => ({}), argv);
		expect(spawned).toHaveLength(1);
		const added = spawned[0].args.slice(1, 1 + flag.length);
		expect(added).toEqual(flag);
		expect(
			spawned[0].args.filter((w) => w.startsWith("--maxWorkers")),
		).toHaveLength(
			argv.some((w) => w.startsWith("--maxWorkers")) ? 1 : flag.length,
		);
	});

	it("logs a queued touched run's exit under its kind (#2935)", async () => {
		const dir = landingRepo();
		fs.appendFileSync(path.join(dir, "lib/a.js"), "// edit\n");
		const queueLog = path.join(qdir(), "exits.jsonl");
		const { spawned } = await launch(dir, () => ({}), ["--queue"], {
			gate: () => null,
			queueDir: qdir(),
			queueLog,
		});
		expect(spawned).toHaveLength(1);
		expect(readJsonl(queueLog)).toMatchObject([
			{ reason: "opened", kind: "touched", slotFree: true },
		]);
	});

	it("carries no whole slot for a 200-file named run (#2935)", async () => {
		const dir = landingRepo();
		const named = Array.from({ length: 200 }, (_, i) => `lib/t${i}.test.ts`);
		const { spawned } = await launch(dir, () => ({}), named);
		expect(readLaunch(spawned[0].env)).toMatchObject({
			resolvedFiles: 200,
			wholeSlot: false,
		});
	});

	it("falls back to same-stem siblings, said, keeping direct importers, where the read graph will not render", async () => {
		const dir = landingRepo();
		fs.appendFileSync(path.join(dir, "lib/h.js"), "// edit\n");
		const { spawned, out } = await launch(dir, () => {
			throw new Error("render failed");
		});
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.args.at(-1)).toBe("lib/chain.test.ts");
		expect(out).toContain("FELL BACK TO SAME-STEM SIBLINGS");
		expect(out).not.toContain("ESCALATED");
	});

	it("runs nothing and exits 0 on an empty selection, naming the lander", async () => {
		const dir = landingRepo();
		fs.writeFileSync(path.join(dir, "notes.md"), "untested\n");
		const { code, out, spawned } = await launch(dir);
		expect(code).toBe(0);
		expect(spawned).toEqual([]);
		expect(out).toContain("NO TOUCHED TESTS");
		expect(out).toContain("The lander runs the full suite");
		const ledger = path.join(dir, ".claude/tmp/markers/.test-runs.jsonl");
		expect(readJsonl(ledger).at(-1)).toMatchObject({
			kind: "touched",
			resolvedFiles: 0,
		});
	});
});
