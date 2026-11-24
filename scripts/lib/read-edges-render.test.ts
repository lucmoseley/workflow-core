// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defineTemplate } from "./git-fixture";
import { render } from "./read-edges-render.js";

const DATA = "docs/data.json";
let dir: string;

const git = (root: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const committed = defineTemplate((root) => {
	git(root, "init", "-q");
	fs.mkdirSync(path.join(root, "docs"));
	fs.writeFileSync(path.join(root, DATA), '{"a":1}\n');
	git(root, "add", "-A");
	git(root, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "a");
});

beforeEach(() => {
	dir = committed.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "read-edges-render-")),
	);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it("fetches a non-script blob from git once per tree, however often it is read (#5745)", () => {
	const { tree } = render(dir, { at: "HEAD" });
	expect(tree.read(DATA)).toBe('{"a":1}\n');
	const oid = git(dir, "rev-parse", `HEAD:${DATA}`);
	fs.rmSync(path.join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
	fs.rmSync(path.join(dir, DATA));
	expect(tree.read(DATA)).toBe('{"a":1}\n');
});
