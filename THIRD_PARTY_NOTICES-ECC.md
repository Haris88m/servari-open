# Third-Party Notices — ECC (consume-ecc branch)

This branch contains agent definitions **derived from** the ECC project and
converted into SERVARI's own agent schema.

## Source

- **Project:** ECC (Everything Claude Code)
- **Repository:** https://github.com/affaan-m/ECC
- **License:** MIT (SPDX: `MIT`)
- **Copyright:** Copyright (c) 2026 Affaan Mustafa

## License verification record

- Verified on **2026-06-12** via the GitHub API:
  - `gh api repos/affaan-m/ECC` returned `"license": {"spdx_id": "MIT"}`.
  - `gh api repos/affaan-m/ECC/contents/LICENSE` (base64-decoded) returned the
    standard MIT license text, reproduced in full below.

## What was consumed, and how

- **What:** the 64 agent definition files under ECC's top-level `agents/`
  directory (markdown with YAML frontmatter: `name`, `description`, `tools`,
  `model`).
- **How:** each definition was **transformed — not copied —** into SERVARI's
  agent schema by [`tools/consume_ecc.py`](tools/consume_ecc.py) in this
  branch: frontmatter became roster metadata in `demo-data-ecc/agents.json`
  and org entries in `demo-data-ecc/team.json`; the instruction body became
  the agent brief `demo-data-ecc/agents/<id>/START.md`. Every converted
  artifact is tagged `source=ECC`, `source_license=MIT`,
  `consumed_at=2026-06-12`, `converter=tools/consume_ecc.py`.
- **ECC's code was NOT copied.** No hooks, scripts, commands, rules, skills,
  plugin configurations, or any other executable content from ECC is included
  in this branch. Only agent definitions — data, not code — were converted.

## Consumed agent definitions (64)

- a11y-architect
- architect
- build-error-resolver
- chief-of-staff
- code-architect
- code-explorer
- code-reviewer
- code-simplifier
- comment-analyzer
- conversation-analyzer
- cpp-build-resolver
- cpp-reviewer
- csharp-reviewer
- dart-build-resolver
- database-reviewer
- django-build-resolver
- django-reviewer
- doc-updater
- docs-lookup
- e2e-runner
- fastapi-reviewer
- flutter-reviewer
- fsharp-reviewer
- gan-evaluator
- gan-generator
- gan-planner
- go-build-resolver
- go-reviewer
- harmonyos-app-resolver
- harness-optimizer
- healthcare-reviewer
- homelab-architect
- java-build-resolver
- java-reviewer
- kotlin-build-resolver
- kotlin-reviewer
- loop-operator
- marketing-agent
- mle-reviewer
- network-architect
- network-config-reviewer
- network-troubleshooter
- opensource-forker
- opensource-packager
- opensource-sanitizer
- performance-optimizer
- php-reviewer
- planner
- pr-test-analyzer
- python-reviewer
- pytorch-build-resolver
- react-build-resolver
- react-reviewer
- refactor-cleaner
- rust-build-resolver
- rust-reviewer
- security-reviewer
- seo-specialist
- silent-failure-hunter
- swift-build-resolver
- swift-reviewer
- tdd-guide
- type-design-analyzer
- typescript-reviewer

## MIT License (ECC, full text)

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
