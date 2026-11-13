// @vitest-environment node
/*
 * The equivalence contract (#5172) for each pre-commit dispatcher row armed by
 * a staged path: the row run in-process gives the same exit code, stdout and
 * stderr as its checker or program spawned. It is what licenses the row: a row
 * whose checker fails it keeps its own process. The other rows are
 * check-in-process-always-rows, a file of their own so the two run on separate
 * workers (#5191). Breaking it costs that licence: a row whose in-process
 * run drifts from its process would refuse, or pass, a commit differently
 * from its own CLI, and nothing else compares the two.
 */

import { afterEach } from "vitest";
import {
	describeDispatcherRows,
	removeFixtures,
} from "./check-in-process-testkit";
import { GATES } from "./precommit-gates.js";

afterEach(removeFixtures);

describeDispatcherRows(GATES.filter((row) => "staged" in row));
