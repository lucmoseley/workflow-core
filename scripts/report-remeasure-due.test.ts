// @vitest-environment node
/*
 * report-remeasure-due.test.ts — the re-measure trigger (#1625). Break it
 * and the founder is asked to re-measure on a wrong count, or asked twice.
 *
 * Driven end to end through `runInProcess` against a throwaway root, with
 * `gh` and the issue-body writer stubbed as files the script spawns. The gh
 * stub answers the GraphQL search per repo, filtered by the query's
 * `updated:` window and paged by cursor, each ticket carrying its first 100
 * comments, and REST for the rest; it logs its argv, so a case reads what
 * reached the tracker.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { guardErrorsLog } from "./lib/guard-errors-log";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-remeasure-due.js");
/* What the program files under, and the day its count starts. */
const TITLE = "Re-measure focused against identical review runs";
const LABEL = "takes:wayfinder";
const FLOOR = "2026-10-14";
const NOW = "2026-11-20T09:00:00Z";
const CORPUS = ["o/core", "o/manta", "o/books"];

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

const sha = (kind: string, n: number) => `${kind}${String(n).padStart(8, "0")}`;
const TIER_LINE =
	"**Review tier:** escalated — secret handling; not mission-critical, because no scan rule changed.";
/** One landed record, `n` naming its shas, over its disposition lines. */
const record = (
	n: number,
	disposed = ["FIXED: a leak in the log line"],
	landed = sha("c", n),
) =>
	[
		`**Review findings:** base ${sha("b", n)}, reviewed ${sha("e", n)}, landed ${landed}`,
		...disposed.map((d) => `- ${d} (Standards)`),
		"Standards 1, Spec 0, Focus 0. 0 raised by more than one run.",
	].join("\n");
const range = (from: number, count: number) =>
	Array.from({ length: count }, (_, i) => from + i);

interface Hit {
	number: number;
	updated: string;
	comments: string[];
}

function fixture(opts: {
	hits: Record<string, Hit[]>;
	/** Issues `gh issue list` serves, for an issue already filed. */
	issues?: unknown[];
	/** A window spanning more days than this reports more than the cap;
	 * null, never. */
	wideDays?: number | null;
	/** Every search reports one hit more than it serves. */
	short?: boolean;
	createFails?: boolean;
}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "remeasure-"));
	temps.push(root);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "F",
			tracker: "o/core",
			corpus: CORPUS,
		}),
	);
	const data = path.join(root, "data.json");
	fs.writeFileSync(
		data,
		JSON.stringify({
			hits: opts.hits,
			issues: opts.issues ?? [],
			wideDays: opts.wideDays ?? null,
			short: opts.short ?? false,
		}),
	);
	const issueBody = fakeIssueBody(root);
	const argvLog = path.join(root, "gh-argv.log");
	const { gh } = stubGhScript(
		root,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const a = process.argv.slice(2);",
			`fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(a) + '\\n');`,
			`const d = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));`,
			"const field = (k) => a.find((x) => x.startsWith(k + '='))?.slice(k.length + 1);",
			"const out = (v) => process.stdout.write(JSON.stringify(v));",
			"if (a[0] === 'api' && a[1] === 'graphql') {",
			"  const q = field('q');",
			"  const repo = /repo:(\\S+)/.exec(q)[1];",
			"  const [, from, to] = /updated:(\\S+)\\.\\.(\\S+)/.exec(q);",
			"  const days = (Date.parse(to) - Date.parse(from)) / 86400000;",
			"  const search = (s) => out({ data: { search: s } });",
			"  if (d.wideDays !== null && days > d.wideDays) search({ issueCount: 1001, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] });",
			"  else {",
			"    const all = (d.hits[repo] ?? []).filter((h) => h.updated >= from && h.updated <= to);",
			"    const start = Number(field('after') ?? 0);",
			"    const nodes = all.slice(start, start + 100).map((h) => ({ number: h.number, comments: { totalCount: h.comments.length, nodes: h.comments.slice(0, 100).map((body) => ({ body })) } }));",
			"    search({ issueCount: all.length + (d.short ? 1 : 0), pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) }, nodes });",
			"  }",
			"} else if (a[0] === 'api') {",
			"  const [, repo, n] = /^repos\\/(.+)\\/issues\\/(\\d+)\\/comments$/.exec(a[1]);",
			"  const hit = d.hits[repo].find((h) => h.number === Number(n));",
			"  out([hit.comments.map((body) => ({ body }))]);",
			"} else if (a[1] === 'list') out(d.issues);",
			`else if (a[1] === 'view') process.stdout.write(fs.readFileSync(${JSON.stringify(issueBody.bodyFile)}, 'utf8'));`,
			opts.createFails
				? "else if (a[1] === 'create') { process.stderr.write('HTTP 403: Resource not accessible\\n'); process.exit(1); }"
				: "else if (a[1] === 'create') process.stdout.write('https://github.com/o/core/issues/999\\n');",
		].join("\n"),
	);
	return {
		root,
		gh,
		issueBody,
		config: path.join(root, "config"),
		calls: (): string[][] =>
			fs.existsSync(argvLog)
				? fs
						.readFileSync(argvLog, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [],
	};
}

function run(fx: ReturnType<typeof fixture>) {
	const r = runInProcess(SCRIPT, [], {
		cwd: fx.root,
		env: {
			...process.env,
			WFC_GH: fx.gh,
			WFC_ISSUE_BODY: fx.issueBody.script,
			WFC_NOW: NOW,
			CLAUDE_PROJECT_DIR: fx.root,
			CLAUDE_CONFIG_DIR: fx.config,
		},
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const creates = (fx: ReturnType<typeof fixture>) =>
	fx.calls().filter((c) => c[0] === "issue" && c[1] === "create");
const flag = (call: string[], f: string) => call[call.indexOf(f) + 1];
const searches = (fx: ReturnType<typeof fixture>) =>
	fx
		.calls()
		.filter((c) => c[1] === "graphql")
		.map((c) => c.find((x) => x.startsWith("q=")) ?? "");

/** A ticket holding one counted record per `ns`, its tier declared first. */
const ticket = (number: number, ns: number[], extra: string[] = []): Hit => ({
	number,
	updated: "2026-11-01",
	comments: [TIER_LINE, ...ns.map((n) => record(n)), ...extra],
});

describe("the re-measure trigger", () => {
	it("is silent below 15 counted commits, and asks the tracker nothing but the search", () => {
		const fx = fixture({ hits: { "o/core": [ticket(1, range(1, 14))] } });
		const r = run(fx);
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(fx.calls().every((c) => c[1] === "graphql")).toBe(true);
	});

	it("files one issue at 15, pooled across repos, listing each commit's repo, base and tree", () => {
		const fx = fixture({
			hits: {
				"o/core": [ticket(1, range(1, 8))],
				"o/books": [ticket(4, range(9, 7))],
			},
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Re-measure due: 15 counted commits. Filed");
		const [create, ...more] = creates(fx);
		expect(more).toEqual([]);
		expect(flag(create, "--title")).toBe(TITLE);
		expect(flag(create, "--label")).toBe(LABEL);
		const body = flag(create, "--body");
		expect(body.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(15);
		expect(body).toContain(
			`- o/core#1: landed ${sha("c", 1)}, base ${sha("b", 1)}, tree ${sha("e", 1)}; 1 fixed or ticketed, 0 escaped`,
		);
		expect(body).toContain(`- o/books#4: landed ${sha("c", 15)}`);
		expect(searches(fx).map((q) => /repo:(\S+)/.exec(q)?.[1])).toEqual(CORPUS);
	});

	it.each([
		["open", null],
		["closed", "2026-11-10T00:00:00Z"],
	])(
		"refreshes an existing %s issue and never files a second",
		(_, closedAt) => {
			const fx = fixture({
				hits: { "o/manta": [ticket(2, range(1, 16))] },
				issues: [
					{
						number: 77,
						title: TITLE,
						labels: [{ name: "takes:implement" }],
						closedAt,
						createdAt: "2026-11-02T00:00:00Z",
					},
				],
			});
			const r = run(fx);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("Refreshed #77");
			expect(creates(fx)).toEqual([]);
			expect(fx.issueBody.calls()).toEqual([
				expect.stringMatching(/^replace 77 --file /),
			]);
			expect(fx.issueBody.body()).toContain("16 commits");
		},
	);

	it("does not count a commit whose only finding was declined, even above a quoted FIXED line in the same comment", () => {
		const declined = record(15, ["DECLINED: a rename the precedent rules out"]);
		const fx = fixture({
			hits: {
				"o/core": [
					ticket(1, range(1, 14), [
						`${declined}\n\nAs the earlier review put it:\n- FIXED: something else`,
					]),
				],
			},
		});
		expect(run(fx).stdout).toBe("");
	});

	it("counts that commit once an escaped defect, filed on another repo's ticket, names it", () => {
		const fx = fixture({
			hits: {
				"o/core": [
					ticket(1, range(1, 14), [
						record(15, ["DECLINED: a rename the precedent rules out"]),
					]),
				],
				"o/manta": [
					{
						number: 9,
						updated: "2026-11-05",
						comments: [
							`**Escaped defect:** ${sha("c", 15).slice(0, 7)} — the scan missed a token in a URL`,
						],
					},
				],
			},
		});
		const r = run(fx);
		expect(r.stdout).toContain("15 counted commits");
		expect(flag(creates(fx)[0], "--body")).toContain(
			`- o/core#1: landed ${sha("c", 15)}, base ${sha("b", 15)}, tree ${sha("e", 15)}; 0 fixed or ticketed, 1 escaped`,
		);
	});

	it("counts neither an ordinary review report under an escalated tier, a record with no escalated tier above it, nor one commit twice by a short and a full sha", () => {
		const fx = fixture({
			hits: {
				"o/core": [
					{
						number: 3,
						updated: "2026-11-01",
						comments: [record(20), "**Review tier:** standard", record(21)],
					},
					ticket(5, range(1, 13), [
						"Review findings (two-axis /code-review, base bd3ee808):\n- FIXED in 9f1eb8e7: a test title overclaimed",
						record(14, undefined, sha("c", 14).slice(0, 7)),
						record(14),
					]),
				],
			},
		});
		expect(run(fx).stdout).toBe("");
	});

	it("reads a record whose shas are backticked, and a ticket's comments past the first 100", () => {
		const fx = fixture({
			hits: {
				"o/core": [
					ticket(1, range(1, 13), [
						record(14).replace(/([bec]\d{8})/g, "`$1`"),
					]),
					{
						number: 2,
						updated: "2026-11-02",
						comments: [
							TIER_LINE,
							...Array.from({ length: 100 }, () => "a comment"),
							record(15),
						],
					},
				],
			},
		});
		const r = run(fx);
		expect(r.stdout).toContain("15 counted commits");
		expect(flag(creates(fx)[0], "--body")).toContain(
			`- o/core#1: landed ${sha("c", 14)}, base ${sha("b", 14)}`,
		);
		expect(fx.calls()).toContainEqual([
			"api",
			"repos/o/core/issues/2/comments",
			"--paginate",
			"--slurp",
		]);
	});

	// #1926: a start-point replay narrows to these paths.
	it("counts a record naming its reviewed paths beside ones naming none, and lists the paths", () => {
		const fx = fixture({
			hits: {
				"o/core": [
					ticket(1, range(1, 14), [
						record(15).replace(
							/landed (\S+)/,
							"landed $1, paths `lib/pricing/quote.ts,lib/pricing/tax.ts`",
						),
					]),
				],
			},
		});
		const r = run(fx);
		expect(r.stdout).toContain("15 counted commits");
		const body = flag(creates(fx)[0], "--body");
		expect(body).toContain(
			`- o/core#1: landed ${sha("c", 15)}, base ${sha("b", 15)}, tree ${sha("e", 15)}, paths lib/pricing/quote.ts,lib/pricing/tax.ts; 1 fixed or ticketed, 0 escaped`,
		);
		expect(body).toContain(
			`tree ${sha("e", 14)}; 1 fixed or ticketed, 0 escaped`,
		);
	});

	/** record(15) re-reviewed: base and tree of 16, naming quote.ts. */
	const withPaths = record(15)
		.replace(sha("b", 15), sha("b", 16))
		.replace(sha("e", 15), sha("e", 16))
		.replace(/landed (\S+)/, "landed $1, paths `lib/pricing/quote.ts`");

	it("keeps a later record's paths, with its ticket, base and tree, where an earlier record of the same commit named none (#2083)", () => {
		const fx = fixture({
			hits: {
				"o/core": [
					ticket(1, range(1, 15)),
					{
						number: 2,
						updated: "2026-11-02",
						comments: [TIER_LINE, withPaths],
					},
				],
			},
		});
		expect(run(fx).stdout).toContain("15 counted commits");
		expect(flag(creates(fx)[0], "--body")).toContain(
			`- o/core#2: landed ${sha("c", 15)}, base ${sha("b", 16)}, tree ${sha("e", 16)}, paths lib/pricing/quote.ts; 2 fixed or ticketed, 0 escaped`,
		);
	});

	it("keeps an earlier record's paths, base and tree over a later pathless record of the same commit (#2083)", () => {
		const fx = fixture({
			hits: {
				"o/core": [ticket(1, range(1, 14), [withPaths, record(15)])],
			},
		});
		expect(run(fx).stdout).toContain("15 counted commits");
		expect(flag(creates(fx)[0], "--body")).toContain(
			`- o/core#1: landed ${sha("c", 15)}, base ${sha("b", 16)}, tree ${sha("e", 16)}, paths lib/pricing/quote.ts; 2 fixed or ticketed, 0 escaped`,
		);
	});

	it("halves a window past search's 1,000-result cap until every hit is read", () => {
		const fx = fixture({
			wideDays: 5,
			hits: {
				"o/core": range(1, 15).map((n) => ({
					...ticket(n, [n]),
					updated: `2026-10-${14 + n}`,
				})),
			},
		});
		const r = run(fx);
		expect(r.stdout).toContain("15 counted commits");
		const windows = searches(fx).map(
			(q) => /updated:(\S+)\.\.(\S+)/.exec(q) ?? [],
		);
		expect(windows[0].slice(1)).toEqual([FLOOR, "2026-11-20"]);
		expect(windows.length).toBeGreaterThan(CORPUS.length);
	});

	it("counts every known defect under a record whose list follows a blank line or wraps a bullet, and none under the next record twice (#1698)", () => {
		const spaced = record(14, [
			"DECLINED: a rename the precedent rules out",
			"TICKETED #40: a lock never released",
		]).replace("\n", "\n\n");
		const wrapped = record(15, [
			"FIXED: a token left in the log line,\n  which the scan never read",
			"TICKETED #41: a second leak",
		]);
		const fx = fixture({
			hits: {
				"o/core": [
					ticket(1, range(1, 13), [
						// Record 14's counts line cut and record 15's header indented after
						// a blank line, so only the header itself ends 14's list.
						`${spaced.replace(/\nStandards 1.*$/, "")}\n\n  ${wrapped}`,
					]),
				],
			},
		});
		const r = run(fx);
		expect(r.stdout).toContain("15 counted commits");
		const body = flag(creates(fx)[0], "--body");
		expect(body).toContain(
			`landed ${sha("c", 14)}, base ${sha("b", 14)}, tree ${sha("e", 14)}; 1 fixed or ticketed`,
		);
		expect(body).toContain(
			`landed ${sha("c", 15)}, base ${sha("b", 15)}, tree ${sha("e", 15)}; 2 fixed or ticketed`,
		);
	});

	it("fails open, logging the fault, where a window's pages return fewer hits than its count (#1698)", () => {
		const fx = fixture({ short: true, hits: {} });
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(
			/^FAILED OPEN: could not read the corpus — .*0 of 1 hits — recorded in the guard-error log\.\nNothing was filed; the next day's run retries\.\n$/,
		);
		expect(guardErrorsLog(fx.config)).toMatch(
			/report-remeasure-due\tcould not read the corpus — .*0 of 1 hits/,
		);
		expect(creates(fx)).toEqual([]);
	});

	it("fails open, logging the fault, where the filing fails (#1698)", () => {
		const fx = fixture({
			createFails: true,
			hits: { "o/core": [ticket(1, range(1, 15))] },
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe(
			`FAILED OPEN: could not file or refresh "${TITLE}" — HTTP 403: Resource not accessible — recorded in the guard-error log.\nThe next day's run retries.\n`,
		);
		expect(guardErrorsLog(fx.config)).toContain(
			`report-remeasure-due\tcould not file or refresh "${TITLE}" — HTTP 403`,
		);
	});
});
