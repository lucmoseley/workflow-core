// @vitest-environment node
/*
 * lib/issue-link-write.js, the guard-issue-link core (#5086), in process: it
 * refuses a raw `gh api` blocker or sub-issue link write, REST or GraphQL,
 * and names the link command that checks the link closes no loop. Every
 * allow case is a shape a session needs — a read, a removal, the priority
 * PATCH, the link commands themselves — so do not thin them out.
 *
 * Loosen a deny case and a session can close a loop of open issues that can
 * never close, as on 12 Nov 2026 (#5055); lose an allow case and reading or
 * breaking a loop is wedged. The dispatcher run, failure policy and worktree
 * case go through the testkit at the foot.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	latchesAt,
	runCore,
	splitCheckout,
	toolCall,
} from "./guard-core-testkit";
import { kitContextFake } from "./kit-context-fake";

type Decision = { deny: string } | { injectRules: string[]; prelude: string };
const { decide } = require("./issue-link-write.js") as {
	decide: (command: string, ctx: object) => Decision | null;
};
const ports = () =>
	kitContextFake({
		fallbackCwd: "/",
		isDir: (p: string) =>
			fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
	});

/** The refusal's text, or "allow". */
const said = (command: string) => {
	const d = decide(command, ports());
	if (!d) return "allow";
	if (!("deny" in d)) throw new Error(`warned: ${d.prelude}`);
	return d.deny;
};

const WHY =
	"A raw link write skips the loop check: the link commands walk every open blocker and sub-issue, in any repo, and refuse a link that would close a loop of issues that can never close (#5055).";
const BLOCKER_FORM = (blocked: string) =>
	`node scripts/link-blocker.js ${blocked} <blocker> — each issue as a bare number or owner/name#n, never a database id; it resolves the id and verifies the edge in a separate read`;

describe("a raw blocker link write is refused, naming the blocker link command", () => {
	it.each([
		[
			"gh api --method POST repos/{owner}/{repo}/issues/12/dependencies/blocked_by -F issue_id=99",
			"12",
		],
		[
			"gh api -X POST repos/o/r/issues/12/dependencies/blocked_by -F issue_id=99",
			"o/r#12",
		],
		[
			"gh api repos/o/r/issues/12/dependencies/blocked_by -F issue_id=99",
			"o/r#12",
		],
		[
			"gh api /repos/o/r/issues/12/dependencies/blocked_by --input edge.json",
			"o/r#12",
		],
		[
			'gh api "https://api.github.com/repos/o/r/issues/12/dependencies/blocked_by" -f issue_id=99',
			"o/r#12",
		],
		[
			"cd /x && gh api --method=post repos/o/r/issues/12/dependencies/blocked_by -F issue_id=99",
			"o/r#12",
		],
	])("%s", (command, blocked) => {
		const text = said(command);
		expect(text).toBe(
			`This POSTs a blocker link by raw gh api: ${text.split(": ")[1]?.split("\n")[0]}\n\n${WHY}\nMake it with ${BLOCKER_FORM(blocked)}.`,
		);
		expect(text).toContain(`node scripts/link-blocker.js ${blocked} <blocker>`);
	});
});

describe("a raw sub-issue link write is refused, naming the sub-issue link command", () => {
	it("gives the plain form for a plain link", () => {
		expect(
			said(
				"gh api --method POST repos/{owner}/{repo}/issues/40/sub_issues -F sub_issue_id=987",
			),
		).toBe(
			`This POSTs a sub-issue link by raw gh api: gh api --method POST repos/{owner}/{repo}/issues/40/sub_issues -F sub_issue_id=987\n\n${WHY}\nMake it with scripts/link-sub-issue.sh 40 <child> — the child's bare number, never its database id; add --replace-parent to move a child that already has a parent.`,
		);
	});

	it("carries --replace-parent where the raw call re-roots, and names the repo it links in", () => {
		const text = said(
			"gh api repos/o/r/issues/40/sub_issues -F sub_issue_id=987 -F replace_parent=true",
		);
		expect(text).toContain(
			"Make it with WFC_LINK_REPO=o/r scripts/link-sub-issue.sh 40 <child> --replace-parent — ",
		);
	});
});

describe("a GraphQL link mutation is refused", () => {
	it.each([
		["addSubIssue", "scripts/link-sub-issue.sh <parent> <child>"],
		["addBlockedBy", "node scripts/link-blocker.js <blocked> <blocker>"],
	])("%s", (mutation, form) => {
		const text = said(
			`gh api graphql -f query='mutation { ${mutation}(input: {issueId: "I_1", subIssueId: "I_2"}) { clientMutationId } }'`,
		);
		expect(text).toContain(`This adds a link through GraphQL's ${mutation}`);
		expect(text).toContain(`Make it with ${form}`);
	});
});

describe("gh's own issue link flags are refused", () => {
	it.each([
		[
			"gh issue edit 12 --add-blocked-by 99",
			"gh issue edit --add-blocked-by",
			"node scripts/link-blocker.js 12 <blocker>",
		],
		[
			"gh issue edit 12 --add-blocking=99",
			"gh issue edit --add-blocking",
			"node scripts/link-blocker.js <blocked> 12",
		],
		[
			"gh issue edit 40 --add-sub-issue 63,64",
			"gh issue edit --add-sub-issue",
			"scripts/link-sub-issue.sh 40 <child>",
		],
		[
			"gh issue edit 63 --parent 40",
			"gh issue edit --parent",
			"scripts/link-sub-issue.sh <parent> 63 --replace-parent",
		],
		[
			"gh issue create --title t --body-file - --parent 40",
			"gh issue create --parent",
			"node scripts/file-issue.js --parent <parent>",
		],
		[
			"gh issue create --title t --body-file - --blocked-by 7",
			"gh issue create --blocked-by",
			"node scripts/file-issue.js …, then node scripts/link-blocker.js <new> <blocker>",
		],
	])("%s", (command, lead, form) => {
		const text = said(command);
		expect(text).toContain(`This makes a link through ${lead}: ${command}`);
		expect(text).toContain(WHY);
		expect(text).toContain(`Make it with ${form}`);
	});
});

describe("reads, removals and the link commands pass", () => {
	it.each([
		["gh api repos/o/r/issues/12/dependencies/blocked_by", "a GET"],
		[
			"gh api repos/o/r/issues/12/dependencies/blocked_by --paginate --jq '.[].number'",
			"a paginated GET",
		],
		[
			"gh api -X GET repos/o/r/issues/40/sub_issues -f per_page=100",
			"a GET carrying fields",
		],
		[
			"gh api --method DELETE repos/o/r/issues/12/dependencies/blocked_by/99",
			"a blocker removal",
		],
		[
			"gh api --method DELETE repos/o/r/issues/40/sub_issue -F sub_issue_id=987",
			"a sub-issue removal",
		],
		[
			"gh api --method PATCH repos/o/r/issues/40/sub_issues/priority -F sub_issue_id=987 -F after_id=5",
			"the priority PATCH",
		],
		[
			"gh api repos/o/r/issues/40 --jq '.url + \"/sub_issues\"' -f x=1 -X GET",
			"an endpoint named only inside --jq",
		],
		[
			"gh api repos/o/r/issues/40 -X PATCH -f state=closed --jq 'repos/o/r/issues/40/sub_issues'",
			"a PATCH elsewhere, the endpoint text only in --jq",
		],
		["gh issue edit 12 --remove-blocked-by 99", "gh's own blocker removal"],
		["gh issue edit 63 --remove-parent", "gh's own parent removal"],
		["gh issue edit 12 --add-label kind:ticket", "a field-only edit"],
		["node scripts/link-blocker.js 12 o/r#99", "the blocker link command"],
		[
			"scripts/link-sub-issue.sh 40 63 --replace-parent",
			"the sub-issue link command",
		],
		[
			'gh api graphql -f query=\'mutation { removeSubIssue(input: {issueId: "I_1", subIssueId: "I_2"}) { clientMutationId } }\'',
			"a GraphQL removal",
		],
		[
			'gh api graphql -f query=\'{ repository(owner: "o", name: "r") { issue(number: 1) { subIssues(first: 5) { nodes { number } } } } }\'',
			"a GraphQL read",
		],
		[
			"echo 'gh api --method POST repos/o/r/issues/1/sub_issues -F sub_issue_id=2'",
			"a mention inside a quoted string",
		],
	])("%s — %s", (command) => {
		expect(said(command)).toBe("allow");
	});
});

describe("through the dispatcher (#5086)", () => {
	let at: { main: string; worktree: string };
	freshSandbox((sb) => {
		at = splitCheckout(path.join(sb.dir, "split"));
	});

	it("refuses the raw link write from a session's own worktree, latching nothing", () => {
		const out = runCore(
			"guard-issue-link",
			toolCall("Bash", {
				command:
					"gh api --method POST repos/o/r/issues/12/dependencies/blocked_by -F issue_id=99",
			}),
			{ root: at.main, worktree: at.worktree },
		).output;
		expect(out?.permissionDecision).toBe("deny");
		expect(out?.permissionDecisionReason).toContain(
			"scripts/link-blocker.js o/r#12 <blocker>",
		);
		expect(latchesAt(at.main)).toEqual([]);
		expect(latchesAt(at.worktree)).toEqual([]);
	});

	it("fails closed on a throw of its own", () => {
		const out = runCore(
			"guard-issue-link",
			toolCall("Bash", { command: "gh api repos/o/r/issues/12" }),
			{ root: at.main, worktree: at.worktree, throwing: "boom" },
		).output;
		expect(out?.permissionDecision).toBe("deny");
	});
});
