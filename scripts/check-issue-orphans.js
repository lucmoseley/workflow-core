#!/usr/bin/env node
/*
 * check-issue-orphans.js — reports an issue whose body says which issue it came
 * out of, but which was never linked as that issue's native sub-issue.
 *
 * The prose gets written; the link does not. A 2 August 2026 sweep found eight
 * (mantahostels#48, mantahostels#81, mantahostels#83, mantahostels#87, mantahostels#88, mantahostels#90, mantahostels#91, mantahostels#93), every one naming its originator in
 * its own opening line — "Split out of mantahostels#63", "Parent map: mantahostels#40". An issue with no
 * parent is outside every map, so /wayfinder's frontier query never offers it and
 * the work is never scheduled.
 *
 * Prevention is scripts/place-new-issue.sh, which asks for the placement decision
 * the moment `gh issue create` returns. This is the backstop for when that prompt
 * is ignored, or the issue is filed from the GitHub UI where no hook runs.
 *
 * THIS SCRIPT NEVER WRITES. The phrase yields a candidate parent, not a verified
 * one: mantahostels#83 named its parent map in a footer and was right, while mantahostels#80 cites four
 * issues and belongs under none of them. Which is which is a judgement about
 * provenance, and a script that linked on a regex match would assert one nobody
 * made.
 *
 * An issue whose body carries a `Standalone:` line — file-issue.js --standalone
 * writes one — had its placement decided, so it is not a finding (#1615).
 *
 * Body only, not comments — all eight named their origin in the body, the issues
 * list returns bodies in one call, and a comment saying "part of mantahostels#22" is usually
 * discussing mantahostels#22, not claiming descent from it.
 *
 * Parentage comes from `parent_issue_url` on the issues list: one paginated call,
 * and it agreed exactly with a full inversion (78 of 85) when checked. Do not
 * rebuild it by walking each issue's /sub_issues — that is one call per issue and
 * defaults to per_page=30, which is what hid the mantahostels#8 → mantahostels#51 edge during the sweep.
 *
 * Usage: node check-issue-orphans.js [--warn] [--json]
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js: an unreachable
 * GitHub is SKIP (exit 0), any other gh failure is BROKEN (exit 2, mantahostels#164 —
 * the ticket that drew that line), and an
 * unplaced issue is a FAIL finding (exit 1, or 0 under --warn).
 */

const { runCheck } = require("./lib/check");
const { ghAllIssues, raiseGhFailure } = require("./lib/gh");
const { hasStandaloneLine } = require("./lib/standalone-line");

/*
 * Phrases that assert descent, not mere reference. Tuned against the whole
 * backlog: it catches all eight known cases and stays silent on the four issues
 * correctly left standalone — mantahostels#2 and mantahostels#94 (roadmap cards, top-level by design),
 * mantahostels#80 and mantahostels#82 (cross-cutting process work naming no single originator). Widening
 * this to a bare "#n" would flag most of the backlog and be ignored within a week.
 */
const PROVENANCE =
	/\b(?:split out of|spun out of|carved out of|extracted from|descoped from|surfaced (?:during|in|while implementing)|found while implementing|raised (?:by|in)|follow-?up (?:to|from)|part of|parent map:)\s+#(\d+)/gi;

runCheck({
	name: "issue-orphans",
	usage: "node check-issue-orphans.js [--warn] [--json]",
	run(ctx) {
		let issues;
		try {
			issues = ghAllIssues();
		} catch (e) {
			raiseGhFailure(e);
		}

		/** @param {unknown} u */
		const parentOf = (u) => (u ? Number(String(u).split("/").pop()) : null);

		const unplaced = [];
		let scanned = 0;
		for (const iss of issues) {
			if (iss.pull_request) continue; // one number space, two kinds of thing
			scanned++;
			if (parentOf(iss.parent_issue_url)) continue;
			if (hasStandaloneLine(iss.body)) continue;
			const claims = [
				...new Set(
					[...(iss.body || "").matchAll(PROVENANCE)].map((m) => Number(m[1])),
				),
			].filter((n) => n !== iss.number);
			if (claims.length > 0)
				unplaced.push({
					number: iss.number,
					title: iss.title,
					url: iss.html_url,
					claims,
				});
		}

		ctx.say(`Checked ${scanned} issue(s) for unplaced provenance.\n`);

		for (const i of unplaced)
			ctx.fail(
				"UNPLACED",
				`#${i.number} ${i.title} — names ${i.claims.map((n) => `#${n}`).join(", ")}, has no parent`,
				i,
				// The title and the origins it names both move; the unplaced issue does
				// not (mantahostels#2490).
				`UNPLACED\t#${i.number}`,
			);

		if (unplaced.length > 0) {
			ctx.say(
				`UNPLACED (${unplaced.length}) — names an origin, has no parent:`,
			);
			for (const i of unplaced)
				ctx.say(
					`  #${i.number} ${i.title}\n    claims ${i.claims.map((n) => `#${n}`).join(", ")}\n    ${i.url}`,
				);
			ctx.say(
				"\n  Decide whether the named issue is really the parent, then link it:\n" +
					"    gh api --method POST repos/{owner}/{repo}/issues/<parent>/sub_issues \\\n" +
					"      -F sub_issue_id=$(gh api repos/{owner}/{repo}/issues/<child> --jq .id)\n" +
					"  sub_issue_id is the numeric database id, not the #number. Where the phrase\n" +
					"  points at a symptom rather than an owner, add a `Standalone: <why>` line to\n" +
					"  its body instead — that clears the finding.\n",
			);
		}

		return {
			okLine:
				"every issue naming an origin is linked to a parent or records why it stands alone.",
			noun: "issue(s) naming an origin they are not linked to",
			data: { unplaced, unplacedCount: unplaced.length, scanned },
		};
	},
});
