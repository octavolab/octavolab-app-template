# OES contract fixtures

Recorded request/response pairs that `src/oes.test.ts` replays against a stubbed `fetch` (no network in CI).

**Status: SYNTHETIC.** The OES API specification is not in this repository yet (see `TODO(OES-SPEC)` in
`src/oes.ts` and `docs/integrations/oes.md`). These files follow the adapter's PROVISIONAL wire format. When OES
delivers the spec and sandbox credentials:

1. Rewrite `toOesRequest` / `fromOesResponse` against the spec.
2. Run the opt-in sandbox test once (`OES_SANDBOX_TEST=1`, see `src/oes.sandbox.test.ts`) and replace these files with
   real sandbox responses. Remove any account id, quote id or personal data before committing; never commit a key.
3. Change the status line above to `RECORDED <date> from the OES sandbox`.
