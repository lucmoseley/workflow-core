import fs from "node:fs";
import path from "node:path";
import { mkScratchDir } from "./git-fixture";

let bareCore: string | null = null;

export function bareCoreRoot(): string {
	if (bareCore === null) {
		bareCore = mkScratchDir("core-");
		fs.writeFileSync(path.join(bareCore, "package.json"), "{}\n");
	}
	return bareCore;
}
