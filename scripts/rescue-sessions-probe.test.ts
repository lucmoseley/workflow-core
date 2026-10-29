// @vitest-environment node
/*
 * rescue-sessions-probe.test.ts — `rescue-sessions.js probe`, driven through
 * its command line (#620, spec #617): one test per verdict row, plus the cases
 * the spec names. Breaking it costs the one promise the probe makes: a slow or
 * asking session is never called FROZEN, so #617's takeover never stops it.
 *
 * Fixtures: scripts/lib/rescue-testkit.ts. The real script is spawned in a
 * sandbox against the kit's fake `claude` oracle, fake `gh` and fabricated
 * `/proc` (WFC_PROC), so no live session is ever sampled.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, issueClaims } from "./lib/arbiter-testkit";
import {
	buildStatLine,
	EXIT,
	holderRow,
	MODEL_LIMIT_LINE,
	PID,
	rescueKit,
	SESSION_LIMIT_LINE,
	SHORT,
	SID,
	said,
	WEEKLY_LIMIT_LINE,
	withTracker,
} from "./lib/rescue-testkit";
import { buildBashCall } from "./lib/transcript-testkit";

const sb = freshSandbox(withTracker);
const {
	plan,
	procRoot,
	transcript,
	lists,
	between,
	proc,
	writeTranscript,
	jobState,
	ghostJob,
	readOracleCalls,
	run,
} = rescueKit(sb);

const subagent = (dir = plan()) =>
	path.join(dir, "projects", "p", SID, "subagents", "agent-a1.jsonl");

const cpuTo = (pid: number, ppid: number, ticks: number) =>
	`printf '%s' '${buildStatLine(pid, ppid, ticks)}' > '${path.join(procRoot(), String(pid), "stat")}'`;

const calling = (command: string) => JSON.stringify(buildBashCall(command));

/**
 * The common case: listed working on the first plan, a transcript whose turn
 * ended on `waiting:`, nothing in flight, and a process tree that idles.
 */
const frozenHolder = () => {
	lists([holderRow()]);
	writeTranscript([said("Delegated the suite.\n\nwaiting: the suite run")]);
	jobState({ inFlight: { tasks: 0, queued: 0 } });
	proc(PID, 1, 1000, "claude");
	issueClaims.claimIssue(620, { sessionId: SID });
};

const probe = (args: string[] = ["--issue", "620"]) => run("probe", args);

const verdictOf = (r: { stdout: string }) => r.stdout.split(/\s/)[0];

describe("probe: the verdict table, first match wins", () => {
	it("UNKNOWN when the only plan's oracle will not read", async () => {
		frozenHolder();
		fs.writeFileSync(path.join(plan(), "fail"), "");
		const r = await probe();
		expect(verdictOf(r)).toBe("UNKNOWN");
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain("holder in no plan that read");
	});

	it("UNKNOWN when the transcript will not read", async () => {
		frozenHolder();
		fs.rmSync(transcript());
		const r = await probe();
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain("transcript would not read");
	});

	it("UNKNOWN when /proc has no entry for the session's process", async () => {
		frozenHolder();
		fs.rmSync(path.join(procRoot(), String(PID)), { recursive: true });
		const r = await probe();
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain("/proc would not read");
	});

	it("UNKNOWN when the transcript vanishes by the second sample", async () => {
		frozenHolder();
		between(`rm '${transcript()}'`);
		const r = await probe();
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain("second sample: transcript would not read");
	});

	it("ENDED when no plan lists it", async () => {
		frozenHolder();
		lists([]);
		const r = await probe();
		expect(verdictOf(r)).toBe("ENDED");
		expect(r.status).toBe(EXIT.ENDED);
	});

	it("ENDED when the oracle lists it terminal, even with its pid gone", async () => {
		frozenHolder();
		lists([holderRow({ state: "stopped" })]);
		fs.rmSync(path.join(procRoot(), String(PID)), { recursive: true });
		const r = await probe();
		expect(r.status).toBe(EXIT.ENDED);
		expect(r.stdout).toContain("terminal (stopped)");
	});

	it("ASKING when the oracle says needs_input", async () => {
		frozenHolder();
		lists([holderRow({ state: "needs_input" })]);
		const r = await probe();
		expect(r.status).toBe(EXIT.ASKING);
		expect(r.stdout).toContain("oracle state needs_input");
	});

	it.each([
		[SESSION_LIMIT_LINE, "#2128"],
		[WEEKLY_LIMIT_LINE, "#2128"],
		[MODEL_LIMIT_LINE, "#2380"],
	])(
		"LIMITED when the oracle says blocked and its job record says %s (%s)",
		async (detail) => {
			frozenHolder();
			lists([holderRow({ state: "blocked" })]);
			jobState({ state: "blocked", detail });
			const r = await probe();
			expect(verdictOf(r)).toBe("LIMITED");
			expect(r.status).toBe(EXIT.LIMITED);
			expect(r.stdout).toContain(`blocked on its limit: ${detail}`);
		},
	);

	it.each([
		["its own question", "Which plan should the suite run on?"],
		[
			"a question quoting the limit message",
			"Retry now, or wait? It said You've hit your weekly limit · resets Oct 24",
		],
	])("ASKING when the oracle says blocked on %s", async (_, detail) => {
		frozenHolder();
		lists([holderRow({ state: "blocked" })]);
		jobState({ state: "blocked", detail });
		const r = await probe();
		expect(r.status).toBe(EXIT.ASKING);
		expect(r.stdout).toContain("oracle state blocked");
	});

	it("ASKING where the limit message is in another session's job record under the same short id", async () => {
		frozenHolder();
		lists([holderRow({ state: "blocked" })]);
		jobState({
			state: "blocked",
			detail: WEEKLY_LIMIT_LINE,
			sessionId: "other-session",
		});
		const r = await probe();
		expect(r.status).toBe(EXIT.ASKING);
	});

	it("ASKING when its last turn ended on needs input:", async () => {
		frozenHolder();
		writeTranscript([said("❓ Q1 …\n\nneeds input: which plan")]);
		const r = await probe();
		expect(r.status).toBe(EXIT.ASKING);
		expect(r.stdout).toContain("needs input:");
	});

	it("DONE when its last turn ended on result: with nothing in flight", async () => {
		frozenHolder();
		writeTranscript([said("Shipped.\n\nresult: #620 done")]);
		const r = await probe();
		expect(r.status).toBe(EXIT.DONE);
		expect(r.stdout).toContain("ended on result:");
	});

	it("FROZEN, not DONE, when a prompt after its result: went unanswered", async () => {
		frozenHolder();
		writeTranscript([
			said("Shipped.\n\nresult: #620 done"),
			JSON.stringify({ type: "user", message: { content: "now do #621" } }),
		]);
		const r = await probe();
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain("user prompt after it is unanswered");
	});

	it("not ENDED when a non-background session reports done", async () => {
		frozenHolder();
		lists([holderRow({ kind: "interactive", state: "done" })]);
		const r = await probe();
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain("kind interactive");
	});

	it("SLOW when the main transcript grows", async () => {
		frozenHolder();
		between(`printf 'x\\n' >> '${transcript()}'`);
		const r = await probe();
		expect(r.status).toBe(EXIT.SLOW);
		expect(r.stdout).toContain("main transcript changed size");
	});

	it("SLOW when a subagent transcript grows and the main one does not", async () => {
		frozenHolder();
		fs.mkdirSync(path.dirname(subagent()), { recursive: true });
		fs.writeFileSync(subagent(), "{}\n");
		between(`printf 'x\\n' >> '${subagent()}'`);
		const r = await probe();
		expect(r.status).toBe(EXIT.SLOW);
		expect(r.stdout).toContain("subagent transcript changed size");
	});

	it("SLOW when state.json shows work in flight", async () => {
		frozenHolder();
		jobState({ inFlight: { tasks: 1, queued: 0 } });
		const r = await probe();
		expect(r.status).toBe(EXIT.SLOW);
		expect(r.stdout).toContain("in flight");
	});

	it("SLOW on a long foreground tool call whose child is burning CPU", async () => {
		frozenHolder();
		writeTranscript([calling("npm run test -- --full=suite")]);
		proc(5000, PID, 0, "bash -c npm run test");
		proc(5001, 5000, 10, "node vitest");
		between(cpuTo(5001, 5000, 500));
		const r = await probe();
		expect(r.status).toBe(EXIT.SLOW);
		expect(r.stdout).toContain("descendant process spent CPU");
		expect(r.stdout).toContain("still open on a tool call");
	});

	it("FROZEN when the lost wake left a waiting: turn with nothing running", async () => {
		frozenHolder();
		const r = await probe();
		expect(verdictOf(r)).toBe("FROZEN");
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain("lost wake");
	});

	it("FROZEN, not SLOW, when only a persistent helper spends CPU", async () => {
		frozenHolder();
		proc(6000, PID, 0, "node /opt/mcp-server/index.js");
		between(cpuTo(6000, PID, 5000));
		const r = await probe();
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain("1 helper(s) excluded");
	});

	it("FROZEN when only a persistent helper's own child spends CPU", async () => {
		frozenHolder();
		proc(6000, PID, 0, "node /opt/mcp-server/index.js");
		proc(6001, 6000, 0, "node worker.js");
		between(cpuTo(6001, 6000, 5000));
		const r = await probe();
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain("descendants +0.00s");
	});

	it("FROZEN when the transcript is touched but not appended to", async () => {
		frozenHolder();
		between(`touch -d '2030-01-01' '${transcript()}'`);
		const r = await probe();
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toMatch(/(\d+)B -> \1B/);
	});
});

describe("probe: finding the plan", () => {
	it("UNKNOWN on every plan when one plan's dir will not read, naming each plan's failed read (#3512)", async () => {
		frozenHolder();
		fs.writeFileSync(path.join(plan(), "fail"), "");
		const two = plan(".claude2");
		lists([holderRow()], two);
		const r = await probe();
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain("holder in no plan that read");
		expect(r.stdout).toContain(`${plan()}: `);
		expect(r.stdout).toContain(`${two}: `);
	});

	it("reads the transcript off the plan whose records hold it, where every plan lists it (#1146)", async () => {
		const two = plan(".claude2");
		lists([holderRow()]);
		lists([holderRow()], two);
		writeTranscript(
			[said("Delegated the suite.\n\nwaiting: the suite run")],
			two,
		);
		jobState({ inFlight: { tasks: 0, queued: 0 } }, two);
		proc(PID, 1, 1000, "claude");
		issueClaims.claimIssue(620, { sessionId: SID });
		const r = await probe();
		expect(r.stdout).toContain(`on plan ${two}`);
		expect(r.stdout).toContain(`transcript: ${transcript(two)}`);
		expect(r.status).toBe(EXIT.FROZEN);
	});

	it("passes over another session's job record under the same short id on the caller's plan (#1146)", async () => {
		const two = plan(".claude2");
		lists([holderRow()]);
		lists([holderRow()], two);
		const other = path.join(plan(), "projects", "p", "other.jsonl");
		fs.mkdirSync(path.dirname(other), { recursive: true });
		fs.writeFileSync(other, `${said("result: done")}\n`);
		jobState({ sessionId: `${SHORT}-other`, linkScanPath: other });
		writeTranscript(
			[said("Delegated the suite.\n\nwaiting: the suite run")],
			two,
		);
		jobState({ inFlight: { tasks: 0, queued: 0 } }, two);
		proc(PID, 1, 1000, "claude");
		issueClaims.claimIssue(620, { sessionId: SID });
		const r = await probe();
		expect(r.stdout).toContain(`transcript: ${transcript(two)}`);
		expect(r.status).toBe(EXIT.FROZEN);
	});

	it("reads a transcript on one plan while its job record sits on another (#1146)", async () => {
		const two = plan(".claude2");
		lists([holderRow()]);
		lists([holderRow()], two);
		jobState({ inFlight: { tasks: 0, queued: 0 } });
		fs.rmSync(transcript(), { force: true });
		writeTranscript(
			[said("Delegated the suite.\n\nwaiting: the suite run")],
			two,
		);
		proc(PID, 1, 1000, "claude");
		issueClaims.claimIssue(620, { sessionId: SID });
		const r = await probe();
		expect(r.stdout).toContain(`transcript: ${transcript(two)}`);
		expect(r.status).toBe(EXIT.FROZEN);
	});

	it("UNKNOWN when one plan will not read and the others do not list it", async () => {
		frozenHolder();
		lists([]);
		const two = plan(".claude2");
		fs.mkdirSync(two, { recursive: true });
		fs.writeFileSync(path.join(two, "fail"), "");
		const r = await probe();
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain(two);
	});
});

describe("probe: naming the holder", () => {
	it("says there is nothing to probe where no other session claims the issue", async () => {
		frozenHolder();
		const r = await probe(["--issue", "999"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("nothing to probe");
	});

	it("refuses an issue with several holders and lists them", async () => {
		frozenHolder();
		issueClaims.claimIssue(620, { sessionId: "other-session" });
		const r = await probe();
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain(SID);
		expect(r.stderr).toContain("other-session");
	});

	it("takes an 8-character session id", async () => {
		frozenHolder();
		const r = await probe(["--session", SHORT]);
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain(`${SHORT} (#620)`);
	});

	it("refuses a session holding several tickets unless --issue names one", async () => {
		frozenHolder();
		issueClaims.claimIssue(621, { sessionId: SID });
		const refused = await probe(["--session", SID]);
		expect(refused.status).toBe(EXIT.REFUSED);
		expect(refused.stderr).toMatch(/#620, #621|#621, #620/);
		const named = await probe(["--session", SID, "--issue", "621"]);
		expect(named.status).toBe(EXIT.FROZEN);
		expect(named.stdout).toContain("(#621)");
	});

	it("takes the one open ticket where its other claims are on closed ones (#648)", async () => {
		frozenHolder();
		issueClaims.claimIssue(621, { sessionId: SID });
		fs.writeFileSync(path.join(sb.dir, "closed-620"), "");
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain("(#621)");
	});

	it("still refuses, naming the closed one, where two claims are open", async () => {
		frozenHolder();
		issueClaims.claimIssue(621, { sessionId: SID });
		issueClaims.claimIssue(622, { sessionId: SID });
		fs.writeFileSync(path.join(sb.dir, "closed-620"), "");
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("(#620 closed) — name one with --issue");
	});

	it("says there is nothing to probe where every claim is on a closed ticket", async () => {
		frozenHolder();
		issueClaims.claimIssue(621, { sessionId: SID });
		fs.writeFileSync(path.join(sb.dir, "closed-620"), "");
		fs.writeFileSync(path.join(sb.dir, "closed-621"), "");
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("only on closed tickets");
		expect(r.stderr).toContain("nothing to probe");
		expect(r.stderr).not.toContain("--issue");
	});

	it("keeps the refusal, never guessing, where the tracker will not read, naming its error and the issues it could not rule out", async () => {
		frozenHolder();
		issueClaims.claimIssue(621, { sessionId: SID });
		fs.writeFileSync(path.join(sb.dir, "closed-620"), "");
		fs.writeFileSync(path.join(sb.dir, "gh-fails"), "");
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain(
			"tracker would not read to rule out closed ones: HTTP 502",
		);
		expect(r.stderr).toMatch(/#620, #621|#621, #620/);
	});

	it("refuses an --issue the named session holds no claim on, naming the issue", async () => {
		frozenHolder();
		const r = await probe(["--session", SID, "--issue", "700"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("holds no claim on #700");
	});

	it("refuses an id no plan, job, transcript or claim knows, naming the id", async () => {
		frozenHolder();
		const r = await probe(["--session", "no-such-session-id"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("knows a session no-such-session-id");
	});

	it("refuses this session's own id", async () => {
		frozenHolder();
		lists([holderRow(), { sessionId: "sandbox", state: "working" }]);
		const r = await probe(["--session", "sandbox"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("is this session");
	});
});

describe("probe: GHOST, off the first sample alone", () => {
	it("GHOST where the oracle lists it with no pid and it wrote no transcript, sampling once", async () => {
		ghostJob("/implement 620");
		issueClaims.claimIssue(620, { sessionId: SID });
		const r = await probe();
		expect(verdictOf(r)).toBe("GHOST");
		expect(r.status).toBe(EXIT.GHOST);
		expect(r.stdout).toContain("listed with no process behind it");
		expect(r.stdout).toContain('detail "starting…"');
		expect(readOracleCalls()).toBe(1);
	});

	it("GHOST where no plan lists it at all", async () => {
		ghostJob("/implement 620", []);
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.GHOST);
		expect(r.stdout).toContain("not listed at all");
	});

	it("not GHOST inside the grace window", async () => {
		ghostJob("/implement 620");
		jobState({ state: "working", updatedAt: new Date().toISOString() });
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain("first sample: /proc would not read");
		expect(readOracleCalls()).toBe(2);
	});

	it("not GHOST once it has written a transcript", async () => {
		ghostJob("/implement 620");
		writeTranscript([said("Reading the ticket.")]);
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain(`transcript: ${transcript()}`);
	});

	it("not GHOST where no listed agent carries a pid: that is a changed shape", async () => {
		ghostJob("/implement 620");
		lists([holderRow({ pid: undefined })]);
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(readOracleCalls()).toBe(2);
	});

	it("not GHOST where its record is no longer working", async () => {
		ghostJob("/implement 620");
		jobState({ state: "done" });
		const r = await probe(["--session", SID]);
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(readOracleCalls()).toBe(2);
	});
});

/* #1989: a job that never started holds no claim. */
describe("probe --issue: falling back to the job whose intent names it", () => {
	it("finds the job by its intent where no session claims the issue", async () => {
		ghostJob("/implement 620 — RESUMED from session 3");
		const r = await probe(["--issue", "620"]);
		expect(r.status).toBe(EXIT.GHOST);
		expect(r.stdout).toContain(`${SHORT} (#620)`);
	});

	it("reads only the command's own issue list, not a number later in the intent", async () => {
		ghostJob("/implement 620 — RESUMED from session 3");
		const r = await probe(["--issue", "3"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("no blocked/running/working/needs_input job");
	});

	it("passes over a finished job naming the issue", async () => {
		ghostJob("/implement 620");
		jobState({ state: "done", intent: "/implement 620" });
		const r = await probe(["--issue", "620"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("nothing to probe");
	});
});
