// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	itNamesItsRecorder,
	readRecording,
	type ToolAnswer,
} from "./windows-tool-recording";
import { writeWslpath } from "./wslpath-fake";

const recorded = readRecording<{ roundTrip: ToolAnswer[] }>(
	path.join(__dirname, "..", "fixtures", "wslpath.json"),
);

const DUMP = "/mnt/c/diag/5743/dumps/live.dmp";

const CASES: {
	name: string;
	check: (call: (args: string[]) => ToolAnswer) => void;
}[] = [
	{
		name: "-w then -u gives back the WSL path, each one line exiting 0",
		check(call) {
			const win = call(["-w", DUMP]);
			expect(win.status).toBe(0);
			expect(win.stdout.trim()).not.toMatch(/\n/);
			const back = call(["-u", win.stdout.trim()]);
			expect(back.status).toBe(0);
			expect(back.stdout.trim()).toBe(DUMP);
		},
	},
];

const spawned = (bin: string) => (args: string[]) =>
	spawnSync(bin, args, { encoding: "utf8" });

const live = spawnSync("wslpath", ["-w", "/"], { encoding: "utf8" });
const hasLive = !live.error && live.status === 0;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wslpath-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the fake", () => {
	const bin = writeWslpath(path.join(dir, "bin"));
	for (const c of CASES) it(c.name, () => c.check(spawned(bin)));
});

describe("the live wslpath", () => {
	for (const c of CASES)
		it.skipIf(!hasLive)(c.name, () => c.check(spawned("wslpath")));
});

describe("the recorded wslpath", () => {
	itNamesItsRecorder(recorded, "wslpath");
	for (const c of CASES)
		it(c.name, () => {
			const answers = [...recorded.responses.roundTrip];
			c.check((args) => {
				const next = answers.shift();
				if (!next) throw new Error("the recording holds no further answer");
				expect(args).toEqual(next.argv);
				return next;
			});
		});
});
