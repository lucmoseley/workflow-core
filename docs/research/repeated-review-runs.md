# Research: the gain from repeated runs of an LLM code reviewer (#1545)

Question: how many defects does each extra independent run of the same LLM reviewer add? Is the gain different between models? On a mission-critical change, how many runs are worth their cost?

Status: complete (13 Oct 2026).

## F0. The per-run cells of #349 are not deleted

The #349 issue says that `.claude/tmp/bake-cells.json` is deleted. That is true. But the same data is still on disk in a different location:

- `~/.claude3/jobs/4004f17c/tmp/bake/judge/dNN.json` (30 files). Each file has a `labels` map (X1–X6 to `dNN-<arm>-rN`) and the judge's `result`, which gives the `found` key ids for each of the six reviews.
- The judge prompt for each diff contains the full answer key. The prompt is in the judge session transcript, `~/.claude3/projects/-home-lucmo--claude3-jobs-4004f17c-tmp-bake-wt-judge-dNN/<session>.jsonl`.
- `~/.claude3/jobs/4004f17c/tmp/bake/runs/` has the 180 review outputs.

## L. Local measurement from the recovered #349 cells

Method: `.claude/tmp/r1545/extract.py` reads the 30 judge files and the 30 judge prompts. `.claude/tmp/r1545/analyse.py` and `.claude/tmp/r1545/cond.py` compute the figures. (Gitignored scratch on the founder's machine; `M.json` beside them is the item × run matrix.) The key has 191 items: 94 defect, 20 spec-miss, 77 standards-breach. d03 has 0 items, because the founder struck its two items. All found ids match key ids; there are 0 strays.

Check: the recovered cells give the same #349 figures. Single-run recall is 55.2% (Fable 5.1 medium), 62.8% (Opus 5.5 medium), 72.0% (Opus 5.5 high). Both/either is 64.8%, 75.2%, 79.7%.

### L1. Single runs vary

| Run | r1 recall | r2 recall |
|---|---|---|
| Fable 5.1 medium | 59.7% | 50.8% |
| Opus 5.5 medium | 64.9% | 60.7% |
| Opus 5.5 high | 74.3% | 69.6% |

### L2. Union of two runs (measured, not estimated)

| Pair | Union recall | Gain over the mean single run | Jaccard of found sets |
|---|---|---|---|
| Opus high + Opus high | **80.1%** | +8.1 pp | 79.7% |
| Opus high + Opus medium (mean of 4 pairs) | 77.2% | +9.8 pp | 74.6% |
| Opus high + Fable medium (mean of 4 pairs) | **76.8%** | +13.2 pp | 65.5% |
| Opus medium + Opus medium | 71.7% | +8.9 pp | 75.2% |
| Opus medium + Fable medium (mean of 4) | 70.3% | +11.3 pp | 68.0% |
| Fable medium + Fable medium | 67.0% | +11.8 pp | 64.8% |
### L3. Larger unions

| Runs | Union recall |
|---|---|
| Opus high ×2 | 80.1% |
| Opus high ×2 + Opus medium ×2 | 83.8% |
| Opus high ×2 + Fable medium ×2 | 84.8% |
| All 6 runs | 85.9% |

27 of 191 items (14.1%) were found by no run. Detection count over the 6 runs (count: items): 0: 27, 1: 17, 2: 14, 3: 20, 4: 14, 5: 29, 6: 70. The distribution is U-shaped. Most items are easy for all runs, and a block of items is hard for all runs.

Per-arm counts over its 2 runs (0 / 1 / 2 runs found it): Fable medium 63 / 45 / 83; Opus medium 54 / 34 / 103; Opus high 38 / 31 / 122.

### L4. Does a Fable run find what an Opus high run missed better than a second Opus high run does?

No. Take one Opus 5.5 high run as the base. For the items that it missed, the probability that an added run finds the item:

| Added run | P(finds item that base Opus high run missed) | Its own single-run recall | Ratio (conditional / own) |
|---|---|---|---|
| Second Opus 5.5 high | **29.0%** | 72.0% | 0.40 |
| Fable 5.1 medium | **17.3%** | 55.2% | 0.31 |
| Opus 5.5 medium | 18.7% | 62.8% | 0.30 |

Bootstrap over diffs (4,000 resamples, seed 1545):
- Conditional rate, second Opus high minus Fable: +11.7 pp (95% interval +4.6 to +19.3 pp). The interval does not include zero.
- Ratio difference (this removes the effect of Fable's lower recall): +0.09 (95% interval −0.03 to +0.21). The interval includes zero. Thus there is no evidence that Fable's misses are less correlated with Opus's misses than Opus's own repeats are. There is weak evidence of the opposite.

The full matrix, P(added arm finds | base run missed), rows = base, columns = added:

| Base \ added | Fable medium | Opus medium | Opus high |
|---|---|---|---|
| Fable medium | 26.3% | 33.6% | 48.2% |
| Opus medium | 20.1% | 23.9% | 38.7% |
| Opus high | 17.3% | 18.7% | 29.0% |
### L5. By defect class (mean single run → union of 2 runs of the same arm)

| Class (n) | Fable medium | Opus medium | Opus high | All 6 runs |
|---|---|---|---|---|
| defect (94) | 59.0 → 70.2 | 62.2 → 69.1 | 72.3 → 78.7 | 84.0 |
| spec-miss (20) | 52.5 → 65.0 | 70.0 → 85.0 | 80.0 → 95.0 | 95.0 |
| standards-breach (77) | 51.3 → 63.6 | 61.7 → 71.4 | 69.5 → 77.9 | 85.7 |

For the "defect" class (the class nearest to a money or access-control bug), the second Opus high run adds +6.4 pp, less than the mean.

### L6. Limits of the local data (they apply to all of section L)

- The arms are Fable 5.1 **medium**, not Fable 5.1 **high**. Fable high is not measured. The cross-model result for Fable high is an inference.
- The key is almost entirely original-review findings. The original reviewer was Opus 5 on 21 of 30 diffs. This can bias the key toward items that an Opus-family reviewer finds, and thus can make Opus repeats look more useful than a Fable run. #349 checked the origin split: the ranking held on the 9 non-Opus diffs. The overlap result in L4 was not split by origin here.
- One judge call per diff scored all 6 runs together. A judge error that is the same for one item in all 6 runs makes the runs look more correlated than they are.
- n = 30 diffs, 191 items. 29 diffs have items. The intervals are bootstrapped over diffs.
- The replays could not run node, python3 or curl. A reviewer that runs the repo's checkers can find items that no replay found. Some of the 27 never-found items can be in this group (not checked).
- The diffs are mantahostels machinery diffs (hooks, scripts, docs), not RLS or money code.

## P. Projection of union recall for k runs (task item 4)

Script: `.claude/tmp/r1545/fit.py` and `.claude/tmp/r1545/cost.py`.

### P1. Three models

Each model gives each key item a per-run detection probability p. The union recall for k independent runs is the mean over items of 1 − (1 − p)^k. The models differ in the distribution of p.

1. **Two-class model (pessimistic).** A fraction f of items is "findable", each with the same p. The other items are never found. Two parameters. Two runs per arm give two free counts (n1, n2), so the fit is exact. Formulas: p = 1 / (1 + n1/(2·n2)); f = n2/p²; union(k) = f·(1 − (1 − p)^k).
   - Opus 5.5 high: n1 = 31/191, n2 = 122/191. p = 1/(1 + 31/244) = 0.887. f = 0.6387/0.787 = 0.811.
   - Fable 5.1 medium: n1 = 45/191, n2 = 83/191. p = 0.787, f = 0.702.
2. **Beta-binomial model (optimistic).** p follows Beta(a, b). Fit by moments: mean μ = (n1 + 2·n2)/2; E[p²] = n2; var = E[p²] − μ²; a + b = μ(1 − μ)/var − 1. union(k) = 1 − Π_{j=0}^{k−1} (b + j)/(a + b + j).
   - Opus 5.5 high: μ = 0.720, var = 0.6387 − 0.5184 = 0.1203, a + b = 0.676, a = 0.485, b = 0.189.
   - Fable 5.1 medium: a = 0.503, b = 0.407.
   - b < 1 puts a large mass near p = 0, so the curve keeps rising slowly (the missed fraction falls approximately as k^(−a)).
3. **Joint one-dimension model (uses all 6 runs).** Each item has one difficulty θ. Each arm has one offset β. p = logistic(θ + β). The distribution of θ is free (a grid of 81 points from −10 to +10, plus "never"), fit by EM. Fitted offsets (Fable medium = 0): Opus medium +0.72, Opus high +1.66 logits. Mass on "never" = 0.
   - Assumption: the models rank items by difficulty in the same order. The model has no term for model-specific blind spots.
   - Fit check against measured unions, which the model did not fit directly: Opus high + Fable: 75.9% predicted, 76.8% measured. Opus high + Opus medium: 77.9% vs 77.2%. Fable + Opus medium: 70.0% vs 70.3%. All 6: 85.8% vs 85.9%. Opus high ×2 + Fable ×2: 83.3% vs 84.8%.
   - Result: a single shared difficulty scale explains the cross-model overlap to about 1 pp. The model-specific diversity that is left is at most about +1.5 pp at 4 runs.

### P2. Projected union recall, Opus 5.5 high

| k | Two-class | Beta-binomial | Joint | Two-class 95% band | Beta-binomial 95% band |
|---|---|---|---|---|---|
| 1 | 72.0% | 72.0% | 72.0% | 66.9–77.7 | 66.9–77.7 |
| 2 | 80.1% (measured) | 80.1% (measured) | 81.1% | 75.7–85.1 | 75.7–85.1 |
| 3 | 81.0% | 83.7% | 84.9% | 76.6–86.0 | 79.3–88.5 |
| 4 | 81.1% | 85.9% | 87.2% | 76.7–86.0 | 81.5–90.4 |
| 5 | 81.1% | 87.3% | 88.9% | 76.7–86.0 | 83.0–91.8 |

Bands: bootstrap over diffs, 2,000 resamples.

### P3. Projected union recall, Fable 5.1 (medium data; Fable high is not measured)

| k | Two-class | Beta-binomial | Joint |
|---|---|---|---|
| 1 | 55.2% | 55.2% | 55.2% |
| 2 | 67.0% | 67.0% | 66.0% |
| 3 | 69.5% | 72.7% | 71.0% |
| 4 | 70.1% | 76.2% | 74.4% |
| 5 | 70.2% | 78.7% | 76.9% |

### P4. Mixed ensembles (joint model)

| Runs | Union recall | Cost (Opus-equivalent weighted tokens) |
|---|---|---|
| Opus high ×1 + Fable ×1 | 75.9% (measured 76.8%) | 1.77M |
| Opus high ×2 | 81.1% (measured 80.1%) | 1.18M |
| Opus high ×2 + Fable ×1 | 82.4% | 2.36M |
| Opus high ×3 | 84.9% | 1.77M |
| Opus high ×2 + Fable ×2 | 83.3% (measured 84.8%) | 3.54M |
| Opus high ×4 | 87.2% | 2.36M |
| Opus high ×3 + Fable ×2 | 86.1% | 4.13M |

On this data, at each cost, more Opus high runs give a higher union than a mix that includes Fable medium.

### P5. Marginal items and cost per extra key item

Assumptions: 6.37 key items per diff (191/30). One Opus 5.5 high two-axis run = 0.59M weighted tokens (#349 median). One Fable 5.1 run = 2 × 0.59M = 1.18M Opus-equivalent weighted tokens (the brief's rule: Fable is about 2× Opus per token; #349's API-equivalent price ratio is $4.76/$2.32 = 2.05×). Fable high has no measured token count. Cost per extra item = run cost / (marginal pp × 6.37 / 100).

Opus 5.5 high:

| Run k | Marginal recall (two-class / beta-binomial / joint) | Extra items per diff (beta-binomial) | Cost per extra item (two-class / beta-binomial / joint) |
|---|---|---|---|
| 1 | +72.0 pp | 4.58 | 0.13M |
| 2 | +8.1 / +8.1 / +9.1 pp | 0.52 | 1.14M / 1.14M / 1.02M |
| 3 | +0.9 / +3.6 / +3.8 pp | 0.23 | 10.1M / 2.57M / 2.44M |
| 4 | +0.1 / +2.1 / +2.3 pp | 0.14 | 90M / 4.31M / 4.03M |
| 5 | +0.0 / +1.5 / +1.7 pp | 0.09 | ∞ / 6.32M / 5.45M |
Fable 5.1 (medium recall, 1.18M per run):

| Run k | Marginal recall (two-class / beta-binomial / joint) | Cost per extra item (two-class / beta-binomial / joint) |
|---|---|---|
| 1 | +55.2 pp | 0.34M |
| 2 | +11.8 / +11.8 / +10.8 pp | 1.57M / 1.57M / 1.72M |
| 3 | +2.5 / +5.7 / +5.0 pp | 7.4M / 3.25M / 3.71M |
| 4 | +0.5 / +3.5 / +3.4 pp | 35M / 5.28M / 5.45M |

Fable as an added run after one Opus high run (measured): +4.8 pp, 0.31 items, 1.18M / 0.31 = 3.9M per item. A second Opus high run: +8.1 pp, 0.52 items, 1.14M per item. Thus the second Opus high run costs about 3.4× less per extra item than a Fable medium run.

### P6. Which model to believe past k = 2

- Two runs per arm cannot tell the two-class model from the beta-binomial model. Both fit the two-run data exactly. They separate only at k ≥ 3.
- The joint model takes information from the other arms: Fable and Opus medium found some items that both Opus high runs missed (all-6 union 85.9% > Opus high ×2 80.1%). Thus at least 5.8 pp of the items that Opus high ×2 missed are findable. This is evidence against the pure two-class model (which puts 18.9% of items at p = 0 for Opus high) and for a model with a long tail, such as the beta-binomial or the joint model.
- The published evidence (section W) also shows a slow, saturating, power-law-like tail for pass@k and for repeated sampling.- Thus the best estimate for Opus 5.5 high is: k = 3 ≈ 84–85%, k = 4 ≈ 86–87%, k = 5 ≈ 87–89%. The pessimistic floor is about 81% for all k ≥ 3.

## W. Published evidence (task items 1–3)

Tags: [VENDOR] = vendor or industry write-up, not peer reviewed. [PAPER] = arXiv or conference paper. [PRACTITIONER] = one person's measured experiment. Transfer = how directly the result applies to our setting (an agentic Claude reviewer on a diff, scored by recall against a known-defect key).

### W1. Anthropic: Code Review and ultrareview [VENDOR]

- Code Review (managed GitHub service): "multiple agents analyze the diff and surrounding code in parallel ... Each agent looks for a different class of issue, then a verification step checks candidates against actual code behavior to filter out false positives." Source: https://code.claude.com/docs/en/code-review (fetched 13 Oct 2026).
- Launch post figures: "Before, 16% of PRs got substantive review comments. Now 54% do." "less than 1% of findings are marked incorrect." "on large PRs (over 1,000 lines changed), 84% get findings, averaging 7.5 issues." "On small PRs under 50 lines, that drops to 31%, averaging 0.5 issues." "Large or complex changes get more agents and a deeper read." Cost "$15–25" per review. Source: https://claude.com/blog/code-review.
- Ultrareview: "a fleet of reviewer agents" in a cloud sandbox; "every reported finding is independently reproduced and verified"; "a larger fleet of reviewer agents explores the change in parallel, which surfaces issues that a local review can miss". $5–$25 per review after 3 free runs. Source: https://code.claude.com/docs/en/ultrareview.
- Anthropic's open-source `code-review` plugin: 4 parallel agents. Agents 1 and 2 (Sonnet) are identical (CLAUDE.md compliance). Agent 3 (Opus) scans the diff only for obvious bugs. Agent 4 (Opus) looks at the introduced code for security and logic problems. Then Opus subagents validate each bug finding, and unvalidated findings are removed. Source: https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/code-review/commands/code-review.md.
- What Anthropic does NOT publish: the number of agents, a recall figure, or a curve of recall against fleet size. The design choice (different focus per agent, then verification) is evidence of practice, not a measurement.
- Transfer: high for design (same vendor, same models, diff review). Zero for numbers on k.

### W2. Cursor Bugbot [VENDOR]

- Early design: "eight parallel bug-finding passes, each with a randomized diff order", then bucket similar bugs, keep the bugs that more than one pass found (majority voting), then a validator model. Different orderings "nudged the model toward different lines of reasoning". "When several passes independently flagged the same issue, we treated it as a stronger signal that the bug was real."
- Later they replaced the fixed passes with one agentic loop, and said it gave the "largest gains". No numbers for that change.
- Over 40 experiments (V1 July 2025 to V11 January 2026): resolution rate 52% → over 70%; bugs flagged per run 0.4 → 0.7; resolved bugs per PR about 0.2 → 0.5.
- Source: https://cursor.com/blog/building-bugbot.
- Transfer: medium. Note that Cursor used repeats for **precision** (voting), not for recall. Majority voting removes a bug that only one pass finds, so it decreases recall. For our purpose (recall on a mission-critical change), the union, not the vote, is the relevant rule. No recall-vs-k figure is published.

### W3. Sean Heelan, o3 on the Linux ksmbd code (CVE-2025-37778, CVE-2025-37899) [PRACTITIONER]

- Session-setup code only (~3.3k LoC, ~27k tokens), 100 runs: o3 found the known bug in **8 of 100** runs; 66 runs said no bug; 28 were false positives. Claude Sonnet 3.7: **3 of 100**. Claude Sonnet 3.5: **0 of 100**.
- All command handlers (~12k LoC, ~100k tokens), 100 runs: o3 found the known bug in **1 of 100**. In other runs it found a new bug (CVE-2025-37899). Signal-to-noise about 1:50. Cost about $116 for 100 runs.
- The author: treat the model "like fuzzing where you are sampling from a distribution."
- Source: https://sean.heelan.io/2025/05/22/how-i-used-o3-to-find-cve-2025-37899-a-remote-zeroday-vulnerability-in-the-linux-kernels-smb-implementation/.
- Transfer: low to medium. It is single-shot prompting, not an agentic review, and one bug. But it shows the "hard tail": for a hard bug, per-run p can be 0.01–0.08. Then union recall rises almost linearly with k for a long time (1 − (1 − 0.08)^k: k = 5 → 34%, k = 10 → 57%). This is the beta-binomial tail in section P, for single items.

### W4. SWR-Bench: repeated reviews on real PRs, then one aggregation call [PAPER, FSE 2026]

- 1,000 manually verified GitHub PRs. LLM judge with about 90% agreement with humans. Source: https://arxiv.org/abs/2509.01494 (HTML: https://arxiv.org/html/2509.01494).
- "Self-Agg" = the same model writes n independent reviews, and one more call merges them. "Multi-Agg" = reviews from different models, merged. n ∈ {0, 1, 3, 5, 10}.
- Gemini-2.5-Flash Self-Agg at n = 10: recall 30.44% (+118.83% relative; single-run baseline 13.91%); F1 21.91% (+43.67%). Qwen-2.5-7B: F1 +26.13%. Qwen-2.5-32B: F1 +19.25%.
- Saturation: "performance gains exhibit diminishing returns beyond n=5, while costs continue to scale linearly"; the authors call n = 5 "a practical sweet spot".
- Gemini-2.5-Flash Self-Agg n = 5 (F1 20.48%) beat single-pass Gemini-2.5-Pro (F1 19.38%) at lower cost.
- Same model vs different models: the text says F1 improved in both cases. It gives no separate Multi-Agg figures. NOT VERIFIED: the per-n values (they are only in Figure 9a, which the fetch did not read).
- Transfer: high for task (PR review, recall against a reference set). Low for level: single-run recall is 14–36% there, against 55–72% here. A low base recall leaves much more room for the union to grow. Expect a smaller relative gain at our base.

### W5. Google Project Zero, Naptime: k independent agent trajectories [VENDOR]

- CyberSecEval 2 tasks, with a verifier for each trajectory. Score at k = 1 / 10 / 20 trajectories:
  - Buffer overflow, GPT-4 Turbo: 0.71 / 1.00 / 1.00. Gemini 1.5 Pro: 0.40 / 0.96 / 0.99.
  - Advanced memory corruption (original), GPT-4 Turbo: 0.36 / 0.69 / 0.76. Gemini 1.5 Pro: 0.26 / 0.51 / 0.60.
  - Advanced memory corruption (revised), GPT-4 Turbo: 0.32 / 0.51 / 0.55. Gemini 1.5 Flash: 0.28 / 0.42 / 0.47.
- ASan@k results "appear to be plateauing at or before k=20".
- Source: https://projectzero.google/2024/06/project-naptime.html.
- Transfer: medium. Agentic, security, independent runs, union scoring (a task passes if any trajectory passes). But the targets are small synthetic programs, and each task has one bug, not a list of defects. The shape is the useful part: large gain from k = 1 to 10, then a plateau below 100% on the hard set.

### W6. Repeated sampling: shape of the curve [PAPER]

- Brown et al., "Large Language Monkeys" (arXiv 2407.21787): SWE-bench Lite solved share (coverage) went from 15.9% with 1 sample to 56% with 250 samples (DeepSeek-Coder-V2-Instruct). Coverage against k is often log-linear and fits an exponentiated power law. Without a verifier, majority voting and reward models plateau after several hundred samples. Source: https://arxiv.org/abs/2407.21787.
- Schaeffer et al., "How Do Large Language Monkeys Get Their Power (Laws)?" (ICML 2025, arXiv 2502.17578): on each single problem the failure rate falls exponentially with k. The aggregate falls as a power law because "the distribution of single-attempt success probabilities is heavy tailed". Source: https://arxiv.org/abs/2502.17578. NOT VERIFIED from the abstract: whether the paper fits a Beta distribution. (The beta-binomial in section P has exactly this property: the missed fraction falls approximately as k^(−a), with a ≈ 0.49 for Opus high.)
- Transfer: medium for the shape, which supports the beta-binomial / joint models over the two-class model. Low for levels (math and code generation with a verifier, not review).

### W7. Correlated errors between models [PAPER]

- Kim et al., "Correlated Errors in Large Language Models" (ICML 2025, arXiv 2506.07962): over 350 LLMs, "models agree 60% of the time when both models err" on one leaderboard. Shared provider and shared architecture increase the correlation. Larger, more accurate models have highly correlated errors, also across different providers. Source: https://arxiv.org/abs/2506.07962.
- Goel et al., "Great Models Think Alike and this Undermines AI Oversight" (ICML 2025, arXiv 2502.04313): a metric (CAPA) for error overlap above chance. Model mistakes become more similar as capability increases. LLM judges favour models similar to themselves, also after control for capability. Source: https://arxiv.org/abs/2502.04313.
- Transfer: medium. These are multiple-choice and classification tasks, not code review. But both papers predict the local result in L4: two strong models from one vendor (Opus 5.5, Fable 5.1) share most blind spots. A different vendor gives less correlation than the same vendor, but the papers say that capability itself also increases correlation.
- Related: the #349 judge was Opus 5, and Goel et al. find that judges favour similar models. #349 found precision flat across arms; it did not test the judge for this bias.

### W8. Model diversity in vulnerability detection [PAPER]

- "Diverse LLMs vs. Vulnerabilities: Who Detects and Fixes Them Better?" (arXiv 2512.12536): 10 open models (CodeLlama, Llama 3/3.1, Gemma 2, Mistral, Mixtral), Linux kernel CVE commits (VulnLLMEval). Ensemble votes at a 60% threshold. Multi-file level: mean single-model recall 64.06%, best single model 84.07%, ensemble 82.11%. The "+18%" is over the mean model, not over the best. No union or overlap analysis; one anecdote only. Source: https://arxiv.org/html/2512.12536v1.
- Transfer: low. Small open models, classification (vulnerable or not), and a vote, which decreases recall against the best member.
- CyberGym (ICLR 2026, arXiv 2506.02548): 4 different agent scaffolds, all on GPT-4.1, have similar single success rates. The union of the 4 reaches 18.4%, "nearly double the best individual result", with "small success overlap across different agents". In open-ended discovery, GPT-4.1 found 7 and GPT-5 found 22 confirmed zero-days, "with 4 overlapping". Source: https://arxiv.org/html/2506.02548v2.
- Transfer: medium. This is the strongest published evidence that **different scaffolds/approaches on one model** decorrelate runs strongly. It is about PoC reproduction, not review.

### W9. Focus or prompt diversity against identical repeats [PAPER]

- PlanSearch (Wang et al., ICLR 2025, arXiv 2409.03733): repeated sampling gives "highly similar, yet incorrect generations". Search over different natural-language plans: Claude 3.5 Sonnet, LiveCodeBench pass@200 = 77.0%, against 60.6% for plain repeated sampling and 41.4% pass@1. The gain is predicted by the measured diversity of ideas. Source: https://arxiv.org/html/2409.03733v1.
- DIV-SE (Naik et al., arXiv 2310.07088): at a fixed generation budget, prompts that each ask for a different reasoning approach beat self-consistency (identical prompt, sampled) on reasoning benchmarks with GPT-3.5 and GPT-4. Source: https://arxiv.org/abs/2310.07088. Not replicated independently (not found).
- Practice: Anthropic Code Review ("Each agent looks for a different class of issue"), Anthropic's code-review plugin (different angles for its two Opus bug agents), Cursor Bugbot (different diff order per pass). All three vendors vary the focus or the input per agent. None publishes a measured comparison with identical runs.
- iCodeReviewer (arXiv 2510.12186): one prompt "expert" per security issue type, with a router. F1 63.98%; production acceptance up to 84%. No ablation against one general prompt was found. Source: https://arxiv.org/abs/2510.12186.
- No published study was found that compares, at the same budget, k identical code-review runs with k runs that each have a different focus, scored by recall.
- Transfer: medium. The direction (diversity of approach > identical sampling) is consistent across code generation, reasoning and PoC reproduction. The size in code review is not measured.
- Local note: the #349 runs are already a two-focus design (STANDARDS axis + SPEC axis). The repeat in #349 repeated both axes. A third focus (for example, access control and money paths) is not measured.

### W10. What was searched and not found

- No published recall-vs-k curve for repeated runs of a Claude reviewer on code review.
- No study that keeps per-run cells for two frontier models from one vendor on code review and measures cross-model overlap. The local recovered #349 cells (section L) are the closest data found.

## R. Is a local replay that keeps per-run cells worth it? (task item 5)

### R1. What the recovered cells already settle (cost 0)

- The cross-model overlap between Opus 5.5 high and Fable 5.1 **medium** (L4).
- Over the 191 items: 9 items (4.7%) were found by a Fable medium run but by neither Opus high run. 34 items were found by an Opus high run but by neither Fable run. 7 items were found by an Opus medium run but by neither Opus high run.
- The second-run gain is measured with a 95% interval over diffs: Opus high +8.1 pp (6.1–10.1); Fable medium +11.8 pp (8.6–15.0).

### R2. What the cells do not settle

1. Fable 5.1 at **high** effort (the escalated tier uses Fable high). Unknown: its single-run recall and its overlap with Opus high.
2. The shape past k = 2: two-class (k = 3 adds +0.9 pp) or long tail (k = 3 adds +3.6 to +3.8 pp).
3. Focus diversity: does a run with a different focus (for example access control + money logic) add more than an identical repeat?
4. Transfer to mission-critical code. The 30 diffs are mantahostels machinery (hooks, scripts, docs). Manta is pre-launch, so few or no RLS, reward-code or money diffs exist to replay. Thus any replay now measures machinery diffs again.

### R3. Replay options and allowance cost

Unit costs: Opus 5.5 high two-axis run = 0.59M weighted tokens (#349 median). Fable 5.1 run = 1.18M Opus-equivalent (the brief's 2× rule; Fable high's own token count is unmeasured, and high effort can use more tokens than medium). Judge call per diff = 0.21M weighted median (computed here from the 30 #349 judge files, Opus 5, 6 reviews per call); assume about 0.25M for a new judge call.

| Option | Runs | Run cost | Judge cost | Total | What it settles |
|---|---|---|---|---|---|
| A. Fable high ×2 on 30 diffs | 60 | 70.8M | 7.5M | ~78M | R2 item 1 |
| B. Opus high ×2 more on 30 diffs (k = 4) | 60 | 35.4M | 7.5M | ~43M | R2 item 2 |
| C. Opus high, 2 focused runs (different lens each) on 30 diffs | 60 | 35.4M | 7.5M | ~43M | R2 item 3 (compare with the existing identical repeat) |
| A + B + C | 180 | 141.6M | ~10M (one judge per diff) | ~152M | items 1–3 |
| Half sample (15 diffs) of A + B + C | 90 | 70.8M | ~5M | ~76M | items 1–3, wider intervals |

For scale: #349 was estimated at ~165M weighted input-equivalents.

Power: on 30 diffs, the 95% interval on the second-run gain is about ±2 pp for Opus high (6.1–10.1). That is narrow enough to separate +0.9 pp from +3.6 pp at k = 3 (option B). On 15 diffs it is about ±3 pp (5.2–11.0), which is marginal. The difference between two added-run types (second Opus high vs Fable medium) had a 95% interval of ±7 pp on 30 diffs (L4), so a focus-vs-identical comparison (option C) can detect only a large difference, about 8 pp or more.
## S. Summary of the numbers that matter for the recommendation

Measured (recovered #349 cells, 30 mantahostels diffs, 191 key items):
- Opus 5.5 high: 1 run 72.0%; 2 runs **80.1%** (+8.1 pp, 95% 6.1–10.1). The second run finds 29% of what the first missed.
- Fable 5.1 medium: 1 run 55.2%; 2 runs 67.0% (+11.8 pp).
- One Opus high + one Fable medium: **76.8%** (lower than two Opus high runs, 80.1%, at 1.5× the cost).
- Opus high ×2 + Fable medium ×2: 84.8%. All six runs: 85.9%. 14.1% of items were found by no run.
- A Fable medium run is not less correlated with Opus high than a second Opus high run is (conditional/own-recall ratio 0.31 vs 0.40; difference interval −0.03 to +0.21). The published evidence on correlated errors (Kim et al.; Goel et al.) predicts this for strong models from one vendor.

Projected (section P; best estimate = beta-binomial/joint; floor = two-class):
- Opus 5.5 high union recall, k = 1..5: 72.0, 80.1, ~84 (floor 81.0), ~86–87 (floor 81.1), ~87–89 (floor 81.1).
- Fable 5.1 (medium data), k = 1..5: 55.2, 67.0, ~71–73, ~74–76, ~77–79.
- Cost per extra key item, Opus high (0.59M per run): run 1 0.13M; run 2 ~1.1M; run 3 ~2.5M (floor case 10M); run 4 ~4M; run 5 ~5.5–6.3M.
- Cost per extra key item, Fable (1.18M per run): run 1 0.34M; run 2 ~1.6M; run 3 ~3.3–3.7M. Fable as the second run after one Opus high: ~3.9M per extra item.
- Marginal items per diff (6.37 key items per diff), Opus high: run 2 +0.52; run 3 +0.23; run 4 +0.14; run 5 +0.10.

Focus per run:
- No measurement on code review, published or local. Both vendors that publish a design (Anthropic, Cursor) vary the focus or the input per agent. Evidence from code generation (PlanSearch: pass@200 77.0% vs 60.6% for plain repeats), reasoning (DIV-SE) and PoC reproduction (CyberGym: union of 4 scaffolds on one model ≈ 2× the best single) shows that diversity of approach decorrelates runs more than plain sampling does.

Open (not measured; the run counts, the mission-critical test and any replay are decided on #1556): Fable 5.1 **high**; the k ≥ 3 shape (two-class vs long tail); focused vs identical runs; transfer from machinery diffs to RLS, reward-code and money diffs; the bias of a key built mostly from Opus 5 findings; the judge's family bias.
