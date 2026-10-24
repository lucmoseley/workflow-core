// @vitest-environment node
/*
 * Pins which issue-body edits check-clobbered-bodies.js reports as one
 * session's write erasing another's, and which honest edits it lets pass
 * (mantahostels#128, the ruling that a body write cannot be made conditional).
 *
 * check-clobbered-bodies.js reads one input — GitHub's record of every past
 * issue body — so every case here fakes it with a stub `gh` injected via
 * WFC_GH. Reading this repo's real issues would make the tests assert the very
 * thing the script reports on, so they would flip red the moment a real clobber
 * happened.
 *
 * The cases that matter are the NEGATIVE ones. A concision pass, a line edited
 * in place, a checkbox ticked, and a loss that was already put back each get a
 * case (the false positives they pin: mantahostels#302 for the reworded
 * restoration, mantahostels#141 for the other three).
 *
 * The script exits 1 on CLOBBERED alone, its one finding that gates in
 * scripts/lib/check.js's alphabet; nothing that runs it gates on that exit.
 * Loosen a case and a lost edit goes unreported, since GitHub tells both
 * writers they succeeded, or honest edits flood the report until it is ignored.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withHostConfig } from "./lib/config-testkit";
import { type StubGh, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-clobbered-bodies.js");

const hostRoot = withHostConfig({ tracker: "owner/repo" });

/* Pins the script's clock to the fixtures' anchor: the script reads the real
 * wall clock otherwise, and the default 30-day --since window drifts past the
 * hardcoded 2026-08-01 revisions as real time passes them (mantahostels#2176). */
const NOW = "2026-08-01T12:00:00Z";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "clobber-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/* Substantial: the script ignores lines under 40 characters, which are headings
 * and bullets shared by every revision. */
const L = (tag: string) =>
	`- [${tag}](https://github.com/owner/repo/issues/1) — the ruling recorded for ${tag}`;

const body = (...ls: string[]) => ls.join("\n");

interface Issue {
	number: number;
	title?: string;
	/** Past bodies, OLDEST first — the fixture is written newest-first for us. */
	revisions: { at: string; body: string }[];
	/** Defaults to the newest revision, as GitHub itself reports it. */
	current?: string;
	lastEditedAt?: string;
	/** Defaults to lastEditedAt — never earlier, as on GitHub. */
	updatedAt?: string;
}

/* The stub answers the issue listing (sorted
 * when the query asks for UPDATED_AT), issues fetched by number (aliases
 * `i<N>: issue` selecting `lastEditedAt`; one not in the fixture is NOT_FOUND,
 * exiting 1 over the printed response as real gh does), a batched first page
 * of histories (the same aliases), and one issue's later history page (`-F n=`).
 * Cursors are offsets. `bump` moves one issue's `updatedAt` once the listing has been
 * called `after` times, as an update landing mid-listing does. */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const [fixtureFile, callsFile] = [process.env.FIXTURE, process.env.CALLS];
const fx = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const args = process.argv.slice(2);
const query = (args.find((a) => a.startsWith("query=")) || "").slice(6);
const vars = Object.fromEntries(
  args.filter((a) => /^(n|cursor)=/.test(a)).map((a) => a.split("=")),
);
fs.appendFileSync(callsFile, JSON.stringify({ query, vars }) + "\\n");
const page = (items, from, size) => ({
  pageInfo: { hasNextPage: from + size < items.length, endCursor: String(from + size) },
  nodes: items.slice(from, from + size),
});
const edits = (n, from) =>
  page(fx.hist[n], from, Number(/userContentEdits\\(first:(\\d+)/.exec(query)[1]));
let data;
if (query.includes("issues(")) {
  const listed = fs.readFileSync(callsFile, "utf8").split("issues(").length - 1;
  if (fx.bump && listed > fx.bump.after)
    fx.nodes.find((i) => i.number === fx.bump.number).updatedAt = fx.bump.updatedAt;
  const nodes = query.includes("UPDATED_AT")
    ? [...fx.nodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : fx.nodes;
  data = { repository: { issues: page(nodes, Number(vars.cursor || 0), fx.listPage) } };
} else if (query.includes("lastEditedAt")) {
  const repository = {};
  const errors = [];
  for (const [, n] of query.matchAll(/i(\\d+): issue/g)) {
    repository["i" + n] = fx.nodes.find((i) => i.number === Number(n)) || null;
    if (!repository["i" + n])
      errors.push({ type: "NOT_FOUND", path: ["repository", "i" + n], message: "Could not resolve to an Issue with the number of " + n + "." });
  }
  if (errors.length > 0) {
    process.stdout.write(JSON.stringify({ data: { repository }, errors }));
    process.stderr.write("gh: " + errors[0].message + "\\n");
    process.exit(1);
  }
  data = { repository };
} else if (vars.n) {
  data = { repository: { issue: { userContentEdits: edits(vars.n, Number(vars.cursor || 0)) } } };
} else {
  const repository = {};
  for (const [, n] of query.matchAll(/i(\\d+): issue/g))
    repository["i" + n] = { userContentEdits: edits(n, 0) };
  data = { repository };
}
process.stdout.write(JSON.stringify({ data, ...(fx.errors ? { errors: fx.errors } : {}) }));
`;

/** A stub `gh` serving the issue list and each issue's revision history. */
const stubGh = (
	issues: Issue[],
	{
		failing = false,
		graphqlError = false,
		errorMessage = "Something went wrong",
		listPage = 100, // the script's own `issues(first:100`
		bump = undefined as
			| { after: number; number: number; updatedAt: string }
			| undefined,
	} = {},
) => {
	const fixture = path.join(dir, "fixture.json");
	const calls = path.join(dir, "calls.jsonl");
	fs.rmSync(calls, { force: true });
	fs.writeFileSync(
		fixture,
		JSON.stringify({
			listPage,
			bump,
			nodes: issues.map((i) => {
				const lastEditedAt = i.lastEditedAt ?? i.revisions.at(-1)?.at ?? null;
				return {
					number: i.number,
					title: i.title ?? `issue ${i.number}`,
					url: `https://github.com/owner/repo/issues/${i.number}`,
					body: i.current ?? i.revisions.at(-1)?.body ?? "",
					lastEditedAt,
					updatedAt: i.updatedAt ?? lastEditedAt,
					userContentEdits: { totalCount: i.revisions.length },
				};
			}),
			// GitHub returns newest first; the script reverses.
			hist: Object.fromEntries(
				issues.map((i) => [
					i.number,
					[...i.revisions]
						.reverse()
						.map((r) => ({ editedAt: r.at, diff: r.body })),
				]),
			),
			...(graphqlError ? { errors: [{ message: errorMessage }] } : {}),
		}),
	);
	const stub = stubGhScript(dir, STUB, { failing });
	return {
		...stub,
		env: { ...stub.env, FIXTURE: fixture, CALLS: calls },
		/** Every call the script made, in order. */
		calls: (): { query: string; vars: Record<string, string> }[] =>
			fs.existsSync(calls)
				? fs
						.readFileSync(calls, "utf8")
						.trim()
						.split("\n")
						.map((l) => JSON.parse(l))
				: [],
	};
};

/** extraEnv is applied last, so it can override the pinned WFC_NOW. */
const run = (
	args: string[] = [],
	stub?: StubGh,
	extraEnv: Record<string, string> = {},
) => {
	const r = runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: hostRoot(),
			WFC_NOW: NOW,
			...stub?.env,
			...extraEnv,
		},
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

/* A clobber, in the shape the corpus showed: session one appends its entry,
 * session two — holding a copy fetched beforehand — writes its own entry over
 * the top, so entry one is gone and everything older survives. */
const CLOBBER: Issue = {
	number: 8,
	title: "taglines — Positioning & taglines",
	revisions: [
		{ at: "2026-08-01T06:00:00Z", body: body(L("older"), L("settled")) },
		{
			at: "2026-08-01T06:02:39Z",
			body: body(L("older"), L("settled"), L("session-one")),
		},
		{
			at: "2026-08-01T06:03:16Z",
			body: body(L("older"), L("settled"), L("session-two")),
		},
	],
};

/* Long enough to carry a second 60-char window, which `L` above is not. */
const LONG = (tag: string) =>
	`${L(tag)}, with the working and the rejected alternative both set out at length`;

/** The same clobber in long lines, against a given live body. */
const longClobber = (restored: string): Issue => ({
	number: 8,
	title: "taglines — Positioning & taglines",
	revisions: [
		{
			at: "2026-08-01T06:00:00Z",
			body: body(LONG("older"), LONG("settled")),
		},
		{
			at: "2026-08-01T06:02:39Z",
			body: body(LONG("older"), LONG("settled"), LONG("session-one")),
		},
		{
			at: "2026-08-01T06:03:16Z",
			body: body(LONG("older"), LONG("settled"), LONG("session-two")),
		},
	],
	current: body(LONG("older"), LONG("settled"), LONG("session-two"), restored),
});

describe("a clobber", () => {
	it("is reported, and gates", () => {
		const r = run([], stubGh([CLOBBER]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("CLOBBERED");
		expect(r.out).toContain("#8");
		expect(r.out).toContain("session-one");
	});

	it("names how long after the overwritten edit it landed", () => {
		const r = run([], stubGh([CLOBBER]));
		expect(r.out).toMatch(/0\.6 min after the edit it dropped/);
	});

	it("stops being reported once the text is back in the live body", () => {
		const r = run(
			[],
			stubGh([
				{
					...CLOBBER,
					current: body(
						L("older"),
						L("settled"),
						L("session-two"),
						L("session-one"),
					),
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("stops being reported when the restoration reworded the opening", () => {
		/* A restoration prepends the issue number to the link text, as the
		 * number-first citation rule requires, so the first 60 characters no
		 * longer match: only the second window sees it (mantahostels#302). */
		const reworded = LONG("session-one").replace(
			"- [session-one]",
			"- [#1 — session-one]",
		);
		const r = run([], stubGh([longClobber(reworded)]));
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("goes quiet when a LONG lost line's second window recurs elsewhere — the accepted false negative", () => {
		/* The price of the second window: a still-missing long line whose middle
		 * 60 characters happen to reappear in some other line reads as restored,
		 * and is never reported. Accepted at mantahostels#302. */
		const lost = LONG("session-one");
		const elsewhere = `an unrelated note quoting ${lost.slice(60, 120)} at length`;
		const r = run([], stubGh([longClobber(elsewhere)]));
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	it("is still reported when a shorter lost line is merely quoted elsewhere", () => {
		/* The second window is a whole 60 characters or nothing. A lost line with
		 * no room for one falls back to the strict opening match, so a later note
		 * quoting its tail does not read as the text being back. */
		const lost = L("session-one"); // 106 chars: room for one window, not two
		const quoted = `a later note that happens to quote ${lost.slice(60)} in passing`;
		const r = run(
			[],
			stubGh([
				{
					...CLOBBER,
					current: body(L("older"), L("settled"), L("session-two"), quoted),
				},
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("CLOBBERED");
	});

	it("is still found when the clobbering write made the body LONGER", () => {
		// The rule cannot lean on size in either direction.
		const grown = {
			...CLOBBER,
			revisions: [
				CLOBBER.revisions[0],
				CLOBBER.revisions[1],
				{
					at: "2026-08-01T06:03:16Z",
					body: body(
						L("older"),
						L("settled"),
						L("session-two"),
						L("session-two-extra"),
						L("session-two-more"),
					),
				},
			],
		};
		const r = run([], stubGh([grown]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("CLOBBERED");
	});
});

describe("legitimate edits are not reported", () => {
	it("a concision pass cutting long-standing text", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 20,
					revisions: [
						{ at: "2026-08-01T06:00:00Z", body: body(L("a"), L("b"), L("c")) },
						{
							at: "2026-08-01T07:00:00Z",
							body: body(L("a"), L("b"), L("c"), L("d")),
						},
						{ at: "2026-08-01T08:00:00Z", body: body(L("a"), L("d")) },
					],
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("CLOBBERED");
	});

	it("an entry edited in place rather than lost", () => {
		const base = `${L("entry")} — recorded`;
		const r = run(
			[],
			stubGh([
				{
					number: 21,
					revisions: [
						{ at: "2026-08-01T06:00:00Z", body: body(L("a")) },
						{ at: "2026-08-01T06:01:00Z", body: body(L("a"), base) },
						{
							at: "2026-08-01T06:02:00Z",
							body: body(L("a"), `${base}, and then extended with more detail`),
						},
					],
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("CLOBBERED");
	});

	it("a checkbox ticked", () => {
		const crit =
			"- [ ] the acceptance criterion nobody has verified yet, at length";
		const r = run(
			[],
			stubGh([
				{
					number: 22,
					revisions: [
						{ at: "2026-08-01T06:00:00Z", body: body(L("a")) },
						{ at: "2026-08-01T06:01:00Z", body: body(L("a"), crit) },
						{
							at: "2026-08-01T06:02:00Z",
							body: body(L("a"), crit.replace("- [ ]", "- [x]")),
						},
					],
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("CLOBBERED");
	});

	it("a partial overlap a day later — a rewrite, not a race", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 23,
					revisions: [
						{ at: "2026-08-01T06:00:00Z", body: body(L("a"), L("b")) },
						{
							at: "2026-08-01T06:01:00Z",
							body: body(L("a"), L("b"), L("new1"), L("new2")),
						},
						{
							at: "2026-08-02T06:01:00Z",
							body: body(L("a"), L("b"), L("new2"), L("later")),
						},
					],
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("SUSPECT");
	});
});

describe("ambiguous transitions", () => {
	it("a partial overlap minutes later is SUSPECT, and does not gate", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 24,
					revisions: [
						{ at: "2026-08-01T06:00:00Z", body: body(L("a"), L("b")) },
						{
							at: "2026-08-01T06:01:00Z",
							body: body(L("a"), L("b"), L("new1"), L("new2")),
						},
						{
							at: "2026-08-01T06:06:00Z",
							body: body(L("a"), L("b"), L("new2"), L("later")),
						},
					],
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUSPECT");
	});

	it("a removal whose only addition is a heading is not called a clobber", () => {
		// Condition 4 asks whether C wrote anything of its own. A short heading or
		// bullet is shared by every revision of every issue, so it establishes
		// nothing.
		const r = run(
			[],
			stubGh([
				{
					number: 27,
					revisions: [
						{ at: "2026-08-01T06:00:00Z", body: body(L("a")) },
						{ at: "2026-08-01T06:01:00Z", body: body(L("a"), L("annotation")) },
						{ at: "2026-08-01T06:02:24Z", body: body(L("a"), "## Notes") },
					],
				},
			]),
		);
		expect(r.out).not.toContain("CLOBBERED");
	});

	it("a removal that adds nothing is not called a clobber", () => {
		// Condition 4: nothing was written over the top, so nobody's work was
		// taken.
		const r = run(
			[],
			stubGh([
				{
					number: 25,
					revisions: [
						{ at: "2026-08-01T06:00:00Z", body: body(L("a")) },
						{ at: "2026-08-01T06:01:00Z", body: body(L("a"), L("annotation")) },
						{ at: "2026-08-01T06:02:24Z", body: body(L("a")) },
					],
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("CLOBBERED");
	});
});

/** CLOBBER, last edited in January: outside any window the fixtures open. */
const OLD_CLOBBER: Issue = {
	...CLOBBER,
	lastEditedAt: "2026-01-01T00:00:00Z",
	revisions: CLOBBER.revisions.map((r) => ({
		...r,
		at: r.at.replace("2026-08", "2026-01"),
	})),
};

describe("scope", () => {
	it("skips issues outside the --since window, and --all reaches them", () => {
		expect(run([], stubGh([OLD_CLOBBER])).status).toBe(0);
		const all = run(["--all"], stubGh([OLD_CLOBBER]));
		expect(all.status).toBe(1);
		expect(all.out).toContain("CLOBBERED");
	});

	/* mantahostels#2176: proves the window reads the injected clock, not the real calendar
	 * date. Paired with "is reported, and gates" above, the positive case a
	 * wall-clock read would falsely flip once real time passed the fixture's
	 * anchor by 30 days. */
	it("closes the --since window as the injected clock, not real time, moves past it", () => {
		const farFuture = run([], stubGh([CLOBBER]), {
			WFC_NOW: "2027-01-01T00:00:00Z",
		});
		expect(farFuture.status).toBe(0);
		expect(farFuture.out).toContain("OK");
		expect(farFuture.out).not.toContain("CLOBBERED");
	});

	/* mantahostels#2176: unlike the far-future case above, a NOW anchored before the fixture
	 * keeps the window open under the injected clock forever — a wall-clock read
	 * starts excluding this fixture once real time passes the fixture's own
	 * anchor by 30 days. */
	it("keeps the --since window open on an injected clock anchored before the fixture", () => {
		const past = run([], stubGh([CLOBBER]), {
			WFC_NOW: "2025-06-01T00:00:00Z",
		});
		expect(past.status).toBe(1);
		expect(past.out).toContain("CLOBBERED");
	});

	/* mantahostels#2176: --all computes no cutoff at all, so a malformed WFC_NOW must not
	 * stop it finding a real clobber. */
	it("--all ignores a malformed WFC_NOW, which its unread cutoff never touches", () => {
		const r = run(["--all"], stubGh([CLOBBER]), { WFC_NOW: "not-a-date" });
		expect(r.status).toBe(1);
		expect(r.out).toContain("CLOBBERED");
	});

	/* `npm run check:clobbers` hardcodes --all, so
	 * `npm run check:clobbers -- --since 7` reads like a narrowed run. Refusing
	 * beats silently sweeping everything under a flag that says otherwise. */
	it("refuses --since and --all together rather than ignoring one", () => {
		const r = run(["--all", "--since", "7"], stubGh([CLOBBER]));
		expect(r.status).toBe(2);
		expect(r.out).toContain("contradict");
	});

	it("ignores an issue with fewer than two recorded edits", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 26,
					revisions: [{ at: "2026-08-01T06:00:00Z", body: body(L("a")) }],
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("0 body transition");
	});
});

/* #1600: the daily run names the issues of its last findings, so an unfixed
 * one stays reported once the window has moved past its issue. */
describe("--rescan", () => {
	it("reports a finding on an issue last edited before the window when it is named", () => {
		const r = run(["--since", "2", "--rescan", "8"], stubGh([OLD_CLOBBER]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("CLOBBERED");
		expect(r.out).toContain("or among the 1 named to re-scan");
	});

	it("fetches by number a named issue the windowed listing stopped short of", () => {
		const stub = stubGh(
			[
				{ ...CLOBBER, number: 1 },
				{ ...OLD_CLOBBER, number: 2, lastEditedAt: "2026-02-01T00:00:00Z" },
				OLD_CLOBBER,
			],
			{ listPage: 1 },
		);
		const r = run(["--since", "2", "--rescan", "8"], stub);
		expect(
			stub
				.calls()
				.filter((c) => /i8: issue\(number:8\)\{ number/.test(c.query)),
		).toHaveLength(1);
		expect(r.out).toContain("#8 taglines");
		expect(r.out).not.toContain("#2 ");
	});

	it("goes quiet on a named issue whose lost text is back in the live body", () => {
		const restored = {
			...OLD_CLOBBER,
			current: body(
				L("older"),
				L("settled"),
				L("session-two"),
				L("session-one"),
			),
		};
		const r = run(["--since", "2", "--rescan", "8"], stubGh([restored]));
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("CLOBBERED");
	});

	it("names and drops an issue that no longer resolves, scanning the rest", () => {
		const r = run(["--since", "2", "--rescan", "8,99"], stubGh([CLOBBER]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("#99 no longer resolves");
		expect(r.out).toContain("CLOBBERED");
	});

	it("refuses --rescan with --all as a bad invocation, naming the contradiction", () => {
		const r = run(["--all", "--rescan", "8"], stubGh([CLOBBER]));
		expect(r.status).toBe(2);
		expect(r.out).toContain("contradict");
	});

	it("refuses a --rescan value that is not issue numbers as a bad invocation, naming it", () => {
		const r = run(["--rescan", "8,x"], stubGh([CLOBBER]));
		expect(r.status).toBe(2);
		expect(r.out).toContain(
			"--rescan needs issue numbers, comma-separated, got 8,x",
		);
	});
});

/** `count` issues edited on `day`, a minute apart from 06:00, each with a
 *  clean two-revision history. */
const cleanIssues = (count: number, from: number, day: string): Issue[] =>
	Array.from({ length: count }, (_, k) => {
		const at = `${day}T06:${String(k).padStart(2, "0")}:00Z`;
		return {
			number: from + k,
			revisions: [
				{ at, body: body(L(`q${k}`)) },
				{ at, body: body(L(`q${k}`), L(`r${k}`)) },
			],
		};
	});

const listCalls = (stub: ReturnType<typeof stubGh>) =>
	stub.calls().filter((c) => c.query.includes("issues("));
const batchCalls = (stub: ReturnType<typeof stubGh>) =>
	stub.calls().filter((c) => /i\d+: issue/.test(c.query));

describe("fetching (#1628)", () => {
	it("reads an issue whose history runs past one page in full", () => {
		/* 45 revisions is three pages of 20: the clobber sits in the oldest, so
		 * only a fetch that pages on finds it. */
		const filler = Array.from({ length: 42 }, (_, k) => ({
			at: `2026-08-01T07:${String(k).padStart(2, "0")}:00Z`,
			body: body(L("older"), L("settled"), L("session-two"), `filler ${k}`),
		}));
		const stub = stubGh([
			{ ...CLOBBER, revisions: [...CLOBBER.revisions, ...filler] },
		]);
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("session-one");
		expect(stub.calls().filter((c) => c.vars.n === "8")).toHaveLength(2);
	});

	it("stops a windowed listing at the first page reaching past the cutoff, and --all reads every page", () => {
		/* Ten issues, two a page: the windowed pass stops on page 2, and its
		 * second look from the top on page 1 (see the next case). */
		const issues = [
			...cleanIssues(3, 100, "2026-07-30"),
			...cleanIssues(7, 200, "2026-01-01"),
		];
		const windowed = stubGh(issues, { listPage: 2 });
		const w = run(["--since", "7"], windowed);
		expect(w.status).toBe(0);
		expect(w.out).toContain("across 3 issue(s)");
		expect(listCalls(windowed)).toHaveLength(3);
		expect(listCalls(windowed)[0]?.query).toContain("UPDATED_AT");

		const all = stubGh(issues, { listPage: 2 });
		const a = run(["--all"], all);
		expect(a.status).toBe(0);
		expect(a.out).toContain("across 10 issue(s)");
		expect(listCalls(all)).toHaveLength(5);
		expect(listCalls(all)[0]?.query).not.toContain("UPDATED_AT");
	});

	it("still finds an issue whose update mid-listing moved it onto a page already read", () => {
		/* #8 was edited 12 days ago; a comment after the first page jumps it to
		 * the front, so the first pass never sees it. */
		const moved = {
			...CLOBBER,
			revisions: CLOBBER.revisions.map((revision) => ({
				...revision,
				at: revision.at.replace("2026-08-01", "2026-07-20"),
			})),
		};
		const stub = stubGh(
			[
				moved,
				...cleanIssues(3, 100, "2026-07-30"),
				...cleanIssues(2, 200, "2026-01-01"),
			],
			{
				listPage: 2,
				bump: { after: 1, number: 8, updatedAt: "2026-08-01T11:00:00Z" },
			},
		);
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("session-one");
		expect(r.out).toContain("across 4 issue(s)");
	});

	it("fetches 25 histories a call", () => {
		const stub = stubGh(cleanIssues(30, 100, "2026-08-01"));
		const r = run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("across 30 issue(s)");
		expect(
			batchCalls(stub).map((c) => c.query.match(/: issue/g)?.length),
		).toEqual([25, 5]);
	});

	it("splits a call whose estimated response passes 4 MB", () => {
		// Estimated as live body × revisions: 1.1 MB × 2 each, so two cannot share.
		const big = "x".repeat(1_100_000);
		const stub = stubGh(
			cleanIssues(3, 100, "2026-08-01").map((i) => ({
				...i,
				current: big,
			})),
		);
		const r = run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("across 3 issue(s)");
		expect(batchCalls(stub)).toHaveLength(3);
	});

	it("keeps every finding's key across batch boundaries, windowed and --all", () => {
		/* Keys pinned from the per-issue fetch before #1628, on this fixture: a
		 * clobber and a SUSPECT each side of the 25-issue boundary. */
		const suspect = (n: number): Issue => ({
			number: n,
			revisions: [
				{ at: "2026-08-01T06:00:00Z", body: body(L("a"), L("b")) },
				{
					at: "2026-08-01T06:01:00Z",
					body: body(L("a"), L("b"), L("new1"), L("new2")),
				},
				{
					at: "2026-08-01T06:06:00Z",
					body: body(L("a"), L("b"), L("new2"), L("later")),
				},
			],
		});
		const issues = [
			{ ...CLOBBER, number: 3 },
			suspect(4),
			...cleanIssues(26, 100, "2026-08-01"),
			{ ...CLOBBER, number: 300 },
			suspect(301),
		];
		const expected = [
			"CLOBBERED\t#3\t2026-08-01T06:03:16Z",
			"CLOBBERED\t#300\t2026-08-01T06:03:16Z",
			"SUSPECT\t#301\t2026-08-01T06:06:00Z",
			"SUSPECT\t#4\t2026-08-01T06:06:00Z",
		];
		for (const args of [[], ["--all"]]) {
			const r = run([...args, "--json"], stubGh(issues));
			expect(r.status).toBe(1);
			const keys = JSON.parse(r.out.slice(0, r.out.lastIndexOf("}") + 1))
				.findings.map((f: { key: string }) => f.key)
				.sort();
			expect(keys).toEqual(expected);
		}
	});
});

/* #1700: a SUSPECT judged a deliberate rewrite stays reported under its own
 * tag, so the daily run can leave it off the standing issue. */
describe("reviewed SUSPECTs", () => {
	const reviewedFile = () =>
		path.join(hostRoot(), "docs", "clobber-reviewed.json");
	const review = (entries: Record<string, string> | string) => {
		fs.mkdirSync(path.dirname(reviewedFile()), { recursive: true });
		fs.writeFileSync(
			reviewedFile(),
			typeof entries === "string" ? entries : JSON.stringify(entries),
		);
	};
	afterEach(() => fs.rmSync(reviewedFile(), { force: true }));

	const editAt = "2026-08-01T06:06:00Z";
	const suspect = (n: number, at = editAt): Issue => ({
		number: n,
		revisions: [
			{ at: "2026-08-01T06:00:00Z", body: body(L("a"), L("b")) },
			{
				at: "2026-08-01T06:01:00Z",
				body: body(L("a"), L("b"), L("new1"), L("new2")),
			},
			{ at, body: body(L("a"), L("b"), L("new2"), L("later")) },
		],
	});
	/* Last edited a month before NOW, so a 1-day window passes it. */
	const passed = (n: number): Issue => ({
		...suspect(n),
		lastEditedAt: "2026-07-01T00:00:00Z",
	});
	const keys = (args: string[], issues: Issue[]) => {
		const r = run([...args, "--json"], stubGh(issues));
		return JSON.parse(r.out.slice(0, r.out.lastIndexOf("}") + 1))
			.findings.map((f: { key: string }) => f.key)
			.sort();
	};

	it("reports a SUSPECT whose identity the host reviewed as SUSPECT-REVIEWED, naming the reason", () => {
		review({ [`#24\t${editAt}`]: "a deliberate rewrite, read 2 Aug" });
		expect(keys([], [suspect(24)])).toEqual([
			`SUSPECT-REVIEWED\t#24\t${editAt}`,
		]);
		const r = run([], stubGh([suspect(24)]));
		expect(r.out).toContain("a deliberate rewrite, read 2 Aug");
		expect(r.status).toBe(0);
	});

	it("still reports a SUSPECT on the same issue at another edit time, and calls the entry stale", () => {
		review({ "#24\t2026-07-01T00:00:00Z": "an earlier edit" });
		expect(keys([], [suspect(24)])).toEqual([
			"REVIEWED-STALE\t#24\t2026-07-01T00:00:00Z",
			`SUSPECT\t#24\t${editAt}`,
		]);
	});

	it("never judges an entry stale whose issue the run did not scan", () => {
		review({
			[`#24\t${editAt}`]: "outside the window",
			[`#99\t${editAt}`]: "absent",
		});
		expect(keys(["--since", "1"], [passed(24)])).toEqual([]);
	});

	it("keeps matching a reviewed issue the window has passed once --rescan names it", () => {
		review({ [`#24\t${editAt}`]: "a deliberate rewrite" });
		expect(keys(["--since", "1", "--rescan", "24"], [passed(24)])).toEqual([
			`SUSPECT-REVIEWED\t#24\t${editAt}`,
		]);
	});

	it("accepts nothing where the host keeps no file", () => {
		expect(keys([], [suspect(24)])).toEqual([`SUSPECT\t#24\t${editAt}`]);
	});

	it.each([
		["will not parse", "{ not json", "unparseable"],
		["is an array", "[]", "not an object"],
		["keys by issue alone", JSON.stringify({ "#24": "r" }), "is no"],
		[
			"gives no reason",
			JSON.stringify({ [`#24\t${editAt}`]: "" }),
			"needs a reason",
		],
	])("is BROKEN on a file that %s", (_, text, why) => {
		review(text);
		const r = run([], stubGh([suspect(24)]));
		expect(r.out).toContain("docs/clobber-reviewed.json");
		expect(r.out).toContain(why);
		expect(r.status).toBe(2);
	});
});

describe("it cannot run", () => {
	it("SKIPs when GitHub is unreachable", () => {
		const r = run([], stubGh([CLOBBER], { failing: true }));
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
	});

	it("is BROKEN when GraphQL returns errors beside its data", () => {
		const r = run([], stubGh([CLOBBER], { graphqlError: true }));
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});

	it("SKIPs a rate-limited sweep rather than calling itself broken", () => {
		// GraphQL refuses a rate-limited caller on a 200 with an errors array, so
		// gh exits 0 and stderr is empty. --all, the whole-history sweep, is the
		// mode that provokes it.
		const r = run(
			["--all"],
			stubGh([CLOBBER], {
				graphqlError: true,
				errorMessage: "API rate limit exceeded for user ID 1.",
			}),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
	});

	it("is BROKEN on a --since that is not a positive number", () => {
		const r = run(["--since", "soon"], stubGh([CLOBBER]));
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});

	/* mantahostels#2176: a malformed clock fails loudly rather than falling back to
	 * the real calendar date. */
	it("is BROKEN on a WFC_NOW that is not a date", () => {
		const r = run([], stubGh([CLOBBER]), { WFC_NOW: "not-a-date" });
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
		expect(r.out).toContain("WFC_NOW is not a date");
	});

	it("caps a finding to WARN under --warn", () => {
		const r = run(["--warn"], stubGh([CLOBBER]));
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});
});
