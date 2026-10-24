/*
 * lib-install-testkit.ts — the one way a test stands all of scripts/lib in a
 * fixture install (#2272).
 *
 * WHY THE WHOLE DIRECTORY, for one of three reasons: the program under test
 * reaches its libs through more than one runtime (a shell guard running a
 * node lib, a node script spawning a shell one), which neither `sourcedLibs`
 * nor `programLibs` in scripts/guard-parse-fixture.ts follows; the fixture
 * stands up a plugin install as shipped (#587); or the program reads every
 * lib as data. A hand-kept list goes stale the next time the program gains a
 * lib, failing as a missing lib in a test about something else.
 *
 * THE COST: the listing below makes every test importing this module a reader
 * of every file in scripts/lib in docs/test-read-edges.json, so any lib change
 * selects it.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Stand every file in scripts/lib in `dest` but the `.ts` ones and any `keep`
 * refuses, as copies, or as symlinks where `link` is set.
 */
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
