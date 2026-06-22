# Title Enrichment Status

## Goal

Track whether each video title has already been enriched, skip those entries during bulk title enrichment, and allow manual one-entry enrichment from the edit modal.

## Implementation Plan

1. Add a persistent `title_enriched` boolean column to `videos` with a SQLite-safe migration defaulting to false.
2. Include `title_enriched` in `/api/videos` responses.
3. Update bulk `/api/videos/enrich-preview` to skip videos already marked as enriched unless the request explicitly forces enrichment.
4. Update enrichment apply behavior to mark videos as enriched when a catalogue title is applied.
5. Allow `PUT /api/videos/{id}` to accept `title_enriched` so manual single-entry enrichment can persist both the title and flag.
6. Add an `Enrich` button to the library edit modal that immediately applies the best match for the selected video, even when already enriched.
7. Show enriched status in the library table so skipped entries are visible to users.
8. Verify with local checks and Docker before committing and pushing.
