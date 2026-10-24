// @vitest-environment node
// Pins that memcheck prints the threshold the watchdog really uses, and that
// memwatch logs its process rows and fires on CPU as well as memory.
// Drives the two home-directory watchdog scripts (~/memcheck.sh, ~/memwatch.sh)
// from outside, per mantahostels#544's testing decisions: fabricated sources in, printed
// output asserted. Skips wherever the scripts are absent — CI runners carry
// neither.
// Break it and `memcheck`, where CLAUDE.md sends a session whose build died
// with no error, reports a threshold or a culprit the watchdog never used.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";

const HOME = os.homedir();
const MEMCHECK = path.join(HOME, "memcheck.sh");
const MEMWATCH = path.join(HOME, "memwatch.sh");
const present = fs.existsSync(MEMCHECK) && fs.existsSync(MEMWATCH);
/* The CPU trigger reads /proc/stat, which CI runners and macOS may not have. */
const hasProc = fs.existsSync("/proc/stat");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memwatch-pair-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runMemcheckLine(watchdogSrc: string): string {
	return execFileSync("bash", [MEMCHECK, "--memwatch-line"], {
		env: { ...process.env, MEMCHECK_WATCHDOG_SRC: watchdogSrc },
		encoding: "utf8",
	});
}

describe.skipIf(!present)("memcheck threshold line", () => {
	it("derives the printed threshold from the watchdog source at run time", () => {
		const src = path.join(tmp, "fabricated-memwatch.sh");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion written into a fabricated .sh file, not a JS placeholder
		fs.writeFileSync(src, 'THRESHOLD_MB="${MEMWATCH_THRESHOLD_MB:-4321}"\n');
		const out = runMemcheckLine(src);
		expect(out).toContain("memwatch: ACTIVE");
		expect(out).toContain("4321 MB");
	});

	// Pins the parser to the real watchdog file: a reformat of its THRESHOLD_MB
	// line would otherwise degrade memcheck to the no-number form while every
	// fabricated-source test stayed green.
	it("parses a number out of the real watchdog source", () => {
		const out = execFileSync("bash", [MEMCHECK, "--memwatch-line"], {
			encoding: "utf8",
		});
		expect(out).toMatch(/exceeds \d+ MB\./);
	});

	it("prints no number when the watchdog source is unreadable", () => {
		const out = runMemcheckLine(path.join(tmp, "no-such-file.sh"));
		expect(out).toContain("memwatch: ACTIVE");
		expect(out).not.toMatch(/\d+\s*MB/);
	});

	// Runs the whole report to confirm the guards section calls the line
	// builder; only the ACTIVE branch prints a threshold, so skipped where the
	// service is down.
	const serviceActive = (() => {
		if (!present) return false;
		try {
			execFileSync("systemctl", [
				"--user",
				"is-active",
				"--quiet",
				"memwatch.service",
			]);
			return true;
		} catch {
			return false;
		}
	})();

	it.skipIf(!serviceActive)("full report prints the derived threshold", () => {
		const src = path.join(tmp, "fabricated-memwatch-full.sh");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion written into a fabricated .sh file, not a JS placeholder
		fs.writeFileSync(src, 'THRESHOLD_MB="${MEMWATCH_THRESHOLD_MB:-4321}"\n');
		const out = execFileSync("bash", [MEMCHECK], {
			env: { ...process.env, MEMCHECK_WATCHDOG_SRC: src },
			encoding: "utf8",
		});
		expect(out).toContain("4321 MB");
	});
});

describe.skipIf(!present)("memwatch incident block", () => {
	// The listing reads /proc itself (#2669), so nothing can be stubbed: these
	// rows are the machine's own, which always runs more than six tasks.
	it("carries the six largest processes by RSS after a header", () => {
		const log = path.join(tmp, "memwatch.log");
		execFileSync("bash", [MEMWATCH], {
			env: {
				...process.env,
				MEMWATCH_ONCE: "1",
				MEMWATCH_LOG: log,
				MEMWATCH_THRESHOLD_MB: "0",
			},
			encoding: "utf8",
		});
		const lines = fs.readFileSync(log, "utf8").trimEnd().split("\n");
		expect(lines[0]).toMatch(/^=== /);
		expect(lines[1]).toContain("PID");
		const processRows = lines.slice(2);
		expect(processRows).toHaveLength(6);
		const rss = processRows.map((r) => {
			expect(r).toMatch(/^ *\d+ +\d+ \S/);
			expect(r.length).toBeLessThanOrEqual(110);
			return Number(r.trim().split(/ +/)[1]);
		});
		expect(rss).toEqual([...rss].sort((a, b) => b - a));
	});

	/*
	 * Rotation survives a NUL byte in the log (#2669). A torn write left NULs in
	 * ~/memwatch.log, after which GNU grep reads the file as binary: `-c` still
	 * counted every header, but `-n` stopped listing them at the NUL, so every
	 * rotation announced "kept last 200" and kept the whole log.
	 */
	it("trims to ROTATE_KEEP blocks when the log holds NUL bytes", () => {
		const log = path.join(tmp, "rotate-nul.log");
		const block = (i: number) =>
			`=== 2026-10-23 07:${String(i).padStart(2, "0")}:00 9000MB used ===\n    PID   RSS COMMAND\n    ${i} 1000 proc\n`;
		const blocks = Array.from({ length: 12 }, (_, i) => block(i));
		// The NUL run sits early, before every header the trim must find.
		blocks[1] = blocks[1].replace("proc", "pr\0\0\0\0oc");
		fs.writeFileSync(log, blocks.join(""));
		execFileSync("bash", [MEMWATCH], {
			env: {
				...process.env,
				MEMWATCH_ONCE: "1",
				MEMWATCH_LOG: log,
				MEMWATCH_THRESHOLD_MB: "0",
				MEMWATCH_ROTATE_AT: "10",
				MEMWATCH_ROTATE_KEEP: "4",
			},
			encoding: "utf8",
		});
		const out = fs.readFileSync(log, "latin1");
		expect(out.split("\n")[0]).toMatch(
			/^--- rotated .*kept last 4 of 13 blocks ---$/,
		);
		expect(out.match(/^=== /gm)).toHaveLength(4);
		expect(out).not.toContain("\0");
		expect(out).toContain("07:09:00");
		expect(out).not.toContain("07:08:00");
	});
});

/*
 * The CPU trigger (mantahostels#1953). The memory trigger alone recorded NOTHING for the
 * episode that opened that ticket — 553-778% of the 800% ceiling at ~4.2 GB
 * used, far below THRESHOLD_MB — so these assert that CPU fires the block on its
 * own, and that it stays quiet when it should.
 *
 * Every case drives the real ~/memwatch.sh with an unreachable memory threshold,
 * so only the CPU limb can be what fires. Two passes are needed before any CPU
 * figure exists at all: /proc/stat is a counter, so the first pass has no delta.
 */
describe.skipIf(!hasProc || !present)("memwatch CPU trigger", () => {
	/*
	 * `untilLogged` is what makes these deterministic. A fixed sleep flaked once
	 * on the machine this ticket is about: the watchdog needs two passes before a
	 * delta exists, and under load bash's own startup can eat a 4 s window. So a
	 * case expecting a block WAITS for one and returns the moment it lands, while
	 * a case expecting silence has nothing to wait for and serves out the window.
	 *
	 * Awaited, never spun. A busy-wait would peg a core for every case — which on
	 * a ticket about CPU saturation is self-defeating, and perturbs the very
	 * reading the watchdog is taking.
	 */
	async function runLoop(
		env: Record<string, string>,
		{ untilLogged = false, ms = 15_000 } = {},
	) {
		const log = path.join(
			tmp,
			`cpu-${Math.random().toString(36).slice(2)}.log`,
		);
		const child = spawn("bash", [MEMWATCH], {
			env: {
				...process.env,
				MEMWATCH_LOG: log,
				MEMWATCH_INTERVAL: "1",
				// Unreachable, so the memory limb can never be what fired.
				MEMWATCH_THRESHOLD_MB: "99999999",
				...env,
			},
		});
		const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			await setTimeout(250);
			if (untilLogged && /^=== /m.test(read())) break;
		}
		const out = read();
		/*
		 * Whether the watchdog was still alive at the end. A case asserting
		 * SILENCE would otherwise pass on an empty string a dead or never-started
		 * process left behind — it would assert nothing at all (F6).
		 */
		const alive = child.exitCode === null && child.signalCode === null;
		child.kill("SIGKILL");
		return { out, alive };
	}

	it("fires a block on CPU alone, with memory far below its threshold", async () => {
		const { out } = await runLoop(
			{ MEMWATCH_CPU_THRESHOLD_PCT: "0" },
			{ untilLogged: true },
		);
		expect(out).toMatch(/^=== /m);
		expect(out).toMatch(/cpu: \d+% busy of \d+%/);
	});

	it("splits system, nice and user rather than logging one busy figure", async () => {
		const { out } = await runLoop(
			{ MEMWATCH_CPU_THRESHOLD_PCT: "0" },
			{ untilLogged: true },
		);
		// nice is where a Claude session's CPU lands; user alone reads as idle.
		expect(out).toMatch(/sys \d+%, nice \d+%, user \d+%/);
		expect(out).toMatch(/load \d/);
	});

	it("stays silent below its threshold rather than logging every pass", async () => {
		const { out, alive } = await runLoop(
			{ MEMWATCH_CPU_THRESHOLD_PCT: "99999" },
			{ ms: 4000 },
		);
		// Silence only means something if the watchdog was running to produce it.
		expect(alive).toBe(true);
		expect(out).not.toMatch(/^=== /m);
	});

	/*
	 * The bug this pins, found while building mantahostels#1953: reading the sampler through
	 * `read < <(cpu_pct)` ran it in a subshell, so its PREV_* delta state was
	 * discarded every iteration and no CPU figure was ever available — the
	 * trigger could not fire at all. A single block proves the state survived.
	 */
	it("carries its delta state across iterations", async () => {
		const { out } = await runLoop(
			{ MEMWATCH_CPU_THRESHOLD_PCT: "0" },
			{ untilLogged: true },
		);
		expect(out.match(/^=== /gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
	});
});
