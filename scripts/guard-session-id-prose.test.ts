// @vitest-environment node
/*
 * guard-session-id-prose.js sends a reply back once where its prose names a
 * session by id rather than by name (#3557) — black-box, driven in process
 * through `lib/stop-guard-testkit` with every root redirected into a temp
 * directory, the sessions registry included.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardBlock } from "./lib/stop-guard-testkit";

const GUARD = path.join(__dirname, "guard-session-id-prose.js");

const ALICE = "5c650936-1111-4222-8333-444455556666";
const NAMELESS = "21b6d552-1111-4222-8333-444455556666";

let dir: string;
let sid = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-prose-"));
	sid = `s-${path.basename(dir)}`;
	const sessions = path.join(dir, "config", "sessions");
	fs.mkdirSync(sessions, { recursive: true });
	fs.writeFileSync(
		path.join(sessions, "101.json"),
		JSON.stringify({ pid: 101, sessionId: ALICE, name: "Wayfinder 1162" }),
	);
	fs.writeFileSync(
		path.join(sessions, "102.json"),
		JSON.stringify({ pid: 102, sessionId: NAMELESS }),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const run = (message: string, payload: Record<string, unknown> = {}) =>
	readStopGuardBlock(GUARD, { dir, sid, message, payload });

describe("#3557: a reply naming a session by id is sent back", () => {
	it("sends back `session <8-hex>`, giving the registry's name for it", () => {
		const out = run("Waiting on session 5c650936 to release the file.");
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("5c650936 → Wayfinder 1162");
	});

	it("sends back `session <8-hex>` the registry does not know", () => {
		const out = run("Session 08efab58 holds it.");
		expect(out?.reason).toContain("08efab58 → no name in the registry");
	});

	it("sends back a bare full UUID or 8-hex prefix the registry knows", () => {
		expect(run(`Held by ${ALICE}.`)?.decision).toBe("block");
		const out = run("Held by 21b6d552, still running.");
		expect(out?.reason).toContain("21b6d552 → no name in the registry");
	});
});

describe("what passes", () => {
	it("passes an id inside a code span or fenced block, where a command needs it", () => {
		expect(
			run(
				"Run `node scripts/session-arbiter.js wait 5c650936` in the background.\n\n```\nsession 21b6d552\n```",
			),
		).toBeNull();
	});

	it("passes a bare UUID or 8-hex word the registry does not know", () => {
		expect(
			run(
				"Committed deadbeef; the artifact is claude.ai/code/artifact/0b1c2d3e-1111-4222-8333-444455556666, request 9a8b7c6d-1111-4222-8333-444455556666.",
			),
		).toBeNull();
	});

	it("passes a session named by its name", () => {
		expect(run("Waiting on Wayfinder 1162 to release it.")).toBeNull();
	});

	it("sends a reply back once: a turn a Stop hook already sent back passes", () => {
		expect(
			run("Held by session 5c650936.", { stop_hook_active: true }),
		).toBeNull();
	});
});
