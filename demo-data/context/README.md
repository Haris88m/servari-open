# context/

The context-pressure policy writes its checkpoint audit here
(`context/audit.jsonl`) when you POST `/api/context-checkpoint`. The pressure and
survival-pin signals are derived live from `active-work.json`, the `work-log/`
entries, the `sessions/` facets, `gate-queue.jsonl`, and `transcripts/` — there
is no static state to ship here, only this note.
