// @vitest-environment node
/*
 * The queue lander's fix tickets (#4485, spec #4458; #4950, spec #4947),
 * filed, updated and closed through fake file-issue.js and gh calls.
 *
 * Loosen it and a dropped queue ref's work can go unrecorded, land under a
 * closed ticket no map offers, or be filed twice; a branch dropped again can
 * get a second ticket or leave its ticket naming an old drop, a closed cited
 * ticket can be reopened by an update, or a filing fault can read as a
 * loader's file path.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { dropTicketFiler } from "./fix-ticket.js";
import { parseGateRefusal } from "./lander-git.js";
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
	state: "open",
	decidedAt: 0,
};
const HELD = [{ ref: DROP.ref, sha: A }];

describe("dropTicketFiler", () => {
	/**
	 * A filer over the member's commit `subjects`, newest first, with `units`
	 * the open tickets under each parent, and file-issue exiting `status`, or
	 * refusing only a `--parent` filing with `refuseParent`.
	 */
	function dropFiler(
		subjects: string[],
		states: Record<number, "open" | "closed"> = {},
		listed: { number: number; title: string; body?: string }[] = [],
		{
			units = {} as Record<string, number[]>,
			status = 0,
			refuseParent = null as string | null,
			stderr = "file-issue: rule:x refused it\n",
			had = [] as { n: number; text: string }[],
		} = {},
	) {
		const files: { args: string[]; input: string }[] = [];
		const ranges: string[] = [];
		const reopened: number[] = [];
		const bodies: { n: number; body: string }[] = [];
		const comments: { n: number; text: string }[] = [];
		const closes: { n: number; comment: string }[] = [];
		const tracker = dropTicketFiler({
			subjectsOf: (base, tip) => {
				ranges.push(`${base}..${tip}`);
				return subjects;
			},
			openUnits: (parent) => units[String(parent)] ?? [],
			similar: () => listed,
			openTitled: (prefix) =>
				listed
					.filter((c) => c.title.startsWith(prefix))
					.map((c) => ({ body: "", ...c })),
			refresh: (n, body) => {
				bodies.push({ n, body });
			},
			comment: (n, text) => {
				comments.push({ n, text });
			},
			commented: (n, text) =>
				[...had, ...comments].some((c) => c.n === n && c.text.includes(text)),
			close: (n, comment) => {
				closes.push({ n, comment });
			},
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
					: { status, stdout: "", stderr };
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
			filed: (d: Partial<Drop> = {}, held = HELD) =>
				tracker.fileDropTicket({ ...DROP, ...d }, held),
			said: (d: Partial<Drop> = {}) =>
				tracker.fileDropTicket({ ...DROP, ...d }, HELD).line,
			found: () => tracker.findDropTicket(DROP.name),
			close: (n: number, main: string) =>
				tracker.closeDropTicket(n, DROP, main),
			files,
			ranges,
			reopened,
			refresh: (n: number, d: Partial<Drop>, held = HELD) =>
				tracker.refreshDropTicket(n, { ...DROP, ...d }, held),
			bodies,
			comments,
			closes,
		};
	}

	it("finds the lowest-numbered open ticket whose title starts with the branch's prefix, whatever sha it was filed at, and none where only a near name does", () => {
		const titled = (number: number, title: string) => ({ number, title });
		const near = [
			titled(5, "Fix queue/wt-10, dropped by the queue lander: x"),
			titled(6, "Fix queue/wt-1-b, dropped by the queue lander: x"),
		];

		expect(dropFiler([], {}, near).found()).toBeNull();
		expect(
			dropFiler([], {}, [
				...near,
				titled(8, "Fix queue/wt-1, dropped by the queue lander: y"),
				titled(7, "Fix queue/wt-1, dropped by the queue lander: x"),
			]).found(),
		).toBe(7);
	});

	it("updates the branch's open ticket in place on a further drop: its body replaced, one comment naming the new sha and cause, nothing filed or reopened", () => {
		const B = "b".repeat(40);
		const f = dropFiler(["Add the widget (#12)"], { 12: "closed" }, [
			{
				number: 5,
				title: "Fix queue/wt-1, dropped by the queue lander: Start",
				body: `dropped \`queue/wt-1\` at ${A}`,
			},
		]);

		const out = f.filed({ sha: B, ref: "dropped/wt-1-bbbbbbbbb" }, [
			{ ref: "dropped/wt-1-bbbbbbbbb", sha: B },
			{ ref: "dropped/wt-1", sha: A },
		]);

		expect(out).toEqual({
			number: 5,
			line: "fix ticket updated: #5 now names queue/wt-1 at bbbbbbbbb",
		});
		expect(f.files).toEqual([]);
		expect(f.reopened).toEqual([]);
		expect(f.bodies).toHaveLength(1);
		const [{ n, body }] = f.bodies;
		expect(n).toBe(5);
		expect(body).toContain(`\`queue/wt-1\` at ${B}`);
		expect(body).toContain(`onto \`main\` at ${M}`);
		expect(body).toContain("- `x.js`\n- `y.js`");
		expect(body).toContain(`- \`dropped/wt-1-bbbbbbbbb\` at ${B}, this drop`);
		expect(body).toContain(`- \`dropped/wt-1\` at ${A}\n`);
		expect(body).toContain("- [ ] bbbbbbbbb's change merges onto `main`");
		expect(f.comments).toEqual([
			{
				n: 5,
				text: `The queue lander dropped \`queue/wt-1\` again, at ${B}: it conflicts with \`main\`. This ticket's body now describes that drop.`,
			},
		]);
	});

	it("adds no second comment where an update cut short left its comment and the old body, and replaces the body", () => {
		const B = "b".repeat(40);
		const f = dropFiler(
			["Start"],
			{},
			[
				{
					number: 5,
					title: "Fix queue/wt-1, dropped by the queue lander: Start",
					body: `dropped \`queue/wt-1\` at ${A}`,
				},
			],
			{ had: [{ n: 5, text: `dropped again, at ${B}` }] },
		);

		f.filed({ sha: B });

		expect(f.comments).toEqual([]);
		expect(f.bodies.map((b) => b.n)).toEqual([5]);
		expect(f.bodies[0].body).toContain(`\`queue/wt-1\` at ${B}`);
	});

	it("refreshes a ticket's body to the drop and dropped refs its branch still holds, with no comment", () => {
		const B = "b".repeat(40);
		const f = dropFiler(["Start"]);

		f.refresh(5, { sha: B }, [{ ref: "dropped/wt-1-bbbbbbbbb", sha: B }]);

		expect(f.comments).toEqual([]);
		expect(f.bodies.map((b) => b.n)).toEqual([5]);
		expect(f.bodies[0].body).toContain(
			`- \`dropped/wt-1-bbbbbbbbb\` at ${B}, this drop`,
		);
		expect(f.bodies[0].body).not.toContain("`dropped/wt-1` at");
	});

	it("leaves an open ticket whose body already names the drop's sha as it is, naming it", () => {
		const f = dropFiler(["Tidy"], {}, [
			{
				number: 5,
				title: "Fix queue/wt-1, dropped by the queue lander: Tidy",
				body: `dropped \`queue/wt-1\` at ${A}`,
			},
		]);

		expect(f.filed()).toEqual({
			number: 5,
			line: "fix ticket already open: #5",
		});
		expect(f.files).toEqual([]);
		expect(f.bodies).toEqual([]);
		expect(f.comments).toEqual([]);
	});

	it("closes an open ticket with a comment naming the main sha that holds the work, and leaves a closed one alone", () => {
		const f = dropFiler([], { 5: "open", 6: "closed" });

		f.close(5, M);
		f.close(6, M);

		expect(f.closes).toEqual([
			{
				n: 5,
				comment: `Closed by the queue lander: \`main\` at ${M} holds the work of \`queue/wt-1\` dropped at ${A}.`,
			},
		]);
	});

	it("names the thrown error's message line, not the loader's file path, where file-issue.js would not load", () => {
		const f = dropFiler(["Tidy"], {}, [], {
			status: 1,
			stderr:
				"node:internal/modules/cjs/loader:1520\n  throw err;\n  ^\n\nError: Cannot find module './lib/x.js'\nRequire stack:\n- /r/scripts/file-issue.js\n",
		});

		expect(() => f.said()).toThrow(
			"fix ticket for a commit on queue/wt-1 not filed: Error: Cannot find module './lib/x.js'",
		);
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

	it("files an unassigned takes:implement sub-issue of the ticket the newest citing commit cites, titled by the queue ref's name alone, naming the ref, sha, dropped ref and conflicted files", () => {
		const f = dropFiler(["Tidy", "Add the widget (#12)", "Start (#40)"], {
			12: "open",
		});

		expect(f.filed()).toEqual({ number: 9, line: "Filed #9: https://x/9" });

		const [{ args, input }] = f.files;
		expect(f.ranges).toEqual([`${M}..${A}`]);
		expect(flag(args, "--parent")).toBe("12");
		expect(flag(args, "--title")).toBe(
			"Fix queue/wt-1, dropped by the queue lander: Tidy",
		);
		expect(args).toEqual(
			expect.arrayContaining(["takes:implement", "kind:ticket"]),
		);
		expect(args).not.toContain("--assign-self");
		expect(input).toContain(`\`queue/wt-1\` at ${A}`);
		expect(input).toContain(`onto \`main\` at ${M}`);
		expect(input).toContain("- `x.js`\n- `y.js`");
		expect(input).toContain(`- \`dropped/wt-1\` at ${A}, this drop`);
	});

	it("files standalone where no commit cites a ticket, naming a merge's refusal as its evidence", () => {
		const f = dropFiler(["Tidy"]);

		f.said({
			cause: {
				kind: "refused",
				name: "wt-1",
				reason: "FAIL: rule:x\nrun: fix ```x```",
			},
		});

		const [{ args, input }] = f.files;
		expect(flag(args, "--standalone")).toBe(
			"No commit on queue/wt-1 cites a ticket of this repo.",
		);
		expect(input).toContain(
			"its merge was refused, the refusal's verdict lines and its end:\n\n```text\nFAIL: rule:x\nrun: fix '''x'''\n```\n",
		);
	});

	it("quotes each row a refused merge did not carry and its reason, where the gate said so more than 40 lines before its end (#4800)", () => {
		const f = dropFiler(["Tidy"]);
		const remedy = Array.from({ length: 60 }, (_, i) => `  rule: ${i}`);

		f.said({
			cause: {
				kind: "refused",
				name: "wt-1",
				reason: parseGateRefusal(
					[
						"OK: a linked worktree",
						"not carried scripts/a.js — both sides changed scripts/lib/x.js.",
						"not carried scripts/b.js — it is not fresh on HEAD.",
						"The fault(s) below are NOT in HEAD — this commit adds them:",
						"  findings: scripts/a.js — the guard changed since the last review",
						"  findings: scripts/b.js — the guard changed since the last review",
						"This commit leaves the guard-registry anchor(s) above expired (#2617).",
						...remedy,
						"FAIL: 2 fault(s) this commit adds",
					].join("\n"),
				),
			},
		});

		expect(f.files[0].input).toContain(
			"```text\n[…]\nnot carried scripts/a.js — both sides changed scripts/lib/x.js.\nnot carried scripts/b.js — it is not fresh on HEAD.\nThe fault(s) below are NOT in HEAD — this commit adds them:\n  findings: scripts/a.js — the guard changed since the last review\n  findings: scripts/b.js — the guard changed since the last review\n[…]\n  rule: 21\n",
		);
		expect(f.files[0].input).toContain(
			"  rule: 59\nFAIL: 2 fault(s) this commit adds\n```\n",
		);
	});

	it("names the type-check a red failed and its first errors, never the whole suite naming no file (#4800)", () => {
		const f = dropFiler(["Tidy"]);
		const iso = "c".repeat(40);
		const typecheck = [
			"scripts/lib/a.js(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
			"scripts/b.js(9,1): error TS2304: Cannot find name 'c'.",
		];
		const red = { kind: "red" as const, name: "wt-1", iso };

		f.said({ cause: { ...red, files: [], typecheck } });
		/* Only a collision's whole-suite step names files and the type-check
		 * both: a member red on files is confirmed on those files alone. */
		const collision = {
			kind: "collision" as const,
			name: "wt-1",
			step: iso,
			after: [],
		};
		f.said({ cause: { ...collision, files: ["x.test.ts"], typecheck: [] } });
		f.said({ cause: { ...collision, files: [], typecheck } });

		const [alone, both, collided] = f.files.map((x) => x.input);
		const quoted = `its first errors:\n\n\`\`\`text\n${typecheck.join("\n")}\n\`\`\``;
		expect(alone).toContain(
			`as ${iso}, it failed the type-check twice, where \`main\` passes it, ${quoted}`,
		);
		expect(alone).not.toContain("naming no file");
		expect(alone).toContain(
			"- [ ] aaaaaaaaa's change passes the type-check merged onto `main`, and is pushed to `queue/wt-1` again.",
		);
		expect(both).toContain(
			"- `x.test.ts`\n\nIt also failed the type-check twice, whose errors its log did not name",
		);
		expect(both).toContain(
			"change passes each file above and the type-check merged onto `main`",
		);
		expect(collided).toContain(
			`as ${iso}, it failed the type-check twice, ${quoted}`,
		);
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

	it("names a member, or a collision's step, whose tree fired no CI run (#4571)", () => {
		const f = dropFiler(["Tidy"]);
		const iso = "c".repeat(40);
		const step = "d".repeat(40);

		f.said({
			cause: { kind: "red", name: "wt-1", files: [], iso, noRun: true },
		});
		f.said({
			cause: {
				kind: "collision",
				name: "wt-1",
				files: [],
				step,
				after: [],
				noRun: true,
			},
		});

		const [alone, collided] = f.files.map((x) => x.input);
		expect(alone).toContain(
			`onto \`main\` at ${M} as ${iso}, no CI run fired for this tree, twice`,
		);
		expect(collided).toContain("each member of its batch passed alone");
		expect(collided).toContain(
			`as ${step}, no CI run fired for this tree, twice`,
		);
		expect(alone).toContain(
			"- [ ] aaaaaaaaa's change, merged onto `main`, fires a CI run on the lander's refs that passes the whole suite",
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
