// @vitest-environment node
/*
 * The scheduled §B budget reporter (mantahostels#971, the ticket that put a published
 * word budget on docs/doc-map.md §B and ruled it must never fail a build).
 *
 * Every fixture size is derived from the script's own BUDGET_WORDS: the budget
 * is a ratchet that moves (mantahostels#1079).
 *
 * `gh` is stubbed as a real executable injected at WFC_GH — the named seam
 * scripts/lib/gh.js documents — which records its own argv. The issue-body stub
 * writes the replacement body back over what the stub `gh issue view` answers
 * with, so the refresh path can be run twice.
 *
 * It runs in the daily repo-checks run,
 * the only thing acting on the §B figure: loosen a case and a breach files
 * nothing, or a duplicate or stale issue is filed unattended.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-doc-map-budget.js");
const { BUDGET_WORDS } = require("./report-doc-map-budget.js");
/** Comfortably over and comfortably under, so neither reads as a boundary case. */
const OVER = BUDGET_WORDS + 10_000;
const UNDER = BUDGET_WORDS - 10_000;
const commas = (n: number) => n.toLocaleString("en-GB");
const TITLE = "doc-map §B — drain the entries over the 300-word prose cap";

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

/** A map whose §B runs to `words` words, with a §C behind it to bound the section. */
const mapDoc = (words: number) =>
	[
		"# Doc map",
		"",
		"v1.0 · 22 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"",
		"## Section B",
		"",
		// The heading above is three whitespace-delimited tokens — `##` counts, as
		// every markdown marker in §B does — and the heading line is inside the
		// range sectionBWords measures.
		Array.from({ length: words - 3 }, (_, i) => `w${i}`).join(" "),
		"",
		"## Section C — question routes",
		"",
		"padding words that must not be counted",
		"",
	].join("\n");

const prose = (n: number) =>
	Array.from({ length: n }, (_, i) => `p${i}`).join(" ");

/** An over-budget §B carrying `n` real `### B<n>` entries — for entry-count/rate tests. */
const entryMapDoc = (n: number) =>
	[
		"# Doc map",
		"",
		"v1.0 · 22 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"",
		"## Section B",
		"",
		prose(OVER),
		"",
		...Array.from({ length: n }, (_, i) => [
			`### B${i + 1} · E${i + 1}`,
			"",
			"- **Owner:** x",
			"",
			"body",
			"",
		]).flat(),
		"## Section C — question routes",
		"",
		"padding words that must not be counted",
		"",
	].join("\n");

/**
 * A map well over budget on padding alone, carrying two real `### B<n>`
 * entries whose prose runs to `b1Words`/`b2Words` — so the drain queue's own
 * worklist is exercised end to end, over cap or under it depending on what
 * the caller passes.
 */
const mapDocWithEntries = (b1Words: number, b2Words: number) =>
	[
		"# Doc map",
		"",
		"v1.0 · 22 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"",
		"## Section B",
		"",
		prose(OVER),
		"",
		"### B1 · Alpha",
		"",
		"- **Owner:** x",
		"- **Settled at #1**",
		"",
		prose(b1Words),
		"",
		"### B2 · Beta",
		"",
		"- **Owner:** x",
		"",
		prose(b2Words),
		"",
		"## Section C — question routes",
		"",
		"padding words that must not be counted",
		"",
	].join("\n");

/**
 * A map with one unexempted over-cap entry (B1) and one carrying an
 * `Over cap by ruling` marker (B2) — for the exempted-stanza split.
 */
const mapDocWithExemptEntry = (
	b1Words: number,
	b2Words: number,
	ruling: number,
) =>
	[
		"# Doc map",
		"",
		"v1.0 · 22 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"",
		"## Section B",
		"",
		prose(OVER),
		"",
		"### B1 · Alpha",
		"",
		"- **Owner:** x",
		"",
		prose(b1Words),
		"",
		"### B2 · Beta",
		"",
		"- **Owner:** x",
		`- **Over cap by ruling (#${ruling}):** every claim here is load-bearing.`,
		"",
		prose(b2Words),
		"",
		"## Section C — question routes",
		"",
		"padding words that must not be counted",
		"",
	].join("\n");

/**
 * A map whose only over-cap entries (B1, B2) both carry an
 * `Over cap by ruling` marker — no unexempted entry at all. Two entries,
 * not one, so the stanza's `(N)` count is exercised against a real count
 * rather than a fixture a hardcoded `1` would also satisfy.
 */
const mapDocWithTwoExemptEntries = (
	b1Words: number,
	b2Words: number,
	ruling1: number,
	ruling2: number,
) =>
	[
		"# Doc map",
		"",
		"v1.0 · 22 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"",
		"## Section B",
		"",
		prose(OVER),
		"",
		"### B1 · Alpha",
		"",
		"- **Owner:** x",
		`- **Over cap by ruling (#${ruling1}):** every claim here is load-bearing.`,
		"",
		prose(b1Words),
		"",
		"### B2 · Beta",
		"",
		"- **Owner:** x",
		`- **Over cap by ruling (#${ruling2}):** every claim here is load-bearing.`,
		"",
		prose(b2Words),
		"",
		"## Section C — question routes",
		"",
		"padding words that must not be counted",
		"",
	].join("\n");

/**
 * A map with one unexempted over-cap entry (B1) carrying a line that reaches
 * for the exemption marker and misses it — no bold leader — and one clean
 * unexempted over-cap entry (B2) with no marker attempt at all (mantahostels#2269).
 */
const mapDocWithMalformedMarker = (b1Words: number, b2Words: number) =>
	[
		"# Doc map",
		"",
		"v1.0 · 22 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"",
		"## Section B",
		"",
		prose(OVER),
		"",
		"### B1 · Alpha",
		"",
		"- **Owner:** x",
		"- Over cap by ruling (#1911): every claim here is load-bearing.",
		"",
		prose(b1Words),
		"",
		"### B2 · Beta",
		"",
		"- **Owner:** x",
		"",
		prose(b2Words),
		"",
		"## Section C — question routes",
		"",
		"padding words that must not be counted",
		"",
	].join("\n");

/**
 * A single unexempted over-cap entry (B1) carrying two lines that each reach
 * for the exemption marker and miss (mantahostels#2269).
 */
const mapDocWithTwoMalformedMarkers = (b1Words: number) =>
	[
		"# Doc map",
		"",
		"v1.0 · 22 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"",
		"## Section B",
		"",
		prose(OVER),
		"",
		"### B1 · Alpha",
		"",
		"- **Owner:** x",
		"- Over cap by ruling (#1911): every claim here is load-bearing.",
		"- Over cap by ruling (#1912): a second, contradicting attempt.",
		"",
		prose(b1Words),
		"",
		"## Section C — question routes",
		"",
		"padding words that must not be counted",
		"",
	].join("\n");

function fixture(opts: {
	words: number;
	ghIssueList: unknown;
	/** What `gh issue view --json body` answers with, for the refresh path;
	 * absent, an empty body. */
	existingBody?: string;
	/** Overrides `mapDoc(opts.words)` — for a fixture that needs real `### B<n>` entries. */
	mapText?: string;
	/**
	 * Seeds `docs/doc-map.md`'s git history for `sectionBEntryRate` — a throwaway
	 * repo, one commit per entry, dated `daysAgo` days back via
	 * GIT_AUTHOR_DATE/GIT_COMMITTER_DATE. Omitted entirely, the fixture stays a
	 * bare directory (no git repo at all), as the other tests here need.
	 */
	historyCommits?: { mapText: string; daysAgo: number }[];
	/** What the stub's `gh issue edit` exits with — for the label-edit failure path. */
	ghEditExitCode?: number;
}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "b-budget-"));
	temps.push(root);

	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "docs", "doc-map.md"),
		opts.mapText ?? mapDoc(opts.words),
	);

	if (opts.historyCommits) {
		const git = (args: string[], env?: Record<string, string>) =>
			execFileSync("git", args, {
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
		git(["init", "-q", "-b", "main", "."]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "test"]);
		for (const c of opts.historyCommits) {
			fs.writeFileSync(path.join(root, "docs", "doc-map.md"), c.mapText);
			const date = new Date(
				Date.now() - c.daysAgo * 24 * 60 * 60 * 1000,
			).toISOString();
			git(["add", "--", "docs/doc-map.md"]);
			git(["commit", "-qm", `map at ${c.daysAgo}d`, "--", "docs/doc-map.md"], {
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
			});
		}
		// Restore the working-tree state the test asked for — the script reads
		// this file directly, never HEAD, so the last commit need not match it.
		fs.writeFileSync(
			path.join(root, "docs", "doc-map.md"),
			opts.mapText ?? mapDoc(opts.words),
		);
	}

	// The sanctioned body writer (mantahostels#131), faked so the refresh path is
	// observable without a network call.
	const issueBody = fakeIssueBody(root, opts.existingBody);

	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const argvLog = path.join(root, "gh-argv.log");
	const ghStub = path.join(bin, "gh");
	fs.writeFileSync(
		ghStub,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
			`  cat ${JSON.stringify(path.join(root, "issues.json"))}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
			`  cat ${JSON.stringify(issueBody.bodyFile)}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
			"  echo https://github.com/o/r/issues/999",
			'elif [ "$1" = "issue" ] && [ "$2" = "edit" ]; then',
			`  echo "label edit refused" >&2; exit ${opts.ghEditExitCode ?? 0}`,
			"fi",
			"exit 0",
		].join("\n"),
	);
	fs.chmodSync(ghStub, 0o755);
	fs.writeFileSync(
		path.join(root, "issues.json"),
		JSON.stringify(opts.ghIssueList),
	);

	return { root, ghStub, argvLog, issueBody };
}

function run(fx: ReturnType<typeof fixture>, ...args: string[]) {
	const r = runInProcess(SCRIPT, args, {
		cwd: fx.root,
		env: {
			...process.env,
			WFC_GH: fx.ghStub,
			WFC_ISSUE_BODY: fx.issueBody.script,
		},
	});
	return { code: r.status, output: r.stdout + r.stderr };
}

const USAGE = "usage: node report-doc-map-budget.js [<doc-map.md>] [--dry-run]";

const ghCalls = (fx: ReturnType<typeof fixture>): string =>
	fs.existsSync(fx.argvLog) ? fs.readFileSync(fx.argvLog, "utf8") : "";

/*
 * One open tracking issue as `gh issue list --json number,title,labels` really
 * answers. `takes` is what the fixture's own map implies, so the steady state
 * under test is a label already right and no `issue edit` at all — a row with
 * no labels at all would send every refresh case down the "issue carries no
 * takes: value" branch instead (mantahostels#1079).
 */
const openIssue = (takes: string) => [
	{
		number: 42,
		title: TITLE,
		labels: [{ name: "documentation" }, { name: takes }],
	},
];

describe("the scheduled §B budget reporter", () => {
	it("files nothing, and touches gh not at all, under budget", () => {
		const fx = fixture({ words: BUDGET_WORDS - 1, ghIssueList: [] });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain(`${commas(BUDGET_WORDS - 1)} words`);
		expect(output).toContain("Under budget");
		expect(ghCalls(fx)).toBe("");
	});

	it("treats the budget itself as within it — the breach is over, not at", () => {
		const fx = fixture({ words: BUDGET_WORDS, ghIssueList: [] });

		expect(run(fx).output).toContain("Under budget");
		expect(ghCalls(fx)).toBe("");
	});

	it("files one issue on a breach when none is open, and still exits 0", () => {
		const fx = fixture({ words: BUDGET_WORDS + 1, ghIssueList: [] });

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain(`${commas(BUDGET_WORDS + 1)} words`);
		expect(output).toContain("Filed https://github.com/o/r/issues/999");
		expect(ghCalls(fx)).toContain(`issue create --title ${TITLE}`);
		// No `### B<n>` entry in this fixture, so the queue is empty and what is
		// left is a decision (mantahostels#3352).
		expect(ghCalls(fx)).toContain(
			"--label documentation --label takes:wayfinder",
		);
	});

	it("creates under takes:implement when the queue holds an unexempted entry", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: [],
			mapText: mapDocWithEntries(400, 100),
		});

		expect(run(fx).code).toBe(0);
		// Matched as the `--label` flag pair, not as a bare substring: the body
		// names both values in prose and rides the same command line.
		expect(ghCalls(fx)).toContain(
			"--label documentation --label takes:implement",
		);
	});

	it("creates under takes:wayfinder when every over-cap entry is exempted by ruling", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: [],
			mapText: mapDocWithTwoExemptEntries(400, 380, 1911, 2285),
		});

		expect(run(fx).code).toBe(0);
		expect(ghCalls(fx)).toContain(
			"--label documentation --label takes:wayfinder",
		);
		expect(ghCalls(fx)).not.toContain("takes:human");
	});

	it("creates under takes:implement on a mixed queue — one unexempted entry is enough", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: [],
			mapText: mapDocWithExemptEntry(400, 380, 1911),
		});

		expect(run(fx).code).toBe(0);
		expect(ghCalls(fx)).toContain(
			"--label documentation --label takes:implement",
		);
	});

	// mantahostels#1079.
	it("moves an open issue's takes: label when the queue has emptied under it", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:implement"),
			mapText: mapDocWithTwoExemptEntries(400, 380, 1911, 2285),
			existingBody: "stale body",
		});

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("takes:implement → takes:wayfinder.");
		// Asserted as outcome, not as one flag string: which of the two flags
		// gh is handed first is not a guarantee this owns.
		expect(ghCalls(fx)).toContain("issue edit 42 ");
		expect(ghCalls(fx)).toContain("--add-label takes:wayfinder");
		expect(ghCalls(fx)).toContain("--remove-label takes:implement");
	});

	it("moves it back when the queue refills", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:wayfinder"),
			mapText: mapDocWithEntries(400, 100),
			existingBody: "stale body",
		});

		expect(run(fx).output).toContain("takes:wayfinder → takes:implement.");
		expect(ghCalls(fx)).toContain("--add-label takes:implement");
		expect(ghCalls(fx)).toContain("--remove-label takes:wayfinder");
	});

	it("touches the label not at all when it is already right", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:implement"),
			mapText: mapDocWithEntries(400, 100),
			existingBody: "stale body",
		});

		expect(run(fx).output).not.toContain("takes:");
		expect(ghCalls(fx)).not.toContain("issue edit");
	});

	it("adds the label to an issue carrying no takes: value at all", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: [
				{ number: 42, title: TITLE, labels: [{ name: "documentation" }] },
			],
			mapText: mapDocWithEntries(400, 100),
			existingBody: "stale body",
		});

		expect(run(fx).output).toContain("Labelled takes:implement.");
		expect(ghCalls(fx)).toContain("--add-label takes:implement");
		expect(ghCalls(fx)).not.toContain("--remove-label");
	});

	it("overwrites a hand-set third value rather than respecting it", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:triage"),
			mapText: mapDocWithEntries(400, 100),
			existingBody: "stale body",
		});

		expect(run(fx).output).toContain("takes:triage → takes:implement.");
	});

	// The wanted value present but not alone: the early return must not fire on
	// it, and the stray must come off.
	it("strips a stray takes: value sitting alongside the right one", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: [
				{
					number: 42,
					title: TITLE,
					labels: [
						{ name: "documentation" },
						{ name: "takes:implement" },
						{ name: "takes:triage" },
					],
				},
			],
			mapText: mapDocWithEntries(400, 100),
			existingBody: "stale body",
		});

		expect(run(fx).output).toContain("takes:triage → takes:implement.");
		expect(ghCalls(fx)).toContain("--remove-label takes:triage");
		expect(ghCalls(fx)).not.toContain("--remove-label takes:implement");
	});

	it("names every stale value when two must come off", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: [
				{
					number: 42,
					title: TITLE,
					labels: [
						{ name: "documentation" },
						{ name: "takes:triage" },
						{ name: "takes:human" },
					],
				},
			],
			mapText: mapDocWithEntries(400, 100),
			existingBody: "stale body",
		});

		expect(run(fx).output).toContain(
			"takes:triage, takes:human → takes:implement.",
		);
		expect(ghCalls(fx)).toContain("--remove-label takes:triage");
		expect(ghCalls(fx)).toContain("--remove-label takes:human");
	});

	// The label is not the run's job — the body is, and it has already landed.
	it("keeps the refresh line and exit 0 when the label edit fails", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:human"),
			mapText: mapDocWithEntries(400, 100),
			existingBody: "stale body",
			ghEditExitCode: 1,
		});

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("Refreshed #42");
		expect(output).toContain("Could not set takes:implement");
	});

	it("leaves the label alone entirely while §B is under budget", () => {
		const fx = fixture({
			words: UNDER,
			ghIssueList: openIssue("takes:human"),
		});

		expect(run(fx).output).toContain("Under budget");
		expect(ghCalls(fx)).toBe("");
	});

	it("refreshes the open issue rather than filing a second", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
		});

		const { code, output } = run(fx);
		expect(code).toBe(0);
		expect(output).toContain("Refreshed #42");
		expect(ghCalls(fx)).not.toContain("issue create");
		expect(fx.issueBody.calls()).toEqual([
			expect.stringContaining("replace 42 --file"),
		]);
	});

	// Asserted end to end rather than against the script's own body(), which
	// would agree with itself however it was written.
	it("leaves the open issue alone on a second run over the same figure", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
		});

		expect(run(fx).output).toContain("Refreshed #42");
		expect(run(fx).output).toContain("#42 is open and current");
		expect(fx.issueBody.calls()).toHaveLength(1);
	});

	it("ignores an open issue of another title under the same label", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: [{ number: 7, title: "Something else entirely" }],
		});

		expect(run(fx).output).toContain("Filed ");
		expect(ghCalls(fx)).toContain("issue create");
	});

	it("--dry-run reports the breach and touches no issue", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });

		const { code, output } = run(fx, "--dry-run");
		expect(code).toBe(0);
		expect(output).toContain(`${commas(OVER)} words`);
		expect(output).toContain("no issue filed");
		expect(ghCalls(fx)).toBe("");
	});

	it("is BROKEN, not silently red, when gh refuses, saying it could not file or refresh the tracking issue", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });
		fs.writeFileSync(fx.ghStub, "#!/bin/sh\necho 'gh: HTTP 403' >&2\nexit 1\n");
		fs.chmodSync(fx.ghStub, 0o755);

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain("could not file or refresh the tracking issue");
	});

	// mantahostels#971's own near-miss.
	it("refuses an unknown flag, naming it and the usage, rather than treating it as a live run", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });

		const { code, output } = run(fx, "--dryrun");
		expect(code).toBe(2);
		expect(output).toContain("unknown flag: --dryrun");
		expect(output).toContain(USAGE);
		expect(ghCalls(fx)).toBe("");
	});

	// Over budget with no issue open, so a fall-through would file (#1062).
	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const fx = fixture({ words: OVER, ghIssueList: [] });

			const { code, output } = run(fx, flag);
			expect(code).toBe(0);
			expect(output).toContain(USAGE);
			expect(ghCalls(fx)).toBe("");
		}
	});

	it("never reads -h as the map path, even where a file of that name exists", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });
		fs.copyFileSync(
			path.join(fx.root, "docs", "doc-map.md"),
			path.join(fx.root, "-h"),
		);

		const { code, output } = run(fx, "-h");
		expect(code).toBe(0);
		expect(output).toContain(USAGE);
		expect(ghCalls(fx)).toBe("");
	});

	it("answers --help before the module gate, so governance off still prints usage", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });
		vi.stubEnv("WFC_MODULES", "");

		const { code, output } = run(fx, "--help");
		expect(code).toBe(0);
		expect(output).toContain(USAGE);
		expect(output).not.toContain("SKIP");
	});

	it("refuses a second map path, naming it, exits non-zero, and calls gh not at all", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });

		const { code, output } = run(fx, "docs/doc-map.md", "docs/doc-map.md");
		expect(code).toBe(2);
		expect(output).toContain("unexpected argument: docs/doc-map.md");
		expect(ghCalls(fx)).toBe("");
	});

	it("is BROKEN, not under budget, when the map will not read, and calls gh not at all", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });
		fs.rmSync(path.join(fx.root, "docs", "doc-map.md"));

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain("cannot read doc map");
		expect(ghCalls(fx)).toBe("");
	});

	it("is BROKEN, not under budget, when the file carries no §B at all", () => {
		const fx = fixture({ words: OVER, ghIssueList: [] });
		fs.writeFileSync(
			path.join(fx.root, "docs", "doc-map.md"),
			"# Doc map\n\nv1.0 · 22 August 2026\n",
		);

		const { code, output } = run(fx);
		expect(code).toBe(2);
		expect(output).toContain('no "## Section B" heading');
		expect(ghCalls(fx)).toBe("");
	});

	it("lists over-cap entries in the filed body, largest excess first", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: mapDocWithEntries(310, 500),
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();
		const b2 = filedBody.indexOf(
			"§B2: 500 prose words, 200 over the 300-word cap",
		);
		const b1 = filedBody.indexOf(
			"§B1: 310 prose words, 10 over the 300-word cap",
		);
		expect(b2).toBeGreaterThan(-1);
		expect(b1).toBeGreaterThan(-1);
		expect(b2).toBeLessThan(b1);
	});

	// The map still carries entries — under cap, not absent — so this proves
	// "nothing owes a drain" rather than "there is nothing to measure".
	it("names no over-cap entry once every entry is under cap", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: mapDocWithEntries(250, 299),
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();
		expect(filedBody).toContain(
			"None — every §B entry is at or under the 300-word prose cap.",
		);
	});

	// mantahostels#2060: an exempted over-cap entry moves out of the drain worklist into
	// its own stanza, counted and named with its prose word count.
	it("splits an exempted over-cap entry into its own stanza", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: mapDocWithExemptEntry(310, 500, 1911),
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();

		const drainQueue = filedBody
			.split("## Drain queue")[1]
			.split("## Exempted over cap by ruling")[0];
		const exemptedSection = filedBody.split(
			"## Exempted over cap by ruling",
		)[1];

		expect(drainQueue).toContain(
			"§B1: 310 prose words, 10 over the 300-word cap",
		);
		expect(drainQueue).not.toContain("§B2");
		expect(exemptedSection).toContain(
			"§B2: 511 prose words, 211 over the 300-word cap (#1911)",
		);
		expect(filedBody).toContain("## Exempted over cap by ruling (1)");
	});

	// mantahostels#2060: a map whose only over-cap entries are all exempted must not
	// claim every entry is at or under the cap, must say so explicitly, and
	// must count them correctly — two entries, so a hardcoded `1` in the
	// stanza heading cannot pass.
	it("does not claim every entry is under cap when the only over-cap entries are exempted", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: mapDocWithTwoExemptEntries(300, 500, 1911, 1912),
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();

		expect(filedBody).not.toContain(
			"None — every §B entry is at or under the 300-word prose cap.",
		);
		expect(filedBody).toContain(
			"None — every remaining over-cap entry is exempted by ruling (see below).",
		);
		expect(filedBody).toContain("## Exempted over cap by ruling (2)");
		const exemptedSection = filedBody.split(
			"## Exempted over cap by ruling",
		)[1];
		expect(exemptedSection).toContain(
			"§B1: 311 prose words, 11 over the 300-word cap (#1911)",
		);
		expect(exemptedSection).toContain(
			"§B2: 511 prose words, 211 over the 300-word cap (#1912)",
		);
	});

	// mantahostels#2269
	it("annotates a drain-queue entry whose marker is malformed", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: mapDocWithMalformedMarker(310, 320),
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();

		const drainQueue = filedBody.split("## Drain queue")[1];
		expect(drainQueue).toContain(
			"§B1: 321 prose words, 21 over the 300-word cap — carries a line that " +
				"does not parse as an exemption marker: " +
				"`- Over cap by ruling (#1911): every claim here is load-bearing.`",
		);
		expect(drainQueue).toContain(
			"§B2: 320 prose words, 20 over the 300-word cap",
		);
		expect(drainQueue).not.toContain(
			"§B2: 320 prose words, 20 over the 300-word cap — carries",
		);
	});

	// mantahostels#2269: an entry with several near-miss lines names all of them, not just
	// the last — grouping by id must not overwrite.
	it("names every near-miss line on an entry that carries more than one", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: mapDocWithTwoMalformedMarkers(310),
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();
		const drainQueue = filedBody.split("## Drain queue")[1];

		expect(drainQueue).toContain(
			"`- Over cap by ruling (#1911): every claim here is load-bearing.`, " +
				"`- Over cap by ruling (#1912): a second, contradicting attempt.`",
		);
	});

	// mantahostels#2269: a near-miss line carrying a backtick must not break the inline
	// code it's wrapped in — the fence widens past the longest run inside it.
	it("widens the inline-code fence when the near-miss line itself carries a backtick", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: mapDocWithMalformedMarker(310, 320).replace(
				"- Over cap by ruling (#1911): every claim here is load-bearing.",
				"- Over cap by ruling (#1911): `load-bearing` in the strict sense.",
			),
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();
		const drainQueue = filedBody.split("## Drain queue")[1];

		expect(drainQueue).toContain(
			"`` - Over cap by ruling (#1911): `load-bearing` in the strict sense. ``",
		);
	});

	// mantahostels#1347.
	it("carries §B's entry count and 7-day rate in the filed body", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: entryMapDoc(12),
			historyCommits: [
				{ mapText: entryMapDoc(3), daysAgo: 10 },
				{ mapText: entryMapDoc(5), daysAgo: 7 },
				{ mapText: entryMapDoc(12), daysAgo: 0 },
			],
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();
		expect(filedBody).toContain("§B holds 12 entries");
		expect(filedBody).toMatch(
			/\+1\.0\/day over the last 7\.0 day\(s\) of git history/,
		);
	});

	// mantahostels#1347.
	it("reports the rate over the actual span when git history is under 7 days", () => {
		const fx = fixture({
			words: 0,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
			mapText: entryMapDoc(9),
			historyCommits: [
				{ mapText: entryMapDoc(2), daysAgo: 3 },
				{ mapText: entryMapDoc(9), daysAgo: 0 },
			],
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();
		expect(filedBody).toContain("§B holds 9 entries");
		expect(filedBody).toMatch(
			/\+2\.3\/day over the last 3\.0 day\(s\) of git history/,
		);
	});

	/*
	 * mantahostels#1384's observable half: how many §B entries were BORN over the 300-word
	 * prose cap in the trailing 7 days. Under check-doc-map.js's assertion 14 —
	 * which refuses the commit that adds one — this reads zero, so any other
	 * reading is the routed-around commit the line exists to catch.
	 */
	describe("the births-over-cap line", () => {
		/** A §B over budget on padding, holding one entry per `[id, proseWords]`. */
		const birthDoc = (entries: [string, number][]) =>
			[
				"# Doc map",
				"",
				"v1.0 · 22 August 2026",
				"",
				"## Section A — authority register",
				"",
				"| Path | Role | Authority |",
				"",
				"## Section B",
				"",
				prose(OVER),
				"",
				...entries.flatMap(([id, n]) => [
					`### ${id} · ${id}`,
					"",
					"- **Owner:** x",
					"",
					prose(n),
					"",
				]),
				"## Section C — question routes",
				"",
				"padding words that must not be counted",
				"",
			].join("\n");

		const filedBodyFor = (history: { mapText: string; daysAgo: number }[]) => {
			const fx = fixture({
				words: 0,
				ghIssueList: openIssue("takes:human"),
				existingBody: "stale body",
				mapText: history.at(-1)?.mapText,
				historyCommits: history,
			});
			expect(run(fx).code).toBe(0);
			return fx.issueBody.body();
		};

		it("names an entry born over the cap, with its birth word count", () => {
			const filedBody = filedBodyFor([
				{ mapText: birthDoc([["B1", 10]]), daysAgo: 3 },
				{
					mapText: birthDoc([
						["B1", 10],
						["B2", 400],
					]),
					daysAgo: 1,
				},
			]);
			expect(filedBody).toContain("2 entries born in the last 7 day(s)");
			expect(filedBody).toContain(
				"1 over the 300-word prose cap at birth, heaviest first: §B2 (400).",
			);
		});

		it("measures at birth, so a drained entry still counts", () => {
			const filedBody = filedBodyFor([
				{ mapText: birthDoc([["B1", 900]]), daysAgo: 3 },
				{ mapText: birthDoc([["B1", 20]]), daysAgo: 1 },
			]);
			expect(filedBody).toContain(
				"1 over the 300-word prose cap at birth, heaviest first: §B1 (900).",
			);
		});

		it("says none where every birth was under the cap", () => {
			const filedBody = filedBodyFor([
				{ mapText: birthDoc([["B1", 10]]), daysAgo: 3 },
				{
					mapText: birthDoc([
						["B1", 10],
						["B2", 20],
					]),
					daysAgo: 1,
				},
			]);
			expect(filedBody).toContain("none over the 300-word prose cap at birth.");
		});

		it("reports births as unavailable outside a git repo", () => {
			const fx = fixture({
				words: OVER,
				ghIssueList: openIssue("takes:human"),
				existingBody: "stale body",
			});
			expect(run(fx).code).toBe(0);
			expect(fx.issueBody.body()).toContain("Births over cap unavailable");
		});

		it("never gates — an all-over-cap week still exits 0", () => {
			const fx = fixture({
				words: 0,
				ghIssueList: openIssue("takes:human"),
				existingBody: "stale body",
				mapText: birthDoc([["B1", 900]]),
				historyCommits: [{ mapText: birthDoc([["B1", 900]]), daysAgo: 1 }],
			});
			expect(run(fx).code).toBe(0);
		});
	});

	it("reports the rate as unavailable outside a git repo", () => {
		const fx = fixture({
			words: OVER,
			ghIssueList: openIssue("takes:human"),
			existingBody: "stale body",
		});

		const { code } = run(fx);
		expect(code).toBe(0);
		const filedBody = fx.issueBody.body();
		expect(filedBody).toContain(
			"rate unavailable (docs/doc-map.md's git history could not be read)",
		);
	});
});
