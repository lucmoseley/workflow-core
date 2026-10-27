// @vitest-environment node
/*
 * lib/vitest-wrapper.js, guard-vitest-wrapper.js's core (#2800), in process:
 * which vitest runs it warns are outside scripts/run-vitest.js's stall
 * watchdog (mantahostels#2002, the follow-on to mantahostels#1910's), what
 * the warning says, and when it drops the rule for the standing line
 * (mantahostels#2275).
 *
 * The rule store is the real one, read through lib/rule-text.js; the latch
 * (`told`), the script-path spelling and the core-path resolution are fakes
 * the case sets. What the kit makes of a verdict — the envelope, the latch
 * file, the fail-open log — is guard-vitest-wrapper.test.ts's boundary set.
 *
 * Loosen a case here and a bare vitest run parks on a hung call with no
 * output and no filename, unwarned — the hang mantahostels#1910's watchdog
 * was built for.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";

type Verdict = {
	injectRules?: string[];
	prelude?: string;
	latchAfter?: string;
	context?: string;
	deny?: string;
} | null;

const WRAPPER_RULE_FALLBACK =
	"A vitest run outside `scripts/run-vitest.js` has no stall watchdog; the rule could not be read from docs/agents/rules/vitest-wrapper.txt. Read that file before doing anything else.";

const { decide } = require("./vitest-wrapper.js") as {
	decide: (command: string, ctx: object) => Verdict;
};

/** The rule fragment the first warning is meant to carry whole. */
const FRAGMENT = fs
	.readFileSync(
		path.resolve(
			__dirname,
			"..",
			"..",
			"docs",
			"agents",
			"rules",
			"vitest-wrapper.txt",
		),
		"utf8",
	)
	.trim();

interface Over {
	told?: boolean;
	ruleText?: (id: string) => string;
	corePaths?: (text: string) => string;
	scriptPath?: (name: string) => string;
	logs?: string[];
}

const ctxOf = ({ told = false, logs, ...over }: Over = {}) =>
	kitContextFake({
		cwd: "/repo",
		moduleOn: () => true,
		log: (what: string) => logs?.push(what),
		told: (id: string) => id === "vitest-wrapper" && told,
		...over,
	});

/** "warn" where the core hands the session text, "allow" where nothing. */
const verdict = (command: string, over: Over = {}) => {
	const v = decide(command, ctxOf(over));
	if (v === null) return "allow";
	expect(v.deny).toBeUndefined();
	return "warn";
};

/** The text the session reads: the prelude untold, the context once told. */
const message = (command: string, over: Over = {}) => {
	const v = decide(command, ctxOf(over));
	if (v === null) throw new Error(`no warning for ${command}`);
	return (v.prelude ?? v.context) as string;
};

describe("an unwrapped one-shot", () => {
	it.each([
		["vitest run scripts/foo.test.ts", "a bare `vitest run`"],
		["node_modules/.bin/vitest run scripts/foo.test.ts", "the `.bin/` path"],
		["./node_modules/.bin/vitest run x.test.ts", "a leading-`./` path"],
		["npx vitest run x.test.ts", "`npx vitest`"],
		["/usr/local/bin/npx vitest run x.test.ts", "npx by path"],
		["npx --no-install vitest run x.test.ts", "past npx's own switch"],
		["npx -y vitest run x.test.ts", "past a short switch"],
		["node_modules/.bin/vitest x.test.ts", "no subcommand at all"],
		["node_modules/.bin/vitest", "no argument at all"],
		["npm run typecheck && vitest run x.test.ts", "a later segment"],
		[
			"NODE_OPTIONS=--max-old-space-size=2048 vitest run x",
			"a leading environment assignment",
		],
		[
			"node_modules/.bin/vitest run -t bench a.test.ts",
			"a flag's value spelling a subcommand",
		],
		[
			"node_modules/.bin/vitest --silent bench",
			"a subcommand behind a leading flag, wrongly and knowingly",
		],
	])("warns %s — %s", (command) => {
		expect(verdict(command)).toBe("warn");
	});

	it.each(["-p", "--package", "-c", "--call"])(
		"skips the value npx's %s takes, finding vitest after it",
		(flag) => {
			expect(verdict(`npx ${flag} foo vitest run x.test.ts`)).toBe("warn");
		},
	);
});

describe("what it leaves alone", () => {
	it.each([
		["node scripts/run-vitest.js scripts/foo.test.ts", "the wrapper itself"],
		["npm run test", "goes through the wrapper"],
		["npm run test:changed", "routed through it since mantahostels#2002"],
		["npm run lint && git status", "an unrelated command"],
		["node_modules/.bin/vitest-not-vitest run x", "a suffixed name"],
		["my-vitest run x", "a prefixed name"],
		["node_modules/.bin/vitest/x run y", "vitest mid-path"],
		["npx", "npx running nothing"],
		["npx --yes", "npx with only switches"],
		["npx -p", "npx with a value flag missing its value"],
		["npx tsc vitest", "npx running something else"],
		["npx -p vitest tsc", "vitest as the value npx's -p takes"],
		["echo vitest run x", "vitest as an argument"],
	])("allows %s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["node_modules/.bin/vitest --watch", "--watch"],
		["node_modules/.bin/vitest watch", "watch"],
		["vitest --watch=false", "--watch=, read as a watcher"],
		["vitest run x.test.ts --watch", "a --watch anywhere"],
		["npx vitest watch", "watch behind npx"],
	])("says nothing about a watcher — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each(["watch", "bench", "list", "related", "init", "typecheck", "dev"])(
		"says nothing about `vitest %s`, which the wrapper cannot serve",
		(sub) => {
			expect(verdict(`node_modules/.bin/vitest ${sub} x`)).toBe("allow");
		},
	);

	it("reads `--watchAll` as no watcher, warning", () => {
		expect(verdict("vitest run --watchAll")).toBe("warn");
	});
});

describe("the warning's content", () => {
	it("is the rule, then the command and its wrapped form, latched after", () => {
		expect(decide("vitest run x.test.ts", ctxOf())).toEqual({
			injectRules: [],
			prelude: `${FRAGMENT}\n\nThis command: vitest run x.test.ts\nWrapped:      NODE_OPTIONS=--max-old-space-size=2048 node scripts/run-vitest.js x.test.ts`,
			latchAfter: "vitest-wrapper",
		});
	});

	it("drops the session's own `run`, and `--run`, from the wrapped form", () => {
		const text = message("node_modules/.bin/vitest run scripts/foo.test.ts");
		expect(text).toContain("node scripts/run-vitest.js scripts/foo.test.ts");
		expect(text).not.toContain("run-vitest.js run ");
		expect(message("vitest --run a.test.ts")).toContain(
			"run-vitest.js a.test.ts",
		);
	});

	it("drops only a leading `run`, passing a later one on", () => {
		expect(message("vitest a.test.ts run")).toMatch(
			/run-vitest\.js a\.test\.ts run$/,
		);
	});

	it("ends the wrapped form at the script where nothing is forwarded", () => {
		expect(message("vitest run")).toMatch(/run-vitest\.js$/);
		expect(message("node_modules/.bin/vitest")).toMatch(/run-vitest\.js$/);
	});

	it("forwards npx's tail only, never npx or its flags", () => {
		expect(message("npx --no-install vitest run a.test.ts")).toMatch(
			/Wrapped: {6}NODE_OPTIONS=--max-old-space-size=2048 node scripts\/run-vitest\.js a\.test\.ts$/,
		);
	});

	it("quotes the command it is about, as typed bar its quotes", () => {
		expect(message("vitest run x.test.ts")).toContain(
			"This command: vitest run x.test.ts",
		);
		const quoted = message('vitest run x.test.ts -t "some name"');
		expect(quoted).toContain('This command: vitest run x.test.ts -t "…"');
		expect(quoted).toContain('run-vitest.js x.test.ts -t "…"');
	});

	it("stops at a redirection rather than ending in a dangling `2>`", () => {
		const text = message("node_modules/.bin/vitest run x.test.ts 2>&1");
		expect(text).toContain("node scripts/run-vitest.js x.test.ts");
		expect(text).not.toMatch(/run-vitest\.js x\.test\.ts [0-9]*[<>]/);
	});

	it("names the wrapper through the script-path port", () => {
		expect(
			message("vitest run a", { scriptPath: (n) => `/plugin/scripts/${n}` }),
		).toContain("node /plugin/scripts/run-vitest.js a");
	});

	it("speaks of the first vitest segment alone", () => {
		const text = message("vitest run a.test.ts; vitest run b.test.ts");
		expect(text).toContain("This command: vitest run a.test.ts");
		expect(text).not.toContain("b.test.ts");
	});

	it("speaks of the first SERVABLE segment, past a watcher", () => {
		expect(message("vitest watch; vitest run b.test.ts")).toContain(
			"This command: vitest run b.test.ts",
		);
	});

	it("says why, in terms of the failure rather than a timeout", () => {
		expect(message("vitest run x.test.ts")).toContain("event loop");
	});

	it("prefixes the same NODE_OPTIONS package.json's test scripts do", () => {
		const pkg = JSON.parse(
			fs.readFileSync(
				path.resolve(__dirname, "..", "..", "package.json"),
				"utf8",
			),
		);
		const cap = String(pkg.scripts.test).match(
			/NODE_OPTIONS=--max-old-space-size=\d+/,
		)?.[0];
		expect(cap).toBeTruthy();
		expect(message("vitest run x.test.ts")).toContain(
			`${cap} node scripts/run-vitest.js x.test.ts`,
		);
	});

	it("spells the whole prelude's core paths through the port", () => {
		const text = message("vitest run x", {
			corePaths: (t) => t.replaceAll("scripts/", "/plugin/scripts/"),
		});
		expect(text).toContain("`/plugin/scripts/run-vitest.js` has no stall");
		expect(text).toContain("node /plugin/scripts/run-vitest.js x");
	});
});

/*
 * mantahostels#2275. The guard warns on a command it ALLOWS, so nothing but
 * this bounds how often one session pays the fragment.
 */
describe("the rule fragment is latched, the suggestion is not", () => {
	it("drops to a standing line once told, latching nothing more", () => {
		const v = decide("vitest run y.test.ts", ctxOf({ told: true }));
		expect(v).toEqual({
			context:
				"A vitest run outside `scripts/run-vitest.js` has no stall watchdog (`rule:vitest-wrapper`).\n\nThis command: vitest run y.test.ts\nWrapped:      NODE_OPTIONS=--max-old-space-size=2048 node scripts/run-vitest.js y.test.ts",
		});
		expect(v?.context?.length).toBeLessThan(FRAGMENT.length);
	});

	it("still names the command and its wrapped form once told", () => {
		const second = message("node_modules/.bin/vitest run y.test.ts", {
			told: true,
		});
		expect(second).toContain(
			"This command: node_modules/.bin/vitest run y.test.ts",
		);
		expect(second).toContain("node scripts/run-vitest.js y.test.ts");
	});

	/* Three copies of the same sentence exist — the fragment's own first line,
	 * the standing line and the store-unreadable fallback — and the two
	 * hardcoded ones are what a session reads in the states where being wrong
	 * costs most (mantahostels#2275's review). */
	it("repeats the fragment's own first sentence, not a paraphrase of it", () => {
		const first = (FRAGMENT.split("\n")[0] ?? "").replace(/\.$/, "");
		expect(message("vitest run y.test.ts", { told: true })).toContain(first);
		expect(WRAPPER_RULE_FALLBACK).toContain(first);
	});

	it("asks for nothing on a command it allows", () => {
		expect(decide("npm run test", ctxOf())).toBeNull();
	});
});

describe("a rule the store cannot give", () => {
	it("sends the fallback naming the file, logged, and still latches", () => {
		const logs: string[] = [];
		const v = decide("vitest run x", {
			...ctxOf({ logs }),
			ruleText: () => {
				throw new Error("no store");
			},
		});
		expect(v).toEqual({
			injectRules: [],
			prelude: `${WRAPPER_RULE_FALLBACK}\n\nThis command: vitest run x\nWrapped:      NODE_OPTIONS=--max-old-space-size=2048 node scripts/run-vitest.js x`,
			latchAfter: "vitest-wrapper",
		});
		expect(WRAPPER_RULE_FALLBACK).toContain(
			"docs/agents/rules/vitest-wrapper.txt",
		);
		expect(logs).toEqual([
			"rule vitest-wrapper unreadable — its fallback sent instead",
		]);
	});

	it("reads the store once told no more", () => {
		const v = decide("vitest run x", {
			...ctxOf({ told: true }),
			ruleText: () => {
				throw new Error("must not be read");
			},
		});
		expect(v?.context).toContain("rule:vitest-wrapper");
	});
});
