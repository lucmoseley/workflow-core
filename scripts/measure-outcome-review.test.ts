// @vitest-environment node
/*
 * measure-outcome-review.test.ts — the weekly outcome review's verdicts
 * (#4797, spec #4796 §Testing Decisions, Seam 2). Break it and a fix is kept
 * or unwound on the wrong count, the baseline reads the trigger week, a
 * session resumed on two seats counts twice, an unwind past the cap is
 * dropped, or a missed signature or a line lost with its worktree goes
 * unlisted.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubGhHandler } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";
import { transcriptRecords, writeTranscript } from "./lib/transcript-testkit";

const SCRIPT = path.join(__dirname, "measure-outcome-review.js");
const TRACKER = "o/t";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 4, 1);
const d = (n: number) => new Date(T0 + n * DAY).toISOString();
/* The finding is filed on day 35: its trigger week is days 28-35 and its
 * baseline days 0-28. The fix lands on day 40; the run reads on day 60. */
const FILED = 35;
const FIXED = 40;
const NOW = d(60);
const SIG = { kind: "regex", pattern: "BOOM", scope: "both" };

let home = "";
afterEach(() => {
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = "";
});

interface Issue {
	number: number;
	title: string;
	state?: "OPEN" | "CLOSED";
	body?: string;
	createdAt?: string;
	closedAt?: string;
	labels?: string[];
}

function scratch() {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "outcome-review-"));
	const root = path.join(home, "repo");
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(root, "docs", "data"), { recursive: true });
	execFileSync("git", ["init", "-q", root]);
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker: TRACKER }),
	);
	const seats = [path.join(home, "seat1"), path.join(home, "seat2")];
	const issues: Issue[] = [];
	const shas: string[] = [];

	const git = (args: string[], at?: string) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
				...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}),
			},
		}).trim();

	return {
		root,
		seats,
		issues,
		commit(message: string, day: number) {
			git(["commit", "-q", "--allow-empty", "-m", message], d(day));
			const sha = git(["rev-parse", "HEAD"]);
			git(["update-ref", "refs/remotes/origin/main", sha]);
			shas.push(sha);
			return sha;
		},
		/** A session starting on day `day` with `hits` BOOM records in its
		 * main log and `subHits` in one subagent log. */
		session(
			id: string,
			day: number,
			hits: number,
			{
				seat = 0,
				subHits = 0,
				word = "BOOM",
			}: { seat?: number; subHits?: number; word?: string } = {},
		) {
			const dir = path.join(seats[seat], "projects", "-repo");
			fs.mkdirSync(dir, { recursive: true });
			const r = transcriptRecords(d(day));
			writeTranscript(
				path.join(dir, `${id}.jsonl`),
				r.founder("go"),
				...Array.from({ length: hits }, () => r.assistant(`${word} again`)),
				r.assistant("done"),
			);
			if (subHits) {
				const sub = path.join(dir, id, "subagents");
				fs.mkdirSync(sub, { recursive: true });
				writeTranscript(
					path.join(sub, "agent-a1.jsonl"),
					...Array.from({ length: subHits }, () => r.assistant(word)),
				);
			}
		},
		signatureLine(n: number, extra: Record<string, unknown> = {}) {
			fs.appendFileSync(
				path.join(root, "docs", "data", "outcome-signatures.jsonl"),
				`${JSON.stringify({
					issue: `${TRACKER}#${n}`,
					filedAt: d(FILED),
					signature: SIG,
					prediction: "the boom stops",
					case: { session: "s", line: 1 },
					...extra,
				})}\n`,
			);
		},
		runLine(line: Record<string, unknown>) {
			fs.appendFileSync(
				path.join(root, "docs", "data", "retro-runs.jsonl"),
				`${JSON.stringify({ mode: "weekly", date: "2026-06-01", ...line })}\n`,
			);
		},
		run({ failingView = false }: { failingView?: boolean } = {}) {
			const handler = `
const issues = ${JSON.stringify(issues)};
const failingView = ${failingView};
const flag = (f) => argv[argv.indexOf(f) + 1];
const row = (i) => ({ number: i.number, title: i.title, body: i.body ?? "", createdAt: i.createdAt ?? "", closedAt: i.closedAt ?? "", labels: (i.labels ?? []).map((name) => ({ name })) });
if (argv[0] === "issue" && argv[1] === "view") {
  if (failingView) { err("HTTP 502: bad gateway\\n"); exit(1); }
  const i = issues.find((x) => x.number === Number(argv[2]));
  if (!i) { err("no such issue\\n"); exit(1); }
  out(JSON.stringify({ state: i.state ?? "CLOSED" }));
} else if (argv[0] === "issue" && argv[1] === "list" && argv.includes("--label")) {
  const closedOnly = flag("--state") === "closed";
  out(JSON.stringify(issues.filter((i) => (i.labels ?? []).includes(flag("--label")) && (!closedOnly || i.closedAt)).map(row)));
} else if (argv[0] === "issue" && argv[1] === "list" && flag("--state") === "closed") {
  out(JSON.stringify(issues.filter((i) => i.closedAt).map(row)));
} else { err("unrouted: " + argv.join(" ") + "\\n"); exit(1); }
`;
			const { env } = stubGhHandler(home, handler);
			const r = runInProcess(
				SCRIPT,
				[
					"--json",
					"--now",
					NOW,
					"--root",
					root,
					...seats.flatMap((s) => ["--config-dir", s]),
				],
				{ env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: root } },
			);
			return { status: r.status, stderr: r.stderr, out: JSON.parse(r.stdout) };
		},
	};
}

type Fixture = ReturnType<typeof scratch>;

function baselineOfOne(f: Fixture) {
	for (const [i, day] of [2, 9, 16, 23].entries()) f.session(`b${i}`, day, 1);
}

function fixedFinding(f: Fixture) {
	f.issues.push({ number: 1, title: "BOOM in the lander" });
	f.signatureLine(1);
	return f.commit("Stop the boom (#1)", FIXED);
}

function afterFix(f: Fixture, n: number, hits: number, from = 0) {
	for (let i = 0; i < n; i++)
		f.session(`a${from + i}`, FIXED + 1 + from + i, hits);
}

const outcome = (
	out: { outcomes: { finding: string; why?: string }[] },
	n = 1,
) => out.outcomes.find((o) => o.finding === `${TRACKER}#${n}`);

describe("measure-outcome-review.js", () => {
	it("waits on an open finding, an unfixed one, and a fix under a week old", () => {
		const f = scratch();
		f.commit("Initial", 1);
		f.issues.push(
			{ number: 1, title: "a", state: "OPEN" },
			{ number: 2, title: "b" },
			{ number: 3, title: "c" },
		);
		for (const n of [1, 2, 3]) f.signatureLine(n);
		f.commit("Stop c (#3)", 56);
		const { status, out } = f.run();
		expect(status).toBe(0);
		expect(outcome(out, 1)).toMatchObject({
			verdict: "waiting",
			why: "the finding is open",
		});
		expect(outcome(out, 2)).toMatchObject({
			verdict: "waiting",
			fixSha: null,
			why: "no commit on origin/main cites it",
		});
		expect(outcome(out, 3)).toMatchObject({
			verdict: "waiting",
			fixAt: d(56),
			why: `first reading from ${d(63).slice(0, 10)}`,
		});
	});

	it("keeps a fix whose count fell to zero against 3 expected", () => {
		const f = scratch();
		baselineOfOne(f);
		const sha = fixedFinding(f);
		afterFix(f, 5, 0);
		const { status, out } = f.run();
		expect(status).toBe(0);
		expect(outcome(out)).toMatchObject({
			verdict: "keep",
			fixSha: sha,
			fixAt: d(FIXED),
			sessions: 3,
			observed: 0,
			expected: 3,
			baseline: { count: 4, sessions: 4, rate: 1 },
			guardrails: { reverts: [], followOns: [] },
			unwindIssue: null,
			late: false,
		});
	});

	it("unwinds a fix whose count did not fall", () => {
		const f = scratch();
		baselineOfOne(f);
		fixedFinding(f);
		afterFix(f, 3, 1);
		const { out } = f.run();
		expect(outcome(out)).toMatchObject({
			verdict: "unwind",
			observed: 3,
			expected: 3,
			why: "did not fall",
		});
		expect(out.unwinds.file.map((u: { finding: string }) => u.finding)).toEqual(
			[`${TRACKER}#1`],
		);
	});

	/** Finding #1 read once inconclusive: 1 hit in its first 3 sessions. */
	function extendedOnce() {
		const f = scratch();
		baselineOfOne(f);
		fixedFinding(f);
		afterFix(f, 3, 0);
		f.session("a-hit", FIXED + 1, 1);
		const first = f.run().out;
		expect(outcome(first)).toMatchObject({
			verdict: "extend",
			sessions: 3,
			observed: 1,
		});
		f.runLine({ outcomes: [outcome(first)] });
		return f;
	}

	it("reads an extended finding again over every session since its fix, keeping it where the count fell", () => {
		const f = extendedOnce();
		afterFix(f, 5, 0, 3);
		const { out } = f.run();
		expect(outcome(out)).toMatchObject({
			verdict: "keep",
			sessions: 9,
			observed: 1,
			expected: 9,
			window: { start: d(FIXED), end: NOW },
		});
	});

	it("unwinds an extended finding read inconclusive a second time, over the grown window", () => {
		const f = extendedOnce();
		afterFix(f, 5, 1, 3);
		const { out } = f.run();
		expect(outcome(out)).toMatchObject({
			verdict: "unwind",
			sessions: 9,
			observed: 6,
			expected: 9,
		});
		expect(outcome(out)?.why).toMatch(/inconclusive a second time/);
	});

	it("extends where the sessions run out before 3 expected", () => {
		const f = scratch();
		baselineOfOne(f);
		fixedFinding(f);
		afterFix(f, 2, 0);
		const { out } = f.run();
		expect(outcome(out)).toMatchObject({
			verdict: "extend",
			sessions: 2,
			expected: 2,
			window: { start: d(FIXED), end: NOW },
		});
	});

	it("unwinds on a revert or a bug follow-on, whatever the counts", () => {
		const f = scratch();
		baselineOfOne(f);
		const sha = fixedFinding(f);
		afterFix(f, 5, 0);
		const revert = f.commit(
			`Revert "Stop the boom (#1)"\n\nThis reverts commit ${sha}.`,
			FIXED + 3,
		);
		f.issues.push(
			{
				number: 9,
				title: "lander hangs",
				labels: ["bug"],
				body: `Since ${sha.slice(0, 8)} the lander hangs.`,
				createdAt: d(FIXED + 2),
			},
			{
				number: 10,
				title: "older",
				labels: ["bug"],
				body: "cites #1",
				createdAt: d(FIXED - 1),
			},
		);
		const { out } = f.run();
		expect(outcome(out)).toMatchObject({
			verdict: "unwind",
			observed: 0,
			why: "guardrail harm",
			guardrails: { reverts: [revert], followOns: [`${TRACKER}#9`] },
		});
		expect(out.unwinds.file[0]).toMatchObject({ harm: true, fixSha: sha });
	});

	it("grows the window until the baseline predicts 3", () => {
		const f = scratch();
		/* Two hits over four sessions: half a hit each, so six sessions. */
		for (const [i, day] of [2, 9, 16, 23].entries())
			f.session(`b${i}`, day, i < 2 ? 1 : 0);
		fixedFinding(f);
		afterFix(f, 8, 0);
		const { out } = f.run();
		expect(outcome(out)).toMatchObject({
			sessions: 6,
			expected: 3,
			baseline: { count: 2, sessions: 4, rate: 0.5 },
			window: {
				start: d(FIXED),
				/* The sixth session's first record, a second into its day. */
				end: new Date(Date.parse(d(FIXED + 6)) + 1000).toISOString(),
			},
		});
	});

	it("never reads the trigger week into the baseline", () => {
		const f = scratch();
		baselineOfOne(f);
		/* The trigger week, days 28-35, full of the fault. */
		f.session("t0", 29, 9);
		f.session("t1", 33, 9);
		/* A session starting exactly at the trigger week's edge is in it. */
		f.session("t2", FILED - 7, 9);
		fixedFinding(f);
		afterFix(f, 3, 0);
		const { out } = f.run();
		expect(outcome(out)).toMatchObject({
			baseline: { count: 4, sessions: 4, rate: 1 },
		});
	});

	it("counts a session in two seats once, with its subagents folded in", () => {
		const f = scratch();
		baselineOfOne(f);
		f.session("b0", 2, 1, { seat: 1 });
		f.session("b4", 20, 0, { subHits: 2 });
		fixedFinding(f);
		afterFix(f, 5, 0);
		const { out } = f.run();
		/* b0 is in both seats; b4's two hits are its subagent's. */
		expect(outcome(out)).toMatchObject({
			baseline: { count: 6, sessions: 5, rate: 1.2 },
		});
	});

	it("reads a finding in both records once, with the run record's baseline", () => {
		const f = scratch();
		fixedFinding(f);
		f.runLine({
			findings: [
				{
					issue: `${TRACKER}#1`,
					class: "NEW",
					cites: "#0",
					signature: SIG,
					baseline: { count: 3, sessions: 3, rate: 1 },
					prediction: "stops",
				},
			],
		});
		afterFix(f, 4, 0);
		const { out } = f.run();
		expect(out.outcomes).toHaveLength(1);
		expect(outcome(out)).toMatchObject({
			verdict: "keep",
			sessions: 3,
			baseline: { count: 3, sessions: 3, rate: 1 },
		});
	});

	it("reports late findings apart and lists settled ones without reading them", () => {
		const f = scratch();
		baselineOfOne(f);
		fixedFinding(f);
		f.issues.push({ number: 2, title: "late one" });
		f.signatureLine(2, { late: true });
		f.commit("Stop the other (#2)", FIXED);
		f.issues.push({ number: 3, title: "kept" });
		f.signatureLine(3);
		f.runLine({ outcomes: [{ finding: `${TRACKER}#3`, verdict: "keep" }] });
		afterFix(f, 5, 0);
		const { out } = f.run();
		expect(outcome(out, 2)).toMatchObject({ verdict: "keep", late: true });
		expect(outcome(out, 1)).toMatchObject({ late: false });
		expect(outcome(out, 3)).toBeUndefined();
		expect(out.settled).toEqual([
			{ finding: `${TRACKER}#3`, verdict: "keep", late: false },
		]);
	});

	it("files at most 5 unwinds, harm first, carrying the rest and the prior backlog", () => {
		const f = scratch();
		baselineOfOne(f);
		const fixes: Record<number, string> = {};
		for (let n = 1; n <= 7; n++) {
			f.issues.push({ number: n, title: `fault ${n}` });
			f.signatureLine(n);
			fixes[n] = f.commit(`Stop fault ${n} (#${n})`, FIXED);
		}
		f.issues.push({
			number: 30,
			title: "fault 6 again",
			labels: ["bug"],
			body: "follows #6",
			createdAt: d(FIXED + 1),
		});
		f.runLine({
			outcomes: [
				{
					finding: `${TRACKER}#99`,
					verdict: "unwind",
					fixSha: "abc",
					observed: 9,
					expected: 3,
					guardrails: { reverts: [], followOns: [] },
				},
			],
			outcomeStep: { tokens: 1000, misses: 0, backlog: [`${TRACKER}#99`] },
		});
		afterFix(f, 3, 1);
		const { out } = f.run();
		const refs = (rows: { finding: string }[]) => rows.map((r) => r.finding);
		expect(out.unwinds.file).toHaveLength(5);
		/* #6 has harm; #99, carried in at 3x, outranks the 1x unwinds. */
		expect(refs(out.unwinds.file)).toEqual([
			`${TRACKER}#6`,
			`${TRACKER}#99`,
			`${TRACKER}#1`,
			`${TRACKER}#2`,
			`${TRACKER}#3`,
		]);
		expect(refs(out.unwinds.carried)).toEqual([
			`${TRACKER}#4`,
			`${TRACKER}#5`,
			`${TRACKER}#7`,
		]);
		expect(out.outcomeStep.backlog).toEqual(refs(out.unwinds.carried));
		expect(out.unwinds.file[1]).toMatchObject({ carriedIn: true });
	});

	it("keeps a carried backlog entry past the cap rather than dropping it", () => {
		const f = scratch();
		f.commit("Initial", 1);
		const backlog = Array.from(
			{ length: 17 },
			(_, i) => `${TRACKER}#${100 + i}`,
		);
		f.runLine({ outcomeStep: { tokens: 1, misses: 0, backlog } });
		const { out } = f.run();
		expect(out.unwinds.file).toHaveLength(5);
		expect(out.outcomeStep.backlog).toHaveLength(12);
		expect(out.flipDue).toMatchObject({ due: true });
		expect(out.flipDue.why).toMatch(/carried backlog 12 is over 10/);
	});

	it("lists the week's landed fault-shaped closes with no signature, and the week's bug closes declared no-fault", () => {
		const f = scratch();
		f.commit("Initial", 1);
		const closed = (
			n: number,
			title: string,
			day: number,
			labels: string[] = [],
		) => f.issues.push({ number: n, title, closedAt: d(day), labels });
		closed(20, "Lander loses a ref", 56, ["bug"]);
		closed(21, "Add a lander dashboard", 57);
		closed(22, "Add a panel", 57);
		closed(23, "No commit for this", 57, ["bug"]);
		closed(24, "Signed already", 57, ["bug"]);
		closed(25, "Closed too long ago", 49, ["bug"]);
		closed(26, "Fix the dropped queue ref", 57, ["origin:lander-script"]);
		f.commit("Read refs once (#20)", 55);
		f.commit("Stop the dashboard stalling (#21)", 56);
		f.commit("Add the panel (#22)", 56);
		f.commit("Sign it (#24)", 56);
		f.commit("Old (#25)", 48);
		f.commit("Fix the dropped ref (#26)", 56);
		f.signatureLine(24, { signature: null, why: "no trace" });
		closed(40, "no-fault bug", 57, ["bug", "origin:triage"]);
		closed(41, "signed bug", 57, ["bug", "origin:audit"]);
		closed(42, "hand-filed bug", 57, ["bug"]);
		closed(43, "no-fault bug closed long ago", 40, ["bug", "origin:triage"]);
		closed(44, "no-fault non-bug", 57, ["origin:triage"]);
		f.issues.push({
			number: 45,
			title: "open no-fault bug",
			labels: ["bug", "origin:triage"],
		});
		f.signatureLine(41, { signature: null, why: "no trace" });
		const { status, out } = f.run();
		expect(status).toBe(0);
		expect(out.misses).toEqual([
			expect.objectContaining({ issue: `${TRACKER}#20`, why: ["bug"] }),
			expect.objectContaining({
				issue: `${TRACKER}#21`,
				why: ["fault-shaped commit subject"],
			}),
		]);
		expect(out.outcomeStep.misses).toBe(2);
		/* Only the week's closes: #43 closed long ago and #45 is open. */
		expect(out.noFaultBug.map((m: { issue: string }) => m.issue)).toEqual([
			`${TRACKER}#40`,
		]);
	});

	describe("a declared line lost with its worktree (#4861)", () => {
		const lostLine = {
			filedAt: d(FILED),
			signature: SIG,
			prediction: "the boom stops",
			case: { session: "s", line: 1 },
		};
		const section = (line: unknown) =>
			`Body.\n\n## Fault signature\n\n\`\`\`json\n${JSON.stringify(line)}\n\`\`\`\n`;

		it("lists a closed labelled ticket with no line, with the line its body records, apart from the no-fault bugs", () => {
			const f = scratch();
			f.commit("Initial", 1);
			f.commit("Stop the boom (#50)", 56);
			f.issues.push(
				{
					number: 50,
					title: "Fix the boom",
					closedAt: d(57),
					labels: ["bug", "origin:triage", "fault-signature"],
					body: section(lostLine),
				},
				{
					number: 51,
					title: "Closed months ago",
					closedAt: d(2),
					labels: ["origin:triage", "fault-signature"],
					body: section(lostLine),
				},
				{
					number: 52,
					title: "Still open",
					labels: ["origin:triage", "fault-signature"],
					body: section(lostLine),
				},
				{
					number: 53,
					title: "Landed fine",
					closedAt: d(57),
					labels: ["origin:triage", "fault-signature"],
					body: section(lostLine),
				},
			);
			f.signatureLine(53);
			const { status, out } = f.run();
			expect(status).toBe(0);
			expect(out.lostLines).toEqual([
				{
					issue: `${TRACKER}#50`,
					title: "Fix the boom",
					line: { issue: `${TRACKER}#50`, ...lostLine },
				},
				expect.objectContaining({ issue: `${TRACKER}#51` }),
			]);
			expect(out.noFaultBug).toEqual([]);
			expect(out.misses).toEqual([]);
		});

		it("lists a lost late line, which carries no origin label, as lost and not as a miss", () => {
			const f = scratch();
			f.commit("Initial", 1);
			f.commit("Stop the boom (#50)", 56);
			f.issues.push({
				number: 50,
				title: "Fix the boom",
				closedAt: d(57),
				labels: ["bug", "fault-signature"],
				body: section({ ...lostLine, late: true }),
			});
			const { out } = f.run();
			expect(out.misses).toEqual([]);
			expect(out.lostLines).toEqual([
				expect.objectContaining({
					issue: `${TRACKER}#50`,
					line: expect.objectContaining({ late: true }),
				}),
			]);
		});

		it("lists it UNRECOVERABLE where the body section is gone", () => {
			const f = scratch();
			f.commit("Initial", 1);
			f.issues.push({
				number: 50,
				title: "Fix the boom",
				closedAt: d(57),
				labels: ["origin:triage", "fault-signature"],
				body: "Body, its section edited away.",
			});
			const { status, out } = f.run();
			expect(status).toBe(0);
			expect(out.lostLines).toEqual([
				expect.objectContaining({ issue: `${TRACKER}#50`, line: null }),
			]);
		});

		it("reads two identical lines for one issue as one finding, and names two differing ones a conflict", () => {
			const f = scratch();
			baselineOfOne(f);
			fixedFinding(f);
			f.signatureLine(1);
			f.issues.push({ number: 2, title: "Another boom" });
			f.signatureLine(2);
			f.signatureLine(2, { prediction: "a different prediction" });
			const { out } = f.run();
			expect(
				out.outcomes.filter((o: { finding: string }) =>
					o.finding.startsWith(TRACKER),
				),
			).toHaveLength(1);
			expect(outcome(out, 1)).toBeDefined();
			expect(outcome(out, 2)).toBeUndefined();
			expect(out.conflicts).toEqual([
				{
					issue: `${TRACKER}#2`,
					lines: [
						expect.objectContaining({ prediction: "the boom stops" }),
						expect.objectContaining({ prediction: "a different prediction" }),
					],
				},
			]);
		});
	});

	it("is due its flip check at the 4th run to reach a verdict, or 2 over budget", () => {
		const f = scratch();
		baselineOfOne(f);
		fixedFinding(f);
		afterFix(f, 5, 0);
		const verdictLine = {
			outcomes: [{ finding: `${TRACKER}#77`, verdict: "keep" }],
			outcomeStep: { tokens: 1000, misses: 0, backlog: [] },
		};
		f.runLine(verdictLine);
		f.runLine(verdictLine);
		f.runLine({ outcomes: [{ finding: `${TRACKER}#78`, verdict: "waiting" }] });
		expect(f.run().out.flipDue).toMatchObject({ due: false });
		f.runLine(verdictLine);
		expect(f.run().out.flipDue).toEqual({
			due: true,
			why: "4 runs reached a verdict (due at 4)",
		});
	});

	it("is due its flip check early on two runs over the token budget", () => {
		const f = scratch();
		f.commit("Initial", 1);
		f.runLine({ outcomeStep: { tokens: 31_000, misses: 0, backlog: [] } });
		expect(f.run().out.flipDue).toMatchObject({ due: false });
		f.runLine({ outcomeStep: { tokens: 45_000, misses: 0, backlog: [] } });
		expect(f.run().out.flipDue).toMatchObject({ due: true });
	});

	it("names a failed issue read, gives no verdict on it, and exits 1", () => {
		const f = scratch();
		baselineOfOne(f);
		fixedFinding(f);
		afterFix(f, 5, 0);
		const { status, out } = f.run({ failingView: true });
		expect(status).toBe(1);
		expect(outcome(out)).toMatchObject({ verdict: "waiting" });
		expect(outcome(out)?.why).toMatch(/could not read o\/t#1: HTTP 502/);
		expect(out.failures.join("\n")).toMatch(/HTTP 502/);
	});
});

describe("--baseline, a finding's baseline at filing", () => {
	function runBaseline(f: Fixture, content: unknown) {
		const file = path.join(home, "sig.json");
		fs.writeFileSync(file, JSON.stringify(content));
		const r = runInProcess(
			SCRIPT,
			[
				"--baseline",
				file,
				"--filed-at",
				d(FILED),
				"--json",
				"--root",
				f.root,
				...f.seats.flatMap((s) => ["--config-dir", s]),
			],
			{ env: { ...process.env, CLAUDE_PROJECT_DIR: f.root } },
		);
		return {
			status: r.status,
			stderr: r.stderr,
			out: r.status === 2 ? null : JSON.parse(r.stdout),
		};
	}
	/* The triggering session, in the trigger week: its line 2 is a BOOM. */
	const declared = {
		signature: SIG,
		prediction: "the boom stops",
		case: { session: "trig", line: 2 },
	};

	it("counts the four weeks before the trigger week as a per-session rate", () => {
		const f = scratch();
		baselineOfOne(f);
		f.session("trig", 30, 5);
		const { status, out } = runBaseline(f, declared);
		expect(status).toBe(0);
		expect(out).toMatchObject({
			filedAt: d(FILED),
			window: { start: d(0), end: d(28) },
			baseline: { count: 4, sessions: 4, rate: 1 },
			failures: [],
		});
	});

	it("gives a null baseline for a null signature", () => {
		const f = scratch();
		const { status, out } = runBaseline(f, {
			signature: null,
			why: "no trace",
		});
		expect(status).toBe(0);
		expect(out.baseline).toBeNull();
	});

	it("refuses a signature that misses its case, exit 2, as a filing is refused", () => {
		const f = scratch();
		f.session("trig", 30, 0);
		const { status, stderr } = runBaseline(f, declared);
		expect(status).toBe(2);
		expect(stderr).toMatch(/does not match its case/);
	});
});
