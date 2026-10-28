// @vitest-environment node
/*
 * Pins which closed tickets the report names for unticked acceptance criteria,
 * which section it reads them from, and when a waiver or an exclusion keeps a
 * ticket from failing. No ticket found: neither the first commit nor the file's
 * history names one.
 *
 * Every case runs with a stub `gh` injected via WFC_GH: no
 * network, no auth, and no dependence on this repo's actual issue state —
 * which is the thing the script reports on and so cannot also be its fixture.
 *
 * The section-scoping cases are not hypothetical. Real ticket bodies quote
 * ledger items containing bracketed text, and a "Blocked by" list is one line
 * away from parsing as a task list.
 *
 * It runs daily as the `criteria` entry of the repo-checks run,
 * read back at `npm run status`: loosen a case and a ticket closed with criteria
 * nobody verified passes unreported, or a reasonless waiver silences a box.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catFixture, type StubGh, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-ticket-criteria.js");

let dir: string;

interface Issue {
	number: number;
	title?: string;
	body?: string;
	labels?: { name: string }[];
	stateReason?: string;
}

/** Write a stub `gh` returning the given closed-issue list. */
const stubGh = (closed: Issue[], { failing = false } = {}) => {
	const fixture = path.join(dir, "closed.json");
	fs.writeFileSync(
		fixture,
		JSON.stringify(
			closed.map((i) => ({
				title: `t${i.number}`,
				body: "",
				labels: [],
				stateReason: "COMPLETED",
				closedAt: "2026-07-01T00:00:00Z",
				url: `http://example/${i.number}`,
				...i,
			})),
		),
	);
	return stubGhScript(dir, catFixture(fixture), { failing });
};

const run = (args: string[] = [], stub?: StubGh) => {
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, ...stub?.env },
	});
	return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const ticket = (number: number, body: string, extra: Partial<Issue> = {}) => ({
	number,
	body,
	labels: [{ name: "kind:ticket" }],
	...extra,
});

const CRITERIA = (...items: string[]) =>
	`## What to build\n\nStuff.\n\n## Acceptance criteria\n\n${items.join("\n")}\n`;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("detection", () => {
	it("reports a closed ticket whose criteria are all unticked", () => {
		const stub = stubGh([
			ticket(
				52,
				CRITERIA("- [ ] retractions applied", "- [ ] figures re-derived"),
			),
		]);
		const r = run([], stub);
		expect(r.out).toContain("UNVERIFIED");
		expect(r.out).toContain("#52");
		expect(r.out).toContain("2/2 unticked");
		expect(r.out).toContain("retractions applied");
		expect(r.status).toBe(1);
	});

	it("reports a partially ticked ticket, listing only the unticked ones", () => {
		const stub = stubGh([
			ticket(
				53,
				CRITERIA("- [x] dateFrom used", "- [ ] import has no side effects"),
			),
		]);
		const r = run([], stub);
		expect(r.out).toContain("1/2 unticked");
		expect(r.out).toContain("import has no side effects");
		expect(r.out).not.toContain("dateFrom used");
		expect(r.status).toBe(1);
	});

	it("passes a fully ticked ticket", () => {
		const stub = stubGh([ticket(54, CRITERIA("- [x] one", "- [X] two"))]);
		const r = run([], stub);
		expect(r.out).toContain("OK: no closed ticket has unticked");
		expect(r.status).toBe(0);
	});
});

describe("section scoping", () => {
	it("ignores task items outside the acceptance-criteria section", () => {
		// The "Blocked by" list is the real trap: it sits in every ticket
		// /to-tickets publishes, and renders as a task list on some trackers.
		const body =
			"## What to build\n\n- [ ] not a criterion, quoted prose\n\n## Acceptance criteria\n\n- [x] done\n\n## Blocked by\n\n- [ ] #51\n";
		const r = run([], stubGh([ticket(55, body)]));
		expect(r.out).toContain("OK: no closed ticket has unticked");
		expect(r.status).toBe(0);
	});

	it("reads a bare Acceptance heading as the criteria section (#2481)", () => {
		const body = "## Acceptance\n\n- [x] met\n- [ ] not met\n";
		const r = run([], stubGh([ticket(58, body)]));
		expect(r.out).toContain("not met");
		expect(r.status).toBe(1);
	});

	it("does not read a heading that only opens with Acceptance", () => {
		const body =
			"## Acceptance notes\n\n- [ ] a stray box\n\n## Acceptance\n\n- [x] met\n";
		const r = run([], stubGh([ticket(59, body)]));
		expect(r.status).toBe(0);
	});

	it("stops the section at the next same-level heading", () => {
		const body =
			"## Acceptance criteria\n\n- [x] met\n\n## Notes\n\n- [ ] a stray box\n";
		const r = run([], stubGh([ticket(56, body)]));
		expect(r.status).toBe(0);
	});

	it("does not stop the section at a deeper heading", () => {
		const body =
			"## Acceptance criteria\n\n- [x] met\n\n### Sub-group\n\n- [ ] also a criterion\n";
		const r = run([], stubGh([ticket(57, body)]));
		expect(r.out).toContain("also a criterion");
		expect(r.status).toBe(1);
	});
});

describe("waivers", () => {
	it("reports a waived criterion without failing", () => {
		const stub = stubGh([
			ticket(
				62,
				CRITERIA("- [x] one", "- [ ] two **waived:** shipped a third fix"),
			),
		]);
		const r = run([], stub);
		expect(r.out).toContain("WAIVED");
		expect(r.out).toContain("shipped a third fix");
		expect(r.out).not.toContain("UNVERIFIED");
		expect(r.status).toBe(0);
	});

	it("still fails a waiver marker carrying no reason", () => {
		const stub = stubGh([ticket(63, CRITERIA("- [ ] two **waived:**"))]);
		const r = run([], stub);
		expect(r.out).toContain("UNVERIFIED");
		expect(r.status).toBe(1);
	});

	it("still fails when an unwaived criterion sits beside a waived one, naming it and the unticked count", () => {
		const stub = stubGh([
			ticket(64, CRITERIA("- [ ] plain unticked", "- [ ] **waived:** reason")),
		]);
		const r = run([], stub);
		expect(r.out).toContain("1/2 unticked");
		expect(r.out).toContain("plain unticked");
		expect(r.status).toBe(1);
	});

	it("does not treat a criterion merely mentioning waivers as waived", () => {
		const stub = stubGh([
			ticket(65, CRITERIA("- [ ] the click-tie is waived for seeded reviews")),
		]);
		const r = run([], stub);
		expect(r.out).toContain("UNVERIFIED");
		expect(r.status).toBe(1);
	});
});

describe("exclusions", () => {
	it("skips issues closed as not planned", () => {
		const stub = stubGh([
			ticket(58, CRITERIA("- [ ] never done"), { stateReason: "NOT_PLANNED" }),
		]);
		const r = run([], stub);
		expect(r.out).toContain("OK: no closed ticket has unticked");
		expect(r.status).toBe(0);
	});

	it("ignores an unlabelled issue that carries no criteria section", () => {
		// A roadmap card's issue, or a wayfinder decision ticket. Neither takes
		// `kind:ticket` and neither is expected to carry criteria.
		const r = run(
			[],
			stubGh([{ number: 33, body: "A decision.", labels: [] }]),
		);
		expect(r.out).toContain("OK: no closed ticket has unticked");
		expect(r.out).not.toContain("NO-CRITERIA");
		expect(r.status).toBe(0);
	});

	it("flags a kind:ticket with no criteria section as NO-CRITERIA, naming the issue, without failing on it", () => {
		const r = run([], stubGh([ticket(59, "## What to build\n\nStuff.\n")]));
		expect(r.out).toContain("NO-CRITERIA");
		expect(r.out).toContain("#59");
		expect(r.status).toBe(0);
	});
});

describe("flags and environment", () => {
	it("--warn reports but exits 0", () => {
		const stub = stubGh([ticket(60, CRITERIA("- [ ] unmet"))]);
		const r = run(["--warn"], stub);
		expect(r.out).toContain("WARN");
		expect(r.status).toBe(0);
	});

	it("--json emits machine-readable findings", () => {
		const stub = stubGh([ticket(61, CRITERIA("- [ ] unmet"))]);
		const r = run(["--json"], stub);
		const parsed = JSON.parse(r.out);
		expect(parsed.unverifiedCount).toBe(1);
		expect(parsed.unverified[0].number).toBe(61);
		expect(parsed.unverified[0].items).toEqual(["unmet"]);
		expect(r.status).toBe(1);
	});

	it("exits 0 with SKIP when gh is unavailable, drawing no conclusion", () => {
		const r = run([], stubGh([], { failing: true }));
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("OK:");
		expect(r.status).toBe(0);
	});
});
