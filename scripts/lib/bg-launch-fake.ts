/*
 * The fake of the launcher's fresh `claude --bg` and of `claude rm <id>`
 * (#4343): the installed harness's recorded answers
 * (scripts/fixtures/bg-launch.json, re-recorded by
 * `node scripts/record-claude-responses.js`), a launch's printed through
 * lib/claude-stub.ts's `buildBgBranch`, a removal's as a stub branch.
 *
 * Residual: no failed launch is recorded, since none is free — an unknown
 * flag and an untrusted directory both start a job (probed on 2.1.318) — so
 * `unrecorded`'s answers are written by hand.
 */

import fs from "node:fs";
import path from "node:path";
import { buildJobIdWord } from "./claude-stub";
import { shellQuote } from "./sh-quote.js";

/** `prompted`: `--bg <flags> -- <prompt>`, as guard-main-checkout-job.js
 * launches; `idle`: `--bg --agent claude --name <name>`, as start-session.sh
 * does; `positional`: `--bg <flags> <prompt>`, as dispatch-sessions.sh and
 * run-arm-test.js do; `named`: `--bg <flags> -n <name> <prompt>`, as
 * dispatch-sessions.sh's overflow launch. */
export type LaunchKind = "prompted" | "idle" | "positional" | "named";
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

/** Launches no recording shows: one that printed nothing, and one that
 * refused to start. */
export const unrecorded = {
	silent: { status: 0, stdout: "", stderr: "" },
	refused: { status: 1, stdout: "", stderr: "could not start\n" },
};

/** The recorded `kind` launch's answer, naming job `id`. */
export function launchAnswer(id: string, kind: LaunchKind = "prompted") {
	const r = recorded.launches[kind];
	return {
		stdout: r.stdout.replaceAll(r.id, id),
		stderr: r.stderr.replaceAll(r.id, id),
	};
}

/** The recorded `kind` launch's answer naming job `id`, written into `dir`
 * as the `out` and `err` files `buildBgBranch` prints. */
export function writeLaunchAnswer(
	dir: string,
	id: string,
	kind: LaunchKind = "prompted",
) {
	const { stdout, stderr } = launchAnswer(id, kind);
	const out = path.join(dir, "bg-launch.out");
	const err = path.join(dir, "bg-launch.err");
	fs.writeFileSync(out, stdout);
	fs.writeFileSync(err, stderr);
	return { out, err };
}

/** A stub's lines answering a launch with `unrecorded[kind]`. */
export function buildUnrecordedBranch(kind: keyof typeof unrecorded) {
	const r = unrecorded[kind];
	return `printf '%s' ${shellQuote(r.stdout)}; printf '%s' ${shellQuote(r.stderr)} >&2; exit ${r.status}`;
}

/** A Node stub's statements printing the recorded `kind` launch's answer
 * naming the job the JavaScript expression `idExpr` evaluates to. */
export function buildLaunchNodeAnswer(
	idExpr: string,
	kind: LaunchKind = "prompted",
) {
	const r = recorded.launches[kind];
	const print = (stream: string, text: string) =>
		`process.${stream}.write(${JSON.stringify(text)}.replaceAll(${JSON.stringify(r.id)},${idExpr}));`;
	return `${print("stdout", r.stdout)}${print("stderr", r.stderr)}`;
}

/** The `rm` branch, removing job `$2`. */
export function buildRmBranch(kind: RmKind = "ok") {
	const r = recorded.removals[kind];
	return `if [ "$1" = "rm" ]; then printf '%s' ${buildJobIdWord(r.stdout, r.id)}; printf '%s' ${buildJobIdWord(r.stderr, r.id)} >&2; exit ${r.status}; fi`;
}
