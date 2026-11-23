// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import { buildBashCall, writeTranscript } from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");

let dir: string;
let file: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "waiting-limb-"));
	file = path.join(dir, "transcript.jsonl");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const launchOut = () =>
	writeTranscript(
		file,
		JSON.stringify(
			buildBashCall("sleep 30", "t1", { input: { run_in_background: true } }),
		),
	);

const sid = () => `waiting-${Math.random().toString(36).slice(2)}`;
const stop = (message: string, { job = true }: { job?: boolean } = {}) =>
	readStopGuardReason(GUARD, {
		dir,
		sid: sid(),
		message,
		job,
		payload: { transcript_path: file },
	});

const WAITING = "Dispatched the review.\n\nwaiting: the review subagent.";

describe("a background job ending on `waiting:`", () => {
	it("is refused while a launch is still out, the refusal naming the backgrounded and foreground waits", () => {
		launchOut();
		const reason = stop(WAITING);
		expect(reason).toContain("This turn ends a background job on `waiting:`");
		expect(reason).toContain("lists\na job whose turn has ended as completed");
		expect(reason).toContain("timeout 540 node scripts/watch-artefact.js");
		expect(reason).toContain(
			"run each wait with `run_in_background` (its exit re-invokes\nyou) and keep working",
		);
		expect(reason).toContain("scripts/bg-run.sh wait <name> 540");
		expect(reason).toContain(
			"queued commits: no wait; end on `result:`, naming them queued",
		);
		expect(reason).not.toContain("landing-status.js --wait");
		expect(reason).toContain("`timeout: 600000`");
		expect(reason).toContain("result:");
		expect(reason).toContain("needs input:");
	});

	it("is refused with nothing launched at all", () => {
		writeTranscript(
			file,
			JSON.stringify({ type: "user", message: { content: "go" } }),
		);
		expect(stop(WAITING)).toContain("background job on `waiting:`");
	});

	it("judges only the marker latest in the message", () => {
		launchOut();
		expect(stop(`${WAITING}\n\nresult: the review came back clean.`)).toBe("");
	});

	it("reads a quoted waiting: above a real one as the earlier", () => {
		launchOut();
		const quoted = "The block said `waiting: x`.\n\nwaiting: the suite.";
		expect(stop(quoted)).toContain("background job on `waiting:`");
	});
});

describe("an interactive session ending on `waiting:`", () => {
	it("passes, as the one-line hand-off", () => {
		launchOut();
		expect(stop(WAITING, { job: false })).toBe("");
	});
});
