/*
 * The fake of `claude attach <job>`, which the refill loop types its resume
 * into through pty_type.py (#2354 F6): held to the installed harness's
 * recorded exits (scripts/fixtures/claude-attach.json, re-recorded by
 * `node scripts/record-claude-responses.js`) by
 * lib/claude-attach.contract.test.ts (#3014).
 */

import fs from "node:fs";
import path from "node:path";

export type AttachKind = "offTerminal" | "onTerminal";

export const recorded: {
	harness: string;
	responses: Record<AttachKind, { status: number }>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "claude-attach.json"),
		"utf8",
	),
);

/**
 * The `attach` branch of a bash `claude` stub, logging to `log`. The typed
 * line is taken at once, which the contract does not hold: the loop's
 * timeline check catches a line the harness never takes. Off a terminal the
 * fake exits 0, as the recording does, so the tests' `typed <prompt>` log
 * assertions are the check on an attach with no pty.
 */
export function buildAttachBranch(log: string) {
	const to = JSON.stringify(log);
	return `if [ "$1" = "attach" ]; then
  [ -t 0 ] || exit ${recorded.responses.offTerminal.status}
  echo "$*" >> ${to}; printf '> '; IFS= read -r line; echo "typed $line" >> ${to}; exit 0
fi`;
}
