// @vitest-environment node
/*
 * Pins file-issue's logic in-process (#5150): lib/file-issue-core.js's
 * fileIssue, on the in-process gh router and the link fake
 * (lib/file-issue-testkit.ts, the link fake held by
 * file-issue-link.contract.test.ts). Every refusal before the create —
 * a bad takes: label, body, takes:human ticket, placement, parent or map,
 * a likely duplicate, rule:size-line — asserts that no create was sent;
 * the filings beside them assert the create and the link that follow.
 * scripts/file-issue.test.ts keeps the program's boundary set.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import HUMAN_BODIES from "../fixtures/takes-human-bodies.json" with {
	type: "json",
};
import { store } from "./arbiter-testkit";
import { fileIssueKit, filing, issue, ME, NEW } from "./file-issue-testkit";
import { UNFILLED_DESTINATION as UNFILLED } from "./issue-gate";
import { readRuleText } from "./rule-text";
import { TRIED_MIN } from "./takes-label";

/* triage-labels.md's founder-act list, as every takes:human refusal prints it (#4155). */
const ACTS = readRuleText("founder-acts");

const kit = fileIssueKit();
const {
	sb,
	at,
	serve,
	setUp,
	readGhCalls,
	readCreates,
	readBodySeen,
	readLinks,
} = kit;
const run = kit.core;

describe("the takes: label", () => {
	it.each([
		["none", ["kind:ticket"], "no takes: label", "Add one of: takes:wayfinder"],
		[
			"two",
			["takes:implement", "takes:triage"],
			"2 takes: labels (takes:implement, takes:triage)",
			"Keep the one naming the command that opens it.",
		],
		[
			"a value outside the seven",
			["takes:implememt"],
			"takes:implememt is not a takes: value",
			"Use one of the seven: takes:wayfinder",
		],
	])(
		"refuses %s with exit 2, saying the way out, and creates nothing",
		(_, labels, said, wayOut) => {
			setUp();
			const r = run(filing(labels));
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(said);
			expect(r.stderr).toContain(wayOut);
			expect(r.stderr).toContain("Nothing filed.");
			expect(readGhCalls()).toEqual([]);
		},
	);

	it("files an issue carrying exactly one of the seven", () => {
		setUp();
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
	});
});

describe("the body", () => {
	it("refuses an empty body with exit 2", () => {
		setUp();
		const r = run(filing(["takes:implement"]), { stdin: " \n\n" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the body is empty");
		expect(r.stderr).toContain("pipe it in with --body-file -");
		expect(readGhCalls()).toEqual([]);
	});

	it("refuses a wait with no basis with exit 2, and files it once one is written (#672)", () => {
		setUp();
		const r = run(filing(["takes:implement"]), {
			stdin: "**Gated until:** 2026-10-05 — a week live\n",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("Nothing filed: the body carries");
		expect(r.stderr).toContain("no `**Gate basis:**` line");
		expect(readGhCalls()).toEqual([]);
		const ok = run(filing(["takes:implement"]), {
			stdin:
				"**Gated until:** 2026-09-29 — a day live\n**Gate basis:** counters live 24 hours (#616)\n",
		});
		expect(ok.status).toBe(0);
	});

	it("refuses a basis with no warrant beneath a window, printing the template (#4946)", () => {
		setUp();
		const r = run(filing(["takes:implement"]), {
			stdin:
				"**Gated until:** 2026-09-29 — a day live\n**Gate basis:** the body asks for a day\n",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			'Nothing filed: the body carries the basis "the body asks for a day", which carries no warrant, as the wording patterns read it. Every gate line',
		);
		expect(r.stderr).toContain("baseline 27/449 attempts");
		expect(readGhCalls()).toEqual([]);
	});

	it("refuses a gate whose check prints nothing with exit 2, naming the fix (#3487)", () => {
		setUp();
		const r = run(filing(["takes:implement"]), {
			stdin:
				"**Gated on:** it lands — check: `true` — abandon if: it is dropped\n**Gate basis:** the landing sets it\n",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("Nothing filed: the `check:` `true`");
		expect(r.stderr).toContain("reads as NO-OUTPUT");
		expect(r.stderr).toContain('|| echo "not on main"');
		expect(readGhCalls()).toEqual([]);
	});

	it("hands over rule:roadmap-gating with a gate line, and nothing without one (#823)", () => {
		setUp();
		const gated = run(filing(["takes:implement"]), {
			stdin:
				"**Gated until:** 2026-09-29 — a day live\n**Gate basis:** counters live 24 hours (#616)\n",
		});
		expect(gated.status).toBe(0);
		expect(gated.stderr).toContain("the rule that governs it");
		const plain = run(filing(["takes:implement"]));
		expect(plain.status).toBe(0);
		expect(plain.stderr).not.toContain("§Gating an issue");
	});

	it("refuses a body file that cannot be read with exit 2", () => {
		setUp();
		const args = filing(["takes:implement"]);
		args[args.length - 1] = at("missing.md");
		const r = run(args);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not read the body");
		expect(r.stderr).toContain("pipe it in with --body-file -");
		expect(readGhCalls()).toEqual([]);
	});
});

describe("takes:human — the create guard's Outside-line tests", () => {
	const triedWayOut = `**Tried:** line followed directly by at least ${TRIED_MIN}`;
	it.each([
		{
			name: "no Outside line",
			body: "Just do it.",
			said: "names no act performed outside Claude Code",
			wayOuts: [
				"If you can honestly write neither, the label is wrong",
				triedWayOut,
			],
			quotesActs: true,
		},
		{
			name: "an Outside line naming a repo file",
			body: "**Outside Claude Code:** draw `docs/logo.svg` in Inkscape",
			said: "produces a file in this repository",
			wayOuts: ["The file is takes:implement"],
			quotesActs: false,
		},
		{
			name: "an Outside line naming a prohibition",
			body: "**Outside Claude Code:** no agent may edit the settings file",
			said: "names a prohibition rather than an act",
			wayOuts: ["a real bar is takes:wayfinder"],
			quotesActs: true,
		},
	])(
		"refuses $name with exit 2, saying the way out",
		({ body, said, wayOuts, quotesActs }) => {
			setUp();
			const r = run(filing(["takes:human"]), { stdin: `${body}\n` });
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(said);
			for (const wayOut of wayOuts) expect(r.stderr).toContain(wayOut);
			if (quotesActs) expect(r.stderr).toContain(ACTS);
			expect(readGhCalls()).toEqual([]);
		},
	);

	it("files one whose Outside line names a real outside act", () => {
		setUp();
		const r = run(filing(["takes:human"]), {
			stdin:
				"**Outside Claude Code:** pay the OTA invoice from the bank app\n\n**Close when:** the receipt is attached here\n",
		});
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
	});
});

const REFUSAL_PHRASE: Record<string, string> = {
	"NO-OUTSIDE-ACT": "names no act performed outside Claude Code",
	"BARRED-NOT-IMPOSSIBLE": "names a prohibition rather than an act",
	"REPO-FILE-ACT": "produces a file in this repository",
	"NOT-A-FOUNDER-ACT": "names none of the founder's own acts",
	"SURFACE-UNTRIED": "names a screen a session can drive",
	"REFUSED-UNTRIED": "names a refused act as its only founder act",
	"OBSERVE-ONLY": "only founder part is to observe a result",
	"NO-CLOSE-WHEN": "has no **Close when:** line",
};

describe("takes:human — the shared table of bodies (#1095)", () => {
	it.each(HUMAN_BODIES)("$reason", ({ body, verdict }) => {
		setUp();
		const r = run(filing(["takes:human"]), { stdin: `${body}\n` });
		if (verdict === "pass") {
			expect(r.status).toBe(0);
			expect(readCreates()).toHaveLength(1);
			return;
		}
		expect(r.status).toBe(2);
		expect(readGhCalls()).toEqual([]);
		for (const [tag, said] of Object.entries(REFUSAL_PHRASE))
			if (tag === verdict) expect(r.stderr).toContain(said);
			else expect(r.stderr).not.toContain(said);
	});

	it("quotes the act list and names both ways out", () => {
		setUp();
		const r = run(filing(["takes:human"]), {
			stdin:
				"**Outside Claude Code:** look up the dorm prices on the Bunkward site.\n",
		});
		expect(r.status).toBe(2);
		expect(readGhCalls()).toEqual([]);
		expect(r.stderr).toContain(ACTS);
		expect(r.stderr).toContain("name the act from that list");
		expect(r.stderr).toContain(
			`**Tried:** line followed directly by at least ${TRIED_MIN}`,
		);
	});
});

describe("takes:human — the Close-when line (#983)", () => {
	const errand =
		"**Outside Claude Code:** pay the OTA invoice from the bank app";

	it.each([
		["no Close-when line", `${errand}\n`],
		["a bare Close-when marker", `${errand}\n\n**Close when:** \n`],
	])("refuses %s with exit 2, naming the line and the template", (_, body) => {
		setUp();
		const r = run(filing(["takes:human"]), { stdin: body });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no **Close when:** line");
		expect(r.stderr).toContain("rule-text.sh founder-deliverable");
		expect(readGhCalls()).toEqual([]);
	});

	it("judges the Outside line first, so one body earns one refusal", () => {
		setUp();
		const r = run(filing(["takes:human"]), { stdin: "Just do it.\n" });
		expect(r.stderr).toContain("names no act performed outside Claude Code");
		expect(r.stderr).not.toContain("has no **Close when:** line");
	});

	it("prints the founder-deliverable fragment whenever it applies takes:human", () => {
		const fragment = readRuleText("founder-deliverable");
		setUp();
		const refused = run(filing(["takes:human"]), { stdin: `${errand}\n` });
		expect(refused.stderr).toContain(fragment);
		setUp();
		const filed = run(filing(["takes:human"]), {
			stdin: `${errand}\n\n**Close when:** the receipt is attached here\n`,
		});
		expect(filed.status).toBe(0);
		expect(filed.stderr).toContain(fragment);
	});

	it("prints nothing of it on any other takes: value", () => {
		setUp();
		const r = run(filing(["takes:implement"]));
		expect(r.stderr).not.toContain(readRuleText("founder-deliverable"));
	});
});

describe("placement", () => {
	it.each([
		["neither", []],
		["both", ["--parent", "528", "--standalone", "cross-cutting"]],
	])("refuses %s of --parent and --standalone with exit 2", (_, placement) => {
		setUp();
		const r = run(filing(["takes:implement"], placement));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("exactly one of --parent <n> or --standalone");
		expect(readGhCalls()).toEqual([]);
	});

	it("writes a --standalone reason into the body and links nothing", () => {
		setUp();
		const r = run(
			filing(
				["takes:implement"],
				["--standalone", "cross-cutting, no originator"],
			),
		);
		expect(r.status).toBe(0);
		expect(readBodySeen()).toBe(
			"Ticket body.\n\nStandalone: cross-cutting, no originator\n",
		);
		expect(r.stdout).toContain("Standalone: cross-cutting, no originator");
		expect(r.stdout).toContain("— written into the body");
		expect(readGhCalls().some((c) => c.includes("sub_issues"))).toBe(false);
		expect(readLinks()).toEqual([]);
	});

	it("keeps a body's own Standalone line rather than writing a second (#1027)", () => {
		setUp();
		const r = run(
			filing(["takes:implement"], ["--standalone", "a retro finding"]),
			{ stdin: "Ticket body.\n\n  Standalone: a retro finding\n" },
		);
		expect(r.status).toBe(0);
		expect(readBodySeen()).toBe(
			"Ticket body.\n\n  Standalone: a retro finding\n",
		);
		expect(r.stdout).toContain("the body's own Standalone line was kept");
		expect(r.stdout).not.toContain("— written into the body");
	});
});

describe("a closed parent (#3637)", () => {
	const Api = "https://api.github.com/repos/acme/widgets/issues/";

	it("is refused with exit 2 before any create, naming its nearest open ancestor", () => {
		setUp(["kind:spec"], { state: "closed", parent_issue_url: `${Api}500` });
		serve(
			"repos/acme/widgets/issues/500",
			issue(500, [], { state: "closed", parent_issue_url: `${Api}400` }),
		);
		serve("repos/acme/widgets/issues/400", issue(400, ["wayfinder:map"]));
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("#528 is closed");
		expect(r.stderr).toContain(
			'Its nearest open ancestor is #400 (issue 400): --parent 400, or --standalone "<why>".',
		);
		expect(readCreates()).toEqual([]);
	});

	it("points at --standalone where no ancestor is open", () => {
		setUp(["kind:spec"], { state: "closed" });
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			'No ancestor of #528 in acme/widgets is open: place it under another open issue, or --standalone "<why>".',
		);
		expect(readCreates()).toEqual([]);
	});

	it("never names an ancestor in another repository, which no link can reach", () => {
		setUp(["kind:spec"], {
			state: "closed",
			parent_issue_url: "https://api.github.com/repos/acme/other/issues/7",
		});
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("No ancestor of #528 in acme/widgets is open");
		expect(readGhCalls().some((c) => c.includes("acme/other"))).toBe(false);
	});
});

describe("urgent under an urgent chain (#3648)", () => {
	const Api = "https://api.github.com/repos/acme/widgets/issues/";

	it("is refused with exit 2 before any create where the parent carries it", () => {
		setUp(["kind:spec", "urgent"]);
		const r = run(filing(["takes:implement", "urgent"]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("#528 carries urgent");
		expect(r.stderr).toContain(
			"where only some children are urgent, move urgent off #528 onto them, or order them with blocking edges. Nothing filed.",
		);
		expect(readCreates()).toEqual([]);
	});

	it.each([
		["a grandparent", 400],
		["a great-grandparent", 300],
	])("is refused where %s carries it, naming that ancestor", (_, carrier) => {
		setUp(["kind:spec"], { parent_issue_url: `${Api}500` });
		for (const n of [500, 400, 300])
			serve(
				`repos/acme/widgets/issues/${n}`,
				issue(n, n === carrier ? ["urgent"] : [], {
					parent_issue_url: `${Api}${n - 100}`,
				}),
			);
		const r = run(filing(["takes:implement", "urgent"]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`#${carrier}, an ancestor of #528, carries urgent`,
		);
		expect(r.stderr).toContain(`move urgent off #${carrier} onto them`);
		expect(readCreates()).toEqual([]);
	});

	it("files where the urgent ancestor sits above a closed one, which passes nothing down", () => {
		setUp(["kind:spec"], { parent_issue_url: `${Api}500` });
		serve(
			"repos/acme/widgets/issues/500",
			issue(500, [], { state: "closed", parent_issue_url: `${Api}400` }),
		);
		serve("repos/acme/widgets/issues/400", issue(400, ["urgent"]));
		const r = run(filing(["takes:implement", "urgent"]));
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
	});

	it.each([
		["a chain with no urgent", ["--parent", "528"]],
		["--standalone", ["--standalone", "cross-cutting"]],
	])("files under %s", (_, placement) => {
		setUp(["kind:spec"], { parent_issue_url: `${Api}500` });
		serve("repos/acme/widgets/issues/500", issue(500, []));
		const r = run(filing(["takes:implement", "urgent"], placement));
		expect(r.status).toBe(0);
		expect(readCreates()[0]).toContain("--label urgent");
	});

	it("files where an ancestor cannot be read, saying the check was skipped", () => {
		setUp(["kind:spec"], { parent_issue_url: `${Api}500` });
		const r = run(filing(["takes:implement", "urgent"]));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"Could not read #528's ancestors (HTTP 404: Not Found) — filing without the urgent check.",
		);
		expect(readCreates()).toHaveLength(1);
	});
});

describe("the family label the parent implies", () => {
	it("gives a child of a kind:spec kind:ticket in the one create", () => {
		setUp(["kind:spec"]);
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(0);
		expect(readCreates()[0]).toContain(
			"--label takes:implement --label origin:triage --label kind:ticket",
		);
		expect(r.stdout).toContain("kind:ticket added: #528 is a spec");
	});

	it.each([
		["a wayfinder:map", ["wayfinder:map", "takes:wayfinder"]],
		["a map's wayfinder:* child", ["wayfinder:grilling", "takes:wayfinder"]],
	])(
		"refuses a child of %s carrying no wayfinder:<type>",
		(_, parentLabels) => {
			setUp(parentLabels);
			const r = run(filing(["takes:implement"]));
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("takes a wayfinder:<type>");
			expect(readCreates()).toEqual([]);
		},
	);

	it("files a child of a wayfinder:map that carries one", () => {
		setUp(["wayfinder:map", "takes:wayfinder"]);
		const r = run(filing(["takes:wayfinder", "wayfinder:grilling"]));
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
	});

	it.each([
		["kind:spec", "a wayfinder:map", ["wayfinder:map", "takes:wayfinder"]],
		["kind:brief", "a wayfinder:map", ["wayfinder:map", "takes:wayfinder"]],
		[
			"kind:spec",
			"a map's wayfinder:* child",
			["wayfinder:grilling", "takes:wayfinder"],
		],
	])(
		"files a %s child of %s with no wayfinder:<type>, as /to-spec needs for its own map (#714)",
		(kind, _, parentLabels) => {
			setUp(parentLabels);
			const r = run(
				filing([
					kind,
					kind === "kind:spec" ? "takes:to-tickets" : "takes:to-spec",
				]),
			);
			expect(r.status).toBe(0);
			expect(readCreates()).toHaveLength(1);
		},
	);
});

describe("a second map while the first is unfilled (#717)", () => {
	const openMap = (number: number, destination: string) =>
		issue(number, ["wayfinder:map", "takes:wayfinder"], {
			body: `## Destination\n\n${destination}\n\n## Notes\n`,
		});
	const mapFiling = () =>
		filing(
			["takes:wayfinder", "wayfinder:map"],
			["--standalone", "a new effort"],
		);
	const listCalls = () =>
		readGhCalls().filter((c) => c.startsWith("issue list"));

	it("is refused with exit 2 before any create, naming the map to fill", () => {
		setUp();
		fs.writeFileSync(at("issues"), JSON.stringify([openMap(3, UNFILLED)]));
		const r = run(mapFiling());
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("Fill #3 instead");
		expect(r.stderr).toContain("Nothing filed.");
		expect(readCreates()).toEqual([]);
		expect(listCalls()).toHaveLength(1);
		expect(listCalls()[0]).toMatch(
			/^issue list --repo acme\/widgets --label wayfinder:map --state open /,
		);
	});

	it("files once every open map's Destination is filled", () => {
		setUp();
		fs.writeFileSync(
			at("issues"),
			JSON.stringify([openMap(3, "Ship the booking flow.")]),
		);
		expect(run(mapFiling()).status).toBe(0);
		expect(readCreates()).toHaveLength(1);
	});

	it("reads no maps for a create that is not a map", () => {
		setUp();
		fs.writeFileSync(at("issues"), JSON.stringify([openMap(3, UNFILLED)]));
		expect(run(filing(["takes:implement"])).status).toBe(0);
		expect(
			listCalls().filter((c) => c.includes("--label wayfinder:map")),
		).toEqual([]);
	});

	it("files anyway, saying so and recording it, when the maps cannot be read", () => {
		setUp();
		fs.writeFileSync(at("list-fails"), "");
		const r = run(mapFiling());
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"the open maps could not be listed (HTTP 502: Bad Gateway) — filing without the second-map check.",
		);
		expect(readCreates()).toHaveLength(1);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
			"file-issue second-map\tthe open maps could not be listed",
		);
	});
});

const SIZE_LINE = readRuleText("size-line");

const LANDER = "Fix the red batch in `src/batch/red-batch.js` and its test.";

describe("rule:size-line before a takes:implement filing (#4450)", () => {
	const sibling = (
		number: number,
		body: string,
		labels = ["takes:implement"],
	) => issue(number, labels, { body });
	const confirmed = (n: string) => [
		...filing(["takes:implement"]),
		"--size-line-checked",
		n,
	];

	it("refuses a second takes:implement filing in one session, printing the rule, and files it once confirmed", () => {
		setUp();
		expect(run(filing(["takes:implement"])).status).toBe(0);
		serve(`repos/acme/widgets/issues/${NEW}`, issue(NEW, ["takes:implement"]));
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(SIZE_LINE);
		expect(r.stderr).toContain(`#${NEW} — filed by this session`);
		expect(r.stderr).toContain(`--size-line-checked ${NEW}`);
		expect(r.stderr).toContain("Nothing filed.");
		expect(readCreates()).toHaveLength(1);
		expect(run(confirmed(String(NEW))).status).toBe(0);
		expect(readCreates()).toHaveLength(2);
	});

	it.each([
		["closed", issue(NEW, ["takes:implement"], { state: "closed" })],
		["no takes:implement", issue(NEW, ["takes:triage"])],
	])("passes over an earlier filing of this session's that is %s", (_, row) => {
		setUp();
		expect(run(filing(["takes:implement"])).status).toBe(0);
		serve(`repos/acme/widgets/issues/${NEW}`, row);
		expect(run(filing(["takes:implement"])).status).toBe(0);
	});

	it("refuses a ticket naming a source file an open sibling names, printing the rule and the sibling", () => {
		setUp();
		serve("repos/acme/widgets/issues/528/sub_issues", [
			[
				sibling(540, "Stall slice in src/batch/red-batch.js."),
				sibling(541, "Other: `scripts/x.js`."),
			],
		]);
		const r = run(filing(["takes:implement"]), { stdin: LANDER });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(SIZE_LINE);
		expect(r.stderr).toContain(
			"#540 — an open sibling also naming src/batch/red-batch.js",
		);
		expect(r.stderr).not.toContain("#541");
		expect(r.stderr).toContain("--size-line-checked 540");
		expect(readCreates()).toEqual([]);
		expect(run(confirmed("540"), { stdin: LANDER }).status).toBe(0);
	});

	it.each([
		[
			"closed",
			issue(540, ["takes:implement"], {
				state: "closed",
				body: "src/batch/red-batch.js",
			}),
		],
		[
			"no takes:implement",
			sibling(540, "src/batch/red-batch.js", ["takes:triage"]),
		],
		["sharing only a doc", sibling(540, "docs/agents/issue-tracker.md")],
	])("files beside a sibling %s", (_, row) => {
		setUp();
		serve("repos/acme/widgets/issues/528/sub_issues", [[row]]);
		const r = run(filing(["takes:implement"]), {
			stdin: `${LANDER} See docs/agents/issue-tracker.md.`,
		});
		expect(r.status).toBe(0);
	});

	it("prints nothing extra on a first, unrelated filing", () => {
		setUp();
		serve("repos/acme/widgets/issues/528/sub_issues", [
			[sibling(540, "scripts/other.js")],
		]);
		const r = run(filing(["takes:implement"]), { stdin: LANDER });
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).not.toContain("size-line");
		expect(r.stdout).not.toContain("Could not");
	});

	it("weighs nothing for a ticket that is no takes:implement", () => {
		setUp();
		serve("repos/acme/widgets/issues/528/sub_issues", [
			[sibling(540, "src/batch/red-batch.js")],
		]);
		expect(run(filing(["takes:triage"]), { stdin: LANDER }).status).toBe(0);
	});

	it("files without the shared-file check where the sub-issues will not read, saying so", () => {
		setUp();
		fs.rmSync(path.join(at("api"), "repos_acme_widgets_issues_528_sub_issues"));
		const r = run(filing(["takes:implement"]), { stdin: LANDER });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"Could not list #528's sub-issues (HTTP 404: Not Found) — filing without the shared-file check.",
		);
	});

	it("files without weighing earlier filings where the acts ledger will not read, saying so", () => {
		setUp();
		fs.mkdirSync(store.paths.actLedger(ME, sb.repo), { recursive: true });
		const r = run(filing(["takes:implement"]));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"Could not read this session's acts ledger — filing without weighing its earlier filings under rule:size-line.",
		);
	});
});

describe("the filing declarations (#4796)", () => {
	const Session = "11111111-2222-3333-4444-555555555555";
	const Slug = "-home-u-repo";
	const DenyText =
		"docs/doc-map.md is held by session 735db33b (pid 1), which is still running.";
	/* A record the case names: a guard's deny, as a tool_result flagged is_error. */
	const caseRecord = {
		type: "user",
		uuid: "u-case",
		timestamp: "2026-11-01T10:00:00.000Z",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					is_error: true,
					content: DenyText,
				},
			],
		},
	};
	/* The call that met the deny, on line 3: a `reads: "call"` case. */
	const callRecord = {
		type: "assistant",
		uuid: "a-call",
		timestamp: "2026-11-01T10:01:00.000Z",
		message: {
			content: [
				{
					type: "tool_use",
					id: "toolu_2",
					name: "Bash",
					input: { command: "git push --force origin main" },
				},
			],
		},
	};
	/** The session's transcript on the second seat, the case record on line 2. */
	const seatTranscript = () => {
		const dir = path.join(path.dirname(sb.home), ".claude2", "projects", Slug);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${Session}.jsonl`),
			[
				{ type: "user", uuid: "u0", message: { content: "hi" } },
				caseRecord,
				callRecord,
			]
				.map((r) => `${JSON.stringify(r)}\n`)
				.join(""),
		);
	};
	const sigFile = (content: unknown) => {
		const f = at("sig.json");
		fs.writeFileSync(f, JSON.stringify(content));
		return f;
	};
	const declaring = (extra: string[]) => [
		...filing(["takes:implement"]),
		"--origin",
		"code-review",
		...extra,
	];
	const log = () =>
		path.join(sb.repo, "docs", "data", "outcome-signatures.jsonl");
	const readLog = () =>
		fs.existsSync(log())
			? fs
					.readFileSync(log(), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];
	const regexSig = (pattern: string, scope = "main") => ({
		signature: { kind: "regex", pattern, scope },
		prediction: "the hold denials stop",
		case: { session: Session, line: 2 },
	});

	it("refuses a filing with no --origin, naming the list, and creates nothing", () => {
		setUp();
		const r = run([...filing(["takes:implement"]), "--no-fault"], {
			bare: true,
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--origin is required");
		expect(r.stderr).toContain("lander-script");
		expect(readCreates()).toEqual([]);
	});

	it("refuses an --origin off the list", () => {
		setUp();
		const r = run(
			declaring(["--no-fault"]).map((a) => (a === "code-review" ? "vibes" : a)),
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--origin 'vibes' is not on the list");
		expect(readCreates()).toEqual([]);
	});

	it.each([
		["neither", []],
		["both", ["--no-fault", "--fault-signature", "x.json"]],
	])("refuses %s of --fault-signature and --no-fault", (_, extra) => {
		setUp();
		const r = run(declaring(extra));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"give exactly one of --fault-signature <file> or --no-fault",
		);
		expect(readCreates()).toEqual([]);
	});

	it("stamps origin:<class> on the create and logs nothing for --no-fault", () => {
		setUp();
		const r = run(declaring(["--no-fault"]), { cwd: sb.repo });
		expect(r.status).toBe(0);
		expect(readCreates()[0]).toContain("--label origin:code-review");
		expect(readCreates()[0]).not.toContain("fault-signature");
		expect(readBodySeen()).not.toContain("## Fault signature");
		expect(readLog()).toEqual([]);
	});

	it.each([
		[
			"an unknown needle key",
			{ signature: { kind: "needle", key: "no-such-guard.js" } },
			"is not a guard with needles",
		],
		[
			"a regex with no scope",
			{ signature: { kind: "regex", pattern: "x" } },
			'"scope" is one of main, subagent, both',
		],
		[
			"a regex reading neither output nor calls",
			{
				signature: {
					kind: "regex",
					pattern: "x",
					scope: "main",
					reads: "prose",
				},
			},
			'"reads" is "output"',
		],
		[
			"a tool named on an output regex",
			{
				signature: {
					kind: "regex",
					pattern: "x",
					scope: "main",
					tool: "Bash",
				},
			},
			'"tool" names the one tool',
		],
		[
			"a pattern that does not compile",
			{ signature: { kind: "regex", pattern: "(", scope: "main" } },
			"the pattern does not compile",
		],
		[
			"null with no why",
			{ signature: null },
			'"signature": null needs a "why"',
		],
		[
			"no prediction",
			{ signature: { kind: "regex", pattern: "x", scope: "main" } },
			'has no "prediction"',
		],
		[
			"no case",
			{
				signature: { kind: "regex", pattern: "x", scope: "main" },
				prediction: "fewer",
			},
			'has no usable "case"',
		],
	])("refuses a signature file with %s", (_, content, said) => {
		setUp();
		const r = run(declaring(["--fault-signature", sigFile(content)]));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(said);
		expect(readCreates()).toEqual([]);
	});

	it("refuses a signature that does not match its case, read off another seat", () => {
		setUp();
		seatTranscript();
		const r = run(
			declaring(["--fault-signature", sigFile(regexSig("never printed"))]),
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("does not match its case");
		expect(r.stderr).toContain(".claude2");
		expect(readCreates()).toEqual([]);
	});

	it("refuses a regex scoped to subagents against a main-session case", () => {
		setUp();
		seatTranscript();
		const r = run(
			declaring([
				"--fault-signature",
				sigFile(regexSig("is held by session", "subagent")),
			]),
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("does not match its case");
	});

	it("refuses a case no seat keeps", () => {
		setUp();
		const r = run(
			declaring(["--fault-signature", sigFile(regexSig("is held by session"))]),
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			`no seat keeps a transcript for session ${Session}`,
		);
	});

	it("files a matching regex signature and appends its line", () => {
		setUp();
		seatTranscript();
		const r = run(
			declaring([
				"--fault-signature",
				sigFile(regexSig("is held by session \\w+")),
			]),
			{ cwd: sb.repo },
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Signature logged");
		const [line, ...more] = readLog();
		expect(more).toEqual([]);
		expect(line).toMatchObject({
			issue: `acme/widgets#${NEW}`,
			signature: {
				kind: "regex",
				pattern: "is held by session \\w+",
				scope: "main",
			},
			prediction: "the hold denials stop",
			case: { session: Session, line: 2 },
		});
		expect(Number.isNaN(Date.parse(line.filedAt))).toBe(false);
		/* The create carries the label and the line less its issue (#4861). */
		expect(readCreates()[0]).toContain("--label fault-signature");
		const { issue: _, ...rest } = line;
		expect(readBodySeen()).toContain(
			`## Fault signature\n\n\`\`\`json\n${JSON.stringify(rest)}\n\`\`\`\n`,
		);
	});

	it("files a call-reading regex against the tool_use record that is its case, logging reads and its tool", () => {
		setUp();
		seatTranscript();
		const callSig = {
			signature: {
				kind: "regex",
				pattern: "push --force",
				scope: "main",
				reads: "call",
				tool: "Bash",
			},
			prediction: "no force pushes to main",
			case: { session: Session, line: 3 },
		};
		const r = run(declaring(["--fault-signature", sigFile(callSig)]), {
			cwd: sb.repo,
		});
		expect(r.status).toBe(0);
		expect(readLog()[0].signature).toEqual(callSig.signature);
	});

	it("refuses a call-reading regex naming another tool than its case's call", () => {
		setUp();
		seatTranscript();
		const r = run(
			declaring([
				"--fault-signature",
				sigFile({
					signature: {
						kind: "regex",
						pattern: "push --force",
						scope: "main",
						reads: "call",
						tool: "Edit",
					},
					prediction: "no force pushes to main",
					case: { session: Session, line: 3 },
				}),
			]),
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("does not match its case");
		expect(readCreates()).toEqual([]);
	});

	it("refuses an output-reading regex whose case is the tool call, naming where the case belongs", () => {
		setUp();
		seatTranscript();
		const r = run(
			declaring([
				"--fault-signature",
				sigFile({
					...regexSig("push --force"),
					case: { session: Session, line: 3 },
				}),
			]),
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the line where the fault surfaces");
		expect(r.stderr).toContain('"reads": "call"');
		expect(readCreates()).toEqual([]);
	});

	it("files a needle signature whose guard fired on the case", () => {
		setUp();
		seatTranscript();
		const needles = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "..", "guard-fire-needles.json"),
				"utf8",
			),
		);
		const host = path.join(sb.repo, ".claude", "guard-fire-needles.json");
		fs.writeFileSync(
			host,
			JSON.stringify({
				guards: {
					"host-hold-guard.js": {
						needles: [
							{ id: "held", text: ["is held by session", "still running."] },
						],
					},
				},
			}),
		);
		expect(needles.guards["host-hold-guard.js"]).toBeUndefined();
		const r = run(
			declaring([
				"--fault-signature",
				sigFile({
					signature: {
						kind: "needle",
						key: "host-hold-guard.js",
						needle: "held",
					},
					prediction: "fewer hold denials",
					case: { session: Session, line: 2 },
				}),
			]),
			{ cwd: sb.repo },
		);
		expect(r.status).toBe(0);
		expect(readLog()[0].signature).toEqual({
			kind: "needle",
			key: "host-hold-guard.js",
			needle: "held",
		});
	});

	it("accepts null with a why, logging it with no case", () => {
		setUp();
		const r = run(
			declaring([
				"--fault-signature",
				sigFile({
					signature: null,
					why: "the fault leaves no transcript trace",
				}),
			]),
			{ cwd: sb.repo },
		);
		expect(r.status).toBe(0);
		expect(readLog()).toEqual([
			expect.objectContaining({
				issue: `acme/widgets#${NEW}`,
				signature: null,
				why: "the fault leaves no transcript trace",
			}),
		]);
		expect(readCreates()[0]).toContain("--label fault-signature");
		expect(readBodySeen()).toContain('"signature":null');
	});
});
