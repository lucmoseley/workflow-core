// @vitest-environment node
/*
 * concision-receipts.test.ts — the parsing and totalling behind
 * scripts/concision-route-report.js.
 *
 * In-process against return values, which is what a `scripts/lib/` seam is for:
 * the CLI's own test drives the script as a subprocess instead.
 *
 * What breaking these costs: mantahostels#1099 built the `route=` receipt line to answer
 * whether a concision pass run in a subagent finds less than one run in the
 * session that wrote the prose. A receipt silently landing in the wrong arm
 * would not fail anything — it would just answer that question wrongly. This
 * test, red in CI, is the only thing that would.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { collect, report } = createRequire(__filename)(
	"./concision-receipts.js",
);

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "concision-receipts-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The receipt `collect` reads off one file holding `text`, or null where it drops it. */
const collectedFrom = (text: string) => {
	fs.writeFileSync(path.join(dir, ".concision-pass-one"), text);
	return collect(dir)[0] ?? null;
};

/** One receipt as the pass's step 6 writes it, plus the route under test. */
const body = (findings: string, route?: string) =>
	`base=${"a".repeat(40)}\nfindings=${findings}\n${route ? `route=${route}\n` : ""}`;

describe("reading a receipt (mantahostels#1099)", () => {
	it("reports the route the pass recorded", () => {
		expect(collectedFrom(body("11", "subagent"))).toEqual({
			findings: 11,
			route: "subagent",
		});
	});

	// The paired negative to the case above: every receipt written before mantahostels#1099
	// carries no route at all. Folding them into in-session — which is what they
	// all in fact were — would let a pre-mantahostels#1099 corpus masquerade as evidence
	// gathered for the comparison.
	it("buckets a receipt carrying no route as unrecorded, not in-session", () => {
		expect(collectedFrom(body("3"))?.route).toBe("unrecorded");
	});

	it("buckets a route it does not know as unrecorded rather than as its own arm", () => {
		expect(collectedFrom(body("3", "agent"))?.route).toBe("unrecorded");
	});

	it("drops a receipt whose findings= is missing or not a number", () => {
		expect(collectedFrom(`base=${"a".repeat(40)}\n`)).toBeNull();
		expect(collectedFrom(body("some cuts"))).toBeNull();
	});

	it("keeps findings=0, which is a pass that ran and found nothing", () => {
		expect(collectedFrom(body("0", "mixed"))?.findings).toBe(0);
	});
});

describe("totalling the receipts by route (mantahostels#1099)", () => {
	const rows = [
		{ findings: 10, route: "subagent" },
		{ findings: 4, route: "subagent" },
		{ findings: 0, route: "subagent" },
		{ findings: 12, route: "in-session" },
	];

	it("means each route over its own runs, counting the zero-finding passes", () => {
		const out = report(rows);
		expect(out).toContain("| subagent | 3 | 14 | 4.7 | 1 |");
		expect(out).toContain("| in-session | 1 | 12 | 12.0 | 0 |");
	});

	it("prints the proxy-validity caveat and the uncounted route with the table", () => {
		const out = report(rows);
		expect(out).toContain("~60% validity");
		expect(out).toContain(".codereview-pass-<sid>");
	});
});
