// @vitest-environment node
/*
 * lib/bg-job.js hands a session the killed-background-job rule at the moment
 * it sets `run_in_background`, rather than leaving it in `CLAUDE.md` for a
 * session that never reads §Subagent dispatch (mantahostels#1904, under
 * mantahostels#1900). It is a guard-dispatch.js core on Bash: loosen a case and
 * a session backgrounds a job without the rule that the harness may kill it.
 *
 * Module cases on the core; the latch, the cap and the store fault are
 * lib/guard-entry.test.ts's and lib/guard-dispatch.test.ts's.
 */

import { describe, expect, it } from "vitest";
import { readRuleCap } from "./rule-emission";
/* The store's Node accessor, so a test asks for the rule by id rather than
 * holding a second copy of its text. */
import { readRuleText } from "./rule-text";

/* Required with a cast, not imported (#3145): the cases hand `decide` a stub
 * context its checked `CoreContext` type refuses. Residual: the cast's types
 * are hand-written, so nothing checks them against the module. */
const { decide } = require("./bg-job.js") as {
	decide: (command: string, ctx: { input: Record<string, unknown> }) => unknown;
};

const judged = (input: Record<string, unknown>) =>
	decide(String(input.command ?? ""), { input });

describe("a backgrounded Bash call is handed the rule, and refused nothing", () => {
	it.each([
		["npm run test", "the suite, the case #1900 measured"],
		["sleep 180; wc -c artefact.md", "the timed artefact check"],
		["gh issue view 1 --json body", "the tracker call the rules prescribe"],
		["scripts/bg-run.sh run suite npm run test", "the wrapper itself"],
	])("%s is handed the rule — %s", (command) => {
		expect(judged({ command, run_in_background: true })).toEqual({
			injectRules: ["killed-background-job"],
		});
	});
});

describe("things that are not a backgrounded Bash call", () => {
	it("a foreground call carries no flag and is handed nothing", () => {
		expect(judged({ command: "npm run test" })).toBeNull();
	});

	it("an explicit false is handed nothing", () => {
		expect(
			judged({ command: "npm run test", run_in_background: false }),
		).toBeNull();
	});

	it("a flag that is not the literal true is handed nothing", () => {
		expect(
			judged({ command: "npm run test", run_in_background: "true" }),
		).toBeNull();
	});

	it("a command that only mentions the flag is handed nothing", () => {
		// The field is read, never the command string — which is what keeps this
		// core off every session that greps the repo for the flag's name.
		expect(
			judged({ command: "grep -rn run_in_background scripts" }),
		).toBeNull();
	});
});

/*
 * MUTATION ANCHORS. `toContain(readRuleText(<id>))` reads the same file the guard
 * does, so it moves with a mutation to the fragment instead of catching it.
 *
 * Reads the fragment directly, not the emission (mantahostels#2230, following mantahostels#2226) — this
 * trigger carries one id today, but a row over the emission would stop catching
 * a clause moved to a second fragment the moment one joins it.
 *
 * The fragment is hard-wrapped at ~80 columns, so a clause straddles a newline
 * whenever a reflow moves it. Collapsing the fragment's whitespace pins the
 * words and never the wrapping — so a wrap CANNOT be pinned here.
 */
const carries = (clause: string) =>
	expect(readRuleText("killed-background-job").replace(/\s+/g, " ")).toContain(
		clause,
	);

describe("the injected rule still carries its operative clauses", () => {
	it("a clause no fragment carries fails", () => {
		expect(() => carries("a clause no fragment carries")).toThrow();
	});

	it.each([
		["scripts/bg-run.sh run", "the wrapper that makes the two distinguishable"],
		["scripts/bg-run.sh check", "the verb that reads the verdict"],
		["1 KILLED", "the exit code a caller branches on"],
		[
			"the wrong place to look",
			"that this machine's limits are the wrong lead",
		],
		[
			"idleness rather than load decides",
			"why the memory trigger is not a machine-tuning problem (#2711)",
		],
		[
			"GOING IDLE IS WHAT KILLS IT — SETTLED AT ~95%",
			"the trigger #2661 wrongly retired, now settled and captured (#2694, #2695)",
		],
		[
			"idle-triggered reaper on memory pressure",
			"the named mechanism, which #2661 said the fragment lacked (#2690)",
		],
		[
			"unless you interacted within 30 min",
			"the idle window, the one figure a session acts on",
		],
		[
			"MECHANISM confirmed (mantahostels#2836)",
			"that the 70% is mechanism-confirmed, not merely probable, off check's own staleness window (#2695, #2836)",
		],
		[
			"CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP",
			"the escape, and #2693's falsification test",
		],
		[
			"partial output could pass for a verdict",
			"that a partial output file is indistinguishable from a finished one",
		],
		[
			"CHECK TWICE, 20+ S APART, BEFORE YOU RE-ISSUE",
			"what a killed notification obliges — two checks 20+ seconds apart, not a blind relaunch",
		],
		["often lies", "that the kill may not have stopped the command"],
		["orphans", "that check reports the run and not the process"],
		[
			"arm a timer in the turn that launches the job",
			"the next move when no wake arrives at all (#2550)",
		],
		[
			"cadence over two minutes",
			"what keeps the re-armed timer under the poll guard's cadence warning",
		],
		[
			"warns from the fourth",
			"the allowance restated — past three timed checks the guard warns (#518)",
		],
		["never refuses one", "that the warning never becomes a refusal (#518)"],
		[
			"A JOB THAT HAS ALREADY REPORTED OWES NO `waiting:`",
			"that a job which already reported owes no hand-off (#3432, #3438)",
		],
		[
			"read the output and carry on in the same turn",
			"the move that replaces the refused waiting: turn",
		],
		[
			"A FRESH BEAT IS A LIVE JOB",
			"what stops the ceiling abandoning a job that is still running",
		],
		[
			"STOP WAITING ONLY ON A BEAT NO NEWER THAN THE LAST LANDING'S",
			"the ceiling, read off the beat rather than off elapsed time",
		],
		[
			"a subagent has no beat to read",
			"why this ceiling differs from the subagent one rather than being a stale wording of it (#2591)",
		],
	])("keeps %s — %s", (clause) => {
		carries(clause);
	});

	it("spends little of the cap, so a later id on this trigger still fits", () => {
		// RULE_CAP is BYTES, and the fragment is multibyte.
		expect(
			Buffer.byteLength(readRuleText("killed-background-job"), "utf8"),
		).toBeLessThan(readRuleCap());
	});
});
