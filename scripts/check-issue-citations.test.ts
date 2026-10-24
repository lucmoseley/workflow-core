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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withHostConfig } from "./lib/config-testkit";
import { catFixture, type StubGh, stubGhScript } from "./lib/gh-stub";

const SCRIPT = path.resolve(__dirname, "check-issue-citations.js");
const URL_ = (n: number) => `https://github.com/owner/repo/issues/${n}`;

withHostConfig({ tracker: "owner/repo" });

let dir: string;

interface Issue {
	number: number;
	title?: string;
	body?: string;
	comments?: { id?: number; body: string }[];
}

/** Write a stub `gh` returning the given issue list. */
const stubGh = (issues: Issue[], { failing = false } = {}) => {
	const fixture = path.join(dir, "issues.json");
	fs.writeFileSync(
		fixture,
		JSON.stringify(
			issues.map((i) => ({
				title: `t${i.number}`,
				body: "",
				comments: [],
				url: `http://example/${i.number}`,
				...i,
			})),
		),
	);
	return stubGhScript(dir, catFixture(fixture), { failing });
};

const run = (args: string[] = [], stub?: StubGh) => {
	const r = spawnSync("node", [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...stub?.env },
	});
	return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "citations-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("title-first links", () => {
	it("flags a link whose text does not lead with the number", () => {
		const stub = stubGh([
			{
				number: 8,
				body: `See [Does the 15% vendor leg survive?](${URL_(32)}) for the ruling.`,
			},
		]);
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("TITLE-FIRST");
		expect(r.out).toContain("#32 cited as");
	});

	it("accepts a link whose text leads with the number", () => {
		const stub = stubGh([
			{
				number: 8,
				body: `See [#32 — Does the 15% vendor leg survive?](${URL_(32)}).`,
			},
		]);
		const r = run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("accepts a deep link to a comment when the text leads with the number", () => {
		const stub = stubGh([
			{
				number: 36,
				body: `Table in [#31's verification comment](${URL_(31)}#issuecomment-5139233893).`,
			},
		]);
		expect(run([], stub).status).toBe(0);
	});

	it("flags a deep link to a comment when the text leads with prose", () => {
		const stub = stubGh([
			{
				number: 36,
				body: `Table in [the verification comment](${URL_(31)}#issuecomment-51392).`,
			},
		]);
		expect(run([], stub).status).toBe(1);
	});

	it("ignores links to another repository's issues", () => {
		const stub = stubGh([
			{
				number: 5,
				body: "Upstream: [App Router caching regression](https://github.com/vercel/next.js/issues/12345).",
			},
		]);
		const r = run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("scans comments as well as bodies, and says which", () => {
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
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("comment 5150208441");
	});
});

describe("number-less blockers", () => {
	it("flags a blocker named only by description as NO-NUMBER, naming the description", () => {
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by the nav-layer ticket, which decides the walk order.",
			},
		]);
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-NUMBER");
		expect(r.out).toContain("nav-layer");
	});

	it("accepts a blocker line carrying a number", () => {
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by #22 (does doc-map become the navigation layer?).",
			},
		]);
		expect(run([], stub).status).toBe(0);
	});

	it("ignores the `## Blocked by` section heading /to-tickets emits", () => {
		const stub = stubGh([
			{ number: 70, body: "## Blocked by\n\nNone — can start immediately.\n" },
		]);
		const r = run([], stub);
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
		(body) => {
			const r = run([], stubGh([{ number: 70, body }]));
			expect(r.status).toBe(0);
			expect(r.out).toContain("OK:");
		},
	);

	it("still flags `Blocked by the scope ticket.`, whose blocker is real but unnumbered", () => {
		const stub = stubGh([{ number: 72, body: "Blocked by the scope ticket." }]);
		const r = run([], stub);
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
		(body) => {
			const r = run([], stubGh([{ number: 73, body }]));
			expect(r.status).toBe(1);
			expect(r.out).toContain("NO-NUMBER");
			expect(r.out).toContain(body);
		},
	);

	it("flags a half-cited line as NO-NUMBER: one numbered blocker beside a described one", () => {
		// mantahostels#26's real form. A bare `#\d+` test passes this and the described half
		// stays unfindable.
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by the nav-layer ticket, and by #19 (which is editing §B by hand).",
			},
		]);
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-NUMBER");
		expect(r.out).toContain("nav-layer ticket");
	});

	it("accepts a fully numbered line that still contains ordinary prose", () => {
		const stub = stubGh([
			{
				number: 26,
				body: "Blocked by #22 (the nav-layer question), and by #19 (editing §B by hand).",
			},
		]);
		expect(run([], stub).status).toBe(0);
	});

	it("accepts a numbered blocker line whose prose names no referring phrase", () => {
		const stub = stubGh([
			{
				number: 42,
				body: "**Blocked by #37**, which re-derives the classification and will move 172 first.",
			},
		]);
		expect(run([], stub).status).toBe(0);
	});

	it("flags `Blocks <description>` too, not only `Blocked by`", () => {
		const stub = stubGh([
			{ number: 16, body: "Blocks the card-depth decision." },
		]);
		expect(run([], stub).status).toBe(1);
	});

	it("does not scan comments for blocker prose", () => {
		// A comment saying "blocked by the other thing" is conversation, not the
		// ticket's own recorded state.
		const stub = stubGh([
			{
				number: 26,
				body: "Clean.",
				comments: [{ id: 1, body: "Blocked by the nav-layer thing." }],
			},
		]);
		expect(run([], stub).status).toBe(0);
	});
});

describe("reporting contract", () => {
	it("--warn reports the finding but exits 0", () => {
		const stub = stubGh([{ number: 8, body: `[A title](${URL_(32)})` }]);
		const r = run(["--warn"], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});

	it("--json emits counts and exits 1 on a finding", () => {
		const stub = stubGh([{ number: 8, body: `[A title](${URL_(32)})` }]);
		const r = run(["--json"], stub);
		expect(r.status).toBe(1);
		expect(JSON.parse(r.out).total).toBe(1);
	});

	it("SKIPs with exit 0 when gh is unavailable — never reads as all-clear", () => {
		const stub = stubGh([], { failing: true });
		const r = run([], stub);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP:");
		expect(r.out).not.toContain("OK:");
	});
});
