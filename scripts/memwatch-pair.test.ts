// @vitest-environment node
// Pins that memcheck prints the threshold the watchdog really uses, and that
// memwatch logs its process rows, fires on CPU as well as memory, logs each
// scheduler-clock freeze and clear, and rotates its log into an age-bounded
// archive.
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
	 * Headers are stamped back from now in local time, as `date` writes them,
	 * so the archive's age bound sees them as fresh.
	 */
	const stamp = (minutesAgo: number) => {
		const d = new Date(Date.now() - minutesAgo * 60_000);
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};
	const block = (i: number, at = stamp(60 - i)) =>
		`=== ${at} 9000MB used ===\n    PID   RSS COMMAND\n    ${i} 1000 proc-${i}\n`;
	const twelve = () => Array.from({ length: 12 }, (_, i) => block(i));
	function rotate(
		name: string,
		{
			blocks = twelve(),
			archived = "",
			archive = path.join(tmp, `${name}-archive.log`),
		} = {},
	) {
		const log = path.join(tmp, `${name}.log`);
		fs.writeFileSync(log, blocks.join(""));
		if (archived) fs.writeFileSync(archive, archived);
		execFileSync("bash", [MEMWATCH], {
			env: {
				...process.env,
				MEMWATCH_ONCE: "1",
				MEMWATCH_LOG: log,
				MEMWATCH_ARCHIVE: archive,
				MEMWATCH_THRESHOLD_MB: "0",
				MEMWATCH_ROTATE_AT: "10",
				MEMWATCH_ROTATE_KEEP: "4",
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const read = (f: string) =>
			fs.statSync(f).isFile() ? fs.readFileSync(f, "latin1") : "";
		return { out: read(log), archive: read(archive) };
	}

	/*
	 * Rotation survives a NUL byte in the log (#2669). A torn write left NULs in
	 * ~/memwatch.log, after which GNU grep reads the file as binary: `-c` still
	 * counted every header, but `-n` stopped listing them at the NUL, so the trim
	 * kept the whole log.
	 */
	it("trims to ROTATE_KEEP blocks when the log holds NUL bytes", () => {
		const blocks = twelve();
		// The NUL run sits early, before every header the trim must find.
		blocks[1] = blocks[1].replace("proc-1", "pr\0\0\0\0oc-1");
		const { out, archive } = rotate("rotate-nul", { blocks });
		expect(out.split("\n")[0]).toMatch(
			/^--- rotated .*kept last 4 of 13 blocks ---$/,
		);
		expect(out.match(/^=== /gm)).toHaveLength(4);
		expect(out).not.toContain("\0");
		expect(out).toContain("proc-9");
		expect(out).not.toContain("proc-8");
		expect(archive).not.toContain("\0");
	});

	// #2741
	it("moves the blocks a rotation trims to the archive, in order", () => {
		const blocks = twelve();
		const archived = block(99, stamp(120));
		const { out, archive } = rotate("rotate-archive", {
			blocks: [
				`--- rotated ${stamp(90)}: kept last 4 of 13 blocks ---\n`,
				...blocks,
			],
			archived,
		});
		expect(archive).toBe(archived + blocks.slice(0, 9).join(""));
		expect((archive + out).match(/^=== /gm)).toHaveLength(14);
	});

	// A pass killed between the append and the cut leaves blocks in both files.
	it("archives no block already there, so a re-run keeps it in order", () => {
		const blocks = twelve();
		const archived = blocks.slice(0, 5).join("");
		const { archive } = rotate("rotate-rerun", { blocks, archived });
		expect(archive).toBe(blocks.slice(0, 9).join(""));
	});

	it("leaves the live log uncut when the archive cannot be written", () => {
		// A directory, so the append fails.
		const { out } = rotate("rotate-unwritable", { archive: tmp });
		expect(out).not.toContain("--- rotated");
		expect(out.match(/^=== /gm)).toHaveLength(13);
	});

	it("drops archived blocks older than MEMWATCH_ARCHIVE_DAYS", () => {
		const day = 24 * 60;
		const kept = block(99, stamp(27 * day));
		const { archive } = rotate("rotate-prune", {
			archived: block(97, stamp(30 * day)) + block(98, stamp(29 * day)) + kept,
		});
		expect(archive.startsWith(kept)).toBe(true);
		expect(archive).toContain("proc-8");
	});
});

/*
 * The CPU trigger (mantahostels#1953): these assert that CPU fires the block on
 * its own, and that it stays quiet when it should. Two passes are needed before
 * any CPU figure exists at all: /proc/stat is a counter, so the first pass has
 * no delta.
 */
describe.skipIf(!hasProc || !present)("memwatch CPU trigger", () => {
	/*
	 * `until` is what makes these deterministic: a case expecting a block WAITS
	 * for one and returns the moment it lands, while a case expecting silence
	 * has nothing to wait for and serves out the window. Awaited, never spun.
	 */
	async function runLoop(
		env: Record<string, string>,
		{ until, ms = 15_000 }: { until?: RegExp; ms?: number } = {},
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
			if (until?.test(read())) break;
		}
		const out = read();
		/*
		 * Whether the watchdog was still alive at the end. A case asserting
		 * SILENCE would otherwise pass on an empty string a dead or never-started
		 * process left behind.
		 */
		const alive = child.exitCode === null && child.signalCode === null;
		child.kill("SIGKILL");
		return { out, alive };
	}

	it("fires a block on CPU alone, with memory far below its threshold", async () => {
		const { out } = await runLoop(
			{ MEMWATCH_CPU_THRESHOLD_PCT: "0" },
			{ until: /^=== /m },
		);
		expect(out).toMatch(/^=== /m);
		expect(out).toMatch(/cpu: \d+% busy of \d+%/);
	});

	it("splits system, nice and user rather than logging one busy figure", async () => {
		const { out } = await runLoop(
			{ MEMWATCH_CPU_THRESHOLD_PCT: "0" },
			{ until: /^=== /m },
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
		expect(alive).toBe(true);
		expect(out).not.toMatch(/^=== /m);
	});

	/*
	 * The bug this pins (mantahostels#1953): reading the sampler through
	 * `read < <(cpu_pct)` ran it in a subshell, so its PREV_* delta state was discarded every iteration and
	 * no CPU figure was ever available — the trigger could not fire at all. A
	 * single block proves the state survived.
	 */
	it("carries its delta state across iterations", async () => {
		const { out } = await runLoop(
			{ MEMWATCH_CPU_THRESHOLD_PCT: "0" },
			{ until: /^=== /m },
		);
		expect(out.match(/^=== /gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
	});

	/*
	 * A fake `top` printing every row at 0.0 in pid order goes first on PATH,
	 * so a sample still taken from `top` fails here.
	 */
	it("ranks the busiest tasks by measured %CPU, never by `top` (#2686)", async () => {
		const bin = path.join(tmp, "fake-top");
		fs.mkdirSync(bin, { recursive: true });
		const frame = [
			"top - 21:01:35 up 1 day,  2 users,  load average: 151.00",
			"    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND",
			...[1, 2, 3, 4, 5, 6, 7, 8].map(
				(p) =>
					`      ${p} root      20   0       0      0      0 S   0.0   0.0   0:00.00 init`,
			),
		].join("\n");
		fs.writeFileSync(
			path.join(bin, "top"),
			`#!/bin/sh\ncat <<'EOF'\n${frame}\n${frame}\nEOF\n`,
			{ mode: 0o755 },
		);
		const spinner = spawn("sh", ["-c", "while :; do :; done"]);
		try {
			const { out } = await runLoop(
				{
					MEMWATCH_CPU_THRESHOLD_PCT: "0",
					PATH: `${bin}:${process.env.PATH}`,
				},
				{ until: /^ *PID S +%CPU .*\n(.*\n){8}/m },
			);
			const lines = out.split("\n");
			const head = lines.findIndex((l) => /^ *PID S +%CPU /.test(l));
			expect(head).toBeGreaterThan(-1);
			const rows = lines.slice(head + 1, head + 9).map((r) => {
				expect(r.length).toBeLessThanOrEqual(110);
				const [pid, , pct] = r.trim().split(/ +/);
				return { pid: Number(pid), pct: Number(pct) };
			});
			expect(rows).toHaveLength(8);
			const pcts = rows.map((r) => r.pct);
			expect(pcts[0]).toBeGreaterThan(0);
			expect(pcts).toEqual([...pcts].sort((a, b) => b - a));
			expect(rows.map((r) => r.pid)).toContain(spinner.pid);
		} finally {
			spinner.kill("SIGKILL");
		}
	});
});

/*
 * The scheduler-clock line (#2779). MEMWATCH_SCHEDSTAT points at a symlink: to
 * a file that never moves, the clock reads frozen while a spinner keeps the
 * real /proc/stat busy; re-pointed at /proc/schedstat, it runs again.
 */
describe.skipIf(!hasProc || !present || !fs.existsSync("/proc/schedstat"))(
	"memwatch scheduler-clock line",
	() => {
		/*
		 * Real time, as the CPU trigger's cases are: memwatch differences two
		 * passes 1 s apart, and the spinner is what makes /proc/stat busy, so
		 * each wait returns the moment its line lands.
		 */
		it("logs the onset and the clear, each dated, whatever the thresholds (#2779)", async () => {
			const still = path.join(tmp, "schedstat-still");
			fs.writeFileSync(still, "version 17\ncpu0 0 0 0 0 0 0 1000 0 0\n");
			const link = path.join(tmp, "schedstat-link");
			fs.symlinkSync(still, link);
			const log = path.join(tmp, "sched.log");
			const child = spawn("bash", [MEMWATCH], {
				env: {
					...process.env,
					MEMWATCH_LOG: log,
					MEMWATCH_INTERVAL: "1",
					MEMWATCH_THRESHOLD_MB: "99999999",
					MEMWATCH_CPU_THRESHOLD_PCT: "99999",
					MEMWATCH_SCHEDSTAT: link,
				},
			});
			const read = () =>
				fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
			const waitFor = async (re: RegExp) => {
				const deadline = Date.now() + 15_000;
				while (Date.now() < deadline && !re.test(read())) await setTimeout(250);
			};
			const spinner = spawn("sh", ["-c", "while :; do :; done"]);
			try {
				await waitFor(/sched clock: frozen/);
				fs.rmSync(link);
				fs.symlinkSync("/proc/schedstat", link);
				await waitFor(/sched clock: running/);
			} finally {
				spinner.kill("SIGKILL");
				child.kill("SIGKILL");
			}
			const lines = read().trimEnd().split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatch(
				/^--- sched clock: frozen \d{4}-\d\d-\d\d \d\d:\d\d:\d\d: run queues advanced 0\.00 s over \d+\.\d\d busy CPU-s ---$/,
			);
			expect(lines[1]).toMatch(/^--- sched clock: running \d{4}-/);
		});
	},
);
