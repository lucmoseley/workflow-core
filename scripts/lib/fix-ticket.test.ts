// @vitest-environment node
/*
 * The lander's fix ticket (#2404, spec #2261), filed through fake
 * file-issue.js and gh calls.
 *
 * Loosen it and a reverted commit's work can go unrecorded, land under a
 * closed ticket no map offers, or be filed twice.
 */
import { describe, expect, it } from "vitest";
import { ticketFiler } from "./fix-ticket.js";

const C = "c".repeat(40);
const P = "b".repeat(40);
const R = "e".repeat(40);
const TICKET = { culprit: C, parent: P, revert: R, files: ["x.test.ts"] };

/**
 * A filer over `message`, an issue tracker whose issues are in `states`,
 * `listed` as the open issues resembling the title, and file-issue refusing
 * a parent where `refuseParent` is set.
 */
function filer(
	message: string,
	{
		states = {} as Record<number, "open" | "closed">,
		listed = [] as { number: number; title: string }[],
		refuseParent = "",
	} = {},
) {
	const files: { args: string[]; input: string }[] = [];
	const reopened: number[] = [];
	const tracker = ticketFiler({
		messageOf: () => message,
		similar: () => listed,
		fileIssue: (args, input) => {
			files.push({ args, input });
			if (refuseParent && args.includes("--parent"))
				return {
					status: 2,
					stdout: "",
					stderr: `file-issue: ${refuseParent}\n`,
				};
			return { status: 0, stdout: "Filed #9: https://x/9\n", stderr: "" };
		},
		stateOf: (n) => {
			const state = states[n];
			if (!state) throw new Error(`no issue #${n}`);
			return state;
		},
		reopen: (n) => {
			reopened.push(n);
		},
	});
	return { said: () => tracker.fileFixTicket(TICKET), files, reopened };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("ticketFiler", () => {
	it("files a takes:implement sub-issue of the ticket the subject cites, naming the revert and the failing files", () => {
		const f = filer("Add the widget (#12)\n\nAs #40 ruled.", {
			states: { 12: "open", 40: "open" },
		});
		expect(f.said()).toBe("Filed #9: https://x/9");
		const [{ args, input }] = f.files;
		expect(flag(args, "--parent")).toBe("12");
		expect(args).toEqual(
			expect.arrayContaining(["takes:implement", "kind:ticket"]),
		);
		expect(input).toContain(`reverted it in ${R}`);
		expect(input).toContain("- `x.test.ts`");
		expect(input).toContain("Reverted commit: `Add the widget (#12)`");
		expect(f.reopened).toEqual([]);
	});

	it("reopens a closed cited ticket before filing under it", () => {
		const f = filer("Add the widget (#12)", { states: { 12: "closed" } });
		f.said();
		expect(f.reopened).toEqual([12]);
		expect(flag(f.files[0].args, "--parent")).toBe("12");
	});

	it.each([
		["cites nothing", "Add the widget"],
		["cites a ticket only in its body", "Add the widget\n\nAs #40 ruled."],
		["cites another repo's ticket", "Add the widget (mantahostels#3)"],
	])(
		"files standalone, reopening nothing, where the subject %s",
		(_, message) => {
			const f = filer(message, { states: { 40: "closed" } });
			f.said();
			expect(f.files).toHaveLength(1);
			expect(f.reopened).toEqual([]);
			expect(flag(f.files[0].args, "--standalone")).toBe(
				"ccccccccc's subject cites no ticket of this repo.",
			);
		},
	);

	it("files standalone, naming the refusal, where file-issue refuses it under the cited ticket", () => {
		const f = filer("Add the widget (#12)", {
			states: { 12: "open" },
			refuseParent: "#12 is a wayfinder map's child",
		});
		f.said();
		expect(f.files.map((c) => c.args.includes("--parent"))).toEqual([
			true,
			false,
		]);
		expect(flag(f.files[1].args, "--standalone")).toBe(
			"file-issue refused it under #12, which ccccccccc cites: file-issue: #12 is a wayfinder map's child",
		);
	});

	it("files standalone where the cited ticket cannot be read", () => {
		const f = filer("Add the widget (#12)");
		f.said();
		expect(flag(f.files[0].args, "--standalone")).toBe(
			"#12, which ccccccccc cites, could not be read or reopened: no issue #12",
		);
	});

	it("files nothing where a listed open ticket already names the culprit", () => {
		const f = filer("Add the widget", {
			listed: [
				{
					number: 5,
					title: "Re-land ccccccccc, reverted by the lander: Add the widget",
				},
			],
		});
		expect(f.said()).toBe("fix ticket already open: #5");
		expect(f.files).toEqual([]);
	});

	it("names every other listed title distinct", () => {
		const f = filer("Add the widget", {
			listed: [
				{ number: 5, title: "Add the widget" },
				{ number: 6, title: "Widget fixes" },
			],
		});
		f.said();
		expect(flag(f.files[0].args, "--distinct-from")).toBe("5,6");
	});

	it("throws, naming the culprit, where even the standalone filing fails", () => {
		const tracker = ticketFiler({
			messageOf: () => "Add the widget",
			similar: () => [],
			fileIssue: () => ({
				status: 1,
				stdout: "",
				stderr: "gh issue create failed\n",
			}),
			stateOf: () => "open",
			reopen: () => undefined,
		});
		expect(() => tracker.fileFixTicket(TICKET)).toThrow(
			"fix ticket for ccccccccc not filed: gh issue create failed",
		);
	});
});
