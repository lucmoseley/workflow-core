// @vitest-environment node

import { afterEach } from "vitest";
import {
	describeDispatcherRows,
	removeFixtures,
	sideOf,
} from "./check-in-process-testkit";
import { GATES } from "./precommit-gates.js";

afterEach(removeFixtures);

describeDispatcherRows(GATES.filter((row) => sideOf(row) !== null));
