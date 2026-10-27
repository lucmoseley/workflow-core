// @vitest-environment node
/*
 * Holds lib/bg-resume.js's parse of the launcher's `--bg --resume` response
 * (#2968) to one case list, run against the installed harness's recorded
 * responses (scripts/fixtures/bg-resume.json, re-recorded by
 * `node scripts/record-claude-responses.js`) and against lib/bg-resume-fake.ts,
 * which refill-loop-run.test.ts's `claude` stub prints. Breaking it costs the
 * refill loop's resume: a response the parse misreads counts a working
 * resume failed.
 */
import { describe, expect, it } from "vitest";
import { parseResumed } from "./bg-resume.js";
import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
	recorded,
} from "./bg-resume-fake";

const cases: { kind: ResumeKind; copy: boolean }[] = [
	{ kind: "copy", copy: true },
	{ kind: "woke", copy: false },
];

describe.each(cases)("the $kind response", ({ kind, copy }) => {
	it(`reads ${recorded.harness}'s recorded response`, () => {
		const r = recorded.responses[kind];
		expect(parseResumed(r)).toEqual({ jobId: r.startedAs, copy });
	});

	it("reads the fake of it", () => {
		const r = buildRekeyedResponse(kind, "job7", FAKE_COPY);
		expect(parseResumed(r)).toEqual({ jobId: r.startedAs, copy });
	});
});

/* The binary's other copy notes, which no recorder run reaches. */
it.each([
	"note: a restricted shell does not wake background session job7 in place, so this started a restricted copy as c0de7a11.",
	"note: started a copy of that conversation as c0de7a11. To continue a session under its own id, pass its full session id (lowercase, as `claude agents --json` prints it) to --resume.",
])("reads the 2.1.310 binary's copy note %#", (stderr) => {
	expect(parseResumed({ stdout: "", stderr })).toEqual({
		jobId: "c0de7a11",
		copy: true,
	});
});

it("reads a response naming no job as null", () => {
	expect(
		parseResumed({ stdout: "backgrounded · job7", stderr: "" }),
	).toBeNull();
});
