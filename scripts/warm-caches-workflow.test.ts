// @vitest-environment node

/*
 * .github/workflows/warm-caches.yml's Node matrix against every job that calls
 * .github/actions/node-deps (#4661). node-deps keys its cache on the Node
 * major, so a caller on a major the matrix lacks misses on every batch until a
 * scheduled main run saves its entry.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "./lib/precommit-gate-testkit";

// Through `require`: js-yaml ships no types.
const yaml = createRequire(import.meta.url)("js-yaml");

interface Step {
	uses?: string;
	with?: { "node-version"?: string | number };
}
interface Job {
	steps?: Step[];
	strategy?: { matrix?: { node?: number[] } };
}
interface Workflow {
	jobs: Record<string, Job>;
}

const WORKFLOWS = path.join(ROOT, ".github/workflows");
const WARM = "warm-caches.yml";
const load = (file: string) =>
	yaml.load(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as Workflow;

it("warms node_modules on every Node major a node-deps caller sets up", () => {
	const callers = new Set<string>();
	for (const file of fs.readdirSync(WORKFLOWS)) {
		if (file === WARM || !/\.ya?ml$/.test(file)) continue;
		for (const [name, job] of Object.entries(load(file).jobs)) {
			const steps = job.steps ?? [];
			if (!steps.some((s) => s.uses === "./.github/actions/node-deps"))
				continue;
			const version = steps.find((s) =>
				s.uses?.startsWith("actions/setup-node@"),
			)?.with?.["node-version"];
			expect(version, `${file} ${name} sets no node-version`).toBeDefined();
			callers.add(String(version).split(".")[0] as string);
		}
	}
	const warmed = load(WARM).jobs["node-deps"]?.strategy?.matrix?.node ?? [];
	expect(callers.size).toBeGreaterThan(0);
	expect(new Set(warmed.map(String))).toEqual(callers);
});
