/*
 * full-pipe-testkit.ts — what a reader sees of a node process writing into a
 * pipe that is already full, for the suites pinning lib/write-fd.js's callers
 * (#1631, #1635, #1641).
 */

import { spawnSync } from "node:child_process";

/* A pipe's default capacity on Linux, so the padding leaves no room. */
const FULL_PIPE_BYTES = 65_536;

/**
 * What a reader of `fd` sees when node, run with `argv`, writes into a full
 * pipe and exits, its exit code appended as `exit <n>`. The reader waits a
 * second, so a write node queued is dropped by process.exit before anything
 * reads, where a synchronous one blocks until the reader drains. The second is
 * a guess at node's start-up, and a slower start only lets a queued write
 * pass, never fails a synchronous one. Spawned through a real pipe: in
 * process, runInProcess captures every write route alike.
 * @param fd the stream under test; the other goes to /dev/null
 * @param argv node's arguments, the script's path included
 * @param opts the child's cwd and env, each the runner's own where left out
 */
export const throughFullPipe = (
	fd: 1 | 2,
	argv: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) => {
	const [to, route] =
		fd === 2 ? [" >&2", " 2>&1 >/dev/null"] : ["", " 2>/dev/null"];
	return spawnSync(
		"sh",
		[
			"-c",
			`{ head -c ${FULL_PIPE_BYTES} /dev/zero${to}; "$0" "$@"; echo "exit $?"${to}; }${route} | { sleep 1; tr -d "\\000"; }`,
			process.execPath,
			...argv,
		],
		// A ceiling on a hang, far above the ~1 s the pipe's reader sleeps.
		{ encoding: "utf8", ...opts, timeout: 20_000 },
	).stdout;
};
