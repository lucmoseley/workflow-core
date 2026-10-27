// @vitest-environment node
/*
 * Direct tests for scripts/lib/suite-launch.js (#1528): every launch spelling
 * the suite guards share, read through lib/shell-parse.js's walk so a quoted
 * word arrives masked, as it does in a guard. A misread spelling is misjudged
 * by each guard taking its kind: a suite let past the cap or detached
 * unwatched, or a command that launches nothing refused.
 */
import { describe, expect, it } from "vitest";
import { PY_COLLECTED_TEST } from "./test-kind";

const { parseCommand, walkCommands } = require("./shell-parse.js") as {
	parseCommand: (c: string) => { spans: string[] };
	walkCommands: (
		p: unknown,
		fn: (cmd: { words: string[] }) => void,
		ports: object,
	) => void;
};
const { QUOTED, literal, unwrap } = require("./shell-words.js") as {
	QUOTED: string;
	literal: (w: string, spans: string[]) => { known: boolean; text: string };
	unwrap: (words: string[], spans: string[]) => { words: string[] };
};
const { hasWrapperCall, isOtherRunner, suiteLaunchKind } =
	require("./suite-launch.js") as {
		hasWrapperCall: (body: string | null) => boolean;
		isOtherRunner: (words: string[], runners: () => string[]) => boolean;
		suiteLaunchKind: (
			words: string[],
			ports: object,
		) => {
			kind: string;
			script: string;
			taken: number;
			queued: boolean;
		} | null;
	};

const scripts: Record<string, string> = {
	test: "node --test",
	"test:changed": "node scripts/run-vitest.js --changed",
};
const ports = {
	runners: () => ["scripts/build-site.js"],
	isWrapperScript: (s: string) => hasWrapperCall(scripts[s] ?? null),
};

/** `kind|script|taken` for each segment of the command, or `none`. */
const kindOf = (command: string) => {
	const parsed = parseCommand(command);
	const out: string[] = [];
	walkCommands(
		parsed,
		(cmd) => {
			const typed = unwrap(cmd.words, parsed.spans).words.map((w) => {
				if (!w.includes(QUOTED)) return w;
				const lit = literal(w, parsed.spans);
				return lit.known ? lit.text : w;
			});
			const l = suiteLaunchKind(typed, ports);
			out.push(
				l
					? `${l.kind}|${l.script}|${l.taken}${l.queued ? "|queued" : ""}`
					: "none",
			);
		},
		{ cwd: __dirname, fallbackCwd: __dirname, vars: {}, isDir: () => false },
	);
	return out.join("\n");
};

/** Each launch spelling, and the `kind|script|taken` it reads as. */
const LAUNCHES: [string, string][] = [
	["npm test", "npm-vitest|test|2"],
	["npm run test", "npm-vitest|test|3"],
	["npm run test:changed", "npm-vitest|test:changed|3"],
	["npm run test:watch", "npm-watch|test:watch|3"],
	["npm test:py", "npm-py|test:py|2"],
	["npm run test:py", "npm-py|test:py|3"],
	[`npm run "test"`, "npm-vitest|test|3"],
	[`npm run 'test:changed' -- --queue`, "npm-vitest|test:changed|3"],
	[`npm "test"`, "npm-vitest|test|2"],
	["/usr/bin/npm run test", "npm-vitest|test|3"],
	["node scripts/run-vitest.js", "wrapper||2"],
	["node /abs/scripts/run-vitest.js a.test.ts", "wrapper||2"],
	[`node "scripts/run-vitest.js"`, "wrapper||2"],
	["node --test", "other||0"],
	["node --test scripts/x.test.js", "other||0"],
	["pytest", "other||0"],
	["pytest -q tests/", "other||0"],
	["python3 -m pytest", "other||0"],
	["python -m unittest", "other||0"],
	["python3 scripts/foo.test.py", "other||0"],
	["python3 tests/test_foo.py", "other||0"],
	[`python3 "scripts/foo.test.py"`, "other||0"],
	["node scripts/build-site.js", "other||0"],
	["node /home/u/fb/scripts/build-site.js", "other||0"],
	// The non-vitest queue (#1776): the command behind it, queued.
	["node scripts/queue-run.js -- node --test", "other||0|queued"],
	["node /p/scripts/queue-run.js -- pytest -q", "other||0|queued"],
	["node scripts/queue-run.js pytest", "other||0|queued"],
	[
		"timeout 900 node scripts/queue-run.js -- timeout 600 python3 a.test.py",
		"other||0|queued",
	],
	// An npm script `--queue` cannot reach, not running run-vitest.js.
	["node scripts/queue-run.js -- npm run test", "other||0|queued"],
	[
		"node scripts/queue-run.js -- node scripts/build-site.js",
		"other||0|queued",
	],
];

/** Spellings that launch no suite. */
const NONES = [
	"npm run build",
	"npm run lint",
	"npm test:changed",
	"npm test:watch",
	`npm run "$SCRIPT"`,
	"node --test-reporter x.js",
	`python3 -c "import pytest"`,
	`node -e "require('x')"`,
	"node scripts/other.js",
	"vitest run",
	"node scripts/queue-run.js -- npm run test:changed",
	"node scripts/queue-run.js -- node scripts/queue-run.js -- pytest",
	"node scripts/queue-run.js -- ls",
	"node scripts/queue-run.js --",
];

describe("suiteLaunchKind", () => {
	it.each(LAUNCHES)("reads %s as a launch: %s", (command, kind) => {
		expect(kindOf(command)).toBe(kind);
	});

	it.each(NONES)("reads %s as no launch", (command) => {
		expect(kindOf(command)).toBe("none");
	});

	it("reads each segment on its own", () => {
		expect(kindOf("npm run build && pytest")).toBe("none\nother||0");
	});
});

// #2759
describe("isOtherRunner's Python test globs", () => {
	it("call a basename a test exactly where test-kind.js's PY_COLLECTED_TEST does", () => {
		const bases = [
			"test_a.py",
			"a_test.py",
			"a.test.py",
			".test.py",
			"test_.py",
			"conftest.py",
			"a.py",
			"testa.py",
			"a_tests.py",
			"a.spec.py",
			"test_a.pyc",
		];
		expect(
			Object.fromEntries(
				bases.map((b) => [b, isOtherRunner(["python3", b], () => [])]),
			),
		).toEqual(
			Object.fromEntries(bases.map((b) => [b, PY_COLLECTED_TEST.test(b)])),
		);
	});
});
