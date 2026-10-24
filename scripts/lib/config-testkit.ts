/*
 * A throwaway host root holding `.claude/workflow-core.json`, pointed at by
 * CLAUDE_PROJECT_DIR for the file's tests, so a script under test reads a
 * fixture config rather than whatever repo the session runs in.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

/** Registers beforeAll/afterAll; returns a getter for the host root. */
export function withHostConfig(config: Record<string, unknown>): () => string {
	let root = "";
	const saved = process.env.CLAUDE_PROJECT_DIR;
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "host-config-"));
		fs.mkdirSync(path.join(root, ".claude"));
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify(config),
		);
		process.env.CLAUDE_PROJECT_DIR = root;
	});
	afterAll(() => {
		if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
		else process.env.CLAUDE_PROJECT_DIR = saved;
		fs.rmSync(root, { recursive: true, force: true });
	});
	return () => root;
}
