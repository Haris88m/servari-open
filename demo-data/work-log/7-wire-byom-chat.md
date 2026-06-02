# 7 — Wire the BYOM chat backend

The canonical record for the current in-flight work (active-work.json work_id 7).

- **Goal:** a provider-agnostic chat call reading config.json (provider / api_key / model / base_url).
- **Status:** in progress — drafting the call.
- **Open risk:** none HIGH. Validate the model name before the first request.
- **Next action:** add the model-name validation, then a smoke test against a local model.
