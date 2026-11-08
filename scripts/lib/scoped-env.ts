/*
 * Runs `fn` with `vars` stubbed, then stubs back the values they held, for a
 * test helper whose caller reads the same variables later in the same test
 * (#4019). unstubEnvs still restores the originals before the next test.
 */
import { vi } from "vitest";

export function withStubbedEnv<T>(
	vars: Record<string, string | undefined>,
	fn: () => T,
): T {
	const held = Object.keys(vars).map((name) => [name, process.env[name]]);
	for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
	try {
		return fn();
	} finally {
		for (const [name, value] of held) vi.stubEnv(String(name), value);
	}
}
