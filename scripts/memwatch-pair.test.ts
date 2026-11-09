// @vitest-environment node
// Pins that memcheck prints the threshold the watchdog really uses, and that
// memwatch logs its process rows, fires on CPU and process count as well as
// memory, logs each scheduler-clock freeze and clear, rotates its log into an
// age-bounded archive, and kills a process runaway it has watched hold its line.
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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMeminfo } from "./lib/meminfo-fake";
import { writeCgroupRoot } from "./lib/sched-clock-fake";
import { shellQuote } from "./lib/sh-quote.js";

const HOME = os.homedir();
const MEMCHECK = path.join(HOME, "memcheck.sh");
const MEMWATCH = path.join(HOME, "memwatch.sh");
const present = fs.existsSync(MEMCHECK) && fs.existsSync(MEMWATCH);
/* The CPU trigger reads /proc/stat, which CI runners and macOS may not have. */
const hasProc = fs.existsSync("/proc/stat");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memwatch-pair-"));
beforeEach(() => {
	/* Every pass writes the minute line, so no run here may reach the live one. */
	vi.stubEnv("MEMWATCH_MINUTE_LOG", path.join(tmp, "minute.jsonl"));
	vi.stubEnv("MEMWATCH_RUNAWAY_LOG", path.join(tmp, "runaway-default.jsonl"));
	/* Nor may any start a real PowerShell read of Windows memory. */
	vi.stubEnv("MEMWATCH_WIN_READ", "");
	vi.stubEnv("MEMWATCH_WIN_OUT", path.join(tmp, "win-default"));
});
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
	 * Rotation survives a NUL byte in the log (#2669): GNU grep reads such a
	 * file as binary, and `-n` stops listing headers at the NUL.
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
 * The minute line (#3214): one JSON line a pass, written whether or not either
 * trigger fires, so a quiet hour still leaves rows.
 */
describe.skipIf(!hasProc || !present)("memwatch minute line", () => {
	// Memory no process listing shows, from /proc/meminfo (#4641).
	const meminfoFields = [
		"anon_mb",
		"shmem_mb",
		"slab_unreclaim_mb",
		"kernel_stack_mb",
		"page_tables_mb",
		"unevictable_mb",
	];
	function quietPass(name: string, env: Record<string, string> = {}) {
		const minute = path.join(tmp, `${name}.jsonl`);
		const log = path.join(tmp, `${name}.log`);
		execFileSync("bash", [MEMWATCH], {
			env: {
				...process.env,
				MEMWATCH_ONCE: "1",
				MEMWATCH_LOG: log,
				MEMWATCH_MINUTE_LOG: minute,
				MEMWATCH_THRESHOLD_MB: "99999999",
				MEMWATCH_CPU_THRESHOLD_PCT: "99999",
				...env,
			},
			encoding: "utf8",
		});
		return {
			lines: fs.readFileSync(minute, "utf8").trimEnd().split("\n"),
			log,
		};
	}

	it("writes one line with every field on a pass neither trigger fires", () => {
		const { lines, log } = quietPass("minute-quiet");
		expect(fs.existsSync(log)).toBe(false);
		expect(lines).toHaveLength(1);
		const row = JSON.parse(lines[0]);
		expect(Object.keys(row)).toEqual([
			"ts",
			"load1",
			"load5",
			"running",
			"threads",
			"psi_cpu_some",
			"psi_mem_some",
			"psi_mem_full",
			"psi_io_some",
			"psi_io_full",
			"mem_avail_mb",
			...meminfoFields,
			"cpu_busy_pct",
			"cpu_sys_pct",
			"procs",
			"node",
			"guards",
			"vitest",
			"tsc",
			"lander",
			"forks",
			"swap_in",
			"swap_out",
			"refault_file",
			"refault_anon",
			"majfault",
			"allocstall",
			"swap_used_mb",
			"uptime_s",
			"win_avail_mb",
			"win_commit_pct",
			"win_pages_in",
			"win_pages_out",
			"win_age_s",
			"sessions",
			"sched",
		]);
		expect(row.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}$/);
		expect(typeof row.load1).toBe("number");
		// The first pass after a start has no CPU or vmstat delta yet.
		expect(row.cpu_busy_pct).toBeNull();
		expect(row.refault_file).toBeNull();
		expect(row.swap_used_mb).toBeGreaterThanOrEqual(0);
		expect(row.uptime_s).toBeGreaterThan(0);
		// The real kernel reports every breakdown key.
		for (const k of meminfoFields) expect(typeof row[k]).toBe("number");
		// The test's own node process is running.
		expect(row.node).toBeGreaterThan(0);
	});

	it("carries the meminfo breakdown in whole MB", () => {
		const meminfo = path.join(tmp, "meminfo");
		fs.writeFileSync(
			meminfo,
			buildMeminfo(
				{ availableMb: 2000, swapTotalMb: 0, swapFreeMb: 0 },
				{
					AnonPages: 3_145_728,
					Shmem: 1_048_576,
					SUnreclaim: 204_900,
					KernelStack: 20_480,
					PageTables: 51_200,
					Unevictable: 1023,
				},
			),
		);
		const { lines } = quietPass("minute-meminfo", {
			MEMWATCH_MEMINFO: meminfo,
		});
		const row = JSON.parse(lines[0]);
		expect(meminfoFields.map((k) => row[k])).toEqual([
			3072, 1024, 200, 20, 50, 0,
		]);
		expect(row.mem_avail_mb).toBe(2000);
	});

	it("writes null for a meminfo key the kernel does not report", () => {
		const meminfo = path.join(tmp, "meminfo-sparse");
		fs.writeFileSync(
			meminfo,
			buildMeminfo(
				{ availableMb: 2000, swapTotalMb: 0, swapFreeMb: 0 },
				{ Shmem: 1024 },
			),
		);
		const { lines } = quietPass("minute-meminfo-sparse", {
			MEMWATCH_MEMINFO: meminfo,
		});
		const row = JSON.parse(lines[0]);
		expect(meminfoFields.map((k) => row[k])).toEqual([
			null,
			1,
			null,
			null,
			null,
			null,
		]);
	});

	// A freeze the state line misses recomputes from these (#4081).
	it("carries each pass's raw clock readings: epoch, run time ns, busy and total ticks", () => {
		const { lines } = quietPass("minute-sched", {
			// The root's own figure goes unread, so it can differ.
			MEMWATCH_CGROUP_ROOT: writeCgroupRoot(
				path.join(tmp, "minute-sched-root"),
				4e-6,
				1,
			),
		});
		const { sched } = JSON.parse(lines[0]);
		expect(sched).toHaveLength(1);
		const [epoch, runtimeNs, busy, total] = sched[0];
		/* Untraced: only rules out a field in the wrong slot, so generous. */
		const epochSlackS = 120;
		expect(Math.abs(epoch - Date.now() / 1000)).toBeLessThan(epochSlackS);
		expect(runtimeNs).toBe(4000);
		expect(busy).toBeGreaterThan(0);
		expect(total).toBeGreaterThan(busy);
	});

	it("keeps the busy and total ticks, run time null, where no cgroup reads (#4092)", () => {
		const { lines } = quietPass("minute-no-sched", {
			MEMWATCH_CGROUP_ROOT: path.join(tmp, "no-cgroup"),
		});
		const [[, runtimeNs, busy, total]] = JSON.parse(lines[0]).sched;
		expect(runtimeNs).toBeNull();
		expect(busy).toBeGreaterThan(0);
		expect(total).toBeGreaterThan(busy);
	});

	/* A stored Windows reading taken ageS ago: epoch, then the five counters. */
	const reading = (ageS: number) =>
		`${Math.floor(Date.now() / 1000) - ageS} 1344 50538099 32868535 21980766208 33936314368\n`;

	// The guest cannot see Windows paging (#3246), so a background read supplies it (#4159).
	describe("Windows memory", () => {
		it("takes a fresh reading, with no paging delta on its first", () => {
			const out = path.join(tmp, "win-fresh");
			fs.writeFileSync(out, reading(5));
			const { lines } = quietPass("minute-win-fresh", {
				MEMWATCH_WIN_OUT: out,
			});
			const row = JSON.parse(lines[0]);
			expect(row.win_avail_mb).toBe(1344);
			expect(row.win_commit_pct).toBe(64);
			expect(row.win_pages_in).toBeNull();
			expect(row.win_age_s).toBeGreaterThanOrEqual(5);
		});

		it("writes nulls for a reading more than two minutes old", () => {
			const out = path.join(tmp, "win-stale");
			fs.writeFileSync(out, reading(600));
			const { lines } = quietPass("minute-win-stale", {
				MEMWATCH_WIN_OUT: out,
			});
			const row = JSON.parse(lines[0]);
			expect(row.win_avail_mb).toBeNull();
			expect(row.win_age_s).toBeNull();
		});

		// Crosses the real clock: the stamp is the shell's EPOCHSECONDS when the
		// background read exits, which no seam reaches.
		it("starts the next read in the background, stamped once it ends", async () => {
			const out = path.join(tmp, "win-launch");
			const fake = path.join(tmp, "fake-powershell");
			fs.writeFileSync(
				fake,
				"#!/bin/sh\nsleep 1\nprintf '1344 1 2 3 4\\r\\n'\n",
				{
					mode: 0o755,
				},
			);
			const before = Math.floor(Date.now() / 1000);
			quietPass("minute-win-launch", {
				MEMWATCH_WIN_OUT: out,
				MEMWATCH_WIN_READ: fake,
			});
			for (let i = 0; i < 50 && !fs.existsSync(out); i++) await setTimeout(100);
			const [stamp, ...rest] = fs
				.readFileSync(out, "utf8")
				.trimEnd()
				.split(" ");
			expect(rest.join(" ")).toBe("1344 1 2 3 4");
			expect(Number(stamp)).toBeGreaterThanOrEqual(before + 1);
		});

		it("keeps the last good reading when a read fails", async () => {
			const out = path.join(tmp, "win-fail");
			const good = reading(5);
			fs.writeFileSync(out, good);
			const fake = path.join(tmp, "failing-powershell");
			fs.writeFileSync(
				fake,
				"#!/bin/sh\necho 'Get-CimInstance : error' >&2\nexit 1\n",
				{ mode: 0o755 },
			);
			quietPass("minute-win-fail", {
				MEMWATCH_WIN_OUT: out,
				MEMWATCH_WIN_READ: fake,
			});
			await setTimeout(1500);
			expect(fs.readFileSync(out, "utf8")).toBe(good);
		});
	});

	/*
	 * Deltas need a second line. A per-second stamp gives one without a
	 * minute's wait.
	 */
	describe("deltas across lines", () => {
		async function twoLines(name: string, env: Record<string, string> = {}) {
			const minute = path.join(tmp, `${name}.jsonl`);
			const child = spawn("bash", [MEMWATCH], {
				env: {
					...process.env,
					MEMWATCH_LOG: path.join(tmp, `${name}.log`),
					MEMWATCH_MINUTE_LOG: minute,
					MEMWATCH_MINUTE_FMT: "%FT%T",
					MEMWATCH_INTERVAL: "1",
					MEMWATCH_THRESHOLD_MB: "99999999",
					MEMWATCH_CPU_THRESHOLD_PCT: "99999",
					...env,
				},
				stdio: "ignore",
			});
			const read = () =>
				fs.existsSync(minute)
					? fs.readFileSync(minute, "utf8").trimEnd().split("\n")
					: [];
			try {
				for (let i = 0; i < 100 && read().length < 2; i++)
					await setTimeout(100);
			} finally {
				child.kill("SIGKILL");
			}
			return read().map((l) => JSON.parse(l));
		}

		it("writes each vmstat counter's change on the second line", async () => {
			const [, second] = await twoLines("delta-vmstat");
			for (const k of [
				"swap_in",
				"swap_out",
				"refault_file",
				"refault_anon",
				"majfault",
				"allocstall",
			]) {
				expect(second[k]).toBeGreaterThanOrEqual(0);
			}
		});

		it("writes a Windows reading's paging delta on one line only", async () => {
			const out = path.join(tmp, "win-reuse");
			fs.writeFileSync(out, reading(5));
			const [first, second] = await twoLines("delta-win-reuse", {
				MEMWATCH_WIN_OUT: out,
			});
			expect(first.win_avail_mb).toBe(1344);
			expect(second.win_avail_mb).toBe(1344);
			expect(second.win_pages_in).toBeNull();
			expect(second.win_pages_out).toBeNull();
		});

		it("writes the paging change between two readings", async () => {
			const out = path.join(tmp, "win-delta");
			const now = Math.floor(Date.now() / 1000);
			fs.writeFileSync(out, `${now - 30} 1344 1000 2000 50 100\n`);
			const fake = path.join(tmp, "next-powershell");
			fs.writeFileSync(
				fake,
				"#!/bin/sh\nprintf '1300 1100 2500 60 100\\r\\n'\n",
				{ mode: 0o755 },
			);
			const rows = await twoLines("delta-win", {
				MEMWATCH_WIN_OUT: out,
				MEMWATCH_WIN_READ: fake,
			});
			const withDelta = rows.find((r) => r.win_pages_in !== null);
			expect(withDelta).toMatchObject({
				win_avail_mb: 1300,
				win_pages_in: 100,
				win_pages_out: 500,
				win_commit_pct: 60,
			});
		});
	});

	// A restart reads the last line back, so it never writes that minute again.
	it("writes no second line for a minute the file already holds", () => {
		quietPass("minute-restart");
		const { lines } = quietPass("minute-restart");
		const minutes = lines.map((l) => JSON.parse(l).ts.slice(0, 16));
		expect(new Set(minutes).size).toBe(minutes.length);
	});

	// `npm run typecheck` reaches tsc through node_modules/.bin, so argv is
	// `node …/node_modules/.bin/tsc`, never typescript/bin/tsc.
	it("counts a tsc started through node_modules/.bin", async () => {
		const bin = path.join(tmp, "node_modules", ".bin");
		fs.mkdirSync(bin, { recursive: true });
		const tsc = path.join(bin, "tsc");
		fs.writeFileSync(tsc, "setTimeout(() => {}, 30_000);\n");
		// spawn-kept: two processes at once — a live tsc for the watcher to count
		const child = spawn(process.execPath, [tsc], { stdio: "ignore" });
		try {
			await setTimeout(300);
			const { lines } = quietPass("minute-tsc");
			expect(JSON.parse(lines[0]).tsc).toBeGreaterThan(0);
		} finally {
			child.kill();
		}
	});

	it("writes null sessions, not a wrong count, when the session lib is missing", () => {
		const { lines } = quietPass("minute-nolib", {
			MEMWATCH_SESSIONS_LIB: path.join(tmp, "absent.sh"),
		});
		expect(JSON.parse(lines[0]).sessions).toBeNull();
	});

	it("drops lines older than MEMWATCH_MINUTE_DAYS", () => {
		const ts = (daysAgo: number) => {
			const d = new Date(Date.now() - daysAgo * 86_400_000);
			const p = (n: number) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+0000`;
		};
		const kept = `{"ts":"${ts(2)}","load1":1}`;
		fs.writeFileSync(
			path.join(tmp, "minute-prune.jsonl"),
			`{"ts":"${ts(5)}","load1":1}\n{"ts":"${ts(4)}","load1":1}\n${kept}\n`,
		);
		const { lines } = quietPass("minute-prune", { MEMWATCH_MINUTE_DAYS: "3" });
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(kept);
	});

	// A rewrite a day, not one a minute once the file is full.
	it("leaves a line less than a day past MEMWATCH_MINUTE_DAYS in place", () => {
		const d = new Date(Date.now() - 3.5 * 86_400_000);
		const p = (n: number) => String(n).padStart(2, "0");
		const aged = `{"ts":"${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+0000","load1":1}`;
		fs.writeFileSync(path.join(tmp, "minute-slack.jsonl"), `${aged}\n`);
		const { lines } = quietPass("minute-slack", { MEMWATCH_MINUTE_DAYS: "3" });
		expect(lines[0]).toBe(aged);
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
	 * The sampler's PREV_* delta state must survive each iteration, or no CPU
	 * figure exists and the trigger never fires (mantahostels#1953) — so never
	 * read it through `read < <(cpu_pct)`, whose subshell discards that state. A single
	 * block proves it did.
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
 * The scheduler-clock line (#2779). MEMWATCH_CGROUP_ROOT points at a symlink: to
 * a tree that never moves, the clock reads frozen while a spinner keeps the
 * real /proc/stat busy; re-pointed at the real cgroup root, it runs again, which
 * holds the fake to the real files (code-standards §G7).
 */
const CGROUP_ROOT = "/sys/fs/cgroup";
/* Long enough that the one spinner alone clears the 2 CPU-s busy floor. */
const PASS_S = "3";
describe.skipIf(
	!hasProc || !present || !fs.existsSync(`${CGROUP_ROOT}/cpu.stat`),
)("memwatch scheduler-clock line", () => {
	/*
	 * Real time, as the CPU trigger's cases are: memwatch differences two
	 * passes PASS_S apart, and the spinner is what makes /proc/stat busy, so
	 * each wait returns the moment its line lands.
	 */
	it("logs the onset and the clear, each dated, whatever the thresholds (#2779)", async () => {
		const still = writeCgroupRoot(path.join(tmp, "cgroup-still"), 0.001, 0);
		const link = path.join(tmp, "cgroup-link");
		fs.symlinkSync(still, link);
		const log = path.join(tmp, "sched.log");
		const child = spawn("bash", [MEMWATCH], {
			env: {
				...process.env,
				MEMWATCH_LOG: log,
				MEMWATCH_INTERVAL: PASS_S,
				MEMWATCH_THRESHOLD_MB: "99999999",
				MEMWATCH_CPU_THRESHOLD_PCT: "99999",
				MEMWATCH_CGROUP_ROOT: link,
			},
		});
		const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
		const waitFor = async (re: RegExp) => {
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline && !re.test(read())) await setTimeout(250);
		};
		const spinner = spawn("sh", ["-c", "while :; do :; done"]);
		try {
			await waitFor(/sched clock: frozen/);
			fs.rmSync(link);
			fs.symlinkSync(CGROUP_ROOT, link);
			await waitFor(/sched clock: running/);
		} finally {
			spinner.kill("SIGKILL");
			child.kill("SIGKILL");
		}
		const lines = read().trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(
			/^--- sched clock: frozen \d{4}-\d\d-\d\d \d\d:\d\d:\d\d: tasks ran 0\.00 s over \d+\.\d\d busy CPU-s ---$/,
		);
		expect(lines[1]).toMatch(/^--- sched clock: running \d{4}-/);
	});
});

/*
 * Memwatch is a shell script and the check a Node one, so the shared figures can
 * only be pinned as text.
 */
describe.skipIf(!present)("the two frozen-clock detectors (#4092)", () => {
	it("apply the same ratio and the same busy floor", () => {
		const script = fs.readFileSync(MEMWATCH, "utf8");
		const check = fs.readFileSync(
			path.join(__dirname, "check-kernel-stall.js"),
			"utf8",
		);
		const figure = (text: string, re: RegExp) => {
			const value = Number(text.match(re)?.[1]);
			expect(value).toBeGreaterThan(0);
			return value;
		};
		expect(figure(script, /^SCHED_MIN_BUSY_TICKS=(\d+)$/m)).toBe(
			figure(check, /^const MIN_BUSY_S = ([\d.]+);$/m) * 100,
		);
		expect(figure(script, /^SCHED_FROZEN_PCT=(\d+)$/m)).toBe(
			figure(check, /^const FROZEN_RATIO = ([\d.]+);$/m) * 100,
		);
	});
});

/*
 * The process-count trigger (#3402). The sleepers fork in a capped scope, so a
 * fault here cannot reach the machine's own pids cap.
 */
const hasScope = (() => {
	if (!hasProc || !present) return false;
	try {
		execFileSync("systemd-run", ["--user", "--scope", "--quiet", "true"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();
/* Past the shipped 2,000 default by more than the machine's own ~100-400. */
const SLEEPERS = 2500;
/* The sleepers, their bash and 100 tasks of slack. */
const SCOPE_TASKS = SLEEPERS + 100;
/*
 * Seconds the scope may live: the case's own bound, so a sleeper this file
 * fails to stop dies with it. 2,500 forks take ~5 s here.
 */
const SCOPE_S = 120;

describe.skipIf(!hasScope)("memwatch process-count trigger", () => {
	it(
		"names the sleepers' command and their parent past the threshold",
		async () => {
			const unit = `memwatch-forks-${process.pid}.scope`;
			const marker = `memwatch-fork-fixture-${process.pid}`;
			const forker = spawn(
				"systemd-run",
				[
					"--user",
					"--scope",
					"--quiet",
					`--unit=${unit}`,
					"-p",
					`TasksMax=${SCOPE_TASKS}`,
					"-p",
					`RuntimeMaxSec=${SCOPE_S}`,
					"bash",
					"-c",
					`: ${marker}; for _ in $(seq ${SLEEPERS}); do sleep 3402 & done; echo ready; wait`,
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			try {
				await new Promise<void>((resolve, reject) => {
					forker.stdout.on("data", (b) => {
						if (String(b).includes("ready")) resolve();
					});
					forker.on("exit", () => reject(new Error("forker exited early")));
				});
				const log = path.join(tmp, "procs.log");
				// The shipped default threshold, never one inherited from the shell.
				const { MEMWATCH_PROCS_THRESHOLD: _, ...env } = process.env;
				execFileSync("bash", [MEMWATCH], {
					env: {
						...env,
						MEMWATCH_ONCE: "1",
						MEMWATCH_LOG: log,
						MEMWATCH_THRESHOLD_MB: "99999999",
						MEMWATCH_CPU_THRESHOLD_PCT: "99999",
					},
					encoding: "utf8",
				});
				const lines = fs.readFileSync(log, "utf8").trimEnd().split("\n");
				const head = lines.findIndex((l) =>
					/^--- \d+ processes \| top commands by process count ---$/.test(l),
				);
				expect(head).toBeGreaterThan(-1);
				expect(Number(lines[head].split(" ")[1])).toBeGreaterThan(SLEEPERS);
				expect(lines[head + 2]).toMatch(
					new RegExp(`^ +${SLEEPERS} sleep 3402$`),
				);
				const parents = lines.indexOf("--- top parents by direct children ---");
				expect(parents).toBeGreaterThan(head);
				// The parent's whole argv, never cut to the block's 110 columns.
				expect(lines[parents + 2]).toMatch(
					new RegExp(
						`^ *\\d+ +${SLEEPERS} \\S*bash -c : ${marker};.* echo ready; wait$`,
					),
				);
			} finally {
				try {
					execFileSync("systemctl", ["--user", "stop", unit], {
						stdio: "ignore",
					});
				} catch {
					// Already gone: RuntimeMaxSec ended it, or it never started.
				}
				forker.kill("SIGKILL");
			}
		},
		SCOPE_S * 1000,
	);

	/*
	 * Real time, as the CPU trigger's cases are: the cooldown is read off the
	 * clock between passes 1 s apart, and 60 s is never shortened to test it.
	 */
	it("logs one block a cooldown however many passes cross the threshold", async () => {
		const log = path.join(tmp, "procs-cooldown.log");
		const child = spawn("bash", [MEMWATCH], {
			env: {
				...process.env,
				MEMWATCH_LOG: log,
				MEMWATCH_INTERVAL: "1",
				MEMWATCH_THRESHOLD_MB: "99999999",
				MEMWATCH_CPU_THRESHOLD_PCT: "99999",
				MEMWATCH_PROCS_THRESHOLD: "0",
			},
		});
		try {
			await setTimeout(3500);
		} finally {
			child.kill("SIGKILL");
		}
		const out = fs.readFileSync(log, "utf8");
		expect(out.match(/^--- \d+ processes \|/gm)).toHaveLength(1);
	});
});

/*
 * The runaway kill (#3807). MEMWATCH_RUNAWAY_ONLY confines every case to its own
 * marker, so a real process on this shared machine cannot be in a group, however
 * low the thresholds. The marker is a number, so `sleep` takes it as a duration.
 */
/* Comfortably above the largest fixture here, 211 tasks and their shell. */
const FIXTURE_TASKS = 400;
/* Far past a window of 2 s; a case that waits this long has already failed. */
const FIRE_BOUND_MS = 30_000;
/* A kill is seen within a scheduling slice; this only rides out a loaded machine. */
const SETTLE_BOUND_MS = 10_000;

describe.skipIf(!hasScope)("memwatch process runaway", () => {
	const marker = `3807.${process.pid}`;
	let nth = 0;
	interface Firing {
		ts: string;
		since: string;
		procs: number;
		argv: string;
		size: number;
		parents: { pid: number; kids: number; argv: string }[];
		killed: number[];
	}

	/** Runs `script` in a capped scope, resolving once it prints `ready`. */
	async function inScope<T>(script: string, body: () => Promise<T>) {
		const unit = `memwatch-runaway-${process.pid}-${nth++}.scope`;
		const scope = spawn(
			"systemd-run",
			[
				"--user",
				"--scope",
				"--quiet",
				`--unit=${unit}`,
				"-p",
				`TasksMax=${FIXTURE_TASKS}`,
				"-p",
				`RuntimeMaxSec=${SCOPE_S}`,
				"bash",
				"-c",
				script,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			await new Promise<void>((resolve, reject) => {
				scope.stdout.on("data", (b) => {
					if (String(b).includes("ready")) resolve();
				});
				scope.on("exit", () => reject(new Error("scope exited early")));
			});
			return await body();
		} finally {
			try {
				execFileSync("systemctl", ["--user", "stop", unit], {
					stdio: "ignore",
				});
			} catch {
				// Already gone: RuntimeMaxSec ended it, or it never started.
			}
			scope.kill("SIGKILL");
		}
	}

	const logs = () => {
		const id = nth++;
		return {
			log: path.join(tmp, `runaway-${id}.log`),
			runaway: path.join(tmp, `runaway-${id}.jsonl`),
		};
	};
	const firings = (file: string): Firing[] =>
		fs.existsSync(file)
			? fs
					.readFileSync(file, "utf8")
					.trimEnd()
					.split("\n")
					.map((l) => JSON.parse(l))
			: [];
	const quietEnv = (log: string, runaway: string) => ({
		...process.env,
		MEMWATCH_LOG: log,
		MEMWATCH_RUNAWAY_LOG: runaway,
		MEMWATCH_INTERVAL: "1",
		MEMWATCH_THRESHOLD_MB: "99999999",
		MEMWATCH_CPU_THRESHOLD_PCT: "99999",
		MEMWATCH_RUNAWAY_ONLY: marker,
		MEMWATCH_RUNAWAY_PROCS: "1",
		MEMWATCH_RUNAWAY_GROUP: "30",
	});
	/** One pass, firing at once. */
	const firePass = (log: string, runaway: string) =>
		execFileSync("bash", [MEMWATCH], {
			env: {
				...quietEnv(log, runaway),
				MEMWATCH_ONCE: "1",
				MEMWATCH_RUNAWAY_WINDOW_S: "0",
			},
			encoding: "utf8",
		});
	/** The loop until `until` holds, or the fire bound. */
	async function loopUntil(
		env: Record<string, string | undefined>,
		until: () => boolean,
	) {
		const child = spawn("bash", [MEMWATCH], { env });
		try {
			const deadline = Date.now() + FIRE_BOUND_MS;
			while (Date.now() < deadline && !until()) await setTimeout(100);
		} finally {
			child.kill("SIGKILL");
		}
	}
	const alive = (pid: number) => {
		try {
			// A killed link may stay a zombie until its parent reaps it.
			return !/^\d+ \(.*\) Z /.test(
				fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
			);
		} catch {
			return false;
		}
	};
	/* A SIGKILLed task dies when next scheduled, so a loaded machine may still
	 * list it just after the signal. */
	async function settles(check: () => boolean) {
		const deadline = Date.now() + SETTLE_BOUND_MS;
		while (Date.now() < deadline && !check()) await setTimeout(50);
		return check();
	}
	const running = (pattern: string) => {
		try {
			return Number(
				execFileSync("pgrep", ["-fc", pattern], { encoding: "utf8" }),
			);
		} catch {
			return 0; // pgrep exits 1 on no match
		}
	};

	it(
		"kills a chain of one argv held past the window, naming its argv and pids",
		async () => {
			const chain = path.join(tmp, "chain.sh");
			// The links' argv is identical; each waits on the next, as ap.sh's did.
			fs.writeFileSync(
				chain,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion written into a .sh file, not a JS placeholder
				'N=$((${N:-40} - 1)); export N\nif [ "$N" -gt 0 ]; then bash "$0" "$1" & wait; else echo ready; sleep 300; fi\n',
			);
			const { log, runaway } = logs();
			const argv = `bash ${chain} ${marker}`;
			await inScope(`exec bash ${shellQuote(chain)} ${marker}`, async () => {
				await loopUntil(
					{ ...quietEnv(log, runaway), MEMWATCH_RUNAWAY_WINDOW_S: "2" },
					() => firings(runaway).length > 0,
				);
				const [line, ...rest] = firings(runaway);
				expect(rest).toEqual([]);
				expect(line.argv).toBe(argv);
				expect(line.size).toBe(40);
				expect(line.killed).toHaveLength(40);
				expect(await settles(() => !line.killed.some(alive))).toBe(true);
				expect(line.procs).toBeGreaterThan(40);
				// Each link has one child, and its parent reads the same argv.
				expect(line.parents.map((p) => p.kids)).toContain(1);
				expect(fs.readFileSync(log, "utf8")).toMatch(
					/^--- \d+ processes \| top commands by process count ---$/m,
				);
			});
		},
		SCOPE_S * 1000,
	);

	it(
		"keeps killing a group that respawns, every line under one episode",
		async () => {
			const { log, runaway } = logs();
			const argv = `sleep ${marker}1`;
			await inScope(
				`while :; do for _ in $(seq 40); do ${argv} & done; echo ready; wait; done`,
				() =>
					loopUntil(
						{ ...quietEnv(log, runaway), MEMWATCH_RUNAWAY_WINDOW_S: "1" },
						() => firings(runaway).length > 1,
					),
			);
			const lines = firings(runaway);
			expect(lines.length).toBeGreaterThan(1);
			expect(new Set(lines.map((l) => l.since)).size).toBe(1);
			for (const l of lines) expect(l.killed.length).toBeGreaterThan(0);
		},
		SCOPE_S * 1000,
	);

	it(
		"reports a varied fan-out once and kills none of it",
		async () => {
			const { log, runaway } = logs();
			const seconds = `${marker}2`;
			await inScope(
				`for i in $(seq 40); do sleep ${seconds}$i & done; echo ready; wait`,
				async () => {
					const child = spawn("bash", [MEMWATCH], {
						env: { ...quietEnv(log, runaway), MEMWATCH_RUNAWAY_WINDOW_S: "0" },
					});
					try {
						await setTimeout(3500);
					} finally {
						child.kill("SIGKILL");
					}
					const lines = firings(runaway);
					expect(lines).toHaveLength(1);
					expect(lines[0].killed).toEqual([]);
					expect(lines[0].size).toBe(1);
					expect(running(`^sleep ${seconds}`)).toBe(40);
				},
			);
		},
		SCOPE_S * 1000,
	);

	it(
		"fires nothing on a count that drops before the window, restarting it from zero",
		async () => {
			const { log, runaway } = logs();
			const env = {
				...quietEnv(log, runaway),
				MEMWATCH_RUNAWAY_PROCS: "300",
				MEMWATCH_RUNAWAY_WINDOW_S: "2",
				MEMWATCH_RUNAWAY_ONLY: `no-process-holds-${marker}`,
				// Six passes, never holding two intervals; then a hold.
				MEMWATCH_PROCS_READINGS: "500 500 0 500 500 0 500",
			};
			// Real time: the window counts passes a real sleep apart, and a pass's
			// `since` is the only record of which one the hold began on.
			const started = Math.floor(Date.now() / 1000);
			await loopUntil(env, () => firings(runaway).length > 0);
			const [line, ...rest] = firings(runaway);
			expect(rest).toEqual([]);
			// One 1-s sleep follows each of the six passes before the hold begins.
			expect(Date.parse(line.since) / 1000 - started).toBeGreaterThanOrEqual(6);
			expect(
				Date.parse(line.ts) / 1000 - Date.parse(line.since) / 1000,
			).toBeGreaterThanOrEqual(2);
		},
		SCOPE_S * 1000,
	);

	it(
		"sweeps a link forked after the scan, so the chain cannot regrow",
		async () => {
			const chain = path.join(tmp, "forking-chain.sh");
			// Each link forks one successor 50 ms on, so a leaf is always about to
			// fork; the scope's task cap ends it if nothing else does.
			fs.writeFileSync(
				chain,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion written into a .sh file, not a JS placeholder
				'[ -n "${READY:-}" ] || { READY=1; export READY; echo ready; }\nsleep 0.05; bash "$0" "$1" & wait\n',
			);
			const { log, runaway } = logs();
			const seeded = `bash ${chain} ${marker}5`;
			await inScope(`exec bash ${shellQuote(chain)} ${marker}5`, async () => {
				await settles(() => running(`^${seeded}$`) >= 30);
				firePass(log, runaway);
				const [line] = firings(runaway);
				expect(line.argv).toBe(seeded);
				expect(line.killed.length).toBeGreaterThanOrEqual(30);
				expect(await settles(() => running(`^${seeded}$`) === 0)).toBe(true);
			});
		},
		SCOPE_S * 1000,
	);

	it(
		"never kills a Claude process, however large its group",
		async () => {
			const { log, runaway } = logs();
			const seconds = `${marker}3`;
			const plain = `sleep ${seconds}`;
			await inScope(
				`for _ in $(seq 60); do (exec -a claude sleep ${seconds}) & (exec -a /x/claude/versions/2.1.234 sleep ${seconds}) & (exec -a '/mnt/c/Program Files/claude.exe' sleep ${seconds}) & done
				for _ in $(seq 31); do ${plain} & done; echo ready; wait`,
				async () => {
					firePass(log, runaway);
					const [line] = firings(runaway);
					expect(line.argv).toBe(plain);
					expect(line.killed).toHaveLength(31);
					expect(running(`^claude ${seconds}`)).toBe(60);
					expect(running(`^/x/claude/versions/2.1.234 ${seconds}`)).toBe(60);
					expect(running(`^/mnt/c/Program Files/claude.exe ${seconds}`)).toBe(
						60,
					);
					expect(await settles(() => running(`^${plain}`) === 0)).toBe(true);
					// Only Claude groups left: a line that says so, and no kill.
					const after = logs();
					firePass(after.log, after.runaway);
					const [only] = firings(after.runaway);
					// All that is left outside them is the scope's own one shell.
					expect(only.size).toBe(1);
					expect(only.killed).toEqual([]);
					expect(running(`^claude ${seconds}`)).toBe(60);
				},
			);
		},
		SCOPE_S * 1000,
	);

	it(
		"writes valid JSON for an argv with quotes, backslashes and control characters",
		async () => {
			const { log, runaway } = logs();
			const argv = `a"b\\c\u0001d`;
			await inScope(
				`for _ in $(seq 31); do (exec -a $'a"b\\\\c\\001d' sleep ${marker}4) & done; echo ready; wait`,
				async () => {
					firePass(log, runaway);
					expect(firings(runaway)[0].argv).toBe(`${argv} ${marker}4`);
				},
			);
		},
		SCOPE_S * 1000,
	);

	it("drops firing lines older than MEMWATCH_MINUTE_DAYS when it writes one", () => {
		const { log, runaway } = logs();
		const ts = (daysAgo: number) =>
			new Date(Date.now() - daysAgo * 86_400_000)
				.toISOString()
				.replace(/\.\d+Z$/, "+0000");
		const old = `{"ts":"${ts(40)}","since":"${ts(40)}","killed":[]}`;
		fs.writeFileSync(runaway, `${old}\n`);
		firePass(log, runaway);
		expect(fs.readFileSync(runaway, "utf8")).not.toContain(old);
		expect(firings(runaway)).toHaveLength(1);
	});
});
