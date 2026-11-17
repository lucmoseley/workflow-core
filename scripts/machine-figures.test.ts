// @vitest-environment node
/*
 * The machine-figures SessionStart hook prints the machine's live figures in
 * one line, and names a read that fails rather than printing it as 0 (#5340).
 * The machine rules carry no figures, so this line is the only place a
 * session learns them: a 0 printed for a failed read would pass for a real
 * figure. Each read is fed through its own seam, so each failure is tried
 * alone.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMeminfo } from "./lib/meminfo-fake";

const HOOK = path.resolve(__dirname, "machine-figures.sh");

/** A 10,240 MiB machine with 2,048 MiB of swap. */
const MEMINFO = buildMeminfo({
	availableMb: 5000,
	swapTotalMb: 2048,
	swapFreeMb: 2048,
});

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-figures-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

interface Stubs {
	/** What `uname -m` prints, or null for a `uname` that fails. */
	uname?: string | null;
	/** What `nproc` prints, or null for an `nproc` that fails. */
	nproc?: string | null;
	/** The meminfo file's text, or null for no file. */
	meminfo?: string | null;
}

/** The hook's output under stubbed `uname`/`nproc` and a fixture meminfo. */
const figures = ({
	uname = "aarch64",
	nproc = "8",
	meminfo = MEMINFO,
}: Stubs = {}) => {
	const stub = (name: string, out: string | null) => {
		const file = path.join(dir, name);
		fs.writeFileSync(
			file,
			out === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho '${out}'\n`,
			{ mode: 0o755 },
		);
		return file;
	};
	const meminfoPath = path.join(dir, "meminfo");
	if (meminfo !== null) fs.writeFileSync(meminfoPath, meminfo);
	const r = spawnSync("bash", [HOOK], {
		env: {
			...process.env,
			WFC_UNAME: stub("uname", uname),
			WFC_NPROC: stub("nproc", nproc),
			WFC_MEMINFO: meminfoPath,
		},
		encoding: "utf8",
	});
	expect(r.status).toBe(0);
	expect(r.stderr).toBe("");
	return r.stdout;
};

describe("the machine-figures line", () => {
	it("gives architecture, cores, MemTotal and SwapTotal in MiB, in one line", () => {
		expect(figures()).toBe(
			"Machine (read live): aarch64; 8 cores; MemTotal 10240 MiB; SwapTotal 2048 MiB.\n",
		);
	});

	it("prints whichever figures it reads, not fixed ones", () => {
		expect(
			figures({
				uname: "x86_64",
				nproc: "16",
				meminfo: "MemTotal: 65536000 kB\nSwapTotal: 0 kB\n",
			}),
		).toBe(
			"Machine (read live): x86_64; 16 cores; MemTotal 64000 MiB; SwapTotal 0 MiB.\n",
		);
	});
});

/* The seams' second adapter (base §G7): the real `uname`, `nproc` and
 * /proc/meminfo, which cost nothing to call. */
describe.runIf(fs.existsSync("/proc/meminfo"))(
	"the real binaries and meminfo",
	() => {
		it("give the line this machine's own figures", () => {
			/* Through bash as the hook is, since a traced run pins its bash
			 * children to one CPU (lib/read-audit-trace.js), and nproc counts
			 * the CPUs its process may use. */
			const real = (cmd: string) =>
				spawnSync("bash", ["-c", cmd], { encoding: "utf8" }).stdout.trim();
			const kb = (field: string) =>
				Number(
					fs
						.readFileSync("/proc/meminfo", "utf8")
						.match(new RegExp(`^${field}:\\s+(\\d+) kB$`, "m"))?.[1],
				);
			const env = { ...process.env };
			delete env.WFC_UNAME;
			delete env.WFC_NPROC;
			delete env.WFC_MEMINFO;
			const r = spawnSync("bash", [HOOK], { env, encoding: "utf8" });
			expect(r.stdout).toBe(
				`Machine (read live): ${real("uname -m")}; ${real("nproc")} cores; ` +
					`MemTotal ${Math.floor(kb("MemTotal") / 1024)} MiB; ` +
					`SwapTotal ${Math.floor(kb("SwapTotal") / 1024)} MiB.\n`,
			);
		});
	},
);

describe("a read that fails is named, never zeroed", () => {
	it.each<[string, Stubs, string]>([
		[
			"no meminfo",
			{ meminfo: null },
			"Machine (read live): aarch64; 8 cores; unreadable: MemTotal, SwapTotal.\n",
		],
		[
			"a meminfo with no SwapTotal",
			{ meminfo: "MemTotal: 2048 kB\n" },
			"Machine (read live): aarch64; 8 cores; MemTotal 2 MiB; unreadable: SwapTotal.\n",
		],
		[
			"a garbled MemTotal",
			{ meminfo: "MemTotal: lots kB\nSwapTotal: 1024 kB\n" },
			"Machine (read live): aarch64; 8 cores; SwapTotal 1 MiB; unreadable: MemTotal.\n",
		],
		[
			"a failing uname",
			{ uname: null },
			"Machine (read live): 8 cores; MemTotal 10240 MiB; SwapTotal 2048 MiB; unreadable: architecture.\n",
		],
		[
			"a failing nproc",
			{ nproc: null },
			"Machine (read live): aarch64; MemTotal 10240 MiB; SwapTotal 2048 MiB; unreadable: cores.\n",
		],
		[
			"every read failing",
			{ uname: null, nproc: null, meminfo: null },
			"Machine (read live): unreadable: architecture, cores, MemTotal, SwapTotal.\n",
		],
	])("%s", (_, stubs, line) => {
		const out = figures(stubs);
		expect(out).toBe(line);
		expect(out).not.toMatch(/\b0 (?:cores|MiB)/);
	});
});
