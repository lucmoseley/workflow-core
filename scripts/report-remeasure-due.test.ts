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
	/** The filed issue's body as the run finds it; absent, empty. */
	body?: string;
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
	const writeData = (fields: object) =>
		fs.writeFileSync(
			data,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(data, "utf8")),
				...fields,
			}),
		);
	const issueBody = fakeIssueBody(root, opts.body);
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
		setHits: (hits: Record<string, Hit[]>) => writeData({ hits }),
		/** Replaces what commit search finds, for shas built after the root. */
		setCommits: (commits: Record<string, { sha: string; message: string }[]>) =>
			writeData({ commits }),
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

function run(fx: ReturnType<typeof fixture>, env: Record<string, string> = {}) {
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
			...env,
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
	fs.mkdirSync(path.join(dir, ".claude"));
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "F", tracker: OWN }),
	);
	git("add", ".claude");
	git("commit", "-qm", "config");
});

const gitIn = (cwd: string, ...a: string[]) =>
	execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/** Gives `code` a bare `origin` whose `main` holds its HEAD. */
function pushToNewOrigin(code: string) {
	const origin = `${code}-origin.git`;
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["remote", "add", "origin", origin], { cwd: code });
	execFileSync("git", ["push", "-q", "--no-verify", "origin", "HEAD:main"], {
		cwd: code,
	});
}

/** That checkout under `fx`'s home, tracking OWN; reads a rev in it. */
function checkout(fx: ReturnType<typeof fixture>) {
	const code = checkoutTemplate.instantiate(path.join(fx.root, "code"));
	pushToNewOrigin(code);
	return (rev: string) =>
		execFileSync("git", ["rev-parse", rev], {
			cwd: code,
			encoding: "utf8",
		}).trim();
}

const buildUnrecordedFault = (landed: string | undefined) =>
	`o/manta@${landed} changes the sensitive area secrets and carries neither a Review-Tier: trailer nor a **Review findings:** record, so nothing answers for it until a record names it as landed, or its message cites that record's ticket within the record's base..landed; \`scripts/lib/rule-text.sh review-tier-records\` gives the record's form`;

/**
 * A checkout under `fx`'s home tracking o/manta, which declares lib/secret.js
 * sensitive, holding one commit per `commits` entry, dated after the trailer
 * landed unless it says otherwise, all on its `origin`'s `main`; returns their
 * shas.
 */
function trailerCheckout(
	fx: ReturnType<typeof fixture>,
	commits: {
		file: string;
		trailer?: string;
		date?: string;
		message?: string;
	}[],
) {
	const code = path.join(fx.root, "manta");
	initGitRepo(code, path.join(fx.root, ".hooks"));
	fs.mkdirSync(path.join(code, ".claude"));
	fs.writeFileSync(
		path.join(code, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "F",
			tracker: "o/manta",
			sensitivePaths: [
				{
					name: "secrets",
					description: "credentials",
					globs: ["lib/secret.js"],
				},
			],
		}),
	);
	const git = (date: string, ...a: string[]) =>
		execFileSync("git", a, {
			cwd: code,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
			},
		}).trim();
	const shas = commits.map(
		({ file, trailer, date = "2026-11-01T12:00:00Z", message }, i) => {
			fs.mkdirSync(path.join(code, path.dirname(file)), { recursive: true });
			fs.writeFileSync(path.join(code, file), `${i}\n`);
			git(date, "add", "-A");
			git(
				date,
				"commit",
				"-qm",
				`${message ?? `change ${i}`}${trailer === undefined ? "" : `\n\nReview-Tier: ${trailer}`}`,
			);
			return git(date, "rev-parse", "HEAD");
		},
	);
	pushToNewOrigin(code);
	return shas;
}

/** The issue already filed, so a count below the threshold reaches its body. */
const FILED = [
	{
		number: 77,
		title: TITLE,
		labels: [{ name: LABEL }],
		closedAt: null,
		createdAt: "2026-11-02T00:00:00Z",
	},
];
const STANDARD_TIER = "**Review tier:** standard — no sensitive path.";
/* Past the record form's 7-hex minimum, as a sha is cited in a ticket. */
const SHORT_SHA = 9;
/** The issue's body as an earlier run left it, counting `n`. */
const buildFiledBody = (n: number) =>
	`${n} commits on adopter-declared sensitive paths, as last read.`;
const buildEscapeTicket = (escaped: string, number = 1): Hit => ({
	number,
	updated: "2026-11-05",
	comments: [
		`**Escaped defect:** ${escaped.slice(0, SHORT_SHA)} — it missed a case`,
	],
});
const buildMantaFindings = (
	base: string,
	landed: string,
	disposed: string[] = [],
) =>
	[
		`**Review findings:** base ${base}, reviewed ${"e".repeat(40)}, landed ${landed}, paths lib/secret.js`,
		...disposed.map((d) => `- ${d}`),
	].join("\n");
/** A record on o/manta#9, of `tier`. */
const buildMantaRecord = (
	base: string,
	landed: string,
	disposed: string[] = [],
	tier = TIER_LINE,
): Hit => ({
	number: 9,
	updated: "2026-11-05",
	comments: [tier, buildMantaFindings(base, landed, disposed)],
});
const buildMantaRow = (
	base: string,
	landed: string,
	fixed: number,
	escaped: number,
) =>
	`- o/manta#9: landed ${landed}, base ${base}, tree ${"e".repeat(40)}, paths lib/secret.js; ${fixed} fixed or ticketed, ${escaped} escaped`;
/** A seed, a commit citing #9, then the tip: what a two-commit ticket lands. */
const TWO_COMMIT_TICKET = [
	{ file: "app/page.tsx" },
	{ file: "lib/secret.js", message: "first of the ticket (#9)" },
	{ file: "lib/secret.js", message: "the tip" },
];
const readCountLine = (fx: { issueBody: { body: () => string } }) =>
	fx.issueBody.body().split("\n")[0];

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

	it("counts only what main holds: silent on a sha queued on landing, and reporting one on neither ref until a record of the same review names one that is on main (#3846)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [corrected, onMain, queued, replaced, lost] = trailerCheckout(fx, [
			{ file: "a.txt" },
			{ file: "b.txt" },
			{ file: "c.txt" },
			{ file: "d.txt" },
			{ file: "e.txt" },
		]) as [string, string, string, string, string];
		const code = path.join(fx.root, "manta");
		gitIn(
			code,
			"push",
			"-qf",
			"--no-verify",
			"origin",
			`${onMain}:refs/heads/main`,
		);
		gitIn(
			code,
			"push",
			"-q",
			"--no-verify",
			"origin",
			`${queued}:refs/heads/landing`,
		);
		const unheld = "d".repeat(40);
		fx.setHits({
			"o/manta": [
				ticket(1, [], [record(1, undefined, onMain)]),
				ticket(
					2,
					[],
					[record(2, undefined, replaced), record(2, undefined, corrected)],
				),
				ticket(3, [], [record(3, undefined, queued)]),
				ticket(4, [], [record(4, undefined, lost)]),
				ticket(5, [], [record(5, undefined, unheld)]),
			],
		});
		const r = run(fx, { WFC_MODULES: "landing" });
		expect(r.code).toBe(0);
		expect(r.stderr.split("\n")).toEqual([
			`OFF MAIN: o/manta#4 has a record naming landed ${lost}, which never reached main, so its commit is not counted until it is corrected: post a record naming the sha it landed under, as \`scripts/lib/rule-text.sh review-tier-records\` says`,
			expect.stringMatching(
				new RegExp(`^UNJUDGED: o/manta#5: could not walk landed ${unheld} `),
			),
			"",
		]);
		expect(readGuardErrorsLog(fx.config)).toContain(
			"report-remeasure-due\to/manta#4 has a record naming landed",
		);
		const body = fx.issueBody.body();
		expect(body.split("\n")[0]).toMatch(/^3 commits on adopter-declared/);
		for (const landed of [onMain, corrected, unheld])
			expect(body).toContain(`landed ${landed}`);
		for (const landed of [queued, replaced, lost])
			expect(body).not.toContain(`landed ${landed}`);
	});

	it("takes an escape on a sha queued on landing into no count and no fault, until it lands (#3846)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [onMain, queued] = trailerCheckout(fx, [
			{ file: "a.txt" },
			{ file: "b.txt" },
		]) as [string, string];
		const code = path.join(fx.root, "manta");
		gitIn(
			code,
			"push",
			"-qf",
			"--no-verify",
			"origin",
			`${onMain}:refs/heads/main`,
		);
		gitIn(
			code,
			"push",
			"-q",
			"--no-verify",
			"origin",
			`${queued}:refs/heads/landing`,
		);
		fx.setHits({
			"o/manta": [
				ticket(1, [], [record(1, [], onMain)]),
				ticket(
					2,
					[],
					[record(2, [], queued), `**Escaped defect:** ${queued} — a leak`],
				),
			],
		});
		const r = run(fx, { WFC_MODULES: "landing" });
		expect(r.stderr).toBe("");
		expect(fx.issueBody.body().split("\n")[0]).toMatch(/^0 commits on/);
	});

	it("reads the pushed ref as main with the landing module off, so a sha only on landing is off main (#3846)", () => {
		const fx = fixture({ hits: {} });
		const [onMain, queued] = trailerCheckout(fx, [
			{ file: "a.txt" },
			{ file: "b.txt" },
		]) as [string, string];
		const code = path.join(fx.root, "manta");
		gitIn(
			code,
			"push",
			"-qf",
			"--no-verify",
			"origin",
			`${onMain}:refs/heads/main`,
		);
		gitIn(code, "update-ref", "refs/remotes/origin/landing", queued);
		fx.setHits({ "o/manta": [ticket(1, [], [record(1, undefined, queued)])] });
		expect(run(fx, { WFC_MODULES: "" }).stderr).toContain(
			`OFF MAIN: o/manta#1 has a record naming landed ${queued}`,
		);
	});

	it("counts a disposition line with no space after its dash (#3846)", () => {
		const tight = record(15, ["x"]).replace("- x (Standards)", "-FIXED: x");
		const fx = fixture({
			hits: { "o/fleet": [ticket(1, range(1, 14), [tight])] },
		});
		expect(run(fx).stdout).toContain("15 counted commits");
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

	it("counts a commit by its Review-Tier: trailer with no record, once where a record names it too, and reports a malformed trailer and a sensitive commit carrying neither, older than the repo's first trailer too (#3664, #3714)", () => {
		const fx = fixture({
			hits: {},
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
		const trailer = (n: number) =>
			`escalated; areas=secrets; base=${"b".repeat(40)}; tree=${String(n).repeat(40)}; paths=lib/secret.js`;
		const [earliest, alone, both, neither, , declined, malformed] =
			trailerCheckout(fx, [
				{ file: "lib/secret.js" },
				{ file: "lib/secret.js", trailer: trailer(1) },
				{ file: "lib/secret.js", trailer: trailer(2) },
				{ file: "lib/secret.js" },
				{ file: "app/page.tsx" },
				{ file: "lib/secret.js" },
				{ file: "lib/secret.js", trailer: "escalated; no fields" },
			]);
		fx.setHits({
			"o/manta": [
				{
					number: 9,
					updated: "2026-11-05",
					comments: [
						`**Escaped defect:** ${alone} — the scan missed a token in a URL`,
						TIER_LINE,
						record(2, undefined, both),
						record(5, ["DECLINED: a rename the precedent rules out"], declined),
					],
				},
			],
		});
		const r = run(fx);
		const fault = buildUnrecordedFault(neither);
		expect(r).toEqual({
			code: 0,
			stdout: "",
			stderr: `UNPARSEABLE: o/manta@${malformed} has a Review-Tier: trailer not in scripts/review-hold-gate.sh's form, so it is not counted by it: escalated; no fields\nUNRECORDED: ${fault}\nUNRECORDED: ${buildUnrecordedFault(earliest)}\n`,
		});
		expect(readGuardErrorsLog(fx.config)).toContain(
			`report-remeasure-due\t${fault}`,
		);
		const body = fx.issueBody.body();
		expect(body.split("\n")[0]).toMatch(
			/^2 commits on adopter-declared sensitive paths/,
		);
		expect(body).toContain(
			`- o/manta#9: landed ${both}, base ${sha("b", 2)}, tree ${sha("e", 2)}; 1 fixed or ticketed, 0 escaped`,
		);
		expect(body).toContain(
			`- o/manta@${alone}: Review-Tier: trailer alone, base ${"b".repeat(40)}, landed tree ${"1".repeat(40)}, paths lib/secret.js; 1 escaped`,
		);
		expect(body).not.toContain(`@${both}`);
	});

	it("reports a sensitive commit landed from a linked worktree in a repo with no trailer anywhere, from 591ef1a74's commit time and not before (#3714)", () => {
		const fx = fixture({ hits: {} });
		const [, atInstant] = trailerCheckout(fx, [
			{ file: "lib/secret.js", date: "2026-10-29T14:57:17Z" },
			{ file: "lib/secret.js", date: "2026-10-29T14:57:18Z" },
		]);
		const code = path.join(fx.root, "manta");
		const wt = path.join(fx.root, "wt");
		gitIn(code, "worktree", "add", "-q", "-b", "landing", wt);
		fs.writeFileSync(path.join(wt, "lib", "secret.js"), "from a worktree\n");
		gitIn(wt, "commit", "-qam", "from a worktree");
		const landed = gitIn(wt, "rev-parse", "HEAD");
		gitIn(code, "merge", "-q", "--ff-only", "landing");
		gitIn(code, "push", "-q", "--no-verify", "origin", "HEAD:main");
		const r = run(fx);
		expect(r).toEqual({
			code: 0,
			stdout: "",
			stderr: `UNRECORDED: ${buildUnrecordedFault(landed)}\nUNRECORDED: ${buildUnrecordedFault(atInstant)}\n`,
		});
	});

	it("judges origin/main, the commits a checkout behind it has not fetched and the sensitive paths declared there, and never its own commits off main (#3819)", () => {
		const fx = fixture({ hits: {} });
		const [behind = ""] = trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		const code = path.join(fx.root, "manta");
		const elsewhere = path.join(fx.root, "elsewhere");
		execFileSync("git", ["clone", "-q", `${code}-origin.git`, elsewhere]);
		gitIn(elsewhere, "config", "user.email", "t@t");
		gitIn(elsewhere, "config", "user.name", "t");
		gitIn(elsewhere, "config", "core.hooksPath", "/dev/null");
		const config = path.join(elsewhere, ".claude", "workflow-core.json");
		const declared = JSON.parse(fs.readFileSync(config, "utf8"));
		declared.sensitivePaths[0].globs = ["lib/secret.js", "lib/token.js"];
		fs.writeFileSync(config, JSON.stringify(declared));
		fs.writeFileSync(path.join(elsewhere, "lib", "token.js"), "landed\n");
		gitIn(elsewhere, "add", "-A");
		gitIn(elsewhere, "commit", "-qm", "landed by the lander");
		const landed = gitIn(elsewhere, "rev-parse", "HEAD");
		gitIn(elsewhere, "push", "-q", "origin", "HEAD:main");
		fs.writeFileSync(path.join(code, "lib", "secret.js"), "unpushed\n");
		gitIn(code, "commit", "-qam", "unpushed, off main");
		const unpushed = gitIn(code, "rev-parse", "HEAD");
		const r = run(fx);
		expect(r).toEqual({
			code: 0,
			stdout: "",
			stderr: `UNRECORDED: ${buildUnrecordedFault(landed)}\nUNRECORDED: ${buildUnrecordedFault(behind)}\n`,
		});
		expect(r.stderr).not.toContain(unpushed);
	});

	it("credits a record with the commits in its base..landed citing its ticket, not a neighbour's in that range nor a later citation (#3819)", () => {
		const fx = fixture({ hits: {} });
		const [
			base = "",
			cited = "",
			neighbour = "",
			passing = "",
			tip = "",
			later = "",
		] = trailerCheckout(fx, [
			{ file: "app/page.tsx" },
			{ file: "lib/secret.js", message: "first of the ticket (#9)" },
			{ file: "lib/secret.js", message: "a neighbour's (#91, mantahostels#9)" },
			{ file: "lib/secret.js", message: "second of the ticket\n\nFor #9." },
			{ file: "lib/secret.js", message: "the tip" },
			{ file: "lib/secret.js", message: "a later fix, after #9" },
		]);
		fx.setHits({
			"o/manta": [
				{
					number: 9,
					updated: "2026-11-05",
					comments: [
						TIER_LINE,
						`**Review findings:** base ${base}, reviewed ${"e".repeat(40)}, landed ${tip}, paths lib/secret.js`,
					],
				},
			],
		});
		const r = run(fx);
		expect(r.stderr).toBe(
			`UNRECORDED: ${buildUnrecordedFault(later)}\nUNRECORDED: ${buildUnrecordedFault(neighbour)}\n`,
		);
		expect(r.stderr).not.toContain(cited);
		expect(r.stderr).not.toContain(passing);
	});

	it("reports a commit an unparseable record names as landed once, by that record (#3819)", () => {
		const fx = fixture({ hits: {} });
		const [landed = ""] = trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		const line = `**Review findings:** base ${"b".repeat(9)}, reviewed ${"e".repeat(9)}, landed pending (${landed.slice(0, SHORT_SHA)} on \`landing\`), paths lib/secret.js`;
		fx.setHits({
			"o/manta": [
				{ number: 9, updated: "2026-11-05", comments: [TIER_LINE, line] },
			],
		});
		const r = run(fx);
		expect(r.stderr).toContain("UNPARSEABLE: o/manta#9");
		expect(r.stderr).not.toContain("UNRECORDED");
	});

	it("reports a record whose range git cannot read as unread, and its uncited-by-sha commit as unrecorded (#3819)", () => {
		const fx = fixture({ hits: {} });
		const [cited = "", tip = ""] = trailerCheckout(fx, [
			{ file: "lib/secret.js", message: "first of the ticket (#9)" },
			{ file: "app/page.tsx" },
		]);
		const base = "b".repeat(40);
		fx.setHits({
			"o/manta": [
				{
					number: 9,
					updated: "2026-11-05",
					comments: [
						TIER_LINE,
						`**Review findings:** base ${base}, reviewed ${"e".repeat(40)}, landed ${tip}, paths lib/secret.js`,
					],
				},
			],
		});
		const r = run(fx);
		expect(r.stderr).toMatch(
			new RegExp(
				`^UNREAD: o/manta#9: could not read its record's range ${base}\\.\\.${tip} in \\S+, so it covers only its landed sha — [^\\n]+\\n`,
			),
		);
		expect(r.stderr).toContain(`UNRECORDED: ${buildUnrecordedFault(cited)}`);
	});

	it("credits an escape naming a covered commit to the record covering it (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [base = "", cited = "", tip = ""] = trailerCheckout(
			fx,
			TWO_COMMIT_TICKET,
		);
		fx.setHits({
			"o/manta": [buildMantaRecord(base, tip)],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		const r = run(fx);
		expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(readCountLine(fx)).toMatch(/^1 commits /);
		expect(fx.issueBody.body()).toContain(buildMantaRow(base, tip, 0, 1));
	});

	it("credits an escape once, to the record naming it as landed over a later one covering it (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [base = "", cited = "", tip = ""] = trailerCheckout(
			fx,
			TWO_COMMIT_TICKET,
		);
		fx.setHits({
			"o/manta": [
				{
					number: 9,
					updated: "2026-11-05",
					comments: [
						TIER_LINE,
						buildMantaFindings(base, cited),
						buildMantaFindings(base, tip),
					],
				},
			],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(readCountLine(fx)).toMatch(/^1 commits /);
		expect(fx.issueBody.body()).toContain(buildMantaRow(base, cited, 0, 1));
	});

	it("reports an escape on a commit no counted record covers, past the range or of a lower tier, counting it on nothing (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [base = "", cited = "", tip = "", after = ""] = trailerCheckout(fx, [
			...TWO_COMMIT_TICKET,
			{ file: "app/page.tsx", message: "after the tip, citing #9" },
		]);
		const fault = (s: string) =>
			`UNCOUNTED: o/manta: an **Escaped defect:** names ${s.slice(0, SHORT_SHA)}, which no counted record covers, so it counts on nothing until a record covers it or the line is corrected\n`;
		fx.setHits({
			"o/manta": [buildMantaRecord(base, tip)],
			"o/fleet": [buildEscapeTicket(after)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: fault(after) });
		expect(readCountLine(fx)).toMatch(/^0 commits /);
		fx.setHits({
			"o/manta": [buildMantaRecord(base, tip, [], STANDARD_TIER)],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: fault(cited) });
		expect(readCountLine(fx)).toMatch(/^0 commits /);
	});

	it("reports nothing of an escape on this repo's own commit, which never counts (#3832)", () => {
		const fx = fixture({ hits: {} });
		const [own = ""] = trailerCheckout(fx, [{ file: "app/page.tsx" }]);
		const config = path.join(fx.root, "manta", ".claude", "workflow-core.json");
		fs.writeFileSync(
			config,
			fs.readFileSync(config, "utf8").replace('"o/manta"', `"${OWN}"`),
		);
		fx.setHits({ "o/fleet": [buildEscapeTicket(own)] });
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
	});

	it("refreshes where only this repo's own tracker is unread, its commits never being counted (#3832)", () => {
		const fx = fixture({
			hits: { "o/fleet": [ticket(1, [1, 2])] },
			issues: FILED,
			body: buildFiledBody(3),
		});
		trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		const code = path.join(fx.root, "manta");
		const config = path.join(code, ".claude", "workflow-core.json");
		fs.writeFileSync(
			config,
			fs.readFileSync(config, "utf8").replace('"o/manta"', `"${OWN}"`),
		);
		gitIn(code, "remote", "set-url", "origin", `${fx.root}/gone.git`);
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(/^UNREAD: o\/wfc: /);
		expect(r.stderr).not.toContain("HELD");
		expect(readCountLine(fx)).toMatch(/^2 commits /);
	});

	it("gives a trailered commit citing a record whose range is unread no row of its own (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const trailer = `escalated; areas=secrets; base=${"b".repeat(40)}; tree=${"1".repeat(40)}; paths=lib/secret.js`;
		const [, , tip = ""] = trailerCheckout(fx, [
			{ file: "app/page.tsx" },
			{ file: "lib/secret.js", message: "first of the ticket (#9)", trailer },
			{ file: "lib/secret.js", message: "the tip" },
		]);
		fx.setHits({
			"o/manta": [
				buildMantaRecord("b".repeat(40), tip, ["TICKETED: a leak (Standards)"]),
			],
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(/^UNREAD: o\/manta#9: could not read/);
		expect(readCountLine(fx)).toMatch(/^1 commits /);
	});

	it("reports an escape on a sha no record names and no checkout holds, once however often it is named (#3832)", () => {
		const gone = "f".repeat(40);
		const fx = fixture({
			hits: {
				"o/fleet": [buildEscapeTicket(gone), buildEscapeTicket(gone, 2)],
			},
		});
		const fault = `an **Escaped defect:** names ${gone.slice(0, SHORT_SHA)}, which no counted record names as landed and no checkout on this machine holds, so it counts on no record until a checkout holds it or the line is corrected`;
		expect(run(fx)).toEqual({
			code: 0,
			stdout: "",
			stderr: `UNLOCATED: ${fault}\n`,
		});
	});

	it("keeps a record when a covered commit is reverted, dropping only an escape credited through that commit (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [base = "", cited = "", tip = ""] = trailerCheckout(
			fx,
			TWO_COMMIT_TICKET,
		);
		fx.setCommits({
			"o/manta": [
				{
					sha: "d".repeat(40),
					message: `Revert "x"\n\nThis reverts commit ${cited}.\n`,
				},
			],
		});
		fx.setHits({
			"o/manta": [
				buildMantaRecord(base, tip, ["TICKETED: a leak (Standards)"]),
			],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(readCountLine(fx)).toMatch(/^1 commits /);
		expect(fx.issueBody.body()).toContain(buildMantaRow(base, tip, 1, 0));
		fx.setHits({
			"o/manta": [buildMantaRecord(base, tip)],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(readCountLine(fx)).toMatch(/^0 commits /);
	});

	it("holds the tracking issue where an unread tracker would lower its count, and refreshes it where it would not (#3832)", () => {
		const fx = fixture({
			hits: { "o/fleet": [ticket(1, [1, 2])] },
			issues: FILED,
			body: buildFiledBody(3),
		});
		trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		gitIn(
			path.join(fx.root, "manta"),
			"remote",
			"set-url",
			"origin",
			`${fx.root}/gone.git`,
		);
		const held = run(fx);
		expect(held.code).toBe(0);
		expect(fx.issueBody.calls()).toEqual([]);
		expect(fx.issueBody.body()).toBe(buildFiledBody(3));
		expect(held.stderr).toMatch(/^UNREAD: o\/manta: /);
		expect(held.stderr).toContain(
			"HELD: #77 stays at 3 commits, this run reading 2; the next day's run retries\n",
		);
		for (const body of [
			buildFiledBody(2),
			buildFiledBody(1),
			"hand-written, no count",
		]) {
			fs.writeFileSync(fx.issueBody.bodyFile, body);
			const r = run(fx);
			expect(r.code).toBe(0);
			expect(r.stderr).not.toContain("HELD");
			expect(readCountLine(fx)).toMatch(/^2 commits /);
		}
	});

	it("holds the tracking issue where a checkout's config will not read, reporting it unread (#3832)", () => {
		const fx = fixture({
			hits: { "o/fleet": [ticket(1, [1, 2])] },
			issues: FILED,
			body: buildFiledBody(3),
		});
		trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		fs.writeFileSync(
			path.join(fx.root, "manta", ".claude", "workflow-core.json"),
			"{ not json",
		);
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("would not read");
		expect(r.stderr).toMatch(/UNREAD: o\/manta: could not read .* under /);
		expect(r.stderr).toContain("HELD: #77 stays at 3 commits");
		expect(fx.issueBody.calls()).toEqual([]);
	});

	it("refreshes on a record's unread range no escape rests on (#3832)", () => {
		const fx = fixture({
			hits: {},
			issues: FILED,
			body: buildFiledBody(3),
		});
		const [, , tip = ""] = trailerCheckout(fx, TWO_COMMIT_TICKET);
		fx.setHits({
			"o/manta": [buildMantaRecord("b".repeat(40), tip, ["FIXED: a leak"])],
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(/^UNREAD: o\/manta#9: could not read/);
		expect(r.stderr).not.toContain("HELD");
		expect(readCountLine(fx)).toMatch(/^1 commits /);
	});

	it("credits a covered escape to a commit recorded by a short sha and then a full one (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [base = "", cited = "", tip = ""] = trailerCheckout(
			fx,
			TWO_COMMIT_TICKET,
		);
		fx.setHits({
			"o/manta": [
				{
					number: 9,
					updated: "2026-11-05",
					comments: [
						TIER_LINE,
						buildMantaFindings(base, tip.slice(0, SHORT_SHA)),
						buildMantaFindings(base, tip),
					],
				},
			],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(fx.issueBody.body()).toContain(buildMantaRow(base, tip, 0, 1));
	});

	it("keeps an escape on a surviving covered commit where the record's tip is reverted, dropping the tip's findings and escape (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const [base = "", cited = "", tip = ""] = trailerCheckout(
			fx,
			TWO_COMMIT_TICKET,
		);
		fx.setCommits({
			"o/manta": [
				{
					sha: "d".repeat(40),
					message: `Revert "x"\n\nThis reverts commit ${tip}.\n`,
				},
			],
		});
		fx.setHits({
			"o/manta": [
				buildMantaRecord(base, tip, ["TICKETED: a leak (Standards)"]),
			],
			"o/fleet": [buildEscapeTicket(cited), buildEscapeTicket(tip, 2)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(fx.issueBody.body()).toContain(
			`${buildMantaRow(base, tip, 0, 1)}, its tip reverted`,
		);
		fx.setHits({
			"o/manta": [
				buildMantaRecord(base, tip, ["TICKETED: a leak (Standards)"]),
			],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(readCountLine(fx)).toMatch(/^0 commits /);
	});

	it("gives a covered commit carrying a trailer no row of its own, its escape counting on the record (#3832)", () => {
		const fx = fixture({ hits: {}, issues: FILED });
		const trailer = `escalated; areas=secrets; base=${"b".repeat(40)}; tree=${"1".repeat(40)}; paths=lib/secret.js`;
		const [base = "", cited = "", tip = ""] = trailerCheckout(fx, [
			{ file: "app/page.tsx" },
			{ file: "lib/secret.js", message: "first of the ticket (#9)", trailer },
			{ file: "lib/secret.js", message: "the tip" },
		]);
		fx.setHits({
			"o/manta": [
				buildMantaRecord(base, tip, ["TICKETED: a leak (Standards)"]),
			],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		expect(run(fx)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(readCountLine(fx)).toMatch(/^1 commits /);
		expect(fx.issueBody.body()).toContain(buildMantaRow(base, tip, 1, 1));
	});

	it("reports an escape git fails on as unread, not unheld, and holds the count (#3832)", () => {
		const fx = fixture({
			hits: {},
			issues: FILED,
			body: buildFiledBody(1),
		});
		const [cited = ""] = trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		fx.setHits({ "o/fleet": [buildEscapeTicket(cited)] });
		gitIn(
			path.join(fx.root, "manta"),
			"config",
			"core.repositoryformatversion",
			"99",
		);
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain(
			`o/manta: could not read escaped ${cited.slice(0, SHORT_SHA)}`,
		);
		expect(r.stderr).not.toContain("UNLOCATED");
		expect(r.stderr).toContain("HELD: #77 stays at 1 commits");
	});

	it("holds the count on a record's unread range too, whose escape it may have lost (#3832)", () => {
		const fx = fixture({
			hits: {},
			issues: FILED,
			body: buildFiledBody(1),
		});
		const [, cited = "", tip = ""] = trailerCheckout(fx, TWO_COMMIT_TICKET);
		fx.setHits({
			"o/manta": [buildMantaRecord("b".repeat(40), tip)],
			"o/fleet": [buildEscapeTicket(cited)],
		});
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(/^UNREAD: o\/manta#9: could not read/);
		expect(r.stderr).toContain("HELD: #77 stays at 1 commits");
		expect(fx.issueBody.calls()).toEqual([]);
	});

	it("reports a checkout whose config at origin/main will not read as unread, however its working copy reads (#3819)", () => {
		const fx = fixture({ hits: {} });
		trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		const code = path.join(fx.root, "manta");
		const config = path.join(code, ".claude", "workflow-core.json");
		const good = fs.readFileSync(config, "utf8");
		fs.writeFileSync(config, "{ not json");
		gitIn(code, "add", "-A");
		gitIn(code, "commit", "-qm", "break the config");
		gitIn(code, "push", "-q", "--no-verify", "origin", "HEAD:main");
		fs.writeFileSync(config, good);
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(
			/^UNREAD: o\/manta: could not read its commits' Review-Tier: trailers in \S+, so none is counted and none unrecorded reported — [^\n]+\n$/,
		);
	});

	it("reports a checkout whose origin git cannot fetch as unread (#3664, #3819)", () => {
		const fx = fixture({ hits: {} });
		trailerCheckout(fx, [{ file: "lib/secret.js" }]);
		execFileSync(
			"git",
			["remote", "set-url", "origin", `${fx.root}/gone.git`],
			{
				cwd: path.join(fx.root, "manta"),
			},
		);
		const r = run(fx);
		expect(r.code).toBe(0);
		expect(r.stderr).toMatch(
			/^UNREAD: o\/manta: could not read its commits' Review-Tier: trailers in \S+, so none is counted and none unrecorded reported — [^\n]+\n$/,
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
