import fs from "node:fs";
import path from "node:path";
import { coreRoot } from "./script-path.js";

const HOOK_FILES = ["hooks/hooks.json", "self-plugin/hooks/hooks.json"].map(
	(rel) => path.join(coreRoot(), rel),
);

interface HookGroup {
	hooks: { command: string; timeout: number }[];
}

export const registeredTimeoutsMs = (script: string): number[] =>
	HOOK_FILES.flatMap((file) =>
		Object.values(
			JSON.parse(fs.readFileSync(file, "utf8")).hooks as Record<
				string,
				HookGroup[]
			>,
		)
			.flat()
			.flatMap((g) => g.hooks)
			.filter((h) => h.command.includes(`/scripts/${script}`))
			.map((h) => h.timeout * 1000),
	);
