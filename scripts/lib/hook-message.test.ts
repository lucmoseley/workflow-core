// @vitest-environment node
/*
 * The guards' own suites drive this end-to-end through their CLIs. What is
 * unreachable from there is exercised here: the transcript path the seam falls
 * back to when the payload names none, and which of its four silent returns a
 * given payload takes (mantahostels#872).
 *
 * The `Stop` guards in .claude/settings.json — guard-priced-options.js and
 * guard-uncommitted-work.js among them — read the outgoing message through
 * this seam, so a loosened case can hand them an empty string, and they pass
 * every turn silently, or misrecord which failure a blind guard took.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { breadcrumbs } from "./breadcrumb-testkit";

const { messageFrom, textOf, transcriptPath } = require("./hook-message.js");
const hookRecord = require("./hook-record.js");
const { projectSlug } = require("./project-slug.js");

let root: string;
const SID = "a-session-id";
const GUARD = "test-guard";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-message-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** A transcript whose outgoing message is `text`, preceded by a user turn. */
function transcriptWith(text: string, extra: object[] = []): string {
	const file = path.join(root, `${SID}.jsonl`);
	const records = [
		{ type: "user", message: { content: "the founder's question" } },
		...extra,
		{ type: "assistant", message: { content: [{ type: "text", text }] } },
	];
	fs.writeFileSync(
		file,
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	return file;
}

/**
 * The breadcrumb is pointed at the throwaway root, not the real repo. A `null`
 * input is a payload that would not parse.
 */
const from = (input: object | null) =>
	messageFrom(input, { root, guard: GUARD });

/**
 * The last line the breadcrumb recorded for this session; a `null` session
 * reads the record kept for payloads naming none.
 */
const recorded = (sessionId: string | null = SID) => {
	const all = breadcrumbs(root, GUARD, sessionId);
	return all.length > 0 ? all.at(-1) : null;
};

const outcome = (sessionId: string | null = SID) =>
	recorded(sessionId)?.outcome ?? null;

describe("the transcript a payload naming none falls back to", () => {
	const saved = {
		config: process.env.CLAUDE_CONFIG_DIR,
		home: process.env.HOME,
	};

	afterEach(() => {
		if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = saved.config;
		process.env.HOME = saved.home;
	});

	/* From the shared function, not restated: this helper spelled the SLASHES
	 * ALONE until mantahostels#1982 and so agreed with the bug it was meant to catch. The
	 * dotted-cwd regression lives in `project-slug.test.ts`. */
	const slug = () => projectSlug();

	it("reads the root from CLAUDE_CONFIG_DIR when the harness sets one", () => {
		process.env.CLAUDE_CONFIG_DIR = "/home/someone/.claude2";
		process.env.HOME = "/home/someone";
		expect(transcriptPath(null, SID)).toBe(
			path.join("/home/someone/.claude2", "projects", slug(), `${SID}.jsonl`),
		);
	});

	it("falls back to $HOME/.claude when it does not", () => {
		delete process.env.CLAUDE_CONFIG_DIR;
		process.env.HOME = "/home/someone";
		expect(transcriptPath(null, SID)).toBe(
			path.join("/home/someone/.claude", "projects", slug(), `${SID}.jsonl`),
		);
	});

	it("reads an empty CLAUDE_CONFIG_DIR as set, cwd-relative as Claude Code does (#2095)", () => {
		process.env.CLAUDE_CONFIG_DIR = "";
		process.env.HOME = "/home/someone";
		expect(transcriptPath(null, SID)).toBe(
			path.join("projects", slug(), `${SID}.jsonl`),
		);
	});
});

describe("transcriptPath (mantahostels#2487)", () => {
	const saved = {
		config: process.env.CLAUDE_CONFIG_DIR,
		home: process.env.HOME,
	};

	afterEach(() => {
		if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = saved.config;
		process.env.HOME = saved.home;
	});

	it("takes the payload's path when the file is there", () => {
		const file = path.join(root, "given.jsonl");
		fs.writeFileSync(file, "");
		expect(transcriptPath({ transcript_path: file }, SID)).toBe(file);
	});

	it("falls back when the payload names a path that is not there", () => {
		process.env.CLAUDE_CONFIG_DIR = "/home/someone/.claude2";
		const gone = path.join(root, "no-such-file.jsonl");
		expect(transcriptPath({ transcript_path: gone }, SID)).toBe(
			transcriptPath({}, SID),
		);
	});

	it("falls back on a payload naming no path, and on no payload at all", () => {
		process.env.CLAUDE_CONFIG_DIR = "/home/someone/.claude2";
		const want = path.join(
			"/home/someone/.claude2",
			"projects",
			projectSlug(),
			`${SID}.jsonl`,
		);
		expect(transcriptPath({}, SID)).toBe(want);
		expect(transcriptPath(null, SID)).toBe(want);
	});
});

describe("the outgoing text comes off the payload (mantahostels#1273)", () => {
	it("returns `last_assistant_message` without opening the transcript", () => {
		const found = from({
			session_id: SID,
			last_assistant_message: "the payload's text",
			// A transcript that says something else: reaching it would show.
			transcript_path: transcriptWith("the transcript's text"),
		});
		expect(found).toEqual({ sessionId: SID, message: "the payload's text" });
		expect(recorded()).toMatchObject({
			outcome: "message",
			source: "payload",
			payloadLen: "the payload's text".length,
			transcriptLen: null,
		});
	});

	it("needs no transcript at all when the field is there", () => {
		process.env.CLAUDE_CONFIG_DIR = path.join(root, "no-such-config");
		try {
			expect(from({ session_id: SID, last_assistant_message: "text" })).toEqual(
				{ sessionId: SID, message: "text" },
			);
		} finally {
			delete process.env.CLAUDE_CONFIG_DIR;
		}
		expect(outcome()).toBe("message");
	});

	it.each([
		["absent", undefined],
		["empty", ""],
		["whitespace-only", "   \n"],
		["not a string", 42],
	])("falls back to the transcript when the field is %s", (_label, value) => {
		const input: Record<string, unknown> = {
			session_id: SID,
			transcript_path: transcriptWith("the transcript's text"),
		};
		if (value !== undefined) input.last_assistant_message = value;
		expect(from(input)).toEqual({
			sessionId: SID,
			message: "the transcript's text",
		});
		expect(recorded()).toMatchObject({
			outcome: "message",
			source: "transcript",
			transcriptLen: "the transcript's text".length,
		});
	});

	it("records `empty-message` only when both routes came back empty", () => {
		const file = path.join(root, `${SID}.jsonl`);
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "user", message: { content: "ask" } })}\n`,
		);
		expect(
			from({
				session_id: SID,
				last_assistant_message: "",
				transcript_path: file,
			}),
		).toBe(null);
		expect(recorded()).toMatchObject({
			outcome: "empty-message",
			source: null,
			payloadLen: 0,
			transcriptLen: 0,
		});
	});

	it("records stop_hook_active off the payload", () => {
		from({
			session_id: SID,
			last_assistant_message: "text",
			stop_hook_active: true,
		});
		expect(recorded()?.stopHookActive).toBe(true);
	});
});

describe("messageFrom names which failure it took", () => {
	it("records `message` and returns the text on the happy path", () => {
		const found = from({
			session_id: SID,
			transcript_path: transcriptWith("the outgoing text"),
		});
		expect(found).toEqual({ sessionId: SID, message: "the outgoing text" });
		expect(outcome()).toBe("message");
	});

	it("records `empty-message` on a transcript with nothing outgoing in it", () => {
		const file = path.join(root, `${SID}.jsonl`);
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "user", message: { content: "ask" } })}\n`,
		);
		expect(from({ session_id: SID, transcript_path: file })).toBe(null);
		expect(outcome()).toBe("empty-message");
	});

	it("records `no-transcript` when neither the payload's path nor the fallback exists", () => {
		process.env.CLAUDE_CONFIG_DIR = path.join(root, "no-such-config");
		try {
			expect(
				from({
					session_id: SID,
					transcript_path: path.join(root, "absent.jsonl"),
				}),
			).toBe(null);
		} finally {
			delete process.env.CLAUDE_CONFIG_DIR;
		}
		expect(outcome()).toBe("no-transcript");
	});

	it("records `unreadable-transcript` when the read itself throws", () => {
		// A directory where the transcript should be: it exists, so the fallback
		// is never tried, and readFileSync throws EISDIR.
		const file = path.join(root, `${SID}.jsonl`);
		fs.mkdirSync(file);
		expect(from({ session_id: SID, transcript_path: file })).toBe(null);
		expect(outcome()).toBe("unreadable-transcript");
	});

	it("records `no-session-id` on a payload carrying none", () => {
		expect(from({ transcript_path: transcriptWith("text") })).toBe(null);
		expect(outcome(null)).toBe("no-session-id");
	});

	it("records `no-payload` when the payload could not be parsed at all", () => {
		expect(from(null)).toBe(null);
		expect(outcome(null)).toBe("no-payload");
	});

	it("still returns the message when the breadcrumb cannot be written", () => {
		// A file where the breadcrumb directory wants to be.
		fs.writeFileSync(hookRecord.recordsDir(root), "not a directory\n");
		const found = from({
			session_id: SID,
			last_assistant_message: "the outgoing text",
		});
		expect(found).toEqual({ sessionId: SID, message: "the outgoing text" });
	});
});

describe("textOf reads without recording (#73)", () => {
	it("takes the payload's message over the transcript", () => {
		const file = transcriptWith("from the transcript");
		expect(
			textOf({ session_id: SID, last_assistant_message: "from payload" }, file),
		).toBe("from payload");
	});

	it("falls back to the transcript on a whitespace-only payload message", () => {
		const file = transcriptWith("from the transcript");
		expect(
			textOf({ session_id: SID, last_assistant_message: "  \n" }, file),
		).toBe("from the transcript");
	});

	/* The scan walks records backwards, so a record's blocks must go in as one
	 * run or they come out reversed (#1533). */
	it("keeps a record's text blocks in content order", () => {
		const file = transcriptWith("c", [
			{
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			},
		]);
		expect(textOf({ session_id: SID }, file)).toBe("a\nb\nc");
	});

	it("returns empty and reports the error on an unreadable transcript", () => {
		const errors: unknown[] = [];
		const text = textOf(
			{ session_id: SID },
			path.join(root, "missing.jsonl"),
			(err: unknown) => errors.push(err),
		);
		expect(text).toBe("");
		expect(errors).toHaveLength(1);
	});

	/* Stubbed rather than read back: `record` defaults its root to the cwd, so
	 * a regressed `textOf` would write where `breadcrumbs(root)` never looks. */
	it("writes no breadcrumb", () => {
		const real = hookRecord.record;
		let calls = 0;
		hookRecord.record = () => {
			calls++;
			return true;
		};
		try {
			textOf({ session_id: SID }, transcriptWith("anything"));
			textOf({ session_id: SID }, path.join(root, "missing.jsonl"));
		} finally {
			hookRecord.record = real;
		}
		expect(calls).toBe(0);
	});
});

describe("the transcript's outgoing message", () => {
	it("assembles text split across several assistant records of one turn", () => {
		const file = transcriptWith("second", [
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "first" }] },
			},
		]);
		expect(textOf({}, file)).toBe("first\nsecond");
	});

	it("skips a subagent's records, which share the file", () => {
		const file = transcriptWith("mine", [
			{
				isSidechain: true,
				type: "assistant",
				message: { content: [{ type: "text", text: "the subagent's" }] },
			},
		]);
		expect(textOf({}, file)).toBe("mine");
	});
});
