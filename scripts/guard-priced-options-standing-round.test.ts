// @vitest-environment node
/*
 * The no-round limb's pointer (#924): a background job's `needs input:` that
 * names a round still standing in the transcript closes without re-printing
 * it. Every case runs the Stop hook in process, as a background job unless it
 * says otherwise, so each also proves `judge` hands the limb the transcript.
 *
 * The missing-marker refusal's two shapes (#1018) are fed back from its live
 * text, so a reworded refusal that no longer passes fails here.
 *
 * The testkit redirects `CLAUDE_CONFIG_DIR` into the temp directory, so the
 * fail-open log lands there, not in this repo's arbiter state.
 *
 * The guard runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): break the pointer and a job must re-print a round the
 * founder already has, or closes pointing at one that is not there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSlug } from "./lib/project-slug.js";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import {
	failOpenLog,
	researchCalls,
	transcriptRecords,
	writeTranscript,
} from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");

const { reset, assistant, founder, notification, toolResult, stopFeedback } =
	transcriptRecords("2026-10-08T10:00:00Z");

let dir: string;
let file: string;
let config: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "standing-round-"));
	file = path.join(dir, "transcript.jsonl");
	config = path.join(dir, "config");
	reset();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (...lines: string[]) => writeTranscript(file, ...lines);

const sid = () => `standing-round-${Math.random().toString(36).slice(2)}`;
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

const ROUND =
	"❓ **Q1** — Which schedule?\n\nRelation: rivals\n\n" +
	"(A) Daily.\nConfidence: 70% (60% - 80%). Cheap.\n\n" +
	"(B) Weekly.\nConfidence: 30% (20% - 40%). Slower.\n\n➡ (A).\n\n" +
	"needs input: which schedule";
const POINTER = "Nothing new.\n\nneeds input: Q1 above — which schedule";
const REFUSED = "with no `❓ **Qn**` round above it";

describe("a round-less `needs input:` pointing at a standing round (#924)", () => {
	it("passes when only notifications, tool results and hook feedback follow the round", () => {
		write(
			founder("go"),
			assistant(ROUND),
			notification(),
			toolResult(),
			stopFeedback(),
			assistant(POINTER),
		);
		expect(stop(POINTER)).toBe("");
	});

	it("is refused once the founder has replied after the round", () => {
		write(assistant(ROUND), founder("A"), notification(), assistant(POINTER));
		expect(stop(POINTER)).toContain(REFUSED);
	});

	it("passes again once a new round follows the founder's reply", () => {
		write(assistant(ROUND), founder("A"), assistant(ROUND), notification());
		expect(stop(POINTER)).toBe("");
	});

	it("is refused where a Stop hook sent the round's turn back", () => {
		write(assistant(ROUND), stopFeedback(), notification());
		expect(stop(POINTER)).toContain(REFUSED);
	});

	it("drops the refused turn's round even where tool calls ran after it", () => {
		write(assistant(ROUND), toolResult(), stopFeedback(), notification());
		expect(stop(POINTER)).toContain(REFUSED);
	});

	it("counts a round printed earlier in the turn the pointer ends", () => {
		write(founder("go"), assistant(ROUND), toolResult());
		expect(stop(POINTER)).toBe("");
	});

	it("passes once the refused round is re-sent in a turn that ends", () => {
		write(assistant(ROUND), stopFeedback(), assistant(ROUND), notification());
		expect(stop(POINTER)).toBe("");
	});

	it("keeps a round whose turn ended before a later turn was sent back", () => {
		write(
			assistant(ROUND),
			notification(),
			assistant("Still nothing."),
			stopFeedback(),
		);
		expect(stop(POINTER)).toBe("");
	});

	it("is refused with no earlier round in the transcript", () => {
		write(founder("go"), assistant("Working on it."), notification());
		expect(stop(POINTER)).toContain(REFUSED);
	});

	it("is refused where the pointer names no `Q<n>`, even with a round standing", () => {
		write(assistant(ROUND), notification());
		const text =
			"Nothing new.\n\nneeds input: the round above — which schedule";
		expect(stop(text)).toContain(REFUSED);
	});

	it("is refused where it names a round that is not standing", () => {
		write(assistant(ROUND), notification());
		const text = "Nothing new.\n\nneeds input: Q1 and Q2 above";
		expect(stop(text)).toContain(REFUSED);
	});

	it("reads only the governing marker's line for the number", () => {
		write(assistant(ROUND), notification());
		const text = "Q1 still stands.\n\nneeds input: which schedule";
		expect(stop(text)).toContain(REFUSED);
	});

	it("is refused where the round lives only in a subagent's sidechain", () => {
		const side = JSON.parse(assistant(ROUND));
		side.isSidechain = true;
		write(founder("go"), JSON.stringify(side), notification());
		expect(stop(POINTER)).toContain(REFUSED);
	});

	it("names the pointer as the escape in its refusal", () => {
		write(founder("go"));
		expect(stop(POINTER)).toContain(
			"`needs input: Q1 above — <the decision> — waits on you: #N` (#924)",
		);
	});
});

describe("its fail mode", () => {
	it("refuses on an unreadable transcript, and logs it", () => {
		expect(stop(POINTER, { transcript: path.join(dir, "gone") })).toContain(
			REFUSED,
		);
		expect(failOpenLog(config)).toContain(
			"guard-priced-options standing-round",
		);
		expect(failOpenLog(config)).toContain("would not be read");
	});

	it("refuses on a transcript that parsed to no records, and logs it", () => {
		write("");
		expect(stop(POINTER)).toContain(REFUSED);
		expect(failOpenLog(config)).toContain("parsed to no records");
	});

	it("reads the conventional transcript where the payload names none", () => {
		/* The harness's own path for this session under the redirected config
		 * directory, keyed on the cwd the hook runs in. */
		const id = sid();
		const slug = projectSlug(fs.realpathSync(dir));
		const conventional = path.join(config, "projects", slug, `${id}.jsonl`);
		expect(stop(POINTER, { id, transcript: null })).toContain(REFUSED);
		fs.mkdirSync(path.dirname(conventional), { recursive: true });
		writeTranscript(
			conventional,
			founder("go"),
			assistant(ROUND),
			notification(),
		);
		expect(stop(POINTER, { id, transcript: null })).toBe("");
	});
});

describe("outside a background job", () => {
	it("says nothing, standing round or not", () => {
		write(founder("go"));
		expect(stop(POINTER, { job: false })).toBe("");
		write(assistant(ROUND), notification());
		expect(stop(POINTER, { job: false })).toBe("");
	});
});

describe("the missing-marker refusal teaches both passing shapes (#1018)", () => {
	const bare = ROUND.replace("\n\nneeds input: which schedule", "");
	const refusal = () => {
		write(founder("go"), assistant(bare));
		return stop(bare);
	};

	it("names the marker below the round in one message, and the pointer", () => {
		const reason = refusal();
		expect(reason).toContain(
			"re-send every round in one message with the marker below them",
		);
		expect(reason).toContain(
			"`needs input: Q1 above — <the decision> — waits on you: #N` (#924)",
		);
	});

	it("passes a reply built from its first shape", () => {
		const template =
			refusal().match(/(<every round, in full>\n\nneeds input: [^\n]+)/)?.[1] ??
			"";
		expect(template).not.toBe("");
		const reply = template
			.replace("<every round, in full>", bare)
			.replace(/<[^>]+>/, "which schedule");
		write(
			founder("go"),
			/* so the under-researched-round limb (#1710) passes the round */
			...researchCalls().map((call) => JSON.stringify(call)),
			assistant(bare),
			stopFeedback(),
			assistant(reply),
		);
		expect(stop(reply)).toBe("");
	});

	it("passes a reply built from its pointer, where an earlier turn's round stands", () => {
		const pointer =
			refusal().match(/`(needs input: Q1 above — [^`]+)`/)?.[1] ?? "";
		expect(pointer).not.toBe("");
		const reply = `Nothing new.\n\n${pointer.replace(/<[^>]+>/, "which schedule")}`;
		write(
			founder("go"),
			assistant(ROUND),
			notification(),
			assistant(bare),
			stopFeedback(),
			assistant(reply),
		);
		expect(stop(reply)).toBe("");
	});
});
