import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const writeIn = (root: string, file: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), body);
};

export const gitIn = (root: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" });

export const gitTrimmedIn = (root: string, ...args: string[]) =>
	gitIn(root, ...args).trim();
