# Evaluation harness (P2/P6)

`golden.jsonl` lands in phase **P0**; the runner and CI gates land in **P6** (§12).

Schema, one JSON object per line:

```json
{"q": "Which Indian Standard applies to drinking water?", "lang": "en", "expected_doc_ids": ["..."], "must_cite": ["S1"], "answerable": true, "notes": "..."}
```

Requirements (§12):
- at least **40** items, English **and** Hindi
- at least **8** unanswerable items (must produce the exact R4 sentence)
- at least **5** vague items (must trigger clarification, not an answer)

Gate targets: citation validity 100%; correct fallback on unanswerable >= 95%;
hit@6 >= 80%; groundedness >= 90%; clarification triggered on the vague set >= 90%.

No golden item may reference a document that is not in `knowledge/manifest.csv`
with `status=approved` — that would make the gate measure a hallucination (R10).
