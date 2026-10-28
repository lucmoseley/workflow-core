/*
 * The `auth status` branch of a `claude` stub, which every launch site's
 * lib/launch-auth.js check calls before its launch (#2236). It hands off to
 * the fake program, lib/fixtures/auth-status.js, before the stub logs its
 * argv, so a suite's launch log holds the launches alone.
 */

import fs from "node:fs";
import path from "node:path";

export const AUTH_STATUS_FAKE = path.join(
	__dirname,
	"fixtures",
	"auth-status.js",
);

/** The branch, for a bash stub, placed right after its shebang. */
export function buildAuthStatusBranch(): string {
	return `if [ "$1" = "auth" ]; then exec ${JSON.stringify(process.execPath)} ${JSON.stringify(AUTH_STATUS_FAKE)}; fi`;
}

/** The branch, for a node stub, placed right after its shebang. */
export function buildAuthStatusNodeBranch(): string {
	return `if (process.argv[2] === "auth") require(${JSON.stringify(AUTH_STATUS_FAKE)});`;
}

/**
 * The launch environments #2236 names, each by what its refusal names. The
 * apiKeyHelper case is the seat's settings, so a site whose cwd is fixed is
 * judged on it too: `writeSeatHelper` writes it.
 */
export const REFUSED_AUTH: [string, Record<string, string>][] = [
	["ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "k" }],
	["ANTHROPIC_AUTH_TOKEN", { ANTHROPIC_AUTH_TOKEN: "t" }],
	["ANTHROPIC_BASE_URL", { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }],
	["CLAUDE_CODE_USE_BEDROCK", { CLAUDE_CODE_USE_BEDROCK: "1" }],
];
export const ADMITTED_AUTH: [string, Record<string, string>][] = [
	["a plain seat", {}],
	["CLAUDE_CODE_OAUTH_TOKEN", { CLAUDE_CODE_OAUTH_TOKEN: "t" }],
];

export function writeSeatHelper(configDir: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "settings.json"),
		JSON.stringify({ apiKeyHelper: "echo k" }),
	);
}
