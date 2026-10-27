// @vitest-environment node
/*
 * Pins that check-open-maps.js reports an open `wayfinder:map` with no open
 * child (mantahostels#1206), a closed child missing from its map's decision
 * record (mantahostels#1862), and a map near GitHub's sub-issue cap (#92) — and
 * never gates or writes.
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth, and no
 * dependence on this repo's own tracker state — which is what the script
 * reports on and so cannot also be its fixture.
 *
 * It runs daily in the repo-checks run, report-only: loosen a case and a
 * map's destination sits with no ticket toward it, a decision leaves its map,
 * or a map hits the 100-child cap unwarned.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_LOGGED_OUT_NODE, stubGhScript } from "./lib/gh-stub";

const SCRIPT = path.resolve(__dirname, "check-open-maps.js");

let dir: string;

interface SubIssue {
	number: number;
	state: "open" | "closed";
	pull_request?: object;
}

interface Map {
	number: number;
	title?: string;
	pull_request?: object;
	body?: string;
	labels?: string[];
	/** undefined means the sub_issues call is never reached for this map. */
	children?: SubIssue[];
	/** the sub_issues call for this one map returns an HTTP error */
	failChildren?: boolean;
}

interface Fixture {
	maps: Map[];
	/** the maps list call itself fails */
	failList?: boolean;
	listError?: string;
	unreachable?: boolean;
}

const CALL_LOG = () => path.join(dir, "calls.log");

const stubGh = (fx: Fixture) => {
	fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(fx));

	const stub = `#!/usr/bin/env node
const fs = require("node:fs");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "fixture.json"))}, "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALL_LOG())}, argv.join(" ") + "\\n");

const p = argv.find((a) => a.startsWith("repos/")) || "";
const num = (re) => { const m = p.match(re); return m ? Number(m[1]) : null; };
const die = (msg) => { process.stderr.write("gh: " + msg + "\\n"); process.exit(1); };
const page = (rows) => process.stdout.write(JSON.stringify([rows]) + "\\n");

if (fx.unreachable) { ${GH_LOGGED_OUT_NODE} }

if (/\\/sub_issues/.test(p)) {
  const n = num(/issues\\/(\\d+)\\/sub_issues/);
  const m = fx.maps.find((x) => x.number === n);
  if (m && m.failChildren) die("HTTP 502 (sub_issues/" + n + ")");
  return page((m && m.children) || []);
}
if (/\\/issues$/.test(p)) {
  if (fx.failList) die(fx.listError || "HTTP 401: Bad credentials");
  return page(fx.maps.map((m) => ({
    number: m.number,
    title: m.title || ("map " + m.number),
    html_url: "http://example/" + m.number,
    pull_request: m.pull_request,
    body: m.body,
    labels: (m.labels || []).map((name) => ({ name })),
  })));
}
die("unexpected path: " + p);
`;
	return stubGhScript(dir, stub);
};

const run = (fx: Fixture, args: string[] = []) => {
	const stub = stubGh(fx);
	const r = spawnSync("node", [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...stub.env, GITHUB_ACTIONS: "" },
	});
	const log = CALL_LOG();
	return {
		status: r.status ?? -1,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		calls: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
				: [],
		json: () => JSON.parse(r.stdout ?? ""),
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-maps-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("undischarged maps", () => {
	it("reports an open map whose children are all closed", () => {
		const r = run({
			maps: [
				{
					number: 8,
					title: "taglines",
					children: [{ number: 9, state: "closed" }],
				},
			],
		});
		expect(r.out).toContain("UNDISCHARGED-MAP");
		expect(r.out).toContain("#8");
		expect(r.out).toContain("taglines");
		// The way out, not just the fault (§X3): a scoping decision, not a close.
		expect(r.out).toContain("takes:triage");
		expect(r.out).toContain("never close by hand");
	});

	it.each(["takes:to-spec", "takes:wayfinder", "takes:triage"])(
		"does not report a map with no open child already under %s (#2267)",
		(label) => {
			const r = run({
				maps: [
					{
						number: 8,
						labels: ["wayfinder:map", label],
						body: "## Decisions so far\n\n- **#9** — landed.\n",
						children: [{ number: 9, state: "closed" }],
					},
				],
			});
			expect(r.status).toBe(0);
			expect(r.out).not.toContain("UNDISCHARGED-MAP");
		},
	);

	it("still reports a map with no open child under takes:children (#2267)", () => {
		const r = run({
			maps: [
				{
					number: 8,
					labels: ["wayfinder:map", "takes:children"],
					children: [{ number: 9, state: "closed" }],
				},
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("UNDISCHARGED-MAP");
		expect(r.out).toContain("#8");
	});

	it("stays silent when a map has at least one open child", () => {
		const r = run({
			maps: [
				{
					number: 8,
					body: "## Decisions so far\n\n- **#9** — landed.\n",
					children: [
						{ number: 9, state: "closed" },
						{ number: 10, state: "open" },
					],
				},
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
		expect(r.out).not.toContain("UNDISCHARGED-MAP");
	});

	it("does not count an open pull request as an open child", () => {
		const r = run({
			maps: [
				{
					number: 8,
					children: [{ number: 10, state: "open", pull_request: {} }],
				},
			],
		});
		expect(r.out).toContain("UNDISCHARGED-MAP");
	});

	it("reports a map with no sub-issues at all as unreadable, not undischarged", () => {
		const r = run({ maps: [{ number: 8, children: [] }] });
		expect(r.out).toContain("UNREADABLE-MAP");
		expect(r.out).toContain("never linked");
		expect(r.out).not.toContain("UNDISCHARGED-MAP");
	});

	it("reports a map whose children could not be read as unreadable", () => {
		const r = run({
			maps: [
				{
					number: 8,
					children: [{ number: 9, state: "open" }],
					failChildren: true,
				},
			],
		});
		expect(r.out).toContain("UNREADABLE-MAP");
		expect(r.out).toContain("#8");
	});

	it("carries counts in --json", () => {
		const r = run(
			{
				maps: [
					{ number: 8, children: [{ number: 9, state: "closed" }] },
					{
						number: 10,
						children: [{ number: 11, state: "open" }],
					},
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.maps).toBe(2);
		expect(j.undischargedCount).toBe(1);
		expect(j.undischarged[0].number).toBe(8);
	});

	it("names a routed map with no open child in --json, not as undischarged (#2267)", () => {
		const r = run(
			{
				maps: [
					{
						number: 8,
						labels: ["takes:to-spec"],
						body: "## Decisions so far\n\n- **#9** — landed.\n",
						children: [{ number: 9, state: "closed" }],
					},
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.undischargedCount).toBe(0);
		expect(j.routedCount).toBe(1);
		expect(j.routed[0].number).toBe(8);
	});
});

describe("missing decision pointers", () => {
	const buildMapBody = (extra = "") => `## Decisions so far

- **#9** — landed, did the thing.
${extra}
## Out of scope

- not this
`;

	it("reports a closed child absent from both Decisions-so-far and Out-of-scope", () => {
		const r = run({
			maps: [
				{
					number: 8,
					title: "a map",
					body: buildMapBody(),
					children: [
						{ number: 9, state: "closed" },
						{ number: 12, state: "closed" },
						{ number: 20, state: "open" },
					],
				},
			],
		});
		expect(r.out).toContain("MISSING-DECISION");
		expect(r.out).toContain("#12");
		expect(r.out).toContain("map #8");
		expect(r.out).not.toMatch(/MISSING-DECISION[\s\S]*#9\b/);
		// The way out, not just the fault (§X3): the repair command, not just the gap.
		expect(r.out).toContain("scripts/issue-body.js append-section");
		expect(r.out).toContain('--heading "Decisions so far"');
	});

	it("mutation: removing the pointer line makes the check report that child, restoring it clears it", () => {
		const withPointer = buildMapBody();
		const withoutPointer = `## Decisions so far

## Out of scope

- not this
`;

		const broken = run({
			maps: [
				{
					number: 8,
					body: withoutPointer,
					children: [{ number: 9, state: "closed" }],
				},
			],
		});
		expect(broken.out).toContain("MISSING-DECISION");
		expect(broken.out).toContain("#9");

		const fixed = run({
			maps: [
				{
					number: 8,
					body: withPointer,
					children: [{ number: 9, state: "closed" }],
				},
			],
		});
		expect(fixed.out).not.toContain("MISSING-DECISION");
	});

	it("accepts a pointer in Out of scope as well as Decisions so far", () => {
		const r = run({
			maps: [
				{
					number: 8,
					body: `## Decisions so far

## Out of scope

- **#9** — ruled out, past the destination.
`,
					children: [{ number: 9, state: "closed" }],
				},
			],
		});
		expect(r.out).not.toContain("MISSING-DECISION");
	});

	it("does not match a longer number sharing the same prefix", () => {
		const r = run({
			maps: [
				{
					number: 8,
					body: `## Decisions so far

- **#180** — unrelated ticket.
`,
					children: [{ number: 18, state: "closed" }],
				},
			],
		});
		expect(r.out).toContain("MISSING-DECISION");
		expect(r.out).toContain("#18");
	});

	it("is silent on a map whose closed children all carry pointers", () => {
		const r = run({
			maps: [
				{
					number: 8,
					body: buildMapBody(),
					children: [{ number: 9, state: "closed" }],
				},
			],
		});
		expect(r.out).not.toContain("MISSING-DECISION");
	});

	it("is silent on a map with no closed children", () => {
		const r = run({
			maps: [
				{
					number: 8,
					body: "## Decisions so far\n",
					children: [{ number: 9, state: "open" }],
				},
			],
		});
		expect(r.out).not.toContain("MISSING-DECISION");
	});

	it("never gates on a missing pointer — WARN, exit 0", () => {
		const r = run({
			maps: [
				{
					number: 8,
					body: "## Decisions so far\n",
					children: [{ number: 9, state: "closed" }],
				},
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});

	it("carries missingPointers in --json", () => {
		const r = run(
			{
				maps: [
					{
						number: 8,
						body: "## Decisions so far\n",
						children: [{ number: 9, state: "closed" }],
					},
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.missingPointersCount).toBe(1);
		expect(j.missingPointers[0].child).toBe(9);
		expect(j.missingPointers[0].map).toBe(8);
	});
});

describe("map near the sub-issue cap", () => {
	const kids = (n: number, state: "open" | "closed" = "open") =>
		Array.from({ length: n }, (_, i) => ({ number: 100 + i, state }));

	it("warns once a map's sub-issue total reaches 90, closed ones counted, naming the map and offering scripts/archive-closed-children.js as the way out", () => {
		const r = run({
			maps: [
				{
					number: 8,
					title: "taglines",
					children: [...kids(45), ...kids(45, "closed")],
				},
			],
		});
		expect(r.out).toContain("MAP-NEAR-CAP");
		expect(r.out).toContain("#8");
		expect(r.out).toContain("90 sub-issue(s)");
		expect(r.out).toContain("scripts/archive-closed-children.js");
	});

	it("stays silent below the threshold", () => {
		const r = run({
			maps: [{ number: 8, children: [...kids(1), ...kids(87, "closed")] }],
		});
		expect(r.out).not.toContain("MAP-NEAR-CAP");
	});

	it("carries nearCap in --json", () => {
		const r = run(
			{
				maps: [{ number: 8, title: "taglines", children: kids(90, "closed") }],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.nearCapCount).toBe(1);
		expect(j.nearCap[0]).toMatchObject({ number: 8, count: 90 });
	});
});

describe("never gates, never writes", () => {
	it("exits 0 on a finding — WARN, not FAIL", () => {
		const r = run({
			maps: [{ number: 8, children: [{ number: 9, state: "closed" }] }],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).not.toContain("FAIL");
	});

	it("issues nothing but gh api GETs — no other method", () => {
		const r = run({
			maps: [{ number: 8, children: [{ number: 9, state: "closed" }] }],
		});
		for (const call of r.calls()) {
			expect(call.split(" ")[0]).toBe("api");
			expect(call).not.toMatch(/(^|\s)(-X|--method)\s+(?!GET(\s|$))/);
			// gh api turns a call carrying -f fields into a POST unless told GET.
			if (/(^|\s)-[fF]\s/.test(call))
				expect(call).toMatch(/(^|\s)-X GET(\s|$)/);
		}
	});
});

describe("failure handling", () => {
	it("SKIPs at exit 0 when GitHub is unreachable", () => {
		const r = run({ maps: [], unreachable: true });
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
	});

	it("is BROKEN (exit 2) when the maps list fails for a reason other than unreachable", () => {
		const r = run({ maps: [], failList: true, listError: "HTTP 500" });
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});

	it("scopes a per-map read failure to that map, not the whole run", () => {
		const r = run({
			maps: [
				{ number: 8, children: [{ number: 9, state: "closed" }] },
				{
					number: 10,
					children: [{ number: 11, state: "open" }],
					failChildren: true,
				},
			],
		});
		expect(r.out).toContain("UNDISCHARGED-MAP");
		expect(r.out).toContain("#8");
		expect(r.out).toContain("UNREADABLE-MAP");
		expect(r.out).toContain("#10");
	});
});
