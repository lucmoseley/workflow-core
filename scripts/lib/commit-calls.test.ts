// @vitest-environment node
/*
 * lib/commit-calls.js (#2383, #2793) in process: which calls in a command are
 * commits, and which message word each carries.
 */

import { describe, expect, it } from "vitest";

const { commitCalls } = require("./commit-calls.js") as {
	commitCalls: (
		command: string,
	) => { call: string; flag: string; word: string }[];
};

describe("commitCalls", () => {
	it.each([
		[
			'git commit -m "fix a" -- a.js',
			[{ call: 'git commit -m "fix a" -- a.js', flag: "m", word: '"fix a"' }],
		],
		[
			"git commit -F msg.txt -- a.js",
			[{ call: "git commit -F msg.txt -- a.js", flag: "F", word: "msg.txt" }],
		],
		[
			"git commit -F $M -- a.js",
			[{ call: "git commit -F $M -- a.js", flag: "-", word: "" }],
		],
		[
			"git commit -- a.js",
			[{ call: "git commit -- a.js", flag: "-", word: "" }],
		],
		[
			"git commit -m one -F two",
			[{ call: "git commit -m one -F two", flag: "m", word: "one" }],
		],
		[
			'cd /r && node scripts/commit-paths.js -m "x y" -- a.js',
			[
				{
					call: 'node scripts/commit-paths.js -m "x y" -- a.js',
					flag: "m",
					word: '"x y"',
				},
			],
		],
		[
			"node scripts/commit-paths.js -F m.txt -- a.js",
			[
				{
					call: "node scripts/commit-paths.js -F m.txt -- a.js",
					flag: "F",
					word: "m.txt",
				},
			],
		],
	])("reads %j", (command, calls) => {
		expect(commitCalls(command)).toEqual(calls);
	});

	it.each([
		["a --tree pin", "node scripts/commit-paths.js --tree -- a.js"],
		["two messages", "node scripts/commit-paths.js -m a -m b -- a.js"],
		["no message", "node scripts/commit-paths.js -- a.js"],
		["--help", "node scripts/commit-paths.js --help"],
		["another subcommand", "git status"],
		["a mention", "grep 'git commit -m x' notes.md"],
	])("counts no %s", (_name, command) => {
		expect(commitCalls(command)).toEqual([]);
	});
});
