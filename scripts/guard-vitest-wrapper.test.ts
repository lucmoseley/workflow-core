// @vitest-environment node
/*
 * guard-vitest-wrapper.sh warns — never denies — when a command runs vitest
 * without going through scripts/run-vitest.js, which is the only thing that
 * kills a run parked on a synchronous call that never returns (mantahostels#2002, the
 * follow-on to mantahostels#1910's watchdog).
 *
 * The real guard is spawned with a hook payload on stdin and its config and
 * project directories under a temp dir, so its latch and fail-open log never
 * land in the shared tree or the developer's own log (see `run` below).
 *
 * It is a `PreToolUse` Bash hook in self-plugin/hooks/hooks.json: loosen a case
 * here and a bare vitest run parks on a hung call with no output and no
 * filename, unwarned — the hang mantahostels#1910's watchdog was built for.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const GUARD = path.resolve(__dirname, "guard-vitest-wrapper.sh");

let dir: string;

/*
 * The guard's fail-open log redirected at `dir` — since mantahostels#147 every guard
 * records fail-opens under CLAUDE_CONFIG_DIR, and inheriting the real one
 * appends to the developer's live guard-errors.log on every suite run (mantahostels#1452).
 *
 * CLAUDE_PROJECT_DIR goes with it, and is not decoration (mantahostels#2275): the guard
 * latches its rule fragment per session under the repo root, so an inherited
 * root would drop a marker into the shared working tree AND latch every case
 * after the first onto the short form.
 */
const run = (command: string, session = "test") =>
	spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: session,
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
		},
	});

const verdict = (command: string) => {
	const r = run(command);
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status).toBe(0);
	expect(r.stderr ?? "").toBe("");
	const out = r.stdout ?? "";
	if (/"permissionDecision"\s*:\s*"deny"/.test(out))
		throw new Error("guard denied — it must never deny");
	if (/"additionalContext"/.test(out)) return "warn";
	expect(out).toBe("");
	return "allow";
};

/** The warning's text, unescaped from the hook envelope. */
const message = (command: string, session = "test") => {
	const out = run(command, session).stdout ?? "";
	const parsed = JSON.parse(out);
	return parsed.hookSpecificOutput.additionalContext as string;
};

/** The rule fragment the warning is meant to carry whole, once. */
const FRAGMENT = fs
	.readFileSync(
		path.resolve(
			__dirname,
			"..",
			"docs",
			"agents",
			"rules",
			"vitest-wrapper.txt",
		),
		"utf8",
	)
	.trim();

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-vitest-wrapper-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("an unwrapped one-shot", () => {
	it("warns a bare `vitest run`", () => {
		expect(verdict("vitest run scripts/foo.test.ts")).toBe("warn");
	});

	it("warns the `.bin/` path form", () => {
		expect(verdict("node_modules/.bin/vitest run scripts/foo.test.ts")).toBe(
			"warn",
		);
	});

	it("warns a leading-`./` path form", () => {
		expect(verdict("./node_modules/.bin/vitest run x.test.ts")).toBe("warn");
	});

	it("warns `npx vitest`, and past npx's own flags", () => {
		expect(verdict("npx vitest run x.test.ts")).toBe("warn");
		expect(verdict("npx --no-install vitest run x.test.ts")).toBe("warn");
	});

	it("warns a vitest with no subcommand at all", () => {
		expect(verdict("node_modules/.bin/vitest x.test.ts")).toBe("warn");
	});

	it("warns on a later segment of a compound command", () => {
		expect(verdict("npm run typecheck && vitest run x.test.ts")).toBe("warn");
	});

	it("survives a leading environment assignment", () => {
		expect(verdict("NODE_OPTIONS=--max-old-space-size=2048 vitest run x")).toBe(
			"warn",
		);
	});
});

describe("what it leaves alone", () => {
	it("allows the wrapper itself", () => {
		expect(verdict("node scripts/run-vitest.js scripts/foo.test.ts")).toBe(
			"allow",
		);
	});

	it("allows `npm run test`, which goes through the wrapper", () => {
		expect(verdict("npm run test")).toBe("allow");
	});

	it("allows `npm run test:changed`, routed through it since mantahostels#2002", () => {
		expect(verdict("npm run test:changed")).toBe("allow");
	});

	it("says nothing about a watcher, in any of its spellings", () => {
		expect(verdict("node_modules/.bin/vitest --watch")).toBe("allow");
		expect(verdict("node_modules/.bin/vitest watch")).toBe("allow");
		expect(verdict("vitest --watch=false")).toBe("allow");
	});

	it("warns where a flag's value happens to spell a subcommand", () => {
		expect(verdict("node_modules/.bin/vitest run -t bench a.test.ts")).toBe(
			"warn",
		);
	});

	it("warns a subcommand hidden behind a leading flag, wrongly and knowingly", () => {
		expect(verdict("node_modules/.bin/vitest --silent bench")).toBe("warn");
	});

	it("says nothing about a subcommand the wrapper cannot serve", () => {
		expect(verdict("node_modules/.bin/vitest bench")).toBe("allow");
		expect(verdict("node_modules/.bin/vitest related src/a.ts")).toBe("allow");
		expect(verdict("node_modules/.bin/vitest list")).toBe("allow");
	});

	it("is anchored on the last path segment, not the word", () => {
		expect(verdict("node_modules/.bin/vitest-not-vitest run x")).toBe("allow");
		expect(verdict("my-vitest run x")).toBe("allow");
	});

	it("allows an unrelated command", () => {
		expect(verdict("npm run lint && git status")).toBe("allow");
	});
});

describe("the warning's content", () => {
	it("names the wrapped command to type instead, without the session's own `run`", () => {
		const text = message("node_modules/.bin/vitest run scripts/foo.test.ts");
		expect(text).toContain("node scripts/run-vitest.js scripts/foo.test.ts");
		expect(text).not.toContain("run-vitest.js run ");
	});

	it("carries the rule's own text, not a summary of it", () => {
		expect(message("vitest run x.test.ts")).toContain(FRAGMENT);
	});

	it("says why, in terms of the failure rather than a timeout", () => {
		expect(message("vitest run x.test.ts")).toContain("event loop");
	});

	it("quotes the command it is about", () => {
		expect(message("vitest run x.test.ts")).toContain("vitest run x.test.ts");
	});
});

describe("the suggestion is a command you can paste", () => {
	it("stops at a redirection rather than ending in a dangling `2>`", () => {
		const text = message("node_modules/.bin/vitest run x.test.ts 2>&1");
		expect(text).toContain("node scripts/run-vitest.js x.test.ts");
		expect(text).not.toMatch(/run-vitest\.js x\.test\.ts [0-9]*[<>]/);
	});
});

describe("the suggestion carries the heap cap the test scripts use", () => {
	it("prefixes the same NODE_OPTIONS package.json's test scripts do", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
		);
		const cap = String(pkg.scripts.test).match(
			/NODE_OPTIONS=--max-old-space-size=\d+/,
		)?.[0];
		expect(cap).toBeTruthy();
		expect(message("vitest run x.test.ts")).toContain(
			`${cap} node scripts/run-vitest.js x.test.ts`,
		);
	});
});

/*
 * mantahostels#2275. The guard warns on a command it ALLOWS, so nothing but this bounds
 * how often one session pays the fragment's 1,227 B.
 */
describe("the rule fragment is latched, the suggestion is not", () => {
	it("carries the whole fragment on the session's first unwrapped run", () => {
		expect(message("vitest run x.test.ts")).toContain(FRAGMENT);
	});

	it("drops to a standing line on every firing after it", () => {
		message("vitest run x.test.ts");
		const second = message("vitest run y.test.ts");
		expect(second).not.toContain(FRAGMENT);
		expect(second).toContain("rule:vitest-wrapper");
		expect(second.length).toBeLessThan(FRAGMENT.length);
	});

	it("still names the command and its wrapped form every time", () => {
		message("vitest run x.test.ts");
		const second = message("node_modules/.bin/vitest run y.test.ts");
		expect(second).toContain(
			"This command: node_modules/.bin/vitest run y.test.ts",
		);
		expect(second).toContain("node scripts/run-vitest.js y.test.ts");
	});

	it("tells a second session afresh", () => {
		message("vitest run x.test.ts");
		expect(message("vitest run x.test.ts", "other")).toContain(FRAGMENT);
	});

	it("still warns rather than denying once latched", () => {
		message("vitest run x.test.ts");
		expect(verdict("vitest run x.test.ts")).toBe("warn");
	});

	/* Three copies of the same sentence exist — the fragment's own first line,
	 * this standing line and the store-unreadable fallback — and the two
	 * hardcoded ones are what a session reads in the states where being wrong
	 * costs most (mantahostels#2275's review). */
	it("repeats the fragment's own first sentence, not a paraphrase of it", () => {
		const first = FRAGMENT.split("\n")[0];
		message("vitest run x.test.ts");
		expect(message("vitest run y.test.ts")).toContain(first.replace(/\.$/, ""));
	});

	it("keeps the latch marker where a compaction clear will find it", () => {
		message("vitest run x.test.ts");
		/* The latch lives under gr_markers_dir (.claude/tmp/markers), not the
		 * repo root itself — guard-parse.sh's _gp_rule_marker (mantahostels#3515 F8,
		 * issue #2). */
		const markers = path.join(dir, ".claude", "tmp", "markers");
		expect(
			fs.readdirSync(markers).filter((f) => f.startsWith(".rule-injected-")),
		).toEqual([".rule-injected-warn.vitest-wrapper-main-test"]);
	});

	it("latches nothing on a command it allows", () => {
		expect(verdict("npm run test")).toBe("allow");
		expect(message("vitest run x.test.ts")).toContain(FRAGMENT);
	});
});

/*
 * This guard's bound is the repo's only `bounded` one, and reading a guard's
 * EFFECTIVE source (mantahostels#2488) is what could quietly withdraw it: the emission
 * accessors are DEFINED in lib/guard-parse.sh, which this guard sources, so
 * handing that text to emissionSites reads each definition as a second emission
 * and the state falls to `ambiguous`. Against the REAL repo — the mechanism
 * only exists where the guard sources the real libs.
 */
describe("the context-budget scan against this guard as it stands (mantahostels#2488)", () => {
	it("still reads its bound as bounded", () => {
		const root = path.resolve(__dirname, "..");
		const r = runInProcess(
			path.join(root, "scripts", "check-context-budget.js"),
			["--json"],
			{ cwd: root },
		);
		expect(r.status).toBe(0);
		const fragments = JSON.parse(r.stdout).session.direct.fragments as {
			id: string;
			latched: string;
		}[];
		expect(fragments.find((f) => f.id === "vitest-wrapper")?.latched).toBe(
			"bounded",
		);
	});
});
