# Voice Safety Boundaries

- Audio, captions, and UI actions are held until the current utterance passes the full crisis detector. A keyword-only clear is insufficient.
- Production Live construction requires Tokyo and an officially reviewed model-region pair. The reviewed Live models do not support Tokyo, so the relay ends with the existing text fallback before any provider connection. CLI-only adult synthetic diagnostics cannot relax this guard.
- Each new utterance changes the epoch. Old clears cannot release a newer utterance; old hits still interrupt the session.
- Rejected detection is treated as unavailable and enters safe mode. Unknown family routing uses the conservative no-guardian-disclosure path; this is not a finding that family harm occurred.
- `record_mood`, `remember`, `suggest_game`, and `start_tell_adult` are checked before dispatch. A new utterance revokes write authorization. Already-dispatched remote writes cannot be recalled by this gate.
- Transcript timeout and output-buffer overflow discard output and stay muted across late clears and turn-complete events. New speech starts a fresh check.
- Held output is bounded by the configured transcript window and PCM rate, plus an output-count bound. Acoustic features exceeding the in-memory sample limit are omitted rather than reporting an incomplete sample as a complete utterance.
- An unresolved child crisis, including guardian acknowledgement without closure, prevents starting another voice session.
- Session shutdown waits for pending checks, transcript writes, and crisis persistence. Errors are logged with controlled codes, never provider exception messages.
- After a non-crisis check, ordinary output waits for a Firestore daily-turn reservation shared with text chat. Exhaustion or reservation failure discards held output and shows fixed text and help; later crisis input is still checked. Reservations are transactional, idempotent and revalidate voice consent, active sessions and child-wide unresolved crises.
- Repeated finals within an utterance are ignored. Tool calls carry a schema-valid hash of the connection/utterance ID to pet-agent, not the latest message ID. New connections use distinct IDs; ended sessions are not reopened.
- Connection-time memory prefetch only uses the latest retained, explicitly cleared child topic in a bounded search of current-pet sessions. It calls pet-agent's existing consent-aware recall, never reads memory collections directly, and rechecks active child, pet and history-reset state before constructing the model. Empty/unrelated results add nothing; malformed or unavailable context fails setup without logging content. Subsequent in-session recall remains a tool call, not a post-transcript rewrite of Live instructions.

## Remaining Limitations

Native Live receives audio before a final transcript exists. Its generated audio can arrive before its output transcript, so output-text filtering can interrupt further audio but cannot guarantee that already-played audio was prescreened. This implementation is not a 100% prescreened speech-output system.

The daily quota limits ordinary replies, not native-audio minutes, upstream model processing, safety-classification calls or total spend. Exhausted sessions remain able to detect crisis speech; a separate active-duration and total-cost policy still needs implementation and product approval.
