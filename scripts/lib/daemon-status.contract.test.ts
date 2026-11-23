// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_STATUS_FAKE } from "./auth-status-fake";
import { parseDaemonStatus } from "./daemon-status.js";

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

const RECORDED = path.join(__dirname, "fixtures", "daemon-status-running.txt");

const statusOf = (argv: string[], env: NodeJS.ProcessEnv) =>
	parseDaemonStatus(
		spawnSync(argv[0] as string, argv.slice(1), {
			env,
			encoding: "utf8",
			timeout: 30_000,
		}).stdout ?? "",
	);

const fakeStatus = (env: NodeJS.ProcessEnv) =>
	statusOf([process.execPath, AUTH_STATUS_FAKE, "daemon", "status"], env);

describe.skipIf(!realClaude)(
	"the daemon status fake against the real binary (#5607)",
	() => {
		it("reads no daemon on a config dir with none, as the binary does", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-status-"));
			try {
				const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
				const real = statusOf([realClaude as string, "daemon", "status"], env);
				expect(real).toEqual({ state: "none" });
				expect(fakeStatus(env)).toEqual(real);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);

describe("a running daemon's status, recorded by `claude daemon status | head -3 > scripts/lib/fixtures/daemon-status-running.txt` (#5607)", () => {
	it("reads the pid off the recording, as off the fake's", () => {
		expect(parseDaemonStatus(fs.readFileSync(RECORDED, "utf8"))).toEqual({
			state: "pid",
			pid: expect.stringMatching(/^\d+$/),
		});
		expect(fakeStatus({ ...process.env, WFC_FAKE_DAEMON: "4242" })).toEqual({
			state: "pid",
			pid: "4242",
		});
	});

	it("reads an unknown status as unread", () => {
		expect(parseDaemonStatus("daemon: confused\n")).toEqual({
			state: "unread",
		});
	});
});
