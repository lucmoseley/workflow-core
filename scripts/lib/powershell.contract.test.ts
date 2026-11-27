// @vitest-environment node
// #5813
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeFakeBin } from "./fake-bin";
import { writePowershell } from "./powershell-fake";

interface Answer {
	status: number | null;
	stdout: string;
	stderr: string;
}
type Key = "command" | "failing" | "check";

const recorded: {
	recordedBy: string;
	responses: Record<Key, Answer>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "powershell.json"),
		"utf8",
	),
);

const withoutCr = (s: string) => s.replace(/\r/g, "");

const CASES: { key: Key; name: string; check: (a: Answer) => void }[] = [
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
		name: "-Command \"& '<exe>' …\" exits non-zero where the program does",
		check(a) {
			expect(a.status).not.toBe(0);
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

describe("the recorded powershell.exe", () => {
	it("names the command that re-records it", () => {
		expect(recorded.recordedBy).toBe(
			"node scripts/record-windows-tools.js powershell",
		);
	});
	for (const c of CASES) it(c.name, () => c.check(recorded.responses[c.key]));
});
