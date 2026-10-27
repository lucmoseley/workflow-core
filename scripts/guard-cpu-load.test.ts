// @vitest-environment node
/*
 * guard-cpu-load.js refuses a CPU load generator run outside a CPU cap of at
 * most half the cores, and hands over the capped form (#2710). These are its
 * boundary cases (§X11), run as the harness runs it: the payload on fd 0, the
 * hook's environment, real scripts in a temp project, and the fail-open log.
 * Which command earns which verdict is lib/cpu-load.test.ts's (#2801); the
 * throw policy is lib/refuse-on-throw.test.ts's.
 *
 * The core count is pinned at 8 through WFC_CPU_COUNT, so a 2-core CI runner
 * judges the cap as this machine does, bar the one case that reads the online
 * count itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	failOpenLogPath,
	readFailOpenLog,
	readFailOpenRecords,
} from "./guard-log-fixture";
import {
	buildBashPayload,
	entryBesideThrowingCore,
	guardDirs,
	nodeGuardOutput,
	runNodeGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-cpu-load.js");
const LOOP = "for _ in 1 2 3 4 5 6 7 8; do yes >/dev/null & done";

let dir: string;
let config: string;
let project: string;

/** The hook output for `command`, the payload's cwd the project; exit 0 and
 * a quiet stderr asserted on every call. */
const emission = (
	command: string,
	{
		cores = "8",
		cwd = project,
	}: { cores?: string | undefined; cwd?: string | undefined } = {},
) =>
	nodeGuardOutput(
		GUARD,
		{
			...buildBashPayload(command, null),
			...(cwd === undefined ? {} : { cwd }),
		},
		{ project, config, cwd: project, env: { WFC_CPU_COUNT: cores } },
	);

beforeEach(() => {
	({ dir, config } = guardDirs("guard-cpu-load-"));
	project = path.join(dir, "project");
	fs.mkdirSync(project);
	fs.writeFileSync(
		path.join(project, "loaded.sh"),
		`#!/usr/bin/env bash\n${LOOP}\nfor i in 1 2; do npx vitest run x; done\n`,
	);
	fs.writeFileSync(
		path.join(project, "capped.sh"),
		"systemd-run --user --scope -p CPUQuota=200% bash -c 'yes >/dev/null & wait'\n",
	);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the guard, end to end", () => {
	it("refuses the #2710 incident's form, read off a real script, as JSON on exit 0", () => {
		const out = emission("bash scripts/bg-run.sh run load bash loaded.sh");
		expect(out.permissionDecision).toBe("deny");
		expect(
			out.permissionDecisionReason,
		).toBe(`Refused: \`yes >/dev/null & (in loaded.sh)\` is a CPU load generator with no CPU cap. Every session shares this machine's 8 cores; on 23 Oct 2026 eight uncapped \`yes\` loops starved the kernel's RCU thread and WSL had to be restarted (#2710).

Synthetic load runs inside a cap of at most 4 cores, the whole load under one cap:

  systemd-run --user --scope -p CPUQuota=400% -- bash -c '<the load>; wait'
  taskset -c 0-3 bash -c '<the load>; wait'

\`yes | <command>\`, feeding a command, passes.`);
		expect(readFailOpenRecords(config, project)).toEqual([]);
	});

	it("passes the capped form of a real script, and a pipe, in silence", () => {
		expect(
			emission("systemd-run --user --scope -p CPUQuota=400% bash loaded.sh"),
		).toBeNull();
		expect(emission("bash capped.sh")).toBeNull();
		expect(emission("yes | head")).toBeNull();
		expect(readFailOpenRecords(config, project)).toEqual([]);
	});

	it("adds up two real capped scripts", () => {
		expect(
			emission("for i in 1 2; do bash capped.sh & done")
				.permissionDecisionReason,
		).toContain("two caps add up to more than one");
	});

	it("resolves a script against the payload's cwd, else the hook's own", () => {
		const elsewhere = path.join(dir, "elsewhere");
		fs.mkdirSync(elsewhere);
		expect(emission("bash loaded.sh", { cwd: elsewhere })).toBeNull();
		expect(
			emission("bash loaded.sh", { cwd: undefined }).permissionDecision,
		).toBe("deny");
		expect(
			emission("bash loaded.sh", { cwd: "project" }).permissionDecision,
		).toBe("deny");
	});

	it("reads no directory, and no script past 256 KB, off the disk", () => {
		fs.mkdirSync(path.join(project, "dir.sh"));
		expect(emission("bash dir.sh")).toBeNull();
		const head = "yes >/dev/null &\n";
		fs.writeFileSync(
			path.join(project, "big.sh"),
			head + "#".repeat(262_144 - head.length),
		);
		expect(emission("bash big.sh").permissionDecision).toBe("deny");
		fs.appendFileSync(path.join(project, "big.sh"), "#");
		expect(emission("bash big.sh")).toBeNull();
	});
});

describe("the core count", () => {
	it("is WFC_CPU_COUNT from the hook's environment, sizing the cap", () => {
		const command = `systemd-run --user --scope -p CPUQuota=200% bash -c '${LOOP}'`;
		expect(emission(command, { cores: "2" })?.permissionDecision).toBe("deny");
		expect(emission(command, { cores: "4" })).toBeNull();
	});

	it("is the online count where WFC_CPU_COUNT is unset", () => {
		const out = emission("yes >/dev/null &", { cores: undefined });
		expect(out.permissionDecisionReason).toContain(
			`this machine's ${os.cpus().length} cores;`,
		);
	});

	it("allows every command, recorded, where it does not resolve", () => {
		expect(emission("yes >/dev/null &", { cores: "eight" })).toBeNull();
		expect(readFailOpenRecords(config, project)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				"guard-cpu-load.js",
				"the core count did not resolve — every command allowed unchecked",
			],
		]);
	});
});

describe("the fail-open record", () => {
	const run = (stdin: string) =>
		runNodeGuard(GUARD, null, {
			project,
			config,
			cwd: project,
			stdin,
			env: { WFC_CPU_COUNT: "8" },
		});

	it("treats an empty payload as nothing to check, not a fault", () => {
		const r = run("");
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it.each([
		[
			"a payload that is not JSON",
			"{not json",
			/payload did not parse as JSON/,
		],
		[
			"a payload carrying no command",
			JSON.stringify({ tool_name: "Bash", tool_input: {} }),
			/no command in payload/,
		],
	])("records %s, allowing", (_l, stdin, match) => {
		const r = run(stdin);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(readFailOpenRecords(config, project)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				"guard-cpu-load.js",
				expect.stringMatching(match),
			],
		]);
	});

	it("records an affinity it cannot read, taking it as a cap", () => {
		expect(emission("taskset zz yes >/dev/null &")).toBeNull();
		expect(readFailOpenRecords(config, project)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				"guard-cpu-load.js",
				"taskset affinity 'zz' unreadable — taken as a cap",
			],
		]);
	});

	it("refuses, logged, where its core throws", () => {
		const out = nodeGuardOutput(
			entryBesideThrowingCore(dir, "scripts/guard-cpu-load.js", "cpu-load.js"),
			buildBashPayload("yes | head", null),
			{ project, config, cwd: project, env: { WFC_CPU_COUNT: "8" } },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-cpu-load.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, project)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});
});
