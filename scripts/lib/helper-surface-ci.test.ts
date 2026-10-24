// @vitest-environment node
/*
 * helper-surface-ci.test.ts — the CI recipe in docs/agents/helper-surface.md
 * runs as written (#466). The steps are read out of the doc itself, so the
 * recipe an adopter copies cannot rot unseen; they run under bash because a
 * yaml `run:` block is shell, which the in-process runner cannot execute.
 *
 * Breaking it lets the doc hand adopters a recipe that fails in their CI, or
 * checks the core out at a tag other than their pin, so their tests run
 * against a core they never pinned. Nothing else runs the recipe; this test
 * fails CI when it is red.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface Step {
	id?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
}

// js-yaml ships no types, and only its load is needed.
const yaml: { load: (text: string) => unknown } = require("js-yaml");
const { resolveCore } = require("./resolve-core.js");

const DOC = path.join(__dirname, "..", "..", "docs/agents/helper-surface.md");
const block = fs.readFileSync(DOC, "utf8").match(/```yaml\n([\s\S]*?)```/);
const recipe = (block ? yaml.load(block[1]) : null) as {
	env?: Record<string, string>;
	steps?: Step[];
} | null;
const steps = recipe?.steps ?? [];
const pinStep = steps.find((s) => s.id === "core-pin");
const keyStep = steps.find((s) => s.env && "DEPLOY_KEY" in s.env);
const coreCheckout = steps.find(
	(s) => s.with?.repository === "lucmoseley/workflow-core",
);

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-ci-"));
	dirs.push(dir);
	return dir;
}

/** A string is written as the settings file verbatim; undefined writes none. */
function adopter(settings: unknown): string {
	const root = tempDir();
	fs.mkdirSync(path.join(root, ".claude"));
	if (settings !== undefined)
		fs.writeFileSync(
			path.join(root, ".claude", "settings.json"),
			typeof settings === "string" ? settings : JSON.stringify(settings),
		);
	return root;
}

function pinned(ref: string, marketplace = "wc") {
	return {
		extraKnownMarketplaces: {
			[marketplace]: {
				source: { source: "url", url: "https://example.invalid/wc.git", ref },
			},
		},
		enabledPlugins: {
			"other@elsewhere": true,
			[`workflow-core@${marketplace}`]: true,
		},
	};
}

function runPinStep(root: string) {
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
}

/** The pin resolveCore() reads for `root`, taken from its failure message:
 * with no variables set and an empty config dir it always fails. */
function resolverPin(root: string): string {
	try {
		resolveCore({
			root,
			env: { CLAUDE_CONFIG_DIR: tempDir() },
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
}

function runKeyStep(env: Record<string, string | undefined>) {
	const { DEPLOY_KEY: _, ...base } = process.env;
	return spawnSync("bash", ["-e", "-c", keyStep?.run ?? ""], {
		env: { ...base, ...env },
		encoding: "utf8",
	});
}

describe("the helper-surface CI recipe", () => {
	it("holds the pin step, the key step and the core checkout", () => {
		expect(pinStep?.run).toBeTruthy();
		expect(keyStep?.run).toBeTruthy();
		expect(coreCheckout).toBeTruthy();
	});

	it.each([
		["v1.4.2", "v1.4.2"],
		["1.4.2", "v1.4.2"],
		["v2.0.0-rc.1", "v2.0.0-rc.1"],
	])("pin %s outputs ref=%s, the pin resolveCore() reads", (ref, tag) => {
		const root = adopter(pinned(ref));
		const r = runPinStep(root);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.output).toBe(`ref=${tag}\n`);
		expect(`v${resolverPin(root).replace(/^v/, "")}`).toBe(tag);
	});

	it.each([
		["no workflow-core enabled", { ...pinned("v1.4.2"), enabledPlugins: {} }],
		[
			"a marketplace settings do not know",
			{ ...pinned("v1.4.2"), extraKnownMarketplaces: {} },
		],
		["no settings file", undefined],
		["a malformed settings file", "{ not json"],
	])(
		"fails on %s, where resolveCore() reads no pin either, naming the fix and writing no output",
		(_, settings) => {
			const root = adopter(settings);
			const r = runPinStep(root);
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain("pins no workflow-core tag (found: none)");
			expect(r.stderr).toContain("pin a release tag");
			expect(r.output).toBe("");
			expect(resolverPin(root)).toBe("none");
		},
	);

	it.each([
		["a branch pin", "main"],
		["a SHA pin", "b88b6baafe3998bb3f84a5aa495d4ab01c2945f4"],
	])("fails on %s, which names no release", (_, ref) => {
		const r = runPinStep(adopter(pinned(ref)));
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(`pins no workflow-core tag (found: ${ref})`);
		expect(r.output).toBe("");
	});

	it.each([
		["unset", {}],
		["empty", { DEPLOY_KEY: "" }],
	])(
		"stops an %s deploy key naming the secret, the pin and the setup doc (#458)",
		(_, key) => {
			const r = runKeyStep({ PIN: "v1.4.2", ...key });
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain("WORKFLOW_CORE_DEPLOY_KEY");
			expect(r.stderr).toContain("v1.4.2");
			expect(r.stderr).toContain("docs/agents/helper-surface.md");
		},
	);

	it("passes a present deploy key", () => {
		expect(runKeyStep({ PIN: "v1.4.2", DEPLOY_KEY: "key" }).status).toBe(0);
	});

	it("checks the core out at the pin step's tag, where WORKFLOW_CORE_CHECKOUT points, keeping no credentials", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template
		expect(coreCheckout?.with?.ref).toBe("${{ steps.core-pin.outputs.ref }}");
		expect(coreCheckout?.with?.["persist-credentials"]).toBe(false);
		expect(recipe?.env?.WORKFLOW_CORE_CHECKOUT).toBe(
			`\${{ github.workspace }}/${coreCheckout?.with?.path}`,
		);
	});

	it("reads the pin, then checks the key, before the core checkout (#458)", () => {
		const at = (s?: Step) => (s ? steps.indexOf(s) : -1);
		expect(at(pinStep)).toBeGreaterThanOrEqual(0);
		expect(at(pinStep)).toBeLessThan(at(keyStep));
		expect(at(keyStep)).toBeLessThan(at(coreCheckout));
	});
});
