// @vitest-environment node
/*
 * Pins that check-issue-citations.js reports a cross-reference that leads with
 * the title rather than the number, and a blocker named with no number at
 * all, and SKIPs rather than reading all-clear when gh is unavailable (its
 * gh-failure rule, mantahostels#164).
 *
 * Every case runs with a stub `gh` injected via WFC_GH: no
 * network, no auth, and no dependence on this repo's actual issue state —
 * which is the thing the script reports on and so cannot also be its fixture.
 *
 * The exclusion cases are not hypothetical. `## Blocked by` is the section
 * header /to-tickets emits on every ticket, "None — can start immediately",
 * "Blocked by nothing: …", "**Blocked by nothing**, but …" and "**Blocking
 * question:** none." are how an unblocked ticket says so (fantasy-books carried
 * all four, #2389), and research tickets cite other projects'
 * trackers constantly — each would swamp the report if it counted.
 *
 * It runs daily in the repo-checks run, report-only, and is the only check on
 * the number-first rule: loosen a case and buried citations pile up again, or
 * the report swamps itself and stops being read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withHostConfig } from "./lib/config-testkit";
import {
	page,
	printed,
	type RouteAnswer,
	refused,
	type StubGh,
	stubGhRoutes,
} from "./lib/gh-stub";
import { MARKERS_REL } from "./lib/marker-root.js";
import { runInProcessAsync } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-issue-citations.js");
const URL_ = (n: number) => `https://github.com/owner/repo/issues/${n}`;

const hostRoot = withHostConfig({ tracker: "owner/repo" });
const cacheDir = () => path.join(hostRoot(), MARKERS_REL, "issue-citations");
const cacheFile = () => path.join(cacheDir(), "owner__repo.json");

let dir: string;

interface Issue {
	number: number;
	title?: string;
	body?: string;
	comments?: { id?: number; body: string }[];
}

const API = "repos/owner/repo/issues";
const FULL_ISSUES = `${API}?state=all&per_page=100`;
const FULL_COMMENTS = `${API}/comments?per_page=100`;
const SINCE_ISSUES = `${API}?state=all&since=*&per_page=100`;
const SINCE_COMMENTS = `${API}/comments?since=*&per_page=100`;

const issueRow = (i: Issue) => ({
	number: i.number,
	title: i.title ?? `t${i.number}`,
	body: i.body ?? "",
	html_url: `http://example/${i.number}`,
});

const commentRows = (issues: Issue[]) =>
	issues.flatMap((i) =>
		(i.comments ?? []).map((c, k) => ({
			id: c.id ?? i.number * 1000 + k,
			issue_url: `https://api.github.com/${API}/${i.number}`,
			body: c.body,
		})),
	);

/** A stub `gh` answering the cold read with `issues` and their comments. */
const stubGh = (issues: Issue[], { failing = false } = {}) =>
	stubGhRoutes(
		dir,
		{
			[FULL_ISSUES]: page("issuesPage", issues.map(issueRow)),
			[FULL_COMMENTS]: page("commentsPage", commentRows(issues)),
		},
		{ failing },
	);

/** A stub `gh` answering only a since read, plus `extra`: a cold read fails. */
const stubSince = (issues: Issue[], extra: Record<string, RouteAnswer> = {}) =>
	stubGhRoutes(dir, {
		[SINCE_ISSUES]: page("issuesPage", issues.map(issueRow)),
		[SINCE_COMMENTS]: page("commentsPage", commentRows(issues)),
		...extra,
	});

const run = async (args: string[] = [], stub?: StubGh) => {
	const r = await runInProcessAsync(SCRIPT, args, {
		env: { ...process.env, ...stub?.env },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "citations-test-"));
	fs.rmSync(cacheDir(), { recursive: true, force: true });
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("title-first links", () => {
	it("flags a link whose text does not lead with the number", async () => {
		const stub = stubGh([
			{
				number: 8,
				body: `See [Does the 15% vendor leg survive?](${URL_(32)}) for the ruling.`,
			},
		]);
		const r = await run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("TITLE-FIRST");
		expect(r.out).toContain("#32 cited as");
	});

	it("accepts a link whose text leads with the number", async () => {
		const stub = stubGh([
			{
				number: 8,
				body: `See [#32 — Does the 15% vendor leg survive?](${URL_(32)}).`,
			},
		]);
		const r = await run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("accepts a deep link to a comment when the text leads with the number", async () => {
		const stub = stubGh([
			{
				number: 36,
				body: `Table in [#31's verification comment](${URL_(31)}#issuecomment-5139233893).`,
			},
		]);
		expect((await run([], stub)).status).toBe(0);
	});

	it("flags a deep link to a comment when the text leads with prose", async () => {
		const stub = stubGh([
			{
				number: 36,
				body: `Table in [the verification comment](${URL_(31)}#issuecomment-51392).`,
			},
		]);
		expect((await run([], stub)).status).toBe(1);
	});

	it("ignores links to another repository's issues", async () => {
		const stub = stubGh([
			{
				number: 5,
				body: "Upstream: [App Router caching regression](https://github.com/vercel/next.js/issues/12345).",
			},
		]);
		const r = await run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("scans comments as well as bodies, and says which", async () => {
		const stub = stubGh([
			{
				number: 39,
				body: "Clean body.",
				comments: [
					{
						id: 5_150_208_441,
						body: `Ruled by [Some long title](${URL_(20)}).`,
					},
				],
			},
		]);
		const r = await run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("comment 5150208441");
	});
});

describe("number-less blockers", () => {
	it("flags a blocker named only by description as NO-NUMBER, naming the description", async () => {
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by the nav-layer ticket, which decides the walk order.",
			},
		]);
		const r = await run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-NUMBER");
		expect(r.out).toContain("nav-layer");
	});

	it("accepts a blocker line carrying a number", async () => {
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by #22 (does doc-map become the navigation layer?).",
			},
		]);
		expect((await run([], stub)).status).toBe(0);
	});

	it("ignores the `## Blocked by` section heading /to-tickets emits", async () => {
		const stub = stubGh([
			{ number: 70, body: "## Blocked by\n\nNone — can start immediately.\n" },
		]);
		const r = await run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it.each([
		"Blocked by: None — can start immediately.",
		"Blocked by nothing.",
		"Blocked by nothing: every row is on disk.",
		"**Blocked by nothing**, but it must not land before the rewrite.",
		"**Blocking question:** none.",
		"Blocked by: none, can start",
		"Blocked by none: the rule has landed.",
		"Blocked by (none)",
		"Blocked by `none`",
		'Blocked by "none".',
		"Blocked by [none]",
		"Blocked by — none",
		"Blocked by: **None**",
		"Blocking: no blocker — can start now.",
		"Blocked by: no blockers.",
	])(
		"ignores `%s`, which states there is no blocker (#1656, #2389)",
		async (body) => {
			const r = await run([], stubGh([{ number: 70, body }]));
			expect(r.status).toBe(0);
			expect(r.out).toContain("OK:");
		},
	);

	it("still flags `Blocked by the scope ticket.`, whose blocker is real but unnumbered", async () => {
		const stub = stubGh([{ number: 72, body: "Blocked by the scope ticket." }]);
		const r = await run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-NUMBER");
		expect(r.out).toContain("scope ticket");
	});

	it.each([
		"Blocked by the scope ticket; nothing else.",
		"Blocked by nothing but the audit ticket.",
		"Blocked by the nav-layer ticket, none of the others.",
		"Blocked by nothing, except the scope ticket.",
		"Blocked by none, only the audit ticket.",
		"Blocks: nothing, but the nav-layer ticket waits on it",
		"Blocked by nothing: the scope ticket must land first.",
		"Blocked by upstream: nothing.",
	])(
		"still flags `%s`, a described blocker beside `nothing` or `none` (#2389)",
		async (body) => {
			const r = await run([], stubGh([{ number: 73, body }]));
			expect(r.status).toBe(1);
			expect(r.out).toContain("NO-NUMBER");
			expect(r.out).toContain(body);
		},
	);

	it("flags a half-cited line as NO-NUMBER: one numbered blocker beside a described one", async () => {
		// mantahostels#26's real form. A bare `#\d+` test passes this and the described half
		// stays unfindable.
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by the nav-layer ticket, and by #19 (which is editing §B by hand).",
			},
		]);
		const r = await run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-NUMBER");
		expect(r.out).toContain("nav-layer ticket");
	});

	it("accepts a fully numbered line that still contains ordinary prose", async () => {
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by #22 (the nav-layer question), and by #19 (editing §B by hand).",
			},
		]);
		expect((await run([], stub)).status).toBe(0);
	});

	it("accepts a numbered blocker line whose prose names no referring phrase", async () => {
		const stub = stubGh([
			{
				number: 42,
				body: "**Blocked by #37**, which re-derives the classification and will move 172 first.",
			},
		]);
		expect((await run([], stub)).status).toBe(0);
	});

	it("flags `Blocks <description>` too, not only `Blocked by`", async () => {
		const stub = stubGh([
			{ number: 16, body: "Blocks the card-depth decision." },
		]);
		expect((await run([], stub)).status).toBe(1);
	});

	it("does not scan comments for blocker prose", async () => {
		// A comment saying "blocked by the other thing" is conversation, not the
		// ticket's own recorded state.
		const stub = stubGh([
			{
				number: 26,
				body: "Clean.",
				comments: [{ id: 1, body: "Blocked by the nav-layer thing." }],
			},
		]);
		expect((await run([], stub)).status).toBe(0);
	});
});

describe("reporting contract", () => {
	it("--warn reports the finding but exits 0", async () => {
		const stub = stubGh([{ number: 8, body: `[A title](${URL_(32)})` }]);
		const r = await run(["--warn"], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});

	it("--json emits counts and exits 1 on a finding", async () => {
		const stub = stubGh([{ number: 8, body: `[A title](${URL_(32)})` }]);
		const r = await run(["--json"], stub);
		expect(r.status).toBe(1);
		expect(JSON.parse(r.out).total).toBe(1);
	});

	it("SKIPs with exit 0 when gh is unavailable — never reads as all-clear", async () => {
		const stub = stubGh([], { failing: true });
		const r = await run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP:");
		expect(r.out).not.toContain("OK:");
	});
});

describe("incremental read (#5355)", () => {
	const issue8 = { number: 8, body: `[A title](${URL_(32)})` };
	const issue9 = { number: 9, body: `[Another title](${URL_(33)})` };
	const probe = (n: number, repo = "owner/repo") =>
		printed(
			JSON.stringify({
				...issueRow({ number: n }),
				repository_url: `https://api.github.com/repos/${repo}`,
			}),
		);

	it("reads only what changed since the last run, rescans it, and carries the rest", async () => {
		await run([], stubGh([issue8, issue9]));
		const r = await run(
			[],
			stubSince([{ number: 9, body: "Fixed." }], { [`${API}/8`]: probe(8) }),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("changed since");
		expect(r.out).toContain("#8 t8");
		expect(r.out).not.toContain("#9 t9");
	});

	it("drops a cached comment finding whose comment is gone", async () => {
		const withComment = {
			number: 39,
			comments: [{ id: 77, body: `See [Some title](${URL_(20)}).` }],
		};
		expect((await run([], stubGh([withComment]))).status).toBe(1);
		const r = await run(
			[],
			stubSince([], {
				[`${API}/comments/77`]: refused("gh: Not Found (HTTP 404)"),
			}),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("drops a cached body finding whose issue is gone", async () => {
		await run([], stubGh([issue8]));
		const r = await run(
			[],
			stubSince([], { [`${API}/8`]: refused("gh: Gone (HTTP 410)") }),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("drops a cached body finding whose issue was transferred out", async () => {
		await run([], stubGh([issue8]));
		const r = await run(
			[],
			stubSince([], { [`${API}/8`]: probe(8, "owner/elsewhere") }),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("rereads the whole tracker when the cache is from another scanner version", async () => {
		fs.mkdirSync(cacheDir(), { recursive: true });
		const stamp = new Date().toISOString();
		fs.writeFileSync(
			cacheFile(),
			JSON.stringify({
				version: "another",
				stamp,
				fullStamp: stamp,
				issues: {
					8: {
						title: "t8",
						url: "u",
						body: { links: [], lines: ["x"] },
						comments: {},
					},
				},
			}),
		);
		const r = await run([], stubGh([{ number: 8, body: "Clean." }]));
		expect(r.status).toBe(0);
		expect(r.out).toContain("Checked all 1 issue(s)");
	});

	it("is BROKEN on a failed since read, and leaves the cache for the next run", async () => {
		await run([], stubGh([issue8]));
		const before = fs.readFileSync(cacheFile(), "utf8");
		const r = await run(
			[],
			stubGhRoutes(dir, {
				[SINCE_ISSUES]: refused("gh: HTTP 504: Gateway Timeout"),
			}),
		);
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN:");
		expect(r.out).toContain("HTTP 504");
		expect(fs.readFileSync(cacheFile(), "utf8")).toBe(before);
	});
});
