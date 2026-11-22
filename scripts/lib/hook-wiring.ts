import { isToolCovered, readRunningHooks } from "./core-hooks.js";
import type { HOOK_EVENTS } from "./hook-events.js";
import { coreRoot } from "./script-path.js";

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookRegistration {
	matcher?: string;
	command: string;
	args?: string[];
	if?: string;
	timeout?: number;
}

export function buildCommandLine(
	r: Pick<HookRegistration, "command" | "args">,
): string {
	return [r.command, ...(Array.isArray(r.args) ? r.args : [])].join(" ");
}

interface SettingsShape {
	hooks?: Partial<
		Record<HookEvent, Array<{ matcher?: string; hooks?: HookRegistration[] }>>
	>;
}

export function readCoreHooks(): SettingsShape {
	return { hooks: readRunningHooks(coreRoot()) };
}

export function registrationsOf(
	event: HookEvent,
	script: string,
	settings: SettingsShape = readCoreHooks(),
): HookRegistration[] {
	return allRegistrations(settings)
		.filter((r) => r.event === event && buildCommandLine(r).includes(script))
		.map((r) => ({
			matcher: r.matcher,
			command: r.command,
			...(r.args ? { args: r.args } : {}),
			...(r.if ? { if: r.if } : {}),
			timeout: r.timeout,
		}));
}

export function allRegistrations(
	settings: SettingsShape = readCoreHooks(),
): Array<HookRegistration & { event: string }> {
	return Object.entries(settings.hooks ?? {}).flatMap(([event, entries]) =>
		(entries ?? []).flatMap((entry) =>
			(entry.hooks ?? []).map((h) => ({
				event,
				matcher: entry.matcher,
				command: h.command ?? "",
				...(h.args ? { args: h.args } : {}),
				...(h.if ? { if: h.if } : {}),
				timeout: h.timeout,
			})),
		),
	);
}

export function hookIsWired(
	event: HookEvent,
	script: string,
	tool: string,
	settings: SettingsShape = readCoreHooks(),
): boolean {
	return registrationsOf(event, script, settings).some((r) =>
		isToolCovered(r.matcher, tool),
	);
}
