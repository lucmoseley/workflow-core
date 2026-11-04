// @vitest-environment node
/*
 * new-repo.js --resume after a part-way copy, committing through the new
 * repo's real hook stack (#4297). new-repo.test.ts's header says how a run is
 * driven and what a loosened case costs.
 *
 * Over the run-cost budget (base §X8 (5)): its one case is a run §X8 (2) keeps
 * on the real hook stack, which is most of its time.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	builtThrough,
	cleanRun,
	type Golden,
	HAS_GITLEAKS,
	newRepoSuite,
	RUN_TIMEOUT_MS,
	SET_ASIDE_HOOK,
	SOURCE_HOOK,
	statusOf,
} from "./new-repo-testkit";

newRepoSuite();

describe.skipIf(!HAS_GITLEAKS)(
	"new-repo.js --resume after a part-way copy",
	() => {
		let golden: Golden;
		beforeAll(() => {
			golden = cleanRun(true, { hooks: false }).golden;
		}, RUN_TIMEOUT_MS);

		it("commits the skeleton where an earlier run set the shebang-less hook aside byte for byte and shellcheck refused it, adding the shell directive (#1870)", () => {
			const s = builtThrough("source docs", true, undefined, golden);
			fs.writeFileSync(
				path.join(s.clone, ".husky/pre-commit.local"),
				SOURCE_HOOK,
			);
			const r = s.resume();
			expect(r.status, r.stdout).toBe(0);
			expect(statusOf(r.stdout, "set aside")).toBe("repaired");
			expect(statusOf(r.stdout, "commit")).toBe("done");
			expect(s.git("show", "HEAD:.husky/pre-commit.local")).toBe(
				SET_ASIDE_HOOK.trim(),
			);
		}, 340_000);
	},
);
