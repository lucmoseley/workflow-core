// @vitest-environment node
/*
 * jev-verdict.js joins a right/wrong verdict to exactly one flagged Jev turn by
 * hash or unique prefix, and refuses anything it cannot join (#253).
 *
 * Driven through the CLI, over a fixture log on disk (#253), in a temp dir so
 * no case reads or appends to the live verdict store.
 *
 * The founder runs it as `npm run jev:verdict` to count the Jev advisory trial
 * (#175): loosen a case here and a typo lands as a lost verdict, or a verdict
 * joins the wrong flag, and the trial that decides whether the guard stays
 * counts wrong.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const require_ = createRequire(__filename);
const { logPath, previousLogPath } = require_("./lib/jev-log.js");
const jevTrial = require_("./lib/jev-trial.js");

/** The trial's and limb 2's start lines, and limb 2's voided stretch. */
const TRIAL_START_MS = Date.parse(jevTrial.TRIAL_START);
const OUTAGE_START_MS = Date.parse(jevTrial.OUTAGE_START);
const OUTAGE_VOID_FROM_MS = Date.parse(
	jevTrial.stand({ lines: [], verdicts: new Map() }).outageVoid.from,
);

/** #175's limb 1 is measured over the trial's first 20 sessions. */
const LIMB1_SESSIONS = 20;

const SCRIPT = path.join(__dirname, "jev-verdict.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-verdict-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

interface Line {
	at: string;
	session?: string;
	outcome: string;
	messageHash?: string;
}

function writeLog(lines: Line[], file = logPath(dir)) {
	fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

function flag(messageHash: string, at = "2026-09-20T10:00:00.000Z"): Line {
	return { at, session: "abcdef0123456789", outcome: "flagged", messageHash };
}

function run(...args: string[]) {
	const res = runInProcess(SCRIPT, args, {
		cwd: dir,
		env: { ...process.env, WFC_REPO_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
	});
	return { ...res, out: `${res.stdout}${res.stderr}` };
}

describe("recording a verdict", () => {
	it("joins it to the flagged turn by hash", () => {
		writeLog([flag("9cf2bbd42b4a")]);

		const { status, stdout } = run("9cf2bbd42b4a", "wrong");

		expect(status).toBe(0);
		expect(stdout).toContain("9cf2bbd42b4a: wrong");
		expect(jevTrial.readVerdicts(dir).get("9cf2bbd42b4a").verdict).toBe(
			"wrong",
		);
	});

	it("takes a unique prefix in place of the whole digest", () => {
		writeLog([flag("9cf2bbd42b4a")]);

		expect(run("9cf2bb", "right").status).toBe(0);
		expect(jevTrial.readVerdicts(dir).get("9cf2bbd42b4a").verdict).toBe(
			"right",
		);
	});

	it("keeps the note the founder gave", () => {
		writeLog([flag("9cf2bbd42b4a")]);

		run("9cf2bbd42b4a", "right", "it really was a choice");

		expect(jevTrial.readVerdicts(dir).get("9cf2bbd42b4a").note).toBe(
			"it really was a choice",
		);
	});

	it("names the verdict it replaces when one is corrected", () => {
		writeLog([flag("9cf2bbd42b4a")]);
		run("9cf2bbd42b4a", "right");

		const { stdout } = run("9cf2bbd42b4a", "wrong");

		expect(stdout).toContain("right → wrong");
		expect(jevTrial.readVerdicts(dir).get("9cf2bbd42b4a").verdict).toBe(
			"wrong",
		);
	});

	it("finds a flag that a rotation moved out of the live log", () => {
		writeLog([flag("aaaaaaaaaaaa")], previousLogPath(dir));
		writeLog([flag("bbbbbbbbbbbb")]);

		expect(run("aaaaaaaaaaaa", "right").status).toBe(0);
	});
});

describe("what it refuses", () => {
	it("refuses a hash no flagged turn carries", () => {
		writeLog([flag("9cf2bbd42b4a")]);

		const { status, out } = run("deadbeefcafe", "wrong");

		expect(status).toBe(1);
		expect(out).toContain("no flagged turn");
		expect(jevTrial.readVerdicts(dir).size).toBe(0);
	});

	it("refuses a prefix matching more than one flagged turn, giving the count and recording no verdict", () => {
		writeLog([flag("abcdef000001"), flag("abcdef000002")]);

		const { status, out } = run("abcdef", "wrong");

		expect(status).toBe(1);
		expect(out).toContain("matches 2 flagged turns");
		expect(jevTrial.readVerdicts(dir).size).toBe(0);
	});

	it("refuses a prefix too short to identify a turn", () => {
		writeLog([flag("9cf2bbd42b4a")]);

		const { status, out } = run("9cf2", "wrong");

		expect(status).toBe(2);
		expect(out).toContain("at least 6 characters");
	});

	it("refuses a verdict outside right and wrong", () => {
		writeLog([flag("9cf2bbd42b4a")]);

		const { status, out } = run("9cf2bbd42b4a", "unsure");

		expect(status).toBe(2);
		expect(out).toContain("right, wrong");
	});

	it("refuses to judge a turn that was never flagged", () => {
		writeLog([
			{
				at: "2026-09-20T10:00:00.000Z",
				outcome: "clear",
				messageHash: "c1c1c1c1c1c1",
			},
		]);

		expect(run("c1c1c1c1c1c1", "right").status).toBe(1);
	});
});

describe("--list", () => {
	/* The era is decided per SESSION, by its first logged line, because that is
	 * how `stand()` counts — a session straddling the start line must not read
	 * one way here and the other way in the standing. */
	it("marks a session that straddles the start line as pre-trial throughout, on limb 1", () => {
		const earlier = new Date(TRIAL_START_MS - 60_000).toISOString();
		const later = new Date(TRIAL_START_MS + 60_000).toISOString();
		writeLog([flag("aaaaaaaaaaaa", earlier), flag("bbbbbbbbbbbb", later)]);

		const { stdout } = run("--list");

		expect(stdout).not.toContain("limb1 trial");
	});

	it("says so where no flag has ever been raised", () => {
		expect(run("--list").stdout).toContain("no flagged turn on record");
	});

	it("marks each flag trial or pre-trial on limb 1, and says what it was judged", () => {
		const inTrial = new Date(TRIAL_START_MS + 60_000).toISOString();
		const earlier = new Date(TRIAL_START_MS - 60_000).toISOString();
		writeLog([
			{ ...flag("aaaaaaaaaaaa", earlier), session: "older" },
			{ ...flag("bbbbbbbbbbbb", inTrial), session: "newer" },
		]);
		run("bbbbbbbbbbbb", "wrong");

		const { stdout } = run("--list");

		expect(stdout).toContain("aaaaaaaaaaaa");
		expect(stdout).toContain("unjudged  (limb1 pre-trial,");
		expect(stdout).toContain("wrong  (limb1 trial,");
	});

	// #288
	it("marks a turn between OUTAGE_START and TRIAL_START as limb 2 evidence", () => {
		const between = new Date(OUTAGE_START_MS + 60_000).toISOString();
		writeLog([{ ...flag("cccccccccccc", between), session: "straddler" }]);

		const { stdout } = run("--list");

		expect(stdout).toContain("(limb1 pre-trial, limb2 trial)");
	});

	it("marks a turn before OUTAGE_START as pre-trial on both limbs", () => {
		const before = new Date(OUTAGE_START_MS - 60_000).toISOString();
		writeLog([{ ...flag("dddddddddddd", before), session: "earliest" }]);

		const { stdout } = run("--list");

		expect(stdout).toContain("(limb1 pre-trial, limb2 pre-trial)");
	});

	// #670
	it("marks a turn inside limb 2's billing-wall void as void on limb 2", () => {
		const at = new Date(OUTAGE_VOID_FROM_MS + 60_000).toISOString();
		writeLog([{ ...flag("eeeeeeeeeeee", at), session: "walled" }]);

		const { stdout } = run("--list");

		expect(stdout).toContain("limb2 void)");
	});

	it("marks a trial session past limb 1's first-20 window as closed, not trial", () => {
		const lines = [];
		for (let i = 0; i < LIMB1_SESSIONS; i++) {
			const at = new Date(TRIAL_START_MS + (i + 1) * 60_000).toISOString();
			lines.push({ ...flag(`${i}`.padStart(12, "0"), at), session: `s${i}` });
		}
		const pastWindow = new Date(
			TRIAL_START_MS + (LIMB1_SESSIONS + 1) * 60_000,
		).toISOString();
		lines.push({
			...flag("eeeeeeeeeeee", pastWindow),
			session: "s-past-window",
		});
		writeLog(lines);

		const { stdout } = run("--list");

		expect(stdout).toContain("eeeeeeeeeeee");
		expect(stdout).toContain("(limb1 closed, limb2 trial)");
	});
});
