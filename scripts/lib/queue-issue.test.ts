// @vitest-environment node
/*
 * The landing queue's one open issue per condition: filed urgent and bug, a
 * label taken off put back on refresh (#2694, ruled at #2672), and a gate a
 * session wrote kept through the refresh (#3636).
 *
 * Loosen it and a held or stalled queue's issue ranks with ordinary work, or
 * loses the gate that would close it.
 */
import { expect, it } from "vitest";
import { queueIssueCloser, queueIssueFiler } from "./queue-issue.js";

const LABELS = ["urgent", "bug", "takes:implement", "kind:ticket"];
const ISSUE = {
	title: "Queue held",
	standalone: "It tracks the queue.",
	noun: "queue issue",
	subject: "the queue",
};

const filer = (
	labels: string[] | null,
	addLabels: (n: number, l: string[]) => void,
) => {
	const filed: string[][] = [];
	const file = queueIssueFiler({
		openIssue: () =>
			labels === null ? null : { number: 7, labels, body: "body" },
		similar: () => [],
		fileIssue: (args) => {
			filed.push(args);
			return { status: 0, stdout: "Filed #7.\n", stderr: "" };
		},
		refresh: () => "Refreshed #7.",
		addLabels,
		close: () => undefined,
	});
	return { line: file(ISSUE, "body"), filed };
};

it("files the issue urgent and bug", () => {
	const { filed } = filer(null, () => undefined);

	const args = filed[0];
	expect(
		args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : [])),
	).toEqual(LABELS);
});

it("adds no label on a refresh that finds them all", () => {
	const added: string[][] = [];

	const { line } = filer(LABELS, (_, l) => added.push(l));

	expect(line).toBe("queue issue: Refreshed #7.");
	expect(added).toEqual([]);
});

it("puts back the labels taken off since filing", () => {
	const added: string[][] = [];

	const { line } = filer(["takes:implement", "kind:ticket"], (_, l) =>
		added.push(l),
	);

	expect(added).toEqual([["urgent", "bug"]]);
	expect(line).toBe("queue issue: Refreshed #7. Re-added urgent, bug.");
});

it("reports a failed re-add on the refresh line rather than throwing, naming gh's reason", () => {
	const { line } = filer(["bug"], () => {
		throw Object.assign(new Error("Command failed: gh issue edit"), {
			stderr: "HTTP 403: label urgent not permitted\n",
		});
	});

	expect(line).toMatch(
		/^queue issue: Refreshed #7\. Could not re-add urgent, takes:implement, kind:ticket: .*403/,
	);
});

it("keeps a gate a session wrote on the body through a refresh (#3636)", () => {
	const gate =
		"**Gated on:** b9f96e964 is on main — check: git merge-base --is-ancestor b9f96e964 origin/main && echo on — abandon if: it is reverted";
	const refreshed: string[] = [];
	const file = queueIssueFiler({
		openIssue: () => ({
			number: 7,
			labels: LABELS,
			body: `old body\n\n${gate}\n`,
		}),
		similar: () => [],
		fileIssue: () => ({ status: 0, stdout: "", stderr: "" }),
		refresh: (_, body) => {
			refreshed.push(body);
			return "Refreshed #7.";
		},
		addLabels: () => undefined,
		close: () => undefined,
	});

	file(ISSUE, "new body");

	expect(refreshed[0]).toContain("new body");
	expect(refreshed[0]).not.toContain("old body");
	expect(refreshed[0]).toContain(gate);
});

it("closes the open issue with the comment its body earns, and none where the body earns none (#3636)", () => {
	const closed: [number, string][] = [];
	const close = queueIssueCloser({
		openIssue: () => ({ number: 7, labels: LABELS, body: "ready" }),
		close: (n, c) => {
			closed.push([n, c]);
		},
	});

	expect(close(ISSUE.title, (b) => (b === "ready" ? "done" : null))).toBe(7);
	expect(close(ISSUE.title, () => null)).toBeNull();
	expect(closed).toEqual([[7, "done"]]);
});
