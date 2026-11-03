// @vitest-environment node
/*
 * The status line carries burn mode only as its restart warning, while this
 * session's model is out of step with the marker (#4062): the refill panel
 * cannot know a session's boot state, and shows the plain on and off itself.
 *
 * The script is machine-level, at ~/.claude/statusline.sh, so what runs here
 * is its reference copy in docs/claude-user-settings.md; `npm run
 * check:settings` holds it to the live file. A miss here shows a burn mode
 * flip as nothing, leaves a session on the wrong model unwarned, or spends a
 * node start on every render of every session.
 */

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
	// A checkout with scripts/burn-mode.sh, so the workflow-core gate opens.
	repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(repo, "scripts", "burn-mode.sh"), "");
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

/** One render, colour codes stripped. */
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
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are what is stripped.
	return out.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
};

const CONTEXT = " Ctx: 0/200,000 tok (0.0%)";
const setBurn = (on: boolean) => {
	const marker = path.join(home, ".claude", ".burn-mode");
	if (on) fs.writeFileSync(marker, "{}");
	else fs.rmSync(marker, { force: true });
};

describe("the status line", () => {
	it.each([false, true])(
		"shows only context usage while burn mode stays as booted, on: %s",
		(on) => {
			setBurn(on);
			expect(render()).toBe(CONTEXT);
			expect(render()).toBe(CONTEXT);
		},
	);

	it("warns of a restart once burn mode turns on after boot, until it is back", () => {
		render();
		setBurn(true);
		expect(render()).toBe(`${CONTEXT}  burn: on (restart: model)`);
		setBurn(false);
		expect(render()).toBe(CONTEXT);
	});

	it("warns of a restart once burn mode turns off after boot", () => {
		setBurn(true);
		render();
		setBurn(false);
		expect(render()).toBe(`${CONTEXT}  burn: off (restart: model)`);
	});

	it("shows no burn warning outside workflow-core's world", () => {
		const elsewhere = path.join(dir, "elsewhere");
		fs.mkdirSync(elsewhere, { recursive: true });
		render(elsewhere);
		setBurn(true);
		expect(render(elsewhere)).toBe(CONTEXT);
	});

	it("spawns no node and no claude on a render", () => {
		render();
		expect(fs.existsSync(spawned)).toBe(false);
	});
});
