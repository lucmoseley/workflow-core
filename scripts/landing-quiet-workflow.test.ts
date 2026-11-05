// @vitest-environment node

/*
 * .github/workflows/landing-quiet.yml's step, run as the shell it is (#3964),
 * under the `-eo pipefail` GitHub gives `shell: bash`, with GitHub's activity
 * endpoint stubbed as a `curl` on PATH. Run from YAML, because no other test or
 * check executes a workflow's shell. Break this and the one alarm that outlives
 * the machine can stay green through a stall, unnoticed.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "./lib/precommit-gate-testkit";
import { shellQuote } from "./lib/sh-quote.js";

// Through `require`: js-yaml ships no types.
const yaml = createRequire(import.meta.url)("js-yaml");

interface Step {
	run: string;
	env: Record<string, unknown>;
}
interface Workflow {
	name: string;
	on: { schedule: { cron: string }[] };
	jobs: { quiet: { name: string; if: string; steps: Partial<Step>[] } };
}

const workflow = yaml.load(
	fs.readFileSync(
		path.join(ROOT, ".github/workflows/landing-quiet.yml"),
		"utf8",
	),
) as Workflow;
const job = workflow.jobs.quiet;
const step = job.steps.find((s) => s.run) as Step;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-quiet-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const runStep = (body: string | null, forceFailure = "") => {
	const payload = path.join(dir, "payload");
	fs.writeFileSync(payload, body ?? "");
	fs.writeFileSync(
		path.join(dir, "curl"),
		body === null
			? "#!/bin/sh\nexit 22\n"
			: `#!/bin/sh\ncat ${shellQuote(payload)}\n`,
		{ mode: 0o755 },
	);
	return spawnSync("bash", ["-eo", "pipefail", "-c", step.run], {
		encoding: "utf8",
		env: {
			PATH: `${dir}:${process.env.PATH}`,
			GH_TOKEN: "token",
			GITHUB_API_URL: "https://api.github.test",
			GITHUB_REPOSITORY: "owner/repo",
			FORCE_FAILURE: forceFailure,
			QUIET_HOURS: String(step.env.QUIET_HOURS),
		},
	});
};

const pushed = (hours: number) =>
	JSON.stringify([
		{ timestamp: new Date(Date.now() - hours * 3600 * 1000).toISOString() },
	]);

describe("landing-quiet.yml", () => {
	it("runs hourly, in the code repo alone", () => {
		expect(workflow.on.schedule).toEqual([{ cron: "17 * * * *" }]);
		expect(job.if).toContain("lucmoseley/workflow-core");
	});

	it("names the threshold it applies where an email shows it", () => {
		const hours = step.env.QUIET_HOURS;
		expect(workflow.name).toContain(`${hours}h`);
		expect(job.name).toContain(`${hours} hours`);
	});

	it("passes on a push inside the 14 hours", () => {
		const run = runStep(pushed(13.9));
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
	});

	it("fails past 14 hours, naming what to look at first", () => {
		const run = runStep(pushed(14.1));
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("::error title=Landing quiet::");
		expect(run.stdout).toContain("wsl --list --running");
		expect(run.stdout).toContain("memcheck");
	});

	it("a forced failure fails a fresh landing, raising no stall", () => {
		const run = runStep(pushed(1), "true");
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("::error title=Forced failure::");
		expect(run.stdout).not.toContain("Landing quiet");
	});

	it.each([
		["an API refusal", null],
		["an empty feed", "[]"],
	])("%s fails as a broken check, naming the way out", (_name, body) => {
		const run = runStep(body);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("::error title=Check broken, not a stall::");
		expect(run.stdout).toContain(
			"https://api.github.test/repos/owner/repo/activity",
		);
		expect(run.stdout).toContain("git log origin/landing");
		expect(run.stdout).not.toContain("Landing quiet");
	});
});
