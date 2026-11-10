// @vitest-environment node
/*
 * Pins what `refill-loop.js status --json` leaves unloaded (#4821). The refill
 * panel runs it every 3 s, and each module it loads costs that poll start-up
 * time, so a later top-level require of the tick, the morning review or the
 * session store would bring back what #4821 cut.
 *
 * A program case (base §X3), run through lib/run-in-process.js, which purges
 * repo modules only before a call: what is in require.cache after it is that
 * call's load set.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "refill-loop.js");
const cache = createRequire(import.meta.url).cache;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-status-load-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("refill-loop.js status's load set (#4821)", () => {
	it("loads neither the tick, the morning review nor the session store to show status", async () => {
		const r = await runInProcessAsync(SCRIPT, ["status", "--json"], {
			cwd: dir,
			env: {
				...process.env,
				WFC_REFILL_DIR: dir,
				CLAUDE_PROJECT_DIR: dir,
				HOME: dir,
				CLAUDE_CONFIG_DIR: path.join(dir, ".claude3"),
				WFC_CLAUDE_BIN: path.join(dir, "no-claude"),
			},
		});
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).running).toBe(false);
		// The module set is an internal, asserted because no output shows the
		// start-up cost it guards (base §X6, #1497).
		const loaded = new Set(
			Object.keys(cache).map((k) => path.relative(__dirname, k)),
		);
		expect(loaded).toContain("lib/refill-io.js");
		expect(
			[
				"lib/refill-tick.js",
				"lib/morning-review.js",
				"lib/project-dirs.js",
			].filter((module) => loaded.has(module)),
		).toEqual([]);
	});
});
