import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BIND_TIMEOUT_MS = 10_000;

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
		{ cwd: path.dirname(socketPath), env, timeout: BIND_TIMEOUT_MS },
	);
};
