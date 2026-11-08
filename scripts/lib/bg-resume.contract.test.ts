// @vitest-environment node
/*
 * Holds lib/bg-resume.js's parse of the launcher's `--bg --resume` response
 * (#2968) to one case list, run against the installed harness's recorded
 * responses (scripts/fixtures/bg-resume.json, re-recorded by
 * `node scripts/record-claude-responses.js`) and against lib/bg-resume-fake.ts,
 * which the refill-loop-run suites' `claude` stub prints. Breaking it costs the
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
	{ kind: "continued", copy: false },
	{ kind: "ownId", copy: false },
];

/** What parseResumed reads off response `r`: a copy keeps its note's line. */
const expected = (r: { stderr: string; startedAs: string }, copy: boolean) =>
	copy
		? { jobId: r.startedAs, copy, why: r.stderr.trim() }
		: { jobId: r.startedAs, copy };

describe.each(cases)("the $kind response", ({ kind, copy }) => {
	it(`reads ${recorded.harness}'s recorded response`, () => {
		const r = recorded.responses[kind];
		expect(parseResumed(r)).toEqual(expected(r, copy));
	});

	it("reads the fake of it", () => {
		const r = buildRekeyedResponse(kind, "job7", FAKE_COPY);
		expect(parseResumed(r)).toEqual(expected(r, copy));
	});
});

/* The binary's other copy notes, which no recorder run reaches. */
it.each([
	"note: a restricted shell does not wake background session job7 in place, so this started a restricted copy as c0de7a11.",
	"note: started a copy of that conversation as c0de7a11. To continue a session under its own id, pass its full session id (lowercase, as `claude agents --json` prints it) to --resume.",
	"note: background session job7 keeps its own saved options, so the flags you passed started a copy as c0de7a11. Without flags, the same command continues job7 itself.",
	"note: could not check whether session job7 is running, so this started a copy as c0de7a11.",
])("reads the 2.1.319 binary's copy note %#", (stderr) => {
	expect(parseResumed({ stdout: "", stderr })).toEqual({
		jobId: "c0de7a11",
		copy: true,
		why: stderr,
	});
});

it("reads a response naming no job as null", () => {
	expect(parseResumed({ stdout: "something else", stderr: "" })).toBeNull();
});
