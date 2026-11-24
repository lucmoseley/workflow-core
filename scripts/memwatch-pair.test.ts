// @vitest-environment node
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ignoreFailure } from "./lib/caught.js";
import { dataOrThrow, readText } from "./lib/file-read.js";
import { keptSpawn } from "./lib/kept-spawn.js";
import { buildMeminfo } from "./lib/meminfo-fake";
import { noop } from "./lib/noop.js";
import { writeCgroupRoot } from "./lib/sched-clock-fake";
import { shellQuote } from "./lib/sh-quote.js";

// #4982
const UNTRACED_ENV = { ...process.env, WFC_READ_AUDIT_UNTRACED: "1" };

const HOME = os.homedir();
const MEMCHECK = path.join(HOME, "memcheck.sh");
const MEMWATCH = path.join(HOME, "memwatch.sh");
const present = fs.existsSync(MEMCHECK) && fs.existsSync(MEMWATCH);
const hasProc = fs.existsSync("/proc/stat");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memwatch-pair-"));
vi.setConfig({ maxConcurrency: 64 });

const memwatch = (env: NodeJS.ProcessEnv) =>
	promisify(execFile)("bash", [MEMWATCH], { env });

const baseEnv: NodeJS.ProcessEnv = {
	...UNTRACED_ENV,
	MEMWATCH_MINUTE_LOG: path.join(tmp, "minute.jsonl"),
	MEMWATCH_RUNAWAY_LOG: path.join(tmp, "runaway-default.jsonl"),
	MEMWATCH_WIN_READ: "",
	MEMWATCH_WIN_OUT: path.join(tmp, "win-default"),
};

const PASS_STAMP = "%FT%T";
const lineCount = (file: string) =>
	fs.existsSync(file)
		? fs.readFileSync(file, "utf8").split("\n").length - 1
		: 0;
// guess: far past any wait here, #4804
const WAIT_BOUND_MS = 30_000;
// guess: a twentieth of a 1 s pass, #4804
const POLL_MS = 50;
async function loopPasses(env: NodeJS.ProcessEnv, minute: string, n: number) {
	const child = spawn("bash", [MEMWATCH], {
		env: {
			...env,
			MEMWATCH_MINUTE_LOG: minute,
			MEMWATCH_MINUTE_FMT: PASS_STAMP,
		},
	});
	try {
		const deadline = Date.now() + WAIT_BOUND_MS;
		while (lineCount(minute) < n) {
			if (Date.now() > deadline) throw new Error(`pass ${n} never began`);
			await setTimeout(POLL_MS);
		}
		return child.exitCode === null && child.signalCode === null;
	} finally {
		child.kill("SIGKILL");
	}
}
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function runMemcheckLine(watchdogSrc: string): string {
	return execFileSync("bash", [MEMCHECK, "--memwatch-line"], {
		env: { ...UNTRACED_ENV, MEMCHECK_WATCHDOG_SRC: watchdogSrc },
		encoding: "utf8",
	});
}

describe.skipIf(!present).concurrent("memcheck threshold line", () => {
	it("derives the printed threshold from the watchdog source at run time", () => {
		const src = path.join(tmp, "fabricated-memwatch.sh");
		fs.writeFileSync(src, `THRESHOLD_MB="\${MEMWATCH_THRESHOLD_MB:-4321}"\n`);
		const out = runMemcheckLine(src);
		expect(out).toContain("memwatch: ACTIVE");
		expect(out).toContain("4321 MB");
	});

	it("parses a number out of the real watchdog source", () => {
		const out = execFileSync("bash", [MEMCHECK, "--memwatch-line"], {
			env: UNTRACED_ENV,
			encoding: "utf8",
		});
		expect(out).toMatch(/exceeds \d+ MB\./);
	});

	it("prints no number when the watchdog source is unreadable", () => {
		const out = runMemcheckLine(path.join(tmp, "no-such-file.sh"));
		expect(out).toContain("memwatch: ACTIVE");
		expect(out).not.toMatch(/\d+\s*MB/);
	});

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
		fs.writeFileSync(src, `THRESHOLD_MB="\${MEMWATCH_THRESHOLD_MB:-4321}"\n`);
		const out = execFileSync("bash", [MEMCHECK], {
			env: { ...UNTRACED_ENV, MEMCHECK_WATCHDOG_SRC: src },
			encoding: "utf8",
		});
		expect(out).toContain("4321 MB");
	});
});

describe.skipIf(!present).concurrent("memwatch incident block", () => {
	it("carries the six largest processes by RSS after a header", async () => {
		const log = path.join(tmp, "memwatch.log");
		await memwatch({
			...baseEnv,
			MEMWATCH_ONCE: "1",
			MEMWATCH_LOG: log,
			MEMWATCH_THRESHOLD_MB: "0",
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

	const stamp = (minutesAgo: number) => {
		const d = new Date(Date.now() - minutesAgo * 60_000);
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};
	const block = (i: number, at = stamp(60 - i)) =>
		`=== ${at} 9000MB used ===\n    PID   RSS COMMAND\n    ${i} 1000 proc-${i}\n`;
	const twelve = () => Array.from({ length: 12 }, (_, i) => block(i));
	async function rotate(
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
		await memwatch({
			...baseEnv,
			MEMWATCH_ONCE: "1",
			MEMWATCH_LOG: log,
			MEMWATCH_ARCHIVE: archive,
			MEMWATCH_THRESHOLD_MB: "0",
			MEMWATCH_ROTATE_AT: "10",
			MEMWATCH_ROTATE_KEEP: "4",
		});
		const read = (f: string) =>
			fs.statSync(f).isFile() ? fs.readFileSync(f, "latin1") : "";
		return { out: read(log), archive: read(archive) };
	}

	it("trims to ROTATE_KEEP blocks when the log holds NUL bytes", async () => {
		const blocks = twelve();
		blocks[1] = blocks[1].replace("proc-1", "pr\0\0\0\0oc-1");
		const { out, archive } = await rotate("rotate-nul", { blocks });
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
	it("moves the blocks a rotation trims to the archive, in order", async () => {
		const blocks = twelve();
		const archived = block(99, stamp(120));
		const { out, archive } = await rotate("rotate-archive", {
			blocks: [
				`--- rotated ${stamp(90)}: kept last 4 of 13 blocks ---\n`,
				...blocks,
			],
			archived,
		});
		expect(archive).toBe(archived + blocks.slice(0, 9).join(""));
		expect((archive + out).match(/^=== /gm)).toHaveLength(14);
	});

	it("archives no block already there, so a re-run keeps it in order", async () => {
		const blocks = twelve();
		const archived = blocks.slice(0, 5).join("");
		const { archive } = await rotate("rotate-rerun", { blocks, archived });
		expect(archive).toBe(blocks.slice(0, 9).join(""));
	});

	it("leaves the live log uncut when the archive cannot be written", async () => {
		const { out } = await rotate("rotate-unwritable", { archive: tmp });
		expect(out).not.toContain("--- rotated");
		expect(out.match(/^=== /gm)).toHaveLength(13);
	});

	it("drops archived blocks older than MEMWATCH_ARCHIVE_DAYS", async () => {
		const day = 24 * 60;
		const kept = block(99, stamp(27 * day));
		const { archive } = await rotate("rotate-prune", {
			archived: block(97, stamp(30 * day)) + block(98, stamp(29 * day)) + kept,
		});
		expect(archive.startsWith(kept)).toBe(true);
		expect(archive).toContain("proc-8");
	});
});

describe.skipIf(!hasProc || !present).concurrent("memwatch minute line", () => {
	const meminfoFields = [
		"anon_mb",
		"file_mb",
		"shmem_mb",
		"slab_reclaim_mb",
		"slab_unreclaim_mb",
		"kernel_stack_mb",
		"page_tables_mb",
		"unevictable_mb",
	];
	async function quietPass(name: string, env: Record<string, string> = {}) {
		const minute = path.join(tmp, `${name}.jsonl`);
		const log = path.join(tmp, `${name}.log`);
		await memwatch({
			...baseEnv,
			MEMWATCH_ONCE: "1",
			MEMWATCH_LOG: log,
			MEMWATCH_MINUTE_LOG: minute,
			MEMWATCH_THRESHOLD_MB: "99999999",
			MEMWATCH_CPU_THRESHOLD_PCT: "99999",
			...env,
		});
		return {
			lines: fs.readFileSync(minute, "utf8").trimEnd().split("\n"),
			log,
		};
	}

	it("writes one line with every field on a pass neither trigger fires", async () => {
		const { lines, log } = await quietPass("minute-quiet");
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
			"mem_free_mb",
			...meminfoFields,
			"loop_peak_mb",
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
			"win_idle_s",
			"win_pages_in",
			"win_pages_out",
			"win_age_s",
			"sessions",
			"sched",
		]);
		expect(row.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}$/);
		expect(typeof row.load1).toBe("number");
		expect(row.cpu_busy_pct).toBeNull();
		expect(row.refault_file).toBeNull();
		expect(row.swap_used_mb).toBeGreaterThanOrEqual(0);
		expect(row.uptime_s).toBeGreaterThan(0);
		for (const k of meminfoFields) expect(typeof row[k]).toBe("number");
		expect(row.node).toBeGreaterThan(0);
	});

	it("carries the meminfo breakdown in whole MB", async () => {
		const meminfo = path.join(tmp, "meminfo");
		fs.writeFileSync(
			meminfo,
			buildMeminfo(
				{ availableMb: 2000, freeMb: 600, swapTotalMb: 0, swapFreeMb: 0 },
				{
					AnonPages: 3_145_728,
					Cached: 1_048_000,
					Buffers: 1048,
					Shmem: 1_048_576,
					SReclaimable: 512_000,
					SUnreclaim: 204_900,
					KernelStack: 20_480,
					PageTables: 51_200,
					Unevictable: 1023,
				},
			),
		);
		const { lines } = await quietPass("minute-meminfo", {
			MEMWATCH_MEMINFO: meminfo,
		});
		const row = JSON.parse(lines[0]);
		expect(meminfoFields.map((k) => row[k])).toEqual([
			3072, 1024, 1024, 500, 200, 20, 50, 0,
		]);
		expect(row).toMatchObject({ mem_avail_mb: 2000, mem_free_mb: 600 });
	});

	it("writes null for a meminfo key the kernel does not report", async () => {
		const meminfo = path.join(tmp, "meminfo-sparse");
		fs.writeFileSync(
			meminfo,
			buildMeminfo(
				{ availableMb: 2000, swapTotalMb: 0, swapFreeMb: 0 },
				{ Shmem: 1024, Buffers: 2048 },
			),
		);
		const { lines } = await quietPass("minute-meminfo-sparse", {
			MEMWATCH_MEMINFO: meminfo,
		});
		const row = JSON.parse(lines[0]);
		expect(meminfoFields.map((k) => row[k])).toEqual([
			null,
			2,
			1,
			null,
			null,
			null,
			null,
			null,
		]);
	});

	it("carries the refill loop boot unit's memory.peak in whole MB, null where it has none", async () => {
		const root = path.join(tmp, "minute-loop-peak-root");
		const unit = path.join(
			root,
			`user.slice/user-${os.userInfo().uid}.slice/user@${os.userInfo().uid}.service/app.slice/refill-loop-boot.service`,
		);
		fs.mkdirSync(unit, { recursive: true });
		fs.writeFileSync(path.join(unit, "memory.peak"), "4123561984\n");
		const [held, none] = await Promise.all([
			quietPass("minute-loop-peak", { MEMWATCH_CGROUP_ROOT: root }),
			quietPass("minute-loop-peak-none", {
				MEMWATCH_CGROUP_ROOT: path.join(tmp, "minute-loop-peak-absent"),
			}),
		]);
		expect(JSON.parse(held.lines[0]).loop_peak_mb).toBe(3932);
		expect(JSON.parse(none.lines[0]).loop_peak_mb).toBeNull();
	});

	it("carries each pass's raw clock readings: epoch, run time ns, busy and total ticks", async () => {
		const { lines } = await quietPass("minute-sched", {
			MEMWATCH_CGROUP_ROOT: writeCgroupRoot(
				path.join(tmp, "minute-sched-root"),
				4e-6,
				1,
			),
		});
		const { sched } = JSON.parse(lines[0]);
		expect(sched).toHaveLength(1);
		const [epoch, runtimeNs, busy, total] = sched[0];
		// guess: only rules out a field in the wrong slot, #4081
		const epochSlackS = 120;
		expect(Math.abs(epoch - Date.now() / 1000)).toBeLessThan(epochSlackS);
		expect(runtimeNs).toBe(4000);
		expect(busy).toBeGreaterThan(0);
		expect(total).toBeGreaterThan(busy);
	});

	it("keeps the busy and total ticks, run time null, where no cgroup reads (#4092)", async () => {
		const { lines } = await quietPass("minute-no-sched", {
			MEMWATCH_CGROUP_ROOT: path.join(tmp, "no-cgroup"),
		});
		const [[, runtimeNs, busy, total]] = JSON.parse(lines[0]).sched;
		expect(runtimeNs).toBeNull();
		expect(busy).toBeGreaterThan(0);
		expect(total).toBeGreaterThan(busy);
	});

	const reading = (ageS: number) =>
		`${Math.floor(Date.now() / 1000) - ageS} 1344 50538099 32868535 21980766208 33936314368 1250\n`;

	describe("Windows memory", () => {
		it("takes a fresh reading, with no paging delta on its first", async () => {
			const out = path.join(tmp, "win-fresh");
			fs.writeFileSync(out, reading(5));
			const { lines } = await quietPass("minute-win-fresh", {
				MEMWATCH_WIN_OUT: out,
			});
			const row = JSON.parse(lines[0]);
			expect(row.win_avail_mb).toBe(1344);
			expect(row.win_commit_pct).toBe(64);
			expect(row.win_idle_s).toBe(1250);
			expect(row.win_pages_in).toBeNull();
			expect(row.win_age_s).toBeGreaterThanOrEqual(5);
		});

		it("keeps the memory counters where the input time would not read", async () => {
			const out = path.join(tmp, "win-no-idle");
			fs.writeFileSync(out, reading(5).replace(/ 1250\n$/, " -1\n"));
			const { lines } = await quietPass("minute-win-no-idle", {
				MEMWATCH_WIN_OUT: out,
			});
			const row = JSON.parse(lines[0]);
			expect(row.win_avail_mb).toBe(1344);
			expect(row.win_idle_s).toBeNull();
		});

		it("writes nulls for a reading more than two minutes old", async () => {
			const out = path.join(tmp, "win-stale");
			fs.writeFileSync(out, reading(600));
			const { lines } = await quietPass("minute-win-stale", {
				MEMWATCH_WIN_OUT: out,
			});
			const row = JSON.parse(lines[0]);
			expect(row.win_avail_mb).toBeNull();
			expect(row.win_idle_s).toBeNull();
			expect(row.win_age_s).toBeNull();
		});

		it("starts the next read in the background, stamped once it ends", async () => {
			const out = path.join(tmp, "win-launch");
			const fake = path.join(tmp, "fake-powershell");
			fs.writeFileSync(
				fake,
				"#!/bin/sh\nsleep 1\nprintf '1344 1 2 3 4 5\\r\\n'\n",
				{
					mode: 0o755,
				},
			);
			const before = Math.floor(Date.now() / 1000);
			await quietPass("minute-win-launch", {
				MEMWATCH_WIN_OUT: out,
				MEMWATCH_WIN_READ: fake,
			});
			for (let i = 0; i < 50 && !fs.existsSync(out); i++) await setTimeout(100);
			const [stamp, ...rest] = fs
				.readFileSync(out, "utf8")
				.trimEnd()
				.split(" ");
			expect(rest.join(" ")).toBe("1344 1 2 3 4 5");
			expect(Number(stamp)).toBeGreaterThanOrEqual(before + 1);
		});

		it("keeps the last good reading when a read fails", async () => {
			const out = path.join(tmp, "win-fail");
			const good = reading(5);
			fs.writeFileSync(out, good);
			const fake = path.join(tmp, "failing-powershell");
			fs.writeFileSync(
				fake,
				"#!/bin/sh\necho 'Get-CimInstance : error' >&2\n: >\"$0.ran\"\nexit 1\n",
				{ mode: 0o755 },
			);
			await quietPass("minute-win-fail", {
				MEMWATCH_WIN_OUT: out,
				MEMWATCH_WIN_READ: fake,
			});
			const deadline = Date.now() + WAIT_BOUND_MS;
			while (!fs.existsSync(`${fake}.ran`) && Date.now() < deadline)
				await setTimeout(POLL_MS);
			expect(fs.existsSync(`${fake}.ran`)).toBe(true);
			// guess: one tr and one mv on a loaded machine, #4804
			const writeSlackMs = 1000;
			await setTimeout(writeSlackMs);
			expect(fs.readFileSync(out, "utf8")).toBe(good);
		});
	});

	describe("deltas across lines", () => {
		async function twoLines(name: string, env: Record<string, string> = {}) {
			const minute = path.join(tmp, `${name}.jsonl`);
			const child = spawn("bash", [MEMWATCH], {
				env: {
					...baseEnv,
					MEMWATCH_LOG: path.join(tmp, `${name}.log`),
					MEMWATCH_MINUTE_LOG: minute,
					MEMWATCH_MINUTE_FMT: PASS_STAMP,
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

		let reused: ReturnType<typeof twoLines> | undefined;
		const oneReading = () => {
			if (!reused) {
				const out = path.join(tmp, "win-reuse");
				fs.writeFileSync(out, reading(5));
				reused = twoLines("delta-win-reuse", { MEMWATCH_WIN_OUT: out });
			}
			return reused;
		};

		it("writes each vmstat counter's change on the second line", async () => {
			const [, second] = await oneReading();
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
			const [first, second] = await oneReading();
			expect(first.win_avail_mb).toBe(1344);
			expect(second.win_avail_mb).toBe(1344);
			expect(second.win_pages_in).toBeNull();
			expect(second.win_pages_out).toBeNull();
		});

		it("writes the paging change between two readings", async () => {
			const out = path.join(tmp, "win-delta");
			const now = Math.floor(Date.now() / 1000);
			fs.writeFileSync(out, `${now - 30} 1344 1000 2000 50 100 7\n`);
			const fake = path.join(tmp, "next-powershell");
			fs.writeFileSync(
				fake,
				"#!/bin/sh\nprintf '1300 1100 2500 60 100 8\\r\\n'\n",
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
				win_idle_s: 8,
			});
		});
	});

	it("writes no second line for a minute the file already holds", async () => {
		await quietPass("minute-restart");
		const { lines } = await quietPass("minute-restart");
		const minutes = lines.map((l) => JSON.parse(l).ts.slice(0, 16));
		expect(new Set(minutes).size).toBe(minutes.length);
	});

	// #5706
	it.each([
		["tsc", "a tsc through node_modules/.bin", "node_modules/.bin/tsc"],
		["tsc", "TypeScript 6's tsc6", "node_modules/typescript/bin/tsc6"],
		["lander", "the queue lander", "scripts/queue-lander.js"],
	])("counts %s for %s", async (field, _what, rel) => {
		const dir = fs.mkdtempSync(path.join(tmp, "counted-"));
		const file = path.join(dir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "setTimeout(() => {}, 30_000);\n");
		await expectCounted(field, path.basename(dir), process.execPath, [file]);
	});

	it("counts tsc for TypeScript 7's native compiler, which runs as no node", async () => {
		const dir = fs.mkdtempSync(path.join(tmp, "counted-"));
		const native = path.join(
			dir,
			"node_modules/@typescript/typescript-linux-x64/lib/tsc",
		);
		fs.mkdirSync(path.dirname(native), { recursive: true });
		const sleep = execFileSync("sh", ["-c", "command -v sleep"], {
			encoding: "utf8",
		}).trim();
		fs.copyFileSync(sleep, native);
		fs.chmodSync(native, 0o755);
		await expectCounted("tsc", path.basename(dir), native, ["30"]);
	});

	async function expectCounted(
		field: string,
		name: string,
		cmd: string,
		args: string[],
	) {
		const child = keptSpawn("concurrent").spawn(cmd, args, {
			stdio: "ignore",
		});
		try {
			await setTimeout(300);
			const { lines } = await quietPass(`minute-${name}`);
			expect(JSON.parse(lines[0])[field]).toBeGreaterThan(0);
		} finally {
			child.kill();
		}
	}

	it("writes null sessions, not a wrong count, when the session lib is missing", async () => {
		const { lines } = await quietPass("minute-nolib", {
			MEMWATCH_SESSIONS_LIB: path.join(tmp, "absent.sh"),
		});
		expect(JSON.parse(lines[0]).sessions).toBeNull();
	});

	it("drops lines older than MEMWATCH_MINUTE_DAYS", async () => {
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
		const { lines } = await quietPass("minute-prune", {
			MEMWATCH_MINUTE_DAYS: "3",
		});
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(kept);
	});

	it("leaves a line less than a day past MEMWATCH_MINUTE_DAYS in place", async () => {
		const d = new Date(Date.now() - 3.5 * 86_400_000);
		const p = (n: number) => String(n).padStart(2, "0");
		const aged = `{"ts":"${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+0000","load1":1}`;
		fs.writeFileSync(path.join(tmp, "minute-slack.jsonl"), `${aged}\n`);
		const { lines } = await quietPass("minute-slack", {
			MEMWATCH_MINUTE_DAYS: "3",
		});
		expect(lines[0]).toBe(aged);
	});
});

describe.skipIf(!hasProc || !present).concurrent("memwatch CPU trigger", () => {
	const cpuLog = () =>
		path.join(tmp, `cpu-${Math.random().toString(36).slice(2)}.log`);
	const cpuEnv = (log: string, env: Record<string, string>) => ({
		...baseEnv,
		MEMWATCH_LOG: log,
		MEMWATCH_INTERVAL: "1",
		MEMWATCH_THRESHOLD_MB: "99999999",
		...env,
	});
	async function runLoop(
		env: Record<string, string>,
		{ until }: { until: RegExp },
	) {
		const log = cpuLog();
		const child = spawn("bash", [MEMWATCH], { env: cpuEnv(log, env) });
		const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
		const deadline = Date.now() + WAIT_BOUND_MS;
		while (Date.now() < deadline && !until.test(read()))
			await setTimeout(POLL_MS);
		child.kill("SIGKILL");
		return { out: read() };
	}

	let fired: ReturnType<typeof runLoop> | undefined;
	const firedBlock = () => {
		fired ??= runLoop({ MEMWATCH_CPU_THRESHOLD_PCT: "0" }, { until: /^=== /m });
		return fired;
	};

	it("fires a block on CPU alone, with memory far below its threshold", async () => {
		const { out } = await firedBlock();
		expect(out).toMatch(/^=== /m);
		expect(out).toMatch(/cpu: \d+% busy of \d+%/);
	});

	it("splits system, nice and user rather than logging one busy figure", async () => {
		const { out } = await firedBlock();
		expect(out).toMatch(/sys \d+%, nice \d+%, user \d+%/);
		expect(out).toMatch(/load \d/);
	});

	it("stays silent below its threshold rather than logging every pass", async () => {
		const log = cpuLog();
		const alive = await loopPasses(
			cpuEnv(log, { MEMWATCH_CPU_THRESHOLD_PCT: "99999" }),
			`${log}.minute`,
			3,
		);
		expect(alive).toBe(true);
		const out = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
		expect(out).not.toMatch(/^=== /m);
	});

	it("carries its delta state across iterations", async () => {
		const { out } = await firedBlock();
		expect(out.match(/^=== /gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
	});

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
		const spinner = spawn("sh", ["-c", "while :; do :; done"], {
			env: UNTRACED_ENV,
		});
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

const CGROUP_ROOT = "/sys/fs/cgroup";
const PASS_S = "2";
describe
	.skipIf(!hasProc || !present || !fs.existsSync(`${CGROUP_ROOT}/cpu.stat`))
	.concurrent("memwatch scheduler-clock line", () => {
		it("logs the onset and the clear, each dated, whatever the thresholds (#2779)", async () => {
			const still = writeCgroupRoot(path.join(tmp, "cgroup-still"), 0.001, 0);
			const link = path.join(tmp, "cgroup-link");
			fs.symlinkSync(still, link);
			const log = path.join(tmp, "sched.log");
			const child = spawn("bash", [MEMWATCH], {
				env: {
					...baseEnv,
					MEMWATCH_LOG: log,
					MEMWATCH_INTERVAL: PASS_S,
					MEMWATCH_THRESHOLD_MB: "99999999",
					MEMWATCH_CPU_THRESHOLD_PCT: "99999",
					MEMWATCH_CGROUP_ROOT: link,
				},
			});
			const read = () =>
				fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
			const waitFor = async (re: RegExp) => {
				const deadline = Date.now() + 15_000;
				while (Date.now() < deadline && !re.test(read())) await setTimeout(250);
			};
			const spinners = [0, 1].map(() =>
				spawn("sh", ["-c", "while :; do :; done"], { env: UNTRACED_ENV }),
			);
			try {
				await waitFor(/sched clock: frozen/);
				fs.rmSync(link);
				fs.symlinkSync(CGROUP_ROOT, link);
				await waitFor(/sched clock: running/);
			} finally {
				for (const s of spinners) s.kill("SIGKILL");
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

describe
	.skipIf(!present)
	.concurrent("the two frozen-clock detectors (#4092)", () => {
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
// guess: past the 2,000 default by more than the machine's ~100-400, #3402
const SLEEPERS = 2500;
// guess: the forker bash and a margin over it, #5669
const SCOPE_HEADROOM = 100;
const SCOPE_TASKS = SLEEPERS + SCOPE_HEADROOM;
// guess, #3402
const SCOPE_S = 120;

interface Firing {
	ts: string;
	since: string;
	procs: number;
	argv: string;
	size: number;
	parents: { pid: number; kids: number; argv: string }[];
	killed: number[];
}
const firings = (file: string): Firing[] =>
	(dataOrThrow(readText(file)) ?? "")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
const alive = (pid: number) => {
	try {
		return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return false;
	}
};

async function startUnit(unit: string, tasksMax: number, script: string) {
	const scope = spawn(
		"systemd-run",
		[
			"--user",
			"--scope",
			"--quiet",
			`--unit=${unit}`,
			"-p",
			`TasksMax=${tasksMax}`,
			"-p",
			`RuntimeMaxSec=${SCOPE_S}`,
			"bash",
			"-c",
			script,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	const stop = () => {
		ignoreFailure(() =>
			execFileSync("systemctl", ["--user", "stop", unit], {
				stdio: "ignore",
			}),
		);
		scope.kill("SIGKILL");
	};
	try {
		await new Promise<void>((resolve, reject) => {
			scope.stdout.on("data", (b) => {
				if (String(b).includes("ready")) resolve();
			});
			scope.on("exit", () => reject(new Error(`${unit} exited early`)));
		});
	} catch (e) {
		stop();
		throw e;
	}
	return stop;
}
async function inUnit<T>(
	unit: string,
	tasksMax: number,
	script: string,
	body: () => Promise<T>,
) {
	const stop = await startUnit(unit, tasksMax, script);
	try {
		return await body();
	} finally {
		stop();
	}
}

describe.skipIf(!hasScope).concurrent("memwatch process-count trigger", () => {
	it("logs one block a cooldown however many passes cross the threshold", async () => {
		const log = path.join(tmp, "procs-cooldown.log");
		await loopPasses(
			{
				...baseEnv,
				MEMWATCH_LOG: log,
				MEMWATCH_INTERVAL: "1",
				MEMWATCH_THRESHOLD_MB: "99999999",
				MEMWATCH_CPU_THRESHOLD_PCT: "99999",
				MEMWATCH_PROCS_THRESHOLD: "0",
			},
			path.join(tmp, "procs-cooldown.jsonl"),
			3,
		);
		const out = fs.readFileSync(log, "utf8");
		expect(out.match(/^--- \d+ processes \|/gm)).toHaveLength(1);
	});
});

// guess: above the largest fixture's 211 tasks, #3807
const FIXTURE_TASKS = 400;
// guess: far past a 2 s window, #3807
const FIRE_BOUND_MS = 30_000;
// guess: rides out a loaded machine, #3807
const SETTLE_BOUND_MS = 10_000;

describe.skipIf(!hasScope).concurrent("memwatch process runaway", () => {
	const marker = `3807.${process.pid}`;
	let nth = 0;
	const inScope = <T>(script: string, body: () => Promise<T>) =>
		inUnit(
			`memwatch-runaway-${process.pid}-${nth++}.scope`,
			FIXTURE_TASKS,
			script,
			body,
		);

	const logs = () => {
		const id = nth++;
		return {
			log: path.join(tmp, `runaway-${id}.log`),
			runaway: path.join(tmp, `runaway-${id}.jsonl`),
		};
	};
	const quietEnv = (log: string, runaway: string, only: string) => ({
		...baseEnv,
		MEMWATCH_LOG: log,
		MEMWATCH_RUNAWAY_LOG: runaway,
		MEMWATCH_INTERVAL: "1",
		MEMWATCH_THRESHOLD_MB: "99999999",
		MEMWATCH_CPU_THRESHOLD_PCT: "99999",
		MEMWATCH_RUNAWAY_ONLY: only,
		MEMWATCH_RUNAWAY_PROCS: "1",
		MEMWATCH_RUNAWAY_GROUP: "30",
	});
	const firePass = (log: string, runaway: string, only: string) =>
		memwatch({
			...quietEnv(log, runaway, only),
			MEMWATCH_ONCE: "1",
			MEMWATCH_RUNAWAY_WINDOW_S: "0",
		});
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
			return 0;
		}
	};

	it(
		"kills a chain of one argv held past the window, naming its argv and pids",
		async () => {
			const chain = path.join(tmp, "chain.sh");
			fs.writeFileSync(
				chain,
				`N=$((\${N:-40} - 1)); export N\nif [ "$N" -gt 0 ]; then bash "$0" "$1" & wait; else echo ready; sleep 300; fi\n`,
			);
			const { log, runaway } = logs();
			const only = `${marker}0`;
			const argv = `bash ${chain} ${only}`;
			await inScope(`exec bash ${shellQuote(chain)} ${only}`, async () => {
				await loopUntil(
					{
						...quietEnv(log, runaway, only),
						MEMWATCH_RUNAWAY_WINDOW_S: "2",
					},
					() => firings(runaway).length > 0,
				);
				const [line, ...rest] = firings(runaway);
				expect(rest).toEqual([]);
				expect(line.argv).toBe(argv);
				expect(line.size).toBe(40);
				expect(line.killed).toHaveLength(40);
				expect(await settles(() => !line.killed.some(alive))).toBe(true);
				expect(line.procs).toBeGreaterThan(40);
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
						{
							...quietEnv(log, runaway, argv),
							MEMWATCH_RUNAWAY_WINDOW_S: "1",
						},
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
					await loopPasses(
						{
							...quietEnv(log, runaway, seconds),
							MEMWATCH_RUNAWAY_WINDOW_S: "0",
						},
						`${runaway}.minute`,
						3,
					);
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
				...quietEnv(log, runaway, `no-process-holds-${marker}`),
				MEMWATCH_RUNAWAY_PROCS: "300",
				MEMWATCH_RUNAWAY_WINDOW_S: "2",
				MEMWATCH_PROCS_READINGS: "500 500 0 500",
			};
			const started = Math.floor(Date.now() / 1000);
			await loopUntil(env, () => firings(runaway).length > 0);
			const [line, ...rest] = firings(runaway);
			expect(rest).toEqual([]);
			expect(Date.parse(line.since) / 1000 - started).toBeGreaterThanOrEqual(3);
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
			fs.writeFileSync(
				chain,
				`[ -n "\${READY:-}" ] || { READY=1; export READY; echo ready; }\nsleep 0.05; bash "$0" "$1" & wait\n`,
			);
			const { log, runaway } = logs();
			const seeded = `bash ${chain} ${marker}5`;
			await inScope(`exec bash ${shellQuote(chain)} ${marker}5`, async () => {
				await settles(() => running(`^${seeded}$`) >= 30);
				await firePass(log, runaway, `${marker}5`);
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
					await firePass(log, runaway, seconds);
					const [line] = firings(runaway);
					expect(line.argv).toBe(plain);
					expect(line.killed).toHaveLength(31);
					expect(running(`^claude ${seconds}`)).toBe(60);
					expect(running(`^/x/claude/versions/2.1.234 ${seconds}`)).toBe(60);
					expect(running(`^/mnt/c/Program Files/claude.exe ${seconds}`)).toBe(
						60,
					);
					expect(await settles(() => running(`^${plain}`) === 0)).toBe(true);
					const after = logs();
					await firePass(after.log, after.runaway, seconds);
					const [only] = firings(after.runaway);
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
					await firePass(log, runaway, `${marker}4`);
					expect(firings(runaway)[0].argv).toBe(`${argv} ${marker}4`);
				},
			);
		},
		SCOPE_S * 1000,
	);

	it("drops firing lines older than MEMWATCH_MINUTE_DAYS when it writes one", async () => {
		const { log, runaway } = logs();
		const ts = (daysAgo: number) =>
			new Date(Date.now() - daysAgo * 86_400_000)
				.toISOString()
				.replace(/\.\d+Z$/, "+0000");
		const old = `{"ts":"${ts(40)}","since":"${ts(40)}","killed":[]}`;
		fs.writeFileSync(runaway, `${old}\n`);
		await firePass(log, runaway, `${marker}6`);
		expect(fs.readFileSync(runaway, "utf8")).not.toContain(old);
		expect(firings(runaway)).toHaveLength(1);
	});
});

// #5669
const HELD = `memwatch-fixture-held-${process.pid}.scope`;
const SLEEP_ARGV = `sleep 3402.${process.pid}`;
const FORK_MARKER = `memwatch-fork-fixture-${process.pid}`;
const sleepers = (n: number, marker = "") =>
	`${marker && `: ${marker}; `}for _ in $(seq ${n}); do ${SLEEP_ARGV} & done; echo ready; wait`;
function unitSleepers(unit: string) {
	const cg = execFileSync(
		"systemctl",
		["--user", "show", "--value", "-p", "ControlGroup", unit],
		{ encoding: "utf8" },
	).trim();
	return fs
		.readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8")
		.trim()
		.split("\n")
		.map(Number)
		.filter((pid) => {
			const read = readText(`/proc/${pid}/cmdline`);
			return (
				read.state === "read" &&
				read.data.replace(/\0$/, "") === SLEEP_ARGV.replace(" ", "\0")
			);
		});
}
async function armedPass(name: string) {
	const log = path.join(tmp, `${name}.log`);
	const runaway = path.join(tmp, `${name}.jsonl`);
	const { MEMWATCH_PROCS_THRESHOLD: _, ...env } = baseEnv;
	await memwatch({
		...env,
		MEMWATCH_ONCE: "1",
		MEMWATCH_LOG: log,
		MEMWATCH_RUNAWAY_LOG: runaway,
		MEMWATCH_THRESHOLD_MB: "99999999",
		MEMWATCH_CPU_THRESHOLD_PCT: "99999",
		MEMWATCH_RUNAWAY_ONLY: SLEEP_ARGV,
		MEMWATCH_RUNAWAY_FIXTURE: "memwatch-fixture-held-",
		MEMWATCH_RUNAWAY_WINDOW_S: "0",
	});
	return { log, fired: firings(runaway) };
}
let strays = 0;
async function strayFires(n: number) {
	const unit = `memwatch-fixture-stray-${process.pid}-${strays++}.scope`;
	return inUnit(unit, n + SCOPE_HEADROOM, sleepers(n), async () => {
		const pids = unitSleepers(unit);
		expect(pids).toHaveLength(n);
		const { fired } = await armedPass(unit);
		expect(fired).toHaveLength(1);
		expect(fired[0].argv).toBe(SLEEP_ARGV);
		expect(fired[0].size).toBe(n);
		expect([...fired[0].killed].sort()).toEqual([...pids].sort());
	});
}
// guess: past RUNAWAY_GROUP's 200, a tenth of the fixture, #5669
const STRAY = 250;

describe
	.skipIf(!hasScope)
	.sequential("memwatch process-count trigger at the shipped threshold", () => {
		let stopHeld: () => void = noop;
		beforeAll(async () => {
			stopHeld = await startUnit(
				HELD,
				SCOPE_TASKS,
				sleepers(SLEEPERS, FORK_MARKER),
			);
		}, SCOPE_S * 1000);
		afterAll(() => stopHeld());

		it("names the sleepers' command and their parent past the threshold", async () => {
			const { log } = await armedPass("procs");
			const lines = fs.readFileSync(log, "utf8").trimEnd().split("\n");
			const head = lines.findIndex((l) =>
				/^--- \d+ processes \| top commands by process count ---$/.test(l),
			);
			expect(head).toBeGreaterThan(-1);
			expect(Number(lines[head].split(" ")[1])).toBeGreaterThan(SLEEPERS);
			expect(lines[head + 2]).toBe(
				`${String(SLEEPERS).padStart(7)} ${SLEEP_ARGV}`,
			);
			const parents = lines.indexOf("--- top parents by direct children ---");
			expect(parents).toBeGreaterThan(head);
			expect(lines[parents + 2]).toMatch(
				new RegExp(
					`^ *\\d+ +${SLEEPERS} \\S*bash -c : ${FORK_MARKER};.* echo ready; wait$`,
				),
			);
		});

		it(
			"leaves the fixture's sleepers out of an armed pass's group and kills, taking a smaller group of their argv (#5669)",
			async () => {
				const fixture = unitSleepers(HELD);
				expect(fixture).toHaveLength(SLEEPERS);
				await strayFires(STRAY);
				expect(fixture.filter((pid) => !alive(pid))).toEqual([]);
			},
			SCOPE_S * 1000,
		);

		it(
			"fires on and kills a fixture-sized group of the fixture's argv outside the fixture's scope (#5669)",
			() => strayFires(SLEEPERS),
			SCOPE_S * 1000,
		);
	});
