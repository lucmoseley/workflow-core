// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StubGh, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "check-issue-card-drift.js");

let dir: string;
let roadmap: string;

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

const without = (rows: unknown[], field: string) =>
	rows.map((r) => {
		const { [field]: _dropped, ...rest } = r as Record<string, unknown>;
		return rest;
	});

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
		fs.writeFileSync(
			path.join(dir, `${name}.noparent.json`),
			JSON.stringify(without(rows, "parent")),
		);
	}

	const script = `#!/bin/sh
case " $* " in
  *" --state closed "*) f=closed ;;
  *" --state open "*)   f=open ;;
  *) echo "[]" ; exit 0 ;;
esac
case " $* " in
  *parent*) cat ${shellQuote(dir)}/$f.json ;;
  *)        cat ${shellQuote(dir)}/$f.noparent.json ;;
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
		expect(r.status).toBe(0);
	});

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
		expect(r.status).toBe(0);
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
