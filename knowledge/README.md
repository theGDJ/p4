# Knowledge seed (P0)

`manifest.csv` lands in phase **P0** and is a team task, not an agent task.

Columns (master spec §PART B P0):
`source_url, title, doc_type, publisher, access[open|restricted], license_note, language, category, priority, status`

Rules that bind whoever fills it in:
- Only **legally accessible official** documents (R11). No paywalled full text, no
  bypassing access controls.
- Restricted items are recorded as `restricted` and stay **metadata-only** (R7 `RESTRICTED`).
- No invented URLs, titles or standard numbers (R2, R10). Every row needs real provenance.
- The build sandbox has **no network route to bis.gov.in** (docs/ENVIRONMENT.md), so rows
  cannot be verified from here; they must be confirmed by a human before `status=approved`.

Until the manifest exists the knowledge base is empty, which means every question
correctly returns the R4 fallback sentence with evidence tier `NONE`.
