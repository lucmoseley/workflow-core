import { createRequire } from "node:module";
import { vi } from "vitest";

const { launchEnv } = createRequire(import.meta.url)("./suite-handoff.js");

export function stubLaunch(launch: Record<string, unknown>) {
	for (const [key, value] of Object.entries(launchEnv(launch)))
		vi.stubEnv(key, value as string);
}
