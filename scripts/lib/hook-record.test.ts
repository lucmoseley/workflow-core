// @vitest-environment node
/*
 * Pins the breadcrumb a Stop guard appends on every run: one line per
 * invocation, from a closed set of outcomes and sources, never the message
 * text (mantahostels#872, mantahostels#1274).
 *
 * Exercised against a throwaway root: the default root is the cwd, and pointing
 * it at this repo would scatter real records through it.
 *
 * check-stop-guard-outcomes.js (`npm run check:stop-guards`) reads these lines
 * to tell a guard that ran and read nothing from a Stop that never fired, so a
 * loosened case lets a lost or overwritten line make those two look alike
 * again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { breadcrumbs } from "./breadcrumb-testkit";

const {
	record,
	guardName,
	normaliseGuardName,
	PREFIX,
	recordsDir,
} = require("./hook-record.js");

let root: string;
const SID = "3df629da-29f1-4240-9c65-9b70c1eeef89";
const GUARD = "guard-priced-options";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-record-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const put = (outcome: string, extra: Record<string, unknown> = {}) =>
	record({ root, guard: GUARD, sessionId: SID, outcome, ...extra });

/**
 * The lines this guard-session has recorded, oldest first; a `null` session
 * reads the record kept for payloads naming none.
 */
const lines = (sessionId: string | null = SID) =>
	breadcrumbs(root, GUARD, sessionId);

/** The files every record so far landed in, by name. */
const files = (): string[] => fs.readdirSync(recordsDir(root)).sort();

/** The one file this guard-session's first record went to. */
const recordFile = () => {
	put("message");
	const [name] = files();
	return path.join(recordsDir(root), name);
};

const last = (sessionId: string | null = SID) => {
	const all = lines(sessionId);
	return all ? all.at(-1) : null;
};

describe("recording an invocation", () => {
	it("writes a record when the guard read a real message", () => {
		expect(put("message", { source: "payload" })).toBe(true);
		expect(last()).toMatchObject({
			guard: GUARD,
			session: SID,
			outcome: "message",
			source: "payload",
		});
	});

	it.each([
		"empty-message",
		"no-transcript",
		"unreadable-transcript",
		"no-session-id",
		"no-payload",
		"no-finding",
		"inventory-stand-down",
	])("names the path it took rather than only that it ran: %s", (outcome) => {
		expect(put(outcome)).toBe(true);
		expect(last()?.outcome).toBe(outcome);
	});

	it("keeps one guard's record clear of another's in the same session", () => {
		record({ root, guard: GUARD, sessionId: SID, outcome: "message" });
		record({
			root,
			guard: "guard-selection-sum",
			sessionId: SID,
			outcome: "empty-message",
		});

		expect(lines()).toHaveLength(1);
		expect(breadcrumbs(root, "guard-selection-sum", SID)).toHaveLength(1);
		// One file each, so one guard's cap never silences the other.
		expect(files()).toHaveLength(2);
	});

	it("refuses an outcome outside the closed set, and writes nothing", () => {
		expect(put("probably-fine")).toBe(false);
		expect(lines()).toEqual([]);
	});
});

describe("one line per invocation, so a turn is not overwritten (mantahostels#1274)", () => {
	it("appends rather than rewriting, keeping every turn's outcome", () => {
		put("empty-message");
		put("empty-message");
		put("message", { source: "payload" });

		expect(lines().map((l) => l.outcome)).toEqual([
			"empty-message",
			"empty-message",
			"message",
		]);
	});

	it("carries no count — the line's ordinal is the invocation number", () => {
		put("message");
		put("message");
		expect(last()).not.toHaveProperty("count");
		expect(lines()).toHaveLength(2);
	});

	it("never reads the file before writing, so a corrupt line costs only itself", () => {
		fs.appendFileSync(recordFile(), "not json\n");
		expect(put("empty-message")).toBe(true);
		// The unparseable line is skipped; the new one survives it.
		expect(lines()).toHaveLength(2);
		expect(last()?.outcome).toBe("empty-message");
	});

	it("keeps lines from different sessions individually readable in the shared file", () => {
		record({ root, guard: GUARD, outcome: "no-session-id" });
		record({ root, guard: GUARD, sessionId: "..", outcome: "no-payload" });
		expect(files()).toHaveLength(1);
		expect(lines(null).map((l) => l.outcome)).toEqual([
			"no-session-id",
			"no-payload",
		]);
	});
});

describe("the fields each line carries (mantahostels#1274)", () => {
	it("records which route produced the message", () => {
		put("message", { source: "transcript" });
		expect(last()?.source).toBe("transcript");
	});

	it("records a null source where neither route yielded text", () => {
		put("empty-message");
		expect(last()?.source).toBe(null);
	});

	it("refuses a source spelling outside the closed set", () => {
		put("message", { source: "guesswork" });
		expect(last()?.source).toBe(null);
	});

	it("records the payload field's length, never its text", () => {
		put("message", {
			source: "payload",
			payload: { last_assistant_message: "twelve chars" },
		});
		const found = last();
		expect(found?.payloadLen).toBe(12);
		expect(JSON.stringify(found)).not.toContain("twelve chars");
	});

	it("records a null payloadLen where the payload carried no such field", () => {
		put("message", { source: "transcript", payload: { session_id: SID } });
		expect(last()?.payloadLen).toBe(null);
	});

	it("records the length the fallback read, and null where it never ran", () => {
		put("message", { source: "payload" });
		expect(last()?.transcriptLen).toBe(null);
		put("empty-message", { transcriptLen: 0 });
		expect(last()?.transcriptLen).toBe(0);
		put("message", { source: "transcript", transcriptLen: 1180 });
		expect(last()?.transcriptLen).toBe(1180);
	});

	it("records stop_hook_active, so a re-fired Stop is not read as a fresh turn", () => {
		put("message", { payload: { stop_hook_active: true } });
		expect(last()?.stopHookActive).toBe(true);
		put("message", { payload: {} });
		expect(last()?.stopHookActive).toBe(false);
	});
});

describe("the 32 KB cap (mantahostels#1274)", () => {
	const capBytes = 32_768;

	/** Fills the record's file to `bytes` without going through `record()`. */
	const fill = (bytes = capBytes) => {
		const file = recordFile();
		const line = JSON.stringify({ guard: GUARD, session: SID, filler: 1 });
		let raw = "";
		while (fs.statSync(file).size + raw.length < bytes) raw += `${line}\n`;
		fs.appendFileSync(file, raw);
		return file;
	};

	it("stops appending invocations once the file is at the cap", () => {
		const file = fill();
		const before = fs.statSync(file).size;
		expect(put("message")).toBe(false);
		const after = fs.statSync(file).size;
		// Only the sentinel was added, and it is not an invocation record.
		expect(after).toBeGreaterThan(before);
		expect(last()).toMatchObject({ guard: GUARD, session: SID, capped: true });
		expect(last()).not.toHaveProperty("outcome");
	});

	it("writes the sentinel exactly once, then nothing ever again", () => {
		const file = fill();
		put("message");
		const afterSentinel = fs.statSync(file).size;
		expect(put("message")).toBe(false);
		expect(put("empty-message")).toBe(false);
		expect(fs.statSync(file).size).toBe(afterSentinel);
	});

	it("appends normally below the cap", () => {
		fill(capBytes - 200);
		expect(put("empty-message")).toBe(true);
		expect(last()?.outcome).toBe("empty-message");
	});
});

describe("a subagent's Stop", () => {
	it("writes no record against the parent session", () => {
		expect(
			put("empty-message", { payload: { hook_event_name: "SubagentStop" } }),
		).toBe(false);
		expect(lines()).toEqual([]);
	});

	it("does not suppress the parent's own Stop", () => {
		expect(put("message", { payload: { hook_event_name: "Stop" } })).toBe(true);
		expect(lines()).toHaveLength(1);
	});

	it("records a payload that names no event at all", () => {
		expect(put("message", { payload: { session_id: SID } })).toBe(true);
	});
});

describe("failure paths stay silent", () => {
	it("returns false rather than throwing when the record cannot be written", () => {
		// A directory where the record file wants to be: appendFileSync throws EISDIR.
		const file = recordFile();
		fs.rmSync(file);
		fs.mkdirSync(file);
		expect(put("message")).toBe(false);
	});

	/* The mkdirSync mantahostels#3382 added sits inside the same silent try as the append, so
	 * a directory that cannot be created must return false rather than throw —
	 * the same contract the append already had. Nothing else reaches that branch:
	 * every other failure test blocks the FILE, which leaves the mkdir working. */
	it("returns false rather than throwing when the directory cannot be created", () => {
		// A file where the directory wants to be: mkdirSync throws EEXIST/ENOTDIR.
		fs.writeFileSync(recordsDir(root), "not a directory\n");
		expect(put("message")).toBe(false);
	});
});

describe("the path a record lands on", () => {
	it("sits in the breadcrumb directory under the root it was given", () => {
		put("message");
		expect(files()).toEqual([`${PREFIX + GUARD}-${SID}`]);
	});

	it("refuses a session id carrying a path separator", () => {
		const evil = "../../etc/passwd";
		expect(
			record({ root, guard: GUARD, sessionId: evil, outcome: "message" }),
		).toBe(true);
		expect(files()).toEqual([`${PREFIX + GUARD}-unknown-session`]);
	});

	it("still records an invocation whose payload carried no session id", () => {
		expect(record({ root, guard: GUARD, outcome: "no-session-id" })).toBe(true);
		expect(last(null)?.outcome).toBe("no-session-id");
	});
});

describe("guardName", () => {
	it("names the script the harness ran", () => {
		expect(guardName("/repo/scripts/guard-priced-options.js")).toBe(
			"guard-priced-options",
		);
	});

	it("falls back rather than putting an unusable name on a path", () => {
		expect(guardName("/repo/scripts/guard priced/options?.js")).toBe(
			"unknown-guard",
		);
		expect(guardName("")).toBe("unknown-guard");
	});
});

describe("normaliseGuardName", () => {
	/* Records written before guardName stripped the suffix are still on disk, so
	 * a reader keying on the raw string counts one guard as two (mantahostels#2545). */
	it("folds a record's suffixed name onto the one the guard writes today", () => {
		expect(normaliseGuardName("guard-priced-options.js")).toBe(
			"guard-priced-options",
		);
		expect(normaliseGuardName("guard-priced-options")).toBe(
			"guard-priced-options",
		);
	});

	it("leaves a name whose suffix is not a script suffix alone", () => {
		expect(normaliseGuardName("guard-lost-deny.sh")).toBe("guard-lost-deny.sh");
	});
});
