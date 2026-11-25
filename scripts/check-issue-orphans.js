#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const { ghAllIssues, raiseGhFailure } = require("./lib/gh");
const { hasStandaloneLine } = require("./lib/standalone-line");
const { scriptPath } = require("./lib/script-path.js");

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
			return raiseGhFailure(e);
		}

		/** @param {unknown} u */
		const parentOf = (u) => (u ? Number(String(u).split("/").pop()) : null);

		const unplaced = [];
		let scanned = 0;
		for (const iss of issues) {
			if (iss.pull_request) continue;
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
					`    ${scriptPath("link-sub-issue.sh")} <parent> <child>\n` +
					"  It refuses a link that would close a loop of open issues. Where the phrase\n" +
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
