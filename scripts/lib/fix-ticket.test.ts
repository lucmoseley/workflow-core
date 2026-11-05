// @vitest-environment node
/*
 * The landers' fix tickets (#2404, spec #2261; #4485, spec #4458), filed
 * through fake file-issue.js and gh calls.
 *
 * Loosen it and a reverted commit's or dropped queue ref's work can go
 * unrecorded, land under a closed ticket no map offers, or be filed twice.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { dropTicketFiler, ticketFiler } from "./fix-ticket.js";
import type { FixTicket } from "./lander.js";
import type { Drop } from "./queue-lander.js";

// Required, not imported: an ESM import of filing-refused.js would load a
// second copy of FilingRefusedError, which fix-ticket.js's throw is not.
const { FilingRefusedError } = createRequire(__filename)("./filing-refused.js");

const C = "c".repeat(40);
const P = "b".repeat(40);
const R = "e".repeat(40);
const TICKET = {
	culprit: C,
	parent: P,
	revert: R,
	files: ["x.test.ts"],
	jobs: [] as string[],
	stale: [] as { row: string; forward: string }[] | null,
};

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
	return {
		said: (over: Partial<FixTicket> = {}) =>
			tracker.fileFixTicket({ ...TICKET, ...over }),
		files,
		reopened,
	};
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

	it("files the culprit's fix ticket past an open re-land ticket of a dependent reverted with it, whose title names its sha too, and names that ticket (#4453)", () => {
		const D = "d".repeat(40);
		const f = filer("Add the widget (#12)", {
			states: { 12: "open" },
			listed: [
				{
					number: 7,
					title: `Re-land ${D.slice(0, 9)}, reverted with ${C.slice(0, 9)} by the lander: x`,
				},
			],
		});
		const said = f.said({
			dependents: [{ commit: D, revert: R, files: ["shared.txt"] }],
		});
		expect(said).toBe("re-land ticket already open: #7\nFiled #9: https://x/9");
		const [{ input }] = f.files;
		expect(input).toContain(`- ${D.slice(0, 9)}, reverted in ${R}: #7`);
	});

	it("names the failing CI jobs where the tester named no failing file (#3253)", () => {
		const bodies: string[] = [];
		ticketFiler({
			messageOf: () => "Add the widget",
			similar: () => [],
			fileIssue: (_args, input) => {
				bodies.push(input);
				return { status: 0, stdout: "Filed #9: https://x/9\n", stderr: "" };
			},
			stateOf: () => "open",
			reopen: () => undefined,
		}).fileFixTicket({
			...TICKET,
			files: [],
			jobs: ["Full suite / Lint and types"],
		});
		expect(bodies[0]).toContain(
			"- CI job `Full suite / Lint and types` (the tester named no failing file)",
		);
		expect(bodies[0]).not.toContain("the whole suite");
	});

	it("names each failing test and its message where the tester named them (#3937)", () => {
		const f = filer("Add the widget");
		f.said({
			files: ["a.test.ts", "b.test.ts"],
			failures: [{ file: "a.test.ts", test: "s > t", message: "boom `x`" }],
		});
		expect(f.files[0]?.input).toContain(
			"- `a.test.ts > s > t`: `boom 'x'`\n- `b.test.ts`",
		);
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
		expect(f.said()).toBe("re-land ticket already open: #5");
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

	it("names each row the revert left stale with its --review line, and owes the re-read", () => {
		const bodies: string[] = [];
		const tracker = ticketFiler({
			messageOf: () => "Add the widget",
			similar: () => [],
			fileIssue: (_args, input) => {
				bodies.push(input);
				return { status: 0, stdout: "Filed #9: https://x/9\n", stderr: "" };
			},
			stateOf: () => "open",
			reopen: () => undefined,
		});
		const review = "node scripts/check-guard-registry.js --review scripts/g.js";
		tracker.fileFixTicket({
			...TICKET,
			stale: [{ row: "STALE-PROSE scripts/g.js", forward: review }],
		});
		expect(bodies[0]).toContain(
			`- \`STALE-PROSE scripts/g.js\`: \`${review}\``,
		);
		expect(bodies[0]).toContain(
			"- [ ] Each stale row above is re-read and re-anchored.",
		);
	});

	it("says the stale rows could not be read where the lander could not read them, and still owes the re-read", () => {
		const bodies: string[] = [];
		ticketFiler({
			messageOf: () => "Add the widget",
			similar: () => [],
			fileIssue: (_args, input) => {
				bodies.push(input);
				return { status: 0, stdout: "Filed #9: https://x/9\n", stderr: "" };
			},
			stateOf: () => "open",
			reopen: () => undefined,
		}).fileFixTicket({ ...TICKET, stale: null });
		expect(bodies[0]).toContain(
			`could not read which guard-registry rows the revert left stale (#3127). Run \`node scripts/check-guard-registry.js --touched-by ${R}\``,
		);
		expect(bodies[0]).toContain(
			"- [ ] Each stale row above is re-read and re-anchored.",
		);
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
			"re-land ticket for ccccccccc not filed: gh issue create failed",
		);
	});
});

const A = "a".repeat(40);
const M = "f".repeat(40);
const DROP: Drop = {
	name: "wt-1",
	sha: A,
	ref: "dropped/wt-1",
	onto: M,
	cause: { kind: "conflict", name: "wt-1", files: ["x.js", "y.js"] },
	ticket: null,
};

describe("dropTicketFiler", () => {
	/**
	 * A filer over the member's commit `subjects`, newest first, with `units`
	 * the open tickets under each parent, and file-issue exiting `status`.
	 */
	function dropFiler(
		subjects: string[],
		states: Record<number, "open" | "closed"> = {},
		listed: { number: number; title: string }[] = [],
		{ units = {} as Record<string, number[]>, status = 0 } = {},
	) {
		const files: { args: string[]; input: string }[] = [];
		const ranges: string[] = [];
		const tracker = dropTicketFiler({
			subjectsOf: (base, tip) => {
				ranges.push(`${base}..${tip}`);
				return subjects;
			},
			openUnits: (parent) => units[String(parent)] ?? [],
			similar: () => listed,
			fileIssue: (args, input) => {
				files.push({ args, input });
				return status === 0
					? { status, stdout: "Filed #9: https://x/9\n", stderr: "" }
					: { status, stdout: "", stderr: "file-issue: rule:x refused it\n" };
			},
			stateOf: (n) => {
				const state = states[n];
				if (!state) throw new Error(`no issue #${n}`);
				return state;
			},
			reopen: () => undefined,
		});
		return {
			said: (d: Partial<Drop> = {}) =>
				tracker.fileDropTicket({ ...DROP, ...d }),
			files,
			ranges,
		};
	}

	it("files an unassigned takes:implement sub-issue of the ticket the newest citing commit cites, naming the ref, sha, dropped ref and conflicted files", () => {
		const f = dropFiler(["Tidy", "Add the widget (#12)", "Start (#40)"], {
			12: "open",
		});

		expect(f.said()).toBe("Filed #9: https://x/9");

		const [{ args, input }] = f.files;
		expect(f.ranges).toEqual([`${M}..${A}`]);
		expect(flag(args, "--parent")).toBe("12");
		expect(flag(args, "--title")).toBe(
			"Fix queue/wt-1 at aaaaaaaaa, dropped by the queue lander: Tidy",
		);
		expect(args).toEqual(
			expect.arrayContaining(["takes:implement", "kind:ticket"]),
		);
		expect(args).not.toContain("--assign-self");
		expect(input).toContain(`\`queue/wt-1\` at ${A}`);
		expect(input).toContain(`onto \`main\` at ${M}`);
		expect(input).toContain("- `x.js`\n- `y.js`");
		expect(input).toContain("`dropped/wt-1`");
	});

	it("files standalone where no commit cites a ticket, naming a merge's refusal as its evidence", () => {
		const f = dropFiler(["Tidy"]);

		f.said({ cause: { kind: "refused", name: "wt-1", reason: "rule:x" } });

		const [{ args, input }] = f.files;
		expect(flag(args, "--standalone")).toBe(
			"No commit on queue/wt-1 cites a ticket of this repo.",
		);
		expect(input).toContain("its merge was refused: `rule:x`");
	});

	it("files nothing where a listed open ticket already names the ref at its sha", () => {
		const f = dropFiler(["Tidy"], {}, [
			{
				number: 5,
				title: "Fix queue/wt-1 at aaaaaaaaa, dropped by the queue lander: Tidy",
			},
		]);

		expect(f.said()).toBe("fix ticket already open: #5");
		expect(f.files).toEqual([]);
	});

	it("names each open ticket under its placement checked past rule:size-line, as each drop is its own fix", () => {
		const f = dropFiler(["Add the widget (#12)"], { 12: "open" }, [], {
			units: { 12: [13, 14], null: [20] },
		});
		const g = dropFiler(["Tidy"], {}, [], { units: { null: [20] } });

		f.said();
		g.said();

		expect(flag(f.files[0].args, "--size-line-checked")).toBe("13,14");
		expect(flag(g.files[0].args, "--size-line-checked")).toBe("20");
	});

	it("throws a FilingRefusedError where file-issue refuses it standalone too, exiting 2", () => {
		const f = dropFiler(["Add the widget (#12)"], { 12: "open" }, [], {
			status: 2,
		});

		expect(() => f.said()).toThrow(FilingRefusedError);
		expect(f.files.map((r) => r.args.includes("--standalone"))).toEqual([
			false,
			true,
		]);
	});

	it("throws a plain error, for the next run to file again, where file-issue exits 1", () => {
		const f = dropFiler(["Tidy"], {}, [], { status: 1 });

		expect(() => f.said()).toThrow(
			"fix ticket for a commit on queue/wt-1 not filed: file-issue: rule:x refused it",
		);
		expect(() => f.said()).not.toThrow(FilingRefusedError);
	});

	it("throws, filing nothing, where the member has no commit off main", () => {
		const f = dropFiler([]);

		expect(() => f.said()).toThrow(
			"queue/wt-1 at aaaaaaaaa has no commit off fffffffff",
		);
		expect(f.files).toEqual([]);
	});
});
