/*
 * The launch record a test's process reads, set the way `run-vitest.js` sets
 * it, so a reporter, teardown or launcher test can say how the run was
 * launched without spelling the environment key.
 *
 * Every test worker inherits the real launch of the run driving the suite, so
 * a test that leaves its own behind makes THAT run's teardown stamp it.
 * vitest.config.ts's `unstubEnvs` undoes `stubLaunch` before the next test.
 */

import { createRequire } from "node:module";
import { vi } from "vitest";

const { launchEnv } = createRequire(import.meta.url)("./suite-handoff.js");

/** @param launch the record's fields; the rest read as absent */
export function stubLaunch(launch: Record<string, unknown>) {
	for (const [key, value] of Object.entries(launchEnv(launch)))
		vi.stubEnv(key, value as string);
}
