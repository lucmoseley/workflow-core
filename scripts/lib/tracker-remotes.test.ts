// @vitest-environment node

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const { readTrackerRemotes } = createRequire(__filename)(
	"./tracker-remotes.js",
);

it("throws a git config read that could not run, never reading it as no tracker remotes (#5644)", () => {
	const gone = path.join(os.tmpdir(), "tracker-remotes-no-such-dir-5644");
	expect(() => readTrackerRemotes("owner/repo", { cwd: gone })).toThrow(
		/ENOENT/,
	);
});
