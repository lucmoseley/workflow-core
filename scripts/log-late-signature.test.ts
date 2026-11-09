// @vitest-environment node
/*
 * Pins the late-signature backstop (#4796): a late line is logged only where
 * its signature matches its case, read across seats, and carries late: true.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "log-late-signature.js");
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let dir = "";
let repo = "";
let seat = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "late-sig-"));
	repo = path.join(dir, "repo");
	seat = path.join(dir, "home", ".claude");
	fs.mkdirSync(repo, { recursive: true });
	const proj = path.join(seat, "projects", "-x");
	fs.mkdirSync(proj, { recursive: true });
	fs.writeFileSync(
		path.join(proj, `${SESSION}.jsonl`),
		`${JSON.stringify({
			type: "user",
			uuid: "u1",
			message: { content: [{ type: "text", text: "lander dropped q/7" }] },
		})}\n`,
	);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (pattern: string) => {
	const sig = path.join(dir, "sig.json");
	fs.writeFileSync(
		sig,
		JSON.stringify({
			signature: { kind: "regex", pattern, scope: "main" },
			prediction: "no more drops",
			case: { session: SESSION, line: 1 },
		}),
	);
	return runInProcess(
		SCRIPT,
		[
			"--issue",
			"acme/widgets#7",
			"--filed-at",
			"2026-11-01T00:00:00Z",
			"--fault-signature",
			sig,
		],
		{
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: seat,
				CLAUDE_PROJECT_DIR: repo,
				WFC_REPO_ROOT: repo,
			},
			cwd: repo,
		},
	);
};
const log = () => path.join(repo, "docs", "data", "outcome-signatures.jsonl");

describe("log-late-signature.js", () => {
	it("logs a matching signature late", () => {
		const r = run("lander dropped q/\\d");
		expect(r.status).toBe(0);
		expect(JSON.parse(fs.readFileSync(log(), "utf8"))).toMatchObject({
			issue: "acme/widgets#7",
			filedAt: "2026-11-01T00:00:00Z",
			late: true,
			case: { session: SESSION, line: 1 },
		});
	});

	it("refuses a signature that misses its case, logging nothing", () => {
		const r = run("never said");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("does not match its case");
		expect(fs.existsSync(log())).toBe(false);
	});
});
