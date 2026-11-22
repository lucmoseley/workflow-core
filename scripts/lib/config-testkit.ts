import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";

export function withHostConfig(config: Record<string, unknown>): () => string {
	let root = "";
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "host-config-"));
		fs.mkdirSync(path.join(root, ".claude"));
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify(config),
		);
	});
	beforeEach(() => {
		vi.stubEnv("CLAUDE_PROJECT_DIR", root);
	});
	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});
	return () => root;
}
