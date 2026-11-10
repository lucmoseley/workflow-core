/*
 * workflow-yaml-testkit.ts — a GitHub workflow's YAML, parsed and typed, so
 * each workflow test holds no js-yaml binding and no shapes of its own (#4818).
 *
 * Callers pass the path composed at the call site, `path.join(ROOT, …)`, so
 * the read-edge extractor still attributes the workflow file to the test.
 */

import fs from "node:fs";
import { createRequire } from "node:module";

// Through `require`: js-yaml ships no types, and only its load is needed.
const yaml: { load: (text: string) => unknown } = createRequire(
	import.meta.url,
)("js-yaml");

export interface Step {
	id?: string;
	name?: string;
	uses?: string;
	run?: string;
	env?: Record<string, unknown>;
	with?: Record<string, unknown>;
}

export interface Job {
	name?: string;
	if?: string;
	env?: Record<string, unknown>;
	strategy?: { matrix?: Record<string, unknown[]> };
	steps?: Step[];
}

export interface Workflow {
	name?: string;
	on?: {
		schedule?: { cron: string }[];
		workflow_dispatch?: { inputs?: Record<string, { type?: string }> };
	};
	jobs: Record<string, Job>;
}

/** A job's YAML, or a fragment of one, parsed from text a test read itself. */
export function parseJob(text: string): Job {
	return yaml.load(text) as Job;
}

/** The workflow at `file`, parsed. */
export function loadWorkflow(file: string): Workflow {
	return yaml.load(fs.readFileSync(file, "utf8")) as Workflow;
}
