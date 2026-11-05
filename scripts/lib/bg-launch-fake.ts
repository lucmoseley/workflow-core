/*
 * The fake of the launcher's fresh `claude --bg <flags> -- <prompt>` and of
 * `claude rm <id>` (#4343): the installed harness's recorded answers
 * (scripts/fixtures/bg-launch.json, re-recorded by
 * `node scripts/record-claude-responses.js`), the launch's printed through
 * lib/bg-resume-fake.ts's `buildBgBranch`, the removal's as a stub branch.
 */

import fs from "node:fs";
import path from "node:path";
import { buildJobIdWord } from "./claude-stub";

export type RmKind = "ok" | "noJob";

interface Answer {
	id: string;
	status: number;
	stdout: string;
	stderr: string;
}

export const recorded: {
	harness: string;
	launch: Answer & { argv: string[] };
	removals: Record<RmKind, Answer>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "bg-launch.json"),
		"utf8",
	),
);

/** The recorded launch's answer naming job `id`, written into `dir` as the
 * `out` and `err` files `buildBgBranch` prints. */
export function writeLaunchAnswer(dir: string, id: string) {
	const { launch } = recorded;
	const out = path.join(dir, "bg-launch.out");
	const err = path.join(dir, "bg-launch.err");
	fs.writeFileSync(out, launch.stdout.replaceAll(launch.id, id));
	fs.writeFileSync(err, launch.stderr.replaceAll(launch.id, id));
	return { out, err };
}

/** The `rm` branch: answers as the recording's `kind` removal, of job `$2`. */
export function buildRmBranch(kind: RmKind = "ok") {
	const r = recorded.removals[kind];
	return `if [ "$1" = "rm" ]; then printf '%s' ${buildJobIdWord(r.stdout, r.id)}; printf '%s' ${buildJobIdWord(r.stderr, r.id)} >&2; exit ${r.status}; fi`;
}
