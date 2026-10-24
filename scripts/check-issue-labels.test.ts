// @vitest-environment node
/*
 * Pins check-issue-labels.js's routing faults on open issues: a child missing
 * its parent's family, a `takes:` absent, duplicated, contradicted or stale, a
 * takes:human body that does not say what finishes it, and a gate line the
 * founder must discharge or that carries no basis, and a ticket left
 * `**Blocked` in a comment the shortlist cannot read. It is `takes:`'s only
 * reader (mantahostels#227); each later rule's ticket is on its describe block.
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth, and no
 * dependence on this repo's live tracker, which is what it reports on.
 *
 * It runs daily in the repo-checks run and in `npm run status`, and is the
 * sole control for issues filed by a script, the web UI or `gh api`: loosen a
 * case and an unrouted issue reaches nobody.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import HUMAN_BODIES from "./fixtures/takes-human-bodies.json" with {
	type: "json",
};
import {
	HERE,
	type StubGh,
	type SubIssuesAnswer,
	stubGhScript,
	subIssuesArm,
	THERE,
	writeSubIssues,
} from "./lib/gh-stub";

const SCRIPT = path.resolve(__dirname, "check-issue-labels.js");

let dir: string;

interface Issue {
	number: number;
	title?: string;
	state?: string;
	labels?: string[];
	parent?: number | null;
	pull_request?: object;
	body?: string;
	updated_at?: string;
	repository_url?: string;
	/** Overrides the URL `parent` builds, for a parent in another repo. */
	parent_issue_url?: string;
	/** Opt out of the default `takes:implement` the stub adds below. */
	noTakes?: boolean;
	/** Comment bodies, oldest first. */
	comments?: string[];
	/** The latest-comment read failing: `"fail"` an HTTP error, `"empty"` an empty page. */
	latestRead?: "fail" | "empty";
	/** What `/dependencies/blocked_by` answers, or `"fail"` for an HTTP error. */
	blockers?: { number: number; state: string }[] | "fail";
}

/**
 * Stub `gh` returning these issues as one --slurp page.
 *
 * Every fixture issue gets a `takes:` unless it declares one or sets
 * `noTakes` — otherwise each fixture written for the label-family rules would
 * also trip the missing-`takes:` rule.
 */
const rowOf = ({
	labels,
	parent,
	noTakes,
	comments,
	blockers: _blockers,
	latestRead: _latestRead,
	...i
}: Issue) => {
	const own = labels ?? [];
	const withTakes =
		noTakes || own.some((n) => n.startsWith("takes:"))
			? own
			: [...own, "takes:implement"];
	return {
		title: `t${i.number}`,
		state: "open",
		html_url: `http://example/${i.number}`,
		/* As the REST rows always are; a case about staleness overrides it. */
		updated_at: new Date().toISOString(),
		labels: withTakes.map((name) => ({ name })),
		parent_issue_url: parent ? `http://api/issues/${parent}` : null,
		comments: comments?.length ?? 0,
		...i,
	};
};

/**
 * The files the comments and blocked_by arms serve: an issue's LATEST comment
 * alone, as a `per_page=1` read of its last page answers, and its edges.
 */
const writeThreads = (issues: Issue[]) => {
	for (const i of issues) {
		const last = i.comments?.at(-1);
		if (i.latestRead === "fail")
			fs.writeFileSync(path.join(dir, `latest-${i.number}.fail`), "");
		else if (i.latestRead === "empty")
			fs.writeFileSync(path.join(dir, `latest-${i.number}.json`), "[[]]");
		else if (last !== undefined)
			fs.writeFileSync(
				path.join(dir, `latest-${i.number}.json`),
				JSON.stringify([[{ body: last }]]),
			);
		if (i.blockers === "fail")
			fs.writeFileSync(path.join(dir, `blockers-${i.number}.fail`), "");
		else if (i.blockers)
			fs.writeFileSync(
				path.join(dir, `blockers-${i.number}.json`),
				JSON.stringify([i.blockers]),
			);
	}
};

const threadArms = () => `  */comments?*)
    n=\`echo "$2" | sed 's|.*/issues/||; s|/comments.*||'\`
    if [ -f ${dir}/latest-$n.fail ]; then
      echo "HTTP 502 (comments/$n)" >&2
      exit 1
    fi
    cat ${dir}/latest-$n.json
    ;;
  */dependencies/blocked_by)
    n=\`echo "$2" | sed 's|.*/issues/||; s|/dependencies.*||'\`
    if [ -f ${dir}/blockers-$n.fail ]; then
      echo "HTTP 502 (blocked_by/$n)" >&2
      exit 1
    fi
    if [ -f ${dir}/blockers-$n.json ]; then cat ${dir}/blockers-$n.json; else echo '[[]]'; fi
    ;;`;

/**
 * `/sub_issues` of N answers with the fixture's own rows parented on N, open
 * and closed, unless `children` overrides it — with other repos' rows, or with
 * `"fail"` or `"unreachable"` for a failed read.
 */
const stubGh = (
	issues: Issue[],
	{
		failing = false,
		children = {} as Record<number, Issue[] | "fail" | "unreachable">,
	} = {},
) => {
	const rows = issues.map(rowOf);
	const fixture = path.join(dir, "issues.json");
	fs.writeFileSync(fixture, JSON.stringify([rows]));
	const kidsOf: Record<number, SubIssuesAnswer> = {};
	/* Rows built from `parent` only: a cross-repo parent URL is another repo's. */
	for (const r of rows)
		if (r.parent_issue_url?.startsWith("http://api/issues/")) {
			const n = Number(r.parent_issue_url.split("/").pop());
			const list = kidsOf[n];
			if (Array.isArray(list)) list.push(r);
			else kidsOf[n] = [r];
		}
	for (const [n, kids] of Object.entries(children))
		kidsOf[Number(n)] = typeof kids === "string" ? kids : kids.map(rowOf);
	writeSubIssues(dir, kidsOf);
	writeThreads(issues);
	/* Every argv line, so a test can assert what was NOT asked for. */
	const callLog = path.join(dir, "calls.log");
	const script = `#!/bin/sh
echo "$@" >> ${callLog}
case "$2" in
${subIssuesArm(dir)}
${threadArms()}
  *) cat ${fixture} ;;
esac
`;
	return { ...stubGhScript(dir, script, { failing }), callLog };
};

const run = (
	args: string[] = [],
	stub?: StubGh,
	extra: Record<string, string> = {},
) => {
	const r = spawnSync("node", [SCRIPT, ...args], {
		encoding: "utf8",
		/* GITHUB_ACTIONS off, deliberately: check.js puts an ::error:: on STDOUT
		 * per finding when it is set, uncapped, so the --notify cap assertions
		 * below passed locally and failed in Actions. Annotation behaviour is
		 * check.test.ts's to cover. */
		env: {
			...process.env,
			...stub?.env,
			...extra,
			GITHUB_ACTIONS: "",
			CLAUDE_PROJECT_DIR: dir,
		},
	});
	return {
		status: r.status ?? -1,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
		/* Separately, because --notify's contract is about stdout specifically:
		 * that is the stream a SessionStart hook injects into the session. */
		stdout: r.stdout ?? "",
	};
};

const MAP: Issue = { number: 96, labels: ["wayfinder:map"] };
/* Every passing takes:human body ends with the line #983 requires. */
const CLOSE = "\n\n**Close when:** the hostel replies.";
const OUTSIDE_BODY = `**Outside Claude Code:** email the hostel.${CLOSE}`;
const { TITLE: DRAIN_QUEUE_TITLE } = require("./report-doc-map-budget");
const FAULT_TAGS = new Set(
	HUMAN_BODIES.map((b) => b.verdict).filter((v) => v !== "pass"),
);
const { TITLE: ROADMAP_CENSUS_TITLE } = require("./report-roadmap-ceilings");
const REPO_FILE_BODY =
	"**Outside Claude Code:** draw the flat/silhouette mark variant in Inkscape and save it into `docs/brand_assets/`.";
const ERRAND_BODY = `**Outside Claude Code:** pay for one month of Higgsfield Starter and one month of Midjourney Basic in the browser, and read three vendors' output-ownership clauses there.${CLOSE}`;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "labels-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("children of a wayfinder map", () => {
	it("flags an unlabelled child as UNLABELLED, naming the issue", () => {
		const r = run(
			[],
			stubGh([
				MAP,
				{ number: 135, title: "no labels", parent: 96, noTakes: true },
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("UNLABELLED");
		expect(r.out).toContain("#135");
		expect(r.out).toContain("no labels at all");
	});

	it("stays silent on a labelled child", () => {
		const r = run(
			[],
			stubGh([MAP, { number: 136, parent: 96, labels: ["wayfinder:task"] }]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
	});

	/*
	 * A child may carry category, takes: or kind labels and still be missing its
	 * type — the check is "no member of this family", not "no labels at all".
	 */
	it("flags a child labelled only outside the wayfinder family, naming the issue and the label it carries", () => {
		const r = run(
			[],
			stubGh([MAP, { number: 137, parent: 96, labels: ["Tech & Stack"] }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("#137");
		expect(r.out).toContain("carries: Tech & Stack");
	});

	/*
	 * A spec is a structural node, not a step on the route, so it takes no
	 * wayfinder type.
	 */
	it("exempts a spec sitting under a map", () => {
		const r = run(
			[],
			stubGh([
				{ number: 8, labels: ["wayfinder:map"] },
				{ number: 51, parent: 8, labels: ["kind:spec", "takes:to-tickets"] },
			]),
		);
		expect(r.status).toBe(0);
	});

	it("exempts a brief sitting under a map (#578)", () => {
		const r = run(
			[],
			stubGh([
				MAP,
				{ number: 145, parent: 96, labels: ["kind:brief", "takes:to-spec"] },
			]),
		);
		expect(r.status).toBe(0);
	});

	it("exempts a nested map", () => {
		const r = run(
			[],
			stubGh([MAP, { number: 144, parent: 96, labels: ["wayfinder:map"] }]),
		);
		expect(r.status).toBe(0);
	});

	it("ignores a closed child", () => {
		const r = run(
			[],
			stubGh([MAP, { number: 138, parent: 96, state: "closed" }]),
		);
		expect(r.status).toBe(0);
	});

	it("ignores an issue with no parent", () => {
		const r = run([], stubGh([MAP, { number: 139 }]));
		expect(r.status).toBe(0);
	});

	it("ignores a child whose parent is not a map", () => {
		const r = run(
			[],
			stubGh([
				{ number: 50, labels: ["kind:ticket"] },
				{ number: 140, parent: 50 },
			]),
		);
		expect(r.status).toBe(0);
	});
});

describe("children of a spec", () => {
	it("flags a child of a kind:spec with no kind:ticket, naming the issue", () => {
		const r = run(
			[],
			stubGh([
				{ number: 51, labels: ["kind:spec", "takes:to-tickets"] },
				{ number: 141, parent: 51, labels: ["Tech & Stack"] },
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("#141");
		expect(r.out).toContain("kind:ticket");
	});

	it("stays silent when the child carries kind:ticket", () => {
		const r = run(
			[],
			stubGh([
				{ number: 51, labels: ["kind:spec", "takes:to-tickets"] },
				{ number: 142, parent: 51, labels: ["kind:ticket"] },
			]),
		);
		expect(r.status).toBe(0);
	});
});

/*
 * `takes:` says which command opens the issue, and every open issue carries
 * exactly one (docs/agents/triage-labels.md §`takes:`; the reader is mantahostels#227).
 */
describe("the takes: label", () => {
	it("flags an open issue carrying no takes: at all", () => {
		const r = run([], stubGh([{ number: 200, noTakes: true }]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-TAKES");
		expect(r.out).toContain("#200");
	});

	it("flags an open issue carrying two", () => {
		const r = run(
			[],
			stubGh([{ number: 201, labels: ["takes:implement", "takes:wayfinder"] }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("MANY-TAKES");
		expect(r.out).toContain("takes:implement, takes:wayfinder");
	});

	it("stays silent on exactly one", () => {
		const r = run([], stubGh([{ number: 202, labels: ["takes:triage"] }]));
		expect(r.status).toBe(0);
	});

	it("checks a standalone issue, which the family rules skip", () => {
		const r = run([], stubGh([{ number: 203, noTakes: true }]));
		expect(r.out).toContain("#203");
		expect(r.out).not.toContain("UNLABELLED");
	});

	it("ignores a closed issue, whose disposition can no longer be typed", () => {
		const r = run(
			[],
			stubGh([{ number: 204, noTakes: true, state: "closed" }]),
		);
		expect(r.status).toBe(0);
	});

	it("ignores a pull request", () => {
		const r = run(
			[],
			stubGh([{ number: 205, noTakes: true, pull_request: {} }]),
		);
		expect(r.status).toBe(0);
	});
});

describe("a takes: contradicted by the issue's own kind", () => {
	it("flags takes:implement on a spec as CONTRADICTED, naming the issue", () => {
		const r = run(
			[],
			stubGh([{ number: 210, labels: ["kind:spec", "takes:implement"] }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("CONTRADICTED");
		expect(r.out).toContain("#210");
	});

	it("flags takes:to-spec on a spec, naming the issue", () => {
		const r = run(
			[],
			stubGh([{ number: 211, labels: ["kind:spec", "takes:to-spec"] }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("#211");
	});

	/*
	 * Deliberately not a fault: an oversized ticket really can need breaking up,
	 * and provenance disagreeing with disposition is what the override rule
	 * protects — "a `kind:ticket` can take `/wayfinder` when it turns out to hide
	 * a decision".
	 */
	it("leaves takes:to-tickets on a ticket alone", () => {
		const r = run(
			[],
			stubGh([{ number: 212, labels: ["kind:ticket", "takes:to-tickets"] }]),
		);
		expect(r.status).toBe(0);
	});

	it("flags takes:human on a manual-finding as CONTRADICTED, naming the issue (mantahostels#2810, mantahostels#3146)", () => {
		const r = run(
			[],
			stubGh([{ number: 218, labels: ["manual-finding", "takes:human"] }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("CONTRADICTED");
		expect(r.out).toContain("#218");
		expect(r.out).toContain("manual-finding");
	});

	it("leaves a manual-finding on takes:implement alone", () => {
		const r = run(
			[],
			stubGh([{ number: 219, labels: ["manual-finding", "takes:implement"] }]),
		);
		expect(r.status).toBe(0);
	});

	it("leaves takes:human alone where nothing contradicts it", () => {
		const r = run(
			[],
			stubGh([{ number: 220, labels: ["takes:human"], body: OUTSIDE_BODY }]),
		);
		expect(r.status).toBe(0);
	});

	it("flags takes:children on a map while a step of its route is open, naming the issue", () => {
		const r = run(
			[],
			stubGh([
				{ number: 213, labels: ["wayfinder:map", "takes:children"] },
				{ number: 214, parent: 213, labels: ["wayfinder:task"] },
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("#213");
		expect(r.out).toContain("wayfinder:map");
	});

	it("leaves takes:children on an exhausted map alone (#578)", () => {
		const r = run(
			[],
			stubGh([
				{ number: 217, labels: ["wayfinder:map", "takes:children"] },
				{ number: 218, parent: 217, labels: ["kind:brief", "takes:to-spec"] },
				{ number: 219, parent: 217, labels: ["kind:spec", "takes:children"] },
				{
					number: 220,
					parent: 219,
					labels: ["kind:ticket", "takes:implement"],
				},
			]),
		);
		expect(r.out).not.toContain("CONTRADICTED");
		expect(r.status).toBe(0);
	});

	it("still flags an exhausted-looking map whose open child is a nested map, as CONTRADICTED", () => {
		const r = run(
			[],
			stubGh([
				{ number: 221, labels: ["wayfinder:map", "takes:children"] },
				{
					number: 222,
					parent: 221,
					labels: ["wayfinder:map", "takes:wayfinder"],
				},
			]),
		);
		expect(r.out).toContain("CONTRADICTED");
		expect(r.status).toBe(1);
	});

	it("leaves a map on takes:wayfinder alone", () => {
		const r = run(
			[],
			stubGh([{ number: 215, labels: ["wayfinder:map", "takes:wayfinder"] }]),
		);
		expect(r.status).toBe(0);
	});

	/*
	 * The override rule: a `takes:` beats a `wayfinder:*` or `kind:` label that
	 * merely disagrees with it — mantahostels#172 is `wayfinder:task` and takes /implement.
	 */
	it("leaves a wayfinder:task taking /implement alone", () => {
		const r = run(
			[],
			stubGh([
				{ number: 216, labels: ["wayfinder:map"] },
				{
					number: 172,
					parent: 216,
					labels: ["wayfinder:task", "takes:implement"],
				},
			]),
		);
		expect(r.status).toBe(0);
	});
});

describe("a takes:human body saying what finishes it (#983)", () => {
	const act = "**Outside Claude Code:** email the hostel.";

	it("flags one whose Outside line passes but which has no Close-when line, as NO-CLOSE-WHEN, naming the issue and the founder-deliverable rule", () => {
		const r = run(
			[],
			stubGh([{ number: 225, labels: ["takes:human"], body: act }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-CLOSE-WHEN");
		expect(r.out).toContain("#225");
		expect(r.out).toContain("(scripts/lib/rule-text.sh founder-deliverable)");
	});

	// WFC_SCRIPT_ROOT stands in for an install: a root with no package.json.
	it("names the template at the plugin root in an install (#1248)", () => {
		const plugin = fs.mkdtempSync(path.join(os.tmpdir(), "labels-plugin-"));
		try {
			const r = run(
				[],
				stubGh([{ number: 225, labels: ["takes:human"], body: act }]),
				{ WFC_SCRIPT_ROOT: plugin },
			);
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				`(${plugin}/scripts/lib/rule-text.sh founder-deliverable)`,
			);
		} finally {
			fs.rmSync(plugin, { recursive: true, force: true });
		}
	});

	it("flags a bare marker with nothing after it, as NO-CLOSE-WHEN", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 226,
					labels: ["takes:human"],
					body: `${act}\n\n**Close when:**  \n`,
				},
			]),
		);
		expect(r.out).toContain("NO-CLOSE-WHEN");
	});

	it("reports an Outside-line fault alone, never both", () => {
		const r = run(
			[],
			stubGh([
				{ number: 227, labels: ["takes:human"], body: "Fill the gaps." },
			]),
		);
		expect(r.out).toContain("NO-OUTSIDE-ACT");
		expect(r.out).not.toContain("NO-CLOSE-WHEN");
	});

	it("reports but gates nothing under --warn", () => {
		const r = run(
			["--warn"],
			stubGh([{ number: 228, labels: ["takes:human"], body: act }]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("NO-CLOSE-WHEN");
	});

	it("leaves every other takes: value without the line alone", () => {
		const r = run(
			[],
			stubGh([{ number: 229, labels: ["takes:implement"], body: act }]),
		);
		expect(r.out).not.toContain("NO-CLOSE-WHEN");
	});
});

describe("a takes:human body naming its outside act", () => {
	it("flags one with no Outside Claude Code line as NO-OUTSIDE-ACT, naming the issue and offering the line to add (mantahostels#3181)", () => {
		const r = run(
			[],
			stubGh([
				{ number: 221, labels: ["takes:human"], body: "Fill the gaps." },
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-OUTSIDE-ACT");
		expect(r.out).toContain("#221");
		expect(r.out).toContain("add the line naming the act");
	});

	it("flags one with no body at all, as NO-OUTSIDE-ACT", () => {
		const r = run([], stubGh([{ number: 222, labels: ["takes:human"] }]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-OUTSIDE-ACT");
	});

	it("flags a bare marker that names no act, as the create guard does", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 225,
					labels: ["takes:human"],
					body: "**Outside Claude Code:**  \nlater",
				},
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("#225");
	});

	it("leaves the line off any other takes: value alone", () => {
		const r = run(
			[],
			stubGh([{ number: 223, labels: ["takes:implement"], body: "x" }]),
		);
		expect(r.status).toBe(0);
	});

	it("flags the doc-map drain queue too, as NO-OUTSIDE-ACT, naming the issue (mantahostels#3555)", () => {
		const r = run(
			[],
			stubGh([
				{ number: 224, title: DRAIN_QUEUE_TITLE, labels: ["takes:human"] },
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-OUTSIDE-ACT");
		expect(r.out).toContain("#224");
	});

	it("flags the roadmap ceiling census too, as NO-OUTSIDE-ACT, naming the issue (mantahostels#3555)", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 226,
					title: ROADMAP_CENSUS_TITLE,
					labels: ["takes:human"],
				},
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("NO-OUTSIDE-ACT");
		expect(r.out).toContain("#226");
	});
});

/* BARRED-NOT-IMPOSSIBLE (#140). Mirrors the guard's barred limb, for the
   routes no PreToolUse hook sees — a script, GraphQL, the web UI. */
describe("a takes:human whose Outside line names a prohibition", () => {
	it("flags #131's original line as BARRED-NOT-IMPOSSIBLE, not NO-OUTSIDE-ACT, naming the issue", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 131,
					labels: ["takes:human"],
					body: "**Outside Claude Code:** Edit ~/.claude/statusline.sh, which sits outside this repository and no agent may write to.",
				},
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("BARRED-NOT-IMPOSSIBLE");
		expect(r.out).toContain("#131");
		expect(r.out).not.toContain("NO-OUTSIDE-ACT");
	});

	it("names the way out in its fix line", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 131,
					labels: ["takes:human"],
					body: "**Outside Claude Code:** edit it, which no agent may write to.",
				},
			]),
		);
		expect(r.out).toContain("test -w");
		expect(r.out).toContain("takes:wayfinder");
		expect(r.out).toContain("takes:implement");
	});

	/* The prohibition must be about an AGENT. One about the world is usually
	   part of a real errand. */
	it.each([
		["a real act", "email the affiliate desk and ask for a partner key"],
		[
			"a location, not a bar",
			"sign up on the vendor site; the credentials live outside this repository",
		],
		[
			"a form's own rule",
			"submit the form; once submitted it may not be edited",
		],
		[
			"a counterparty's rule",
			"phone the bank and ask why the account is barred from transfers",
		],
	])("leaves %s alone", (_, act) => {
		const r = run(
			[],
			stubGh([
				{
					number: 242,
					labels: ["takes:human"],
					body: `**Outside Claude Code:** ${act}.`,
				},
			]),
		);
		expect(r.out).not.toContain("BARRED-NOT-IMPOSSIBLE");
	});
});

/* REPO-FILE-ACT (mantahostels#3555). */
describe("a takes:human whose outside act produces a repo file", () => {
	it("flags a tool and a repo path as REPO-FILE-ACT, not NO-OUTSIDE-ACT, naming the issue", () => {
		const r = run(
			[],
			stubGh([{ number: 240, labels: ["takes:human"], body: REPO_FILE_BODY }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("REPO-FILE-ACT");
		expect(r.out).toContain("#240");
		expect(r.out).not.toContain("NO-OUTSIDE-ACT");
	});

	it.each([
		["a backticked repo path alone", "edit `scripts/x.sh` by hand"],
		["a source filename alone", "redraw mark-final.svg at 2.85x"],
		["a file-producing tool alone", "lay the table out in a spreadsheet"],
		["a tool in lower case", "open it in figma"],
	])("flags %s as REPO-FILE-ACT", (_, act) => {
		const r = run(
			[],
			stubGh([
				{
					number: 241,
					labels: ["takes:human"],
					body: `**Outside Claude Code:** ${act}.`,
				},
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("REPO-FILE-ACT");
	});

	it.each([
		"in the Claude account settings for the `.claude` seat, pay to renew its 20x Max plan before it ends on 17 Sep 2026.",
		"submit the trade-licence renewal in the council portal as a sole trader, following the walkthrough above, with the founder's own ID details.",
		"email Bunkward from the founder's own mailbox, by the route recommended above, and log any reply here.",
		"send the supplier the written request for consent from the founder's own mailbox, once #85 has found a channel, and log the reply here.",
	])("leaves a real errand alone: %s", (act) => {
		const r = run(
			[],
			stubGh([
				{
					number: 245,
					labels: ["takes:human"],
					body: `**Outside Claude Code:** ${act}${CLOSE}`,
				},
			]),
		);
		expect(r.status).toBe(0);
	});

	it("leaves paying in a browser alone — an errand", () => {
		const r = run(
			[],
			stubGh([{ number: 242, labels: ["takes:human"], body: ERRAND_BODY }]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("REPO-FILE-ACT");
	});

	it("reads the Outside line only, never the rest of the body", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 243,
					labels: ["takes:human"],
					body: `${ERRAND_BODY}\n\nContext: the result lands in \`docs/research/x.md\` later.`,
				},
			]),
		);
		expect(r.status).toBe(0);
	});

	it("leaves the line off any other takes: value alone", () => {
		const r = run(
			[],
			stubGh([
				{ number: 244, labels: ["takes:implement"], body: REPO_FILE_BODY },
			]),
		);
		expect(r.status).toBe(0);
	});
});

/* NOT-A-FOUNDER-ACT (#1095), and every other Outside-line verdict, from the
   table file-issue.test.ts reads too. */
describe("a takes:human body against the shared table", () => {
	it.each(HUMAN_BODIES)("$reason", ({ body, verdict }) => {
		const r = run([], stubGh([{ number: 246, labels: ["takes:human"], body }]));
		if (verdict === "pass") {
			expect(r.status).toBe(0);
			return;
		}
		expect(r.status).toBe(1);
		expect(r.out).toContain(verdict);
		expect(r.out).toContain("#246");
		for (const other of [...FAULT_TAGS].filter((t) => t !== verdict))
			expect(r.out).not.toContain(other);
	});

	it("names both ways out of NOT-A-FOUNDER-ACT, and the relabel where neither holds, in its fix line", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 247,
					labels: ["takes:human"],
					body: `**Outside Claude Code:** look up the dorm prices on the Bunkward site.${CLOSE}`,
				},
			]),
		);
		expect(r.out).toContain("name the act from the list");
		expect(r.out).toContain("add a `Tried:` list of at least 3 methods run");
		expect(r.out).toContain("relabel takes:implement");
	});
});

/* HUMAN-UNREVIEWED (mantahostels#3358). */
describe("a takes:human nobody has looked at", () => {
	const daysAgo = (n: number) =>
		new Date(Date.now() - n * 86_400_000).toISOString();

	it("warns, without gating, on one untouched for exactly 14 days as HUMAN-UNREVIEWED, offering a walk with the founder in chat as the way out", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 227,
					labels: ["takes:human"],
					body: OUTSIDE_BODY,
					updated_at: daysAgo(14),
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("HUMAN-UNREVIEWED");
		expect(r.out).toContain("untouched for 14 days");
		expect(r.out).toContain("a 403 names one permission");
		expect(r.out).toContain("walk it with the founder in chat");
	});

	it("stays silent on one touched 13 days ago", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 228,
					labels: ["takes:human"],
					body: OUTSIDE_BODY,
					updated_at: daysAgo(13),
				},
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("HUMAN-UNREVIEWED");
	});

	it("leaves an old takes:implement alone", () => {
		const r = run(
			[],
			stubGh([
				{ number: 229, labels: ["takes:implement"], updated_at: daysAgo(40) },
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("HUMAN-UNREVIEWED");
	});

	it("warns HUMAN-UNREVIEWED on the two script-set shapes too, naming both issues (mantahostels#3555)", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 230,
					title: DRAIN_QUEUE_TITLE,
					labels: ["takes:human"],
					body: OUTSIDE_BODY,
					updated_at: daysAgo(40),
				},
				{
					number: 231,
					title: ROADMAP_CENSUS_TITLE,
					labels: ["takes:human"],
					body: OUTSIDE_BODY,
					updated_at: daysAgo(40),
				},
			]),
		);
		expect(r.out).toContain("HUMAN-UNREVIEWED");
		expect(r.out).toContain("#230");
		expect(r.out).toContain("#231");
	});
});

/*
 * `takes:children` means every remaining action sits on the open sub-issues, so
 * it rots the moment the last one closes and nothing retires it
 * (docs/agents/triage-labels.md §`takes:`).
 */
describe("a stale takes:children", () => {
	it("flags a container whose last open child has closed, as STALE-CONTAINER, naming the issue", () => {
		const r = run(
			[],
			stubGh([
				{ number: 220, labels: ["takes:children"] },
				{ number: 221, parent: 220, state: "closed" },
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("STALE-CONTAINER");
		expect(r.out).toContain("#220");
	});

	it("flags one that never had a child at all, naming the issue", () => {
		const r = run([], stubGh([{ number: 222, labels: ["takes:children"] }]));
		expect(r.status).toBe(1);
		expect(r.out).toContain("#222");
	});

	it("leaves a container with an open child alone, raising no UNMARKED-CONTAINER either", () => {
		const r = run(
			[],
			stubGh([
				{ number: 223, labels: ["takes:children"] },
				{ number: 224, parent: 223 },
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("UNMARKED-CONTAINER");
	});

	/*
	 * The inverse, reported at lower confidence: an issue may hold real work of
	 * its own alongside open children.
	 */
	it("warns without gating on open children and no takes:children, as UNMARKED-CONTAINER, naming the issue", () => {
		const r = run(
			[],
			stubGh([
				{ number: 230, labels: ["takes:implement"] },
				{ number: 231, parent: 230 },
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("UNMARKED-CONTAINER");
		expect(r.out).toContain("#230");
	});

	it("stays silent on a map, which is never a container", () => {
		const r = run(
			[],
			stubGh([
				{ number: 232, labels: ["wayfinder:map", "takes:wayfinder"] },
				{ number: 233, parent: 232, labels: ["wayfinder:task"] },
			]),
		);
		expect(r.out).not.toContain("UNMARKED-CONTAINER");
	});

	/* retire-stale-containers.js retags this one (mantahostels#1663), and this check goes on
	 * reporting it meanwhile — the same division as STALE-CONTAINER above. */
	it("still reports a ticketed takes:to-tickets spec", () => {
		const r = run(
			[],
			stubGh([
				{ number: 234, labels: ["takes:to-tickets"] },
				{ number: 235, parent: 234, labels: ["takes:implement"] },
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("UNMARKED-CONTAINER");
		expect(r.out).toContain("#234");
	});

	/* The open-issue list holds this repo's issues alone (#778). */
	it("leaves a container whose only open child is in another repo", () => {
		const r = run(
			[],
			stubGh([{ number: 17, labels: ["takes:children"] }], {
				children: {
					17: [{ number: 3645, state: "open", repository_url: THERE }],
				},
			}),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("STALE-CONTAINER");
	});

	it("flags it as STALE-CONTAINER once that child has closed, naming the issue", () => {
		const r = run(
			[],
			stubGh([{ number: 17, labels: ["takes:children"] }], {
				children: {
					17: [{ number: 3645, state: "closed", repository_url: THERE }],
				},
			}),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("STALE-CONTAINER");
		expect(r.out).toContain("#17");
	});

	it("never counts a local child of another repo's #17 as a child of local #17", () => {
		const stub = stubGh([
			{ number: 17, labels: ["takes:children"], repository_url: HERE },
			{
				number: 30,
				repository_url: HERE,
				parent_issue_url: `${THERE}/issues/17`,
			},
		]);
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("STALE-CONTAINER");
		expect(r.out).toContain("#17");
		/* Nor is local #17 looked up as #30's parent. */
		expect(r.out).toContain("0 of them with a parent");
	});

	it("reports no STALE-CONTAINER on sub-issues it could not read", () => {
		const r = run(
			[],
			stubGh([{ number: 17, labels: ["takes:children"] }], {
				children: { 17: "fail" },
			}),
		);
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("STALE-CONTAINER");
		expect(r.out).toContain("CHILDREN-UNREADABLE");
		expect(r.out).toContain("HTTP 502");
	});

	it("SKIPs, reporting no STALE-CONTAINER, when GitHub goes unreachable on its read", () => {
		const r = run(
			[],
			stubGh([{ number: 17, labels: ["takes:children"] }], {
				children: { 17: "unreachable" },
			}),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("STALE-CONTAINER");
	});

	it("does not count a closed child as keeping it live", () => {
		const r = run(
			[],
			stubGh([
				{ number: 225, labels: ["takes:children"] },
				{ number: 226, parent: 225 },
				{ number: 227, parent: 225, state: "closed" },
			]),
		);
		expect(r.status).toBe(0);
	});
});

describe("a brief still holding its spec (#609)", () => {
	const brief = { number: 240, labels: ["kind:brief", "takes:children"] };

	it("reports an open brief with an open spec child, naming the fix", () => {
		const r = run(
			[],
			stubGh([
				brief,
				{ number: 241, parent: 240, labels: ["kind:spec", "takes:to-tickets"] },
			]),
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("SPECCED-BRIEF");
		expect(r.out).toContain("#240");
		expect(r.out).toContain("node scripts/promote-spec.js 240");
	});

	it("names the hand fix where the brief holds two specs", () => {
		const r = run(
			[],
			stubGh([
				brief,
				{ number: 246, parent: 240, labels: ["kind:spec", "takes:to-tickets"] },
				{ number: 247, parent: 240, labels: ["kind:spec", "takes:to-tickets"] },
			]),
		);
		expect(r.out).toContain("2 open kind:spec children");
	});

	it("stays silent on a spec under anything but a brief", () => {
		const r = run(
			[],
			stubGh([
				{ number: 248, labels: ["wayfinder:map", "takes:children"] },
				{ number: 249, parent: 248, labels: ["kind:spec", "takes:to-tickets"] },
			]),
		);
		expect(r.out).not.toContain("SPECCED-BRIEF");
	});

	it("stays silent on a brief whose only child is no spec", () => {
		const r = run(
			[],
			stubGh([brief, { number: 242, parent: 240, labels: ["kind:ticket"] }]),
		);
		expect(r.out).not.toContain("SPECCED-BRIEF");
	});

	it("stays silent on a brief whose spec child has closed", () => {
		const r = run(
			[],
			stubGh([
				{ number: 243, labels: ["kind:brief", "takes:triage"] },
				{ number: 244, parent: 243, labels: ["kind:spec"], state: "closed" },
			]),
		);
		expect(r.out).not.toContain("SPECCED-BRIEF");
	});

	it("stays silent on a closed brief", () => {
		const r = run(
			[],
			stubGh([
				{ ...brief, state: "closed" },
				{ number: 245, parent: 240, labels: ["kind:spec", "takes:to-tickets"] },
			]),
		);
		expect(r.out).not.toContain("SPECCED-BRIEF");
	});
});

describe("reporting discipline", () => {
	it("never exits non-zero under --warn", () => {
		const r = run(["--warn"], stubGh([MAP, { number: 135, parent: 96 }]));
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
	});

	/*
	 * --notify is built for a SessionStart hook, whose stdout every session
	 * would pay for, so a clean run must cost nothing: the scan summary
	 * goes to stderr on every other path and is withheld here.
	 */
	it("says nothing on stdout under --notify when every issue is labelled", () => {
		const r = run(["--notify"], stubGh([{ number: 230 }]));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("still names the faulting issue on stdout under --notify", () => {
		const r = run(["--notify"], stubGh([{ number: 230, noTakes: true }]));
		expect(r.stdout).toContain("230");
	});

	/*
	 * --notify output is a function of the backlog, not a fixed string, so it
	 * names the first few offenders and counts the rest (mantahostels#1148).
	 */
	const backlog = Array.from({ length: 40 }, (_, n) => ({
		number: 500 + n,
		noTakes: true,
	}));
	const named = (text: string) =>
		backlog.filter((i) => text.includes(`#${i.number}`)).length;

	it("caps the named offenders under --notify and counts the remainder", () => {
		const r = run(["--notify"], stubGh(backlog));
		expect(named(r.stdout)).toBe(3);
		expect(r.stdout).toContain("and 37 more");
	});

	it("names every offender when not under --notify", () => {
		const r = run([], stubGh(backlog));
		expect(named(r.out)).toBe(40);
		expect(r.out).not.toContain("and 37 more");
	});

	/* The cap is per list, so the ceiling is 2 x NOTIFY_CAP plus fixed footers
	 * (mantahostels#1148). */
	it("holds stdout under 2 KB with faults of both kinds in the backlog", () => {
		const r = run(
			["--notify"],
			stubGh([MAP, ...backlog.map((i) => ({ ...i, parent: 96 }))]),
		);
		expect(r.stdout.length).toBeLessThan(2048);
	});

	/* A WARN early in the scan must not take a slot from a FAIL (mantahostels#1148). */
	it("names the gating faults before the warning ones under --notify", () => {
		const r = run(
			["--notify"],
			stubGh([
				/* Three UNMARKED-CONTAINER WARNs, scanned before the FAIL below. */
				{ number: 400 },
				{ number: 401, parent: 400 },
				{ number: 402 },
				{ number: 403, parent: 402 },
				{ number: 404 },
				{ number: 405, parent: 404 },
				{ number: 600, noTakes: true },
			]),
		);
		expect(r.stdout).toContain("#600");
	});

	it("exits 0 under --notify even on a finding, so a session start is never blocked", () => {
		const r = run(["--notify"], stubGh([{ number: 230, noTakes: true }]));
		expect(r.status).toBe(0);
	});

	it("skips rather than reports clear when gh is unavailable", () => {
		const r = run([], stubGh([], { failing: true }));
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("OK:");
	});

	it("emits machine-readable findings under --json", () => {
		const r = run(["--json"], stubGh([MAP, { number: 135, parent: 96 }]));
		expect(r.status).toBe(1);
		const parsed = JSON.parse(r.out);
		expect(parsed.unlabelledCount).toBe(1);
		expect(parsed.unlabelled[0].number).toBe(135);
	});

	it("carries the takes: faults into --json too", () => {
		const r = run(["--json"], stubGh([{ number: 230, noTakes: true }]));
		const parsed = JSON.parse(r.out);
		expect(parsed.takesFaultCount).toBe(1);
		expect(parsed.takesFaults[0]).toMatchObject({
			number: 230,
			tag: "NO-TAKES",
		});
	});

	it("issues no gh call that could write", () => {
		const stub = stubGh([{ number: 231, noTakes: true }]);
		run([], stub);
		const calls = fs.readFileSync(stub.callLog, "utf8");
		expect(calls).not.toMatch(/--method|-X (POST|PATCH|PUT|DELETE)|issue edit/);
	});

	it("ignores pull requests", () => {
		const r = run(
			[],
			stubGh([MAP, { number: 143, parent: 96, pull_request: {} }]),
		);
		expect(r.status).toBe(0);
	});
});

/* The fetch shape, not the rules (mantahostels#1899). */
describe("what it asks GitHub for", () => {
	/**
	 * A `gh` that answers per query rather than serving one fixture to all of
	 * them — and REFUSES `state=all`, so a whole-tracker read fails the run
	 * rather than passing on rows it should not have had.
	 */
	const stubByState = (issues: Issue[]) => {
		const rows = issues.map(rowOf);
		const open = path.join(dir, "open.json");
		fs.writeFileSync(
			open,
			JSON.stringify([rows.filter((r) => r.state === "open")]),
		);
		const closedWith = (label: string) => {
			const f = path.join(dir, `closed-${label.replace(/\W/g, "_")}.json`);
			fs.writeFileSync(
				f,
				JSON.stringify([
					rows.filter(
						(r) =>
							r.state === "closed" && r.labels.some((l) => l.name === label),
					),
				]),
			);
			return f;
		};
		const map = closedWith("wayfinder:map");
		const spec = closedWith("kind:spec");
		const callLog = path.join(dir, "calls.log");
		const script = [
			"#!/bin/sh",
			`echo "$@" >> ${callLog}`,
			'case "$*" in',
			'  *state=all*) echo "stub: refused a whole-tracker read" >&2; exit 1 ;;',
			`  *labels=wayfinder:map*) cat ${map} ;;`,
			`  *labels=kind:spec*) cat ${spec} ;;`,
			`  *state=open*) cat ${open} ;;`,
			'  *) echo "[[]]" ;;',
			"esac",
			"",
		].join("\n");
		return { ...stubGhScript(dir, script), callLog };
	};

	it("never reads the whole tracker", () => {
		const stub = stubByState([
			MAP,
			{ number: 150, parent: 96, labels: ["wayfinder:task"] },
		]);
		const r = run([], stub);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(stub.callLog, "utf8")).not.toContain("state=all");
	});

	it("still catches a child whose parent map has closed", () => {
		const stub = stubByState([
			{ ...MAP, state: "closed" },
			{ number: 151, title: "orphaned by a closed map", parent: 96 },
		]);
		const r = run([], stub);
		expect(r.status).toBe(1);
		expect(r.out).toContain("UNLABELLED");
		expect(r.out).toContain("#151");
	});

	it("asks for no closed rows at all when every parent is already open", () => {
		const stub = stubByState([
			MAP,
			{ number: 152, parent: 96, labels: ["wayfinder:task"] },
		]);
		const r = run([], stub);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(stub.callLog, "utf8")).not.toContain("state=closed");
	});
});

describe("a gate whose condition is the founder typing a command (#411)", () => {
	const gated = (condition: string) =>
		`**Gated on:** ${condition} — abandon if: the map is abandoned`;

	it("flags #388's original line and names the relabel", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 388,
					labels: ["wayfinder:map", "takes:wayfinder"],
					body: gated(
						"the founder types `/to-spec 388` (the skill refuses a model call)",
					),
				},
			]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("COMMAND-GATE");
		expect(r.out).toContain("#388");
		expect(r.out).toContain("relabel takes:to-spec");
	});

	it("flags a command no takes: value names, without inventing a label", () => {
		fs.mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".claude", "commands", "card-close.md"),
			"",
		);
		const r = run(
			[],
			stubGh([{ number: 389, body: gated("the founder runs /card-close") }]),
		);
		expect(r.status).toBe(1);
		expect(r.out).toContain("COMMAND-GATE");
		expect(r.out).toContain("give it the takes: value of the command");
		expect(r.out).not.toContain("takes:card-close");
	});

	it("leaves a malformed gate alone, which holds nothing", () => {
		const r = run(
			[],
			stubGh([
				{ number: 390, body: "**Gated on:** the founder types /implement" },
			]),
		);
		expect(r.status).toBe(0);
	});

	it("leaves a path or a product route alone", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 394,
					body: gated("the founder runs the export to /tmp/dump"),
				},
				{ number: 395, body: gated("the founder launches /book on staging") },
			]),
		);
		expect(r.status).toBe(0);
	});

	it("reads the command case-blind", () => {
		const r = run(
			[],
			stubGh([{ number: 396, body: gated("the founder types /To-Spec 396") }]),
		);
		expect(r.out).toContain("relabel takes:to-spec");
	});

	it("leaves a data condition alone", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 391,
					body: gated("the founder has signed the Supabase DPA"),
				},
			]),
		);
		expect(r.status).toBe(0);
	});

	it("leaves a path in the condition alone", () => {
		const r = run(
			[],
			stubGh([
				{
					number: 392,
					body: gated("the founder runs the audit and docs/x.md lands"),
				},
			]),
		);
		expect(r.status).toBe(0);
	});

	it("ignores a command named outside any gate line", () => {
		const r = run(
			[],
			stubGh([{ number: 393, body: "The founder types /to-spec 393 later." }]),
		);
		expect(r.status).toBe(0);
	});
});

describe("a gate line with no basis (#577)", () => {
	const until = "**Gated until:** 2099-01-01 — waiting on the data";
	const on = "**Gated on:** 4 weeks of data — abandon if: the map is abandoned";
	const basis =
		"**Gate basis:** the export lands weekly, so four runs is the first sample";
	const faulted = (body: string) => {
		const r = run([], stubGh([{ number: 450, body }]));
		return { r, fault: r.out.includes("NO-GATE-BASIS") };
	};

	it("warns on a Gated until line with none, naming the line to add", () => {
		const { r, fault } = faulted(until);
		expect(fault).toBe(true);
		expect(r.status).toBe(0);
		expect(r.out).toContain("#450");
		expect(r.out).toContain("**Gate basis:**");
		expect(r.out).toContain("beneath the Gated until line");
	});

	it("warns on a Gated on line with none", () => {
		const { r, fault } = faulted(on);
		expect(fault).toBe(true);
		expect(r.status).toBe(0);
		expect(r.out).toContain("beneath the Gated on line");
	});

	it("passes either gate carrying a basis", () => {
		expect(faulted(`${until}\n${basis}`).fault).toBe(false);
		expect(faulted(`${on}\n${basis}`).fault).toBe(false);
	});

	it("warns on an empty basis", () => {
		const { r, fault } = faulted(`${until}\n**Gate basis:**   `);
		expect(fault).toBe(true);
		expect(r.status).toBe(0);
	});

	it("warns where the only basis is quoted in a fenced block", () => {
		const { r, fault } = faulted(`${on}\n\n\`\`\`\n${basis}\n\`\`\``);
		expect(fault).toBe(true);
		expect(r.status).toBe(0);
	});

	it("raises no basis fault on a date gate quoted in a fenced block (#612)", () => {
		expect(faulted(`\`\`\`\n${until}\n\`\`\``).fault).toBe(false);
	});

	it("raises no basis fault on a malformed gate line", () => {
		expect(faulted("**Gated until:** someday").fault).toBe(false);
		expect(faulted("**Gated on:** 4 weeks of data").fault).toBe(false);
	});

	it("raises no basis fault on a body carrying both gate markers", () => {
		expect(faulted(`${until}\n${on}`).fault).toBe(false);
	});

	it("says nothing where there is no gate", () => {
		expect(faulted("Plain body.").fault).toBe(false);
	});
});

describe("a ticket left Blocked in a comment alone (#2309)", () => {
	const Blocked =
		"**Blocked** — the adopters have not bumped their pin, so nothing to test yet.";
	const Gate =
		"**Gated on:** every adopter pins v1.3.16 — check: node scripts/adopter-pins.js — abandon if: the offers are withdrawn\n**Gate basis:** each pin bump is its own ticket, so the last to land sets it";
	const flagged = (issue: Omit<Issue, "number">) => {
		const r = run([], stubGh([{ ...issue, number: 520 }]));
		return { r, fault: r.out.includes("PROSE-BLOCKED") };
	};

	it("warns where the latest comment opens **Blocked and nothing gates it, naming both remedies", () => {
		const { r, fault } = flagged({ comments: ["Started.", Blocked] });
		expect(fault).toBe(true);
		expect(r.status).toBe(0);
		expect(r.out).toContain("#520");
		expect(r.out).toContain("native blocked-by edge");
		expect(r.out).toContain("**Gated on:**");
		expect(r.out).toContain("waiting:external is not a gate");
	});

	it("warns where every native blocker has closed", () => {
		expect(
			flagged({
				comments: [Blocked],
				blockers: [{ number: 7, state: "closed" }],
			}).fault,
		).toBe(true);
	});

	it("stays silent where an open native blocker holds it", () => {
		expect(
			flagged({
				comments: [Blocked],
				blockers: [
					{ number: 7, state: "closed" },
					{ number: 8, state: "open" },
				],
			}).fault,
		).toBe(false);
	});

	it("stays silent where a gate line holds it", () => {
		expect(flagged({ comments: [Blocked], body: Gate }).fault).toBe(false);
	});

	it("stays silent where the Blocked comment is not the latest", () => {
		expect(
			flagged({ comments: [Blocked, "Unblocked: #7 landed."] }).fault,
		).toBe(false);
	});

	it("stays silent on a comment that names Blocked after its opening", () => {
		expect(flagged({ comments: ["Not **Blocked** any more."] }).fault).toBe(
			false,
		);
	});

	it("reads no comment of an issue that has none", () => {
		const stub = stubGh([{ number: 521 }]);
		run([], stub);
		expect(fs.readFileSync(stub.callLog, "utf8")).not.toContain("/comments");
	});

	it.each([
		["the blockers will not read", { comments: [Blocked], blockers: "fail" }],
		[
			"the latest comment will not read",
			{ comments: [Blocked], latestRead: "fail" },
		],
		[
			"the latest comment's page comes back empty",
			{ comments: [Blocked], latestRead: "empty" },
		],
	] as [string, Omit<Issue, "number">][])(
		"warns BLOCKED-UNREADABLE, not PROSE-BLOCKED, where %s",
		(_, issue) => {
			const { r, fault } = flagged(issue);
			expect(fault).toBe(false);
			expect(r.out).toContain("BLOCKED-UNREADABLE");
			expect(r.out).toContain("#520");
		},
	);
});
