// @vitest-environment node

import { afterEach } from "vitest";
import {
	describeDispatcherRows,
	describeRowFixtures,
	removeFixtures,
} from "./check-in-process-testkit";
import { GATES } from "./precommit-gates.js";

afterEach(removeFixtures);

describeDispatcherRows(GATES.filter((row) => "always" in row.arm));
describeRowFixtures(GATES);
