// @vitest-environment node
/*
 * check-facts.test.ts — pins the version and sha patterns check-facts.js
 * reads. It once reported "every fact-shaped token survived" on a diff that
 * swapped a version stamp and two git shas, because a leading `v` or a
 * trailing hex letter blocks \b on either side of the digit run the decimal
 * and number patterns anchor on (mantahostels#3323, the ticket that traced
 * this). Loosen a case and a cut that loses one of those tokens passes the
 * skill's step 5 as clean.
 *
 * Run through runInProcess (§X3), not a subprocess: check-facts.js is
 * synchronous and calls main() unconditionally at load, exactly the shape
 * runInProcess loads directly.
 *
 * MUTATIONS RUN (mantahostels#3323): the version pattern broken — the two version tests
 * below went red (a `v2.25` loss is no longer reported at all — the fallback
 * `number` match on the tail digits still fires, so it isn't a silent pass,
 * but the specific `[version]` assertion fails). The sha pattern's `[a-f]`
 * requirement dropped — the double-count test below went red, since a plain
 * digit run then matches both patterns and the shared map entry's count
 * inflates from 1 to 2 instead of staying 1. Each was reversed by its
 * inverse edit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "../../../../scripts/lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-facts.js");

let dir: string;

const write = (rel: string, body: string) => {
	fs.writeFileSync(path.join(dir, rel), body);
};

const run = (before: string, after: string, ...flags: string[]) => {
	const r = runInProcess(SCRIPT, [
		path.join(dir, before),
		path.join(dir, after),
		...flags,
	]);
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-facts-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("version stamp (mantahostels#3323)", () => {
	it("reports a GONE hit when v2.25 becomes v2.27", () => {
		write("before.md", "brand sheet v2.25\n");
		write("after.md", "brand sheet v2.27\n");

		const { code, out } = run("before.md", "after.md");

		expect(code).toBe(2);
		expect(out).toContain("[version] v2.25");
	});

	it("reports a GONE hit when v7.4 becomes v7.6", () => {
		write("before.md", "roadmap v7.4\n");
		write("after.md", "roadmap v7.6\n");

		const { code, out } = run("before.md", "after.md");

		expect(code).toBe(2);
		expect(out).toContain("[version] v7.4");
	});

	it("stays clean when the version stamp is untouched", () => {
		write("before.md", "roadmap v7.4 and nothing else\n");
		write("after.md", "roadmap v7.4\n");

		const { code, out } = run("before.md", "after.md");

		expect(code).toBe(0);
		expect(out).toContain("OK — every fact-shaped token survived the cut.");
	});
});

describe("bare git sha (mantahostels#3323)", () => {
	it("reports a GONE hit for each of a pair of replaced shas", () => {
		write("before.md", "roadmap commit 1349d2a5c\nrepo at 2cd25068e\n");
		write("after.md", "roadmap commit 9baa68403\nrepo at 59a209e52\n");

		const { code, out } = run("before.md", "after.md");

		expect(code).toBe(2);
		expect(out).toContain("[sha] 1349d2a5c");
		expect(out).toContain("[sha] 2cd25068e");
	});

	it("stays clean when the sha is untouched", () => {
		write("before.md", "repo at 2cd25068e and nothing else\n");
		write("after.md", "repo at 2cd25068e\n");

		const { code, out } = run("before.md", "after.md");

		expect(code).toBe(0);
		expect(out).toContain("OK — every fact-shaped token survived the cut.");
	});

	it("does not read a 6-character hex run below the 7-character floor as a sha", () => {
		write("before.md", "colour cafe12 and nothing else\n");
		write("after.md", "colour cafe12\n");

		const { code, out } = run("before.md", "after.md");

		expect(code).toBe(0);
		expect(out).toContain("OK — every fact-shaped token survived the cut.");
	});

	it("does not double-count a lost pure-digit run against the number pattern's own match", () => {
		// A digit run with no a-f letter is already read once by the number
		// pattern; if the sha pattern also matched it, the same map entry
		// would take a second hit and inflate "was" from 1 to 2 (mantahostels#3323).
		write("before.md", "count 1234567 items\n");
		write("after.md", "count nothing here\n");

		const { code, out } = run("before.md", "after.md");

		expect(code).toBe(2);
		expect(out).toContain("[number] 1234567  (1 -> 0)");
	});
});
