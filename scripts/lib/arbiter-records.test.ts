// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshSandbox, live, lockRecord, proc, store } from "./arbiter-testkit";

const sb = freshSandbox();

describe("a lock record — where its fields are written down", () => {
	it("reads a lock with no observed process as dead, so a bare one is breakable", () => {
		const lock = lockRecord({ path: "docs/doc-map.md", sessionId: "ancient" });
		expect(proc.holderAlive(lock)).toBe(false);
	});

	it("stamps each claim with a claim id and this boot, so two locks never collide", () => {
		const me = live(sb, "alice");
		const a = store.acquire("docs/a.md", me).lock;
		const b = store.acquire("docs/b.md", me).lock;
		expect(a?.claimId).not.toBe(b?.claimId);
		expect(a?.bootId).toBe(proc.readCurrentBootId());
	});
});
