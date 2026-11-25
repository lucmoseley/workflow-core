// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inProcessSpawn, writeStubChecker } from "./fixtures/stub-checker.js";
import { keptSpawn } from "./kept-spawn.js";

let dir = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "stub-checker-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const envelope = { checker: "x", outcome: "WARN", count: 1, keys: ["k"] };

const CASES: {
	behaviour: string;
	spec: Record<string, unknown>;
	argv: string[];
}[] = [
	{
		behaviour: "prints its envelope on --json",
		spec: { envelope },
		argv: ["--json"],
	},
	{ behaviour: "prints nothing without --json", spec: { envelope }, argv: [] },
	{
		behaviour: "prints its re-scan envelope on --rescan",
		spec: { envelope, onRescan: { ...envelope, keys: [] } },
		argv: ["--rescan", "34", "--json"],
	},
	{
		behaviour: "prints no envelope where it has none, with its exit and stderr",
		spec: {
			envelope: null,
			exit: 2,
			stderr: "Error: gone\n    at x (y.js:1:1)\n",
		},
		argv: ["--json"],
	},
];

const launched = (log: string) =>
	fs.readFileSync(log, "utf8").split("\n").filter(Boolean);

describe("the stub checker answers the same spawned and in-process (#5734)", () => {
	it.each(CASES)("$behaviour", ({ spec, argv }) => {
		const answers = (["spawned", "in-process"] as const).map((route) => {
			const shim = path.join(dir, `${route}.js`);
			const launches = path.join(dir, `${route}.log`);
			writeStubChecker(shim, { ...spec, id: "x", launches });
			const r =
				route === "spawned"
					? keptSpawn("boundary").spawnSync(process.execPath, [shim, ...argv], {
							encoding: "utf8",
						})
					: inProcessSpawn(process.execPath, [shim, ...argv]);
			return {
				status: r.status,
				stdout: r.stdout,
				stderr: r.stderr,
				launched: launched(launches),
			};
		});
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[0].launched).toEqual([JSON.stringify(["x", ...argv])]);
	});
});
