# GitHub / research landscape (scan of 2026-11-15)

Method: web searches plus reading the OSIRIS repository. Entries marked *(summary only)* were judged from search-result summaries, not from reading their code. Star counts and maintenance status change; verify before depending on anything.

## Reuse directly

| What | Why it matters here | Status |
|---|---|---|
| `google-research/camel-prompt-injection` (CaMeL) | Reference design for control-flow/data-flow separation with capabilities; the paper reports 77% of AgentDojo tasks solved with provable security vs 84% undefended. | Code released *(summary only)* |
| LlamaFirewall (Meta): PromptGuard 2 + AlignmentCheck | Classifier and reasoning auditor to layer *under* the structural gate as defence in depth. | Open source per paper *(summary only)* |
| AgentDojo | The benchmark CaMeL is evaluated on; a standard yardstick for agent-injection work. | Referenced in CaMeL paper |
| `forecastingresearch/forecastbench` (+ datasets) | Contamination-free resolved questions to score OI Forecast with `calibration`. Code MIT, data CC-BY-SA. | Maintained at least to mid-2027 per slides |
| `suprathermal/ACH-Grounding` | "LLM fills the matrix, code does the arithmetic": same split as `ach.ts`. Token cost grows quadratically, so small matrices only. | Working implementation *(summary only)* |
| Stanford GPS Lab GNSS-RFI resources (rfi.stanford.edu, GitHub downloader) | Public ADS-B-derived jamming/spoofing data; a ready source for an East-Med interference layer. | *(summary only)* |
| OpenSky Network | The ADS-B source OSIRIS already uses; NACp/NIC fields drive jamming detection. | Used by OSIRIS |

## Compare against (closest existing work)

| What | Overlap | Gap relative to this repo |
|---|---|---|
| `fort3/fortis-intel` | Admiralty grading, contradiction detection, ACH, claim verification layers. | No information-flow gate on tool calls; independence-aware release not described *(summary only)* |
| `vericle/intellyweave` | OSINT analysis platform with multi-agent debate and hypothesis-driven investigation. | Same *(summary only)* |
| `emillambert/QATIS` | AI evaluation producing Admiralty codes and PMESII tags. | Collection/evaluation, not enforcement *(summary only)* |
| `OpenOSINT/OpenOSINT` | Agent with 9-18 OSINT tools, REPL, CLI and MCP server. | Person-lookup tools with no provenance gate: a natural second adapter *(summary only)* |
| ShadowBroker | Self-hosted multi-domain OSINT map, 60+ feeds. | Dashboard; no agent safety layer described *(summary only)* |
| NeuroTaint, ARM, APPA, FIDES (papers) | Taint/provenance for LLM agents, recoverable IFC, reference monitors. | Domain-agnostic; labels are not source-reliability grades *(summary only)* |
| `twschiller/open-synthesis` | Human collaborative ACH. | Maintenance mode, no AI. |

## Data and methods to build on later

- Cross-platform coordinated-behaviour detection on Telegram (USC ISI / Cinus et al.), and a 2026 paper releasing code and data for a narrative-coordination score over Telegram and Reddit. Both are English/Russian-centred; Hebrew/Arabic/Persian coverage is open ground.
- A public report by the International Institute for Counter-Terrorism (Reichman University) on a post-7-October coordinated inauthentic network on Israeli social media: a worked methodology for a Hebrew-language detector.
- Open-source GNSS interference literature (NACp/NIC-based detection and localisation) for an interference layer in the eastern Mediterranean.
