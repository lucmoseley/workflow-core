// @vitest-environment node
/*
 * lib/cli-args.js's contract (#920), limb by limb: --help, an unknown flag, a
 * missing value, a boolean beside a positional, and per-subcommand specs.
 * It calls `parse` in-process and reads the CliExit it throws, so no case
 * exits the runner. One case spawns node: a full non-blocking pipe needs a real
 * fd, which run-in-process cannot give it.
 * Every script on the helper inherits these answers, so loosening a case here
 * loosens all of them.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CliExit, flagValue, parse, parseOrCode } from "./cli-args.js";
import { throughFullPipe } from "./full-pipe-testkit";

type CliSpec = import("./cli-args.js").CliSpec;

const SPEC = {
	usage: "usage: tool [--dry-run] [--repo <r>] [<id>]",
	flags: { "--dry-run": "boolean", "--repo": "value" },
	max: 1,
} satisfies CliSpec;

/** The CliExit a call throws, or a failure naming what it returned. */
function exitOf(argv: string[], spec: CliSpec = SPEC) {
	try {
		const parsed = parse(argv, spec);
		throw new Error(`no exit: parsed ${JSON.stringify(parsed)}`);
	} catch (e) {
		if (!(e instanceof CliExit)) throw e;
		return e;
	}
}

describe("parse", () => {
	it("answers --help with the usage and exit 0, wherever it sits", () => {
		for (const argv of [["--help"], ["--dry-run", "--help"], ["x", "-h"]]) {
			const e = exitOf(argv);
			expect(e.code).toBe(0);
			expect(e.text).toBe(`${SPEC.usage}\n`);
		}
	});

	it("answers --help before refusing an unknown flag beside it", () => {
		expect(exitOf(["--bogus", "--help"]).code).toBe(0);
	});

	it("refuses an unknown flag, naming it, with the usage and exit 2", () => {
		const e = exitOf(["--bogus"]);
		expect(e.code).toBe(2);
		expect(e.text).toBe(`unknown flag: --bogus\n\n${SPEC.usage}\n`);
		expect(exitOf(["-x"]).text).toContain("unknown flag: -x");
		expect(exitOf(["--bogus=1"]).text).toContain("unknown flag: --bogus\n");
	});

	it("refuses a value flag with no value, or with another flag in its place", () => {
		for (const argv of [["--repo"], ["--repo", "--dry-run"]]) {
			const e = exitOf(argv);
			expect(e.code).toBe(2);
			expect(e.text).toBe(`--repo needs a value\n\n${SPEC.usage}\n`);
		}
	});

	it("takes any value but a declared flag, inline or not", () => {
		expect(parse(["--repo", "- [ ] x"], SPEC).flags["--repo"]).toBe("- [ ] x");
		expect(parse(["--repo=--x"], SPEC).flags["--repo"]).toBe("--x");
		/* A markdown rule passed to issue-body.js's --text (#920's review). */
		expect(parse(["--repo", "---"], SPEC).flags["--repo"]).toBe("---");
	});

	/* #743's bug: a boolean flag swallowed the positional after it. */
	it("never lets a boolean flag take the positional after it", () => {
		expect(parse(["--dry-run", "42"], SPEC)).toEqual({
			command: undefined,
			flags: { "--dry-run": true },
			lists: {},
			positionals: ["42"],
		});
		expect(exitOf(["--dry-run=yes"]).text).toContain(
			"--dry-run takes no value",
		);
	});

	it("gathers a repeated list flag's values in order, refusing one with none and naming the flag", () => {
		const spec = { ...SPEC, flags: { ...SPEC.flags, "--label": "list" } };
		expect(
			parse(["--label", "a", "--dry-run", "--label=b"], spec as CliSpec).lists,
		).toEqual({ "--label": ["a", "b"] });
		expect(exitOf(["--label", "--dry-run"], spec as CliSpec).text).toContain(
			"--label needs a value",
		);
	});

	it("refuses a positional past the declared count, quoting it, and one short of it", () => {
		expect(exitOf(["a", "b"]).text).toContain("unexpected argument: b");
		expect(exitOf([], { ...SPEC, min: 1 }).text).toContain("missing argument");
	});

	it("reads everything after -- as positional, --help included", () => {
		expect(parse(["--", "--help"], SPEC).positionals).toEqual(["--help"]);
	});
});

describe("parse — subcommands", () => {
	const cmd = {
		usage: "usage: tool <command> <issue> [--repo <r>]",
		flags: { "--repo": "value" },
		commands: {
			tick: {
				usage: "usage: tool tick <issue> --match <s>",
				flags: { "--match": "value" },
				min: 1,
			},
			show: { usage: "usage: tool show <issue>", min: 1 },
		},
	} satisfies CliSpec;

	it("prints the named command's usage on --help, and the top level's otherwise", () => {
		expect(exitOf(["tick", "920", "--help"], cmd).text).toBe(
			`${cmd.commands.tick.usage}\n`,
		);
		expect(exitOf(["--help"], cmd).text).toBe(`${cmd.usage}\n`);
		expect(exitOf(["nope", "--help"], cmd).text).toBe(`${cmd.usage}\n`);
	});

	it("reads a command's own flags beside the top level's", () => {
		expect(
			parse(["tick", "920", "--match", "x", "--repo", "o/r"], cmd),
		).toEqual({
			command: "tick",
			flags: { "--match": "x", "--repo": "o/r" },
			lists: {},
			positionals: ["920"],
		});
	});

	it("refuses another command's flag, naming it, with this command's usage", () => {
		const e = exitOf(["show", "920", "--match", "x"], cmd);
		expect(e.code).toBe(2);
		expect(e.text).toBe(
			`unknown flag: --match\n\n${cmd.commands.show.usage}\n`,
		);
	});

	it("refuses an unknown command and a missing one with the top-level usage", () => {
		expect(exitOf(["nope", "1"], cmd).text).toBe(
			`unknown command: nope\n\n${cmd.usage}\n`,
		);
		expect(exitOf([], cmd).text).toBe(
			`a command is required\n\n${cmd.usage}\n`,
		);
		expect(exitOf(["--repo", "o/r"], cmd).code).toBe(2);
	});
});

describe("flagValue", () => {
	it("reads a value flag's string, and undefined for a boolean or an absent flag", () => {
		const { flags } = parse(["--repo", "r", "--dry-run"], SPEC);
		expect(flagValue(flags, "--repo")).toBe("r");
		expect(flagValue(flags, "--dry-run")).toBeUndefined();
		expect(flagValue(parse([], SPEC).flags, "--repo")).toBeUndefined();
	});
});

describe("parseOrCode", () => {
	it("returns the parse where nothing exits", () => {
		expect(parseOrCode(["7"], SPEC)).toEqual(parse(["7"], SPEC));
	});

	it("returns the exit code where help or a refusal ends the run", () => {
		// The whole text taken: a 0-byte answer holds writeFd for its 10 s ceiling.
		const write = vi
			.spyOn(fs, "writeSync")
			.mockImplementation((_fd, data) => Buffer.byteLength(data as string));
		try {
			expect(parseOrCode(["--help"], SPEC)).toBe(0);
			expect(parseOrCode(["--bogus"], SPEC)).toBe(2);
			expect(write.mock.calls.map(([fd]) => fd)).toEqual([1, 2]);
		} finally {
			write.mockRestore();
		}
	});
});

describe("parseOrExit", () => {
	/* A pipe can be non-blocking — a module the process loads that touches
	 * process.stderr sets that on the pipe itself, which the script's first
	 * statement stands in for. */
	it("waits out a full non-blocking stderr pipe, keeping the refusal and its exit code (#1641)", () => {
		const script = `process.stderr; require(${JSON.stringify(path.join(__dirname, "cli-args.js"))}).parseOrExit(["--bogus"], ${JSON.stringify(SPEC)});`;
		expect(throughFullPipe(2, ["-e", script])).toBe(
			`unknown flag: --bogus\n\n${SPEC.usage}\nexit 2\n`,
		);
	});
});
