// @vitest-environment node

import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	latchesAt,
	runCore,
	splitCheckout,
	toolCall,
} from "./guard-core-testkit";
import { decide } from "./headroom-read.js";
import { kitContextFake } from "./kit-context-fake";
import { readRuleText } from "./rule-text";

const PORTS = kitContextFake({ cwd: "/work", fallbackCwd: "/work" });
const RULE = { injectRules: ["headroom-reap"] };

describe("a memory reading is handed the rule", () => {
	it.each([
		[
			"free -m",
			"the spelling docs/agents/guard-registry.md §Machine limits prescribes",
		],
		["free -h", "-h is free's human-readable flag, never help"],
		["free", "the bare form"],
		["grep MemAvailable /proc/meminfo", "the same reading by file"],
		["cat /proc/meminfo", "and by another reader of it"],
		["node -e 'x' && free -m", "the tail of a chain"],
	])("%s — %s", (command) => {
		expect(decide(command, PORTS)).toEqual(RULE);
	});

	it("names the rule once for a command carrying two readings", () => {
		expect(decide("free -m; free -h", PORTS)).toEqual(RULE);
	});
});

describe("it stays silent where no memory is read", () => {
	it.each([
		["free --help", "reports no memory"],
		["free -V", "nor does the version"],
		["ls -la", "an unrelated command"],
		["npm run test", "the launch — that is guard-suite-concurrency's seam"],
		["grep free /proc/cpuinfo", "a different file, and `free` not the verb"],
		["echo 'free -m'", "a reading quoted as prose runs nothing"],
		["echo 'done; free -m'", "nor does a separator quoted with it"],
	])("%s — %s", (command) => {
		expect(decide(command, PORTS)).toBeNull();
	});
});

const carries = (clause: string) =>
	expect(readRuleText("headroom-reap").replace(/\s+/g, " ")).toContain(clause);

describe("the injected rule still carries its operative clauses", () => {
	it("a clause no fragment carries fails", () => {
		expect(() => carries("a clause no fragment carries")).toThrow();
	});

	it.each([
		[
			"npm's `test` script, whose `pretest` hook",
			"the run that reaps for itself, named in prose and never launched",
		],
		[
			"node scripts/reap-finished-sessions.js",
			"the one command the fragment prescribes",
		],
		[
			"`test:changed`, whose `pretest:changed` runs the same reap",
			"the narrowed run reaps for itself too (#633)",
		],
		["330-450 MB", "what a finished session gives back"],
		["FINISHED", "the limit that live neighbours are not reclaimed"],
		["rung for the suite being started", "the band the pretest reap fires in"],
	])("names %s — %s", (clause) => {
		carries(clause);
	});

	it("names no bare `npm run test` at all", () => {
		expect(
			readRuleText("headroom-reap").match(/npm run test(?![:\w])/g),
		).toBeNull();
	});

	it("prescribes the hand reap above the self-reaping-run limb", () => {
		const text = readRuleText("headroom-reap").replace(/\s+/g, " ");
		const reap = text.indexOf("node scripts/reap-finished-sessions.js");
		const script = text.indexOf("npm's `test` script");
		expect(reap).toBeGreaterThanOrEqual(0);
		expect(script).toBeGreaterThanOrEqual(0);
		expect(reap).toBeLessThan(script);
	});
});

describe("a memory reading from a session in its own worktree (#4242)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});

	const fromWorktree = () =>
		runCore("guard-headroom-read", toolCall("Bash", { command: "free -m" }), {
			root: at.main,
			worktree: at.worktree,
		}).output?.additionalContext ?? "";

	it("hands the rule once, latched in the main checkout's marker store", () => {
		const rule = readRuleText("headroom-reap");
		expect(fromWorktree()).toContain(rule);
		expect(latchesAt(at.main).length).toBe(1);
		expect(latchesAt(at.worktree)).toEqual([]);
		expect(fromWorktree()).not.toContain(rule);
	});
});
