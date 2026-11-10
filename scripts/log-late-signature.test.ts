// @vitest-environment node
/*
 * Pins the late-signature backstop (#4796): a late line is logged only where
 * its signature matches its case, read across seats, and carries late: true;
 * its ticket is marked first, and --restore appends the line a ticket's body
 * records unchanged (#4861).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhHandler } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "log-late-signature.js");
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let dir = "";
let repo = "";
let seat = "";
let ghEnv: Record<string, string> = {};
const at = (f: string) => path.join(dir, f);
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
	/* The ticket's body lives in `body`; an edit rewrites it and logs its argv. */
	fs.writeFileSync(at("body"), "The lander drops refs.\n");
	ghEnv = stubGhHandler(
		dir,
		`
const fs = require("node:fs");
const at = (f) => ${JSON.stringify(dir)} + "/" + f;
if (argv[0] === "issue" && argv[1] === "view") out(JSON.stringify({ body: fs.readFileSync(at("body"), "utf8") }));
else if (argv[0] === "issue" && argv[1] === "edit" && fs.existsSync(at("edit-fails"))) { err("HTTP 502: bad gateway\\n"); exit(1); }
else if (argv[0] === "issue" && argv[1] === "edit") { fs.writeFileSync(at("body"), stdin); fs.appendFileSync(at("edits"), argv.join(" ") + "\\n"); }
else { err("unrouted: " + argv.join(" ") + "\\n"); exit(1); }
`,
	).env;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const runWith = (args: string[]) =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			...ghEnv,
			CLAUDE_CONFIG_DIR: seat,
			CLAUDE_PROJECT_DIR: repo,
			WFC_REPO_ROOT: repo,
		},
		cwd: repo,
	});

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
	return runWith([
		"--issue",
		"acme/widgets#7",
		"--filed-at",
		"2026-11-01T00:00:00Z",
		"--fault-signature",
		sig,
	]);
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

	it("marks the ticket with the label and the line in its body section", () => {
		expect(run("lander dropped q/\\d").status).toBe(0);
		expect(fs.readFileSync(at("edits"), "utf8")).toContain(
			"--add-label fault-signature",
		);
		const body = fs.readFileSync(at("body"), "utf8");
		expect(body).toMatch(/^The lander drops refs\.\n\n## Fault signature\n/);
		const { issue: _, ...rest } = JSON.parse(fs.readFileSync(log(), "utf8"));
		expect(body).toContain(`\`\`\`json\n${JSON.stringify(rest)}\n\`\`\``);
	});

	it("replaces a section already in the body, keeping the text after it", () => {
		fs.writeFileSync(
			at("body"),
			'Top.\n\n## Fault signature\n\n```json\n{"old":true}\n```\n\nStandalone: kept.\n',
		);
		expect(run("lander dropped q/\\d").status).toBe(0);
		const body = fs.readFileSync(at("body"), "utf8");
		expect(body).not.toContain('"old"');
		expect(body.match(/## Fault signature/g)).toHaveLength(1);
		expect(body).toMatch(
			/^Top\.\n\n## Fault signature\n[\s\S]*\n\nStandalone: kept\.\n$/,
		);
	});

	it("logs nothing where the ticket cannot be marked", () => {
		fs.writeFileSync(at("edit-fails"), "");
		const r = run("lander dropped q/\\d");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("acme/widgets#7");
		expect(r.stderr).toContain("nothing was logged");
		expect(r.stderr).toContain("Run it again.");
		expect(fs.existsSync(log())).toBe(false);
	});

	it("--restore appends the line the body records, unchanged", () => {
		expect(run("lander dropped q/\\d").status).toBe(0);
		const original = fs.readFileSync(log(), "utf8");
		fs.rmSync(log());
		const r = runWith(["--restore", "acme/widgets#7"]);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(log(), "utf8")).toBe(original);
	});

	it("--restore refuses a ticket whose section is gone, naming the late fallback", () => {
		const r = runWith(["--restore", "acme/widgets#7"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("unrecoverable");
		expect(r.stderr).toContain("--fault-signature");
		expect(fs.existsSync(log())).toBe(false);
	});

	it("refuses a signature that misses its case, logging nothing", () => {
		const r = run("never said");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("does not match its case");
		expect(fs.existsSync(log())).toBe(false);
	});
});
