# Lost-deny census, true deny rates (5 Sep 2026)

The correct-cut table of the lost-deny census, which `scripts/lib/guard-deny-rates.js`'s RATES copies and `scripts/lib/guard-deny-rates.test.ts` pins. Method and the other cuts: [docs/research/lost-deny-recoverability.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md) §Q2.

| guard | lost (Q1) | deny events (whole corpus) | true population | true deny rate | expected escaped denies |
|---|---|---|---|---|---|
| guard-issue-close.sh | 90 | 255 | 16,057 | 1.588% [1.41-1.79%] | 1.429 [1.27-1.61] |
| guard-agent-poll.sh | 64 | 881 | 40,198 | 2.192% [2.05-2.34%] | 1.403 [1.31-1.50] |
| guard-suite-concurrency.sh | 81 | 736 | 71,159 | 1.034% [0.96-1.11%] | 0.838 [0.78-0.90] |
| guard-issue-create-label.sh | 61 | 208 | 16,057 | 1.295% [1.13-1.48%] | 0.790 [0.69-0.90] |
| guard-issue-body.sh | 66 | 16 | 16,057 | 0.0996% [0.06-0.16%] | 0.066 [0.04-0.11] |
| guard-dispatch-model.sh | 1 | 220 | 7,804 | 2.819% [2.47-3.21%] | 0.028 [0.02-0.03] |
| guard-dispatch-artefact.sh | 1 | 187 | 7,804 | 2.396% [2.08-2.76%] | 0.024 [0.02-0.03] |
| guard-issue-phase-scope.sh | 70 | 9 | 38,601 | 0.0233% [0.01-0.04%] | 0.016 [0.01-0.03] |
| guard-cd-prefix.sh | 4 | 1030 | 291,734 | 0.353% [0.33-0.38%] | 0.014 [0.01-0.02] |
| guard-self-match.sh | 80 | 79 | 291,734 | 0.0271% [0.02-0.03%] | 0.022 [0.02-0.03] |
| guard-suite-background.sh | 27 | 70 | 291,734 | 0.0240% [0.02-0.03%] | 0.006 [0.01-0.01] |
| guard-recursive-dot-read.sh | 4 | 74 | 291,734 | 0.0254% [0.02-0.03%] | 0.001 [0.00-0.00] |
| guard-echo-call.sh | 9 | 69 | 317,047 | 0.0218% [0.02-0.03%] | 0.002 [0.00-0.00] |
| guard-root-scratch.sh | 8 | 11 | 291,734 | 0.0038% [0.00-0.01%] | 0.0003 |
| guard-registry-atomicity.sh | 3 | 3 | 21,952 | 0.0137% [0.00-0.04%] | 0.0004 |
| guard-commit-form.sh | 119 | 1 | 21,952 | 0.0046% [0.00-0.03%] | 0.0054 |
| guard-pull-form.sh | 77 | 0 | 21,952 | 0% [0-0.02%] | 0 |
| guard-branch.sh | 68 | 0 | 21,952 | 0% [0-0.02%] | 0 |
| guard-sweep-fire.sh | 44 | 0 | 291,734 | 0% [0-0.001%] | 0 |
