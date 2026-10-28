// @vitest-environment node
/*
 * Holds lib/fixtures/auth-status.js, the fake every launch site's `claude`
 * stub answers `auth status` through, to the installed binary (#2236). The
 * real `auth status` makes no model call, so each live case is free. Breaking
 * it costs lib/launch-auth.js: a fake reporting an auth the harness ranks
 * otherwise passes a site's admit case while the real launch bills per token.
 *
 * The live cases run under a scratch CLAUDE_CONFIG_DIR, which #838 keeps
 * every test to, so the real binary has no login there: the fake's no-login
 * mode stands beside it.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH_STATUS_FAKE, writeSeatHelper } from "./auth-status-fake";

const run = promisify(execFile);

const realClaude = (process.env.PATH ?? "")
	.split(path.delimiter)
	.map((d) => path.join(d, "claude"))
	.find((f) => {
		try {
			fs.accessSync(f, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});

const CASES: [string, Record<string, string>, boolean][] = [
	/* The real binary ignores the fake's knob. */
	["no login", { WFC_FAKE_AUTH_NO_LOGIN: "1" }, false],
	["an API key", { ANTHROPIC_API_KEY: "k" }, false],
	["an auth token", { ANTHROPIC_AUTH_TOKEN: "t" }, false],
	["the subscription token", { CLAUDE_CODE_OAUTH_TOKEN: "t" }, false],
	[
		"an auth token over a key",
		{ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" },
		false,
	],
	[
		"a key over the subscription token",
		{ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" },
		false,
	],
	[
		"Bedrock over a key",
		{ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "k" },
		false,
	],
	["Vertex", { CLAUDE_CODE_USE_VERTEX: "1" }, false],
	["Foundry", { CLAUDE_CODE_USE_FOUNDRY: "1" }, false],
	["a helper", {}, true],
	["a helper over a key", { ANTHROPIC_API_KEY: "k" }, true],
	[
		"a helper over the subscription token",
		{ CLAUDE_CODE_OAUTH_TOKEN: "t" },
		true,
	],
	["an auth token over a helper", { ANTHROPIC_AUTH_TOKEN: "t" }, true],
];

/* The seat's own settings carry the helper; the plain project does not. */
const SEAT_CASES: [string, Record<string, string>][] = [
	["a seat's helper", {}],
	["a seat's helper over a key", { ANTHROPIC_API_KEY: "k" }],
];

let dir = "";
let plain = "";
let helped = "";
let helpedSeat = "";

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-status-contract-"));
	plain = path.join(dir, "plain");
	helped = path.join(dir, "helped");
	fs.mkdirSync(plain);
	helpedSeat = path.join(dir, "helped-seat");
	writeSeatHelper(helpedSeat);
	fs.mkdirSync(path.join(helped, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(helped, ".claude", "settings.json"),
		JSON.stringify({ apiKeyHelper: "echo k" }),
	);
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function readStatusOf(
	argv: string[],
	env: Record<string, string>,
	cwd: string,
) {
	/* With no login the binary exits 1, still printing its JSON. */
	const { stdout, code } = await run(argv[0], argv.slice(1), {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			...env,
		},
	}).then(
		(r) => ({ stdout: r.stdout, code: 0 }),
		(e: { stdout: string; code: number }) => ({
			stdout: e.stdout,
			code: e.code,
		}),
	);
	const status = JSON.parse(stdout);
	return {
		code,
		authMethod: status.authMethod,
		shape: {
			loggedIn: typeof status.loggedIn,
			authMethod: typeof status.authMethod,
			apiProvider: typeof status.apiProvider,
		},
	};
}

describe.skipIf(!realClaude)(
	"the auth status fake against the real binary",
	() => {
		it("reports the authMethod the binary does, in its precedence and its shape", async () => {
			const pairs = await Promise.all(
				[
					...CASES.map(([name, env, helper]) => ({
						name,
						env,
						cwd: helper ? helped : plain,
					})),
					...SEAT_CASES.map(([name, env]) => ({
						name,
						env: { ...env, CLAUDE_CONFIG_DIR: helpedSeat },
						cwd: plain,
					})),
				].map(async ({ name, env, cwd }) => {
					const [real, fake] = await Promise.all([
						readStatusOf(
							[realClaude as string, "auth", "status", "--json"],
							env,
							cwd,
						),
						readStatusOf([process.execPath, AUTH_STATUS_FAKE], env, cwd),
					]);
					return { name, real, fake };
				}),
			);
			for (const p of pairs) expect(p.fake, p.name).toEqual(p.real);
		}, 60_000);
	},
);
