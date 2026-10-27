/*
 * The fake of the launcher's `claude --bg --resume` response: the installed
 * harness's recorded responses (scripts/fixtures/bg-resume.json, re-recorded
 * by `node scripts/record-claude-responses.js`), each re-keyed to a test's job ids
 * (#2968).
 */

import fs from "node:fs";
import path from "node:path";

export type ResumeKind = "copy" | "woke";

interface Response {
	resumed: string;
	stdout: string;
	stderr: string;
	startedAs: string;
}

export const recorded: {
	harness: string;
	responses: Record<ResumeKind, Response>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "bg-resume.json"),
		"utf8",
	),
);

export const FAKE_COPY = "c0de7a11";

export function buildRekeyedResponse(
	kind: ResumeKind,
	resumed: string,
	copy: string,
): Response {
	const r = recorded.responses[kind];
	const startedAs = kind === "copy" ? copy : resumed;
	const swap = (text: string) =>
		text
			.replaceAll(r.startedAs, "\0")
			.replaceAll(r.resumed, resumed)
			.replaceAll("\0", startedAs);
	return {
		resumed,
		stdout: swap(r.stdout),
		stderr: swap(r.stderr),
		startedAs,
	};
}
