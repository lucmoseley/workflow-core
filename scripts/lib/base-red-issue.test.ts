// @vitest-environment node
/*
 * The queue lander's one base-red ticket.
 *
 * Loosen it and each red base files a second ticket, or the ticket stops
 * naming the `main` sha and files that are red there.
 */
import { expect, it } from "vitest";
import { baseRedFiler } from "./base-red-issue.js";

const M = "f".repeat(40);

const filer = (
	deps: Partial<Parameters<typeof baseRedFiler>[0]>,
): ReturnType<typeof baseRedFiler> =>
	baseRedFiler({
		openIssue: () => null,
		similar: () => [],
		fileIssue: () => ({ status: 0, stdout: "Filed #9\n", stderr: "" }),
		refresh: () => "refreshed #9.",
		addLabels: () => undefined,
		close: () => undefined,
		...deps,
	});

it("files the ticket where none is open for the refill loop to take, naming main's sha and each file red there", () => {
	const filed: { args: string[]; body: string }[] = [];

	const line = filer({
		fileIssue: (argv, input) => {
			filed.push({ args: argv, body: input });
			return { status: 0, stdout: "Filed #9\n", stderr: "" };
		},
	}).fileBaseRed(M, ["scripts/x.test.ts", "scripts/y.test.ts"]);

	expect(line).toBe("Filed #9");
	const [{ args, body }] = filed;
	expect(args).toEqual(
		expect.arrayContaining(["urgent", "bug", "takes:implement"]),
	);
	expect(body).toContain(`- Main: \`${M}\``);
	expect(body).toContain("- `scripts/x.test.ts`\n- `scripts/y.test.ts`");
});

it("refreshes the open ticket in place of filing a second", () => {
	const refreshed: string[] = [];
	let filings = 0;

	const line = filer({
		openIssue: () => ({ number: 9, labels: ["urgent", "bug"], body: "" }),
		refresh: (_, body) => {
			refreshed.push(body);
			return "refreshed #9.";
		},
		fileIssue: () => {
			filings++;
			return { status: 0, stdout: "", stderr: "" };
		},
	}).fileBaseRed(M, ["scripts/x.test.ts"]);

	expect(filings).toBe(0);
	expect(line).toMatch(/^base-red ticket: refreshed #9\./);
	expect(refreshed[0]).toContain("- `scripts/x.test.ts`");
});

it("names the whole suite where main's red named no file", () => {
	const filed: string[] = [];

	filer({
		fileIssue: (_, input) => {
			filed.push(input);
			return { status: 0, stdout: "Filed #9\n", stderr: "" };
		},
	}).fileBaseRed(M, []);

	expect(filed[0]).toContain("found the whole suite, naming no file, failing");
	expect(filed[0]).not.toContain("Failing:");
	expect(filed[0]).toContain("- [ ] The whole suite passes on `main`.");
});
