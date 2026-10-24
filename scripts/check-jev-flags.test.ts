// @vitest-environment node
/*
 * Pins that check-jev-flags.js shows the Jev advisory's flagged, outage and
 * malformed turns once each since it last spoke, stays silent on an absent or
 * empty log, and reports where the trial stands.
 *
 * Driven end to end through the CLI, the way its sibling check-*.js suites
 * are: a fixture log on disk, argv, and the envelope or the human report as
 * the assertion (#202).
 *
 * TWO SANDBOXES, and the tests need both. `WFC_REPO_ROOT` points the marker
 * directory — and so the guard's log — at a temporary tree. `CLAUDE_CONFIG_DIR`
 * points lib/delivery-stamp.js's store at another, because the stamp lives per
 * machine rather than per repo and a test writing the real one would suppress
 * the founder's own next report.
 *
 * NOTHING HERE RUNS THE GUARD. The log is written by hand: this checker's
 * contract is with the file's shape, and `flagged`/`outage` lines do not exist
 * until the vendor call lands in a later ticket.
 *
 * `npm run status` runs it by hand (#2038): loosen a case and a flag raised in
 * a background job is never seen, so never judged, and #175's stop condition
 * counts the wrong flags.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

/* Asked for by name rather than spelled out, which is the whole reason
 * lib/jev-log.js exists: a fixture written to a filename of its own would
 * still pass the day the guard and this checker stopped agreeing. */
const require_ = createRequire(__filename);
const { logPath, previousLogPath } = require_("./lib/jev-log.js");
const jevTrial = require_("./lib/jev-trial.js");

/** The trial's and limb 2's start lines. */
const TRIAL_START_MS = Date.parse(jevTrial.TRIAL_START);
const OUTAGE_START_MS = Date.parse(jevTrial.OUTAGE_START);

const SCRIPT = path.join(__dirname, "check-jev-flags.js");

let dir: string;
let home: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-flags-"));
	home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-flags-home-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
});

function markers(): string {
	const at = path.join(dir, ".claude", "tmp", "markers");
	fs.mkdirSync(at, { recursive: true });
	return at;
}

interface Line {
	at: string;
	session?: string;
	outcome: string;
	confidence?: number;
	messageHash?: string;
	messageText?: string;
	model?: string;
	provider?: string;
}

/** Write `lines` as the live log, or to `file`, such as the rotated one. */
function writeLog(lines: (Line | string)[], file = logPath(dir)) {
	fs.writeFileSync(
		file,
		lines
			.map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
			.map((l) => `${l}\n`)
			.join(""),
	);
}

function flag(at: string, over: Partial<Line> = {}): Line {
	return {
		at,
		session: "abcdef0123456789",
		outcome: "flagged",
		confidence: 0.91,
		messageHash: "3f9c1a2b7e40",
		...over,
	};
}

function run(...args: string[]) {
	const res = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: {
			...process.env,
			WFC_REPO_ROOT: dir,
			CLAUDE_PROJECT_DIR: dir,
			HOME: home,
			CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
			WFC_NOTIFY_PERSIST: "",
		},
	});
	return { ...res, out: `${res.stdout}${res.stderr}` };
}

interface Envelope {
	outcome: string;
	summary: string;
	findings: { severity: string; tag: string; message: string }[];
	flagged?: number;
	outages?: number;
	malformed?: number;
	logged?: number;
	torn?: number;
}

function json(...args: string[]): Envelope {
	return JSON.parse(run("--json", ...args).stdout) as Envelope;
}

describe("check-jev-flags", () => {
	it("says nothing at all where the guard has logged nothing", () => {
		const { out, status } = run("--notify");

		expect(out).toBe("");
		expect(status).toBe(0);
	});

	it("says nothing where the log holds only gate skips", () => {
		writeLog([
			{ at: "2026-09-19T10:00:00.000Z", outcome: "skipped-no-sdk" },
			{ at: "2026-09-19T10:01:00.000Z", outcome: "skipped-marker" },
		]);

		const { out, status } = run("--notify");

		expect(out).toBe("");
		expect(status).toBe(0);
	});

	it("reports a flag by session and timestamp, never by its text", () => {
		writeLog([flag("2026-09-19T10:00:00.000Z")]);

		const { out, status } = run("--notify");

		expect(out).toContain("JEV-FLAG (1)");
		expect(out).toContain("2026-09-19T10:00:00.000Z");
		expect(out).toContain("session abcdef01");
		expect(out).toContain("3f9c1a2b7e40");
		/* Advisory: it reports and refuses nothing (#173). */
		expect(status).toBe(0);
		expect(json().outcome).toBe("WARN");
	});

	it("counts an outage on its own limb of the stop condition", () => {
		writeLog([
			flag("2026-09-19T10:00:00.000Z"),
			{ at: "2026-09-19T10:05:00.000Z", outcome: "outage", session: "s2" },
		]);

		const envelope = json();

		expect(envelope.flagged).toBe(1);
		expect(envelope.outages).toBe(1);
		expect(envelope.findings.map((f) => f.tag)).toEqual([
			"JEV-FLAG",
			"JEV-OUTAGE",
		]);
	});

	it("counts a malformed reply apart from the outage limb (#226)", () => {
		writeLog([
			{ at: "2026-09-19T10:05:00.000Z", outcome: "outage", session: "s2" },
			{ at: "2026-09-19T10:06:00.000Z", outcome: "malformed", session: "s3" },
		]);

		const envelope = json();

		expect(envelope.outages).toBe(1);
		expect(envelope.malformed).toBe(1);
		expect(envelope.findings.map((f) => f.tag)).toEqual([
			"JEV-OUTAGE",
			"JEV-MALFORMED",
		]);
	});

	it("says a malformed line counts toward no reversal limb", () => {
		writeLog([
			{ at: "2026-09-19T10:06:00.000Z", outcome: "malformed", session: "s3" },
		]);

		const { out } = run("--notify");

		expect(out).toContain("JEV-MALFORMED (1)");
		expect(out).toContain("MALFORMED ");
		/* On "neither", not on "counts toward": a footer saying the opposite —
		 * "counts toward reversal" — would pass the looser assertion. */
		expect(out).toContain("toward neither limb");
	});

	it("shows a flag once and stays silent on the next session start", () => {
		writeLog([flag("2026-09-19T10:00:00.000Z")]);

		expect(run("--notify").out).toContain("JEV-FLAG");
		expect(run("--notify").out).toBe("");
	});

	it("reports only what has landed since it last showed anything", () => {
		writeLog([flag("2026-09-19T10:00:00.000Z")]);
		run("--notify");

		writeLog([
			flag("2026-09-19T10:00:00.000Z"),
			flag("2026-09-19T11:00:00.000Z", { messageHash: "ffff00001111" }),
		]);
		const { out } = run("--notify");

		expect(out).toContain("JEV-FLAG (1)");
		expect(out).toContain("ffff00001111");
		expect(out).not.toContain("3f9c1a2b7e40");
	});

	it("answers a hand run in full, and does not consume the report", () => {
		writeLog([flag("2026-09-19T10:00:00.000Z")]);

		expect(json().flagged).toBe(1);
		/* The hand run stamped nothing, so the session start still gets it. */
		expect(run("--notify").out).toContain("JEV-FLAG");
	});

	it("reads the rotated half where a rotation could have hidden a flag", () => {
		writeLog([flag("2026-09-19T10:00:00.000Z")]);
		run("--notify");

		/* The live log now starts after the stamp, which is the one state in
		 * which an unreported flag can be sitting in the rotated file. */
		writeLog(
			[flag("2026-09-19T10:30:00.000Z", { messageHash: "aaaabbbbcccc" })],
			previousLogPath(dir),
		);
		writeLog([
			flag("2026-09-19T11:00:00.000Z", { messageHash: "ddddeeeeffff" }),
		]);

		const { out } = run("--notify");

		expect(out).toContain("aaaabbbbcccc");
		expect(out).toContain("ddddeeeeffff");
	});

	it("does not let a torn line hide the flags around it", () => {
		writeLog([
			flag("2026-09-19T10:00:00.000Z"),
			'{"at":"2026-09-19T10:01:00.000Z","outcome":"flag',
			flag("2026-09-19T10:02:00.000Z", { messageHash: "999988887777" }),
		]);

		const envelope = json();

		expect(envelope.flagged).toBe(2);
		expect(envelope.torn).toBe(1);
	});

	it("passes over a flag carrying no readable timestamp", () => {
		writeLog([
			{ at: "not a date", outcome: "flagged", session: "s1" },
			flag("2026-09-19T10:00:00.000Z"),
		]);

		expect(json().flagged).toBe(1);
	});

	it("skips rather than reporting all-clear where the log will not read", () => {
		/* A directory where the log file should be: present, and unreadable as a
		 * file — an absent log must stay distinguishable from an unreadable one. */
		fs.mkdirSync(logPath(dir));

		const { out, status } = run("--notify");

		expect(out).toBe("");
		expect(status).toBe(0);
		const envelope = json();
		expect(envelope.outcome).toBe("SKIP");
		expect(envelope.summary).toContain("the Jev advisory log would not read");
	});

	it("reads the rotated half on a run that has never stamped", () => {
		writeLog(
			[flag("2026-09-19T10:00:00.000Z", { messageHash: "aaaabbbbcccc" })],
			previousLogPath(dir),
		);
		writeLog([
			flag("2026-09-19T11:00:00.000Z", { messageHash: "ddddeeeeffff" }),
		]);

		const { out } = run("--notify");

		expect(out).toContain("aaaabbbbcccc");
		expect(out).toContain("ddddeeeeffff");
	});
});

/*
 * The trial standing (#253). The arithmetic itself is `lib/jev-trial.test.ts`'s
 * subject; what is asserted here is the reporting — which run shows it, what a
 * flag's verdict reads as, and that an unreadable verdict store leaves the
 * standing unsaid rather than showing a clean trial.
 */
describe("where the trial stands", () => {
	/** A timestamp `seconds` after the trial's start line. */
	function inTrial(seconds: number): string {
		return new Date(TRIAL_START_MS + seconds * 1000).toISOString();
	}

	/** A timestamp `seconds` after limb 2's own, later start line. */
	function afterFix(seconds: number): string {
		return new Date(OUTAGE_START_MS + seconds * 1000).toISOString();
	}

	function judge(messageHash: string, verdict: string) {
		markers();
		jevTrial.recordVerdict({ root: dir, messageHash, verdict });
	}

	it("reports both limbs at a session start that has something to show", () => {
		writeLog([flag(inTrial(10))]);

		const { out } = run("--notify");

		expect(out).toContain(`TRIAL — started ${jevTrial.TRIAL_START}`);
		expect(out).toContain("limb 1 (wrong flags): pending");
		expect(out).toContain("limb 2 (outages):     holding");
	});

	it("answers a hand run with the standing where there is nothing to report", () => {
		writeLog([{ at: inTrial(10), outcome: "clear", session: "s1" }]);

		const { out } = run();

		expect(out).toContain("no unreported Jev advisory flag");
		expect(out).toContain("TRIAL — started");
		expect(out).toContain("1 session(s) since");
	});

	it("stays silent at a session start with nothing to show", () => {
		writeLog([{ at: inTrial(10), outcome: "skipped-no-sdk" }]);

		expect(run("--notify").out).toBe("");
	});

	it("quotes an unjudged flag's stored text with the command that judges it", () => {
		writeLog([
			flag(inTrial(10), {
				messageHash: "111111111111",
				messageText: "Two ways to take this.\n(A) one\n(B) two",
			}),
		]);

		const { out } = run("--notify");

		expect(out).toContain(
			"node scripts/jev-verdict.js 111111111111 right|wrong",
		);
		expect(out).toContain("| Two ways to take this.");
		expect(out).toContain("| (A) one");
		expect(out).toContain("| (B) two");
	});

	it("quotes nothing for a flag already judged", () => {
		writeLog([
			flag(inTrial(10), {
				messageHash: "111111111111",
				messageText: "Two ways to take this.",
			}),
		]);
		judge("111111111111", "right");

		expect(run("--notify").out).not.toContain("| Two ways to take this.");
	});

	it("names a flag that carries no text rather than passing over it", () => {
		writeLog([flag(inTrial(10), { messageHash: "111111111111" })]);

		expect(run("--notify").out).toContain(
			"(no text stored — logged before #285, so it cannot be judged now)",
		);
	});

	it("quotes nothing for an outage", () => {
		writeLog([{ at: inTrial(10), outcome: "outage", session: "s1" }]);

		const { out } = run("--notify");

		expect(out).toContain("OUTAGE");
		expect(out).not.toContain("jev-verdict.js");
	});

	it("says a flag's verdict beside it, and unjudged where there is none", () => {
		writeLog([
			flag(inTrial(10), { messageHash: "111111111111" }),
			flag(inTrial(20), { messageHash: "222222222222", session: "s2" }),
		]);
		judge("111111111111", "wrong");

		const { out } = run("--notify");

		expect(out).toContain("message 111111111111, p=0.91, wrong");
		expect(out).toContain("message 222222222222, p=0.91, unjudged");
	});

	it("names what answered beside the probability, where the line records it (#702)", () => {
		writeLog([
			flag(inTrial(10), {
				messageHash: "111111111111",
				model: "typesafe-ai/jev",
				provider: "typesafe-ai",
			}),
			flag(inTrial(20), { messageHash: "222222222222", session: "s2" }),
		]);

		const { out } = run("--notify");

		expect(out).toContain(
			"message 111111111111, p=0.91 typesafe-ai/jev via typesafe-ai, unjudged",
		);
		expect(out).toContain("message 222222222222, p=0.91, unjudged");
	});

	it("trips limb 1 once the wrong flags outrun one in ten", () => {
		const lines = Array.from({ length: 10 }, (_, i) =>
			flag(inTrial(10 + i), {
				session: `s${i}`,
				messageHash: `${i}`.repeat(12),
			}),
		);
		writeLog(lines);
		for (let i = 0; i < 8; i++) judge(`${i}`.repeat(12), "right");
		judge("8".repeat(12), "wrong");
		judge("9".repeat(12), "wrong");

		expect(run("--notify").out).toContain("limb 1 (wrong flags): tripped");
	});

	it("trips limb 2 once the outage-carrying sessions outrun one in ten", () => {
		writeLog([
			flag(afterFix(10)),
			{ at: afterFix(20), outcome: "outage", session: "s2" },
			{ at: afterFix(30), outcome: "outage", session: "s3" },
		]);

		expect(run("--notify").out).toContain("limb 2 (outages):     tripped");
	});

	it("excludes a turn logged before the start line from both limbs", () => {
		writeLog([
			flag("2026-09-19T10:00:00.000Z", { session: "old" }),
			{ at: "2026-09-19T10:05:00.000Z", outcome: "outage", session: "old" },
			flag(inTrial(10), { session: "new", messageHash: "aaaaaaaaaaaa" }),
		]);

		const { out } = run("--notify");

		expect(out).toContain("1 session(s) since");
		expect(out).toContain("of 1 flagged turn(s)");
		expect(out).toContain("0 of 1 session(s) since");
	});

	it("leaves the standing unsaid where the verdict store will not read", () => {
		writeLog([flag(inTrial(10))]);
		/* A directory where a file is expected: readVerdicts throws EISDIR. */
		fs.mkdirSync(path.join(markers(), ".jev-verdicts.jsonl"));

		const { out } = run("--notify");

		expect(out).toContain("JEV-FLAG (1)");
		expect(out).toContain("standing not computed");
		expect(out).not.toContain("limb 1");
	});
});
