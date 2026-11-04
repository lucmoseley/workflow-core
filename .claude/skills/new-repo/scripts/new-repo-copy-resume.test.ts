// @vitest-environment node
/*
 * new-repo.js --resume after a part-way copy of a source repo, from each step
 * the copy can stop after. Split from new-repo.test.ts, whose header says how
 * a run is driven and what a loosened case costs (#3258).
 *
 * Over the run-cost budget (base §X8 (5)): each case is a whole run of the
 * script, with the hooks off (#4297).
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shellQuote } from "../../../../scripts/lib/sh-quote.js";
import {
	cleanRun,
	newRepoSuite,
	type readEndState,
	resumeFinishes,
	SET_ASIDE_HOOK,
	sandbox,
	worlds,
} from "./new-repo-testkit";

newRepoSuite();

describe("new-repo.js --resume after a part-way copy", () => {
	let goldenEnd: ReturnType<typeof readEndState>;
	let world: ReturnType<typeof worlds>;
	beforeAll(() => {
		const clean = cleanRun(true, { hooks: false });
		goldenEnd = clean.goldenEnd;
		world = worlds(clean.golden, true);
	}, 340_000);
	afterAll(() => world?.drop());

	it.each([
		"clone",
		"source repo",
		"set aside",
		"init-adopter",
		"gitignore",
		"source docs",
		"push",
	])(
		"finishes from the world as left after %s, reaching a clean copy's end state, as its dry run foretold",
		(step) => {
			resumeFinishes(world.at(step), step, goldenEnd, true);
		},
		170_000,
	);

	it("moves a linked pre-commit beside itself, and files the reconcile ticket for a CLAUDE.md that was only a link", () => {
		const s = sandbox({
			hooks: false,
			source: "node_modules/\n",
			sourceFiles: {
				"AGENTS.md": null,
				"CLAUDE.md": { link: "docs/tides.md" },
				".husky/pre-commit": { link: "../scripts/hook.sh" },
				"scripts/hook.sh": SET_ASIDE_HOOK,
			},
		});
		const r = s.run();
		expect(r.status, r.stdout).toBe(0);
		expect(r.stdout).toContain(
			"set aside      done — CLAUDE.md, a link to docs/tides.md, removed, .husky/pre-commit → .husky/pre-commit.local\n",
		);
		expect(fs.readlinkSync(path.join(s.clone, ".husky/pre-commit.local"))).toBe(
			"../scripts/hook.sh",
		);
		expect(r.stdout).toContain("reconcile      done — #2 under #1\n");
		const [, ticket] = s.readState().issues;
		expect(ticket.body).toContain(
			"- the source repo's `CLAUDE.md` was a link to `docs/tides.md`",
		);
		expect(ticket.body).not.toContain("AGENTS.source.md");
	}, 170_000);

	it("prints the self-plugin's once-per-machine setup before the first session, for a copy of a workflow-core checkout (#2440)", () => {
		const s = sandbox({
			hooks: false,
			source: "node_modules/\n",
			sourceFiles: { "self-plugin/hooks/hooks.json": '{"hooks":{}}\n' },
		});
		const r = s.run();
		expect(r.status, r.stdout).toBe(0);
		expect(r.stdout).toContain(
			`This is a workflow-core checkout. Once per machine, first run:\nclaude plugin marketplace add ${shellQuote(`${s.clone}/self-plugin`)} --scope user\n\nOpen a new terminal tab`,
		);
	}, 170_000);

	it("keeps the lowest reconcile ticket, links it under the map where a failed run left it unlinked, and closes every other", () => {
		const s = world.at("push");
		const gh = s.readState();
		const [map] = gh.issues;
		const ticket = {
			...map,
			title: "Reconcile octo/surf-lib's agent instructions with the core's",
			labels: ["wayfinder:grilling", "takes:wayfinder"],
			body: "filed by a failed run",
		};
		gh.issues.push(
			{ ...ticket, number: 2 },
			{ ...ticket, number: 3, parent: 1 },
		);
		fs.writeFileSync(
			path.join(s.sb, "github/lucmoseley/tides.json"),
			JSON.stringify(gh),
		);
		const r = s.resume();
		expect(r.status, r.stdout).toBe(0);
		expect(r.stdout).toContain("reconcile      repaired — #2 under #1\n");
		const [, kept, dup] = s.readState().issues;
		expect(kept.state).toBe("OPEN");
		expect(kept.parent).toBe(1);
		expect(dup.state).toBe("CLOSED");
		expect(dup.comments).toEqual([
			"duplicate of #2, filed by a failed new-repo run",
		]);
	}, 170_000);
});
