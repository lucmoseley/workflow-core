import { spawnSync } from "node:child_process";

const FULL_PIPE_BYTES = 65_536;
// guess, #5529
const HANG_CEILING_MS = 20_000;

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
		{ encoding: "utf8", ...opts, timeout: HANG_CEILING_MS },
	).stdout;
};
