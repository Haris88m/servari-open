# Launch Ladder (demo)

A generic five-stage rollout ladder. The shell parses the markdown table below
into the LaunchArc panel (`/api/launch`). Edit the rows to match your own plan;
the `Status` cell is classified into a dot color (DONE / PARTIAL / UNMET).

| Stage | Goal | Status | Gate |
|---|---|---|---|
| 1. Prototype | Working shell on one machine | DONE | self-review |
| 2. Pilot | One real user, one real model wired | PARTIAL | user feedback |
| 3. Hardening | Reliability, error handling, docs | PARTIAL | test pass |
| 4. Beta | Small group of external users | UNMET | sign-off |
| 5. Launch | Public release | UNMET | go/no-go |
