// @vitest-environment node
/*
 * Tests for hook-wiring.ts (mantahostels#190): which event, matcher, `if`,
 * args and timeout settings.json gives each registered script.
 *
 * The parsing is exercised against literals, because the interesting inputs —
 * a matcher that nearly matches, a registration with no timeout, a script
 * wired twice — are all shapes the real settings.json does not currently hold.
 *
 * The guards' wiring tests assert through this reader, so a loosened case lets
 * a guard ship unwired or on the wrong event with those tests still green.
 */

import { describe, expect, it } from "vitest";
import {
	allRegistrations,
	commandLine,
	hookIsWired,
	readCoreHooks,
	registrationsOf,
} from "./hook-wiring";

const settings = {
	hooks: {
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [
					{ command: "$DIR/scripts/guard-a.sh", timeout: 10 },
					{ command: "$DIR/scripts/guard-b.sh" },
				],
			},
			{
				matcher: "Write|Edit|NotebookEdit",
				hooks: [{ command: "$DIR/scripts/guard-a.sh", timeout: 15 }],
			},
		],
		Stop: [
			{ hooks: [{ command: "$DIR/scripts/backstop.sh stop", timeout: 15 }] },
		],
	},
};

describe("registrationsOf", () => {
	it("carries the matcher down from the entry onto each hook", () => {
		expect(registrationsOf("PreToolUse", "guard-b.sh", settings)).toEqual([
			{
				matcher: "Bash",
				command: "$DIR/scripts/guard-b.sh",
				timeout: undefined,
			},
		]);
	});

	it("returns a script wired twice twice, so a count can be asserted", () => {
		const found = registrationsOf("PreToolUse", "guard-a.sh", settings);
		expect(found).toHaveLength(2);
		expect(found.map((r) => r.timeout)).toEqual([10, 15]);
	});

	it("reports a missing timeout as undefined rather than defaulting one", () => {
		// An unbounded hook is a real state: guard-last30days.sh has no timeout.
		expect(
			registrationsOf("PreToolUse", "guard-b.sh", settings)[0].timeout,
		).toBe(undefined);
	});

	it("is empty for an event nothing registers on", () => {
		expect(registrationsOf("SessionStart", "guard-a.sh", settings)).toEqual([]);
	});

	it("is empty for a script nothing registers", () => {
		expect(registrationsOf("PreToolUse", "guard-z.sh", settings)).toEqual([]);
	});
});

/*
 * The exec form (mantahostels#2059): the interpreter is the `command` and the script path
 * is the first `args` entry, with the guard's own argument behind it. Reading
 * `command` alone here finds `node` and no script at all (mantahostels#2266).
 */
const execFormSettings = {
	hooks: {
		Stop: [
			{
				hooks: [
					{
						command: "node",
						args: ["$DIR/scripts/backstop.sh", "stop"],
						timeout: 15,
					},
					{
						command: "node",
						args: ["$DIR/scripts/backstop.sh", "start"],
						timeout: 15,
					},
				],
			},
		],
	},
};

describe("the exec form's args (mantahostels#2266)", () => {
	it("finds a script whose path is held in args, not in command", () => {
		expect(
			registrationsOf("Stop", "scripts/backstop.sh", execFormSettings),
		).toHaveLength(2);
	});

	it("carries args through allRegistrations rather than dropping them", () => {
		expect(allRegistrations(execFormSettings)[0].args).toEqual([
			"$DIR/scripts/backstop.sh",
			"stop",
		]);
	});

	it("tells two registrations of one script apart on their argument", () => {
		// The whole reason args must be read: `stop` and `start` are the only
		// thing distinguishing these two entries.
		expect(
			registrationsOf("Stop", "backstop.sh stop", execFormSettings),
		).toHaveLength(1);
		expect(
			registrationsOf("Stop", "backstop.sh start", execFormSettings),
		).toHaveLength(1);
	});

	it("joins command and args into the one line the transcript records", () => {
		expect(commandLine(allRegistrations(execFormSettings)[1])).toBe(
			"node $DIR/scripts/backstop.sh start",
		);
	});

	it("leaves a shell-form registration with no args key at all", () => {
		expect("args" in allRegistrations(settings)[0]).toBe(false);
		expect(commandLine({ command: "$DIR/scripts/guard-a.sh" })).toBe(
			"$DIR/scripts/guard-a.sh",
		);
	});
});

/*
 * The `if` narrowing (mantahostels#2811). The field holds exactly one permission rule, so a
 * guard wanting several is registered once per rule: every copy shares a
 * command line, and `if` is the only thing telling them apart.
 */
const narrowedSettings = {
	hooks: {
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [
					{
						command: "$DIR/scripts/guard-n.sh",
						if: "Bash(*npm *)",
						timeout: 10,
					},
					{
						command: "$DIR/scripts/guard-n.sh",
						if: "Bash(*npx *)",
						timeout: 10,
					},
				],
			},
			{
				matcher: "Read",
				hooks: [{ command: "$DIR/scripts/guard-n.sh", timeout: 10 }],
			},
		],
	},
};

describe("the if narrowing (mantahostels#2811)", () => {
	it("carries if through allRegistrations rather than dropping it", () => {
		expect(allRegistrations(narrowedSettings).map((r) => r.if)).toEqual([
			"Bash(*npm *)",
			"Bash(*npx *)",
			undefined,
		]);
	});

	it("carries if through registrationsOf too", () => {
		const found = registrationsOf(
			"PreToolUse",
			"scripts/guard-n.sh",
			narrowedSettings,
		);
		expect(found).toHaveLength(3);
		expect(found.map((r) => r.if ?? null)).toEqual([
			"Bash(*npm *)",
			"Bash(*npx *)",
			null,
		]);
	});

	it("leaves an unnarrowed registration with no if key at all", () => {
		expect("if" in allRegistrations(narrowedSettings)[2]).toBe(false);
	});

	it("keeps if out of the command line", () => {
		expect(commandLine(allRegistrations(narrowedSettings)[0])).toBe(
			"$DIR/scripts/guard-n.sh",
		);
	});
});

describe("hookIsWired", () => {
	it("matches a tool named in an alternation", () => {
		expect(
			hookIsWired("PreToolUse", "guard-a.sh", "NotebookEdit", settings),
		).toBe(true);
	});

	it("anchors, so a matcher is not a substring test", () => {
		expect(hookIsWired("PreToolUse", "guard-a.sh", "WriteFile", settings)).toBe(
			false,
		);
	});

	it("treats an entry with no matcher as covering every tool", () => {
		expect(hookIsWired("Stop", "backstop.sh", "anything", settings)).toBe(true);
	});

	it("is false when the script is wired on a different event", () => {
		expect(hookIsWired("PostToolUse", "guard-a.sh", "Bash", settings)).toBe(
			false,
		);
	});

	it("is false for the right event and the wrong tool", () => {
		expect(hookIsWired("PreToolUse", "guard-b.sh", "Write", settings)).toBe(
			false,
		);
	});
});

describe("against the real registration", () => {
	it("reads the repo's own file", () => {
		expect(Object.keys(readCoreHooks().hooks ?? {})).toContain("PreToolUse");
	});

	it("finds a guard this repo genuinely wires", () => {
		expect(hookIsWired("PreToolUse", "guard-file-claim.sh", "Edit")).toBe(true);
	});

	/* The Jev advisory guard (#203), in the shape its five Stop siblings use: no
	 * matcher, and the 15-second timeout every one of them carries. */
	it("wires guard-jev-advisory.js on Stop, shaped like its siblings", () => {
		const found = registrationsOf("Stop", "scripts/guard-jev-advisory.js");
		expect(found).toHaveLength(1);
		expect(found[0].matcher).toBe(undefined);
		expect(found[0].timeout).toBe(15);
		expect(found[0].command).toContain("|| true");
	});
});
