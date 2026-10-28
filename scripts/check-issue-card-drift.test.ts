// @vitest-environment node
/*
 * Pins that check-issue-card-drift.js reports an issue whose roadmap card
 * state disagrees with it, in both directions, without reading a closed child
 * ticket as its card being done (mantahostels#275, mantahostels#277).
 *
 * check-issue-card-drift.js shells out to `gh`, so every case here runs with a
 * stub `gh` injected via WFC_GH. That keeps the test hermetic —
 * no network, no auth, no dependence on this repo's actual issue state, which
 * is the very thing the script reports on and therefore cannot be a fixture.
 *
 * The roadmap is likewise a fixture, not docs/reference-roadmap.html: asserting
 * against the live roadmap would make these tests fail whenever a card's state
 * legitimately changes.
 *
 * The `state` case below is not hypothetical. The first draft of the script read
 * the card-state field as `s`; it is `state`. Every card silently read as
 * "(no state)", which would have reported every closed issue as drift. Nothing
 * in the script's own output looked wrong — it needed a card whose state was
 * known to catch it.
 *
 * It runs daily in the repo-checks run, report-only: loosen a case and an
 * issue closed outside /card-close leaves its card describing finished work
 * as outstanding, with no signal anywhere.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StubGh, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-issue-card-drift.js");

let dir: string;
let roadmap: string;

/** Minimal roadmap carrying the same `const ITEMS = [...]` shape the real one has. */
const roadmapHtml = (
	cards: Array<{ id: string; state: string; m?: string }>,
) => `<!doctype html><html><body>
<p class="docmeta">v9.99 · test</p>
<script>
const ITEMS = [
${cards
	.map(
		(c) =>
			`  {id:${JSON.stringify(c.id)}, state:${JSON.stringify(c.state)}, t:"T", p:1${
				c.m === undefined ? "" : `, m:${JSON.stringify(c.m)}`
			}}`,
	)
	.join(",\n")}
];
</script>
</body></html>`;

/** Drop a field gh was never asked for, the way gh itself would. */
const without = (rows: unknown[], field: string) =>
	rows.map((r) => {
		const { [field]: _dropped, ...rest } = r as Record<string, unknown>;
		return rest;
	});

/** Write a stub `gh` returning the given issue lists. */
const stubGh = (
	closed: unknown[],
	open: unknown[],
	{ failing = false } = {},
) => {
	for (const [name, rows] of [
		["closed", closed],
		["open", open],
	] as const) {
		fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rows));
		// gh returns only the fields --json names. Serving `parent` to a script
		// that never asked for it would let the check keep passing these tests
		// after dropping the field from its query — the mutation that first ran
		// straight through this stub unnoticed.
		fs.writeFileSync(
			path.join(dir, `${name}.noparent.json`),
			JSON.stringify(without(rows, "parent")),
		);
	}

	// Match on the exact `--state <x>` pair: the `--json ...closedAt...` argument
	// also contains the substring "closed", so a looser match sends the open
	// query to the closed fixture.
	const script = `#!/bin/sh
case " $* " in
  *" --state closed "*) f=closed ;;
  *" --state open "*)   f=open ;;
  *) echo "[]" ; exit 0 ;;
esac
case " $* " in
  *parent*) cat ${dir}/$f.json ;;
  *)        cat ${dir}/$f.noparent.json ;;
esac
`;
	return stubGhScript(dir, script, { failing });
};

const run = (args: string[] = [], stub?: StubGh) => {
	const r = runInProcess(SCRIPT, [...args, roadmap], {
		env: { ...process.env, ...stub?.env },
	});
	return {
		status: r.status ?? -1,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
	};
};

const issue = (
	number: number,
	title: string,
	parent?: number,
	labels: string[] = [],
) => ({
	number,
	title,
	state: "X",
	closedAt: "2026-07-01T00:00:00Z",
	url: `http://example/${number}`,
	// gh serves `parent` as an object, absent rather than null when there is none.
	...(parent === undefined ? {} : { parent: { number: parent } }),
	labels: labels.map((name) => ({ name })),
});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
	roadmap = path.join(dir, "roadmap.html");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("roadmap parsing", () => {
	it("reads the card state field, not a same-shaped neighbour", () => {
		// `done-card` is done; a closed issue against it is NOT drift. If the state
		// field is misread, this reports drift and fails — the regression that
		// prompted this test.
		fs.writeFileSync(
			roadmap,
			roadmapHtml([{ id: "done-card", state: "done" }]),
		);
		const stub = stubGh([issue(1, "done-card — finished")], []);
		const r = run([], stub);
		expect(r.out).toContain("OK: no issue/card drift");
		expect(r.status).toBe(0);
	});

	it("refuses rather than reporting mass drift when no card has a state", () => {
		fs.writeFileSync(
			roadmap,
			'<script>\nconst ITEMS = [\n  {id:"a", s:"done", t:"T"}\n];\n</script>',
		);
		const r = run([], stubGh([issue(1, "a — x")], []));
		expect(r.out).toContain("no card in");
		expect(r.status).toBe(2);
	});

	it("exits 2 on an unreadable roadmap", () => {
		const r = runInProcess(SCRIPT, ["/nonexistent/roadmap.html"]);
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toContain("cannot read");
	});
});

describe("drift detection", () => {
	beforeEach(() => {
		fs.writeFileSync(
			roadmap,
			roadmapHtml([
				{ id: "done-card", state: "done" },
				{ id: "active-card", state: "active" },
			]),
		);
	});

	it("flags a closed issue whose card is not done as CLOSED-BUT-NOT-DONE, naming the issue", () => {
		const r = run([], stubGh([issue(7, "active-card — closed early")], []));
		expect(r.out).toContain("CLOSED-BUT-NOT-DONE");
		expect(r.out).toContain("#7");
		expect(r.status).toBe(1);
	});

	it("flags a done card whose issue is still open as DONE-BUT-STILL-OPEN, naming the issue", () => {
		const r = run([], stubGh([], [issue(8, "done-card — still open")]));
		expect(r.out).toContain("DONE-BUT-STILL-OPEN");
		expect(r.out).toContain("#8");
		expect(r.status).toBe(1);
	});

	it("reports no drift when both sides agree", () => {
		const r = run(
			[],
			stubGh([issue(9, "done-card — done")], [issue(10, "active-card — open")]),
		);
		expect(r.out).toContain("OK: no issue/card drift");
		expect(r.status).toBe(0);
	});

	it("downgrades drift to exit 0 under --warn", () => {
		const r = run(["--warn"], stubGh([issue(7, "active-card — closed")], []));
		expect(r.out).toContain("WARN");
		expect(r.status).toBe(0);
	});
});

describe("titles it will not guess at", () => {
	beforeEach(() => {
		fs.writeFileSync(
			roadmap,
			roadmapHtml([{ id: "real-card", state: "done" }]),
		);
	});

	it("reports an unparseable title instead of matching on text", () => {
		const r = run([], stubGh([issue(3, "no separator here")], []));
		expect(r.out).toContain("UNPARSEABLE TITLE");
		expect(r.status).toBe(0); // reported, but not drift
	});

	// Only an unparented issue could have been a card's own issue, so a parented
	// one is counted rather than listed — the 170-of-189 wall mantahostels#277 removed.
	it("counts a parented unparseable title instead of listing it", () => {
		const r = run(
			[],
			stubGh(
				[
					issue(3, "no separator here"),
					issue(5, "a child ticket", 145),
					issue(6, "another child ticket", 211),
				],
				[],
			),
		);
		expect(r.out).toContain("UNPARSEABLE TITLE (1 of 3)");
		expect(r.out).toContain('#3 "no separator here"');
		expect(r.out).toContain("2 parented, omitted");
		expect(r.out).not.toContain("a child ticket");
		expect(r.status).toBe(0);
	});

	it("still reports the count when every unparseable title is parented", () => {
		const r = run([], stubGh([issue(5, "a child ticket", 145)], []));
		expect(r.out).toContain("UNPARSEABLE TITLE (0 of 1)");
		expect(r.out).toContain("1 parented, omitted");
		expect(r.status).toBe(0);
	});

	it("keeps every parented unparseable issue in the --json payload", () => {
		const r = run(["--json"], stubGh([issue(5, "a child ticket", 145)], []));
		expect(JSON.parse(r.out).unparseableParented).toHaveLength(1);
	});

	it("reports a title naming no card rather than fuzzy-matching", () => {
		const r = run([], stubGh([issue(4, "ghost-card — gone")], []));
		expect(r.out).toContain("UNKNOWN CARD");
		expect(r.status).toBe(0);
	});
});

describe("child tickets are not their card", () => {
	beforeEach(() => {
		fs.writeFileSync(
			roadmap,
			roadmapHtml([
				{ id: "done-card", state: "done" },
				{ id: "active-card", state: "active" },
			]),
		);
	});

	it("does not read a closed child ticket as its card finishing early", () => {
		const r = run([], stubGh([issue(7, "active-card — a child", 145)], []));
		expect(r.out).not.toContain("CLOSED-BUT-NOT-DONE");
		expect(r.out).toContain("CHILD TICKETS (1)");
		expect(r.out).toContain("1 under #145");
		expect(r.status).toBe(0);
	});

	it("does not read an open child ticket as its card's issue left open", () => {
		const r = run([], stubGh([], [issue(8, "done-card — a child", 96)]));
		expect(r.out).not.toContain("DONE-BUT-STILL-OPEN");
		expect(r.out).toContain("CHILD TICKETS (1)");
		expect(r.status).toBe(0);
	});

	// The other half of the bargain: suppression keyed on parentage must not
	// swallow the card's own issue, which is what the check exists to catch.
	it("still flags an unparented issue against a card that is not done as CLOSED-BUT-NOT-DONE, naming the issue", () => {
		const r = run([], stubGh([issue(9, "active-card — the card itself")], []));
		expect(r.out).toContain("CLOSED-BUT-NOT-DONE");
		expect(r.out).toContain("#9");
		expect(r.status).toBe(1);
	});

	it("groups the exclusions by parent rather than listing every child", () => {
		const r = run(
			[],
			stubGh(
				[
					issue(1, "active-card — one", 145),
					issue(2, "active-card — two", 145),
					issue(3, "active-card — three", 211),
				],
				[],
			),
		);
		expect(r.out).toContain("CHILD TICKETS (3)");
		expect(r.out).toContain("2 under #145");
		expect(r.out).toContain("1 under #211");
		expect(r.out).not.toContain("#3 ");
		expect(r.status).toBe(0);
	});
});

// mantahostels#1173: a card's "—" and its own issue's takes:human label are one concept,
// reported when they disagree, never blocked.
describe('"—" / takes:human mismatch (mantahostels#1173)', () => {
	beforeEach(() => {
		fs.writeFileSync(
			roadmap,
			roadmapHtml([
				{ id: "dash-card", state: "open", m: "—" },
				{ id: "human-card", state: "open" },
			]),
		);
	});

	it('flags a "—" card whose own issue lacks takes:human, naming the issue and its card, without gating', () => {
		const r = run([], stubGh([], [issue(1, "dash-card — no label")]));
		expect(r.out).toContain('"—" CARD, ISSUE NOT takes:human (1)');
		expect(r.out).toContain("#1 dash-card");
		expect(r.status).toBe(0); // reported, never blocked
	});

	it('does not flag a "—" card whose own issue carries takes:human', () => {
		const r = run(
			[],
			stubGh(
				[],
				[issue(1, "dash-card — labelled", undefined, ["takes:human"])],
			),
		);
		expect(r.out).not.toContain('"—" CARD, ISSUE NOT takes:human');
	});

	it('flags an unparented takes:human issue whose card is not "—", naming the issue and its card, without gating', () => {
		const r = run(
			[],
			stubGh(
				[],
				[issue(2, "human-card — labelled", undefined, ["takes:human"])],
			),
		);
		expect(r.out).toContain('takes:human ISSUE, CARD NOT "—" (1)');
		expect(r.out).toContain("#2 human-card");
		expect(r.status).toBe(0);
	});

	it("does not flag a takes:human CHILD issue under a card with real build work", () => {
		const r = run(
			[],
			stubGh([], [issue(3, "human-card — a child", 999, ["takes:human"])]),
		);
		expect(r.out).not.toContain("takes:human ISSUE, CARD NOT");
	});

	it('a "—" card with no issue at all is not flagged', () => {
		const r = run([], stubGh([], []));
		expect(r.out).not.toContain('"—" CARD, ISSUE NOT takes:human');
	});

	// A card id can carry more than one unparented issue in practice (a stale
	// spin-off, a reopened one) — every one must be checked, not just one.
	it('flags every unparented own issue on a "—" card, not just one, naming only the one lacking takes:human', () => {
		const r = run(
			[],
			stubGh(
				[],
				[
					issue(4, "dash-card — first", undefined, ["takes:human"]),
					issue(5, "dash-card — second, missing the label"),
				],
			),
		);
		expect(r.out).toContain('"—" CARD, ISSUE NOT takes:human (1)');
		expect(r.out).toContain("#5 dash-card");
		expect(r.out).not.toContain("#4 dash-card");
	});
});

describe("environment failures are not drift findings", () => {
	it("SKIPs, exit 0, when gh cannot answer", () => {
		fs.writeFileSync(roadmap, roadmapHtml([{ id: "a", state: "done" }]));
		const r = run([], stubGh([], [], { failing: true }));
		expect(r.out).toContain("SKIP");
		expect(r.out).toContain("No drift conclusion drawn");
		expect(r.status).toBe(0);
	});
});
