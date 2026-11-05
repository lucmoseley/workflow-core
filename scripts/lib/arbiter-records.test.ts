// @vitest-environment node
/*
 * The record factories — where each family's field set is written down, and the
 * one place arbiter-records.js's typedefs are mirrored. A bare lock defaults to
 * breakable, and two locks never share a claim id (split out at
 * mantahostels#1795).
 *
 * The lock factory is called directly, under arbiter-testkit's sandbox, so that
 * nothing it touches can reach the live registry.
 *
 * Loosen a case here and a pid-less lock nothing can ever clear ships unnoticed
 * through every arbiter family that mints one.
 */
import { describe, expect, it } from "vitest";
import { freshSandbox, locks, proc } from "./arbiter-testkit";

freshSandbox();

describe("the record factories — where a record's fields are written down", () => {
	it("defaults a lock to the not-observed values, so a bare one is breakable", () => {
		// holderAlive must read it as dead, or nothing could ever clear it.
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
