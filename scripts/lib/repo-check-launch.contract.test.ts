// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keptSpawn } from "./kept-spawn.js";
import { inProcessSpawn, writeStubChecker } from "./repo-check-launch-fake.js";

let dir = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-check-launch-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const envelope = { checker: "x", outcome: "WARN", count: 1, keys: ["k"] };

const CASES: {
	behaviour: string;
	spec: Record<string, unknown>;
	argv: string[];
	timeout?: number;
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
	{
		behaviour: "is killed at its timeout with nothing printed",
		spec: { envelope, sleepMs: 5000 },
		argv: ["--json"],
		timeout: 1000,
	},
];

interface LaunchOptions {
	encoding: "utf8";
	timeout?: number;
	killSignal: "SIGKILL";
}
const spawnShim = (args: string[], options: LaunchOptions) => {
	if (options.timeout)
		return keptSpawn("timeout").spawnSync(process.execPath, args, options);
	return keptSpawn("boundary").spawnSync(process.execPath, args, options);
};

const launched = (log: string) =>
	fs.existsSync(log)
		? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
		: [];

describe("repo-checks' launch answers the same spawned and in-process (#5734)", () => {
	it.each(CASES)("$behaviour", ({ spec, argv, timeout }) => {
		const answers = (["spawned", "in-process"] as const).map((route) => {
			const shim = path.join(dir, `${route}.js`);
			const launches = path.join(dir, `${route}.log`);
			writeStubChecker(shim, { ...spec, id: "x", launches });
			const options = {
				encoding: "utf8" as const,
				timeout,
				killSignal: "SIGKILL" as const,
			};
			const r =
				route === "in-process"
					? inProcessSpawn(process.execPath, [shim, ...argv], options)
					: spawnShim([shim, ...argv], options);
			return {
				status: r.status,
				signal: r.signal,
				error: (r.error as NodeJS.ErrnoException | undefined)?.code,
				stdout: r.stdout,
				stderr: r.stderr,
				launched: launched(launches),
			};
		});
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[0].launched).toEqual([JSON.stringify(["x", ...argv])]);
	});
});
