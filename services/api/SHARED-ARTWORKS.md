# Explicit Artwork Sharing (TASK6)

## Wiring

`registerSharedArtworks(app, getDeps)` in `src/routes/shared-artworks.ts` takes
`SharedArtworkDeps = Pick<SubmissionDeps, 'db' | 'auth' | 'images' | 'now'>`.
Use the same cached submission-runtime getter as `registerSubmissions`.
It registers `GET /v1/children/:childId/shared-artworks` and owns guardian auth.
`SharedArtworksRes` is unchanged. The guardian page is
`/children/[childId]/shared`.

The existing child route now supports:

- `POST /v1/child/artworks/:artworkId/share`: explicit share, 204; repeated requests
  preserve the original sharing timestamp.
- `DELETE /v1/child/artworks/:artworkId/share`: revoke sharing, 204, idempotent;
  clearing sharing is still permitted during a family-safety suppression.

These endpoints have no response body or new API DTO. POST/DELETE both recheck
active child ownership in the write transaction. POST also checks an unexpired
saved image, canonical child/artwork object path and family safety.

## Access And Limits

- Guardian reads require a matching guardian ID with primary/secondary role,
  no revocation and no non-active status, a child in the same family and active
  child status. Consent-required children also require active, consented family.
- Only `sharedWithGuardian === true`, valid `sharedAt`, unexpired `expireAt`, a
  supported artwork type and exact expected image path are eligible. Missing
  expiration fails closed. Saved-but-unshared images are never read or signed.
- Responses are `no-store` and only project artworkId, type, sharedAt and imageUrl.
  No narrative decryption, features, interpretation, risk or raw storage path.
- Check family safety before listing, again immediately before each image read,
  and again after asynchronous image I/O before returning the whole page.
  Only explicitly closed crises are ignored; uncertain family-harm flags on
  unresolved records suppress access. Crisis checks read at most 101 records;
  more than 100 suppresses sharing/reading without scanning further.
- Pagination reads at most `limits.pageSize.default` (currently 20) artwork rows,
  in document-ID order, without unbounded backfill. Filtered pages may be empty
  with a nextPageToken. This is not chronological ordering.
- Images are at most `limits.artworkImageMaxBytes` (2 MiB). Local memory reads
  check the PNG header and positive dimensions up to 1024 pixels per edge;
  this is not full PNG decoding. GCS reads check object size/content type.
- Optional `ArtworkImageStore.readUrl(path, expiresAt)` preserves compatibility
  with old write-only adapters; a gallery with no reader configured returns 503.
- GCS produces V4 read URLs expiring at the earlier of artwork expiry or five
  minutes. Local MemoryArtworkImages produces data PNG URLs, for local testing.
  All GCS tests inject a mocked Storage adapter; no cloud call is made.

## Revocation Semantics

Revocation stops future list responses and new URL issuance. It does not erase
images already viewed, downloaded or saved, and cannot invalidate a previously
issued GCS URL before its expiry (at most five minutes). A delivered local data
URL does not expire. This is disclosed in the child UI and guardian gallery.

The gallery refetches every 60 seconds while visible, on focus, on becoming
visible and on manual refresh. It clears images while hidden and on errors.
A revoked share disappears on the next refresh, not instantly from every device.

## Verification

`src/shared-artworks.test.ts` covers the real HTTP projection against Firestore
emulator, cross-family/guardian/child authorization, consent, expiry, canonical
paths, unsafe crises, revocation and changes during image lookup.
`src/artwork-io.test.ts` verifies bounded local PNG reads and mocked GCS expiry.
The new `apps/child-web/e2e/shared-artworks-functional.spec.ts` uses local real
account/submission APIs, explicit confirmation/cancel/undo, image rendering and
mobile/desktop overflow checks. The parent task owns running that browser spec.
