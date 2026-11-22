// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ADMITTED_AUTH,
	buildAuthStatusBranch,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./lib/auth-status-fake";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "measure-spare-warm.js");

const SAMPLE_MS = 250;

let dir: string;
let procRoot: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-spare-warm-"));
	procRoot = path.join(dir, "proc");
	fs.mkdirSync(procRoot, { recursive: true });
	fs.mkdirSync(path.join(dir, "a"), { recursive: true });
	fs.mkdirSync(path.join(dir, "b"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function runEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		WFC_PROC: procRoot,
		CLAUDE_CONFIG_DIR: path.join(dir, "a"),
		WFC_CLAUDE_CONFIG_A: path.join(dir, "a"),
		WFC_CLAUDE_CONFIG_B: path.join(dir, "b"),
		WFC_CLAUDE_CONFIG_C: path.join(dir, "b"),
	};
}

function statm(pid: number, mb: number) {
	fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
	fs.writeFileSync(
		path.join(procRoot, String(pid), "statm"),
		`999999 ${Math.round((mb * 1024 * 1024) / 4096)} 1 1 0 1 0\n`,
	);
}

function stat(pid: number, ppid: number) {
	fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
	fs.writeFileSync(
		path.join(procRoot, String(pid), "stat"),
		`${pid} (claude bg-spare (x)) S ${ppid} 1 1 0 -1 4194304\n`,
	);
}

const logA = () => path.join(dir, "a", "daemon.log");

const buildSpawnLine = (pid: number, at = new Date().toISOString()) =>
	`[${at}] [bg] bg spare spawned host pid=${pid}\n`;

async function watch(timeoutSeconds: number) {
	const r = await runInProcessAsync(
		SCRIPT,
		["--watch", "--timeout-seconds", String(timeoutSeconds), "--json"],
		{ env: runEnv() },
	);
	return { ...r, reading: r.stdout ? JSON.parse(r.stdout) : null };
}

describe("the daemon-log spawn line (mantahostels#2588)", () => {
	it("reads the pid and the timestamp off a real line", async () => {
		fs.writeFileSync(logA(), "");
		setTimeout(
			() =>
				fs.appendFileSync(
					logA(),
					"[2026-09-02T09:33:04.883Z] [bg] bg spare spawned host pid=2699405\n",
				),
			200,
		);
		const { reading } = await watch(4);
		expect(reading.pid).toBe(2_699_405);
		expect(reading.spawnedAt).toBe("2026-09-02T09:33:04.883Z");
	});

	for (const [what, line] of [
		[
			"the claim line that precedes it",
			"[2026-09-02T09:33:04.871Z] [bg] bg claimed-spare 02fff7fe (shell)\n",
		],
		[
			"a settled line",
			"[2026-09-02T09:34:15.621Z] [bg] bg settled 6985b38d (killed)\n",
		],
	]) {
		it(`does not match ${what}`, async () => {
			fs.writeFileSync(logA(), "");
			setTimeout(() => fs.appendFileSync(logA(), line), 100);
			const r = await watch(0.6);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("no spare was spawned");
		});
	}
});

describe("finding the next spawn (mantahostels#2588)", () => {
	it("ignores what the log already held and reports only a new line", async () => {
		fs.writeFileSync(
			logA(),
			"[2026-09-02T08:00:00.000Z] [bg] bg spare spawned host pid=111\n",
		);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(222)), 200);
		expect((await watch(4)).reading.pid).toBe(222);
	});

	it("watches every config dir, not only the first", async () => {
		fs.writeFileSync(logA(), "");
		const other = path.join(dir, "b", "daemon.log");
		fs.writeFileSync(other, "");
		setTimeout(() => fs.appendFileSync(other, buildSpawnLine(333)), 200);
		const { reading } = await watch(4);
		expect(reading.pid).toBe(333);
		expect(reading.log).toBe(other);
	});

	it("re-baselines a truncated log instead of throwing", async () => {
		fs.writeFileSync(logA(), "x".repeat(5000));
		setTimeout(() => fs.writeFileSync(logA(), ""), 150);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(444)), 500);
		expect((await watch(4)).reading.pid).toBe(444);
	});
});

describe("timing the plateau (mantahostels#2588)", () => {
	it("reports the wait from the spawn to the first steady sample", async () => {
		fs.writeFileSync(logA(), "");
		statm(900, 50);
		setTimeout(
			() =>
				fs.appendFileSync(
					logA(),
					buildSpawnLine(900, new Date(Date.now() - 1000).toISOString()),
				),
			200,
		);
		const r = await watch(10);
		expect(r.status).toBe(0);
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(50);
		expect(r.reading.secondsToPlateau).toBeGreaterThanOrEqual(0.9);
		expect(r.reading.secondsToPlateau).toBeLessThan(2.5);
	});

	it("waits out a climbing RSS rather than calling it settled", async () => {
		fs.writeFileSync(logA(), "");
		statm(901, 10);
		let mb = 10;
		const climb = setInterval(() => {
			mb += 20;
			statm(901, mb);
			if (mb >= 90) clearInterval(climb);
		}, SAMPLE_MS);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(901)), 50);
		const r = await watch(14);
		clearInterval(climb);
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(90);
	});

	it("says `gone` where the process exits before it settles", async () => {
		fs.writeFileSync(logA(), "");
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(902)), 100);
		const r = await watch(4);
		expect(r.status).toBe(1);
		expect(r.reading.verdict).toBe("gone");
		expect(r.reading.secondsToPlateau).toBeNull();
	});

	it("says `timeout` rather than reporting a figure it never reached", async () => {
		fs.writeFileSync(logA(), "");
		statm(903, 10);
		let mb = 10;
		const climb = setInterval(() => {
			mb += 50;
			statm(903, mb);
		}, SAMPLE_MS);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(903)), 50);
		const r = await watch(1.5);
		clearInterval(climb);
		expect(r.status).toBe(1);
		expect(r.reading.verdict).toBe("timeout");
		expect(r.reading.secondsToPlateau).toBeNull();
	});
});

describe("the pair, not the logged process (mantahostels#2588)", () => {
	it("counts a child that appears after the first sample", async () => {
		fs.writeFileSync(logA(), "");
		statm(1100, 90);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(1100)), 50);
		setTimeout(
			() => {
				statm(1101, 300);
				stat(1101, 1100);
			},
			50 + SAMPLE_MS * 3,
		);
		const r = await watch(14);
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(390);
	});

	it("ignores a process that is not this host's child", async () => {
		fs.writeFileSync(logA(), "");
		statm(1200, 90);
		statm(1201, 410);
		stat(1201, 999);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(1200)), 50);
		const r = await watch(10);
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(90);
	});

	it("is gone once the host itself is, however many children linger", async () => {
		fs.writeFileSync(logA(), "");
		statm(1301, 410);
		stat(1301, 1300);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(1300)), 50);
		const r = await watch(4);
		expect(r.reading.verdict).toBe("gone");
		expect(r.reading.plateauMb).toBeNull();
	});
});

describe("a spawn line split across two reads (mantahostels#2588)", () => {
	it("carries the unterminated half forward and matches the joined line", async () => {
		fs.writeFileSync(logA(), "");
		setTimeout(
			() =>
				fs.appendFileSync(
					logA(),
					"[2026-09-02T09:00:00.000Z] [bg] bg spare spa",
				),
			200,
		);
		setTimeout(() => fs.appendFileSync(logA(), "wned host pid=555\n"), 700);
		expect((await watch(6)).reading.pid).toBe(555);
	});

	it("says a log went rather than skipping it in silence for the rest of the run", async () => {
		const log = logA();
		fs.writeFileSync(log, "");
		const r = await runInProcessAsync(
			SCRIPT,
			["--watch", "--timeout-seconds", "1"],
			{ env: runEnv() },
		);
		expect(r.status).toBe(1);
		fs.rmSync(log);
		const r2 = await runInProcessAsync(
			SCRIPT,
			["--watch", "--timeout-seconds", "1"],
			{ env: runEnv() },
		);
		expect(r2.status).toBe(2);
		expect(r2.stderr).toContain("no daemon.log");
	});
});

describe("the script itself (mantahostels#2588)", () => {
	it("refuses --watch and --probe together, and refuses neither, each with usage on stderr", async () => {
		fs.writeFileSync(logA(), "");
		const both = await runInProcessAsync(SCRIPT, ["--watch", "--probe"], {
			env: runEnv(),
		});
		expect(both.status).toBe(2);
		expect(both.stderr).toContain("usage:");
		const neither = await runInProcessAsync(SCRIPT, [], { env: runEnv() });
		expect(neither.status).toBe(2);
		expect(neither.stderr).toContain("usage:");
	});

	it("refuses a --timeout-seconds that is not a positive number", async () => {
		fs.writeFileSync(logA(), "");
		for (const bad of ["soon", "0", "-5"]) {
			const r = await runInProcessAsync(
				SCRIPT,
				["--watch", "--timeout-seconds", bad],
				{ env: runEnv() },
			);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("--timeout-seconds must be a positive number");
		}
	});

	it("refuses a --prompt with no value before any probe launches", async () => {
		fs.writeFileSync(logA(), "");
		const r = await runInProcessAsync(SCRIPT, ["--probe", "--prompt"], {
			env: runEnv(),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^--prompt needs a value\n/);
	});

	it("refuses a machine with no daemon.log at all, rather than waiting out the timeout", async () => {
		const r = await runInProcessAsync(
			SCRIPT,
			["--watch", "--timeout-seconds", "600"],
			{ env: runEnv() },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no daemon.log");
	});

	it("exits 1 and says so where no spare was spawned in the window", async () => {
		fs.writeFileSync(logA(), "");
		const r = await runInProcessAsync(
			SCRIPT,
			["--watch", "--timeout-seconds", "1"],
			{ env: runEnv() },
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no spare was spawned");
	});

	it("reports the pair's plateau, and names the pid as the pty-host's", async () => {
		fs.writeFileSync(logA(), "");
		statm(2000, 80);
		statm(2001, 320);
		stat(2001, 2000);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(2000)), 200);
		const r = await runInProcessAsync(
			SCRIPT,
			["--watch", "--timeout-seconds", "20"],
			{ env: runEnv() },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("pty-host pid       2000");
		expect(r.stdout).toContain("plateau RSS        400 MB (the pair)");
		expect(r.stdout).toContain("WFC_DISPATCH_STAGGER_SECONDS");
	});

	it("emits the same reading as JSON under --json", async () => {
		fs.writeFileSync(logA(), "");
		statm(2100, 80);
		statm(2101, 320);
		stat(2101, 2100);
		setTimeout(() => fs.appendFileSync(logA(), buildSpawnLine(2100)), 200);
		const r = await watch(20);
		expect(r.status).toBe(0);
		expect(r.reading.pid).toBe(2100);
		expect(r.reading.mode).toBe("watch");
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(400);
		expect(r.reading.probeBin).toBeNull();
	});
});

describe("the probe's auth (#2236)", () => {
	const bgCalls = () => path.join(dir, "bg-calls");
	const probe = (env: Record<string, string> = {}) => {
		const stub = path.join(dir, "claude");
		fs.writeFileSync(
			stub,
			`#!/bin/bash\n${buildAuthStatusBranch()}\necho "$*" >> ${shellQuote(bgCalls())}\n`,
			{ mode: 0o755 },
		);
		fs.writeFileSync(logA(), "");
		return runInProcessAsync(SCRIPT, ["--probe", "--timeout-seconds", "1"], {
			env: { ...runEnv(), WFC_CLAUDE_BIN: stub, ...env },
		});
	};

	it.each(REFUSED_AUTH)(
		"refuses under %s, before any probe launches",
		async (name, env) => {
			const r = await probe(env);
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(new RegExp(`^REFUSED: .*${name} is set`));
			expect(fs.existsSync(bgCalls())).toBe(false);
		},
	);

	it("refuses an apiKeyHelper in the seat's settings", async () => {
		writeSeatHelper(path.join(dir, "a"));
		const r = await probe();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("apiKeyHelper");
		expect(fs.existsSync(bgCalls())).toBe(false);
	});

	it.each(ADMITTED_AUTH)("launches the probe on %s", async (_name, env) => {
		const r = await probe(env);
		expect(r.status).toBe(1);
		expect(fs.readFileSync(bgCalls(), "utf8")).toMatch(/^--bg /);
	});
});
