// @vitest-environment node
/*
 * Pins adopter-ci.js, the one job of an adopter's core-owned CI workflow
 * (#5347), by running it over fixture adopters.
 *
 * Breaking it lets a red command or check pass the adopter's CI, or lets one
 * failure hide the steps after it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CI_WORKFLOW, renderCiWorkflow } from "./lib/adopter-ci.js";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";
import { parseJob, type Workflow } from "./lib/workflow-yaml-testkit";

const { resolveCore } = require("./lib/resolve-core.js");

const SCRIPT = path.resolve(__dirname, "adopter-ci.js");
/* The one shipped check whose gate holds in these fixtures: a change to it
 * selects this file. */
const PERMISSIONS_CHECK = "scripts/check-workflow-permissions.js";

const repoTemplate = defineTemplate((dir) => {
	execFileSync("git", ["init", "-q"], { cwd: dir });
});

let root: string;

const write = (rel: string, body: string) => {
	const at = path.join(root, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};
const config = (extra: object) =>
	write(
		".claude/workflow-core.json",
		JSON.stringify({
			contract: 1,
			founder: "A Founder",
			modules: [],
			...extra,
		}),
	);
const run = () => {
	execFileSync("git", ["add", "-A"], { cwd: root });
	/* The suite injects WFC_MODULES, which replaces the declared list the
	 * gates read. */
	const { WFC_MODULES: _, ...env } = process.env;
	return runInProcess(SCRIPT, [], {
		cwd: root,
		env: { ...env, CLAUDE_PROJECT_DIR: root },
	});
};

beforeEach(() => {
	root = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "adopter-ci-test-")),
		"repo",
	);
	repoTemplate.instantiate(root);
});
afterEach(() =>
	fs.rmSync(path.dirname(root), { recursive: true, force: true }),
);

describe("the declared commands", () => {
	it("runs every one after a failure and fails naming the red one", () => {
		config({
			commands: {
				lint: "touch lint.ran; exit 3",
				test: "touch test.ran",
			},
		});
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("commands.lint");
		expect(r.stderr).not.toContain("commands.test");
		expect(fs.existsSync(path.join(root, "test.ran"))).toBe(true);
	});

	it("passes where every declared command does", () => {
		config({ commands: { check: "true", test: "true" } });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("every step passed");
	});
});

describe("the shipped tree checks", () => {
	it("runs a check whose gate holds and fails on its FAIL", () => {
		expect(
			fs.existsSync(path.resolve(__dirname, "..", PERMISSIONS_CHECK)),
		).toBe(true);
		config({});
		write(
			".github/workflows/x.yml",
			"name: x\non: push\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("check workflow-permissions");
	});

	it("passes the core's own rendered workflow, and skips a check whose gate fails, naming why", () => {
		config({ ci: { runner: "ubuntu-slim" } });
		write(CI_WORKFLOW, renderCiWorkflow({ runner: "ubuntu-slim" }));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'skipped digest-version: module "roadmap" is off',
		);
	});
});

/* The rendered job, parsed: the pin step's script and the core checkout. */
const job = (
	parseJob(renderCiWorkflow({ runner: "ubuntu-slim" })) as unknown as Workflow
).jobs.ci;
const steps = job?.steps ?? [];
const pinStep = steps.find((s) => s.id === "core-pin");
const coreCheckout = steps.find((s) => s.with?.path === ".workflow-core");

describe("the workflow's pin step and core checkout", () => {
	const pinned = (source: object, marketplace = "wc") => ({
		extraKnownMarketplaces: { [marketplace]: { source } },
		enabledPlugins: {
			"other@elsewhere": true,
			[`workflow-core@${marketplace}`]: true,
		},
	});
	const atUrl = (ref: string) =>
		pinned({
			source: "url",
			url: "https://github.com/o/workflow-core.git",
			ref,
		});
	/** A string is written verbatim; undefined writes no settings file. */
	const runPinStep = (settings: unknown) => {
		if (settings !== undefined)
			write(
				".claude/settings.json",
				typeof settings === "string" ? settings : JSON.stringify(settings),
			);
		const out = path.join(root, "github-output");
		fs.writeFileSync(out, "");
		const r = spawnSync("bash", ["-e", "-c", pinStep?.run ?? ""], {
			cwd: root,
			env: { ...process.env, GITHUB_OUTPUT: out },
			encoding: "utf8",
		});
		return {
			status: r.status,
			stderr: r.stderr,
			output: fs.readFileSync(out, "utf8"),
		};
	};
	/** The pin resolveCore() reads, off its failure in an empty config dir. */
	const resolverPin = () => {
		try {
			resolveCore({
				root,
				env: { CLAUDE_CONFIG_DIR: path.dirname(root) },
				warn: () => {
					/* only the thrown pin is read */
				},
			});
		} catch (e) {
			const pin = /for pin (\S+) —/.exec((e as Error).message)?.[1];
			if (pin) return pin;
			throw e;
		}
		throw new Error("resolveCore found a core in an empty config dir");
	};

	it.each([
		["v1.4.2", "v1.4.2"],
		["1.4.2", "v1.4.2"],
		["v2.0.0-rc.1", "v2.0.0-rc.1"],
	])("pin %s outputs ref=%s, the pin resolveCore() reads", (ref, tag) => {
		const r = runPinStep(atUrl(ref));
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.output).toBe(`repo=o/workflow-core\nref=${tag}\n`);
		expect(`v${resolverPin().replace(/^v/, "")}`).toBe(tag);
	});

	it("reads a github source's repo, and a url's whose name holds a dot", () => {
		expect(
			runPinStep(pinned({ source: "github", repo: "o/wc", ref: "v3.0.0" }))
				.output,
		).toBe("repo=o/wc\nref=v3.0.0\n");
		expect(
			runPinStep(
				pinned({
					source: "url",
					url: "git@github.com:o/work.flow.git",
					ref: "v3.0.0",
				}),
			).output,
		).toBe("repo=o/work.flow\nref=v3.0.0\n");
	});

	it.each([
		["no workflow-core enabled", { ...atUrl("v1.4.2"), enabledPlugins: {} }],
		[
			"a marketplace settings do not know",
			{ ...atUrl("v1.4.2"), extraKnownMarketplaces: {} },
		],
		[
			"an unknown marketplace named like an Object method",
			{
				...atUrl("v1.4.2"),
				enabledPlugins: { "workflow-core@toString": true },
			},
		],
		["no settings file", undefined],
		["a malformed settings file", "{ not json"],
	])(
		"fails on %s, where resolveCore() reads no pin either, naming the fix and writing no output",
		(_, settings) => {
			const r = runPinStep(settings);
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain("pins no workflow-core release tag");
			expect(r.stderr).toContain("pin a release tag");
			expect(r.output).toBe("");
		},
	);

	it.each([
		["a branch pin", "main"],
		["a SHA pin", "b88b6baafe3998bb3f84a5aa495d4ab01c2945f4"],
	])("fails on %s, which names no release", (_, ref) => {
		const r = runPinStep(atUrl(ref));
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(`(found: ${ref} on o/workflow-core)`);
		expect(r.output).toBe("");
	});

	it("fails on a source off GitHub, which no runner can check out", () => {
		const r = runPinStep(
			pinned({ source: "directory", path: "/x", ref: "v1.4.2" }),
		);
		expect(r.status).not.toBe(0);
		expect(r.output).toBe("");
	});

	it("checks the core out at the pin step's repo and tag, where WORKFLOW_CORE_CHECKOUT points, keeping no credentials", () => {
		expect(steps.indexOf(pinStep ?? {})).toBeLessThan(
			steps.indexOf(coreCheckout ?? {}),
		);
		expect(coreCheckout?.with?.repository).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template
			"${{ steps.core-pin.outputs.repo }}",
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template
		expect(coreCheckout?.with?.ref).toBe("${{ steps.core-pin.outputs.ref }}");
		expect(coreCheckout?.with?.["persist-credentials"]).toBe(false);
		expect(job?.env?.WORKFLOW_CORE_CHECKOUT).toBe(
			`\${{ github.workspace }}/${coreCheckout?.with?.path}`,
		);
	});
});
