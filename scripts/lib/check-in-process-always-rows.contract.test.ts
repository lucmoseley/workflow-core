// @vitest-environment node
/*
 * The equivalence contract (#5172) for each always-armed pre-commit dispatcher
 * row. The rows armed by a staged path are check-in-process-armed-rows, a
 * file of their own so the two run on separate workers (#5191).
 */

import { afterEach, describe, it } from "vitest";
import { dispatcherRowCase, removeFixtures } from "./check-in-process-testkit";
import { GATES } from "./precommit-gates.js";

afterEach(removeFixtures);

describe.each(GATES.filter((row) => !("staged" in row)))(
	"the $id dispatcher row",
	(row) => {
		it("runs in-process exactly as spawned over a change to its arming path", () =>
			dispatcherRowCase(row));
	},
);
