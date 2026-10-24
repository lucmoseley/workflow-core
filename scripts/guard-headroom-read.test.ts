// @vitest-environment node
/*
 * guard-headroom-read.sh states the headroom rule before a session draws a
 * conclusion from a memory reading (mantahostels#1933, deferred at mantahostels#1843). Like
 * guard-push-rules.sh it NEVER denies — reading memory is the correct act, and
 * only the conclusion is wrong — so every case asserts `permissionDecision` is
 * absent as well as asserting the text. The guard is spawned with
 * `CLAUDE_PROJECT_DIR` and `CLAUDE_CONFIG_DIR` in a temp directory, so its
 * latch and fail-open log never land in the real checkout or the founder's log.
 *
 * It runs as a `PreToolUse` Bash hook on a `free`/`/proc/meminfo` read
 * (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`), the only moment before
 * the conclusion: break it and a session reads a short figure and abandons work
 * the machine had room for; make it deny and the memory check itself is
 * refused.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBashPayload,
	guardDirs,
	guardOutput,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-headroom-read.sh");
/* The store's Node accessor, so a test asks for the rule by id rather than
 * holding a second copy of its text. CommonJS, hence the require. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("headroom-read-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The whole hook output for `command`, parsed. Null where it said nothing. */
const emission = (command: string, session = `s-${Math.random()}`) =>
	guardOutput(GUARD, buildBashPayload(command, session), {
		project: dir,
		config,
		cwd: dir,
	});

describe("a memory reading is handed the rule, and refused nothing", () => {
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
	])("%s is handed the rule — %s", (command) => {
		const out = emission(command);
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(ruleText("headroom-reap"));
	});

	it("says nothing twice in one session, whatever the second reading is", () => {
		const session = "one-session";
		expect(emission("free -m", session)).not.toBeNull();
		expect(emission("free -h", session)).toBeNull();
	});

	it("tells a command carrying two readings once", () => {
		const ctx = emission("free -m; free -h").additionalContext as string;
		expect(ctx.split("A short memory reading").length - 1).toBe(1);
	});
});

describe("it stays silent where no memory is read", () => {
	it.each([
		["free --help", "reports no memory"],
		["free -V", "nor does the version"],
		["ls -la", "an unrelated command"],
		["npm run test", "the launch — that is guard-suite-concurrency's seam"],
		["grep free /proc/cpuinfo", "a different file, and `free` not the verb"],
	])("%s says nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});
});

/*
 * MUTATION ANCHORS. `toContain(ruleText(...))` reads the same file the guard
 * does, so it moves with a mutation to the fragment instead of catching it: cut
 * a clause and both sides lose it together.
 *
 * The fragment is hard-wrapped at ~80 columns, so a clause straddles a newline
 * whenever a reflow moves it (mantahostels#2230, following mantahostels#2226). Collapsing the
 * fragment's whitespace pins the words and never the wrapping — so a wrap
 * CANNOT be pinned here.
 */
const carries = (clause: string) =>
	expect(ruleText("headroom-reap").replace(/\s+/g, " ")).toContain(clause);

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
			ruleText("headroom-reap").match(/npm run test(?![:\w])/g),
		).toBeNull();
	});

	it("prescribes the hand reap above the self-reaping-run limb", () => {
		/* Collapsed, per the MUTATION ANCHORS note above. Both indices are
		 * asserted present first — a bare `toBeLessThan` passes on a MISSING
		 * hand reap, -1 being below any hit. */
		const text = ruleText("headroom-reap").replace(/\s+/g, " ");
		const reap = text.indexOf("node scripts/reap-finished-sessions.js");
		const script = text.indexOf("npm's `test` script");
		expect(reap).toBeGreaterThanOrEqual(0);
		expect(script).toBeGreaterThanOrEqual(0);
		expect(reap).toBeLessThan(script);
	});
});
