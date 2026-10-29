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
import HUMAN_BODIES from "./fixtures/takes-human-bodies.json" with {
	type: "json",
};
import { freshSandbox, issueClaims, store } from "./lib/arbiter-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { UNFILLED_DESTINATION as UNFILLED } from "./lib/issue-gate";
import { MARKERS_REL } from "./lib/marker-root";
import { readRuleText } from "./lib/rule-text";
import { runInProcess } from "./lib/run-in-process";
import { FOUNDER_ACTS, TAKES_VALUES, TRIED_MIN } from "./lib/takes-label";

const SCRIPT = path.resolve(__dirname, "file-issue.js");
const ME = "sess-me";
/** The number the stubbed create returns — nothing a caller could guess. */
const NEW = 561;

const sb = freshSandbox((s) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
});

const at = (name: string) => path.join(sb.dir, name);

/** Serve `body` for `gh api <apiPath>`. */
const serve = (apiPath: string, body: unknown) => {
	fs.mkdirSync(at("api"), { recursive: true });
	fs.writeFileSync(
		path.join(at("api"), apiPath.replaceAll("/", "_")),
		JSON.stringify(body),
	);
};

const LABELS = [
	...TAKES_VALUES.map((v) => `takes:${v}`),
	"kind:spec",
	"kind:ticket",
	"kind:brief",
	"wayfinder:map",
	"wayfinder:grilling",
	"wayfinder:research",
	"urgent",
];

const issue = (number: number, labels: string[], over: object = {}) => ({
	number,
	title: `issue ${number}`,
	state: "open",
	labels: labels.map((name) => ({ name })),
	body: "",
	parent_issue_url: null,
	...over,
});

/**
 * The `gh` stub. `issue list` answers from the `issues` file, or `[]`;
 * `issue create` saves its stdin body and prints the new URL;
 * the sub-issue POST fails with the text in `post-err` where it exists, and
 * otherwise makes the parent list the child; `api <path>` answers from
 * serve()'s files. Every argv is logged.
 */
const ghStub = () =>
	stubGhScript(
		sb.dir,
		`#!/bin/sh
echo "$*" >> "${at("gh-calls")}"
case "$*" in
  "issue create"*)
    cat > "${at("body-seen")}"
    echo "https://github.com/acme/widgets/issues/${NEW}"; exit 0 ;;
  "issue list"*)
    if [ -f "${at("list-fails")}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    f="${at("issues")}"; case "$*" in *"--state open --json number,title,state"*) f="${at("issues-open")}" ;; esac
    if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi
    exit 0 ;;
  "issue edit"*)
    if [ -f "${at("assign-fails")}" ]; then echo "HTTP 403: no" >&2; exit 1; fi
    exit 0 ;;
  *"--method POST"*)
    if [ -f "${at("post-err")}" ]; then cat "${at("post-err")}" >&2; exit 1; fi
    touch "${at("linked")}"; exit 0 ;;
  *"/sub_issues"*) [ -f "${at("linked")}" ] && echo ${NEW}; exit 0 ;;
  *"--jq .id"*) echo 987654; exit 0 ;;
  *"--jq .state"*) echo open; exit 0 ;;
  "api "*)
    f="${at("api")}/$(echo "$2" | tr / _)"
    [ -f "$f" ] && cat "$f" && exit 0
    echo "HTTP 404: Not Found" >&2; exit 1 ;;
esac
exit 0
`,
	);

/** The liveness oracle, listing exactly `ids`. */
const oracle = (ids: string[]) => {
	const bin = at("claude-agents");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho '${JSON.stringify(ids.map((sessionId) => ({ sessionId })))}'\n`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
};

const setUp = (parentLabels: string[] = ["kind:spec"], over: object = {}) => {
	serve(
		"repos/acme/widgets/labels",
		LABELS.map((name) => ({ name })),
	);
	serve("repos/acme/widgets/issues/528", issue(528, parentLabels, over));
};

const run = (
	args: string[],
	{
		stdin = "Ticket body.\n",
		sessionId = ME as string | null,
	}: { stdin?: string; sessionId?: string | null } = {},
) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...ghStub().env,
		WFC_CLAUDE_BIN: oracle([ME]),
		WFC_LINK_SLEEP: "0",
		WFC_LINK_RETRIES: "2",
		CLAUDE_CODE_SESSION_ID: sessionId ?? "",
	};
	if (sessionId === null) delete env.CLAUDE_CODE_SESSION_ID;
	return runInProcess(SCRIPT, args, { env, stdin });
};

const filing = (labels: string[], placement = ["--parent", "528"]) => [
	"--title",
	"A new ticket",
	...labels.flatMap((l) => ["--label", l]),
	...placement,
	"--body-file",
	"-",
];

const readGhCalls = () =>
	fs.existsSync(at("gh-calls"))
		? fs.readFileSync(at("gh-calls"), "utf8").split("\n").filter(Boolean)
		: [];
const readCreates = () =>
	readGhCalls().filter((c) => c.startsWith("issue create"));
const readClaimants = () =>
	issueClaims
		.readIssueClaims(NEW)
		.map((e: { record: { sessionId: string } }) => e.record.sessionId);
const assignCall = `issue edit ${NEW} --repo acme/widgets --add-assignee @me`;
const readBodySeen = () => fs.readFileSync(at("body-seen"), "utf8");

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

	it("spells the same seven values docs/agents/triage-labels.md and place-new-issue.sh's takes_values do, and the doc's founder-act list word for word", () => {
		const doc = fs.readFileSync(
			path.resolve(__dirname, "..", "docs", "agents", "triage-labels.md"),
			"utf8",
		);
		expect(TAKES_VALUES).toHaveLength(7);
		for (const v of TAKES_VALUES) expect(doc).toContain(`takes:${v}`);
		for (const act of FOUNDER_ACTS) expect(doc).toContain(act);
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
	it("refuses an empty body with exit 2", () => {
		setUp();
		const r = run(filing(["takes:implement"]), { stdin: " \n\n" });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("the body is empty");
		expect(r.stderr).toContain("pipe it in with --body-file -");
		expect(readGhCalls()).toEqual([]);
	});

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
				"**Gated until:** 2026-09-29 — a day live\n**Gate basis:** counters live 24 hours\n",
		});
		expect(ok.status).toBe(0);
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
				"**Gated until:** 2026-09-29 — a day live\n**Gate basis:** counters live 24 hours\n",
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
			if (quotesActs)
				for (const act of FOUNDER_ACTS) expect(r.stderr).toContain(act);
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
		for (const act of FOUNDER_ACTS) expect(r.stderr).toContain(act);
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
			"--label takes:implement --label kind:ticket",
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
			`#!/bin/sh\necho "$*" >> "${at("gh-calls")}"\ncase "$*" in "issue create"*) cat >/dev/null; exit 0;; esac\ncat "${at("api")}/$(echo "$2" | tr / _)"\n`,
		);
		const r = runInProcess(SCRIPT, filing(["takes:implement"]), {
			env: { ...process.env, ...silent.env },
			stdin: "Body.\n",
		});
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
