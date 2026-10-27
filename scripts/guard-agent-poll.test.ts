// @vitest-environment node
/*
 * guard-agent-poll.js stops a session waiting by looking on its Bash routes —
 * a no-op command and a timed watch (mantahostels#627, mantahostels#659).
 * These are its boundary cases (§X11), run as the harness runs it: the payload
 * on stdin, the TMPDIR its window lives under, the real clock, the real
 * window file and the real core-path rewrite, each exit path once. Which call
 * earns which verdict is lib/agent-poll.test.ts's; the throw policy is
 * lib/refuse-on-throw.test.ts's.
 *
 * Every case gets its own TMPDIR, where the window lives, and its own
 * CLAUDE_CONFIG_DIR, because a fail-open is recorded (mantahostels#147).
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import {
	entryBesideThrowingCore,
	guardDirs,
	nodeGuardOutput,
	readHookLines,
	runNodeGuard,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

const { CONTRACT } = require("./lib/workflow-core-config.js");

const GUARD = path.resolve(__dirname, "guard-agent-poll.js");
const LINES = readHookLines(
	"self-plugin/hooks/hooks.json",
	"scripts/guard-agent-poll.js",
);

let dir: string;
let config: string;
let project: string;
let tmp: string;

const bashCall = (command: string, session = "s1") => ({
	session_id: session,
	tool_name: "Bash",
	tool_input: { command },
});

const emission = (
	payload: unknown,
	env: NodeJS.ProcessEnv = {},
): Record<string, string> | null =>
	nodeGuardOutput(GUARD, payload, {
		project,
		config,
		cwd: project,
		env: { TMPDIR: tmp, ...env },
	});

beforeEach(() => {
	({ dir, config } = guardDirs("guard-agent-poll-"));
	project = path.join(dir, "project");
	tmp = path.join(dir, "tmp");
	fs.mkdirSync(project);
	fs.mkdirSync(tmp);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the guard, end to end", () => {
	it("refuses the second no-op as JSON on exit 0, its window under the env's TMPDIR", () => {
		expect(emission(bashCall("true"))).toBeNull();
		const out = emission(bashCall("true"));
		expect(out?.permissionDecision).toBe("deny");
		expect(out?.permissionDecisionReason).toMatch(
			/^Ending a turn is not a tool call\./,
		);
		expect(
			fs.readFileSync(path.join(tmp, "wfc-agent-poll", "s1"), "utf8"),
		).toMatch(/^\d+\tnoop\n$/);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it("warns a fourth timed check as context, its watcher spelled at the plugin root in an install", () => {
		// WFC_SCRIPT_ROOT stands in for an install: a core root with no
		// package.json.
		const install = path.join(dir, "install");
		fs.mkdirSync(path.join(install, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(install, "scripts", "watch-artefact.js"), "");
		const env = { WFC_SCRIPT_ROOT: install };
		for (let i = 0; i < 3; i++)
			expect(emission(bashCall("sleep 1; ls"), env)).toBeNull();
		const out = emission(bashCall("sleep 1; ls"), env);
		expect(out?.permissionDecision).toBeUndefined();
		expect(out?.additionalContext).toContain(
			`node ${install}/scripts/watch-artefact.js <artefact> 120`,
		);
	});

	it("keys a subagent's window by the payload's agent_id, and tells it to wait in the turn (#1169)", () => {
		const sub = { ...bashCall("true"), agent_id: "x/y" };
		expect(emission(sub)).toBeNull();
		const out = emission(sub);
		expect(out?.permissionDecisionReason).toContain("You are a subagent");
		expect(fs.readdirSync(path.join(tmp, "wfc-agent-poll"))).toEqual([
			"s1.ax_y",
		]);
	});

	it("runs from each of its registrations' hook lines", () => {
		expect(LINES).toHaveLength(4);
		for (const [i, line] of LINES.entries()) {
			const r = spawnGuard("/bin/bash", bashCall("true", `line${i}`), {
				project: path.resolve(__dirname, ".."),
				config,
				cwd: project,
				args: ["-c", line],
				env: { TMPDIR: tmp },
			});
			expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
			expect(fs.existsSync(path.join(tmp, "wfc-agent-poll", `line${i}`))).toBe(
				true,
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

	it("is silenced by the dispatcher row's name, so one entry stands down every route (#569)", () => {
		declare(["guard-agent-poll"]);
		expect(emission(bashCall("true"))).toBeNull();
		expect(emission(bashCall("true"))).toBeNull();
	});

	it("still refuses where the list names another hook", () => {
		declare(["guard-branch.js"]);
		expect(emission(bashCall("true"))).toBeNull();
		expect(emission(bashCall("true"))?.permissionDecision).toBe("deny");
	});
});

describe("the fail-open record", () => {
	const run = (stdin: string) =>
		runNodeGuard(GUARD, null, {
			project,
			config,
			cwd: project,
			stdin,
			env: { TMPDIR: tmp },
		});

	it("treats an empty payload as nothing to check, not a fault", () => {
		const r = run("");
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it.each([
		[
			"a payload that is not JSON",
			"not json at all",
			/payload did not parse as JSON — poll check allowed unchecked/,
		],
		[
			"a payload carrying no session_id",
			JSON.stringify({ tool_name: "Bash", tool_input: { command: "true" } }),
			/no session_id in payload — poll check allowed unchecked/,
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
				"guard-agent-poll.js",
				expect.stringMatching(match),
			]);
		},
	);

	it("refuses, logged, where its core throws", () => {
		const entry = entryBesideThrowingCore(
			dir,
			"scripts/guard-agent-poll.js",
			"agent-poll.js",
		);
		const out = nodeGuardOutput(entry, bashCall("true"), {
			project,
			config,
			cwd: project,
			env: { TMPDIR: tmp },
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-agent-poll.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, project)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});
});
