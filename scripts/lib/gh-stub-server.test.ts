// @vitest-environment node
/*
 * gh-stub-server.js through `serveGhStub`'s bash client, as a test's gh call
 * reaches it (#2877). SPAWNED, NOT RUN IN PROCESS (§X3's two-processes shape):
 * the server must answer while the call runs. Loosen a case and a suite on
 * this stub can pass on a gh call whose arguments, body or exit status never
 * reached its handler.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { type GhStubServer, serveGhStub, stubGhScript } from "./gh-stub";

const HANDLER = String.raw`
if (argv[0] === "echo") { out(JSON.stringify({ argv, cwd, stdin, sb: env.SB }) + "\n"); err("on stderr\n"); exit(3); }
if (argv[0] === "throw") throw new Error("handler broke");
if (argv[0] === "nul") { out("a\0b"); exit(0); }
out("fell through\n");
`;

let server: GhStubServer;
beforeAll(async () => {
	server = await serveGhStub(HANDLER);
});
afterAll(async () => {
	await server?.close();
});

let dir: string;
beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gh-stub-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const call = (args: string[], input?: string) =>
	spawnSync(stubGhScript(dir, server.script).gh, args, {
		cwd: dir,
		env: { ...process.env, SB: "a=b" },
		encoding: "utf8",
		input,
		maxBuffer: 8 * 1024 * 1024,
	});

it("hands the handler argv, cwd, the environment and a named stdin verbatim, and returns its streams and status", () => {
	const args = ["echo", "two words", "a\nnewline", "", "--body-file", "-"];
	const r = call(args, "body\n\nends\n");
	expect(r.stderr).toBe("on stderr\n");
	expect(r.status).toBe(3);
	expect(JSON.parse(r.stdout)).toEqual({
		argv: args,
		cwd: dir,
		stdin: "body\n\nends\n",
		sb: "a=b",
	});
});

it("reads no stdin where no argument names it", () => {
	const r = call(["echo"], "unread");
	expect(JSON.parse(r.stdout).stdin).toBe("");
});

it("exits 0 where the handler ends without exit, and 1 naming the error where it throws", () => {
	expect(call(["other"])).toMatchObject({
		status: 0,
		stdout: "fell through\n",
	});
	const r = call(["throw"]);
	expect(r.status).toBe(1);
	expect(r.stderr).toContain("Error: handler broke");
});

it("carries a body larger than one socket read whole, through the `x=@-` form too", () => {
	const body = "line of a long body\n".repeat(60_000);
	const r = call(["echo", "-F", "body=@-"], body);
	expect(r.status).toBe(3);
	expect(JSON.parse(r.stdout).stdin).toBe(body);
});

it("refuses, exit 1, an answer holding a NUL, naming why, rather than misaligning the streams", () => {
	const r = call(["nul"]);
	expect(r.status).toBe(1);
	expect(r.stdout).toBe("");
	expect(r.stderr).toBe(
		"gh stub: the handler answered a NUL, which the wire cannot carry\n",
	);
});

it("exits 70 naming the port where no server answers", async () => {
	const gone = await serveGhStub(HANDLER);
	await gone.close();
	const port = /tcp\/127\.0\.0\.1\/(\d+)/.exec(gone.script)?.[1];
	const r = spawnSync(stubGhScript(dir, gone.script).gh, ["echo"], {
		encoding: "utf8",
	});
	expect(r.status).toBe(70);
	expect(r.stderr).toBe(`gh stub: no answer from the server on port ${port}\n`);
});
