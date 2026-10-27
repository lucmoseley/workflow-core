// @vitest-environment node
/*
 * guard-wide-read.js warns where a Bash command pours a whole file, a wide
 * slice or an uncounted glob into the context window (mantahostels#1562).
 * These are its boundary cases (§X11), run as the harness runs it: the
 * payload on stdin, the WFC_WIDE_READ_* thresholds from the environment, the
 * hook's own directory for a relative path, and the real file-size, glob and
 * core-path adapters, end to end. Which command earns which warning, and the
 * `Read` limb the dispatcher runs, are lib/wide-read.test.ts's (#2791).
 *
 * Every warning asserts no `permissionDecision`: this guard warns and must
 * never deny.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import {
	buildBashPayload,
	entryBesideThrowingCore,
	guardDirs,
	nodeGuardOutput,
	readHookLines,
	runNodeGuard,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

const { CONTRACT } = require("./lib/workflow-core-config.js");

const GUARD = path.resolve(__dirname, "guard-wide-read.js");
const LINES = readHookLines(
	"self-plugin/hooks/hooks.json",
	"scripts/guard-wide-read.js",
);

let dir: string;
let config: string;
let project: string;

beforeEach(() => {
	({ dir, config } = guardDirs("guard-wide-read-"));
	project = path.join(dir, "project");
	fs.mkdirSync(project);
	fs.writeFileSync(path.join(project, "big.md"), "x".repeat(1001));
	fs.writeFileSync(path.join(project, "small.md"), "x".repeat(20));
	for (const n of [1, 2, 3])
		fs.writeFileSync(path.join(project, `part-${n}.txt`), "y".repeat(10));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const emission = (command: string, env: NodeJS.ProcessEnv = {}) =>
	nodeGuardOutput(GUARD, buildBashPayload(command), {
		project,
		config,
		cwd: project,
		env: { WFC_WIDE_READ_BYTES: "1000", WFC_WIDE_READ_MATCHES: "3", ...env },
	});

describe("the guard, end to end", () => {
	it("warns as additionalContext on exit 0, measuring a relative path from the hook's directory against the env's threshold", () => {
		const out = emission("cat big.md");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toMatch(
			/^Reading a whole file into context: big\.md is 1001 characters/,
		);
		expect(out.additionalContext).toMatch(
			/Why this fires and what the convention asks for: docs\/agents\/tool-output\.md\. It only ever warns\.$/,
		);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it("is silent under the env's threshold, and on the shipped default", () => {
		expect(emission("cat small.md")).toBeNull();
		expect(emission("cat big.md", { WFC_WIDE_READ_BYTES: undefined })).toBe(
			null,
		);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it("counts a glob through the shell's expansion on disk", () => {
		expect(emission("cat part-*.txt").additionalContext).toContain(
			"`part-*.txt` matches at least 3 files, 30 characters or more",
		);
	});

	it("spells core paths at the plugin root in an install", () => {
		// WFC_SCRIPT_ROOT stands in for an install: a core root with no
		// package.json.
		const install = path.join(dir, "install");
		fs.mkdirSync(path.join(install, "docs", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(install, "docs", "agents", "tool-output.md"),
			"",
		);
		expect(
			emission("cat big.md", { WFC_SCRIPT_ROOT: install }).additionalContext,
		).toContain(`asks for: ${install}/docs/agents/tool-output.md.`);
	});

	it("runs from each of its registrations' hook lines", () => {
		expect(LINES).toHaveLength(3);
		for (const line of LINES) {
			const r = spawnGuard("/bin/bash", buildBashPayload("cat big.md"), {
				project: path.resolve(__dirname, ".."),
				config,
				cwd: project,
				args: ["-c", line],
				env: { WFC_WIDE_READ_BYTES: "1000" },
			});
			expect([r.status, r.stderr]).toEqual([0, ""]);
			expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(
				/^Reading a whole file into context: big\.md/,
			);
		}
	});
});

describe("a host listing the guard under `disabled`", () => {
	const declare = (disabled: string[]) => {
		fs.mkdirSync(path.join(project, ".claude"));
		fs.writeFileSync(
			path.join(project, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: CONTRACT, disabled }),
		);
	};

	it("is silenced by the dispatcher row's name, so one entry stands down both limbs (#569)", () => {
		declare(["guard-wide-read"]);
		expect(emission("cat big.md")).toBeNull();
	});

	it("still warns where the list names another hook", () => {
		declare(["guard-branch"]);
		expect(emission("cat big.md")?.additionalContext).toMatch(
			/^Reading a whole file into context/,
		);
	});
});

describe("the fail-open record", () => {
	const run = (stdin: string) =>
		runNodeGuard(GUARD, null, { project, config, cwd: project, stdin });

	it("treats an empty payload as nothing to check, not a fault", () => {
		const r = run("");
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it.each([
		[
			"a payload that is not JSON",
			"not json at all",
			/payload did not parse as JSON/,
		],
		[
			"a payload carrying no command",
			JSON.stringify({ session_id: "t", tool_name: "Bash", tool_input: {} }),
			/no command in payload — read allowed unchecked/,
		],
	])(
		"records %s in three fields under its own name, allowing",
		(_l, stdin, match) => {
			const r = run(stdin);
			expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
			const lines = readFailOpenLog(config, project).trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]?.split("\t")).toEqual([
				expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				"guard-wide-read.js",
				expect.stringMatching(match),
			]);
		},
	);

	it("allows, logged, where its core throws", () => {
		const entry = entryBesideThrowingCore(
			dir,
			"scripts/guard-wide-read.js",
			"wide-read.js",
		);
		const r = runNodeGuard(entry, buildBashPayload("cat big.md"), {
			project,
			config,
			cwd: project,
		});
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(readFailOpenLog(config, project)).toMatch(
			/guard threw — allowed unchecked: broke/,
		);
	});
});
