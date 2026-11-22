import fs from "node:fs";
import path from "node:path";

export function installLib(
	dest: string,
	{
		keep = () => true,
		link = false,
	}: {
		keep?: (name: string) => boolean;
		link?: boolean;
	} = {},
): void {
	fs.mkdirSync(dest, { recursive: true });
	for (const e of fs.readdirSync(__dirname, { withFileTypes: true })) {
		if (!e.isFile() || e.name.endsWith(".ts") || !keep(e.name)) continue;
		const from = path.join(__dirname, e.name);
		const to = path.join(dest, e.name);
		if (link) fs.symlinkSync(from, to);
		else fs.copyFileSync(from, to);
	}
}
