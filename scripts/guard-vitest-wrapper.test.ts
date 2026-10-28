// @vitest-environment node
/*
 * The guard-vitest-wrapper core of guard-dispatch.js, its boundary set
 * (#2800): each exit path, each input channel and each production adapter
 * crossed once for real, the dispatcher entry run on it alone. Which commands
 * it warns on and what the warning says are lib/vitest-wrapper.test.ts's
 * module cases on the core; the entry's payload faults and the throw policy
 * are guard-dispatch's own tests' (#3227). The last case reads the
 * context-budget census against the real repo (#2905).
 *
 * The entry runs in process (lib/run-in-process.js) on a hook payload, its
 * config and project directories under a temp dir, so its latch and
 * fail-open log never land in the shared tree or the developer's own log
 * (mantahostels#1452). CLAUDE_PROJECT_DIR names that temp project directory
 * (mantahostels#2275): the latch is per session under the project root, so an
 * inherited root would drop a marker into the shared working tree AND latch
 * every case after the first onto the short form.
 *
 * It is a core of the PreToolUse dispatcher: loosen a case here and a bare vitest run parks on a hung call with no output and no
 * filename, unwarned.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const CORE = "guard-vitest-wrapper";

/** The rule fragment the first warning is meant to carry whole, once. */
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

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("guard-vitest-wrapper-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook output for `payload`, parsed; null where it said nothing. */
const output = (
	payload: Record<string, unknown>,
	env: NodeJS.ProcessEnv = {},
) => dispatchCoreOutput(CORE, payload, { project: dir, config, cwd: dir, env });

/** The warning's text; it must never deny. */
const message = (
	command: string,
	session: string | null = "test",
	env: NodeJS.ProcessEnv = {},
) => {
	const out = output(buildBashPayload(command, session), env);
	expect(out).not.toBeNull();
	expect(out.permissionDecision).toBeUndefined();
	expect(out.hookEventName).toBe("PreToolUse");
	return out.additionalContext as string;
};

const readLatches = () => {
	const markers = path.join(dir, ".claude", "tmp", "markers");
	return fs.existsSync(markers)
		? fs.readdirSync(markers).filter((f) => f.startsWith(".rule-injected-"))
		: [];
};

describe("each exit path", () => {
	it("says nothing on a command it allows, and latches nothing", () => {
		expect(output(buildBashPayload("npm run test", "test"))).toBeNull();
		expect(readLatches()).toEqual([]);
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("carries the whole fragment and the wrapped command on the first run", () => {
		const text = message("node_modules/.bin/vitest run scripts/foo.test.ts");
		expect(text).toContain(FRAGMENT);
		expect(text).toContain(
			"This command: node_modules/.bin/vitest run scripts/foo.test.ts",
		);
		expect(text).toContain("node scripts/run-vitest.js scripts/foo.test.ts");
	});

	it("keeps the latch marker where a compaction clear will find it", () => {
		message("vitest run x.test.ts");
		/* The latch lives under markersDir (.claude/tmp/markers), not the repo
		 * root itself — guard-entry.js's latchPath. */
		expect(readLatches()).toEqual([
			".rule-injected-warn.vitest-wrapper-main-test",
		]);
	});

	it("drops to the standing line once latched, still warning", () => {
		message("vitest run x.test.ts");
		const second = message("vitest run y.test.ts");
		expect(second).not.toContain(FRAGMENT);
		expect(second).toContain("rule:vitest-wrapper");
		expect(second).toContain("node scripts/run-vitest.js y.test.ts");
	});

	/* Three copies of the same sentence exist — the fragment's own first line,
	 * this standing line and the store-unreadable fallback — and the two
	 * hardcoded ones are what a session reads where being wrong costs most. */
	it("repeats the fragment's own first sentence, not a paraphrase of it", () => {
		const first = (FRAGMENT.split("\n")[0] ?? "").replace(/\.$/, "");
		message("vitest run x.test.ts");
		expect(message("vitest run y.test.ts")).toContain(first);
	});
});

describe("each input channel", () => {
	it("keys the latch on the session: a second session is told afresh", () => {
		message("vitest run x.test.ts");
		expect(message("vitest run x.test.ts", "other")).toContain(FRAGMENT);
	});

	it("keys the latch on the agent: a subagent is told afresh", () => {
		message("vitest run x.test.ts");
		const out = output({
			...buildBashPayload("vitest run x.test.ts", "test"),
			agent_id: "sub1",
		});
		expect(out.additionalContext).toContain(FRAGMENT);
		expect(readLatches()).toContain(
			".rule-injected-warn.vitest-wrapper-asub1-test",
		);
	});

	it("warns without a session id, every time, latching nothing, logged", () => {
		expect(message("vitest run x.test.ts", null)).toContain(FRAGMENT);
		expect(message("vitest run x.test.ts", null)).toContain(FRAGMENT);
		expect(readLatches()).toEqual([]);
		expect(readFailOpenLog(config, dir)).toMatch(
			/no session key — rule vitest-wrapper unlatchable, delivered again/,
		);
	});
});

describe("each production adapter, crossed once", () => {
	it("sends the fallback naming the file where the store is empty, logged", () => {
		const empty = fs.mkdtempSync(path.join(dir, "store-"));
		const text = message("vitest run x.test.ts", "test", {
			WFC_RULES_DIR: empty,
		});
		expect(text).toContain("docs/agents/rules/vitest-wrapper.txt");
		expect(text).not.toContain(FRAGMENT);
		expect(readLatches()).toEqual([
			".rule-injected-warn.vitest-wrapper-main-test",
		]);
		expect(readFailOpenLog(config, dir)).toMatch(
			/rule vitest-wrapper unreadable — its fallback sent instead/,
		);
	});

	it("spells the wrapper at the plugin root in an install", () => {
		/* WFC_SCRIPT_ROOT stands in for an install: a core root with
		 * scripts/run-vitest.js and no package.json. */
		const install = path.join(dir, "install");
		fs.mkdirSync(path.join(install, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(install, "scripts", "run-vitest.js"), "");
		const text = message("vitest run x.test.ts", "test", {
			WFC_SCRIPT_ROOT: install,
		});
		expect(text).toContain(
			`node ${path.join(install, "scripts", "run-vitest.js")} x.test.ts`,
		);
	});
});

/*
 * The census reads this guard's bound off its Node core — `ctx.ruleText`,
 * `ctx.told` and `latchAfter` (#2905) — and a spelling it stops seeing drops
 * the fragment out of the per-session budget unnoticed.
 */
describe("the context-budget scan against this guard as it stands", () => {
	it("reads its bound as bounded, from its core", () => {
		const root = path.resolve(__dirname, "..");
		const r = runInProcess(
			path.join(root, "scripts", "check-context-budget.js"),
			["--json"],
			{ cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
		);
		/* Its exit is the repo's whole budget verdict, not this guard's. */
		const fragments = JSON.parse(r.stdout).session.direct.fragments as {
			id: string;
			guards: string[];
			latched: string;
		}[];
		expect(fragments.find((f) => f.id === "vitest-wrapper")).toMatchObject({
			guards: ["scripts/lib/vitest-wrapper.js"],
			latched: "bounded",
		});
	});
});
