/*
 * inject-tracker-docs-testkit.ts — the in-process fakes of
 * lib/inject-tracker-docs-host.js's two reads (#5151), shared by the core's
 * module cases and by the contract test that holds each to its production
 * adapter.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInProcess } from "./run-in-process.js";

type Ports = import("./inject-tracker-docs.js").Ports;

/** The dispatcher the review-tier core runs through, as the adapter's default. */
export const TIER_HOOK = path.join(__dirname, "..", "guard-dispatch.js");

/* The dispatcher's fail-open log, kept off the developer's live one. */
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tier-port-"));

/**
 * The review-tier port on the real dispatcher, run in-process rather than
 * spawned: the adapter's answer for the same payload, at no process start.
 */
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

/**
 * The `takes:` port answering `label`, recording each read as the `gh`
 * argument line the adapter builds from it, up to `--json labels`. A cwd that
 * is not a directory is asked nothing, as the adapter asks nothing.
 */
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
