/*
 * transcript-testkit.ts — session-transcript records for the tests that drive
 * guard-priced-options.js over a fixture transcript, and the fail-open log
 * those runs leave under a redirected config directory (#943); and
 * `buildToolCall` and `buildBashCall`, the shared assistant tool-call records
 * (#1413, #2006).
 */

import fs from "node:fs";
import path from "node:path";
import { MIN_CALLS } from "./round-check.js";

/** Past the wall clock the guard stamps its record with, so a record stamped
 * this far ahead follows it. A guess: any margin past one case's wall time. */
export const LATER = 60_000;

/**
 * Record builders stamped one second apart from `start`. A case that moves the
 * clock leaves it moved for the next, so call `reset` in `beforeEach`.
 */
export function transcriptRecords(start: string) {
	const origin = Date.parse(start);
	let clock = origin;
	const at = () => {
		clock += 1000;
		return new Date(clock).toISOString();
	};
	const user = (content: unknown, extra: Record<string, unknown> = {}) =>
		JSON.stringify({
			type: "user",
			...extra,
			timestamp: at(),
			message: { role: "user", content },
		});
	const stopFeedback = () =>
		user("Stop hook feedback: refused", { isMeta: true });
	/** Stamp every later record after `ms`, a real-epoch time. */
	const stampAfter = (ms: number) => {
		clock = ms;
	};
	return {
		reset: () => {
			clock = origin;
		},
		stampAfter,
		/** `extra` sets top-level keys — `isSidechain`, `requestId`. */
		assistant: (text: string, extra: Record<string, unknown> = {}) =>
			JSON.stringify({
				type: "assistant",
				...extra,
				timestamp: at(),
				message: { role: "assistant", content: [{ type: "text", text }] },
			}),
		founder: (text = "go") => user(text, { origin: { kind: "human" } }),
		toolResult: () =>
			user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
		notification: () =>
			user(
				"<task-notification>\n<tool-use-id>t1</tool-use-id>\n</task-notification>",
				{ origin: { kind: "task-notification" } },
			),
		stopFeedback,
		/** Another Stop hook refusing the turn, after the guard's own record. */
		siblingBlock: () => {
			stampAfter(Date.now() + LATER);
			return stopFeedback();
		},
		skillBody: () =>
			user([{ type: "text", text: "Base directory for this skill: x" }], {
				isMeta: true,
			}),
	};
}

interface BashCallOptions {
	input?: Record<string, unknown>;
	sessionId?: string;
	timestamp?: string;
	uuid?: string;
	isSidechain?: boolean;
}

/**
 * An assistant record carrying one `tool_use` of any tool, as an object for
 * the caller to stringify:
 * `{type: "assistant", ...extra, message: {role: "assistant", content:
 * [{type: "tool_use", id, name, input}]}}`.
 */
export const buildToolCall = (
	name: string,
	input: Record<string, unknown>,
	id = "t1",
	extra: Omit<BashCallOptions, "input"> = {},
) => ({
	type: "assistant",
	...extra,
	message: {
		role: "assistant",
		content: [{ type: "tool_use", id, name, input }],
	},
});

/** `buildToolCall` for one Bash `command`, `input` adding to its input. */
export const buildBashCall = (
	command: string,
	id = "t1",
	{ input = {}, ...extra }: BashCallOptions = {},
) => buildToolCall("Bash", { command, ...input }, id, extra);

/**
 * `n` Bash calls, as objects. The default is the research the
 * under-researched-round limb asks for before a round (#1710), for a fixture
 * whose round is under test for something else.
 */
export const researchCalls = (n: number = MIN_CALLS) =>
	Array.from({ length: n }, (_, i) => buildBashCall("ls", `t-research-${i}`));

export const writeTranscript = (file: string, ...lines: string[]) =>
	fs.writeFileSync(file, `${lines.join("\n")}\n`);

/** Every line the fail-open log holds, wherever under `config` it landed. */
export function failOpenLog(config: string): string {
	const found: string[] = [];
	const walk = (at: string) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			const full = path.join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.push(fs.readFileSync(full, "utf8"));
		}
	};
	if (fs.existsSync(config)) walk(config);
	return found.join("");
}
