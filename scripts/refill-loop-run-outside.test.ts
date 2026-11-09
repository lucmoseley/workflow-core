// @vitest-environment node
/*
 * The refill loop's `run` driven end to end over one background session the
 * founder started, which no launch knows (#4815, lib/refill-outside.js): its
 * turn drops on a connection error, the loop waits while the API host is
 * unreachable, types the resume once it is back, and counts it arrived off the
 * job's timeline. Its sandbox is lib/refill-loop-run-testkit.ts's; the
 * network probe is the testkit's stand-in, taken down by setOffline.
 *
 * The testkit's `claude` stub types through lib/claude-attach-fake.ts, which
 * answers from "scripts/fixtures/claude-attach.json": a re-recording selects
 * this file.
 *
 * Loosen it and the wiring the unit tests stub (the registry read, the probe
 * child, the attach, the outside file) can break unseen (#2851).
 */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { buildJobRow } from "./lib/agents-stop-fake";
import { readProcStartOf } from "./lib/arbiter-proc.js";
import { API_PROMPT } from "./lib/loop-prompts.js";
import {
	at,
	buildBlockedJobRecord,
	fakeResumeClaude,
	LISTED,
	oneTick,
	readLines,
	refillSandbox,
	repo,
	seat,
	setOffline,
} from "./lib/refill-loop-run-testkit";

refillSandbox();

const Job = "job7";
const jobDir = () => path.join(seat, "jobs", Job);
const outside = () =>
	JSON.parse(fs.readFileSync(at(".refill-outside.json"), "utf8"));

/** The founder's session: live in the seat's registry as a background job,
 * its job record blocked and its transcript ending on a connection error. */
function seedFounderSession() {
	const transcript = at("transcript.jsonl");
	fs.writeFileSync(
		transcript,
		`${JSON.stringify({
			type: "assistant",
			isApiErrorMessage: true,
			message: {
				content: [
					{
						type: "text",
						text: "API Error: Unable to connect to API (ConnectionRefused)",
					},
				],
			},
		})}\n`,
	);
	fs.mkdirSync(jobDir(), { recursive: true });
	fs.writeFileSync(
		path.join(jobDir(), "state.json"),
		buildBlockedJobRecord(
			"API Error: Unable to connect to API (ConnectionRefused)",
			transcript,
		),
	);
	fs.mkdirSync(path.join(seat, "sessions"), { recursive: true });
	fs.writeFileSync(
		path.join(seat, "sessions", `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			procStart: readProcStartOf(process.pid),
			sessionId: "s-job7",
			jobId: Job,
			kind: "bg",
			name: "founder-session",
			cwd: repo,
			startedAt: 1,
		}),
	);
}

it("takes a founder-started session through a drop, an offline wait, a typed resume and its arrival", async () => {
	seedFounderSession();
	fakeResumeClaude(Job, [LISTED, buildJobRow(Job, "blocked")]);
	const name = `founder-session (${Job}, started outside the loop)`;

	setOffline(true);
	const off = await oneTick("offline tick");
	expect(off.status).toBe(0);
	expect(readLines(at("calls"))).toEqual([]);
	expect(off.stdout).toContain(
		`the API host is unreachable (api.anthropic.com did not resolve: EAI_AGAIN), so these due resumes wait for the next tick, no try spent: ${name}`,
	);
	expect(outside()).toMatchObject([{ jobId: Job, tries: 0 }]);

	setOffline(false);
	expect((await oneTick("online tick")).status).toBe(0);
	expect(readLines(at("calls"))).toEqual([
		`attach ${Job}`,
		`typed ${API_PROMPT}`,
	]);
	const [typed] = outside();
	expect(typed).toMatchObject({ tries: 1, attachAt: expect.any(Number) });

	/* Past the verdict window, with the typed line on the job's timeline. */
	const attachAt = Date.now() - 2 * 60 * 1000;
	fs.writeFileSync(
		at(".refill-outside.json"),
		JSON.stringify([{ ...typed, attachAt }]),
	);
	fs.writeFileSync(
		path.join(jobDir(), "timeline.jsonl"),
		`${JSON.stringify({ at: new Date(attachAt + 1000).toISOString(), detail: API_PROMPT })}\n`,
	);
	expect((await oneTick("arrival tick")).status).toBe(0);
	expect(readLines(at("calls"))).toEqual([
		`attach ${Job}`,
		`typed ${API_PROMPT}`,
	]);
	const [arrived] = outside();
	expect(arrived).toMatchObject({ tries: 1 });
	expect(arrived).not.toHaveProperty("attachAt");
});
