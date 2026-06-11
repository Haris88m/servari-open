# -*- coding: utf-8 -*-
# Portions derived from Odysseus (MIT) — see NOTICE.
# https://github.com/pewdiepie-archdaemon/odysseus
# Copyright (c) 2025 Odysseus Contributors. Licensed under the MIT License.
"""Model Cookbook — hardware-aware model recommendations.

Ported from Odysseus services/hwfit/ (MIT): calibrated VRAM/quant/bandwidth
math + a curated model catalog, scored against the locally detected hardware.
Local-only (the SSH-remote / multi-GPU orchestration of the original is NOT
ported). Pure stdlib, consistent with the SERVARI server's zero-dependency rule.

Modules:
  hardware  — local CPU/RAM/GPU/VRAM probe (degrades gracefully: no GPU,
              sandboxed environments, missing tools all yield a valid profile)
  models    — quant tables (BPP/speed/quality), VRAM estimator, model catalog
  fit       — GPU bandwidth table, tok/s estimator, use-case scoring, ranking
  profiles  — llama.cpp serve profiles (Quality/Balanced/Speed) from the same math
"""
