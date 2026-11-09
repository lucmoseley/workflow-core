// @vitest-environment node
/*
 * origin-fallback.test.ts — #4627's keyword rules for an issue with no
 * `origin:*` label (#4797). Break it and the ticket-mix review counts a
 * hand-filed issue under the wrong origin, or under one off the fixed list.
 */

import { describe, expect, it } from "vitest";
import { ORIGINS } from "./issue-origin";
import { classifyOrigin } from "./origin-fallback";

interface Issue {
	title: string;
	body?: string;
	labels?: string[];
}
const of = ({ title, body = "", labels = [] }: Issue) =>
	classifyOrigin({ title, body, labels: labels.map((name) => ({ name })) });

describe("classifyOrigin, a case per class", () => {
	it.each<[string, Issue]>([
		["morning-review-script", { title: "Morning review — 2026-11-08" }],
		["incident", { title: "Memory kill incident from 2026-11-08" }],
		["incident", { title: "Suite queue wait is over 10 minutes" }],
		["wayfinder", { title: "Map the lander", labels: ["wayfinder:map"] }],
		["wayfinder", { title: "Flip check", labels: ["takes:wayfinder"] }],
		["to-spec", { title: "Spec: weekly mix" }],
		["to-spec", { title: "A spec", labels: ["kind:spec"] }],
		["orphaned-edit-script", { title: "Orphaned edit: docs/x.md" }],
		["lander-script", { title: "q/x dropped by the queue lander" }],
		["lander-script", { title: "Landing queue held on main" }],
		["ci-red", { title: "Something", labels: ["ci-red"] }],
		["ci-red", { title: "Fix it", body: "Standalone: red main since abc." }],
		["release-bump", { title: "Bump workflow-core to v1.2" }],
		["repo-checks-script", { title: "Repo checks: standing findings" }],
		["repo-checks-script", { title: "x", labels: ["manual-finding"] }],
		[
			"morning-review-script",
			{
				title: "Closed tickets",
				body: "## Closed tickets\nfrom the morning review",
			},
		],
		["found-in-passing", { title: "x", body: "Found by #12 (the suite)" }],
		["concision-pass", { title: "Cut prose", body: "From a concision pass." }],
		["architecture-scan", { title: "x", body: "Architecture scan item." }],
		["heresy-sweep", { title: "x", body: "A heresy sweep find." }],
		["retro", { title: "x", body: "A retro-sweep finding." }],
		["code-review", { title: "x", body: "From the whole-spec review of #4." }],
		["ruling-impl", { title: "x", body: "As ruled on #12." }],
		["measure-census", { title: "Re-measure the suite" }],
		["incident", { title: "x", body: "After the memory kill at noon." }],
		["audit", { title: "x", body: "The audit showed it." }],
		["triage", { title: "x", body: "Moved at triage." }],
		["founder", { title: "x", body: "The founder asked for it." }],
		["founder", { title: "x", labels: ["takes:human"] }],
		["to-tickets-child", { title: "x", body: "## Parent\n#4796" }],
		["to-tickets-child", { title: "x", body: "Part of #4796." }],
		["follow-up", { title: "x", body: "Split out of #12." }],
		["measure-census", { title: "x", body: "The readout found 3." }],
		["code-review", { title: "x", body: "Seen while reviewing #3." }],
		["found-in-passing", { title: "x", body: "Met in passing on #3." }],
		["follow-up", { title: "x", body: "The follow-up to #3." }],
		["unmarked", { title: "Plain title", body: "Nothing to go on." }],
	])("%s: %j", (want, issue) => {
		expect(of(issue)).toBe(want);
	});

	it("answers only the fixed list or unmarked", () => {
		const out = of({ title: "x", body: "A retro finding." });
		expect([...ORIGINS, "unmarked"]).toContain(out);
	});
});

describe("classifyOrigin, first match wins", () => {
	it("a daily report title beats a wayfinder label", () => {
		expect(
			of({ title: "Morning review — x", labels: ["takes:wayfinder"] }),
		).toBe("morning-review-script");
	});

	it("review findings in a wayfinder's title is code-review", () => {
		expect(
			of({ title: "Code-review findings for #3", labels: ["wayfinder:task"] }),
		).toBe("code-review");
	});

	it("a wayfinder label beats a Spec: title", () => {
		expect(of({ title: "Spec: x", labels: ["wayfinder:grilling"] })).toBe(
			"wayfinder",
		);
	});

	it("ci-red beats every provenance keyword", () => {
		expect(
			of({ title: "x", body: "Standalone: landing break, an audit." }),
		).toBe("ci-red");
	});

	it("concision beats retro, and retro beats review", () => {
		expect(of({ title: "x", body: "Concision pass from the retro." })).toBe(
			"concision-pass",
		);
		expect(of({ title: "x", body: "A retro finding from code review." })).toBe(
			"retro",
		);
	});

	it("a keyword beats the Part of line", () => {
		expect(of({ title: "x", body: "Part of #1, from the audit." })).toBe(
			"audit",
		);
	});

	it("a ruling beside a census row is the census", () => {
		expect(of({ title: "x", body: "The ruling on the census row." })).toBe(
			"measure-census",
		);
	});

	it("reads only the first two sections' heads", () => {
		const long = `${"word ".repeat(60)}`;
		expect(
			of({
				title: "x",
				body: `## A\n${long}\n## B\nplain\n## C\nThe founder asked.`,
			}),
		).toBe("unmarked");
	});
});
