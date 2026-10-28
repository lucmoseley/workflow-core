# llm-evaluation

Researched: 2026-10-28

## The key (ground truth) and pooling bias

- A key built from the output of the systems under test favours those systems. Zobel removed the items that only one run contributed and scored that run again: the mean loss was 0.5% to 2.2%, but 7% to 19% on the queries with the most answers, and up to 14% with a shallow pool. Zobel, "How Reliable are the Results of Large-Scale Information Retrieval Experiments?", SIGIR 1998 §4 [named expert]
- Test a pooled key with the "leave out uniques" (LOU) test, and remove all items from the same group of runs, not only one run. The test cannot see the bias when "all the runs use the same or very similar systems". Buckley, Dimmick, Soboroff, Voorhees (NIST), Information Retrieval 10(6) 2007 §2 [standard or field body]
- To score a new system, pool its unjudged output, remove what is already judged, and have an assessor judge the rest without knowing which system produced it. "cherry-picking documents from a small set of runs risks biasing the qrels in favor of those runs". Voorhees, Soboroff, Lin, arXiv 2201.11086 (2022) §3 [standard or field body]
- On production code, recall against a full key is not possible; use sources of truth independent of the tools (expert analysis, field-reported defects such as CVEs) and report them apart, because they are few. NIST SP 500-326 (SATE V) §1.6, §1.8 [standard or field body]
- Absolute recall against a pooled key is high-biased (at best 50% to 70% of relevant items were found in the TREC pools Zobel studied). Trust differences between arms on a shared, re-pooled key, not absolute levels. Zobel 1998 §5 [named expert]

## LLM judges

- Give the judge a matching task against a fixed key ("does finding X hit key item Y"), not a quality score. Hit agreement was kappa 0.71 to 0.87 over human and LLM pairs. On human preference, a matching judge reached kappa 0.53 to 0.62 (human-human 0.56 to 0.63); a score judge reached only 0.31 to 0.45. Zeng et al., SWR-Bench, FSE 2026 §3.4, §4 [named expert]
- Grade the match (equivalent, strongly related, weakly related) and keep an "unknown" class. NIST SP 500-326 §1.8 [standard or field body]
- Validate the judge against a human on a held-out set: freeze the prompt, run once, report true positive rate and true negative rate, about 30 to 50 examples of each label, never in the prompt. Husain, hamel.dev/blog/posts/llm-judge/ (read 2026-10-28) [named expert]
- Let the human grade real outputs before the criteria are fixed; criteria drift as people grade. Shankar et al., UIST 2024 (arXiv 2404.12272) [named expert]
- Judges have position bias; swap the order and accept only verdicts that agree in both orders. Zheng et al., MT-Bench, NeurIPS 2023 §3.3–3.4 [named expert]
- Judges favour their own output, and the bias grows with self-recognition. Prefer a judge from another model family or version, or report the limit. Panickssery, Bowman, Feng, NeurIPS 2024 [named expert]
- Correct an imperfect judge with a small gold set by prediction-powered inference, which gives valid intervals without assumptions on the judge. Angelopoulos et al., Science 2023 [named expert]

## Statistics and power

- Compare arms paired on the same items; cluster the standard error when items come in groups, and report the cluster count. Resample each item K times to cut run-to-run variance. Plan n and K with the power formula before the run. Miller, "Adding Error Bars to Evals", arXiv 2411.00640 (2024) [named expert]
- With fewer than about 20 to 50 clusters, cluster-robust Wald tests over-reject; use a wild cluster bootstrap or an exact sign-flip test over clusters. Cameron, Miller, J. Human Resources 2015 §VI [named expert]
- Run a simulation power analysis first; an underpowered significant result exaggerates the effect or gets its sign wrong. McNemar's test on discordant items is the standard paired test for two classifiers when items are independent. Card et al., EMNLP 2020 [named expert]; Dror et al., ACL 2018 [named expert]

## Repeated sampling and union (any-of-k) metrics

- Estimate any-of-k success from n ≥ k samples per item with the unbiased estimator 1 − C(n−c, k)/C(n, k), not from one draw of k samples. Chen et al., arXiv 2107.03374 (2021) §2.1 [named expert]
- The aggregate any-of-k curve follows a power law because per-item success probabilities are heavy-tailed; fit that distribution to project past the measured k. Schaeffer et al., ICML 2025 [named expert]
- To estimate the defects no reviewer found, use a capture–recapture model with per-defect heterogeneity (Mh, jackknife); estimates are unstable with three or fewer reviewers. Briand, El Emam, Freimut, ISERN-98-11 (1998) [named expert]

## Arms and controls

- Compare a variant with its control at the same team size or budget, with one factor changed. Laitenberger, El Emam, Harbich, IEEE TSE 2001 [named expert]; Naik et al., DIV-SE, arXiv 2310.07088 [named expert]
- Log the cost of every run and report the effect per unit cost beside the effect. Derived from DIV-SE's accuracy–cost frontier; one source, so it sets no default [unverified]

## Tools

- No Claude-compatible skill, plugin or MCP server for this kind of offline replay evaluation was checked in this pass. Not searched [unverified]
