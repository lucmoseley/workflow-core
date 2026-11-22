import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { subjectsFor, transcriptFires } = require("./guard-fires.js");

const ROOT = path.resolve(__dirname, "..", "..");
const readJson = (...parts: string[]) =>
	JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), "utf8"));

export const denyRecord = (text: string, isError = true) => ({
	type: "user",
	uuid: "u1",
	timestamp: "2026-08-17T13:22:14.026Z",
	message: {
		role: "user",
		content: [{ type: "tool_result", content: text, is_error: isError }],
	},
});

export function denyFires(reason: string): string[] {
	const subjects = subjectsFor(
		readJson("scripts", "guard-fire-needles.json"),
		readJson("self-plugin", "hooks", "hooks.json"),
	);
	return transcriptFires(
		JSON.stringify(denyRecord(reason)),
		subjects,
		"main",
	).map((f: { subject: string; needle: string }) => `${f.subject}/${f.needle}`);
}
