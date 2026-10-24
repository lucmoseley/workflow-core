// @vitest-environment node
/*
 * arbiter-requests.js's own suite — the store-only branches of asking a live
 * holder for a file. The CLI's own paths stay in session-arbiter.test.ts.
 * An empty register is never conflated with an unreadable one (mantahostels#1782,
 * mantahostels#174).
 *
 * The store is called in process under arbiter-testkit's sandbox, with an
 * unreadable register made by hand, so the fault branches are reached exactly.
 *
 * `session-arbiter.js request` is how a session blocked past its wait asks a
 * holder for a file: loosen a case here and a request is lost, or a register
 * that will not read answers "nobody asked", and the holder never hears.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AS_ROOT, durably, freshSandbox, store } from "./arbiter-testkit";

freshSandbox();

describe("the request register — store-only branches (mantahostels#1782)", () => {
	const asker = () => durably("asker");

	it("readRequests: [] on a genuine empty, null on an unreadable register — never conflated (mantahostels#174)", () => {
		// Nothing has ever been requested: the directory does not exist.
		expect(store.readRequests()).toEqual([]);
		// A file where the directory should be: readdir fails with ENOTDIR, which
		// is a fault.
		fs.mkdirSync(store.stateDir(), { recursive: true });
		fs.writeFileSync(store.paths.requestsDir(), "not a directory");
		expect(store.readRequests()).toBeNull();
	});

	it.skipIf(AS_ROOT)("reads a sealed-off register as null too", () => {
		store.recordRequest("docs/a.md", asker(), "holder", null);
		fs.chmodSync(store.paths.requestsDir(), 0o000);
		try {
			expect(store.readRequests()).toBeNull();
		} finally {
			fs.chmodSync(store.paths.requestsDir(), 0o755);
		}
	});

	it("keeps the region-qualified subject while keying by the file", () => {
		store.recordRequest("docs/doc-map.md#B5", asker(), "holder", "why");
		expect(store.readRequests()).toMatchObject([
			{ subject: "docs/doc-map.md#B5", requester: "asker" },
		]);
		store.dropRequests("docs/doc-map.md");
		expect(store.readRequests()).toEqual([]);
	});

	it("dropRequests with a requester drops that pair alone", () => {
		store.recordRequest("docs/a.md", asker(), "holder", null);
		store.recordRequest("docs/a.md", durably("other"), "holder", null);
		store.dropRequests("docs/a.md", "asker");
		expect(store.readRequests()).toMatchObject([{ requester: "other" }]);
	});

	it("dropRequests without one drops every requester's, and only that file's", () => {
		store.recordRequest("docs/a.md", asker(), "holder", null);
		store.recordRequest("docs/a.md", durably("other"), "holder", null);
		store.recordRequest("docs/b.md", asker(), "holder", null);
		store.dropRequests("docs/a.md");
		expect(store.readRequests()).toMatchObject([{ subject: "docs/b.md" }]);
	});

	it("declineRequest mutates the declined field in place, keeping the rest", () => {
		store.recordRequest("docs/a.md", asker(), "holder", "the why line");
		const r = store.declineRequest("docs/a.md", "holder", "mid-edit");
		expect(r).toEqual({ status: "declined", count: 1 });
		const [rec] = store.readRequests();
		expect(rec).toMatchObject({
			subject: "docs/a.md",
			why: "the why line",
			declined: { by: "holder", reason: "mid-edit" },
		});
	});

	it("declineRequest answers none on an empty register and unreadable on a broken one", () => {
		expect(store.declineRequest("docs/a.md", "holder", null)).toEqual({
			status: "none",
			count: 0,
		});
		fs.mkdirSync(store.stateDir(), { recursive: true });
		fs.writeFileSync(store.paths.requestsDir(), "not a directory");
		expect(store.declineRequest("docs/a.md", "holder", null)).toMatchObject({
			status: "unreadable",
		});
	});

	it("records nothing for a session with no id — there is nobody to answer", () => {
		store.recordRequest("docs/a.md", { sessionId: null }, "holder", null);
		expect(fs.existsSync(store.paths.requestsDir())).toBe(false);
	});

	it("a sibling region's release does not destroy the ask — only an overlapping subject does", () => {
		store.recordRequest("docs/doc-map.md#B9", asker(), "holder", null);
		// Regions tile: releasing #B5 answers nothing about #B9, whose holder may
		// still be mid-edit, so the requester must keep its record.
		store.dropRequests("docs/doc-map.md#B5");
		expect(store.readRequests()).toHaveLength(1);
		store.dropRequests("docs/doc-map.md#B9");
		expect(store.readRequests()).toEqual([]);
	});

	it("the requester's own claim on a disjoint region answers nothing either", () => {
		store.recordRequest("docs/doc-map.md#B9", asker(), "holder", null);
		store.dropRequests("docs/doc-map.md#B5", "asker");
		expect(store.readRequests()).toHaveLength(1);
		store.dropRequests("docs/doc-map.md#B9", "asker");
		expect(store.readRequests()).toEqual([]);
	});

	it("declining a sibling region leaves the ask unanswered", () => {
		store.recordRequest("docs/doc-map.md#B9", asker(), "holder", null);
		expect(store.declineRequest("docs/doc-map.md#B5", "holder", null)).toEqual({
			status: "none",
			count: 0,
		});
		expect(store.readRequests()[0].declined).toBeNull();
		expect(
			store.declineRequest("docs/doc-map.md#B9", "holder", null).status,
		).toBe("declined");
	});

	it.skipIf(AS_ROOT)(
		"a decline the register refused to write is failed, never none",
		() => {
			store.recordRequest("docs/a.md", asker(), "holder", null);
			// The FILE refuses, not the directory: writeRecord overwrites in place,
			// which a read-only directory would still allow.
			const f = store.paths.request("docs/a.md", "asker");
			fs.chmodSync(f, 0o444);
			try {
				// "none" here would print "No requests to decline" over a standing,
				// unanswered request — the opposite of the truth.
				expect(store.declineRequest("docs/a.md", "holder", null).status).toBe(
					"failed",
				);
			} finally {
				fs.chmodSync(f, 0o644);
			}
		},
	);
});
