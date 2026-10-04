# Pet Agent integration notes

## Implemented boundaries

- Production rejects scripted mode. Gemini uses `resolveModelId` from config.
- Context reads careFlag, pending consultations and due follow-ups from Firestore.
  Dates, weekdays and holidays use JST; family long-vacation context is respected.
- Recent trends are limited to an approved, unexpired `agentSummary` or recent
  weekly report text exactly matching the current KB's deterministic templates.
- Internal HTTP tools use the same strict Zod declarations as ADK tools.
- Session ownership, child status, safeMode and open child-wide crisis events are
  checked. Stateful tools repeat those checks inside their write transactions.
- Normal tool executions are budgeted. Crisis escalation, help resources and
  tell-adult offers are budget-exempt, but do not bypass data authorization.
- Writes use HMAC-keyed operation receipts and transactions. Receipts contain
  IDs and statuses, not plaintext arguments. The HTTP endpoint also persists
  a budget per operation/turn.
- Action text passes the output filter. Application error paths emit controlled
  codes, not provider error messages. SDK/internal infrastructure logging still
  needs production configuration and a separate live audit.
- Session history is limited before decryption: up to 40 recent events and 40
  older records at current configuration. Older history contributes at most
  12 role-labelled excerpts of 160 UTF-16 characters, with a 4096-character JSON
  budget. This is an ephemeral extractive context, not a model-written summary.
  Tool/system records and encrypted tool-result parts never enter the excerpts;
  they remain untrusted conversation data, not instructions. Recent event counts
  include tool events and are not guaranteed to equal 20 complete conversation pairs.
- All session/message mutations recheck the authoritative active child and
  existing session inside their Firestore transaction. Cached directory records
  cannot recreate message documents after deletion; production lookup also
  rejects nonactive children. Session creation requires an active child.
- Model history applies the root child's `modelHistoryResetAt` cutoff before
  decryption, including encrypted recall tool responses. UI chat-history reads
  are intentionally unaffected by this model-only reset.

## Memory contract

`remember` returns `{ proposalId, status: 'pending' }` and emits:

```ts
const action = { type: 'memory_proposal', proposalId, text, category };
```

The proposal is stored at `{childPath}/memoryProposals/{proposalId}` with
`contentEnc`, `category`, `status`, `characterId`, `petId`, `createdAt`, `expiresAt`.
Its AAD is `{childPath}/memoryProposals#contentEnc`. Expiry currently reuses
`retention.idempotencyKeyHours` (24 hours); a dedicated approved policy belongs
in shared config. No long-term memory is created by this tool.

The API-owned accept endpoint decrypts that field and writes
`{childPath}/memories/{proposalId}` with AAD `{childPath}/memories#contentEnc`.
Recall recognizes the API's `consentedAt` plus current `characterId`/`petId`;
it also supports explicit accepted status / acceptedAt / consentAt records.
Pending, expired, deleted, other-character and other-pet entries are excluded.
Recall is bounded lexical relevance, not semantic/vector retrieval.

Text turns now prefetch through that same recall implementation using the current
screened message before constructing the ADK instruction. Unrelated memories are
not added; the next turn rereads Firestore, so deleted memories are not cached in
an instruction between turns. Voice now prefetches through the same forwarded
recall tool at connection/reconnection, using the latest retained, explicitly
screened child topic from a bounded search of three sessions for the current pet.
It revalidates child status and the history reset before constructing Live.
Within a Live session, recall remains on demand; this is not dynamic instruction
rewriting after each transcript. Neither path persists a new plaintext summary.

## Game suggestion budget

`suggest_game` calls `PetToolExecutor.suggestGame` before emitting an action.
The pet-agent executor transaction shares `{childPath}/toolUsage/suggest_game`
across sessions, channels, and game types. Only successful reservation timestamps
within a rolling seven-day window count toward `agent.suggestGameWeeklyLimit`.
The tool's existing HMAC operation receipt prevents retry double-charging.
Denied or failed reservations emit no game action; safety tools remain available.
The ledger stores no content and has `expireAt` plus a Terraform TTL declaration
(not yet deployed). Direct child-initiated play is not a pet suggestion.

## Voice integration

`createPetTools` accepts an optional fifth argument:

```ts
const options = { filter, turnId: () => String(currentSafetyEpoch) };
```

Use a per-utterance ID rather than the lifetime Live invocation ID to reset the
budget. Internal requests accept optional `operationId`; send the same stable
ID for all calls/retries in that approved utterance. Legacy requests fall back
to the latest message ID, or session ID before messages exist. A tool-call ID
is not a suitable per-turn budget key.

The internal endpoint preserves `{ result }` and additionally returns `actions`.
The existing voice forwarding executor may continue ignoring that field because
its shared ADK tool emits the equivalent action locally.

Agent crisis IDs are `agent_<HMAC operation id>` and have `status: 'open'`.
Without a reliable family-harm assessment, detection.familyHarmStatus is
`unknown` and familyHarmSuspected is true. Read the persisted value downstream;
do not default it to false. Child safety lock does not clear on a new session.

## Google RAG adapter

Optional configuration:

- `PET_RAG_CORPUS`: full Tokyo corpus resource.
- `PET_RAG_KB_VERSION`: must equal the verified local KB version.
- `PET_RAG_SKILL_SOURCES_JSON`: JSON mapping cloud source URIs to manifest-backed
  `skills/*.md` paths. Those sources must contain the same versioned skill text.

The adapter uses the existing ADC HTTP client and Google's retrieveContexts API.
Queries contain only vocabulary found in public skill text, never the original
child query, identifiers or conversation history. Returned passages must match
the configured source and verified local content. A configured cloud failure
does not silently switch to local retrieval. Without cloud configuration the
adapter uses local versioned lexical search. Production serves no skill text
while the manifest has no expert approvers.

No cloud corpus, credentials, deployment or real-child data was used to validate
this adapter. Tokyo availability and actual IAM/network access remain unverified.

## Remaining work outside this slice

- Native Live end-to-end verification and UI integration are owned elsewhere.
- Independent adult Developer API probes have passed limited synthetic cases;
  production Vertex, RAG and model-quality acceptance remain incomplete.
- Weekly suggest-game quotas are enforced here. Text and voice share the configured
  daily ordinary-turn counter after crisis screening; complete voice cost
  caps and total model token budgets remain separate work.
- Older history has bounded extractive context, not a complete or abstractive
  summary; total model token budgeting remains.
- Comprehensive person-name pseudonymization is not implemented. The model is
  instructed not to propose real names, but this is not an independently proven
  de-identification guarantee.
- Receipt, weekly suggestion, daily usage, proposal and per-turn tool budget TTL
  declarations now exist, but have not been deployed. Application checks enforce
  expiry without relying on asynchronous database TTL deletion.

## Mood event integration

`PetRuntime.publish` / `createRuntime({ publish })` accepts the existing
`Publisher['publish']` contract. Production and configured Pub/Sub emulators use
`PubSubRestPublisher.fromEnv`; production requires `GCP_PROJECT_ID`. An
unconfigured development publisher fails explicitly, rather than claiming delivery.

After the mood transaction commits, `record_mood` publishes `checkin.created`
with only `{ childId, kind: 'mood', checkinId }`. A failed publish returns a controlled
failure; the operation receipt allows retry to publish the same checkin ID without
writing a duplicate checkin. Delivery is at-least-once, not exactly-once; consumers
must deduplicate by the checkin ID. This is retry-driven, not a scheduled outbox.

There is no mood data-source toggle in the current shared schema. A voice-session
mood write is rejected if voice consent has been disabled; disabling typing metrics
does not disable an explicitly provided mood in text chat.

## Local verification

Use Node 22, build shared dependencies first, and set
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8095` for the shared local emulator.
Run `vitest run` from `packages/agent-core` and `services/pet-agent`.
Integration tests use isolated demo project IDs per process so repeated runs
do not share crisis locks or proposals with other developers' fixtures.
