// @vitest-environment node
/*
 * Contract of lib/inject-tracker-docs-host.js's two reads against the fakes
 * the core's module cases use (lib/inject-tracker-docs-testkit.ts, §G7): each
 * fixture is answered by the production adapter, spawning `gh` at WFC_GH and
 * the dispatcher under `timeout`, and by the fake, and the answers must agree.
 * A fake that drifts from its adapter fails here before a module case can pass
 * on it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stubGhScript } from "./gh-stub";
import { initGitRepo } from "./git-fixture";
import { takesPort, tierPort } from "./inject-tracker-docs-testkit";
import { shellQuote } from "./sh-quote.js";

const { buildHostPorts } =
	require("./inject-tracker-docs-host.js") as typeof import("./inject-tracker-docs-host.js");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "inject-host-contract-"));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** The production ports, logging into `logged`. */
const production = (logged: string[] = []) =>
	buildHostPorts((what) => logged.push(what));

/** Run `fn` with these variables set over the environment, restored after. */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
	const saved = process.env;
	// env-write-kept: swapped and restored around one synchronous call, never across a case.
	process.env = { ...saved, ...env };
	try {
		return fn();
	} finally {
		// env-write-kept: the restore of the swap above.
		process.env = saved;
	}
}

describe("the `takes:` read", () => {
	const dir = fs.mkdtempSync(path.join(SCRATCH, "takes-"));
	const log = path.join(dir, "gh.log");
	const label = path.join(dir, "label");
	const recording = stubGhScript(
		dir,
		`#!/bin/sh\necho "$@" >> ${shellQuote(log)}\ncat ${shellQuote(label)}\n`,
	);
	const failing = stubGhScript(path.join(dir, "failing"), "", {
		failing: true,
	});

	it.each(["takes:implement", "takes:human", ""])(
		"answers the label gh prints (%j) as the fake does",
		(takes) => {
			fs.writeFileSync(label, `${takes}\n`);
			const q = { issue: "7", repo: "", cwd: "" };
			const real = withEnv(recording.env, () => production().takesLabel(q));
			expect(real).toBe(takesPort(() => takes).port(q));
		},
	);

	it("asks gh for the issue, its repo and the labels, as the fake records", () => {
		fs.rmSync(log, { force: true });
		fs.writeFileSync(label, "");
		const q = { issue: "9", repo: "o/r", cwd: "" };
		withEnv(recording.env, () => production().takesLabel(q));
		const fake = takesPort(() => "");
		fake.port(q);
		expect(fs.readFileSync(log, "utf8").startsWith(fake.calls[0])).toBe(true);
	});

	it("answers nothing where gh fails, as the module cases' default does", () => {
		expect(
			withEnv(failing.env, () =>
				production().takesLabel({ issue: "7", repo: "", cwd: "" }),
			),
		).toBe("");
	});

	it("asks nothing from a cwd that is not a directory", () => {
		fs.rmSync(log, { force: true });
		const q = { issue: "7", repo: "", cwd: path.join(dir, "gone") };
		expect(withEnv(recording.env, () => production().takesLabel(q))).toBe("");
		expect(fs.existsSync(log)).toBe(false);
	});
});

describe("the review-tier read", () => {
	const repo = fs.mkdtempSync(path.join(SCRATCH, "tier-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	initGitRepo(repo, path.join(repo, ".git", "no-hooks"));
	fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, ".claude", "workflow-core.json"),
		JSON.stringify({
			sensitivePaths: [
				{
					name: "RLS and auth boundaries",
					description: "who may read or write what",
					globs: ["supabase/migrations/**"],
					focus: "who can read or write what",
					examples: ["an RLS policy"],
				},
			],
		}),
	);
	fs.mkdirSync(path.join(repo, "supabase", "migrations"), { recursive: true });
	fs.writeFileSync(path.join(repo, "supabase", "migrations", "001.sql"), "x\n");
	git("add", ".");
	const env = { CLAUDE_PROJECT_DIR: repo, CLAUDE_CONFIG_DIR: SCRATCH };
	let n = 0;
	/* A fresh session per read: the tier core latches what it has told one. */
	const query = () => ({
		payload: JSON.stringify({
			hook_event_name: "PreToolUse",
			tool_name: "Skill",
			tool_input: { skill: "workflow-core:code-review" },
			session_id: `tier-contract-${++n}`,
			cwd: repo,
		}),
		cwd: repo,
	});

	it("answers the tier a staged sensitive path owes, as the in-process fake does", () => {
		const real = withEnv(env, () => production().reviewTier(query()));
		const fake = withEnv(env, () => tierPort()(query()));
		expect(real).toContain("Tier owed: escalated");
		expect(real).toBe(fake);
	});

	it("answers nothing where the tier hook is absent, as the fake does", () => {
		const missing = path.join(repo, "no-such-hook");
		const real = withEnv({ ...env, WFC_REVIEW_TIER_HOOK: missing }, () =>
			production().reviewTier(query()),
		);
		expect(real).toBe("");
		expect(withEnv(env, () => tierPort(missing)(query()))).toBe("");
	});
});
