# Accedra (platform F)

Accedra uses a provider API key, never an Accedra admin login. The API origin is fixed to `https://accedra.xyz`. Create platform F in the existing Platforms screen and paste the server key in its API-key field. Credentials are encrypted with the existing server secret box and are not returned to the browser after saving. Provisioning and key handoff happen privately, outside this repository.

The CCMAX provider is `bing@accedra.xyz` with a **0.25×** contract. The connection quote is fixed to 0.25. Its key needs only `accounts:read`, `accounts:write`, and `earnings:read`; it cannot request withdrawals. Accedra assigns destinations server-side. This provider is assigned the internal pool and tagged with CCMAX as its origin, preventing a route back to CCMAX.

## Accounts and authorization

Reuse the normal CCMAX account and fixed-proxy flow. Accedra receives the existing account proxy as a custom proxy; this integration does not purchase proxies. Each submission has a stable connection/account idempotency key. Read and chat authorizations may require several callbacks. Each callback consumes a distinct CCMAX OAuth attempt, retaining existing state and code-claim checks. Ownership and the binding are committed only after every required authorization is complete and the remote account ID and email match.

Only completed accounts are included in periodic inventory sync. Remote enable/disable, changing a bound account's proxy, refresh-token import, and reauthorizing an existing binding are currently unsupported; the UI hides those actions and the API rejects them. Quota percentages are displayed as quota data, never converted to monetary usage. Their observation time remains unknown until Accedra supplies one.

## Earnings and settlement

Requires Accedra's scoped `GET /api/v1/provider/finance/daily-statement?date=YYYY-MM-DD` endpoint. Its statement contains **credited ledger postings for a completed Beijing calendar day**, not the day tokens were consumed. Late upstream reconciliation appears on the day the credit is posted. Estimates and lifetime totals never enter daily billing.

The statement must be complete, have the requested date/timezone and basis, reconcile exactly to its total, and contain one row per account at the expected 0.25 multiplier. Inconsistent or mixed-rate statements fail closed. The sparse ledger omits accounts with no postings. Only existing eligible local bindings are filled with zero for such days.

Accedra's account credit already includes the provider multiplier. CCMAX stores eight decimal places, so the adapter truncates each account's credited amount to eight decimals, then divides by 0.25 to obtain CCMAX's settlement base. CCMAX's existing 0.25 root quote recovers that credited amount, avoiding a second application of the multiplier or paying more than the upstream credit. Any smaller fractional remainder stays in Accedra. Downstream agent quotes continue using CCMAX's existing settlement rules.

The Platforms screen shows Accedra's exact available, held, earned, paid, and withdrawable balances separately. These balances do not substitute for a daily statement. Snapshot billing is disabled for F.

## Validation

The integration tests exercise encrypted key storage, fixed quotes, multiple OAuth phases, exact account ownership, callback state and code claims, unsupported actions, schema upgrades, sparse daily credits and zero days. Adapter tests cover malformed and incomplete reports, decimal precision, rate mismatches, and secret-safe upstream errors. The upstream account and destination credentials never belong in fixtures or PR descriptions.
