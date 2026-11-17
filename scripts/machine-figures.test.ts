// @vitest-environment node
/*
 * The machine-figures SessionStart hook prints the machine's live figures in
 * one line, and names a read that fails rather than printing it as 0 (#5340).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK = path.resolve(__dirname, "machine-figures.sh");

const MEMINFO = [
	"MemTotal:       10168320 kB",
	"MemFree:         1234567 kB",
	"MemAvailable:    5555555 kB",
	"SwapTotal:       2097152 kB",
	"SwapFree:        2097152 kB",
	"",
].join("\n");

let dir: string;
let fixtures = 0;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-figures-"));
});

afterAll(() => {
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
	const root = path.join(dir, `f${fixtures++}`);
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin, { recursive: true });
	const stub = (name: string, out: string | null) =>
		fs.writeFileSync(
			path.join(bin, name),
			out === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho '${out}'\n`,
			{ mode: 0o755 },
		);
	stub("uname", uname);
	stub("nproc", nproc);
	const meminfoPath = path.join(root, "meminfo");
	if (meminfo !== null) fs.writeFileSync(meminfoPath, meminfo);
	const r = spawnSync("bash", [HOOK], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
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
			"Machine (read live): aarch64; 8 cores; MemTotal 9930 MiB; SwapTotal 2048 MiB.\n",
		);
	});

	it("reads this machine's figures, not fixed ones", () => {
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
			"Machine (read live): 8 cores; MemTotal 9930 MiB; SwapTotal 2048 MiB; unreadable: architecture.\n",
		],
		[
			"a failing nproc",
			{ nproc: null },
			"Machine (read live): aarch64; MemTotal 9930 MiB; SwapTotal 2048 MiB; unreadable: cores.\n",
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
