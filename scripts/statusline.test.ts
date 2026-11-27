// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { copyBlockPattern } from "./lib/settings-copy";
import { shellQuote } from "./lib/sh-quote.js";

const SGR = new RegExp(`${"\x1b"}\\[[0-9;]*m`, "g");

const DOC = path.resolve(__dirname, "..", "docs", "claude-user-settings.md");

let dir: string;
let script: string;
let home: string;
let repo: string;
let shims: string;
let spawned: string;

beforeAll(() => {
	const found = fs
		.readFileSync(DOC, "utf8")
		.match(copyBlockPattern("statusline.sh", "```bash"));
	if (!found) throw new Error(`no statusline.sh block in ${DOC}`);
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-"));
	script = path.join(dir, "statusline.sh");
	fs.writeFileSync(script, `${found[1]}\n`, { mode: 0o755 });
	repo = path.join(dir, "repo");
	fs.mkdirSync(repo);
	shims = path.join(dir, "shims");
	spawned = path.join(dir, "spawned");
	fs.mkdirSync(shims);
	for (const name of ["node", "claude"])
		fs.writeFileSync(
			path.join(shims, name),
			`#!/usr/bin/env bash\necho ${shellQuote(name)} >> ${shellQuote(spawned)}\n`,
			{ mode: 0o755 },
		);
});

beforeEach(() => {
	home = fs.mkdtempSync(path.join(dir, "home-"));
	fs.mkdirSync(path.join(home, ".claude"));
	fs.rmSync(spawned, { force: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const render = (projectDir = repo) => {
	const out = execFileSync("bash", [script], {
		input: JSON.stringify({
			session_id: "s1",
			workspace: { project_dir: projectDir },
		}),
		env: {
			...process.env,
			HOME: home,
			PATH: `${shims}:${process.env.PATH}`,
		},
		encoding: "utf8",
	});
	return out.replace(SGR, "").trimEnd();
};

const CONTEXT = " Ctx: 0/200,000 tok (0.0%)";
describe("the status line", () => {
	it("shows context usage", () => {
		expect(render()).toBe(CONTEXT);
	});

	it("spawns no node and no claude on a render", () => {
		render();
		expect(fs.existsSync(spawned)).toBe(false);
	});
});
