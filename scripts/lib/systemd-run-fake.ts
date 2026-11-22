import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

const PROBE = "--user --scope --quiet -- true";

export interface SystemdRunCall {
	words: string;
	command: string;
	sid: string;
	job: string;
	owner: string;
	outlives: string;
}

export function writeSystemdRun(dir: string, { answers = true } = {}) {
	const bin = path.join(dir, "systemd-run");
	const log = path.join(dir, "systemd-run.calls");
	const q = shellQuote(log);
	fs.writeFileSync(
		bin,
		`#!/bin/sh
[ "$*" = ${shellQuote(PROBE)} ] && { echo probe >> ${q}; exit ${answers ? 0 : 1}; }
${answers ? "" : "exit 1\n"}words=
while [ $# -gt 0 ] && [ "$1" != -- ]; do words="$words$1 "; shift; done
shift
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$words--" "$*" "\${CLAUDE_CODE_SESSION_ID-}" "\${CLAUDE_JOB_DIR-}" "\${WFC_REPORT_OWNER-}" "\${WFC_OUTLIVES-}" >> ${q}
exec "$@"
`,
		{ mode: 0o755 },
	);
	const lines = () => {
		try {
			return fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};
	return {
		bin,
		probes: () => lines().filter((l) => l === "probe").length,
		calls: (): SystemdRunCall[] =>
			lines()
				.filter((l) => l !== "probe")
				.map((l) => {
					const [
						words = "",
						command = "",
						sid = "",
						job = "",
						owner = "",
						outlives = "",
					] = l.split("\t");
					return { words, command, sid, job, owner, outlives };
				}),
	};
}
