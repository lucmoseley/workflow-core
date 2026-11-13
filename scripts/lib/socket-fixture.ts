/*
 * socket-fixture.ts — a real Unix socket on disk at a given path. FOR TESTS
 * ONLY.
 *
 * A child process binds it and exits at once; the socket file stays behind.
 * The child binds the socket's bare name from its own directory, because
 * sun_path holds 108 bytes and a nested temp root's absolute path can pass
 * that (#5162, #5177). A child is needed for that: process.chdir is not
 * available in a vitest worker thread.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const plantSocket = (
	socketPath: string,
	env: NodeJS.ProcessEnv = process.env,
): void => {
	fs.mkdirSync(path.dirname(socketPath), { recursive: true });
	execFileSync(
		process.execPath,
		[
			"-e",
			"require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))",
			path.basename(socketPath),
		],
		{ cwd: path.dirname(socketPath), env, timeout: 10_000 },
	);
};
