// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeFakeBin } from "./fake-bin";
import { writePowershell } from "./powershell-fake";
import {
	itNamesItsRecorder,
	readRecording,
	type ToolAnswer,
} from "./windows-tool-recording";

type Key = "command" | "failing" | "check";

const recorded = readRecording<Record<Key, ToolAnswer>>(
	path.join(__dirname, "..", "fixtures", "powershell.json"),
);

const REAL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const DIAG = "/mnt/c/diag/5743";

const withoutCr = (s: string) => s.replace(/\r/g, "");

const CASES: { key: Key; name: string; check: (a: ToolAnswer) => void }[] = [
	{
		key: "command",
		name: "-Command \"& '<exe>' …\" passes the program's stdout through, exiting 0",
		check(a) {
			expect(a.status).toBe(0);
			expect(withoutCr(a.stdout)).toBe("@@probe\n");
		},
	},
	{
		key: "failing",
		name: "-Command \"& '<exe>' …\" exits 1 where the program fails",
		check(a) {
			expect(a.status).toBe(1);
		},
	},
	{
		key: "check",
		name: "-File page-combining.ps1 -Check prints one line, ok or what is missing",
		check(a) {
			expect(a.status).toBe(0);
			expect(withoutCr(a.stdout)).toMatch(/^(ok|missing: .+)\n$/);
		},
	},
];

const reachable = (file: string) => {
	try {
		fs.accessSync(file);
		return !process.env.CI;
	} catch {
		return false;
	}
};
const live: Record<Key, boolean> = {
	command: reachable(REAL),
	failing: reachable(REAL),
	check: reachable(REAL) && reachable(path.join(DIAG, "page-combining.ps1")),
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "powershell-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the fake", () => {
	const bin = path.join(dir, "bin");
	const ps = writePowershell(bin).bin;
	const probe = writeFakeBin(bin, "probe", "echo @@probe");
	const failing = writeFakeBin(bin, "failing", "exit 3");
	const argv: Record<Key, string[]> = {
		command: ["-NoProfile", "-Command", `& '${probe}'`],
		failing: ["-NoProfile", "-Command", `& '${failing}'`],
		check: [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			path.join(dir, "page-combining.ps1"),
			"-Check",
		],
	};
	for (const c of CASES)
		it(c.name, () => c.check(spawnSync(ps, argv[c.key], { encoding: "utf8" })));
});

describe("the live powershell.exe, given the recorded arguments", () => {
	for (const c of CASES)
		it.skipIf(!live[c.key])(c.name, { timeout: 30_000 }, () =>
			c.check(
				spawnSync(REAL, recorded.responses[c.key].argv ?? [], {
					encoding: "utf8",
					cwd: DIAG,
				}),
			),
		);
});

describe("the recorded powershell.exe", () => {
	itNamesItsRecorder(recorded, "powershell");
	for (const c of CASES) it(c.name, () => c.check(recorded.responses[c.key]));
});
