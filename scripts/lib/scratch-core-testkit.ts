/*
 * scratch-core-testkit.ts — a stand-in core for a test whose fixture root is
 * an adopter host (#2445). lib/core-hooks.js's `readRunningHooks` merges an adopter's
 * settings with the core plugin's `hooks/hooks.json`, read from `coreRoot()`;
 * without this, every fixture also carries the live core's registrations, and
 * a roster case passes or fails on whatever the core wires today.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * A core under `dir` whose plugin registers `hooks`, made the running core
 * through `WFC_SCRIPT_ROOT` (lib/script-path.js's tests-only seam). It carries
 * a `package.json`, so `scriptPath` still spells a script as a checkout does.
 * @returns a function putting `WFC_SCRIPT_ROOT` back as it was
 */
export function useScratchCore(dir: string, hooks: object = {}): () => void {
	const saved = process.env.WFC_SCRIPT_ROOT;
	const core = path.join(dir, "scratch-core");
	fs.mkdirSync(path.join(core, "hooks"), { recursive: true });
	fs.writeFileSync(path.join(core, "package.json"), "{}\n");
	fs.writeFileSync(
		path.join(core, "hooks", "hooks.json"),
		JSON.stringify({ hooks }),
	);
	process.env.WFC_SCRIPT_ROOT = core;
	return () => {
		if (saved === undefined) delete process.env.WFC_SCRIPT_ROOT;
		else process.env.WFC_SCRIPT_ROOT = saved;
	};
}
