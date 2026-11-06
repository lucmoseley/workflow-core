// @vitest-environment node
/*
 * The queue lander's fix tickets (#4485, spec #4458), filed through fake
 * file-issue.js and gh calls.
 *
 * Loosen it and a dropped queue ref's work can go unrecorded, land under a
 * closed ticket no map offers, or be filed twice.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { dropTicketFiler } from "./fix-ticket.js";
import type { Drop } from "./queue-lander.js";

// Required, not imported: an ESM import of filing-refused.js would load a
// second copy of FilingRefusedError, which fix-ticket.js's throw is not.
const { FilingRefusedError } = createRequire(__filename)("./filing-refused.js");

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

const A = "a".repeat(40);
const M = "f".repeat(40);
const DROP: Drop = {
	name: "wt-1",
	sha: A,
	ref: "dropped/wt-1",
	onto: M,
	cause: { kind: "conflict", name: "wt-1", files: ["x.js", "y.js"] },
	ticket: null,
	at: 0,
};

describe("dropTicketFiler", () => {
	/**
	 * A filer over the member's commit `subjects`, newest first, with `units`
	 * the open tickets under each parent, and file-issue exiting `status`, or
	 * refusing only a `--parent` filing with `refuseParent`.
	 */
	function dropFiler(
		subjects: string[],
		states: Record<number, "open" | "closed"> = {},
		listed: { number: number; title: string }[] = [],
		{
			units = {} as Record<string, number[]>,
			status = 0,
			refuseParent = null as string | null,
		} = {},
	) {
		const files: { args: string[]; input: string }[] = [];
		const ranges: string[] = [];
		const reopened: number[] = [];
		const tracker = dropTicketFiler({
			subjectsOf: (base, tip) => {
				ranges.push(`${base}..${tip}`);
				return subjects;
			},
			openUnits: (parent) => units[String(parent)] ?? [],
			similar: () => listed,
			readTicketsTitled: (prefix) =>
				new Map(
					listed
						.filter((c) => c.title.startsWith(prefix))
						.map((c) => [c.title, c.number]),
				),
			fileIssue: (args, input) => {
				files.push({ args, input });
				if (refuseParent !== null && args.includes("--parent"))
					return {
						status: 2,
						stdout: "",
						stderr: `file-issue: ${refuseParent}\n`,
					};
				return status === 0
					? { status, stdout: "Filed #9: https://x/9\n", stderr: "" }
					: { status, stdout: "", stderr: "file-issue: rule:x refused it\n" };
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
			said: (d: Partial<Drop> = {}) =>
				tracker.fileDropTicket({ ...DROP, ...d }),
			found: () => tracker.findDropTicket(DROP.name, DROP.sha),
			files,
			ranges,
			reopened,
		};
	}

	it("finds the lowest-numbered ticket whose title starts with the drop's prefix, and none where only a near title does", () => {
		const titled = (number: number, title: string) => ({ number, title });
		const near = [
			titled(5, "Fix queue/wt-10 at aaaaaaaaa, dropped by the queue lander: x"),
			titled(6, "Fix queue/wt-1 at bbbbbbbbb, dropped by the queue lander: x"),
		];

		expect(dropFiler([], {}, near).found()).toBeNull();
		expect(
			dropFiler([], {}, [
				...near,
				titled(
					8,
					"Fix queue/wt-1 at aaaaaaaaa, dropped by the queue lander: y",
				),
				titled(
					7,
					"Fix queue/wt-1 at aaaaaaaaa, dropped by the queue lander: x",
				),
			]).found(),
		).toBe(7);
	});

	it("files an unrecorded drop's ticket saying why is unknown", () => {
		const f = dropFiler(["Add the widget"]);

		f.said({ cause: { kind: "unrecorded", name: "wt-1" } });

		expect(f.files[0].input).toContain(
			`why is unknown, as the lander's drop record lost its entry; its commits are read off \`main\` at ${M}`,
		);
		expect(f.files[0].input).toContain(
			"aaaaaaaaa's change merges onto `main`, passes the whole suite there, and is pushed to `queue/wt-1` again.",
		);
	});

	it("reopens a closed cited ticket before filing under it", () => {
		const f = dropFiler(["Add the widget (#12)"], { 12: "closed" });

		f.said();

		expect(f.reopened).toEqual([12]);
		expect(flag(f.files[0].args, "--parent")).toBe("12");
	});

	it("files standalone, naming the refusal, where file-issue refuses it under the cited ticket", () => {
		const f = dropFiler(["Add the widget (#12)"], { 12: "open" }, [], {
			refuseParent: "#12 is a wayfinder map's child",
		});

		expect(f.said()).toBe("Filed #9: https://x/9");

		expect(f.files.map((c) => c.args.includes("--parent"))).toEqual([
			true,
			false,
		]);
		expect(flag(f.files[1].args, "--standalone")).toBe(
			"file-issue refused it under #12, which a commit on queue/wt-1 cites: file-issue: #12 is a wayfinder map's child",
		);
	});

	it("files standalone where the cited ticket cannot be read", () => {
		const f = dropFiler(["Add the widget (#12)"]);

		f.said();

		expect(flag(f.files[0].args, "--standalone")).toBe(
			"#12, which a commit on queue/wt-1 cites, could not be read or reopened: no issue #12",
		);
	});

	it("names every other listed title distinct", () => {
		const f = dropFiler(["Tidy"], {}, [
			{ number: 5, title: "Tidy" },
			{ number: 6, title: "Tidy fixes" },
		]);

		f.said();

		expect(flag(f.files[0].args, "--distinct-from")).toBe("5,6");
	});

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

	it("names a member red alone twice by its isolation commit, its failing files and their pass on main, or the whole suite where it named none", () => {
		const f = dropFiler(["Tidy"]);
		const iso = "c".repeat(40);

		f.said({
			cause: { kind: "red", name: "wt-1", files: ["x.test.ts"], iso },
		});
		f.said({ cause: { kind: "red", name: "wt-1", files: [], iso } });

		const [{ input }, unnamed] = f.files;
		expect(unnamed?.input).toContain(
			"failed the whole suite twice, naming no file, where `main` passes it",
		);
		expect(input).toContain(`onto \`main\` at ${M} as ${iso}`);
		expect(input).toContain("failed these files twice, which pass on `main`");
		expect(input).toContain("- `x.test.ts`");
		expect(input).toContain(
			"- [ ] aaaaaaaaa's change passes each file above merged onto `main`, and is pushed to `queue/wt-1` again.",
		);
	});

	it("names a collision's step, the members landed before it and its failing files, or the whole suite where it named none", () => {
		const f = dropFiler(["Tidy"]);
		const step = "d".repeat(40);
		const collision = {
			kind: "collision" as const,
			name: "wt-1",
			step,
			after: ["wt-0"],
		};

		f.said({ cause: { ...collision, files: ["x.test.ts"] } });
		f.said({ cause: { ...collision, files: [] } });

		const [named, unnamed] = f.files.map((x) => x.input);
		expect(named).toContain("each member of its batch passed alone");
		expect(named).toContain(`after \`queue/wt-0\` landed, as ${step}`);
		expect(named).toContain("- `x.test.ts`");
		expect(unnamed).toContain("failed the whole suite twice, naming no file");
		expect(unnamed).toContain(
			"- [ ] aaaaaaaaa's change passes the whole suite merged onto `main`, and is pushed to `queue/wt-1` again.",
		);
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
