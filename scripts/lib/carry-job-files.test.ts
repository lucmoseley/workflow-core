// @vitest-environment node
/*
 * lib/carry-job-files.js over real files in a temp seat and checkout (#4750).
 *
 * Loosen one and `claude rm` deletes a pasted screenshot the next session
 * is still told to read.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	buildCarriedNote,
	carryJobFiles,
	readUserTurnsNaming,
} from "./carry-job-files.js";

const JOB = "5e55101d";
let dir: string;
let jobDir: string;
let checkout: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "carry-job-files-"));
	jobDir = path.join(dir, "seat", "jobs", JOB);
	checkout = path.join(dir, "repo");
	fs.mkdirSync(path.join(jobDir, "tmp"), { recursive: true });
	fs.mkdirSync(checkout);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const paste = (rel: string) => {
	const file = path.join(jobDir, rel);
	fs.writeFileSync(file, `bytes of ${rel}`);
	return file;
};
const carry = (text: string) =>
	carryJobFiles({ text, jobDir, jobId: JOB, checkout });
const copyOf = (rel: string) =>
	path.join(checkout, ".claude", "tmp", "attachments", JOB, rel);

it("copies each named file, both layouts, and names the copy, glued punctuation kept", () => {
	const a = paste("tmp/pasted-9f0c82a3.png");
	const b = paste("pasted-1.png");

	const r = carry(`look at ${a}, and (see ${b}).`);

	expect(r.text).toBe(
		`look at ${copyOf("tmp/pasted-9f0c82a3.png")}, and (see ${copyOf("pasted-1.png")}).`,
	);
	expect(fs.readFileSync(copyOf("pasted-1.png"), "utf8")).toBe(
		"bytes of pasted-1.png",
	);
	expect(r.carried.map((c) => c.from)).toEqual([a, b]);
});

it("still names a copy once the job directory is gone, so a resume after removal is told", () => {
	const a = paste("tmp/pasted-9f0c82a3.png");
	carry(`look at ${a}`);
	fs.rmSync(jobDir, { recursive: true });

	expect(carry(`look at ${a}`).carried).toEqual([
		{ from: a, to: copyOf("tmp/pasted-9f0c82a3.png") },
	]);
});

it("leaves named what removal cannot delete: a file gone, or one outside the job directory", () => {
	const outside = path.join(dir, "seat", "outside.txt");
	fs.writeFileSync(outside, "x");
	fs.symlinkSync(outside, path.join(jobDir, "tmp", "link.txt"));
	const text = `${jobDir}/tmp/gone.png ${jobDir}/../../outside.txt ${jobDir}/tmp/link.txt`;

	expect(carry(text)).toEqual({ text, carried: [] });
});

it("throws naming a named file that will not copy", () => {
	const shots = path.join(jobDir, "tmp", "shots");
	fs.mkdirSync(shots);
	expect(() => carry(`look at ${shots}`)).toThrow(
		`carrying ${shots} out of its job directory failed`,
	);
});

it("refuses to recreate a checkout that is gone", () => {
	const a = paste("tmp/pasted-9f0c82a3.png");
	fs.rmSync(checkout, { recursive: true });
	expect(() => carry(a)).toThrow(`its checkout ${checkout} is gone`);
	expect(fs.existsSync(checkout)).toBe(false);
});

it("reads a later turn's paste off the transcript's user words, never a tool result", () => {
	const later = paste("tmp/pasted-2.png");
	const scratch = path.join(jobDir, "tmp", "scratch.txt");
	const file = path.join(dir, "t.jsonl");
	const rows = [
		{ type: "user", message: { content: "start" } },
		{
			type: "user",
			message: { content: [{ type: "text", text: `and ${later}` }] },
		},
		{
			type: "user",
			message: { content: [{ type: "tool_result", content: scratch }] },
		},
		{ type: "user", isMeta: true, message: { content: scratch } },
		{
			type: "assistant",
			message: { content: [{ type: "text", text: scratch }] },
		},
	];
	fs.writeFileSync(
		file,
		`${rows.map((r) => JSON.stringify(r)).join("\n")}\nnot json ${scratch}\n`,
	);

	expect(readUserTurnsNaming(file, JOB)).toBe(`and ${later}`);
	expect(readUserTurnsNaming(path.join(dir, "gone.jsonl"), JOB)).toBe("");
});

it("says nothing where nothing was carried", () => {
	expect(buildCarriedNote([])).toBe("");
});
