// @vitest-environment node
/*
 * The code the refill loop runs (#2361): `start` launching from a loop-owned
 * worktree at the verified tip, and a running loop adopting a newer tip by
 * re-exec under its pid. Against fixture repos: a bare origin, a "main
 * checkout" clone the loop's code comes from, and a second clone commits are
 * pushed from.
 *
 * `start` and `boot-resume` each run once, from a checkout holding the real
 * refill-loop.js and its libs, and the loop spawned is killed as soon as its
 * command line is read. The control commands (#4337) run from such a
 * checkout made stale, each a spawned caller handing off to a second node, so
 * this file runs past its CI record: four real-loop checkouts and their
 * node starts are what proves the hand-off, which no in-process run can.
 *
 * The running loop is otherwise a fixture program at the checkout's
 * scripts/refill-loop.js that requires this module by its absolute path, ticks
 * every 50 ms through adoptIfMoved and afterTick, and holds a pidLock across
 * the re-exec.
 *
 * The ticks and waits cross the real clock: a re-exec is a real process
 * replacing its image, which no injected clock stands in for; the 20 s wait
 * is a ceiling on a hang, never an assertion.
 *
 * Loosen it and the loop runs uncommitted or stale code, re-execs into a tip
 * that does not load, retries a bad tip every tick, re-execs under a gate
 * sweep's children, or a boot starts from a working copy mid-edit or a link
 * left dangling.
 */
import {
	type ChildProcess,
	execFileSync,
	spawn,
	spawnSync,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyLibs, readProgramLibs } from "../lib-closure-fixture.js";
import { SHA_SHOWN } from "./pinned-code.js";
import { makeProcRoot, writeCwd } from "./proc-fake";
import {
	bootProgram,
	codeUpdater,
	launchProgram,
	readRunningCode,
} from "./refill-code.js";
import { runInProcessAsync } from "./run-in-process.js";

const CODE_LIB = path.resolve(__dirname, "refill-code.js");
const LOOP = path.resolve(__dirname, "..", "refill-loop.js");
const PID_LOCK_LIB = path.resolve(__dirname, "pid-lock.js");

const DRIVER = `const fs = require("node:fs");
const path = require("node:path");
const { codeUpdater } = require(${JSON.stringify(CODE_LIB)});
const { pidLock } = require(${JSON.stringify(PID_LOCK_LIB)});
const marker = require("./lib/marker.js");
const dir = process.env.FIXTURE_DIR;
const log = (line) => fs.appendFileSync(path.join(dir, "log"), line + "\\n");
function main() {
	if (!pidLock(path.join(dir, "pid"), "refill-loop.js").acquire()) {
		log("lock refused");
		return;
	}
	const updater = codeUpdater({ program: __filename, codeDir: path.join(dir, "code"), log });
	let n = 0;
	const tick = () => {
		updater.adoptIfMoved({ hold: fs.existsSync(path.join(dir, "hold")) });
		log("tick " + n++ + " " + marker + " pid " + process.pid);
		updater.afterTick();
		setTimeout(tick, 50);
	};
	tick();
}
if (require.main === module) main();
`;

let dir: string;
let origin: string;
let checkout: string;
let dev: string;
let codeDir: string;
let loopProc: ChildProcess | null = null;

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

const short = (sha: string) => sha.slice(0, SHA_SHOWN);

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

function push(files: Record<string, string>) {
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dev, name)), { recursive: true });
		fs.writeFileSync(path.join(dev, name), text);
	}
	git(dev, "add", "-A");
	git(dev, "commit", "-qm", "change");
	git(dev, "push", "-q", "origin", "main");
	return git(dev, "rev-parse", "HEAD");
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-code-"));
	origin = path.join(dir, "origin.git");
	checkout = path.join(dir, "checkout");
	dev = path.join(dir, "dev");
	codeDir = path.join(dir, "code");
	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	git(dir, "clone", "-q", origin, dev);
	git(dev, "checkout", "-q", "-b", "main");
	push({
		"scripts/refill-loop.js": DRIVER,
		"scripts/lib/marker.js": 'module.exports = "one";\n',
		"docs/notes.md": "notes\n",
	});
	git(dir, "clone", "-q", origin, checkout);
});

afterEach(() => {
	loopProc?.kill("SIGKILL");
	loopProc = null;
	fs.rmSync(dir, { recursive: true, force: true });
});

const readLogLines = () => {
	try {
		return fs.readFileSync(path.join(dir, "log"), "utf8").split("\n");
	} catch {
		return [];
	}
};

async function until(test: () => boolean, what: string) {
	const end = Date.now() + 20_000;
	while (!test()) {
		if (Date.now() > end)
			throw new Error(`timed out on ${what}:\n${readLogLines().join("\n")}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const readTicks = () => readLogLines().filter((l) => l.startsWith("tick "));

async function startLoop() {
	const launch = launchProgram({
		scriptsDir: path.join(checkout, "scripts"),
		codeDir,
	});
	if ("error" in launch) throw new Error(launch.error);
	// spawn-kept: a long-running loop that re-execs under its pid while the test runs beside it
	loopProc = spawn(process.execPath, [launch.program, "run"], {
		env: { ...gitEnv, FIXTURE_DIR: dir },
		stdio: "ignore",
	});
	await until(() => readTicks().length > 0, "the first tick");
	return launch.program;
}

async function moreTicks(n: number) {
	const seen = readTicks().length;
	await until(() => readTicks().length >= seen + n, `${n} more ticks`);
}

describe("readRunningCode", () => {
	it("reads the loop's command line from a WFC_PROC root, not the real /proc (#3587)", () => {
		const fake = makeProcRoot();
		vi.stubEnv("WFC_PROC", fake.root);
		try {
			fake.proc(4242, { argv: "node scripts/refill-loop.js" });
			writeCwd(fake.root, "4242", fake.root);
			expect(readRunningCode(4242, codeDir)).toBe("a plugin install");
		} finally {
			fake.remove();
		}
	});
});

describe("launchProgram", () => {
	it("launches from a loop-owned worktree at origin's tip, never the checkout's working tree", () => {
		fs.writeFileSync(
			path.join(checkout, "scripts/lib/marker.js"),
			'module.exports = "uncommitted";\n',
		);
		const tip = push({
			"scripts/lib/marker.js": 'module.exports = "pushed";\n',
		});
		const launch = launchProgram({
			scriptsDir: path.join(checkout, "scripts"),
			codeDir,
		});
		expect(launch).toEqual({
			program: path.join(codeDir, tip, "scripts/refill-loop.js"),
			fetchError: null,
		});
		expect(
			fs.readFileSync(path.join(codeDir, tip, "scripts/lib/marker.js"), "utf8"),
		).toContain("pushed");
	});

	it("launches a plugin install's own program, its code having no checkout", () => {
		const plugin = path.join(dir, "plugin", "scripts");
		fs.mkdirSync(plugin, { recursive: true });
		expect(launchProgram({ scriptsDir: plugin, codeDir })).toEqual({
			program: path.join(plugin, "refill-loop.js"),
		});
		expect(
			codeUpdater({
				program: path.join(plugin, "refill-loop.js"),
				codeDir,
				log: () => undefined,
			}),
		).toBeNull();
	});
});

/** Push the real loop and its libs, and clone a main checkout of them. */
function pushRealLoop() {
	const libs = path.join(dir, "libs");
	copyLibs(libs, readProgramLibs("refill-loop.js"));
	const files: Record<string, string> = {
		".claude/workflow-core.json": "{}\n",
		"scripts/refill-loop.js": fs.readFileSync(LOOP, "utf8"),
	};
	for (const f of fs.readdirSync(libs))
		files[`scripts/lib/${f}`] = fs.readFileSync(path.join(libs, f), "utf8");
	const tip = push(files);
	const main = path.join(dir, "main");
	git(dir, "clone", "-q", origin, main);
	return { tip, main };
}

describe("a worktree a kill cut short", () => {
	it("is checked out again, though its program is there", () => {
		const scriptsDir = path.join(checkout, "scripts");
		const launch = launchProgram({ scriptsDir, codeDir });
		if ("error" in launch) throw new Error(launch.error);
		const worktree = path.dirname(path.dirname(launch.program));
		fs.rmSync(
			path.resolve(worktree, git(worktree, "rev-parse", "--git-path", "index")),
		);
		fs.rmSync(path.join(worktree, "scripts/lib/marker.js"));
		expect(launchProgram({ scriptsDir, codeDir })).toEqual(launch);
		expect(fs.existsSync(path.join(worktree, "scripts/lib/marker.js"))).toBe(
			true,
		);
	});
});

describe("start", () => {
	it("spawns run from the loop-owned worktree at origin's tip, never the main checkout's working tree", async () => {
		const { tip, main } = pushRealLoop();
		fs.appendFileSync(
			path.join(main, "scripts", "refill-loop.js"),
			"\n// dirty\n",
		);
		const state = path.join(dir, "state");
		const r = await runInProcessAsync(
			path.join(main, "scripts", "refill-loop.js"),
			["start"],
			{
				cwd: main,
				env: {
					...gitEnv,
					HOME: dir,
					WFC_REFILL_DIR: state,
					CLAUDE_PROJECT_DIR: main,
					CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
					WFC_CLAUDE_BIN: path.join(dir, "no-claude"),
				},
			},
		);
		const pid = Number(/refill loop started: pid (\d+)/.exec(r.stdout)?.[1]);
		expect(pid, r.stdout + r.stderr).toBeGreaterThan(0);
		try {
			expect(
				fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[1],
			).toBe(
				path.join(state, ".refill-loop-code", tip, "scripts", "refill-loop.js"),
			);
		} finally {
			process.kill(-pid, "SIGKILL");
		}
	});
});

describe("control commands from a stale checkout (#4337)", () => {
	let state: string;
	let main: string;
	let pinned: string;

	const controlFile = () => path.join(state, ".refill-loop-control.json");
	const readControl = () => JSON.parse(fs.readFileSync(controlFile(), "utf8"));

	/* The pinned code, then a caller beside it whose control parse predates
	 * quietBenchOff, whose status is not the loop's, whose argument parser
	 * exits 2 silently and whose refill-code.js exports nothing. */
	function plant(
		install: (where: { scriptsDir: string; codeDir: string }) => string,
	) {
		({ main } = pushRealLoop());
		state = path.join(dir, "state");
		pinned = install({
			scriptsDir: path.join(main, "scripts"),
			codeDir: path.join(state, ".refill-loop-code"),
		});
		fs.appendFileSync(
			path.join(main, "scripts/lib/refill-loop.js"),
			"\n{ const real = module.exports.parseControl; module.exports.parseControl = (raw) => { const c = real(raw); if (c) delete c.quietBenchOff; return c; }; }\n",
		);
		fs.appendFileSync(
			path.join(main, "scripts/lib/refill-commands.js"),
			"\nmodule.exports.buildStatusJson = () => ({ stale: true });\n",
		);
		fs.appendFileSync(
			path.join(main, "scripts/lib/cli-args.js"),
			"\nmodule.exports.parseOrCode = () => 2;\n",
		);
		fs.appendFileSync(
			path.join(main, "scripts/lib/refill-code.js"),
			"\nmodule.exports = {};\n",
		);
		fs.writeFileSync(
			controlFile(),
			JSON.stringify({
				noProgressFrom: 5,
				stopRequested: false,
				quietBenchOff: true,
				seats: [],
				scope: { mode: "normal", repos: [], goal: null },
			}),
		);
	}

	const fromStale = (...argv: string[]) =>
		// spawn-kept: the hand-off's child inherits fd 1 and 2, which an in-process run does not capture
		spawnSync(
			process.execPath,
			[path.join(main, "scripts", "refill-loop.js"), ...argv],
			{
				cwd: main,
				encoding: "utf8",
				env: {
					...gitEnv,
					HOME: dir,
					WFC_REFILL_DIR: state,
					CLAUDE_PROJECT_DIR: main,
					CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
					WFC_CLAUDE_BIN: path.join(dir, "no-claude"),
				},
			},
		);

	function expectPinnedRan() {
		const status = fromStale("status", "--json");
		expect(status.status, status.stderr).toBe(0);
		expect(JSON.parse(status.stdout)).not.toHaveProperty("stale");
		const set = fromStale("set", "--pause");
		expect(set.status, set.stderr).toBe(0);
		const stop = fromStale("stop");
		expect(stop.status, stop.stderr).toBe(0);
		expect(readControl()).toMatchObject({
			quietBenchOff: true,
			paused: { by: "founder" },
			stopRequested: true,
		});
		const refused = fromStale("set", "--no-such-flag");
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain("usage:");
	}

	it("runs set, stop and status from the running loop's code", () => {
		plant((where) => {
			const launch = launchProgram(where);
			if ("error" in launch) throw new Error(launch.error);
			return launch.program;
		});
		// spawn-kept: an idle process whose command line names the pinned program, the lock's holder
		loopProc = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)", pinned],
			{ stdio: "ignore" },
		);
		fs.writeFileSync(
			path.join(state, ".refill-loop.pid"),
			String(loopProc.pid),
		);
		expect(
			readRunningCode(
				Number(loopProc.pid),
				path.join(state, ".refill-loop-code"),
			),
		).not.toBeNull();
		expectPinnedRan();
	});

	it("runs set, stop and status from the boot link's code where no loop runs", () => {
		plant((where) => {
			const boot = bootProgram(where);
			if ("error" in boot) throw new Error(boot.error);
			return boot.program;
		});
		expectPinnedRan();
	});
});

describe("the boot link (#3891)", () => {
	const link = () => `${codeDir}.current`;
	const scriptsDir = () => path.join(checkout, "scripts");

	it("is made at the verified tip where no loop has made it, and kept once it resolves", () => {
		const tip = git(dev, "rev-parse", "HEAD");
		const program = path.join(link(), "scripts/refill-loop.js");
		expect(bootProgram({ scriptsDir: scriptsDir(), codeDir })).toEqual({
			program,
			fetchError: null,
		});
		expect(fs.readlinkSync(link())).toBe(path.join(codeDir, tip));
		push({ "scripts/lib/marker.js": 'module.exports = "two";\n' });
		expect(bootProgram({ scriptsDir: scriptsDir(), codeDir })).toEqual({
			program,
		});
		expect(fs.readlinkSync(link())).toBe(path.join(codeDir, tip));
	});

	it("is replaced where it names a worktree gone", () => {
		fs.mkdirSync(path.dirname(link()), { recursive: true });
		fs.symlinkSync(path.join(codeDir, "gone"), link());
		bootProgram({ scriptsDir: scriptsDir(), codeDir });
		expect(fs.readlinkSync(link())).toBe(
			path.join(codeDir, git(dev, "rev-parse", "HEAD")),
		);
	});

	it("is not made for a plugin install, nor where the code will not launch", () => {
		const plugin = path.join(dir, "plugin", "scripts");
		fs.mkdirSync(plugin, { recursive: true });
		expect(bootProgram({ scriptsDir: plugin, codeDir })).toEqual({
			program: path.join(plugin, "refill-loop.js"),
		});
		const empty = path.join(dir, "empty");
		git(dir, "init", "-q", empty);
		expect(bootProgram({ scriptsDir: empty, codeDir })).toEqual({
			error: expect.stringMatching(/^no \S+ in /),
		});
		expect(fs.existsSync(link())).toBe(false);
	});

	it("is no plugin install's, though another checkout's link resolves on this machine", () => {
		bootProgram({ scriptsDir: scriptsDir(), codeDir });
		const plugin = path.join(dir, "plugin", "scripts");
		fs.mkdirSync(plugin, { recursive: true });
		expect(bootProgram({ scriptsDir: plugin, codeDir })).toEqual({
			program: path.join(plugin, "refill-loop.js"),
		});
	});

	it("is not made at a tip that does not load", () => {
		const bad = push({ "scripts/lib/marker.js": 'throw new Error("boom");\n' });
		expect(bootProgram({ scriptsDir: scriptsDir(), codeDir })).toEqual({
			error: expect.stringContaining(
				`${short(bad)}'s program does not load: exit 1, Error: boom`,
			),
		});
		expect(fs.existsSync(link())).toBe(false);
	});

	it("survives a refused tip that it names", async () => {
		await startLoop();
		await moreTicks(1);
		fs.writeFileSync(path.join(dir, "hold"), "");
		const bad = push({ "scripts/lib/marker.js": 'throw new Error("boom");\n' });
		fs.mkdirSync(path.join(codeDir, bad));
		fs.rmSync(link());
		fs.symlinkSync(path.join(codeDir, bad), link());
		fs.rmSync(path.join(dir, "hold"));
		await until(
			() => readLogLines().some((l) => l.startsWith("not adopting")),
			"the refusal",
		);
		expect(fs.existsSync(path.join(codeDir, bad, "scripts"))).toBe(true);
	});

	it("is followed through a symlinked code directory, pruning all but the image", async () => {
		const real = path.join(dir, "real-code");
		fs.mkdirSync(path.join(real, "stale"), { recursive: true });
		fs.symlinkSync(real, codeDir);
		const first = await startLoop();
		await moreTicks(1);
		const sha = path.basename(path.dirname(path.dirname(first)));
		expect(fs.readlinkSync(link())).toBe(path.join(real, sha));
		expect(fs.readdirSync(real)).toEqual([sha]);
	});

	it("follows the loop's image, so an adoption's pruning never leaves it dangling", async () => {
		const first = await startLoop();
		await moreTicks(1);
		expect(fs.readlinkSync(link())).toBe(path.dirname(path.dirname(first)));
		const tip = push({ "scripts/lib/marker.js": 'module.exports = "two";\n' });
		await until(() => readTicks().some((l) => l.includes(" two ")), "two");
		await moreTicks(2);
		expect(fs.readlinkSync(link())).toBe(path.join(codeDir, tip));
		expect(fs.readdirSync(codeDir)).toEqual([tip]);
	});

	it("keeps the worktrees where it will not move, logging why", async () => {
		const stale = path.join(codeDir, "stale");
		fs.mkdirSync(stale, { recursive: true });
		/* A directory with something in it: no rename lands on it. */
		fs.mkdirSync(path.join(link(), "x"), { recursive: true });
		await startLoop();
		await moreTicks(1);
		expect(readLogLines().join("\n")).toContain("boot link not moved to ");
		expect(fs.existsSync(stale)).toBe(true);
	});

	it("leaves the link and the worktrees alone for an image outside the code directory", async () => {
		const worktree = path.join(codeDir, "named");
		fs.mkdirSync(worktree, { recursive: true });
		fs.symlinkSync(worktree, link());
		// spawn-kept: the loop's image in the checkout itself, ticking beside the test
		loopProc = spawn(
			process.execPath,
			[path.join(scriptsDir(), "refill-loop.js"), "run"],
			{ env: { ...gitEnv, FIXTURE_DIR: dir }, stdio: "ignore" },
		);
		await until(() => readTicks().length > 1, "two ticks");
		expect(fs.readlinkSync(link())).toBe(worktree);
		expect(fs.existsSync(worktree)).toBe(true);
	});

	it("resumes at boot past a syntax error in the shared checkout's refill-loop.js", () => {
		const { tip, main } = pushRealLoop();
		const state = path.join(dir, "state");
		const env = {
			...gitEnv,
			HOME: dir,
			WFC_REFILL_DIR: state,
			CLAUDE_PROJECT_DIR: main,
			CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
			WFC_CLAUDE_BIN: path.join(dir, "no-claude"),
		};
		const stateCode = path.join(state, ".refill-loop-code");
		const boot = bootProgram({
			scriptsDir: path.join(main, "scripts"),
			codeDir: stateCode,
		});
		if ("error" in boot) throw new Error(boot.error);
		fs.writeFileSync(
			path.join(state, ".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: Date.now(),
				stopRequested: false,
				seats: [],
				scope: { mode: "normal", repos: [main] },
			}),
		);
		fs.appendFileSync(
			path.join(main, "scripts/refill-loop.js"),
			"\nthis is not javascript (\n",
		);
		// spawn-kept: the boot resume outlives its call in a detached loop, and node resolving the symlinked program is what is under test
		const r = spawnSync(process.execPath, [boot.program, "boot-resume"], {
			cwd: dir,
			env,
			encoding: "utf8",
		});
		expect(r.status, r.stderr).toBe(0);
		const pid = Number(/resumed .*, pid (\d+)/.exec(r.stdout)?.[1]);
		expect(pid, r.stdout).toBeGreaterThan(0);
		try {
			expect(
				fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[1],
			).toBe(path.join(stateCode, tip, "scripts", "refill-loop.js"));
		} finally {
			process.kill(-pid, "SIGKILL");
		}
		expect(
			fs.readFileSync(path.join(state, ".refill-loop.log"), "utf8"),
		).toContain("boot resume: resumed");
	});
});

describe("adoption", () => {
	it("adopts a tip changing its lib at the next tick, under the same pid, holding its lock", async () => {
		const first = await startLoop();
		const pid = loopProc?.pid;
		const kept = ["control.json", "state.json", "gates.json"];
		for (const f of kept)
			fs.writeFileSync(
				path.join(dir, f),
				`{"stopRequested":true,"noProgressFrom":1,"of":"${f}"}\n`,
			);
		const before = kept.map((f) => fs.readFileSync(path.join(dir, f)));
		const tip = push({ "scripts/lib/marker.js": 'module.exports = "two";\n' });
		await until(
			() => readTicks().some((l) => l.includes(" two ")),
			"the new code",
		);
		const lines = readLogLines();
		expect(lines.filter((l) => l.startsWith("adopting "))).toEqual([
			`adopting ${short(path.basename(path.dirname(path.dirname(first))))}..${short(tip)}`,
		]);
		expect(lines).not.toContain("lock refused");
		expect(readTicks().at(-1)).toContain(`pid ${pid}`);
		expect(kept.map((f) => fs.readFileSync(path.join(dir, f)))).toEqual(before);
		expect(readRunningCode(Number(pid), codeDir)).toBe(short(tip));
		await moreTicks(2);
		expect(fs.readdirSync(codeDir)).toEqual([tip]);
	});

	it("leaves the process alone on a tip changing only docs and tests", async () => {
		await startLoop();
		push({ "docs/notes.md": "more\n", "scripts/lib/marker.test.ts": "//\n" });
		await moreTicks(4);
		expect(readLogLines().some((l) => l.startsWith("adopting "))).toBe(false);
	});

	it("refuses a tip whose program throws on load, once, ticking on the old code", async () => {
		await startLoop();
		const bad = push({ "scripts/lib/marker.js": 'throw new Error("boom");\n' });
		await until(
			() => readLogLines().some((l) => l.startsWith("not adopting")),
			"the refusal",
		);
		await moreTicks(4);
		const refusals = readLogLines().filter((l) => l.startsWith("not adopting"));
		expect(refusals).toHaveLength(1);
		expect(readLogLines().some((l) => l.startsWith("adopting "))).toBe(false);
		expect(refusals[0]).toMatch(
			new RegExp(
				`^not adopting ${short(bad)}: its program does not load: exit 1, Error: boom; running `,
			),
		);
		expect(readTicks().at(-1)).toContain(" one ");
		expect(fs.existsSync(path.join(codeDir, bad))).toBe(false);
	});

	it("adopts nothing while held, as by a running gate sweep or a pending stop, then adopts once released", async () => {
		await startLoop();
		fs.writeFileSync(path.join(dir, "hold"), "");
		push({ "scripts/lib/marker.js": 'module.exports = "two";\n' });
		await moreTicks(4);
		expect(readLogLines().some((l) => l.startsWith("adopting "))).toBe(false);
		fs.rmSync(path.join(dir, "hold"));
		await until(
			() => readTicks().some((l) => l.includes(" two ")),
			"the new code",
		);
	});
});
