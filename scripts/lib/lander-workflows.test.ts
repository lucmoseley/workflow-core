// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_CONTRACT } from "./actions-tester.js";
import { keptSpawn } from "./kept-spawn.js";
import {
	ADOPTER_WORKFLOWS,
	LANDER_NAMED_WORKFLOW,
	LANDER_SUITE_WORKFLOW,
	renderLanderWorkflows,
} from "./lander-workflows.js";
import { parseFailingFiles } from "./suite-output.js";
import { upgrade } from "./upgrade-walk.js";
import { parseJob, type Workflow } from "./workflow-yaml-testkit";

const SCRIPT = path.resolve(__dirname, "..", "lander-ci.js");
const PATHS = [LANDER_SUITE_WORKFLOW, LANDER_NAMED_WORKFLOW];
const expr = (e: string) => `\${{ ${e} }}`;

let tmp: string;
let root: string;
let pluginRoot: string;

const write = (base: string, rel: string, body: string) => {
	const at = path.join(base, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};
const config = (extra: object = {}) =>
	write(
		root,
		".claude/workflow-core.json",
		JSON.stringify({
			contract: 1,
			founder: "A Founder",
			modules: [],
			...extra,
		}),
	);
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

beforeEach(() => {
	vi.stubEnv("WFC_MODULES", undefined);
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lander-workflows-test-"));
	root = path.join(tmp, "adopter");
	pluginRoot = path.join(tmp, "plugin");
	write(
		pluginRoot,
		".claude-plugin/plugin.json",
		JSON.stringify({ name: "workflow-core", version: "1.0.0" }),
	);
	config();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run() {
	const lines: string[] = [];
	const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
	expect(r.status).toBe(0);
	return lines;
}

const parsed = (rel: string) => parseJob(read(rel)) as unknown as Workflow;

describe("the upgrade's lander workflows", () => {
	it("writes both where landingTester is absent or auto, on the marker, and says nothing once current", () => {
		const lines = run();
		for (const rel of PATHS) {
			expect(lines).toContain(`wrote   ${rel}`);
			expect(read(rel)).toMatch(/^# CORE-OWNED\./);
		}
		config({ landingTester: "auto" });
		expect(run().filter((l) => PATHS.some((p) => l.includes(p)))).toEqual([]);
	});

	it("fires the suite on lander suite refs and the named rerun on a dispatch titled by sha and nonce", () => {
		run();
		const suite = read(LANDER_SUITE_WORKFLOW);
		expect(suite).toContain(
			'  push:\n    branches: ["lander/batch*", "lander/iso-suite-*"]\n',
		);
		const named = parsed(LANDER_NAMED_WORKFLOW);
		expect(Object.keys(named.on?.workflow_dispatch?.inputs ?? {})).toEqual([
			"sha",
			"files",
			"nonce",
		]);
		expect(read(LANDER_NAMED_WORKFLOW)).toContain(
			`run-name: named-rerun ${expr("inputs.sha")} ${expr("inputs.nonce")}\n`,
		);
	});

	it("removes the core's copies where landingTester pins local, and writes none where it pins actions", () => {
		run();
		config({ landingTester: "local" });
		const lines = run();
		for (const rel of PATHS) {
			expect(lines).toContain(
				`removed ${rel} — .claude/workflow-core.json pins "landingTester": "local"`,
			);
			expect(exists(rel)).toBe(false);
		}
		config({ landingTester: "actions" });
		expect(run().filter((l) => PATHS.some((p) => l.includes(p)))).toEqual([]);
		for (const rel of PATHS) expect(exists(rel)).toBe(false);
	});

	it("leaves an adopter's own file at either path alone, whatever landingTester is", () => {
		for (const rel of PATHS) write(root, rel, "name: own\n");
		for (const landingTester of ["auto", "local"]) {
			config({ landingTester });
			expect(run().join("\n")).toContain(`skipped ${LANDER_SUITE_WORKFLOW}`);
			for (const rel of PATHS) expect(read(rel)).toBe("name: own\n");
		}
	});

	it("runs one shard job per fullTestShards group, on the ci key's runner and ceiling, else arm64 and 15 min", () => {
		config({ commands: { full_test: "npm test" }, fullTestShards: 3 });
		run();
		const suite = parsed(LANDER_SUITE_WORKFLOW);
		const shardNames = Object.values(suite.jobs)
			.map((j) => j.name)
			.filter((n) => n?.startsWith("Vitest"));
		expect(shardNames).toEqual([
			"Vitest (1/3)",
			"Vitest (2/3)",
			"Vitest (3/3)",
		]);
		for (const rel of PATHS) {
			expect(read(rel)).toContain("runs-on: ubuntu-24.04-arm\n");
			expect(read(rel)).toContain("timeout-minutes: 15\n");
		}
		config({
			commands: { test: "npm test" },
			ci: { runner: "ubuntu-slim", timeoutMinutes: 9 },
		});
		run();
		expect(
			Object.values(parsed(LANDER_SUITE_WORKFLOW).jobs).map((j) => j.name),
		).toEqual(["Vitest (1/1)", "Suite passed"]);
		for (const rel of PATHS) {
			expect(read(rel)).toContain("runs-on: ubuntu-slim\n");
			expect(read(rel)).not.toContain("ubuntu-24.04-arm");
			expect(read(rel)).toContain("timeout-minutes: 9\n");
		}
	});

	it("reads contents alone, names no secret, pins every action to a full sha and sets up Node 24", () => {
		run();
		for (const rel of PATHS) {
			const body = read(rel);
			expect(body).toContain("permissions:\n  contents: read\n");
			expect(body).not.toContain("secrets.");
			for (const [, ref] of body.matchAll(/uses: [^@\s]+@(\S+)/g))
				expect(ref).toMatch(/^[0-9a-f]{40}$/);
			expect(body).toContain("node-version: 24");
			expect(body).toContain("npm ci");
			expect(body).toContain("requirements-dev.txt");
			expect(body).toContain(`ref: ${expr("steps.core-pin.outputs.ref")}`);
		}
	});
});

describe("the job contract the Actions tester reads", () => {
	const [suite, named] = renderLanderWorkflows({
		commands: { full_test: "npm test" } as never,
		fullTestShards: 2,
		ci: undefined,
	}).map(({ body }) => parseJob(body) as unknown as Workflow);

	it("names each shard job, Suite passed, Named files and the runner-readying steps as the tester matches them", () => {
		const jobs = Object.values(suite?.jobs ?? {});
		const shards = jobs.filter((j) => JOB_CONTRACT.shardJob.test(j.name ?? ""));
		expect(
			shards.map((j) => j.name?.match(JOB_CONTRACT.shardJob)?.slice(1)),
		).toEqual([
			["1", "2"],
			["2", "2"],
		]);
		expect(jobs.map((j) => j.name)).toContain(JOB_CONTRACT.suitePassedJob);
		expect(Object.values(named?.jobs ?? {}).map((j) => j.name)).toEqual([
			JOB_CONTRACT.namedJob,
		]);
		for (const job of [...shards, ...Object.values(named?.jobs ?? {})]) {
			const steps = job.steps ?? [];
			const readying = steps.filter((s) =>
				/^actions\/(checkout|setup-node)@/.test(s.uses ?? ""),
			);
			expect(readying.length).toBeGreaterThan(0);
			for (const s of readying)
				expect(
					JOB_CONTRACT.runnerSteps.has((s as { name?: string }).name ?? ""),
				).toBe(true);
		}
		for (const job of shards)
			expect(
				(job.steps ?? []).map((s) => (s as { name?: string }).name),
			).toContain(ADOPTER_WORKFLOWS.suiteStep);
	});

	it("dispatches and reads the workflows at the paths the upgrade writes", () => {
		expect(path.basename(LANDER_SUITE_WORKFLOW)).toBe(ADOPTER_WORKFLOWS.suite);
		expect(path.basename(LANDER_NAMED_WORKFLOW)).toBe(ADOPTER_WORKFLOWS.named);
	});
});

describe("lander-ci.js, each job's step", () => {
	const fakeRunner = `const fs = require("node:fs");
let red = false;
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const shard = process.argv.find((a) => a.startsWith("--shard="));
fs.appendFileSync("ran.txt", (shard ?? "whole") + " " + named.join(" ") + "\\n");
for (const f of named) if (f.includes("red")) { red = true; console.log(" FAIL  " + f + " > it fails"); }
process.exit(red ? 1 : 0);
`;
	const lander = (...args: string[]) => {
		const { WFC_MODULES: _, ...env } = process.env;
		return keptSpawn("fd").spawnSync(process.execPath, [SCRIPT, ...args], {
			cwd: root,
			env: { ...env, CLAUDE_PROJECT_DIR: root },
			encoding: "utf8",
		});
	};
	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		write(root, "run.js", fakeRunner);
		write(root, "a.check.js", "");
		write(root, "red.check.js", "");
	});
	const ran = () => read("ran.txt").trim().split("\n");

	it("runs the k-th whole-run group, its shard flag the local tester's", () => {
		config({ commands: { full_test: "node run.js" }, fullTestShards: 2 });
		expect(lander("group", "2/2").status).toBe(0);
		expect(ran()).toEqual(["--shard=2/2"]);
	});

	it("fails naming both counts where the workflow's groups are not the config's", () => {
		config({ commands: { full_test: "node run.js" }, fullTestShards: 3 });
		const r = lander("group", "1/2");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("runs 2 group(s), but the config here plans 3");
	});

	it("runs the named files the tree holds, and a red prints the FAIL line the tester reads", () => {
		config({ commands: { test: "node run.js" } });
		const r = lander("files", "a.check.js", "red.check.js", "gone.check.js");
		expect(r.status).toBe(1);
		expect(ran()).toEqual(["whole a.check.js red.check.js"]);
		expect(parseFailingFiles(r.stdout)).toEqual(["red.check.js"]);
	});

	it("passes a repo declaring no suite, naming that nothing ran", () => {
		config();
		const r = lander("group", "1/1");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("nothing to run here");
	});
});
