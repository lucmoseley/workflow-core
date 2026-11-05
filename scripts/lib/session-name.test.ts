// @vitest-environment node
/*
 * lib/session-name.js (#4395) against real files in a temp directory: the
 * latest `custom-title` is the session's name, a transcript naming none or a
 * missing file reads null, one that will not read says why, and the prefix is
 * the shell scripts' (#3701).
 *
 * Loosen one and a session moved onto an overflow key takes its first name
 * rather than the one its row shows, a move throws on a transcript it cannot
 * read, or the prefix drifts from the one the shell scripts name an
 * overflow job with.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { OVERFLOW_PREFIX, readSessionName } from "./session-name.js";

let dir = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-name-"));
});

const title = (customTitle: string) =>
	JSON.stringify({ type: "custom-title", customTitle, sessionId: "s1" });

/** A transcript of `lines`, its path. */
const transcript = (...lines: string[]) => {
	const file = path.join(dir, "s1.jsonl");
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
};

describe("readSessionName", () => {
	it("reads the latest custom-title, past a cut line after it", () => {
		const file = transcript(
			title("Overflow · /implement 7"),
			JSON.stringify({ type: "user", message: "custom-title" }),
			title("Overflow · Implement 7: a title"),
			'{"type":"custom-title","customTi',
		);
		expect(readSessionName(file)).toEqual({
			name: "Overflow · Implement 7: a title",
		});
	});

	it("reads no name from a transcript naming nothing, and from no file", () => {
		expect(readSessionName(transcript('{"type":"user"}'))).toEqual({
			name: null,
		});
		expect(readSessionName(path.join(dir, "none.jsonl"))).toEqual({
			name: null,
		});
	});

	it("says why a transcript will not read", () => {
		const r = readSessionName(dir);
		expect(r).toEqual({
			why: expect.stringContaining(`reading ${dir}: EISDIR`),
		});
	});
});

describe("OVERFLOW_PREFIX", () => {
	it("is the prefix dispatch-sessions.sh launches with and name-issue-session.sh keeps", () => {
		const read = (f: string) =>
			fs.readFileSync(path.join(__dirname, f), "utf8");
		expect(read("../dispatch-sessions.sh")).toContain(
			`-n "${OVERFLOW_PREFIX}$prompt"`,
		);
		expect(read("../name-issue-session.sh")).toContain(
			`local prefix="${OVERFLOW_PREFIX}"`,
		);
	});
});
