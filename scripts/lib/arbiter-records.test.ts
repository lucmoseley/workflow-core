// @vitest-environment node
/*
 * The record factories — where each family's field set is written down, and the
 * one place arbiter-records.js's typedefs are mirrored. A bare lock defaults to
 * breakable, two locks never share a claim id, and a debt has exactly its five
 * fields, unowned by default (mantahostels#116, #1170; split out at
 * mantahostels#1795).
 *
 * The lock factory is called directly; a debt is read as a denial writes it.
 * Both run under arbiter-testkit's sandbox, so that nothing they touch can
 * reach the live registry.
 *
 * Loosen a case here and a pid-less lock nothing can ever clear, or a debt record
 * the denied session cannot complete, ships unnoticed through every arbiter
 * family that mints one.
 */
import { describe, expect, it } from "vitest";
import { debtOf, freshSandbox, locks, proc, store } from "./arbiter-testkit";

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
		expect(a.bootId).toBe(proc.currentBootId() || undefined);
	});

	it("gives a debt five fields — mantahostels#116 cut the blocking session, #1170 added the recording one", () => {
		store.registerDenial("docs/a.md");
		expect(Object.keys(debtOf("docs/a.md") ?? {}).sort()).toEqual([
			"createdAt",
			"gist",
			"issue",
			"path",
			"recordedBy",
		]);
	});

	it("defaults a debt to unowned, which is the stub a denial writes", () => {
		store.registerDenial("docs/a.md");
		const d = debtOf("docs/a.md");
		expect(d?.issue).toBeNull();
		expect(d?.gist).toBeNull();
		expect(d?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});
