// @vitest-environment node
/*
 * The landing queue's one open issue per condition: filed urgent and bug, and
 * a label taken off put back on refresh (#2694, ruled at #2672).
 *
 * Loosen it and a held or stalled queue's issue ranks with ordinary work.
 */
import { expect, it } from "vitest";
import { queueIssueFiler } from "./queue-issue.js";

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
		openIssue: () => (labels === null ? null : { number: 7, labels }),
		similar: () => [],
		fileIssue: (args) => {
			filed.push(args);
			return { status: 0, stdout: "Filed #7.\n", stderr: "" };
		},
		refresh: () => "Refreshed #7.",
		addLabels,
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
