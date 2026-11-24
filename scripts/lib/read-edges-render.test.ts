// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { render } from "./read-edges-render.js";

const DATA = ["docs", "data.json"].join("/");
let dir: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-edges-render-"));
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	fs.mkdirSync(path.join(dir, "docs"));
	fs.writeFileSync(path.join(dir, DATA), '{"a":1}\n');
	git("add", "-A");
	git("commit", "-q", "-m", "init");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it("fetches a non-script blob from git once per tree, however often it is read (#5745)", () => {
	const { tree } = render(dir, { at: "HEAD" });
	expect(tree.read(DATA)).toBe('{"a":1}\n');
	const oid = git("rev-parse", `HEAD:${DATA}`);
	fs.rmSync(path.join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
	expect(tree.read(DATA)).toBe('{"a":1}\n');
});
