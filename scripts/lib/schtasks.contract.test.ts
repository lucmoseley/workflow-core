// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeSchtasks } from "./schtasks-fake";
import {
	itNamesItsRecorder,
	readRecording,
	type ToolAnswer,
} from "./windows-tool-recording";

type Key = "run" | "missing";

const recorded = readRecording<Record<Key, ToolAnswer>>(
	path.join(__dirname, "..", "fixtures", "schtasks.json"),
);

const TASK = "Verifier 5743 combining on";

const CASES: {
	key: Key;
	name: string;
	task: string;
	check: (a: ToolAnswer) => void;
}[] = [
	{
		key: "run",
		name: "/Run of a registered task exits 0, printing SUCCESS",
		task: TASK,
		check(a) {
			expect(a.status).toBe(0);
			expect(a.stdout).toMatch(/^SUCCESS: /);
		},
	},
	{
		key: "missing",
		name: "/Run of an absent task exits 1, printing ERROR on stderr",
		task: `${TASK} absent`,
		check(a) {
			expect(a.status).toBe(1);
			expect(a.stderr).toMatch(/^ERROR: /);
		},
	},
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schtasks-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the fake", () => {
	const bin = writeSchtasks(path.join(dir, "bin"), dir, {
		[TASK]: { log: "combining.log", line: "on PageCombining=True" },
	});
	for (const c of CASES)
		it(c.name, () =>
			c.check(spawnSync(bin, ["/Run", "/TN", c.task], { encoding: "utf8" })),
		);
});

describe("the recorded schtasks.exe", () => {
	itNamesItsRecorder(recorded, "schtasks");
	for (const c of CASES)
		it(c.name, () => {
			const a = recorded.responses[c.key];
			expect(a.argv?.slice(0, 2)).toEqual(["/Run", "/TN"]);
			c.check(a);
		});
});
