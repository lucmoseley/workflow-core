// @vitest-environment node
/*
 * The code the refill loop runs (#2361): `start` launching from a loop-owned
 * worktree at the verified tip, and a running loop adopting a newer tip by
 * re-exec under its pid. Against fixture repos: a bare origin, a "main
 * checkout" clone the loop's code comes from, and a second clone commits are
 * pushed from.
 *
 * `start` itself runs once, from a checkout holding the real refill-loop.js
 * and its libs, and the loop it spawns is killed as soon as its command line
 * is read.
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
 * that does not load, retries a bad tip every tick, or re-execs under a gate
 * sweep's children.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyLibs, readProgramLibs } from "../lib-closure-fixture.js";
import {
	codeUpdater,
	launchProgram,
	readRunningCode,
	SHA_SHOWN,
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

describe("start", () => {
	it("spawns run from the loop-owned worktree at origin's tip, never the main checkout's working tree", async () => {
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

describe("adoption", () => {
	it("adopts a tip changing its lib at the next tick, under the same pid, holding its lock", async () => {
		const first = await startLoop();
		const pid = loopProc?.pid;
		const kept = ["control.json", "state.json", "gates.json"];
		for (const f of kept)
			fs.writeFileSync(
				path.join(dir, f),
				`{"stopRequested":true,"startedAt":1,"of":"${f}"}\n`,
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
