import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

export const AUTH_STATUS_FAKE = path.join(
	__dirname,
	"fixtures",
	"auth-status.js",
);

export function buildAuthStatusBranch(): string {
	return `if [ "$1" = "auth" ]; then exec ${shellQuote(process.execPath)} ${shellQuote(AUTH_STATUS_FAKE)}; fi`;
}

export function buildAuthStatusNodeBranch(): string {
	return `if (process.argv[2] === "auth") require(${JSON.stringify(AUTH_STATUS_FAKE)});`;
}

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
