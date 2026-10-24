// @vitest-environment node
/*
 * launch.sh hands each hand-launched command the model its kind calls for —
 * Sonnet rows, Opus rows, plain Opus for an unmapped kind, and a `--model`
 * override in either direction (mantahostels#1334, mantahostels#1088).
 *
 * launch.sh resolves scripts/dispatch-sessions.sh relative to its own
 * location ("$here/dispatch-sessions.sh"), not via PATH, so the seam is a
 * sibling stub file rather than a PATH shadow: copy launch.sh into a temp
 * dir alongside a stub dispatch-sessions.sh that records its argv, and the
 * real lib/launch-models.sh it sources.
 *
 * It is the launcher a session or the founder runs by hand: break a case here
 * and a launch silently inherits the default model again.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REAL_SCRIPT = path.resolve(__dirname, "launch.sh");

let dir: string;
let scriptCopy: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-"));
	scriptCopy = path.join(dir, "launch.sh");
	fs.copyFileSync(REAL_SCRIPT, scriptCopy);
	fs.chmodSync(scriptCopy, 0o755);
	fs.mkdirSync(path.join(dir, "lib"));
	fs.copyFileSync(
		path.resolve(__dirname, "lib/launch-models.sh"),
		path.join(dir, "lib/launch-models.sh"),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const stubDispatch = (): void => {
	const script = [
		"#!/bin/bash",
		`printf '%s\\n' "$*" >> "${path.join(dir, "argv")}"`,
		"exit 0",
	].join("\n");
	const file = path.join(dir, "dispatch-sessions.sh");
	fs.writeFileSync(file, script);
	fs.chmodSync(file, 0o755);
};

const stubDispatchExiting = (code: number): void => {
	const script = ["#!/bin/bash", `exit ${code}`].join("\n");
	const file = path.join(dir, "dispatch-sessions.sh");
	fs.writeFileSync(file, script);
	fs.chmodSync(file, 0o755);
};

const run = (
	args: string[],
): { stdout: string; stderr: string; code: number } => {
	const r = spawnSync("bash", [scriptCopy, ...args], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
	return {
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		code: r.status ?? -1,
	};
};

const dispatchArgv = (): string | undefined => {
	const f = path.join(dir, "argv");
	if (!fs.existsSync(f)) return;
	return fs.readFileSync(f, "utf8").trim();
};

describe("the sonnet row", () => {
	it("launches pick-next on sonnet", () => {
		stubDispatch();
		const r = run(["pick-next", "1353"]);
		expect(r.code).toBe(0);
		expect(dispatchArgv()).toBe("sonnet /pick-next 1353");
	});
});

describe("the opus rows", () => {
	it.each([
		"implement",
		"to-tickets",
		"triage",
		"wayfinder",
		"to-spec",
		"code-review",
		"manual-sync",
		"concision-pass",
		"research",
	])("launches %s on opus", (command) => {
		stubDispatch();
		const r = run([command, "1114"]);
		expect(r.code).toBe(0);
		expect(dispatchArgv()).toBe(`opus /${command} 1114`);
	});
});

describe("commands with no argv", () => {
	it("builds a bare slash prompt when no args are given (mantahostels#1353)", () => {
		stubDispatch();
		const r = run(["pick-next"]);
		expect(r.code).toBe(0);
		expect(dispatchArgv()).toBe("sonnet /pick-next");
	});
});

describe("skills invoked inside a host, never standalone", () => {
	it.each(["card-close", "roadmap-edit"])(
		"launches %s on plain Opus rather than refusing it (mantahostels#1334, mantahostels#1093's unlisted-kind fallthrough)",
		(command) => {
			stubDispatch();
			const r = run([command]);
			expect(r.code).toBe(0);
			expect(r.stderr).toContain("NOTE");
			expect(r.stderr).toContain("#1334");
			expect(r.stderr).toContain(
				"invoked as a skill inside an existing session, not launched standalone",
			);
			expect(dispatchArgv()).toBe(`opus /${command}`);
		},
	);
});

describe("an unrecognised command", () => {
	it("notes the fallback and launches on plain Opus (mantahostels#1088's tie-break)", () => {
		stubDispatch();
		const r = run(["some-future-kind", "42"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("NOTE");
		expect(r.stderr).toContain("some-future-kind");
		expect(r.stderr).toContain("not one of the Sonnet-table kinds");
		expect(dispatchArgv()).toBe("opus /some-future-kind 42");
	});
});

describe("--model override", () => {
	it("escalates a Sonnet-table kind to Opus (mantahostels#1334's Q2)", () => {
		stubDispatch();
		const r = run(["--model", "opus", "pick-next", "1352"]);
		expect(r.code).toBe(0);
		expect(dispatchArgv()).toBe("opus /pick-next 1352");
	});

	it("accepts the --model=<alias> spelling", () => {
		stubDispatch();
		const r = run(["--model=opus", "pick-next", "1352"]);
		expect(r.code).toBe(0);
		expect(dispatchArgv()).toBe("opus /pick-next 1352");
	});

	it("is not itself forwarded to dispatch-sessions.sh as a flag", () => {
		stubDispatch();
		run(["--dry-run", "--model", "opus", "pick-next", "1352"]);
		const argv = dispatchArgv();
		expect(argv).toBe("--dry-run opus /pick-next 1352");
		expect(argv).not.toContain("--model");
	});
});

describe("flag passthrough", () => {
	it("forwards leading flags to dispatch-sessions.sh ahead of the model/prompt pair", () => {
		stubDispatch();
		const r = run(["--dry-run", "--no-advisor", "pick-next", "341"]);
		expect(r.code).toBe(0);
		expect(dispatchArgv()).toBe("--dry-run --no-advisor sonnet /pick-next 341");
	});
});

describe("usage", () => {
	it("exits 2 with usage on stderr when no command is given", () => {
		stubDispatch();
		const r = run([]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("usage:");
	});

	it("exits 2 with usage on stderr when only flags are given", () => {
		stubDispatch();
		const r = run(["--dry-run"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("usage:");
	});
});

describe("exit code propagation", () => {
	it("propagates dispatch-sessions.sh's exit code verbatim", () => {
		stubDispatchExiting(3);
		const r = run(["implement", "1"]);
		expect(r.code).toBe(3);
	});
});
