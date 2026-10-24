// @vitest-environment node
/*
 * guard-bg-job.sh hands a session the killed-background-job rule at the moment
 * it sets `run_in_background`, rather than leaving it in `CLAUDE.md` for a
 * session that never reads §Subagent dispatch (mantahostels#1904, under mantahostels#1900).
 *
 * It never denies, so every case here asserts `permissionDecision` is ABSENT as
 * well as asserting the text — the shape guard-push-rules.test.ts established
 * for an injection-only guard, and the reason the shared deny fixtures are not
 * used.
 *
 * No git repo is built: this guard walks no working tree, and gr_root takes
 * CLAUDE_PROJECT_DIR before it ever reaches git.
 *
 * It is a `PreToolUse` Bash hook in `self-plugin/hooks/hooks.json`: loosen a
 * case and a session backgrounds a job without the rule that the harness may
 * kill it, or the hook starts refusing calls it was only meant to annotate.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import {
	guardDirs,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-bg-job.sh");
/* The store's Node accessor, so a test asks for the rule by id rather than
 * holding a second copy of its text. CommonJS, hence the require. */
const { ruleText } = require("./lib/rule-text") as {
	ruleText: (id: string) => string;
};

let dir: string;
let config: string;
let root: string;

beforeEach(() => {
	({ dir, config } = guardDirs("bg-job-"));
	// The latch root. A plain directory is enough — gr_root reads
	// CLAUDE_PROJECT_DIR and asks git nothing.
	root = path.join(dir, "root");
	fs.mkdirSync(root);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Payload = Record<string, unknown>;

const run = (payload: Payload, env: Record<string, string> = {}) =>
	spawnGuard(GUARD, payload, { project: root, config, cwd: root, env });

/** The whole hook output for one payload, parsed. Null where it said nothing. */
const emission = (payload: Payload) =>
	guardOutput(GUARD, payload, { project: root, config, cwd: root });

/** A Bash PreToolUse payload, backgrounded unless told otherwise. */
const bash = (
	command: string,
	extra: Payload = {},
	session = "test",
): Payload => ({
	session_id: session,
	tool_name: "Bash",
	tool_input: { command, run_in_background: true, ...extra },
});

describe("a backgrounded Bash call is handed the rule, and refused nothing", () => {
	it.each([
		["npm run test", "the suite, the case #1900 measured"],
		["sleep 180; wc -c artefact.md", "the timed artefact check"],
		["gh issue view 1 --json body", "the tracker call the rules prescribe"],
		["scripts/bg-run.sh run suite npm run test", "the wrapper itself"],
	])("%s is handed the rule — %s", (command) => {
		const out = emission(bash(command));
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(ruleText("killed-background-job"));
	});
});

/*
 * MUTATION ANCHORS. `toContain(ruleText(<id>))` reads the same file the guard
 * does, so it moves with a mutation to the fragment instead of catching it: cut
 * a clause and both sides lose it together.
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
	expect(ruleText("killed-background-job").replace(/\s+/g, " ")).toContain(
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
			"what keeps the re-armed timer under guard-agent-poll.sh's cadence warning",
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
		// GP_RULE_CAP is BYTES, and the fragment is multibyte — guard-parse.sh
		// forces LC_ALL=C on its own length for exactly this reason.
		const ctx = emission(bash("npm run test")).additionalContext as string;
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(4000);
	});
});

describe("it says it once", () => {
	it("is silent on a session's second background job, and speaks to a new session", () => {
		expect(emission(bash("npm run test", {}, "sess-A"))).not.toBeNull();
		expect(emission(bash("sleep 60", {}, "sess-A"))).toBeNull();
		expect(emission(bash("npm run test", {}, "sess-B"))).not.toBeNull();
	});

	it("a subagent under a session already told is told too", () => {
		// A dispatched subagent's payload carries its PARENT's session_id and is
		// told apart only by agent_id (mantahostels#1804). Keyed on the session alone, the
		// subagent would inherit the parent's latch and never meet the rule.
		expect(emission(bash("npm run test", {}, "sess-C"))).not.toBeNull();
		expect(
			emission({ ...bash("npm run test", {}, "sess-C"), agent_id: "sub-1" }),
		).not.toBeNull();
	});
});

describe("things that are not a backgrounded Bash call", () => {
	it("a foreground call carries no flag and is handed nothing", () => {
		expect(
			emission({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test" },
			}),
		).toBeNull();
	});

	it("an explicit false is handed nothing", () => {
		expect(
			emission({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "npm run test", run_in_background: false },
			}),
		).toBeNull();
	});

	it("a command that only mentions the flag is handed nothing", () => {
		// The field is read, never the command string — which is what keeps this
		// guard off every session that greps the repo for the flag's name.
		expect(
			emission({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command: "grep -rn run_in_background scripts" },
			}),
		).toBeNull();
	});

	it("a payload with no tool input at all is handed nothing", () => {
		expect(emission({ session_id: "test", tool_name: "Bash" })).toBeNull();
	});
});

describe("what it cannot resolve, it records and allows", () => {
	it("says nothing and logs when the payload carries no session", () => {
		// gp_begin's own fail-open (mantahostels#103 §6): without a session id there is no
		// latch key, so an injection would repeat on every call.
		const r = run({
			tool_name: "Bash",
			tool_input: { command: "npm run test", run_in_background: true },
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/no session_id in payload/,
		);
	});

	it("writes nothing at all on a foreground call it was never going to judge", () => {
		// The pair to the case above, and the one that pins gp_begin's field. A
		// guard gated on `.session_id` would record a fail-open here — on every
		// foreground Bash call in the repo — burying the records that mean
		// something, which is the trap guard-parse.sh's gp_walk_shared_git header
		// states for the same reason.
		const r = run({ tool_name: "Bash", tool_input: { command: "ls" } });
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.existsSync(failOpenLogPath(config, root))).toBe(false);
	});

	it("disarms itself, silently and on the record, without the parser", () => {
		// The one fault that stands the guard down entirely (mantahostels#103 §6). It is
		// copied to a scratch directory whose lib/ holds guard-log.sh alone, so
		// the `declare -F gp_begin` gate finds nothing.
		const at = fs.mkdtempSync(path.join(dir, "nolib-"));
		fs.mkdirSync(path.join(at, "lib"));
		fs.copyFileSync(GUARD, path.join(at, "guard-bg-job.sh"));
		// guard-log.sh reads the repo root through gr_root, which lives in
		// guard-root.sh since mantahostels#1905 — without it the fail-open record lands under
		// the wrong slug and this case tests nothing.
		for (const lib of ["guard-log.sh", "guard-root.sh"]) {
			fs.copyFileSync(
				path.resolve(__dirname, "lib", lib),
				path.join(at, "lib", lib),
			);
		}
		const r = spawnGuard(
			path.join(at, "guard-bg-job.sh"),
			bash("npm run test"),
			{ project: root, config, cwd: root },
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(fs.readFileSync(failOpenLogPath(config, root), "utf8")).toMatch(
			/guard-parse\.sh did not load/,
		);
	});

	it("refuses the call when the fragment cannot be read, naming the rule", () => {
		// The one place this guard exits non-zero (mantahostels#1762): a rule that cannot be
		// stated is worth a refused tool call.
		const empty = fs.mkdtempSync(path.join(dir, "store-"));
		const r = run(bash("npm run test"), { WFC_RULES_DIR: empty });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("killed-background-job");
	});
});
