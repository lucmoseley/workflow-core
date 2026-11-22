// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TreePorts } from "./guard-host-ports.js";
import { PY_COLLECTED_TEST } from "./test-kind";
import { treePortsFake } from "./tree-ports-fake";

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
	unwrap: (
		words: string[],
		spans: string[],
	) => [{ words: string[] }, ...{ words: string[] }[]];
};
const {
	buildIsWrapperScript,
	hasNamedTestFiles,
	isOtherRunner,
	isQueueable,
	isWholePytestRun,
	suiteLaunchKind,
} = require("./suite-launch.js") as {
	isQueueable: (words: string[], ports: object) => boolean;
	hasNamedTestFiles: (words: string[]) => boolean;
	isWholePytestRun: (argv: string[]) => boolean;
	buildIsWrapperScript: (
		tree: () => TreePorts,
		log: (what: string) => void,
	) => (script: string) => boolean;
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
	isWrapperScript: buildIsWrapperScript(
		() => treePortsFake({ "package.json": JSON.stringify({ scripts }) }),
		() => undefined,
	),
};

const kindOf = (command: string) => {
	const parsed = parseCommand(command);
	const out: string[] = [];
	walkCommands(
		parsed,
		(cmd) => {
			const typed = unwrap(cmd.words, parsed.spans)[0].words.map((w) => {
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
	["npm t", "npm-vitest|test|2"],
	["npm tst", "npm-vitest|test|2"],
	["npm rum test", "npm-vitest|test|3"],
	["npm urn test", "npm-vitest|test|3"],
	["npm run-script test", "npm-vitest|test|3"],
	["npm run-s test:changed", "npm-vitest|test:changed|3"],
	["npm runScript test:py", "npm-py|test:py|3"],
	["/usr/bin/npm run test", "npm-vitest|test|3"],
	["node scripts/run-vitest.js", "wrapper||2"],
	["node scripts/run-pytest.js --full", "npm-py||2"],
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
	["node scripts/queue-run.js -- node --test", "other||0|queued"],
	["node /p/scripts/queue-run.js -- pytest -q", "other||0|queued"],
	["node scripts/queue-run.js pytest", "other||0|queued"],
	[
		"timeout 900 node scripts/queue-run.js -- timeout 600 python3 a.test.py",
		"other||0|queued",
	],
	["node scripts/queue-run.js -- npm run test", "other||0|queued"],
	[
		"node scripts/queue-run.js -- node scripts/build-site.js",
		"other||0|queued",
	],
];

const NONES = [
	"npm run build",
	"npm run lint",
	"npm test:changed",
	"npm test:watch",
	"npm start",
	"npm rum build",
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

describe("isWholePytestRun (#4775)", () => {
	const whole = (argv: string[]) => isWholePytestRun(argv);

	it("reads a bare run as touched, never whole", () => {
		expect(whole([])).toBe(false);
		expect(whole(["--"])).toBe(false);
	});

	it.each([
		[["--", "scripts"], "a directory"],
		[["--", "--full"], "the lone `--full`"],
		[["--", "-x"], "flags alone"],
		[["--", "--deselect", "scripts/test_a.py::test_x"], "a deselected test"],
		[["--", "--ignore", "scripts/test_a.py"], "an ignored file"],
		[["--", "--junit-xml", "out.xml"], "an unlisted flag's value"],
		[["--", "scripts/test_a.py", "scripts/lib"], "a file beside a directory"],
		[["--", "scripts/helper.py"], "a Python file pytest does not collect"],
	])("reads %j as whole — %s", (argv) => {
		expect(whole(argv)).toBe(true);
	});

	it.each([
		[["--", "scripts/test_a.py"], "one test file"],
		[
			["--", "-x", "scripts/a_test.py", "scripts/b.test.py"],
			"files and a flag",
		],
		[["scripts/test_a.py::test_one"], "a node id"],
		[["--", "-k", "name", "-n", "4", "scripts/test_a.py"], "flags' values"],
	])("reads %j as a part run — %s", (argv) => {
		expect(whole(argv)).toBe(false);
	});
});

describe("hasNamedTestFiles on `python3 -m unittest` (#5450)", () => {
	const named = (command: string) => hasNamedTestFiles(command.split(" "));

	it.each([
		"python3 -m unittest tests.test_picker tests.test_bot",
		"python3 -m unittest tests.test_picker.PickerTest.test_one",
		"python3 -m unittest -v tests/test_picker.py",
		"python3 -m unittest -k slow tests.test_picker",
		"python3 -m unittest --durations 5 tests.checks_test",
	])("reads `%s` as a part-suite", (command) => {
		expect(named(command)).toBe(true);
	});

	it.each([
		["python3 -m unittest", "a bare run discovers"],
		["python3 -m unittest discover tests", "`discover`"],
		["python3 -m unittest -k slow", "`-k` with no target discovers"],
		["python3 -m unittest tests", "a package with no test segment"],
		[
			"python3 -m unittest pkg.Foo.test_x",
			"a module part with no test segment",
		],
		["python3 -m unittest tests.test_a tests/helper.py", "a non-test file"],
	])("reads `%s` as whole — %s", (command) => {
		expect(named(command)).toBe(false);
	});
});

describe("isQueueable", () => {
	it("takes `npm run test:py`, whose queue is queue-run.js (#4775)", () => {
		expect(isQueueable(["npm", "run", "test:py", "--", "scripts"], ports)).toBe(
			true,
		);
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

describe("buildIsWrapperScript (#4276)", () => {
	const reader = (pkg?: string | Error) => {
		const logs: string[] = [];
		const tree = vi.fn(() =>
			treePortsFake(pkg === undefined ? {} : { "package.json": pkg }),
		);
		return { logs, tree, is: buildIsWrapperScript(tree, (w) => logs.push(w)) };
	};

	it("reads the npm script's body, resolving the tree once on the first ask", () => {
		const r = reader(JSON.stringify({ scripts }));
		expect(r.tree).not.toHaveBeenCalled();
		expect(r.is("test")).toBe(false);
		expect(r.is("test:changed")).toBe(true);
		expect(r.tree).toHaveBeenCalledTimes(1);
	});

	it("answers yes, unlogged, where package.json is absent", () => {
		const r = reader();
		expect(r.is("test")).toBe(true);
		expect(r.logs).toEqual([]);
	});

	it("answers yes, logged, where package.json will not read or parse", () => {
		const unreadable = reader(new Error("EACCES"));
		const unparsed = reader("{");
		expect(unreadable.is("test")).toBe(true);
		expect(unparsed.is("test")).toBe(true);
		expect(unreadable.logs).toEqual([
			expect.stringMatching(/^package\.json unreadable — /),
		]);
		expect(unparsed.logs).toEqual([
			expect.stringMatching(/^package\.json is not JSON — /),
		]);
	});

	it("lets a fault resolving the tree propagate, for the core to answer for", () => {
		const is = buildIsWrapperScript(
			() => {
				throw new Error("tree down");
			},
			() => undefined,
		);
		expect(() => is("test")).toThrow("tree down");
	});
});
