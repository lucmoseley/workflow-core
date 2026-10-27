// @vitest-environment node
/*
 * project-dirs.test.ts — the seat listings every multi-seat scanner reads.
 * A module test: imports the lib and calls it against throwaway seat trees
 * under the system temp dir, never the real config dirs — those change under
 * every live session, and a case needs symlinked seats and duplicate sessions
 * the real ones may not hold.
 *
 * Break it and scanners miss a seat's sessions, count a symlinked seat or a
 * resumed session twice (#375, #382), or drop a seat without saying (#1054).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	listTranscripts,
	oneCopyEach,
	projectDirs,
	readSeatProjectDirs,
	readSeatTranscripts,
} from "./project-dirs.js";
import { slugForRepo } from "./project-slug.js";

describe("projectDirs", () => {
	const knobs = [
		"CLAUDE_CONFIG_DIR",
		"WFC_CLAUDE_CONFIG_A",
		"WFC_CLAUDE_CONFIG_B",
		"WFC_CLAUDE_CONFIG_C",
	];
	const saved = Object.fromEntries(knobs.map((k) => [k, process.env[k]]));
	let home = "";
	afterEach(() => {
		for (const k of knobs)
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("returns every seat's real directory, and a symlinked one once (#375)", () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "project-dirs-"));
		const seat = (name: string) => path.join(home, name);
		const projects = (name: string) =>
			path.join(seat(name), "projects", slugForRepo());
		fs.mkdirSync(projects(".claude"), { recursive: true });
		fs.mkdirSync(projects(".claude2"), { recursive: true });
		fs.mkdirSync(path.dirname(projects(".claude3")), { recursive: true });
		fs.symlinkSync(projects(".claude2"), projects(".claude3"));
		process.env.CLAUDE_CONFIG_DIR = seat(".claude");
		process.env.WFC_CLAUDE_CONFIG_A = seat(".claude");
		process.env.WFC_CLAUDE_CONFIG_B = seat(".claude2");
		process.env.WFC_CLAUDE_CONFIG_C = seat(".claude3");
		expect(projectDirs()).toEqual([projects(".claude"), projects(".claude2")]);
	});
});

describe("oneCopyEach", () => {
	let home = "";
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it("keeps the larger of one session's copies on two seats, and each other session (#382)", () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "one-copy-each-"));
		const [a, b] = ["seat-a", "seat-b"].map((s) => {
			const dir = path.join(home, s, "projects", slugForRepo());
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		});
		fs.writeFileSync(path.join(a, "shared.jsonl"), "{}\n");
		fs.writeFileSync(path.join(b, "shared.jsonl"), "{}\n{}\n");
		fs.writeFileSync(path.join(a, "only-a.jsonl"), "{}\n");
		fs.writeFileSync(path.join(b, "only-b.jsonl"), "{}\n");
		const found = [a, b].flatMap((d) =>
			fs.readdirSync(d).map((n) => path.join(d, n)),
		);
		expect(oneCopyEach(found).sort()).toEqual(
			[
				path.join(a, "only-a.jsonl"),
				path.join(b, "only-b.jsonl"),
				path.join(b, "shared.jsonl"),
			].sort(),
		);
	});
});

describe("listTranscripts", () => {
	let home = "";
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it("lists each directory's .jsonl, keeping an absent directory apart from an unreadable one (#1520)", () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "list-transcripts-"));
		const read = path.join(home, "read");
		fs.mkdirSync(read);
		fs.writeFileSync(path.join(read, "s1.jsonl"), "{}\n");
		fs.writeFileSync(path.join(read, "notes.txt"), "");
		const file = path.join(home, "a-file");
		fs.writeFileSync(file, "");
		const gone = path.join(home, "gone");

		expect(listTranscripts([read, gone, file])).toEqual({
			found: [path.join(read, "s1.jsonl")],
			absent: [gone],
			unreadable: [`${file} (ENOTDIR)`],
		});
	});
});

describe("readSeatTranscripts", () => {
	let home = "";
	afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

	it("reads every repo on every seat, a symlinked slug once, main logs only, one copy each (#980)", () => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-transcripts-"));
		const seat = (s: string) => path.join(home, s);
		const slugDir = (s: string, name: string) =>
			path.join(seat(s), "projects", name);
		for (const d of [slugDir("a", "-repo-one"), slugDir("b", "-repo-two")])
			fs.mkdirSync(d, { recursive: true });
		fs.symlinkSync(slugDir("a", "-repo-one"), slugDir("b", "-repo-one"));
		fs.writeFileSync(path.join(slugDir("a", "-repo-one"), "s1.jsonl"), "{}\n");
		fs.writeFileSync(path.join(slugDir("a", "-repo-one"), "notes.txt"), "");
		fs.writeFileSync(
			path.join(slugDir("b", "-repo-two"), "s1.jsonl"),
			"{}\n{}\n",
		);
		fs.writeFileSync(path.join(slugDir("b", "-repo-two"), "s2.jsonl"), "{}\n");
		const sub = path.join(slugDir("b", "-repo-two"), "s2", "subagents");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, "agent-x.jsonl"), "{}\n");

		const r = readSeatTranscripts([seat("a"), seat("b"), seat("gone")]);
		expect(r.files.sort()).toEqual(
			[
				path.join(slugDir("b", "-repo-two"), "s1.jsonl"),
				path.join(slugDir("b", "-repo-two"), "s2.jsonl"),
			].sort(),
		);
		expect(r.listed).toBe(2);
		expect(r.absent).toEqual([path.join(seat("gone"), "projects")]);
		expect(r.unreadable).toEqual([]);
		expect(readSeatProjectDirs([seat("a"), seat("b")]).dirs).toHaveLength(2);
	});
});
