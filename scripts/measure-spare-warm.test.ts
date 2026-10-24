// @vitest-environment node
/*
 * Pins how the spare-warm harness finds a new bg-spare spawn in the daemon
 * logs and times the host-and-spare pair's RSS to a plateau, reporting `gone`
 * or `timeout` rather than a figure it never reached.
 *
 * The program is driven end to end, in-process through lib/run-in-process.js's
 * `runInProcessAsync`, against a fake `/proc` (WFC_PROC) and fake daemon logs
 * under fake config dirs (mantahostels#2588), and read through its `--json`
 * reading or its printed one. Every case goes through `--watch`, never a
 * helper the program keeps to itself (#1369, §G6: nothing is exported only for
 * its tests). Nothing here launches a session or reads the real process tree:
 * `--probe` is a founder call, and a test that could fire one would spend an
 * allowance nobody asked it to.
 *
 * Its reading sets `WFC_DISPATCH_STAGGER_SECONDS` in `dispatch-sessions.sh`:
 * a figure timed short lets the next member's admission miss memory the
 * previous launch is still taking, on a machine that freezes past 10 GB.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "measure-spare-warm.js");

/** How often the program samples, as its header documents it. */
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

/** The environment an in-process run needs to see the fakes above. */
function runEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		WFC_PROC: procRoot,
		/* CLAUDE_CONFIG_DIR too, and it is the load-bearing one: `sessionDirs`
		 * always puts THIS session's own config dir first, whatever the three
		 * WFC_ vars say (lib/arbiter-core.js). Without it every case here also
		 * reads the machine's live daemon.log, and a real spawn lands mid-test. */
		CLAUDE_CONFIG_DIR: path.join(dir, "a"),
		WFC_CLAUDE_CONFIG_A: path.join(dir, "a"),
		WFC_CLAUDE_CONFIG_B: path.join(dir, "b"),
		WFC_CLAUDE_CONFIG_C: path.join(dir, "b"),
	};
}

/** A fake `/proc/<pid>/statm`, whose second field is resident pages. */
function statm(pid: number, mb: number) {
	fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
	fs.writeFileSync(
		path.join(procRoot, String(pid), "statm"),
		`999999 ${Math.round((mb * 1024 * 1024) / 4096)} 1 1 0 1 0\n`,
	);
}

/** A fake `/proc/<pid>/stat`, whose fourth field is the parent pid. The comm
 * field carries a space and a `)` on purpose: the parser must read past the
 * LAST `)`, not the first. */
function stat(pid: number, ppid: number) {
	fs.mkdirSync(path.join(procRoot, String(pid)), { recursive: true });
	fs.writeFileSync(
		path.join(procRoot, String(pid), "stat"),
		`${pid} (claude bg-spare (x)) S ${ppid} 1 1 0 -1 4194304\n`,
	);
}

const logA = () => path.join(dir, "a", "daemon.log");

/** The daemon's refill line, stamped now unless told otherwise. */
const spawnLine = (pid: number, at = new Date().toISOString()) =>
	`[${at}] [bg] bg spare spawned host pid=${pid}\n`;

/** One `--watch --json` run, with its reading parsed where it printed one. */
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
		/* No such process in the fake tree, so the reading ends `gone` at once —
		 * what is pinned is which spawn it read. */
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
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(222)), 200);
		expect((await watch(4)).reading.pid).toBe(222);
	});

	it("watches every config dir, not only the first", async () => {
		fs.writeFileSync(logA(), "");
		const other = path.join(dir, "b", "daemon.log");
		fs.writeFileSync(other, "");
		setTimeout(() => fs.appendFileSync(other, spawnLine(333)), 200);
		const { reading } = await watch(4);
		expect(reading.pid).toBe(333);
		expect(reading.log).toBe(other);
	});

	/* Giving up at the deadline is "exits 1 and says so where no spare was
	 * spawned in the window", under the script itself below. */

	it("re-baselines a truncated log instead of throwing", async () => {
		fs.writeFileSync(logA(), "x".repeat(5000));
		setTimeout(() => fs.writeFileSync(logA(), ""), 150);
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(444)), 500);
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
					spawnLine(900, new Date(Date.now() - 1000).toISOString()),
				),
			200,
		);
		const r = await watch(10);
		expect(r.status).toBe(0);
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(50);
		// The RSS never moved, so the plateau began at the first sample — about a
		// second after the spawn this case back-dated.
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
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(901)), 50);
		const r = await watch(14);
		clearInterval(climb);
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(90);
	});

	it("says `gone` where the process exits before it settles", async () => {
		fs.writeFileSync(logA(), "");
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(902)), 100);
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
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(903)), 50);
		const r = await watch(1.5);
		clearInterval(climb);
		expect(r.status).toBe(1);
		expect(r.reading.verdict).toBe("timeout");
		expect(r.reading.secondsToPlateau).toBeNull();
	});
});

/* mantahostels#2588. Timing the logged host alone reports a plateau before the memory
 * lands, and would set the stagger far too short. That the host and its
 * bg-spare child are summed is "reports the pair's plateau", under the script
 * itself below. */
describe("the pair, not the logged process (mantahostels#2588)", () => {
	it("counts a child that appears after the first sample", async () => {
		fs.writeFileSync(logA(), "");
		statm(1100, 90);
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(1100)), 50);
		// The fork lands two samples into the timing, exactly as a real one does.
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
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(1200)), 50);
		const r = await watch(10);
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(90);
	});

	it("is gone once the host itself is, however many children linger", async () => {
		fs.writeFileSync(logA(), "");
		statm(1301, 410);
		stat(1301, 1300);
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(1300)), 50);
		const r = await watch(4);
		expect(r.reading.verdict).toBe("gone");
		expect(r.reading.plateauMb).toBeNull();
	});
});

/* mantahostels#2588. A spawn line can straddle two reads. */
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
		// The other config dir has no log, so only this one was being read.
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

/* mantahostels#2588. `--probe` is never driven here — it would spend a real allowance — so
 * only the paths that reach a verdict without one are. */
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

	/* #1346: a bare trailing --prompt crashed in spawn with a TypeError rather than refusing. */
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
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(2000)), 200);
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
		setTimeout(() => fs.appendFileSync(logA(), spawnLine(2100)), 200);
		const r = await watch(20);
		expect(r.status).toBe(0);
		expect(r.reading.pid).toBe(2100);
		expect(r.reading.mode).toBe("watch");
		expect(r.reading.verdict).toBe("plateau");
		expect(r.reading.plateauMb).toBe(400);
		// Never a probe binary on a watch: nothing was launched.
		expect(r.reading.probeBin).toBeNull();
	});
});
