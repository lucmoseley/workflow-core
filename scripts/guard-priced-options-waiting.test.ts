// @vitest-environment node
/*
 * The twelfth refusal (mantahostels#2487): a background job ending on `waiting:` with
 * nothing running to wake it. Driven through the Stop hook in process, as a
 * background job unless a case says otherwise, with the transcript named on
 * the payload the way the harness names it.
 *
 * The testkit redirects `CLAUDE_CONFIG_DIR` in every case, so the fail-open log
 * the apparatus paths write lands in the temp directory and not in this repo's
 * own arbiter state.
 *
 * The guard runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a case and a background job parks on `waiting:`
 * that nothing will ever wake; widen it and a job with work genuinely running
 * is refused.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSlug } from "./lib/project-slug.js";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import {
	buildBashCall,
	failOpenLog,
	writeTranscript,
} from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");

let dir: string;
let file: string;
let config: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "waiting-limb-"));
	file = path.join(dir, "transcript.jsonl");
	config = path.join(dir, "config");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const launch = (id: string) =>
	JSON.stringify(
		buildBashCall("sleep 30", id, { input: { run_in_background: true } }),
	);

const settlement = (id: string) =>
	JSON.stringify({
		type: "queue-operation",
		operation: "enqueue",
		content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
	});

const write = (...lines: string[]) => writeTranscript(file, ...lines);

const sid = () => `waiting-${Math.random().toString(36).slice(2)}`;
/** The guard's refusal of `message` as a turn's last, or "" where it allows. */
const stop = (
	message: string,
	{
		job = true,
		transcript = file,
		id = sid(),
	}: { job?: boolean; transcript?: string | null; id?: string } = {},
) =>
	readStopGuardReason(GUARD, {
		dir,
		sid: id,
		message,
		job,
		payload: { transcript_path: transcript ?? undefined },
	});

const WAITING = "Dispatched the review.\n\nwaiting: the review subagent.";

describe("a background job ending on `waiting:`", () => {
	it("refuses a waiting: whose every launch has already settled, counting the launches and pointing back to the work in the same turn", () => {
		write(launch("t1"), settlement("t1"));
		const reason = stop(WAITING);
		expect(reason).toContain("nothing this session launched is still running");
		expect(reason).toContain("1 launch(es)");
		/* mantahostels#3432: the settled-launch case is the finished `gh` call, and the way
		 * out there is to keep working, not to pick another marker. */
		expect(reason).toContain("has already reported");
		expect(reason).toContain("no `waiting:` hand-off is owed");
		expect(reason).toContain("carry on with the work in this same turn");
	});

	it("refuses a waiting: from a session that launched nothing at all", () => {
		write(JSON.stringify({ type: "user", message: { content: "go" } }));
		const reason = stop(WAITING);
		expect(reason).toContain("waiting:");
		expect(reason).not.toContain("already reported");
	});

	it("allows a waiting: while a launch is still out", () => {
		write(launch("t1"));
		expect(stop(WAITING)).toBe("");
	});

	it("allows a waiting: on a foreground call moved to the background at its timeout (#1012)", () => {
		write(
			JSON.stringify(buildBashCall("npm run test")),
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content:
								"Command did not complete within its 600s timeout and was moved to the background (ID: b1).",
						},
					],
				},
			}),
		);
		expect(stop(WAITING)).toBe("");
	});

	it("allows a waiting: while one of two launches is still out", () => {
		write(launch("t1"), launch("t2"), settlement("t1"));
		expect(stop(WAITING)).toBe("");
	});

	it("says nothing outside a background job", () => {
		write(launch("t1"), settlement("t1"));
		expect(stop(WAITING, { job: false })).toBe("");
	});

	it("reads the conventional transcript where the payload names none", () => {
		/* The harness's own path for this session under the redirected config
		 * directory, keyed on the cwd the hook runs in. */
		const id = sid();
		const slug = projectSlug(fs.realpathSync(dir));
		const conventional = path.join(config, "projects", slug, `${id}.jsonl`);
		fs.mkdirSync(path.dirname(conventional), { recursive: true });
		writeTranscript(conventional, launch("t1"), settlement("t1"));
		expect(stop(WAITING, { id, transcript: null })).toContain("still running");
	});

	it("fails open where the payload names none and the conventional one is absent", () => {
		expect(stop(WAITING, { transcript: null })).toBe("");
		expect(failOpenLog(config)).toContain("would not be read");
	});

	it("fails open on an unreadable transcript, and reports it", () => {
		expect(stop(WAITING, { transcript: path.join(dir, "gone") })).toBe("");
		expect(failOpenLog(config)).toContain("guard-priced-options waiting");
		expect(failOpenLog(config)).toContain("would not be read");
	});

	it("fails open on a transcript that parsed to no records, and reports it", () => {
		write("");
		expect(stop(WAITING)).toBe("");
		expect(failOpenLog(config)).toContain("parsed to no records");
	});

	it("writes nothing to that log when it reaches a verdict", () => {
		write(launch("t1"), settlement("t1"));
		expect(stop(WAITING)).toContain("still running");
		expect(failOpenLog(config)).not.toContain("guard-priced-options waiting");
	});

	it("judges only the marker latest in the message", () => {
		write(launch("t1"), settlement("t1"));
		const done = `${WAITING}\n\nresult: the review came back clean.`;
		expect(stop(done)).toBe("");
	});

	it("reads a quoted waiting: above the real marker as the earlier one", () => {
		write(launch("t1"), settlement("t1"));
		const quoted = "The block said `waiting: x`.\n\nwaiting: the suite.";
		expect(stop(quoted)).toContain("still running");
	});

	it("ignores a message carrying no status marker at all", () => {
		write(launch("t1"), settlement("t1"));
		expect(stop("Done, nothing more.")).not.toContain("still running");
	});
});

/* `judge` resolves the transcript off the payload. */
describe("the Stop hook end to end", () => {
	it("blocks a waiting: turn whose transcript shows nothing pending", () => {
		write(launch("t1"), settlement("t1"));
		const reason = stop(WAITING);
		expect(reason).toContain("nothing this session launched is still running");
		/* The way out, not just the offence (§X3). */
		expect(reason).toContain("carry on with the work in this same turn");
		expect(reason).toContain("result:");
		expect(reason).toContain("needs input:");
		expect(reason).toContain("relaunch the work through the background route");
	});

	it("allows the same turn while that launch is still out", () => {
		write(launch("t1"));
		expect(stop(WAITING)).not.toContain("still running");
	});

	it("reads the transcript the payload names, not the conventional one", () => {
		/* The payload's `transcript_path` is the only route to this file: no
		 * transcript exists under the redirected config directory for this session id, so a
		 * guard falling back to the conventional path would find nothing and
		 * allow the stop. */
		write(launch("t1"), settlement("t1"));
		expect(fs.existsSync(path.join(config, "projects"))).toBe(false);
		expect(stop(WAITING)).toContain("still running");
	});
});
