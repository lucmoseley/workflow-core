// @vitest-environment node
/*
 * The refill loop's resume of a stopped session (lib/refill-resume.js) against
 * lib/resume-io-fake.ts, which resume-io.contract.test.ts holds to the
 * production adapter: what the resume launches and with which key, how it
 * judges the job the launcher named, what a copy is handed, and what a move to
 * another seat or onto a key stops where it fails.
 *
 * Loosen one and a resume can bill the plan for a key's session, count a job
 * still stopped or another session's as resumed, leave a failed move's resume
 * starting, or run a move's job on a key unrecorded.
 */
import { describe, expect, it } from "vitest";
import { FAKE_COPY } from "./bg-resume-fake";
import { MODEL } from "./refill-decide.js";
import { resumeSteps } from "./refill-resume.js";
import {
	ANSWERS,
	COPY_SESSION,
	FAULTS,
	fakeResumeIo,
	HEADLESS_JOB,
	JOB,
	KEY_VAR,
	type Picks,
	SAVED_FLAGS,
	SESSION,
} from "./resume-io-fake";

type JobLaunch = import("./refill-blocks.js").JobLaunch;

const SEAT = "/home/u/.claude3";
const TARGET = "/home/u/.claude4";
const ROOT = "/home/u/repo";
const PROMPT = "carry on";
const LAUNCH = { root: ROOT, issues: [7], seat: SEAT };
const IDS = { sessionId: SESSION, cwd: ROOT };

/** The resume steps over the fake serving `picks`, its env `env`, else
 * fakeResumeIo's bare PATH. */
function fakeIo(picks: Picks = {}, env?: NodeJS.ProcessEnv) {
	const fake = fakeResumeIo(picks, env);
	return { ...fake, steps: resumeSteps(fake.io) };
}

describe("readResumeTarget", () => {
	it("takes the listing's session id over its job record's", () => {
		const { steps } = fakeIo({ readJobRecord: "otherSession" });
		expect(
			steps.readResumeTarget({
				...LAUNCH,
				jobId: JOB,
				sessionId: SESSION,
			} as unknown as JobLaunch),
		).toEqual(IDS);
	});

	it("falls back to the checkout where the job record names no cwd", () => {
		const { steps } = fakeIo({ readJobRecord: "working" });
		expect(
			steps.readResumeTarget({ ...LAUNCH, jobId: JOB } as unknown as JobLaunch),
		).toEqual(IDS);
	});

	it("carries the launch flags its job record saved (#4098)", () => {
		const { steps } = fakeIo({ readJobRecord: "saved" });
		expect(
			steps.readResumeTarget({ ...LAUNCH, jobId: JOB } as unknown as JobLaunch),
		).toEqual({ ...IDS, flags: SAVED_FLAGS });
	});

	it("reads no job record for a launch naming no job, its target the checkout", () => {
		const { steps, callsTo } = fakeIo({ readJobRecord: "working" });
		expect(
			steps.readResumeTarget({
				...LAUNCH,
				sessionId: SESSION,
			} as unknown as JobLaunch),
		).toEqual(IDS);
		expect(callsTo("readJobRecord")).toEqual([]);
	});
});

describe("resumeStopped", () => {
	it("refuses the --bg --resume where its auth would not bill the subscription, launching nothing (#2236)", () => {
		const { steps, callsTo } = fakeIo({ authRefusal: "refused" });
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: ANSWERS.authRefusal.refused,
		});
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("reads a launcher line naming no job as a failed resume (#2963)", () => {
		const { steps } = fakeIo({ runClaude: "noJob" });
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: `the launcher never said what it started: ${ANSWERS.runClaude.noJob.out}`,
		});
	});

	it("counts a job woken in place whose state.json names its session, running", () => {
		const { steps } = fakeIo({ runClaude: "woke", readJobRecord: "working" });
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: null,
			jobId: JOB,
			sessionId: SESSION,
			copy: false,
		});
	});

	it("does not count a woken job whose state.json still reads stopped", () => {
		const { steps } = fakeIo({ runClaude: "woke", readJobRecord: "stopped" });
		const r = steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(r.failed).toContain("state.json reads stopped");
	});

	it("does not count a woken job whose state.json reads another session", () => {
		const { steps } = fakeIo({
			runClaude: "woke",
			readJobRecord: "otherSession",
		});
		const r = steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(r.failed).toContain(`session s-other, not ${SESSION}`);
	});

	it("resumes an overflow session headless on its key, never --bg, the run keeping the session and its claims (#4580)", () => {
		const { steps, callsTo } = fakeIo({ overflowLookup: "launched" });
		const r = steps.resumeStopped({ ...LAUNCH, keyVar: KEY_VAR }, PROMPT, IDS);
		expect(r).toEqual({
			failed: null,
			jobId: HEADLESS_JOB,
			sessionId: SESSION,
			copy: false,
		});
		expect(callsTo("runClaude")).toEqual([]);
		expect(callsTo("authRefusal")).toEqual([]);
		expect(callsTo("launchHeadless")).toEqual([
			[{ keyVar: KEY_VAR, cwd: ROOT, prompt: PROMPT, resume: SESSION }],
		]);
		expect(callsTo("recordLaunch")).toEqual([]);
		expect(callsTo("moveIssueClaim")).toEqual([]);
		expect(callsTo("moveParkedBy")).toEqual([]);
	});

	it("names a key the headless launch refuses, launching nothing else", () => {
		const { steps, callsTo } = fakeIo({ launchHeadless: "unreadable" });
		expect(
			steps.resumeStopped({ ...LAUNCH, keyVar: KEY_VAR }, PROMPT, IDS),
		).toEqual({ failed: ANSWERS.launchHeadless.unreadable.why });
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("hands a plan seat's copy its claims and pass markers, recording no ledger row (#2963, #4105)", () => {
		const { steps, callsTo } = fakeIo();
		steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(callsTo("moveIssueClaim")).toEqual([
			[ROOT, 7, SESSION, COPY_SESSION],
		]);
		expect(callsTo("movePassMarkers")).toEqual([[ROOT, SESSION, COPY_SESSION]]);
		expect(callsTo("recordLaunch")).toEqual([]);
	});

	it("leaves the pass markers where the past id is still live, logging it (#4105)", () => {
		const { steps, lines } = fakeIo({ movePassMarkers: "live" });
		steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(lines).toContain(
			`pass markers of ${SESSION} not moved: ${ANSWERS.movePassMarkers.live}`,
		);
	});
});

describe("a copy's original retired (#4098)", () => {
	const Name = ANSWERS.sessionName.named.name;
	const CopyNote = ANSWERS.runClaude.copy.stderr.trim();

	it("names the copy after its original and stops and removes the original's job row", () => {
		const { steps, callsTo } = fakeIo({
			runClaude: ["copy", "removed"],
			readJobRecord: ["copyWorking", "working"],
			hasJobRecord: "present",
			sessionName: "named",
		});
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: null,
			jobId: FAKE_COPY,
			sessionId: COPY_SESSION,
			copy: true,
			why: CopyNote,
		});
		expect(callsTo("writeJobName")).toEqual([[SEAT, FAKE_COPY, Name]]);
		expect(callsTo("stop")).toEqual([[SEAT, JOB]]);
		expect(callsTo("runClaude").map(([argv]) => argv)[1]).toEqual(["rm", JOB]);
	});

	it("leaves a job row naming another session where the original's would be", () => {
		const { steps, callsTo } = fakeIo({
			readJobRecord: ["copyWorking", "otherSession"],
			hasJobRecord: "present",
		});
		steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(callsTo("stop")).toEqual([]);
		expect(callsTo("runClaude")).toHaveLength(1);
	});

	it("keeps an original it could not stop, and a copy it could not name, logging both", () => {
		const { steps, callsTo, lines } = fakeIo({
			readJobRecord: ["copyWorking", "working"],
			hasJobRecord: "present",
			stop: "busy",
			sessionName: "named",
			writeJobName: "unwritable",
		});
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS).failed).toBeNull();
		expect(callsTo("runClaude")).toHaveLength(1);
		expect(lines).toContain(
			`copy ${FAKE_COPY} of ${SESSION} not named: ${ANSWERS.writeJobName.unwritable}`,
		);
		expect(lines).toContain(
			`original ${JOB} of copy ${FAKE_COPY} not retired: its job ${JOB} not confirmed stopped: ${ANSWERS.stop.busy.why}`,
		);
	});
});

describe("resumeOwnId (#4098)", () => {
	const argvs = (calls: unknown[][]) => calls.map(([argv]) => argv);

	it("stops and removes a killed job, then resumes it under its own id with the flags it saved", () => {
		const { steps, callsTo } = fakeIo({
			readJobRecord: ["saved", "saved", "working"],
			hasJobRecord: "present",
			runClaude: ["removed", "ownId"],
		});
		expect(steps.resumeOwnId(LAUNCH, PROMPT, IDS)).toEqual({
			failed: null,
			jobId: JOB,
			sessionId: SESSION,
			copy: false,
		});
		expect(callsTo("stop")).toEqual([[SEAT, JOB]]);
		expect(argvs(callsTo("runClaude"))).toEqual([
			["rm", JOB],
			["--bg", "--resume", SESSION, ...SAVED_FLAGS, PROMPT],
		]);
		expect(callsTo("writeJobName")).toEqual([]);
	});

	it("resumes with the loop's model and its transcript's name where its record saved no flags", () => {
		const { steps, callsTo, lines } = fakeIo({
			readJobRecord: ["working", "working", "working"],
			hasJobRecord: "present",
			runClaude: ["removed", "ownId"],
			sessionName: "named",
		});
		steps.resumeOwnId(LAUNCH, PROMPT, IDS);
		expect(argvs(callsTo("runClaude"))[1]).toEqual([
			"--bg",
			"--resume",
			SESSION,
			"--model",
			MODEL,
			"--name",
			ANSWERS.sessionName.named.name,
			PROMPT,
		]);
		expect(lines.join("\n")).toContain(
			`no saved launch flags read for ${SESSION}`,
		);
	});

	it("names the copy the harness still starts, its original's row gone already", () => {
		const { steps, callsTo } = fakeIo({
			readJobRecord: ["saved", "saved", "copyWorking"],
			hasJobRecord: ["present", "present", "none"],
			runClaude: ["removed", "copy"],
			sessionName: "named",
		});
		expect(steps.resumeOwnId(LAUNCH, PROMPT, IDS)).toMatchObject({
			jobId: FAKE_COPY,
			copy: true,
		});
		expect(callsTo("writeJobName")).toEqual([
			[SEAT, FAKE_COPY, ANSWERS.sessionName.named.name],
		]);
		expect(callsTo("stop")).toEqual([[SEAT, JOB]]);
	});

	it("takes the flags read before an earlier try removed its record over any read now", () => {
		const flags = ["--model", "sonnet"];
		const { steps, callsTo, lines } = fakeIo({
			readJobRecord: "working",
			runClaude: "ownId",
		});
		steps.resumeOwnId(LAUNCH, PROMPT, { ...IDS, flags });
		expect(argvs(callsTo("runClaude")).at(-1)).toEqual([
			"--bg",
			"--resume",
			SESSION,
			...flags,
			PROMPT,
		]);
		expect(lines.join("\n")).not.toContain("no saved launch flags");
	});

	it("stops what a failed resume may still be starting under its id", () => {
		const { steps, callsTo } = fakeIo({
			readJobRecord: "saved",
			hasJobRecord: ["present", "present", "none"],
			runClaude: ["removed", "noJob"],
		});
		expect(steps.resumeOwnId(LAUNCH, PROMPT, IDS).failed).toContain(
			"the launcher never said what it started",
		);
		expect(callsTo("stop")).toEqual([
			[SEAT, JOB],
			[SEAT, JOB],
		]);
	});

	it("resumes nothing where the killed job is not confirmed stopped", () => {
		const { steps, callsTo } = fakeIo({
			readJobRecord: "saved",
			hasJobRecord: "present",
			stop: "busy",
		});
		expect(steps.resumeOwnId(LAUNCH, PROMPT, IDS)).toEqual({
			failed: `its job ${JOB} not confirmed stopped: ${ANSWERS.stop.busy.why}`,
		});
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("stops and removes nothing where the resume's auth would not bill the subscription", () => {
		const { steps, callsTo } = fakeIo({
			authRefusal: "refused",
			readJobRecord: "saved",
			hasJobRecord: "present",
		});
		expect(steps.resumeOwnId(LAUNCH, PROMPT, IDS)).toEqual({
			failed: ANSWERS.authRefusal.refused,
		});
		expect(callsTo("stop")).toEqual([]);
		expect(callsTo("runClaude")).toEqual([]);
	});
});

describe("moveSession (#3734, #3736)", () => {
	const job = { ...LAUNCH, jobId: JOB, prompt: "/implement 7" } as never;
	const keyTarget = { seat: TARGET, keyVar: KEY_VAR, allowanceUsd: 40 };

	it("names a transcript it could not copy, resuming nothing", () => {
		const { steps, callsTo } = fakeIo({ copyTranscript: "uncopied" });
		expect(steps.moveSession(job, { seat: TARGET }, PROMPT, IDS)).toEqual({
			failed: ANSWERS.copyTranscript.uncopied,
		});
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("stops what may be starting on the target where the resume is not confirmed", () => {
		const { steps, callsTo } = fakeIo({
			runClaude: "continued",
			readJobRecord: "unread",
			stop: "noJob",
		});
		const r = steps.moveSession(job, { seat: TARGET }, PROMPT, IDS);
		expect(r.failed).toContain("not confirmed");
		expect(callsTo("stop")).toEqual([[TARGET, JOB]]);
	});

	it("stops the job and names the fault where the dispatch ledger will not read (#3730)", () => {
		const { steps, callsTo } = fakeIo({ overflowLookup: "unreadable" });
		const r = steps.moveSession(
			job,
			{ seat: SEAT, keyVar: KEY_VAR, allowanceUsd: 40 },
			PROMPT,
			IDS,
		);
		expect(r.failed).toContain(FAULTS.overflowLookup.unreadable);
		expect(callsTo("stop")).toContainEqual([SEAT, HEADLESS_JOB]);
		expect(callsTo("moveIssueClaim")).toEqual([]);
	});

	/** The name a move onto `target` gives, its transcript read as `name`: a
	 * headless launch's on a key, a `--bg` launch's `-n` on a plan seat. */
	const movedName = (
		name: Picks["sessionName"],
		target: object = keyTarget,
	) => {
		const { steps, callsTo, lines } = fakeIo({ sessionName: name });
		steps.moveSession(job, target as never, PROMPT, IDS);
		const [[headless] = []] = callsTo("launchHeadless") as [
			[{ name?: string }]?,
		];
		const [[args] = [[]]] = callsTo("runClaude") as [[string[]]?];
		const at = args.indexOf("-n");
		const bgName = at < 0 ? null : args[at + 1];
		return {
			headless: headless ?? null,
			name: headless ? (headless.name ?? null) : bgName,
			read: callsTo("sessionName"),
			lines,
		};
	};

	it("resumes a plan session moved onto a key headless, named as its transcript gives, capped at the allowance it moved with (#4395, #4580)", () => {
		expect(movedName("named")).toMatchObject({
			headless: {
				keyVar: KEY_VAR,
				cwd: ROOT,
				prompt: PROMPT,
				resume: SESSION,
				name: "Implement 7: a title",
				budgetUsd: 40,
			},
			name: "Implement 7: a title",
			read: [[`${SEAT}/projects/-home-u-repo/${SESSION}.jsonl`]],
			lines: expect.not.arrayContaining([
				expect.stringContaining("name not read"),
			]),
		});
	});

	it("names a session whose transcript gives no name after its prompt (#4395)", () => {
		expect(movedName("unnamed").name).toBe("/implement 7");
	});

	it("names a session whose transcript will not read after its prompt, logging why (#4395)", () => {
		const r = movedName("unreadable");
		expect(r.name).toBe("/implement 7");
		expect(r.lines).toContain(
			`${SESSION}'s name not read, so named after its prompt: ${ANSWERS.sessionName.unreadable.why}`,
		);
	});

	it("leaves a session moved onto a plan seat its own name", () => {
		expect(movedName("named", { seat: TARGET }).name).toBeNull();
	});

	it("stops the job and hands it nothing where its ledger row will not write (#3730)", () => {
		const { steps, callsTo } = fakeIo({ recordLaunch: "unwritable" });
		const r = steps.moveSession(
			job,
			{ seat: SEAT, keyVar: KEY_VAR, allowanceUsd: 40 },
			PROMPT,
			IDS,
		);
		expect(r.failed).toContain("not recorded in the dispatch ledger");
		expect(callsTo("stop")).toContainEqual([SEAT, HEADLESS_JOB]);
		expect(callsTo("moveIssueClaim")).toEqual([]);
		expect(callsTo("moveParkedBy")).toEqual([]);
	});
});

describe("readResumeTarget on a key (#4580)", () => {
	const keyed = { ...LAUNCH, keyVar: KEY_VAR, jobId: "0e0e0e0e" };

	it("takes the cwd from the headless run's record, not a --bg job's", () => {
		const { steps, callsTo } = fakeIo({ readRunAsJob: "working" });
		expect(steps.readResumeTarget(keyed as unknown as JobLaunch)).toEqual({
			sessionId: SESSION,
			cwd: ANSWERS.readRunAsJob.working.cwd,
		});
		expect(callsTo("readJobRecord")).toEqual([]);
	});

	it("falls back to the checkout where the record will not read", () => {
		const { steps } = fakeIo({ readRunAsJob: "unreadable" });
		expect(steps.readResumeTarget(keyed as unknown as JobLaunch)).toEqual({
			sessionId: null,
			cwd: ROOT,
		});
	});
});

describe("adoptResumed on a key (#4580)", () => {
	const keyed = { ...LAUNCH, keyVar: KEY_VAR };

	it("adopts the headless run of the session launched since, from the run store", () => {
		const { steps, callsTo } = fakeIo({ findHeadlessRun: "found" });
		expect(steps.adoptResumed(keyed, IDS, 1000)).toEqual({
			failed: null,
			jobId: HEADLESS_JOB,
			sessionId: SESSION,
			copy: false,
		});
		expect(callsTo("findHeadlessRun")).toEqual([[SESSION, 1000]]);
		expect(callsTo("findResumed")).toEqual([]);
	});

	it("finds no job where the store holds no run of it since", () => {
		const { steps } = fakeIo({ findHeadlessRun: "none" });
		expect(steps.adoptResumed(keyed, IDS, 1000)).toBeNull();
	});
});
