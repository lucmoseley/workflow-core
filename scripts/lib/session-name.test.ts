// @vitest-environment node
/*
 * lib/session-name.js (#4395) against real files in a temp directory, since
 * it reads the transcript itself through no injected port: the latest
 * `custom-title` is the session's name, a transcript naming none or a missing
 * file reads null, one that will not read says why, and the prefix is the
 * shell scripts' (#3701).
 *
 * Loosen one and a session moved onto an overflow key takes its first name
 * rather than the one its row shows, an unreadable transcript names it after
 * its prompt in silence, or the prefix drifts from the one the shell scripts
 * name an overflow job with.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionName } from "./session-name.js";

let dir = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-name-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const title = (customTitle: string) =>
	JSON.stringify({ type: "custom-title", customTitle, sessionId: "s1" });

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
