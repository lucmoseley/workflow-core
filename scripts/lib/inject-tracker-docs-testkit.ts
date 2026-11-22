import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInProcess } from "./run-in-process.js";

type Ports = import("./inject-tracker-docs.js").Ports;

export const TIER_HOOK = path.join(__dirname, "..", "guard-dispatch.js");

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tier-port-"));

export const tierPort =
	(hook = TIER_HOOK): Ports["reviewTier"] =>
	({ payload, cwd }) => {
		if (!fs.existsSync(hook)) return "";
		const r = runInProcess(hook, ["--only", "inject-review-tier"], {
			stdin: payload,
			cwd,
			env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR },
		});
		try {
			return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
		} catch {
			return "";
		}
	};

export function takesPort(label: () => string) {
	const calls: string[] = [];
	const port: Ports["takesLabel"] = ({ issue, repo, cwd }) => {
		if (
			cwd !== "" &&
			!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()
		)
			return "";
		calls.push(
			`issue view ${issue}${repo ? ` --repo ${repo}` : ""} --json labels`,
		);
		return label();
	};
	return { port, calls };
}
