/*
 * hook-wiring.ts — what the repo's hooks actually register.
 *
 * A guard's own tests prove its logic. Claude Code cannot run inside a test, so
 * none of them sees whether the registration runs the guard on the right event and
 * matcher — and mantahostels#112 and mantahostels#117 both shipped guards that were built but never
 * wired (mantahostels#190).
 *
 * Every function here takes an already-parsed settings-shaped object, so
 * parsing is testable against a literal; the default reads this repo's real
 * registration through lib/core-hooks.js.
 */

import { runningHooks } from "./core-hooks.js";
import { hostRoot } from "./host-root.js";

/**
 * The events a hook registers on. A closed set deliberately: as a bare
 * string, a misspelt event finds no registration and reads as "not wired".
 * A typo is a compile error instead.
 */
export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"PreCompact",
	"SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** One hook's registration, flattened out of the entry that carries its matcher. */
export interface HookRegistration {
	/** Absent on the events that take no matcher — Stop, SessionStart, UserPromptSubmit. */
	matcher?: string;
	command: string;
	/**
	 * The exec form's argument list (mantahostels#2059), absent on the shell form. It holds
	 * the script path where `command` is a bare interpreter, and the guard's own
	 * arguments either way — so a reader matching on `command` alone cannot tell
	 * two registrations of one script apart. Match through `commandLine` below.
	 */
	args?: string[];
	/**
	 * The entry's `if` narrowing, absent where it declares none. One script is
	 * registered several times over — once per permission rule, the field holding
	 * exactly one (hooks.md:432) — so this is what tells those entries apart, as
	 * `args` tells two differently-argued registrations apart above (mantahostels#2811).
	 */
	if?: string;
	/** Absent where the entry declares none, which is an unbounded hook. */
	timeout?: number;
}

/**
 * One registration as a single command line — `command` and its `args` joined,
 * the spelling the transcript records and the only one both hook forms share
 * (mantahostels#2266).
 *
 * A malformed `args` contributes nothing rather than throwing, matching the
 * same tolerance in `rule-emission.js`'s `hookCommandLine`. The duplication
 * between the two is mantahostels#1932's — this module is TypeScript and its JS consumers
 * cannot import it.
 */
export function commandLine(
	r: Pick<HookRegistration, "command" | "args">,
): string {
	return [r.command, ...(Array.isArray(r.args) ? r.args : [])].join(" ");
}

interface SettingsShape {
	hooks?: Partial<
		Record<HookEvent, Array<{ matcher?: string; hooks?: HookRegistration[] }>>
	>;
}

/** The hooks this repo runs (lib/core-hooks.js's `runningHooks`), settings-shaped. */
export function readCoreHooks(): SettingsShape {
	return { hooks: runningHooks(hostRoot()) };
}

/**
 * Every registration of `script` on `event`. A script registered twice comes
 * back twice — the count is load-bearing wherever a test reads a timeout, since
 * one of two registrations is whichever happened to sort first.
 */
export function registrationsOf(
	event: HookEvent,
	script: string,
	settings: SettingsShape = readCoreHooks(),
): HookRegistration[] {
	return allRegistrations(settings)
		.filter((r) => r.event === event && commandLine(r).includes(script))
		.map((r) => ({
			matcher: r.matcher,
			command: r.command,
			...(r.args ? { args: r.args } : {}),
			...(r.if ? { if: r.if } : {}),
			timeout: r.timeout,
		}));
}

/**
 * Every registration in the file, tagged with the event key carrying it.
 *
 * The key is read from the file rather than from `HookEvent`, so a hook
 * registered on an event this module does not know — `PreCompact`,
 * `SessionEnd`, any Claude Code adds next — still comes back.
 */
export function allRegistrations(
	settings: SettingsShape = readCoreHooks(),
): Array<HookRegistration & { event: string }> {
	return Object.entries(settings.hooks ?? {}).flatMap(([event, entries]) =>
		(entries ?? []).flatMap((entry) =>
			(entry.hooks ?? []).map((h) => ({
				event,
				matcher: entry.matcher,
				command: h.command ?? "",
				/* hook-registrations.test.ts's ids embed the arguments that tell two
				 * registrations of one script apart, so `args` must survive (mantahostels#2266). */
				...(h.args ? { args: h.args } : {}),
				/* And `if` (mantahostels#2811), the only thing separating one
				 * script's several narrowed registrations. */
				...(h.if ? { if: h.if } : {}),
				timeout: h.timeout,
			})),
		),
	);
}

/**
 * Does `event` really run `script` for a matcher covering `tool`? Anchored, so
 * a matcher of `Write` does not answer for `WriteFile`; an entry with no matcher
 * covers every tool.
 */
export function hookIsWired(
	event: HookEvent,
	script: string,
	tool: string,
	settings: SettingsShape = readCoreHooks(),
): boolean {
	return registrationsOf(event, script, settings).some(
		(r) => r.matcher === undefined || new RegExp(`^(${r.matcher})$`).test(tool),
	);
}
