// @vitest-environment node
/*
 * Pins that file-issue refuses a bad label, body, `takes:human` ticket,
 * placement or likely duplicate before any create, and that a filed issue is
 * labelled, linked under its parent and verified in one call.
 *
 * file-issue.js, driven through its command line with the gh stub and a
 * sandboxed arbiter store (#533; the seam ruled on #500, Q1 (A)).
 *
 * The real link-sub-issue.sh runs underneath, against the same stub, so a
 * link reported as made is one the parent side listed. Breaking a refusal
 * case costs the guarantee the script exists for — nothing half-filed — so
 * each asserts that no create was sent. It is the route the issue-create
 * guard sends every new ticket down, so a loosened case files tickets that
 * route to nobody or sit unplaced. The takes: value set is pinned here too,
 * against each hand copy of it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { issueClaims, store } from "./lib/arbiter-testkit";
import {
	assignCall,
	DECLARED,
	fileIssueKit,
	filing,
	ME,
	NEW,
	SCRIPT,
} from "./lib/file-issue-testkit";
import {
	callLogPath,
	FALLBACK_LEAD,
	type JudgeFakePlan,
	judgeFakeEnv,
	MODEL_LEAD,
	OVERRIDE_LEAD,
	OVERRIDE_LINE,
	OVERRIDE_REASON,
} from "./lib/gate-judge-fake";
import { stubGhScript } from "./lib/gh-stub";
import { readJsonl } from "./lib/jsonl.js";
import { MARKERS_REL } from "./lib/marker-root";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { TAKES_VALUES } from "./lib/takes-label";

const kit = fileIssueKit();
const { sb, at, setUp, readGhCalls, readCreates, readClaimants, readBodySeen } =
	kit;
const run = kit.program;

describe("the takes: label", () => {
	it("spells the same seven values docs/agents/triage-labels.md and place-new-issue.sh's takes_values do", () => {
		const doc = fs.readFileSync(
			path.resolve(__dirname, "..", "docs", "agents", "triage-labels.md"),
			"utf8",
		);
		expect(TAKES_VALUES).toHaveLength(7);
		for (const v of TAKES_VALUES) expect(doc).toContain(`takes:${v}`);
		const placed = fs
			.readFileSync(path.resolve(__dirname, "place-new-issue.sh"), "utf8")
			.match(/^takes_values="(.*)"$/m)?.[1];
		expect(placed?.match(/takes:[a-z-]+/g)).toEqual(
			TAKES_VALUES.map((v) => `takes:${v}`),
		);
	});
});

describe("a label the tracker does not know", () => {
	it("exits 2 before any create, naming it", () => {
		setUp();
		const r = run(filing(["takes:implement", "kind:tiket"]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("kind:tiket is not a label on acme/widgets");
		expect(r.stderr).toContain("Fix the spelling");
		expect(r.stderr).toContain("Nothing filed.");
		expect(readCreates()).toEqual([]);
	});
});

describe("the body", () => {
	it("reads it from a file, backticks and all, and sends it through standard input", () => {
		setUp();
		const file = at("body.md");
		fs.writeFileSync(file, "Run `rm -rf /` never.\n");
		const args = filing(["takes:implement"]);
		args[args.length - 1] = file;
		const r = run(args);
		expect(r.status).toBe(0);
		expect(readBodySeen()).toBe("Run `rm -rf /` never.\n");
	});
});

describe("the model reading (#4969)", () => {
	const Wait = "Re-measure over seven days of those records.";
	const judged = (stdin: string, plan: JudgeFakePlan) =>
		run(filing(["takes:implement"]), {
			stdin,
			extraEnv: judgeFakeEnv(sb.dir, plan).env,
		});
	const waitFound = {
		reading: {
			waits: [
				{
					sentence: Wait,
					on: "data",
					window: "seven days",
					basisNamesWindow: false,
				},
			],
			bases: [],
		},
	};

	it("refuses a body whose wait only the model reads, printing the template and the override", () => {
		setUp();
		const r = judged(`Build it.\n\n${Wait}\n`, waitFound);
		expect(r.status).toBe(2);
		const refusal = r.stderr.slice(r.stderr.indexOf("Nothing filed:"));
		expect(refusal).toContain(`Nothing filed: the body carries ${MODEL_LEAD}:`);
		expect(refusal).toContain(`"${Wait}" makes work wait on data accumulating`);
		expect(refusal).toContain("question 1:");
		expect(refusal).toContain("The line's template: `**Gate basis:**");
		expect(refusal).toContain(
			"`**Gate judge override:** <why the reading is wrong>`",
		);
		expect(readGhCalls()).toEqual([]);
	});

	it("files a body whose override gives a reason, saying it was honoured, and logs it", () => {
		setUp();
		fs.rmSync(callLogPath(), { force: true });
		const r = judged(`Build it.\n\n${Wait}\n${OVERRIDE_LINE}\n`, waitFound);
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
		expect(r.stderr).toContain(`${OVERRIDE_LEAD} ("${OVERRIDE_REASON}")`);
		expect(readJsonl(callLogPath())?.rows).toEqual([
			expect.objectContaining({ override: OVERRIDE_REASON }),
		]);
	});

	it("refuses a body whose override gives no reason", () => {
		setUp();
		const r = judged(
			`Build it.\n\n${Wait}\n**Gate judge override:**\n`,
			waitFound,
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("gives no reason, so it clears nothing");
		expect(readGhCalls()).toEqual([]);
	});

	it("refuses a body the patterns fault, an override line present", () => {
		setUp();
		const r = judged(
			`**Gated until:** 2026-10-05 — a week live\n\n${Wait}\n${OVERRIDE_LINE}\n`,
			waitFound,
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("as the wording patterns read it");
		expect(readGhCalls()).toEqual([]);
	});

	it("refuses a body the patterns fault as before, the model's finding in the same message", () => {
		setUp();
		const r = judged(
			`**Gated until:** 2026-10-05 — a week live\n\n${Wait}\n`,
			waitFound,
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("Nothing filed: the body carries");
		const refusal = r.stderr.slice(r.stderr.indexOf("Nothing filed:"));
		expect(refusal).toContain(
			"no `**Gate basis:**` line, as the wording patterns read it.",
		);
		expect(refusal).toContain(`It also carries ${MODEL_LEAD}:`);
		expect(refusal).toContain(`"${Wait}"`);
		expect(readGhCalls()).toEqual([]);
	});

	it("files on the patterns alone where the model cannot be had, saying so once", () => {
		setUp();
		const r = judged(`Build it.\n\n${Wait}\n`, { exit: 1 });
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
		expect(r.stderr.split(FALLBACK_LEAD)).toHaveLength(2);
		expect(r.stderr).toContain("the judge exited 1");
		expect(r.stderr).not.toContain(MODEL_LEAD);
	});

	it("logs the call: route, faults by reading, wall time, fallback", () => {
		setUp();
		fs.rmSync(callLogPath(), { force: true });
		judged(`Build it.\n\n${Wait}\n`, waitFound);
		const rows = readJsonl(callLogPath())?.rows ?? [];
		expect(rows).toEqual([
			expect.objectContaining({
				route: "file-issue",
				issue: null,
				patterns: [],
				model: [{ kind: "no-basis", text: Wait, on: "data" }],
				ms: expect.any(Number),
				fallback: null,
			}),
		]);
	});
});

describe("create, then link", () => {
	it("prints the number GitHub returned and links that number, verified from the parent side", () => {
		setUp();
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`Filed #${NEW}: https://github.com/acme/widgets/issues/${NEW}`,
		);
		expect(r.stdout).toContain(`linked #${NEW} as a sub-issue of #528`);
		const calls = readGhCalls();
		expect(calls).toContain(
			"api --method POST repos/acme/widgets/issues/528/sub_issues -F sub_issue_id=987654",
		);
		expect(calls.at(-1)).toContain("repos/acme/widgets/issues/528/sub_issues");
	});

	it("exits 1 when the create prints no issue URL, saying to search before re-running", () => {
		setUp();
		const silent = stubGhScript(
			at("alt"),
			`#!/bin/sh\necho "$*" >> ${shellQuote(at("gh-calls"))}\ncase "$*" in "issue create"*) cat >/dev/null; exit 0;; esac\ncat ${shellQuote(at("api"))}/"$(echo "$2" | tr / _)"\n`,
		);
		const r = runInProcess(
			SCRIPT,
			[...filing(["takes:implement"]), ...DECLARED],
			{
				env: { ...process.env, ...silent.env },
				stdin: "Body.\n",
			},
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("printed no issue URL");
		expect(r.stderr).toContain("Search acme/widgets's open issues");
	});

	it.each([
		[
			"the 7-layer cap",
			"gh: You can't add more than 7 layers of sub-issues (HTTP 422)",
			`give #${NEW} #528's own parent — scripts/link-sub-issue.sh 500 ${NEW}`,
		],
		[
			"the 100-child cap",
			"gh: Parent cannot have more than 100 sub-issues (HTTP 422)",
			`node scripts/archive-closed-children.js 528, then scripts/link-sub-issue.sh 528 ${NEW}`,
		],
	])(
		"exits 1 on a link refused at %s, naming the created issue and its remedy",
		(_, err, remedy) => {
			setUp(["kind:spec"], {
				parent_issue_url:
					"https://api.github.com/repos/acme/widgets/issues/500",
			});
			fs.writeFileSync(at("post-err"), err);
			const r = run(filing(["takes:implement"]));
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(`#${NEW} was filed but not linked under #528`);
			expect(r.stderr).toContain(remedy);
			expect(r.stderr).toContain("Do NOT file it again.");
			expect(readCreates()).toHaveLength(1);
			expect(readGhCalls().some((c) => c.includes("DELETE"))).toBe(false);
		},
	);
});

describe("a link failing for any other reason", () => {
	it("exits 1 naming the created issue, the finishing link, and, under --assign-self, the claim still owed", () => {
		setUp();
		fs.writeFileSync(at("post-err"), "gh: Bad credentials (HTTP 401)");
		const r = run([...filing(["takes:implement"]), "--assign-self"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`#${NEW} was filed but not linked under #528`);
		expect(r.stderr).toContain(
			`Finish it with scripts/link-sub-issue.sh 528 ${NEW} once the cause is fixed.`,
		);
		expect(r.stderr).toContain(
			`It is not yet claimed: node scripts/claim-issue.js ${NEW} once it is placed.`,
		);
		expect(issueClaims.readIssueClaims(NEW)).toEqual([]);
	});
});

describe("the acts ledger (#2308)", () => {
	it("records one file line for the filing session, and none for a refused filing", () => {
		setUp();
		expect(run(filing(["kind:ticket"])).status).toBe(2);
		expect(run(filing(["takes:implement"])).status).toBe(0);
		expect(store.readActsBy(ME, [sb.repo]).acts).toEqual([
			`file acme/widgets#${NEW}`,
		]);
	});
});

describe("assignment", () => {
	it("leaves the new issue unassigned by default, with no arbiter record", () => {
		setUp();
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`#${NEW} is unassigned.`);
		expect(readGhCalls().some((c) => c.startsWith("issue edit"))).toBe(false);
		expect(readCreates()[0]).not.toContain("assignee");
		expect(issueClaims.readIssueClaims(NEW)).toEqual([]);
	});

	it("with --assign-self, writes the arbiter record and assigns @me", () => {
		setUp();
		const r = run([...filing(["takes:implement"]), "--assign-self"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Recorded the arbiter claim for session ${ME}.`);
		expect(readClaimants()).toEqual([ME]);
		expect(readGhCalls()).toContain(assignCall);
	});

	it("with --assign-self and no session id, assigns and says no record was written", () => {
		setUp();
		const r = run([...filing(["takes:implement"]), "--assign-self"], {
			sessionId: null,
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("no arbiter record was written");
		expect(issueClaims.readIssueClaims(NEW)).toEqual([]);
	});
});

describe("a charting session's map and its children (#2314)", () => {
	const mapFiling = () =>
		filing(
			["takes:wayfinder", "wayfinder:map"],
			["--standalone", "a new effort"],
		);

	it("claims and assigns a map filed under a session id, without --assign-self", () => {
		setUp();
		const r = run(mapFiling());
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Recorded the arbiter claim for session ${ME}.`);
		expect(readClaimants()).toEqual([ME]);
		expect(readGhCalls()).toContain(assignCall);
	});

	it("leaves a map filed with no session id unassigned", () => {
		setUp();
		const r = run(mapFiling(), { sessionId: null });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`#${NEW} is unassigned.`);
		expect(readGhCalls()).not.toContain(assignCall);
	});

	it("leaves a research ticket filed under a map unassigned and unclaimed", () => {
		setUp(["wayfinder:map", "takes:wayfinder"]);
		const r = run(filing(["takes:wayfinder", "wayfinder:research"]));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`#${NEW} is unassigned.`);
		expect(readClaimants()).toEqual([]);
		expect(readGhCalls()).not.toContain(assignCall);
	});
});

describe("--assign-self failing once the issue is placed", () => {
	it("exits 1 when the arbiter cannot record the claim, naming the issue and claim-issue", () => {
		setUp();
		fs.mkdirSync(path.dirname(store.paths.issueClaimsDir()), {
			recursive: true,
		});
		fs.writeFileSync(store.paths.issueClaimsDir(), "not a directory");
		const r = run([...filing(["takes:implement"]), "--assign-self"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			`#${NEW} is filed and placed, but the arbiter would not record the claim`,
		);
		expect(r.stderr).toContain(`node scripts/claim-issue.js ${NEW}`);
		expect(readGhCalls().some((c) => c.startsWith("issue edit"))).toBe(false);
	});

	it("exits 1 when the assignment fails after the record, saying the record stands", () => {
		setUp();
		fs.writeFileSync(at("assign-fails"), "");
		const r = run([...filing(["takes:implement"]), "--assign-self"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`Recorded the arbiter claim for session ${ME}.`);
		expect(r.stderr).toContain(`assigning #${NEW} failed (HTTP 403: no)`);
		expect(r.stderr).toContain(`node scripts/claim-issue.js ${NEW}`);
	});
});

describe("usage", () => {
	it("answers --help and -h with the usage and exit 0, filing nothing (#1078)", () => {
		for (const help of ["--help", "-h"]) {
			const r = run([...filing(["takes:implement"]), help]);
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(/^usage: node scripts\/file-issue\.js/);
			expect(r.stderr).toBe("");
		}
		const check = run(["--check", "A title", "--help"]);
		expect(check.status).toBe(0);
		expect(check.stdout).toMatch(/^usage: node scripts\/file-issue\.js/);
		expect(readGhCalls()).toEqual([]);
	});

	it("refuses an unknown flag with exit 2 and the usage line", () => {
		const r = run([...filing(["takes:implement"]), "--bogus"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --bogus");
		expect(r.stderr).toContain("usage: node scripts/file-issue.js");
		expect(readGhCalls()).toEqual([]);
	});
});

interface Row {
	number: number;
	state: string;
	title: string;
}

/**
 * Serve `rows` for the similar-title list's `issue list` fetches — the whole
 * tracker, and its open rows for `--state open` — with no closed-title cache,
 * so the next call pulls the whole tracker.
 */
const serveIssues = (rows: Row[]) => {
	fs.writeFileSync(at("issues"), JSON.stringify(rows));
	fs.writeFileSync(
		at("issues-open"),
		JSON.stringify(rows.filter((r) => r.state === "OPEN")),
	);
	fs.rmSync(path.join(sb.repo, MARKERS_REL, "closed-titles"), {
		recursive: true,
		force: true,
	});
};

/** The issue numbers a similar-title list printed, in its order. */
const listed = (stdout: string) =>
	[...stdout.matchAll(/^ {2}#(\d+) /gm)].map((m) => Number(m[1]));

/*
 * A small tracker, scored for "Generate a sitemap and robots file": #1 11.7,
 * #5 and #6 8.8, #2 8.6 — cut as the fourth — and #3 5.8, under 6. A hundred
 * filler titles make the four shared words rare.
 */
const TRACKER: Row[] = [
	{ number: 1, state: "OPEN", title: "Generate the sitemap and robots file" },
	{ number: 2, state: "OPEN", title: "Robots file for the sitemap" },
	{ number: 3, state: "OPEN", title: "Sitemap and robots crawl budget" },
	{ number: 4, state: "CLOSED", title: "Generate the sitemap and robots file" },
	{ number: 5, state: "OPEN", title: "Generate the sitemap file nightly" },
	{ number: 6, state: "OPEN", title: "Generate a robots file" },
	...Array.from({ length: 100 }, (_, i) => ({
		number: 7 + i,
		state: "OPEN",
		title: `Filler ticket ${7 + i}`,
	})),
];

describe("the similar-title list", () => {
	it("--check prints at most three open issues, best first, and files nothing", () => {
		serveIssues(TRACKER);
		const r = run(["--check", "Generate a sitemap and robots file"]);
		expect(r.status).toBe(0);
		expect(listed(r.stdout)).toEqual([1, 5, 6]);
		expect(readGhCalls()).toHaveLength(1);
		expect(readGhCalls()[0]).toContain("--repo acme/widgets --state all");
	});

	it("reads only the open issues on a call after the first, still listing one filed between them (#2755)", () => {
		serveIssues(TRACKER);
		run(["--check", "Generate a sitemap and robots file"]);
		fs.writeFileSync(
			at("issues-open"),
			JSON.stringify([
				{
					number: 200,
					state: "OPEN",
					title: "Generate a sitemap and robots file",
				},
				...TRACKER.filter((row) => row.state === "OPEN"),
			]),
		);
		const r = run(["--check", "Generate a sitemap and robots file"]);
		expect(listed(r.stdout)).toEqual([200, 1, 5]);
		expect(readGhCalls()).toHaveLength(2);
		expect(readGhCalls()[1]).toContain("--repo acme/widgets --state open");
	});

	it("never shows a closed issue, even one with the very same title", () => {
		serveIssues(TRACKER);
		const r = run(["--check", "Generate the sitemap and robots file"]);
		expect(listed(r.stdout)).not.toContain(4);
	});

	it("shows nothing scoring under 6, saying none resembles it", () => {
		serveIssues(TRACKER);
		const r = run(["--check", "Filler work"]);
		expect(r.status).toBe(0);
		expect(listed(r.stdout)).toEqual([]);
		expect(r.stdout).toContain("No open issue's title resembles this one.");
	});

	const sitemap = [
		"--title",
		"Generate the sitemap and robots file",
		"--label",
		"takes:implement",
		"--parent",
		"528",
		"--body-file",
		"-",
	];

	// #1073
	it("refuses while a listed match is left unnamed, printing the list again", () => {
		setUp();
		serveIssues(TRACKER);
		const r = run(sitemap);
		expect(r.status).toBe(2);
		expect(listed(r.stderr)).toEqual([1, 5, 6]);
		expect(r.stderr).toContain("--distinct-from 1,5,6.");
		expect(readCreates()).toEqual([]);
	});

	it("still refuses when one listed match is left off --distinct-from, naming the unchecked match and filing nothing", () => {
		setUp();
		serveIssues(TRACKER);
		const r = run([...sitemap, "--distinct-from", "1,#5"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("Nothing filed: #6 is not yet checked.");
		expect(readCreates()).toEqual([]);
	});

	it("files once every listed match is named, printing the list before the create", () => {
		setUp();
		serveIssues(TRACKER);
		const r = run([
			...sitemap,
			"--distinct-from",
			"1,5",
			"--distinct-from",
			"6",
		]);
		expect(r.status).toBe(0);
		expect(listed(r.stdout)).toEqual([1, 5, 6]);
		expect(r.stdout.indexOf("#1 ")).toBeLessThan(
			r.stdout.indexOf(`Filed #${NEW}`),
		);
		expect(readCreates()).toHaveLength(1);
	});

	it("counts a listed match taken as --parent as checked", () => {
		setUp();
		serveIssues([
			...TRACKER,
			{
				number: 528,
				state: "OPEN",
				title: "Generate the sitemap and robots file",
			},
		]);
		const shown = listed(run(["--check", sitemap[1]]).stdout);
		expect(shown).toContain(528);
		const others = shown.filter((n) => n !== 528).join(",");
		const r = run([...sitemap, "--distinct-from", others]);
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
	});

	it("refuses a --distinct-from that is not a list of issue numbers, and makes no gh call", () => {
		const r = run([...filing(["takes:implement"]), "--distinct-from", "1,two"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"is not a comma-separated list of issue numbers",
		);
		expect(readGhCalls()).toEqual([]);
	});

	it("files anyway, saying so, when the issues cannot be listed", () => {
		setUp();
		fs.writeFileSync(at("list-fails"), "");
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"Could not list similar open issues (HTTP 502: Bad Gateway) — filing without the check.",
		);
		expect(readCreates()).toHaveLength(1);
	});

	it("--check exits 1 when the issues cannot be listed, naming the repository", () => {
		fs.writeFileSync(at("list-fails"), "");
		const r = run(["--check", "Anything"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not list acme/widgets's issues");
	});

	it("--check refuses anything beside its one title with exit 2", () => {
		for (const extra of [
			["--label", "takes:implement"],
			["--check", "Another title"],
		]) {
			const r = run(["--check", "A title", ...extra]);
			expect(r.status).toBe(2);
		}
		expect(readGhCalls()).toEqual([]);
	});
});

/*
 * #500's measurement, re-run: the 520-title snapshot with each of its 30
 * sampled issues withdrawn in turn, as it was before it was filed, and its
 * title put to --check.
 */
describe("the #500 dataset", () => {
	const read = (f: string) =>
		JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", f), "utf8"));
	const titles: Row[] = read(
		"docs/data/issue-title-search-2026-09-27/titles.json",
	);
	const queries: {
		number: number;
		title: string;
		overlap: number | null;
		shown: number[];
	}[] = read("docs/data/issue-title-search-2026-09-27/queries.json");
	const check = (q: (typeof queries)[number]) => {
		serveIssues(titles.filter((t) => t.number !== q.number));
		const r = run(["--check", q.title]);
		expect(r.status).toBe(0);
		return listed(r.stdout);
	};

	it("holds the 520 titles and the 30 queries the research measured", () => {
		expect(titles).toHaveLength(520);
		expect(queries).toHaveLength(30);
	});

	it("finds all 7 known overlaps", () => {
		const overlaps = queries.filter((q) => q.overlap !== null);
		expect(overlaps).toHaveLength(7);
		for (const q of overlaps) expect(check(q)).toContain(q.overlap);
	});

	it("shows, for every query, exactly what the research's ranking showed", () => {
		for (const q of queries)
			expect([q.number, check(q)]).toEqual([q.number, q.shown]);
	});
});
