# capacity-planning-and-admission

Researched: 2026-10-23

## Admitting work against machine capacity

- Admit new work only when what running jobs have reserved, plus its own request, fits capacity; never against their live usage, so a quiet job's later peak still fits. Kubernetes, "Resource Management for Pods and Containers" (the scheduler refuses a pod on a node whose requests sum past capacity, "although actual memory or CPU resource usage on nodes is very low"); Slurm 26.05, "Consumable Resources in Slurm" and slurm.conf(5) (`CR_Memory` "prevents memory oversubscription" by counting each job's requested `--mem`); Verma et al., "Large-scale cluster management at Google with Borg", EuroSys 2015 §5.5 (prod tasks are placed on their limits, so "they never rely on reclaimed resources") [standard or field body]
- Charge a job that states no request a default at admission, never nothing; where its size scales with what it is allocated, charge the default per unit. Kubernetes, "Limit Ranges" (the admission controller "applies default request and limit values for all Pods … that do not set compute resource requirements"); Slurm, sbatch(1) and slurm.conf(5) (`--mem-per-cpu` defaults to `DefMemPerCPU`, "Default real memory size available per usable allocated CPU") [standard or field body]; Nomad, `resources` block (`memory` defaults to 300 MB), one vendor's product docs [unverified]
- The one exception: work that may be killed can be admitted against running jobs' usage estimates, which Borg calls reservations, instead of their requests, provided it is killed first when an estimate proves short. Verma et al., Borg, EuroSys 2015 §5.5 ("for non-prod tasks, it uses the reservations of existing tasks so the new tasks can be scheduled into reclaimed resources"; "we kill or throttle non-prod tasks, never prod ones") [standard or field body]
- Treat memory as incompressible and CPU as compressible: share CPU by weight and let it be overcommitted, since a shortfall only slows work; admit memory against reservations, since a shortfall kills. Verma et al., Borg, EuroSys 2015 §6.2 (non-compressible resources "generally cannot be reclaimed without killing the task"; for compressible ones the Borglet "throttles usage"); Linux `Documentation/admin-guide/cgroup-v2.rst` (`memory.max` is a "hard limit" past which "the OOM killer is invoked"; `cpu.weight` "proportionally distributes CPU cycles", "work-conserving"); Kubernetes, "Resource Management for Pods and Containers" ("`cpu` limits are enforced by CPU throttling", memory limits "with out of memory (OOM) kills") and "Node-pressure Eviction" (no CPU eviction signal) [standard or field body]
- Research: #2424, its 2026-10-22 research comment (issuecomment-6342458660); #2557, its resolution comment; #2548, its 2026-10-23 research comment (issuecomment-6351857252).

## Sizing a reservation from measurements

- Size a memory reservation to the job's measured peak plus a small margin, never to its mean. Rzadca et al., "Autopilot", EuroSys 2020 §3.2 ("we typically want to to [sic] provision for (close to) the peak memory usage"); HTCondor 25.14.1 `MemoryUsage` ("the peak memory usage for the job") with OSG User School 2026 ("use that number or a slightly larger number") [standard or field body]; DESY NAF, "How much memory" (set `RequestMemory` from a test job's peak), one facility's user docs [unverified]
- Google and Kubernetes put the margin at 10–15% and allow a high percentile of per-interval peaks in place of the peak; they are one lineage, so these figures set no default. Autopilot §3.2 ("increased by a 10–15% safety margin"; "S_p98 for jobs with low OOM tolerance"); Kubernetes VPA recommender (kubernetes/autoscaler `vertical-pod-autoscaler`, untagged, read 2026-10-23: memory keeps "the maximum usage over that interval", 90th percentile, `recommendation-margin-fraction` 0.15) — Autopilot §7: "Kubernetes' approach was directly inspired by our moving window recommenders" [standard or field body]
- Research: #2548, its 2026-10-23 research comment (issuecomment-6351857252).

## Measuring a job's memory and CPU draw

- Run each job in its own cgroup, started inside it, and read its memory as the cgroup's peak, not a sum or sample of per-process RSS: RSS counts a shared page once per process, and sampling misses short spikes. Linux `memory.peak` (kernel 5.19; per-descriptor reset from 6.12), whose commit 8e20d4b33266 calls `ru_maxrss` "the max RSS of a single child process" and polling `memory.current` "not practical"; systemd 255 `MemoryPeak` unit property; Slurm 26.05 slurm.conf(5) (`jobacct_gather/cgroup` "(recommended)") [standard or field body]
- The cgroup's peak includes page cache, which the kernel can drop. Excluding the cache gives up the peak: `anon` in `memory.stat` is a live value, and Slurm's `NoFileCache` stops it reading `memory.peak`, so short spikes go unrecorded. Linux `cgroup-v2.rst` (`file`: "Amount of memory used to cache filesystem data"); Slurm 26.05 slurm.conf(5) (`no_file_cache` "can result in MaxRSS failing to record short memory spikes"); HTCondor `CGROUP_IGNORE_CACHE_MEMORY` [standard or field body]
- Tools, read 2026-10-23:
  - `systemd-run --user --scope -p MemoryAccounting=yes <cmd>` (systemd 262 man page) puts a command in a transient cgroup [standard or field body]
  - `memory.peak`, `memory.current`, `memory.stat` and `cpu.stat` `usage_usec` in that cgroup (`cgroup-v2.rst`; cgroup v2 from kernel 4.5, `memory.peak` from 5.19); `usage_usec` over wall time is the mean CPUs used, and `cpu.stat` exists without the CPU controller [standard or field body]
  - `/proc/<pid>/smaps_rollup` `Pss` (kernel 4.14, `Documentation/filesystems/proc.rst`) where processes must be summed outside a cgroup: each shared page "is divided by the number of processes sharing it". A live value, with no peak [standard or field body]
  - PSI, `/proc/pressure/memory` and a cgroup's `memory.pressure` (kernel 4.20, `Documentation/accounting/psi.rst`): stall time, which shows the machine short of memory, not a job's size [standard or field body]
- Research: #2548, its 2026-10-23 research comment (issuecomment-6351857252).

## Reading out why work waits

- Name every limit failing now, not one: a fix to the first found may leave the next binding. Kubernetes `FitError` lists `"<count> <reason>"` for each (pkg/scheduler/framework/types.go) [standard or field body]; Nomad's Placement Failure lists each exhausted dimension, one vendor's product docs [unverified]; Gregg, USE method ("the first one you find may be _a_ problem but not _the_ problem") [named expert]
- Check gates on the job or on policy before resource fit, and report them first: they hide the resource reasons. Kubernetes PreFilter and `SchedulingGated`; Borg ("Quota-checking is part of admission control, not scheduling", EuroSys 2015 §2.5); `condor_q -analyze` (runnable state before the machine match) [standard or field body]
- Record events or per-state time counters, and derive averages as a time-weighted area (Little: L = ∫n(t)dt / T, "numerically exact"); a mean of samples is right only at a fixed interval with no gaps (Prometheus `avg_over_time`: every sample "the same weight"). Slurm `sreport` states sum to Reported; Linux PSI `total` counters [standard or field body]
- Keep a distribution beside the mean, since an average hides bursts. Kubernetes and Kueue wait histograms [standard or field body]; SRE book "Monitoring Distributed Systems" (bucketed counts); Gregg, USE method [named expert]
- Show a short reason token where the work is always listed, the full analysis on demand, and history in a dashboard or periodic report. `squeue` `NODELIST(REASON)`, `condor_q -analyze`, `sreport` rollups [standard or field body]; SRE book ("Dashboards should answer basic questions") [named expert]
- Research: #2497, its 2026-10-22 research comment (issuecomment-6338282041).

## Holding headroom for interactive work

- Keep the reserve standing while the arrivals it serves are expected, and refill it once one takes it. Size it to expected demand. Kubernetes, "Overprovision Node Capacity For A Cluster" [standard or field body]; AWS EC2 Auto Scaling, "warm pools", and Azure, "Standby pools for Virtual Machine Scale Sets" (standing and refill only), vendors' product docs [unverified]
- Release it when those arrivals stop. Only one vendor's product docs carry this, so it sets no default. AWS warm pools [unverified]
- Research: #2499, its resolution comment; #2548, its 2026-10-23 research comment (issuecomment-6351857252).

## Relieving memory pressure

- Read the pressure signal straight from kernel files, never through a call that itself needs memory or a CPU slice. Kubernetes, "Node-pressure Eviction" (`memory.available` "is derived from the cgroupfs instead of tools like `free -m`"); systemd-oomd(8) ("periodically polls PSI statistics for the system and those cgroups"); Android, "Low memory killer daemon" (PSI monitors, "the default mechanism of memory pressure detection for `lmkd`") [standard or field body]
- Reclaim what no running work uses before stopping work that runs. Kubernetes, "Node-pressure Eviction" ("The kubelet attempts to reclaim node-level resources before it terminates end-user pods"; pods whose usage exceeds requests go first) [standard or field body]
- Research: #2663, its resolution comment.
