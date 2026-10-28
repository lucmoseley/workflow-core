// @vitest-environment node
/*
 * Pins that check-stale-claims.js reports an open issue assigned long ago with
 * no sign of work since, never gates or unassigns, and says what it could not
 * read rather than calling it clean.
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth, and no
 * dependence on this repo's own issue state — which is what the script reports
 * on and so cannot also be its fixture.
 *
 * The fixtures are the measured cases from mantahostels#270 (a spun-off ticket created
 * already assigned): an issue assigned one second after creation and untouched
 * since, the shape that hid 9 of 41 open issues from selection.
 *
 * It runs daily in the repo-checks run, report-only: loosen a case and work
 * claimed by the session that merely filed it stays off the /wayfinder
 * frontier unseen.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GH_LOGGED_OUT_NODE, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-stale-claims.js");

let dir: string;

interface Event {
	event: string;
	created_at: string;
}

interface Issue {
	number: number;
	title?: string;
	assignees?: string[];
	pull_request?: object;
}

interface Fixture {
	issues: Issue[];
	/** issue number -> its timeline events */
	timeline?: Record<number, Event[]>;
	/** issue numbers whose timeline call returns an HTTP error */
	failTimeline?: number[];
	/** issue numbers whose timeline call fails with the SAME error text —
	 *  for the >3-failures-collapse case (#93), where failTimeline's own
	 *  per-issue text would defeat the "same error" grouping under test. */
	failTimelineSame?: number[];
	/** the issues list call itself fails */
	failList?: boolean;
	/** what that failure says — defaults to the unauthenticated spelling */
	listError?: string;
	/** every call fails the way an unauthenticated gh does */
	unreachable?: boolean;
}

const daysAgo = (d: number) =>
	new Date(Date.now() - d * 864e5).toISOString().replace(/\.\d+Z$/, "Z");

/** An `assigned` event `d` days old, plus any activity events after it. */
const claimed = (d: number, since: Event[] = []): Event[] => [
	{ event: "assigned", created_at: daysAgo(d) },
	...since,
];

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
// --slurp wraps each page's array; one page is enough for every fixture here.
const page = (rows) => process.stdout.write(JSON.stringify([rows]) + "\\n");

if (fx.unreachable) { ${GH_LOGGED_OUT_NODE} }

if (/\\/timeline/.test(p)) {
  const n = num(/issues\\/(\\d+)\\/timeline/);
  if ((fx.failTimeline || []).includes(n)) die("HTTP 502 (timeline/" + n + ")");
  if ((fx.failTimelineSame || []).includes(n)) die("Service Unavailable (HTTP 503)");
  return page((fx.timeline || {})[n] || []);
}
if (/^repos\\/[^/]+\\/[^/]+$/.test(p))
  return process.stdout.write(JSON.stringify({ open_issues_count: fx.issues.length }) + "\\n");
if (/\\/issues$/.test(p)) {
  if (fx.failList) die(fx.listError || "HTTP 401: Bad credentials");
  return page(fx.issues.map((i) => ({
    number: i.number,
    title: i.title || ("issue " + i.number),
    html_url: "http://example/" + i.number,
    assignees: (i.assignees || []).map((login) => ({ login })),
    pull_request: i.pull_request,
  })));
}
die("unexpected path: " + p);
`;
	return stubGhScript(dir, stub);
};

const run = (fx: Fixture, args: string[] = []) => {
	const stub = stubGh(fx);
	const r = runInProcess(SCRIPT, args, {
		env: { ...process.env, ...stub.env, GITHUB_ACTIONS: "" },
	});
	const log = CALL_LOG();
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		calls: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
				: [],
		json: () => JSON.parse(r.stdout),
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-claims-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("probably-dead claims", () => {
	it("reports a claim older than the threshold with nothing since", () => {
		const r = run({
			issues: [{ number: 230, title: "spun off", assignees: ["owner"] }],
			timeline: { 230: claimed(40) },
		});
		expect(r.out).toContain("STALE-CLAIM");
		expect(r.out).toContain("#230");
		expect(r.out).toContain("owner");
		expect(r.out).toMatch(/40 days/);
	});

	it("stays silent on a claim younger than the threshold", () => {
		const r = run({
			issues: [{ number: 262, assignees: ["owner"] }],
			timeline: { 262: claimed(3) },
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
		expect(r.out).not.toContain("STALE-CLAIM");
	});

	it.each(["commented", "referenced", "committed", "cross-referenced"])(
		"stays silent when the claim shows %s since",
		(event) => {
			const r = run({
				issues: [{ number: 145, assignees: ["owner"] }],
				timeline: { 145: claimed(40, [{ event, created_at: daysAgo(2) }]) },
			});
			expect(r.out).not.toContain("STALE-CLAIM");
		},
	);

	it("ignores activity that predates the assignment", () => {
		// The spin-off shape: an issue discussed, then filed and assigned.
		const r = run({
			issues: [{ number: 249, assignees: ["owner"] }],
			timeline: {
				249: [
					{ event: "commented", created_at: daysAgo(41) },
					{ event: "assigned", created_at: daysAgo(40) },
				],
			},
		});
		expect(r.out).toContain("STALE-CLAIM");
	});

	it("ignores chatter that is not work — a label, a title edit", () => {
		const r = run({
			issues: [{ number: 253, assignees: ["owner"] }],
			timeline: {
				253: claimed(40, [
					{ event: "labeled", created_at: daysAgo(1) },
					{ event: "renamed", created_at: daysAgo(1) },
				]),
			},
		});
		expect(r.out).toContain("STALE-CLAIM");
	});

	it("dates the claim from the most recent assignment, not the first", () => {
		const r = run({
			issues: [{ number: 261, assignees: ["owner"] }],
			timeline: {
				261: [
					{ event: "assigned", created_at: daysAgo(90) },
					{ event: "assigned", created_at: daysAgo(2) },
				],
			},
		});
		expect(r.out).not.toContain("STALE-CLAIM");
	});

	it("skips unassigned issues without asking for their timeline", () => {
		const r = run({ issues: [{ number: 263 }, { number: 264 }] });
		expect(r.status).toBe(0);
		expect(r.calls().filter((c) => /timeline/.test(c))).toHaveLength(0);
	});

	it("ignores pull requests, which share the number space", () => {
		const r = run({
			issues: [{ number: 99, assignees: ["owner"], pull_request: {} }],
			timeline: { 99: claimed(40) },
		});
		expect(r.out).not.toContain("STALE-CLAIM");
	});
});

describe("never gates, never writes", () => {
	it("exits 0 on a finding — WARN, not FAIL", () => {
		const r = run({
			issues: [{ number: 230, assignees: ["owner"] }],
			timeline: { 230: claimed(40) },
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).not.toContain("FAIL");
	});

	it("issues nothing but gh api GETs — no other method, no assignees endpoint", () => {
		const r = run({
			issues: [{ number: 230, assignees: ["owner"] }],
			timeline: { 230: claimed(40) },
		});
		for (const call of r.calls()) {
			expect(call.split(" ")[0]).toBe("api");
			expect(call).not.toMatch(/(^|\s)(-X|--method)\s+(?!GET(\s|$))/);
			// gh api turns a call carrying -f fields into a POST unless told GET.
			if (/(^|\s)-[fF]\s/.test(call))
				expect(call).toMatch(/(^|\s)-X GET(\s|$)/);
		}
		expect(r.calls().join("\n")).not.toMatch(/assignees/);
		expect(r.out).toMatch(/never unassigns/);
	});
});

describe("what it could not read", () => {
	it("reports an unreadable timeline rather than passing it as clean", () => {
		const r = run({
			issues: [{ number: 236, assignees: ["owner"] }],
			failTimeline: [236],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("UNREADABLE");
		expect(r.out).toContain("#236");
	});

	it("reports an assigned issue whose timeline records no assignment", () => {
		const r = run({
			issues: [{ number: 239, assignees: ["owner"] }],
			timeline: { 239: [{ event: "labeled", created_at: daysAgo(5) }] },
		});
		expect(r.out).toContain("UNREADABLE");
	});

	it("collapses more than 3 unreadable claims failing the same way into one line (#93)", () => {
		const numbers = [301, 302, 303, 304];
		const r = run({
			issues: numbers.map((number) => ({ number, assignees: ["owner"] })),
			failTimelineSame: numbers,
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("UNREADABLE (4)");
		expect(r.out).toContain(
			"4 failing the same way — gh: Service Unavailable (HTTP 503)",
		);
		for (const n of numbers) expect(r.out).toContain(`#${n}`);
		// collapsed, not one block each: no per-issue title/url line for these
		for (const n of numbers) expect(r.out).not.toContain(`issue ${n}\n`);
	});

	it("keeps individual blocks for 3 or fewer sharing the same error (#93)", () => {
		const numbers = [401, 402, 403];
		const r = run({
			issues: numbers.map((number) => ({ number, assignees: ["owner"] })),
			failTimelineSame: numbers,
		});
		expect(r.status).toBe(0);
		expect(r.out).not.toMatch(/failing the same way/);
		for (const n of numbers) {
			expect(r.out).toContain(`#${n} issue ${n}`);
			expect(r.out).toContain("Service Unavailable (HTTP 503)");
		}
	});

	it("SKIPs rather than passing when gh is unavailable", () => {
		const r = run({ issues: [], unreachable: true });
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("OK:");
	});

	it("SKIPs when the issue list fails for want of credentials", () => {
		const r = run({ issues: [], failList: true });
		expect(r.status).toBe(0); // a 401 is an unreachable GitHub, not a fault here
		expect(r.out).toContain("SKIP");
	});

	it("is BROKEN when a gh failure is the call's own fault", () => {
		// The mantahostels#164 split: a malformed request is the check breaking, not GitHub
		// being unreachable.
		const r = run({ issues: [], failList: true, listError: "HTTP 422" });
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});
});

describe("modes", () => {
	it("--json carries each claim's age and assignee", () => {
		const r = run(
			{
				issues: [{ number: 230, title: "spun off", assignees: ["owner"] }],
				timeline: { 230: claimed(40) },
			},
			["--json"],
		);
		expect(r.json()).toMatchObject({
			staleCount: 1,
			stale: [{ number: 230, assignees: ["owner"] }],
		});
		expect(r.json().stale[0].ageDays).toBeGreaterThanOrEqual(39);
	});
});
