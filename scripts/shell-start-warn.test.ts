// @vitest-environment node
/*
 * Pins shell-start-warn.sh: it fires only when MemAvailable is under the floor,
 * what it prints, and that the silent path never lists processes.
 *
 * It runs the script in bash with a fixture meminfo and a stub `ps` at WFC_PS,
 * so the test sets the trigger and the stub's marker shows whether the costly
 * path ran.
 *
 * Breaking it either fires on every shell, training the founder to skip it, or
 * hides a real memory pile-up (mantahostels#578).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePsStub } from "./lib/ps-stub";

const SCRIPT = path.resolve(__dirname, "shell-start-warn.sh");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-start-warn-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeMeminfo(availableKb: number | null, freeKb = 8_000_000): string {
	const file = path.join(dir, "meminfo");
	const lines = [
		"MemTotal:       10162176 kB",
		`MemFree:        ${freeKb} kB`,
		...(availableKb === null ? [] : [`MemAvailable:   ${availableKb} kB`]),
		"Buffers:          123456 kB",
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

const marker = () => path.join(dir, "ps-ran");

// A stub `ps` at WFC_PS: proof of whether the firing path ran, and a fixed
// process table so the message fields are assertable.
// Fixture covers all three argv[0] shapes (versioned binary, bare claude,
// launcher path) plus a non-Claude line that must not be counted.
function stubPs(): string {
	return writePsStub(
		dir,
		[
			"  101 1 524288 /home/u/.local/share/claude/versions/2.1.234 bg-pty-host --job x",
			"  102 101 262144 claude bg-spare",
			"  103 1 102400 /home/u/.local/bin/claude",
			"  104 1  50000 vim notes.txt",
		],
		{ marker: marker() },
	);
}

function run(meminfo: string, floorMb?: number): string {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LC_ALL: "C",
		WFC_PS: stubPs(),
		WFC_MEMINFO: meminfo,
	};
	delete env.WFC_HEADROOM_FLOOR_MB;
	if (floorMb !== undefined) env.WFC_HEADROOM_FLOOR_MB = String(floorMb);
	return execFileSync("bash", [SCRIPT], { encoding: "utf8", env });
}

describe("trigger", () => {
	it("stays silent when MemAvailable is above the floor", () => {
		expect(run(writeMeminfo(2000 * 1024), 1500)).toBe("");
	});

	it("stays silent at exactly the floor — fires strictly below", () => {
		expect(run(writeMeminfo(1500 * 1024), 1500)).toBe("");
	});

	it("fires when MemAvailable is below the floor", () => {
		expect(run(writeMeminfo(1200 * 1024), 1500)).toContain("1200 MB");
	});

	it("defaults the floor to 2200 MB", () => {
		expect(run(writeMeminfo(2199 * 1024))).toContain("floor 2200 MB");
		expect(run(writeMeminfo(2201 * 1024))).toBe("");
	});

	it("reads MemAvailable, never MemFree", () => {
		// MemFree far below the floor, MemAvailable above it: reclaimable
		// cache is not spent memory, so this must stay silent.
		expect(run(writeMeminfo(3000 * 1024, 100 * 1024), 1500)).toBe("");
		// And the reverse fires.
		expect(run(writeMeminfo(1000 * 1024, 8_000_000), 1500)).not.toBe("");
	});
});

describe("message", () => {
	it("shows available against the floor, session context as an upper bound, and points at memcheck", () => {
		const out = run(writeMeminfo(1000 * 1024), 1500);
		expect(out).toContain("1000 MB");
		expect(out).toContain("floor 1500 MB");
		expect(out).toContain("earlyoom");
		// From the ps fixture: one bg-pty-host, three Claude processes,
		// (524288+262144+102400) kB = 0.8 GB.
		expect(out).toContain("1 session(s) / 3 process(es) / 0.8 GB RSS");
		expect(out).toContain("upper bound");
		expect(out).toContain("memcheck");
	});
});

describe("cost and robustness", () => {
	it("never runs the process listing on the silent path", () => {
		run(writeMeminfo(5000 * 1024), 1500);
		expect(fs.existsSync(marker())).toBe(false);
	});

	it("runs the process listing on the firing path", () => {
		run(writeMeminfo(1000 * 1024), 1500);
		expect(fs.existsSync(marker())).toBe(true);
	});

	it("is silent, exit 0, on a missing meminfo file", () => {
		expect(run(path.join(dir, "no-such-file"), 1500)).toBe("");
	});

	it("is silent, exit 0, when meminfo has no MemAvailable line", () => {
		expect(run(writeMeminfo(null), 1500)).toBe("");
	});
});
