import fs from "node:fs";
import path from "node:path";

export const writeFakeBin = (dir: string, name: string, body: string) => {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, name);
	fs.writeFileSync(bin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	return bin;
};
