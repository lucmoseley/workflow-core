/*
 * The fake of the launcher's fresh `claude --bg` and of `claude rm <id>`
 * (#4343): the installed harness's recorded answers
 * (scripts/fixtures/bg-launch.json, re-recorded by
 * `node scripts/record-claude-responses.js`), a launch's printed through
 * lib/claude-stub.ts's `buildBgBranch`, a removal's as a stub branch.
 *
 * Residual: no failed launch is recorded, since none is free — an unknown
 * flag and an untrusted directory both start a job (probed on 2.1.318).
 */

import fs from "node:fs";
import path from "node:path";
import { buildJobIdWord } from "./claude-stub";

/** `prompted`: `--bg <flags> -- <prompt>`, as guard-main-checkout-job.js
 * launches; `idle`: `--bg --agent claude --name <name>`, as start-session.sh
 * does. */
export type LaunchKind = "prompted" | "idle";
export type RmKind = "ok" | "noJob";

export interface Answer {
	id: string;
	status: number;
	stdout: string;
	stderr: string;
}

export const recorded: {
	harness: string;
	launches: Record<LaunchKind, Answer & { argv: string[] }>;
	removals: Record<RmKind, Answer>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "bg-launch.json"),
		"utf8",
	),
);

/** The recorded `kind` launch's answer naming job `id`, written into `dir`
 * as the `out` and `err` files `buildBgBranch` prints. */
export function writeLaunchAnswer(
	dir: string,
	id: string,
	kind: LaunchKind = "prompted",
) {
	const r = recorded.launches[kind];
	const out = path.join(dir, "bg-launch.out");
	const err = path.join(dir, "bg-launch.err");
	fs.writeFileSync(out, r.stdout.replaceAll(r.id, id));
	fs.writeFileSync(err, r.stderr.replaceAll(r.id, id));
	return { out, err };
}

/** The `rm` branch, removing job `$2`. */
export function buildRmBranch(kind: RmKind = "ok") {
	const r = recorded.removals[kind];
	return `if [ "$1" = "rm" ]; then printf '%s' ${buildJobIdWord(r.stdout, r.id)}; printf '%s' ${buildJobIdWord(r.stderr, r.id)} >&2; exit ${r.status}; fi`;
}
