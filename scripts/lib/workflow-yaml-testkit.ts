import fs from "node:fs";
import { createRequire } from "node:module";

const yaml: { load: (text: string) => unknown } = createRequire(
	import.meta.url,
)("js-yaml");

export interface Step {
	id?: string;
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

export function parseJob(text: string): Job {
	return yaml.load(text) as Job;
}

export function loadWorkflow(file: string): Workflow {
	return yaml.load(fs.readFileSync(file, "utf8")) as Workflow;
}
