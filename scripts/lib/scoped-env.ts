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

export function withOnlyEnv<T>(
	vars: Record<string, string | undefined>,
	fn: () => T,
): T {
	const unset = Object.fromEntries(
		Object.keys(process.env).map((name) => [name, undefined]),
	);
	return withStubbedEnv({ ...unset, ...vars }, fn);
}
