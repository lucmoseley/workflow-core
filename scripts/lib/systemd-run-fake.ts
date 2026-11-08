/*
 * systemd-run-fake.ts — a stub `systemd-run` for tests of the outliving
 * launch (#4706), injected at WFC_SYSTEMD_RUN (lib/systemd-bins.js) and held
 * to the real one by systemd-run.contract.test.ts (§G7). It records each
 * call's words and the session keys its environment carries, then execs the
 * command after `--` as `--scope` does; with `answers` false every call fails
 * as one with no user manager does.
 *
 * FOR TESTS ONLY.
 */
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

const PROBE = "--user --scope --quiet -- true";

export interface SystemdRunCall {
	/** Its words up to the command, `--` included. */
	words: string;
	/** The command `--` names, and its arguments. */
	command: string;
	/** The session keys the call's environment carries, "" where unset. */
	sid: string;
	job: string;
	owner: string;
}

/**
 * @returns its path, and the calls it has recorded, the probe's left out
 */
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
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$words--" "$*" "\${CLAUDE_CODE_SESSION_ID-}" "\${CLAUDE_JOB_DIR-}" "\${WFC_REPORT_OWNER-}" >> ${q}
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
					const [words = "", command = "", sid = "", job = "", owner = ""] =
						l.split("\t");
					return { words, command, sid, job, owner };
				}),
	};
}
