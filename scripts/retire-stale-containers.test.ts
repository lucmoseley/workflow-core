// @vitest-environment node
/*
 * The `takes:` retagger moves a routing label only where an issue's children
 * have made it false, and leaves every other issue alone (mantahostels#1632,
 * mantahostels#1663; cross-repo children #778).
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth, and no
 * dependence on this repo's own issue state. The stub answers `gh api …` from a
 * fixture and logs every `gh issue edit …`, which is what these tests assert on.
 *
 * `scripts/sweep-debts-detached.sh` runs it detached at every session start,
 * output unread: loosen a case and a live container is silently retagged off
 * its children, or a discharged one sits on the `/pick-next` frontier with
 * nothing to type.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubIssuesAnswer } from "./lib/gh-fake";
import {
	HERE,
	type StubGh,
	stubGhScript,
	subIssuesArm,
	THERE,
	writeSubIssues,
} from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "retire-stale-containers.js");

let dir: string;

interface Issue {
	number: number;
	title?: string;
	labels?: string[];
	parent?: number | null;
	state?: string;
	pull_request?: object;
	repository_url?: string;
	/** Overrides the URL `parent` builds, for a parent in another repo. */
	parent_issue_url?: string;
}

/**
 * Stub `gh` serving `issues` as one --slurp page, logging each `issue edit`,
 * and answering `issue view --json labels` from `viewLabels` — what the script
 * reads back when an edit fails.
 *
 * `children` answers the per-issue `/sub_issues` call that rule (b) and each
 * rule (a) candidate make: a number absent from it returns no sub-issue at
 * all — so a rule (a) candidate absent from it is stale — `"fail"` returns an
 * HTTP error the way an unreadable parent does, and `"unreachable"` returns
 * the one failure lib/gh.js classifies as an environment fact rather than a
 * fault.
 */
const stubGh = (
	issues: Issue[],
	{
		editFails = false,
		viewLabels = [] as string[],
		children = {} as Record<number, Issue[] | "fail" | "unreachable">,
	} = {},
) => {
	const fixture = path.join(dir, "issues.json");
	fs.writeFileSync(
		fixture,
		JSON.stringify([
			issues.map(({ labels, parent, ...i }) => ({
				title: `t${i.number}`,
				state: "open",
				html_url: `http://example/${i.number}`,
				labels: (labels ?? []).map((name) => ({ name })),
				parent_issue_url: parent ? `http://api/issues/${parent}` : null,
				...i,
			})),
		]),
	);
	const editLog = path.join(dir, "edits.log");
	const viewFixture = path.join(dir, "view.json");
	fs.writeFileSync(
		viewFixture,
		JSON.stringify({ labels: viewLabels.map((name) => ({ name })) }),
	);
	const answers: Record<number, SubIssuesAnswer> = {};
	for (const [n, kids] of Object.entries(children))
		answers[Number(n)] =
			typeof kids === "string"
				? kids
				: kids.map((k) => ({ title: `t${k.number}`, state: "open", ...k }));
	writeSubIssues(dir, answers);
	const script = `#!/bin/sh
case "$1 $2" in
  "issue edit")
    echo "$@" >> ${editLog}
    ${editFails ? "exit 1" : "exit 0"}
    ;;
  "issue view")
    cat ${viewFixture}
    ;;
  *)
    case "$2" in
${subIssuesArm(dir)}
      *)
        cat ${fixture}
        ;;
    esac
    ;;
esac
`;
	return { ...stubGhScript(dir, script), editLog };
};

const run = (args: string[] = [], stub?: StubGh) => {
	const r = runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			...(stub?.env ?? {}),
		},
	});
	return { ...r, out: `${r.stdout}${r.stderr}` };
};

const readEdits = (editLog: string) =>
	fs.existsSync(editLog) ? fs.readFileSync(editLog, "utf8").trim() : "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-containers-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("retire-stale-containers", () => {
	it("retags a container whose last child has closed", () => {
		/* mantahostels#10's only child mantahostels#11 is closed, so it is absent from the open list. */
		const stub = stubGh([{ number: 10, labels: ["takes:children"] }]);
		const r = run([], stub);

		expect(r.status).toBe(0);
		expect(readEdits(stub.editLog)).toBe(
			"issue edit 10 --add-label takes:triage --remove-label takes:children",
		);
		expect(r.out).toContain("#10");
	});

	it("names the whole-spec review when the container is a spec (#892)", () => {
		const stub = stubGh([
			{ number: 10, labels: ["takes:children", "kind:spec"] },
			{ number: 30, labels: ["takes:children"] },
		]);
		const r = run([], stub);

		expect(r.out).toContain("node scripts/spec-commits.js 10");
		expect(r.out).not.toContain("spec-commits.js 30");
	});

	it("leaves a container that still has an open child", () => {
		const stub = stubGh([
			{ number: 10, labels: ["takes:children"] },
			{ number: 11, labels: ["takes:implement"], parent: 10 },
		]);
		const r = run([], stub);

		expect(r.status).toBe(0);
		expect(readEdits(stub.editLog)).toBe("");
		expect(r.out).toContain("OK:");
	});

	it("moves an exhausted wayfinder:map whose last child closed (#578)", () => {
		const stub = stubGh([
			{ number: 8, labels: ["takes:children", "wayfinder:map"] },
		]);
		const r = run([], stub);

		expect(readEdits(stub.editLog)).toBe(
			"issue edit 8 --add-label takes:triage --remove-label takes:children",
		);
		expect(r.status).toBe(0);
	});

	it("leaves an exhausted wayfinder:map with a brief still open", () => {
		const stub = stubGh([
			{ number: 8, labels: ["takes:children", "wayfinder:map"] },
			{ number: 9, labels: ["kind:brief", "takes:to-spec"], parent: 8 },
		]);
		const r = run([], stub);

		expect(readEdits(stub.editLog)).toBe("");
		expect(r.status).toBe(0);
	});

	it("writes nothing under --dry-run and names what it would retag", () => {
		const stub = stubGh([{ number: 10, labels: ["takes:children"] }]);
		const r = run(["--dry-run"], stub);

		expect(readEdits(stub.editLog)).toBe("");
		expect(r.out).toContain("would retag #10");
		expect(r.out).toContain("--dry-run wrote nothing");
	});

	it("reports the fix when the retag fails and the label did not move", () => {
		const stub = stubGh([{ number: 10, labels: ["takes:children"] }], {
			editFails: true,
			viewLabels: ["takes:children"],
		});
		const r = run([], stub);

		expect(r.status).toBe(1);
		expect(r.out).toContain("RETAG-FAILED");
		expect(r.out).toContain("#10");
		expect(r.out).toContain("FAIL: 1 label(s) that could not be retagged");
	});

	it("stays silent when a parallel sweep already moved the label", () => {
		const stub = stubGh([{ number: 10, labels: ["takes:children"] }], {
			editFails: true,
			viewLabels: ["takes:triage"],
		});
		const r = run([], stub);

		expect(r.status).toBe(0);
		expect(r.out).not.toContain("RETAG-FAILED");
	});

	it("asks GitHub for open issues only", () => {
		const stub = stubGh([{ number: 10, labels: ["takes:implement"] }]);
		const argLog = path.join(dir, "args.log");
		fs.writeFileSync(
			stub.gh,
			fs
				.readFileSync(stub.gh, "utf8")
				.replace("case ", `echo "$@" >> ${argLog}\ncase `),
			{ mode: 0o755 },
		);
		run([], stub);

		const asked = fs.readFileSync(argLog, "utf8");
		expect(asked).toContain("state=open");
		expect(asked).not.toContain("state=all");
	});

	it("SKIPs at exit 0 when GitHub is unreachable", () => {
		const stub = stubGhScript(dir, "", { failing: true });
		const r = run([], stub);

		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
	});

	it("reports a JSON envelope naming what it retagged", () => {
		const stub = stubGh([{ number: 10, labels: ["takes:children"] }]);
		const r = run(["--json"], stub);
		const env = JSON.parse(r.stdout);

		expect(env.checker).toBe("stale-containers");
		expect(env.retagged).toEqual([
			{
				number: 10,
				title: "t10",
				from: "takes:children",
				to: "takes:triage",
			},
		]);
	});

	/* Rule (b) — mantahostels#1663, the duplicate-ticketing fix. */
	describe("a ticketed takes:to-tickets spec", () => {
		it("is retagged takes:children while a ticket is still open", () => {
			const stub = stubGh([{ number: 20, labels: ["takes:to-tickets"] }], {
				children: { 20: [{ number: 21, state: "open" }] },
			});
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(readEdits(stub.editLog)).toBe(
				"issue edit 20 --add-label takes:children --remove-label takes:to-tickets",
			);
			// The report names the issue, the direction and the reason.
			expect(r.out).toContain("#20 t20");
			expect(r.out).toContain(
				"takes:to-tickets → takes:children — its tickets",
			);
			expect(r.out).toContain("Retagged 1 routing label(s)");
		});

		/* Both takes: values at once is already a MANY-TAKES FAIL elsewhere; this
		 * sweep must not add a second pair to it. */
		it("stands off an issue also carrying takes:children", () => {
			/* mantahostels#21 open keeps rule (a) off it too, so any edit here is rule (b)'s. */
			const stub = stubGh(
				[
					{ number: 20, labels: ["takes:to-tickets", "takes:children"] },
					{ number: 21, labels: ["takes:implement"], parent: 20 },
				],
				{ children: { 20: [{ number: 21, state: "open" }] } },
			);
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(readEdits(stub.editLog)).toBe("");
		});

		it("is retagged takes:triage once every ticket has closed", () => {
			const stub = stubGh([{ number: 20, labels: ["takes:to-tickets"] }], {
				children: {
					20: [
						{ number: 21, state: "closed" },
						{ number: 22, state: "closed" },
					],
				},
			});
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(readEdits(stub.editLog)).toBe(
				"issue edit 20 --add-label takes:triage --remove-label takes:to-tickets",
			);
			expect(r.out).toContain(
				"/triage reviews its combined commits first (node scripts/spec-commits.js 20, adding --since <sha>",
			);
		});

		it("is left alone with no sub-issue at all — it still awaits /to-tickets", () => {
			const stub = stubGh([{ number: 20, labels: ["takes:to-tickets"] }]);
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(readEdits(stub.editLog)).toBe("");
			expect(r.out).toContain("OK:");
		});

		it("is left alone on a wayfinder:map, whose right value only a human knows", () => {
			const stub = stubGh(
				[{ number: 8, labels: ["takes:to-tickets", "wayfinder:map"] }],
				{ children: { 8: [{ number: 9, state: "open" }] } },
			);
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(readEdits(stub.editLog)).toBe("");
		});

		it("is left labelled as it stands when its sub-issues cannot be read", () => {
			const stub = stubGh([{ number: 20, labels: ["takes:to-tickets"] }], {
				children: { 20: "fail" },
			});
			const r = run([], stub);

			expect(r.status).toBe(0); // WARN, not a gate
			expect(readEdits(stub.editLog)).toBe("");
			expect(r.out).toContain("CHILDREN-UNREADABLE");
		});

		it("keeps the unread-spec count in the summary even when a retag also fails (#93)", () => {
			const stub = stubGh(
				[
					{ number: 10, labels: ["takes:children"] },
					{ number: 20, labels: ["takes:to-tickets"] },
				],
				{
					editFails: true,
					viewLabels: ["takes:children"],
					children: { 20: "fail" },
				},
			);
			const r = run([], stub);

			expect(r.status).toBe(1); // FAIL wins over WARN
			expect(r.out).toContain("RETAG-FAILED");
			expect(r.out).toContain("CHILDREN-UNREADABLE");
			expect(r.out).toMatch(
				/FAIL: 1 label\(s\) that could not be retagged \(plus 1 issue\(s\) whose children could not be read, left as they stand\)/,
			);
		});

		it("names the WARN by what actually happened — a spec unread, not a failed retag (#93)", () => {
			const stub = stubGh([{ number: 20, labels: ["takes:to-tickets"] }], {
				children: { 20: "fail" },
			});
			const r = run([], stub);

			expect(r.out).toMatch(
				/WARN: 1 issue\(s\) whose children could not be read/,
			);
			expect(r.out).not.toContain(
				"WARN: 1 label(s) that could not be retagged",
			);
		});

		it("writes nothing under --dry-run and names the retag it would make", () => {
			const stub = stubGh([{ number: 20, labels: ["takes:to-tickets"] }], {
				children: { 20: [{ number: 21, state: "open" }] },
			});
			const r = run(["--dry-run"], stub);

			expect(readEdits(stub.editLog)).toBe("");
			expect(r.out).toContain(
				"would retag #20 t20  takes:to-tickets → takes:children",
			);
			expect(r.out).toContain("--dry-run wrote nothing");
		});

		it("stays silent when a parallel sweep already moved the label", () => {
			const stub = stubGh([{ number: 20, labels: ["takes:to-tickets"] }], {
				editFails: true,
				viewLabels: ["takes:children"],
				children: { 20: [{ number: 21, state: "open" }] },
			});
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(r.out).not.toContain("RETAG-FAILED");
		});

		/* An unreachable GitHub SKIPs the run — and the SKIP line must not claim
		 * nothing was retagged, since rule (a) has already written by then. */
		it("SKIPs without denying the rule (a) retags already made", () => {
			const stub = stubGh(
				[
					{ number: 10, labels: ["takes:children"] },
					{ number: 20, labels: ["takes:to-tickets"] },
				],
				{ children: { 20: "unreachable" } },
			);
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(r.out).toContain("SKIP");
			expect(r.out).toContain("1 label(s) retagged above");
			expect(r.out).not.toContain("No container was retagged");
		});

		it("names both retags under --dry-run and writes neither", () => {
			const stub = stubGh(
				[
					{ number: 10, labels: ["takes:children"] },
					{ number: 20, labels: ["takes:to-tickets"] },
				],
				{ children: { 20: [{ number: 21, state: "open" }] } },
			);
			const r = run(["--dry-run"], stub);

			expect(readEdits(stub.editLog)).toBe("");
			expect(r.out).toContain(
				"would retag #10 t10  takes:children → takes:triage",
			);
			expect(r.out).toContain(
				"would retag #20 t20  takes:to-tickets → takes:children",
			);
			expect(r.out).toContain("2 routing label(s) named above");
		});

		it("runs alongside rule (a) in one sweep", () => {
			const stub = stubGh(
				[
					{ number: 10, labels: ["takes:children"] },
					{ number: 20, labels: ["takes:to-tickets"] },
				],
				{ children: { 20: [{ number: 21, state: "open" }] } },
			);
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(readEdits(stub.editLog).split("\n")).toEqual([
				"issue edit 10 --add-label takes:triage --remove-label takes:children",
				"issue edit 20 --add-label takes:children --remove-label takes:to-tickets",
			]);
		});

		it("costs a /sub_issues call only for takes:to-tickets issues and rule (a) candidates", () => {
			const stub = stubGh(
				[
					{ number: 10, labels: ["takes:children"] },
					{ number: 11, labels: ["takes:children"] },
					{ number: 13, labels: ["takes:implement"], parent: 11 },
					{ number: 12, labels: ["takes:implement"] },
					{ number: 20, labels: ["takes:to-tickets"] },
				],
				{ children: { 20: [{ number: 21, state: "open" }] } },
			);
			const argLog = path.join(dir, "args.log");
			fs.writeFileSync(
				stub.gh,
				fs
					.readFileSync(stub.gh, "utf8")
					.replace("case ", `echo "$@" >> ${argLog}\ncase `),
				{ mode: 0o755 },
			);
			run([], stub);

			const asked = fs.readFileSync(argLog, "utf8").split("\n");
			expect(
				asked
					.filter((l) => l.includes("/sub_issues"))
					.map((l) => l.split(" ")[1]),
			).toEqual([
				"repos/{owner}/{repo}/issues/10/sub_issues",
				"repos/{owner}/{repo}/issues/20/sub_issues",
			]);
		});
	});

	/* The open-issue list holds this repo's issues alone (#778). */
	describe("children in another repository", () => {
		it("leaves a container whose only open child is in another repo", () => {
			const stub = stubGh([{ number: 17, labels: ["takes:children"] }], {
				children: {
					17: [{ number: 3645, state: "open", repository_url: THERE }],
				},
			});
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(readEdits(stub.editLog)).toBe("");
		});

		it("retags it once that child has closed", () => {
			const stub = stubGh([{ number: 17, labels: ["takes:children"] }], {
				children: {
					17: [{ number: 3645, state: "closed", repository_url: THERE }],
				},
			});
			run([], stub);

			expect(readEdits(stub.editLog)).toBe(
				"issue edit 17 --add-label takes:triage --remove-label takes:children",
			);
		});

		it("never counts a local child of another repo's #17 as a child of local #17", () => {
			const stub = stubGh([
				{ number: 17, labels: ["takes:children"], repository_url: HERE },
				{
					number: 30,
					labels: ["takes:implement"],
					repository_url: HERE,
					parent_issue_url: `${THERE}/issues/17`,
				},
			]);
			run([], stub);

			expect(readEdits(stub.editLog)).toBe(
				"issue edit 17 --add-label takes:triage --remove-label takes:children",
			);
		});

		it("retags nothing when a candidate's sub-issues cannot be read", () => {
			const stub = stubGh([{ number: 17, labels: ["takes:children"] }], {
				children: { 17: "fail" },
			});
			const r = run([], stub);

			expect(r.status).toBe(0); // WARN, not a gate
			expect(readEdits(stub.editLog)).toBe("");
			expect(r.out).toContain("CHILDREN-UNREADABLE");
			expect(r.out).toContain("takes:children left as it stands");
		});

		it("SKIPs, retagging nothing, when GitHub goes unreachable on a candidate", () => {
			const stub = stubGh(
				[
					{ number: 10, labels: ["takes:children"] },
					{ number: 17, labels: ["takes:children"] },
				],
				{ children: { 17: "unreachable" } },
			);
			const r = run([], stub);

			expect(r.status).toBe(0);
			expect(r.out).toContain("SKIP");
			expect(r.out).toContain("No container was retagged");
			expect(readEdits(stub.editLog)).toBe("");
		});
	});
});
