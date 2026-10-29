// @vitest-environment node
/*
 * report-remeasure-due.test.ts — the re-measure trigger (#1625). Break it
 * and the founder is asked to re-measure on a wrong count, or asked twice.
 *
 * Driven end to end through `runInProcess` against a throwaway root, with
 * `gh` and the issue-body writer stubbed as files the script spawns. The gh
 * stub answers the GraphQL search per repo, filtered by the query's
 * `updated:` window and paged by cursor, each ticket carrying its first 100
 * comments, REST for the rest, and commit search per repo; it logs its argv, so a case reads what
 * reached the tracker.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { defineTemplate, initGitRepo } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-remeasure-due.js");
/* What the program files under, and the day its count starts. */
const TITLE = "Re-measure focused against identical review runs";
const LABEL = "takes:wayfinder";
const FLOOR = "2026-10-14";
const NOW = "2026-11-20T09:00:00Z";
const OWN = "o/wfc";
const CORPUS = [OWN, "o/fleet", "o/manta", "o/books"];

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
	paths?: string,
) =>
	[
		`**Review findings:** base ${sha("b", n)}, reviewed ${sha("e", n)}, landed ${landed}${paths === undefined ? "" : `, paths ${paths}`}`,
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
	/** What commit search finds in each repo. */
	commits?: Record<string, { sha: string; message: string }[]>;
	commitsFail?: boolean;
	/** Every commit search reports one hit more than it serves. */
	commitsShort?: boolean;
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
			tracker: OWN,
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
			commits: opts.commits ?? {},
			commitsFail: opts.commitsFail ?? false,
			commitsShort: opts.commitsShort ?? false,
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
			"    const nodes = all.slice(start, start + 100).map((h) => ({ number: h.number, comments: { totalCount: h.comments.length, nodes: h.comments.slice(0, 100).map((body) => ({ body, createdAt: h.updated + 'T12:00:00Z' })) } }));",
			"    search({ issueCount: all.length + (d.short ? 1 : 0), pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) }, nodes });",
			"  }",
			"} else if (a[0] === 'api' && a[1].startsWith('search/commits?')) {",
			"  if (d.commitsFail) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }",
			"  const repo = / repo:(\\S+)/.exec(new URL(a[1], 'https://x/').searchParams.get('q'))[1];",
			"  const items = (d.commits[repo] ?? []).map(({ sha, message }) => ({ sha, commit: { message } }));",
			"  out([{ total_count: items.length + (d.commitsShort ? 1 : 0), items }]);",
			"} else if (a[0] === 'api') {",
			"  const [, repo, n] = /^repos\\/(.+)\\/issues\\/(\\d+)\\/comments$/.exec(a[1]);",
			"  const hit = d.hits[repo].find((h) => h.number === Number(n));",
			"  out([hit.comments.map((body) => ({ body, created_at: hit.updated + 'T12:00:00Z' }))]);",
			"} else if (a[1] === 'list') out(d.issues);",
			`else if (a[1] === 'view') process.stdout.write(fs.readFileSync(${JSON.stringify(issueBody.bodyFile)}, 'utf8'));`,
			opts.createFails
				? "else if (a[1] === 'create') { process.stderr.write('HTTP 403: Resource not accessible\\n'); process.exit(1); }"
				: "else if (a[1] === 'create') process.stdout.write('https://github.com/o/fleet/issues/999\\n');",
		].join("\n"),
	);
	return {
		root,
		gh,
		issueBody,
		config: path.join(root, "config"),
		/** Replaces what the search serves, for hits built after the root. */
		setHits: (hits: Record<string, Hit[]>) =>
			fs.writeFileSync(
				data,
				JSON.stringify({
					...JSON.parse(fs.readFileSync(data, "utf8")),
					hits,
				}),
			),
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
			HOME: fx.root,
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

/* A checkout of quote.ts: `base` seeds it, `refs/pre-fix` is the staged
 * pre-fix tree, and tags l1..l5 are five landed commits. */
const checkoutTemplate = defineTemplate((dir) => {
	const hooks = path.join(dir, ".hooks");
	fs.mkdirSync(hooks);
	initGitRepo(dir, hooks);
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
	/** Stages `text` as quote.ts. */
	const stage = (text: string) => {
		fs.writeFileSync(path.join(dir, "quote.ts"), text);
		git("add", "quote.ts");
	};
	stage("price = 0\n");
	git("commit", "-qm", "seed");
	git("tag", "base");
	stage("price = 1 // leak\n");
	git("update-ref", "refs/pre-fix", git("write-tree"));
	for (const n of [1, 2, 3, 4, 5]) {
		stage(`price = ${n}\n`);
		git("commit", "-qm", `price = ${n}`);
		git("tag", `l${n}`);
	}
});

/** That checkout under `fx`'s home, tracking OWN; reads a rev in it. */
function checkout(fx: ReturnType<typeof fixture>) {
	const code = checkoutTemplate.instantiate(path.join(fx.root, "code"));
	fs.mkdirSync(path.join(code, ".claude"));
	fs.writeFileSync(
		path.join(code, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "F", tracker: OWN }),
	);
	return (rev: string) =>
		execFileSync("git", ["rev-parse", rev], {
			cwd: code,
			encoding: "utf8",
		}).trim();
}

describe("the re-measure trigger", () => {
	it("is silent below 15 counted commits with no issue filed, and asks the tracker nothing but the search and that issue", () => {
		const fx = fixture({ hits: { "o/fleet": [ticket(1, range(1, 14))] } });
		const r = run(fx);
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(fx.calls().every((c) => c[1] === "graphql" || c[1] === "list")).toBe(
			true,
		);
	});

	it("counts no commit recorded on this repo's own tracker, still reporting its records and counting its escaped-defect line for an adopter's commit (#3576)", () => {
		const bad = "**Review findings:** base 1234567 reviewed";
		const fx = fixture({
			hits: {
				[OWN]: [
					ticket(1, range(1, 20), [bad]),
					{
						number: 2,
						updated: "2026-11-01",
						comments: [`**Escaped defect:** ${sha("c", 35)}`],
					},
				],
				"o/fleet": [
					ticket(3, range(21, 14)),
					ticket(4, [], [record(35, ["DECLINED: a style nit"])]),
				],
			},
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe(
			`UNPARSEABLE: ${OWN}#1 has a record not in \`scripts/lib/rule-text.sh review-tier-records\`'s form, so its commit is not counted until it is corrected: ${bad}\n`,
		);
		expect(r.stdout).toContain("Re-measure due: 15 counted commits. Filed");
		const body = flag(creates(fx)[0], "--body");
		expect(body).not.toContain(`${OWN}#`);
		expect(body).toContain(
			`- o/fleet#4: landed ${sha("c", 35)}, base ${sha("b", 35)}, tree ${sha("e", 35)}; 0 fixed or ticketed, 1 escaped`,
		);
		expect(
			fx
				.calls()
				.filter((c) => c[1]?.startsWith("search/commits?"))
				.map((c) => / repo:(\S+)/.exec(decodeURIComponent(c[1]))?.[1]),
		).toEqual(["o/fleet"]);
	});

	it("refreshes an existing issue below 15 silently, its first line the count less a reverted commit, and never files a second (#3576)", () => {
		const fx = fixture({
			hits: {
				[OWN]: [ticket(1, range(1, 18))],
				"o/manta": [ticket(2, [19, 20, 21])],
			},
			commits: {
				"o/manta": [
					{
						sha: "e".repeat(40),
						message: `Revert "x"\n\nThis reverts commit ${sha("c", 21).padEnd(40, "0")}.\n`,
					},
				],
			},
			issues: [
				{
					number: 77,
					title: TITLE,
					labels: [{ name: "takes:wayfinder" }],
					closedAt: null,
					createdAt: "2026-11-02T00:00:00Z",
				},
			],
		});
		const r = run(fx);
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(creates(fx)).toEqual([]);
		expect(fx.issueBody.body().split("\n")[0]).toMatch(
			/^2 commits on adopter-declared sensitive paths/,
		);
		expect(fx.issueBody.body()).not.toContain(`landed ${sha("c", 21)}`);
	});

	it("files one issue at 15, pooled across repos, listing each commit's repo, base and tree", () => {
		const fx = fixture({
			hits: {
				"o/fleet": [ticket(1, range(1, 8))],
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
			`- o/fleet#1: landed ${sha("c", 1)}, base ${sha("b", 1)}, tree ${sha("e", 1)}; 1 fixed or ticketed, 0 escaped`,
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
				"o/fleet": [
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
				"o/fleet": [
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
			`- o/fleet#1: landed ${sha("c", 15)}, base ${sha("b", 15)}, tree ${sha("e", 15)}; 0 fixed or ticketed, 1 escaped`,
		);
	});

	it("counts neither an ordinary review report under an escalated tier, a record with no escalated tier above it, nor one commit twice by a short and a full sha", () => {
		const fx = fixture({
			hits: {
				"o/fleet": [
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

	it("reports a record it cannot parse under an escalated tier, and neither a backticked mention, one under a standard tier, nor a close draft a parsed record of its tree supersedes (#3064)", () => {
		const bad = `**Review findings:** base ${sha("b", 1)}, reviewed ${sha("e", 1)} (pinned at refs/reviewed/${sha("e", 1)}), landed ${sha("c", 1)}`;
		const fx = fixture({
			hits: {
				"o/fleet": [
					{
						number: 7,
						updated: "2026-11-01",
						comments: [
							"**Review tier:** standard",
							bad,
							TIER_LINE,
							"The `**Review findings:**` comment names three shas.",
							`${bad}\n- FIXED: a leak in the log line (Focus)`,
						],
					},
					ticket(
						8,
						[2],
						[
							`**Review findings:** base ${sha("b", 2)}, reviewed ${sha("e", 2)}, landed LANDED`,
						],
					),
				],
			},
		});
		const r = run(fx);
		const fault = `o/fleet#7 has a record not in \`scripts/lib/rule-text.sh review-tier-records\`'s form, so its commit is not counted until it is corrected: ${bad}`;
		expect(r).toEqual({
			code: 0,
			stdout: "",
			stderr: `UNPARSEABLE: ${fault}\n`,
		});
		expect(readGuardErrorsLog(fx.config)).toContain(
			`report-remeasure-due\t${fault}`,
		);
	});

	it("reports a record with a note after its landed sha, never reading it pathless, and counts its commit once, with paths, under the record of its tree, or of its base and paths, that supersedes it (#3541)", () => {
		const noted = record(15).replace(
			/landed (\S+)/,
			"landed $1 (queued on landing), paths lib/pricing/quote.ts",
		);
		const fault = `o/fleet#2 has a record not in \`scripts/lib/rule-text.sh review-tier-records\`'s form, so its commit is not counted until it is corrected: ${noted.split("\n")[0]}`;
		const alone = run(
			fixture({
				hits: {
					"o/fleet": [ticket(1, range(1, 14)), ticket(2, [], [noted])],
				},
			}),
		);
		expect(alone).toEqual({
			code: 0,
			stdout: "",
			stderr: `UNPARSEABLE: ${fault}\n`,
		});
		const stray = record(18, undefined, "LANDED_SHA", "a.ts").replace(
			sha("b", 18),
			sha("b", 17),
		);
		const fx = fixture({
			hits: {
				"o/fleet": [
					ticket(1, range(1, 14)),
					ticket(
						2,
						[],
						[noted, record(15, undefined, undefined, "lib/pricing/quote.ts")],
					),
					/* A draft naming the landed tree, its correction the pinned one. */
					ticket(
						3,
						[],
						[
							record(16, undefined, "LANDED_SHA", "a.ts,b.ts").replace(
								sha("e", 16),
								sha("c", 16),
							),
							record(16, undefined, undefined, "b.ts a.ts"),
						],
					),
					/* Another commit from the same base, over other paths. */
					ticket(4, [], [record(17, undefined, undefined, "b.ts"), stray]),
				],
			},
		});
		const r = run(fx);
		expect(r.stderr).toBe(
			`UNPARSEABLE: o/fleet#4 has a record not in \`scripts/lib/rule-text.sh review-tier-records\`'s form, so its commit is not counted until it is corrected: ${stray.split("\n")[0]}\n`,
		);
		expect(r.stdout).toContain("17 counted commits");
		expect(flag(creates(fx)[0], "--body")).toContain(
			`- o/fleet#2: landed ${sha("c", 15)}, base ${sha("b", 15)}, tree ${sha("e", 15)}, paths lib/pricing/quote.ts; 1 fixed or ticketed, 0 escaped`,
		);
	});

	it("reports a record naming the tree its landed commit carries on its paths, judged in the checkout tracking its repo, and not one naming the pre-fix tree, one posted before the rule, one naming no paths, nor one that fixed nothing (#3444)", () => {
		const fx = fixture({ hits: {} });
		const rev = checkout(fx);
		const base = rev("base");
		const preFix = rev("refs/pre-fix");
		const landed = [1, 2, 3, 4, 5].map((n) => rev(`l${n}`));
		const tree = (c: string) => rev(`${c}^{tree}`);
		const line = (
			reviewed: string,
			l: string,
			paths = ", paths quote.ts",
			disposed = "FIXED: a leak in the log line",
		) =>
			[
				`**Review findings:** base ${base}, reviewed ${reviewed}, landed ${l}${paths}`,
				`- ${disposed} (Focus)`,
			].join("\n");
		/* On this repo's own tracker, which the count skips but this report
		 * still reads (#3576). */
		fx.setHits({
			[OWN]: [
				{
					number: 7,
					updated: "2026-11-01",
					comments: [
						TIER_LINE,
						line(tree(landed[0]), landed[0]),
						line(preFix, landed[1]),
						line(tree(landed[2]), landed[2], ""),
						line(
							tree(landed[4]),
							landed[4],
							undefined,
							"TICKETED #9: a leak in the log line",
						),
					],
				},
				{
					number: 8,
					updated: "2026-10-28",
					comments: [TIER_LINE, line(tree(landed[3]), landed[3])],
				},
			],
		});
		const r = run(fx);
		const fault = `${OWN}#7 has a record naming reviewed ${tree(landed[0])}, the tree landed ${landed[0]} carries on its paths, so a replay finds none of its fixed defects: name the tree pinned before the first round's dispatch, as \`scripts/lib/rule-text.sh review-tier-records\` says`;
		expect(r).toEqual({
			code: 0,
			stdout: "",
			stderr: `LANDED TREE: ${fault}\n`,
		});
		expect(readGuardErrorsLog(fx.config)).toContain(
			`report-remeasure-due\t${fault}`,
		);
	});

	it("reports a record its checkout cannot diff as unjudged, one line, and nothing more of it (#3544)", () => {
		const fx = fixture({ hits: {} });
		const rev = checkout(fx);
		const missing = "f".repeat(40);
		const reviewed = rev("refs/pre-fix");
		fx.setHits({
			[OWN]: [
				{
					number: 7,
					updated: "2026-11-01",
					comments: [
						TIER_LINE,
						[
							`**Review findings:** base ${rev("base")}, reviewed ${reviewed}, landed ${missing}, paths quote.ts`,
							"- FIXED: a leak in the log line (Focus)",
						].join("\n"),
					],
				},
			],
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(
			new RegExp(
				`^UNJUDGED: ${OWN}#7: could not diff reviewed ${reviewed} against landed ${missing} in \\S+, so whether its record names the landed tree is not judged until that checkout holds both — [^\\n]+\\n$`,
			),
		);
		expect(readGuardErrorsLog(fx.config)).toContain(
			`report-remeasure-due\t${OWN}#7: could not diff`,
		);
	});

	it("reads a record whose shas are backticked, and a ticket's comments past the first 100", () => {
		const fx = fixture({
			hits: {
				"o/fleet": [
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
			`- o/fleet#1: landed ${sha("c", 14)}, base ${sha("b", 14)}`,
		);
		expect(fx.calls()).toContainEqual([
			"api",
			"repos/o/fleet/issues/2/comments",
			"--paginate",
			"--slurp",
		]);
	});

	// #1926: a start-point replay narrows to these paths.
	it("counts a record naming its reviewed paths beside ones naming none, and lists the paths", () => {
		const fx = fixture({
			hits: {
				"o/fleet": [
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
			`- o/fleet#1: landed ${sha("c", 15)}, base ${sha("b", 15)}, tree ${sha("e", 15)}, paths lib/pricing/quote.ts,lib/pricing/tax.ts; 1 fixed or ticketed, 0 escaped`,
		);
		expect(body).toContain(
			`tree ${sha("e", 14)}; 1 fixed or ticketed, 0 escaped`,
		);
	});

	/** record(15) re-reviewed: base and tree of 16, naming quote.ts. */
	const withPaths = record(15, undefined, undefined, "`lib/pricing/quote.ts`")
		.replace(sha("b", 15), sha("b", 16))
		.replace(sha("e", 15), sha("e", 16));

	it("keeps a later record's paths, with its ticket, base and tree, where an earlier record of the same commit named none (#2083)", () => {
		const fx = fixture({
			hits: {
				"o/fleet": [
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
			`- o/fleet#2: landed ${sha("c", 15)}, base ${sha("b", 16)}, tree ${sha("e", 16)}, paths lib/pricing/quote.ts; 2 fixed or ticketed, 0 escaped`,
		);
	});

	it("keeps an earlier record's paths, base and tree over a later pathless record of the same commit (#2083)", () => {
		const fx = fixture({
			hits: {
				"o/fleet": [ticket(1, range(1, 14), [withPaths, record(15)])],
			},
		});
		expect(run(fx).stdout).toContain("15 counted commits");
		expect(flag(creates(fx)[0], "--body")).toContain(
			`- o/fleet#1: landed ${sha("c", 15)}, base ${sha("b", 16)}, tree ${sha("e", 16)}, paths lib/pricing/quote.ts; 2 fixed or ticketed, 0 escaped`,
		);
	});

	it("halves a window past search's 1,000-result cap until every hit is read", () => {
		const fx = fixture({
			wideDays: 5,
			hits: {
				"o/fleet": range(1, 15).map((n) => ({
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
				"o/fleet": [
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
		expect(readGuardErrorsLog(fx.config)).toMatch(
			/report-remeasure-due\tcould not read the corpus — .*0 of 1 hits/,
		);
		expect(creates(fx)).toEqual([]);
	});

	it("drops a commit whose revert is on its tracker's main, but not one whose revert was itself reverted (#3395)", () => {
		const full = (n: number) => sha("c", n).padEnd(40, "0");
		const revert = (by: string, of: string) => ({
			sha: by,
			message: `Revert "x"\n\nThis reverts commit ${of}.\n`,
		});
		const revertOf7 = "a".repeat(40);
		const commits = {
			"o/fleet": [
				revert(revertOf7, full(7)),
				revert("d".repeat(40), revertOf7),
			],
			"o/manta": [revert("e".repeat(40), full(17))],
		};
		const fx = fixture({
			hits: {
				"o/fleet": [ticket(1, range(1, 15))],
				"o/manta": [ticket(2, [17])],
			},
			commits,
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("Re-measure due: 15 counted commits. Filed");
		const body = flag(creates(fx)[0], "--body");
		expect(body).not.toContain(`landed ${sha("c", 17)}`);
		expect(body).toContain(`landed ${sha("c", 7)}`);
		expect(
			fx
				.calls()
				.filter((c) => c[1]?.startsWith("search/commits?"))
				.map((c) => / repo:(\S+)/.exec(decodeURIComponent(c[1]))?.[1]),
		).toEqual(["o/fleet", "o/manta"]);
		const below = fixture({
			hits: {
				"o/fleet": [ticket(1, range(1, 14))],
				"o/manta": [ticket(2, [17])],
			},
			commits,
		});
		expect(run(below)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(creates(below)).toEqual([]);
	});

	it.each([
		["fails", { commitsFail: true }, "HTTP 502: Bad Gateway"],
		[
			"returns fewer hits than its count",
			{ commitsShort: true },
			"o/fleet: revert search returned 0 of 1 hits",
		],
	])(
		"fails open, logging the fault, where the revert search %s (#3395)",
		(_, opts, why) => {
			const fx = fixture({
				...opts,
				hits: { "o/fleet": [ticket(1, range(1, 15))] },
			});
			const r = run(fx);
			expect(r.code).toBe(0);
			expect(r.stderr).toBe(
				`FAILED OPEN: could not read the corpus's reverts — ${why} — recorded in the guard-error log.\nNothing was filed; the next day's run retries.\n`,
			);
			expect(readGuardErrorsLog(fx.config)).toContain(
				`report-remeasure-due\tcould not read the corpus's reverts — ${why}`,
			);
			expect(creates(fx)).toEqual([]);
		},
	);

	it("fails open, logging the fault, where the filing fails (#1698)", () => {
		const fx = fixture({
			createFails: true,
			hits: { "o/fleet": [ticket(1, range(1, 15))] },
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe(
			`FAILED OPEN: could not file or refresh "${TITLE}" — HTTP 403: Resource not accessible — recorded in the guard-error log.\nThe next day's run retries.\n`,
		);
		expect(readGuardErrorsLog(fx.config)).toContain(
			`report-remeasure-due\tcould not file or refresh "${TITLE}" — HTTP 403`,
		);
	});
});
