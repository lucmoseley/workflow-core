// @vitest-environment node
/*
 * file-issue.js's §X11 boundary set (#5150), run through its command line on
 * file-issue's gh fake as the WFC_GH stub and a sandboxed arbiter store
 * (#533; the seam ruled on #500, Q1 (A)). Each case stays a program case for
 * what only the shell wires: the exit code and streams, argv and --help, the
 * body read from fd 0 and from a file, the real link-writer underneath (a
 * link reported as made is one the parent side listed), the gate judge's
 * spawn and its fallback, the session id from the env, the host clock under
 * WFC_NOW, and the similar-title list's gh failure. The takes: value set is
 * pinned here against each hand copy of it. Every branch — each refusal
 * before the create among them — is pinned in lib/file-issue-core.test.ts.
 *
 * A loosened case lets the shell file a ticket half-made or unplaced on the
 * route the issue-create guard sends every new ticket down.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { issueClaims } from "./lib/arbiter-testkit";
import { NEW } from "./lib/file-issue-gh-fake";
import {
	ASSIGN_CALL,
	declarationFixtures,
	fileIssueKit,
	filing,
	listed,
	ME,
	TRACKER,
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
import { readJsonl } from "./lib/jsonl.js";
import { TAKES_VALUES } from "./lib/takes-label";

const kit = fileIssueKit();
const {
	sb,
	at,
	serveIssues,
	setUp,
	readGhCalls,
	readCreates,
	readClaimants,
	readBodySeen,
} = kit;
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

	it("files on the patterns alone where the model cannot be had, saying so once", () => {
		setUp();
		const r = judged(`Build it.\n\n${Wait}\n`, { exit: 1 });
		expect(r.status).toBe(0);
		expect(readCreates()).toHaveLength(1);
		expect(r.stderr.split(FALLBACK_LEAD)).toHaveLength(2);
		expect(r.stderr).toContain("the judge exited 1");
		expect(r.stderr).not.toContain(MODEL_LEAD);
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

describe("assignment", () => {
	it("with --assign-self, writes the arbiter record and assigns @me", () => {
		setUp();
		const r = run([...filing(["takes:implement"]), "--assign-self"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Recorded the arbiter claim for session ${ME}.`);
		expect(readClaimants()).toEqual([ME]);
		expect(readGhCalls()).toContain(ASSIGN_CALL);
	});
});

describe("a fault signature (#4796)", () => {
	const { Session, seatTranscript, sigFile, declaring, readLog, regexSig } =
		declarationFixtures(kit);

	it("files a matching regex signature and appends its line, stamped from the host clock", () => {
		setUp();
		seatTranscript();
		const r = run(
			declaring([
				"--fault-signature",
				sigFile(regexSig("is held by session \\w+")),
			]),
			{ extraEnv: { WFC_NOW: "2026-11-13T09:00:00.000Z" } },
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
			filedAt: "2026-11-13T09:00:00.000Z",
		});
		/* The create carries the label and the line less its issue (#4861). */
		expect(readCreates()[0]).toContain("--label fault-signature");
		const { issue: _, ...rest } = line;
		expect(readBodySeen()).toContain(
			`## Fault signature\n\n\`\`\`json\n${JSON.stringify(rest)}\n\`\`\`\n`,
		);
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

describe("the similar-title list", () => {
	it("--check prints at most three open issues, best first, and files nothing", () => {
		serveIssues(TRACKER);
		const r = run(["--check", "Generate a sitemap and robots file"]);
		expect(r.status).toBe(0);
		expect(listed(r.stdout)).toEqual([1, 5, 6]);
		expect(readGhCalls()).toHaveLength(1);
		expect(readGhCalls()[0]).toContain("--repo acme/widgets --state all");
	});

	it("--check exits 1 when the issues cannot be listed, naming the repository", () => {
		fs.writeFileSync(at("list-fails"), "");
		const r = run(["--check", "Anything"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not list acme/widgets's issues");
	});
});
