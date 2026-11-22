import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

export function useScratchCore(dir: string, hooks: object = {}): void {
	const core = path.join(dir, "scratch-core");
	fs.mkdirSync(path.join(core, "hooks"), { recursive: true });
	fs.writeFileSync(path.join(core, "package.json"), "{}\n");
	fs.writeFileSync(
		path.join(core, "hooks", "hooks.json"),
		JSON.stringify({ hooks }),
	);
	vi.stubEnv("WFC_SCRIPT_ROOT", core);
}
