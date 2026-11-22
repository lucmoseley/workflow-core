// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshSandbox, locks, proc } from "./arbiter-testkit";

freshSandbox();

describe("the record factories — where a record's fields are written down", () => {
	it("defaults a lock to the not-observed values, so a bare one is breakable", () => {
		const lock = locks.newLock({
			path: "docs/doc-map.md",
			sessionId: "ancient",
		});
		expect(lock.pid).toBeNull();
		expect(lock.procStart).toBeNull();
		expect(proc.holderAlive(lock)).toBe(false);
	});

	it("stamps a lock with a claim id and this boot, so two locks never collide", () => {
		const a = locks.newLock({ path: "docs/a.md" });
		const b = locks.newLock({ path: "docs/a.md" });
		expect(a.claimId).not.toBe(b.claimId);
		expect(a.bootId).toBe(proc.readCurrentBootId() || undefined);
	});
});
