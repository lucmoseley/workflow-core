// @vitest-environment node
/*
 * lib/headroom-read.js decides when a command is a memory reading and so is
 * handed the headroom rule (mantahostels#1933, deferred at mantahostels#1843):
 * break it and a session reads a short figure and abandons work the machine
 * had room for. The latch, the emission and the hook boundary are
 * guard-entry.test.ts's and guard-headroom-read.test.ts's.
 */

import { describe, expect, it } from "vitest";
import { decide } from "./headroom-read.js";
import { kitContextFake } from "./kit-context-fake";
/* The store's Node accessor, so a test asks for the rule by id rather than
 * holding a second copy of its text. */
import { readRuleText } from "./rule-text";

/* The kit's context, with nothing real behind it: the core reads no env and
 * no disk. */
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

/*
 * MUTATION ANCHORS. `toContain(readRuleText(...))` reads the same file the guard
 * does, so it moves with a mutation to the fragment instead of catching it: cut
 * a clause and both sides lose it together.
 *
 * The fragment is hard-wrapped at ~80 columns, so a clause straddles a newline
 * whenever a reflow moves it (mantahostels#2230, following mantahostels#2226). Collapsing the
 * fragment's whitespace pins the words and never the wrapping — so a wrap
 * CANNOT be pinned here.
 */
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

	/* mantahostels#2681 (the ticket that took the launch imperative out of this fragment).
	 * Both cases are lexical, as mantahostels#2672's sibling case is: an imperative
	 * respelled in prose would pass either. */
	it("names no bare `npm run test` at all", () => {
		/* The lookahead spares `npm run test:changed` and `npm run test:py`,
		 * other scripts whose own pre-hook is not `pretest`. */
		expect(
			readRuleText("headroom-reap").match(/npm run test(?![:\w])/g),
		).toBeNull();
	});

	it("prescribes the hand reap above the self-reaping-run limb", () => {
		/* Collapsed, per the MUTATION ANCHORS note above. Both indices are
		 * asserted present first — a bare `toBeLessThan` passes on a MISSING
		 * hand reap, -1 being below any hit. */
		const text = readRuleText("headroom-reap").replace(/\s+/g, " ");
		const reap = text.indexOf("node scripts/reap-finished-sessions.js");
		const script = text.indexOf("npm's `test` script");
		expect(reap).toBeGreaterThanOrEqual(0);
		expect(script).toBeGreaterThanOrEqual(0);
		expect(reap).toBeLessThan(script);
	});
});
