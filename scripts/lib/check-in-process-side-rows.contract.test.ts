// @vitest-environment node
/*
 * The equivalence contract (#5172) for each pre-commit dispatcher row comparing
 * an `--against` or `--index` side: the row run in-process gives the same exit
 * code, stdout and stderr as its checker spawned, over a change to its arming
 * path and over a tree holding an inherited fault, with and without an added
 * one (#5195). It is what licenses the row's in-process sides: an added /
 * inherited split that drifts from its process shows only where findings
 * exist. The other rows are check-in-process-always-rows and
 * check-in-process-armed-rows, files of their own so they run on separate
 * workers (#5191).
 *
 * Its cost, ~30 s, is three trees for each of some twenty rows, each run twice
 * over materialised sides: a fault tree per row is what this file proves.
 */

import { afterEach } from "vitest";
import {
	describeDispatcherRows,
	removeFixtures,
	sideOf,
} from "./check-in-process-testkit";
import { GATES } from "./precommit-gates.js";

afterEach(removeFixtures);

describeDispatcherRows(GATES.filter((row) => sideOf(row) !== null));
