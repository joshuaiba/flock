# Resolver tool fixtures

## Recorded (real responses)

Recorded 2026-11-10 with curl from the public USAspending API (no key), using
the pipeline's descriptive User-Agent, three requests in total:

- `usaspending_search_sikorsky.json`: `POST https://api.usaspending.gov/api/v2/recipient/`
  with body `{"keyword": "SIKORSKY AIRCRAFT", "limit": 5, "award_type": "all"}`.
- `usaspending_recipient_d64537c9-5482-dd40-cdd4-5cf07b66329d-C.json`:
  `GET /api/v2/recipient/d64537c9-5482-dd40-cdd4-5cf07b66329d-C/`
  (Sikorsky Aircraft Corporation, child record; note the parent history:
  RTX, then Lockheed Martin).
- `usaspending_recipient_3b77cd29-f995-1212-a302-18cb53bad99a-C.json`:
  `GET /api/v2/recipient/3b77cd29-f995-1212-a302-18cb53bad99a-C/`
  (Boeing Sikorsky Aircraft Support, LLC: a similarly named joint venture,
  i.e. a different entity).

## NOT recorded (doc-derived)

- `sam_entity_sikorsky.json` is **hand-built** from the documented response
  shape of the SAM.gov Entity Management API v4
  (https://open.gsa.gov/api/entity-api/, read 2026-11-09). We had no
  `SAM_API_KEY` when this was written, so it has never been checked against a
  live response. The UEIs, names and Stratford address come from the
  USAspending recordings above; the CAGE code, DBA name, dates and the parent
  address are illustrative placeholders, not verified facts.

  Re-record it once a key exists, then fix `_sam_entity` in
  `pipeline/resolve/tools.py` if the real field paths differ:

      curl -s "https://api.sam.gov/entity-information/v4/entities?ueiSAM=UTJWTSLMFNG4&includeSections=entityRegistration,coreData&api_key=$SAM_API_KEY" \
        > tests/fixtures/resolve/sam_entity_sikorsky.json

  Never commit a response that echoes the API key (check `links.selfLink`).
