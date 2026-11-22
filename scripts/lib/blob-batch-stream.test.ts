// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchBlobGroups } from "./blob-batch-stream.js";
import { initGitRepo, mkScratchDir } from "./git-fixture";

describe("matchBlobGroups — groups of blobs tested through one streaming batch (#4542)", () => {
	let root: string;
	const ids: Record<string, string> = {};
	const big = `${"x".repeat(199)}\n`.repeat(2000);
	beforeAll(() => {
		const scratch = mkScratchDir("blob-batch-stream-");
		fs.mkdirSync(path.join(scratch, "no-hooks"));
		root = path.join(scratch, "repo");
		initGitRepo(root, path.join(scratch, "no-hooks"));
		for (const [name, text] of Object.entries({
			one: "one\n",
			two: "two\n",
			big,
		}))
			ids[name] = execFileSync("git", ["hash-object", "-w", "--stdin"], {
				cwd: root,
				input: text,
				encoding: "utf8",
			}).trim();
	});
	afterAll(() => {
		fs.rmSync(path.dirname(root), { recursive: true, force: true });
	});

	const is = (text: string) => (body: Buffer) => body.toString() === text;
	const Missing = "0".repeat(40);

	it("answers each group, a body far over one chunk read whole and a missing blob skipped", async () => {
		const found = await matchBlobGroups(
			[
				{ blobs: [Missing, ids.one, ids.big], test: is(big) },
				{ blobs: [ids.two], test: is("one\n") },
				{ blobs: [], test: () => true },
			],
			{ cwd: root },
		);
		expect(found).toEqual([true, false, false]);
	});

	it("stops testing a group at its first match", async () => {
		const seen: string[] = [];
		const found = await matchBlobGroups(
			[
				{
					blobs: [ids.one, ids.two, ids.big],
					test: (body: Buffer) => {
						seen.push(body.toString().slice(0, 4));
						return seen.length === 1;
					},
				},
			],
			{ cwd: root },
		);
		expect(found).toEqual([true]);
		expect(seen).toEqual(["one\n"]);
	});

	it("rejects where git cannot run the batch", async () => {
		await expect(
			matchBlobGroups([{ blobs: [ids.one], test: () => false }], {
				cwd: path.join(root, "gone"),
			}),
		).rejects.toThrow();
	});
});
