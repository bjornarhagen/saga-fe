# Private state and account balances

SQLite is the durable store for a single owner and a single application writer.
`DATABASE_PATH` selects the private file. The container runs as UID 1000; the
data directory and database are private to that user. Local Compose uses a named
volume. Neither the volume nor any CSV is copied into the image or public Git tree.

```mermaid
flowchart LR
  CSV[Bank CSV adapter] --> Batch[Validated ingest batch]
  JSON[Canonical metadata / transaction adapter] --> Batch
  Future[Future adapters] --> Batch
  Batch --> DB[(Private SQLite ledger)]
  DB --> Accounts[Accounts and dated balances]
  DB --> Reports[Spending and projections]
  Owner[Owner corrections] --> DB
```

The schema separates accounts and provider identifiers, categories and parent
relationships, counterparties, transactions, balance snapshots, source records,
import batches/rows, transaction corrections, connection decisions, and forecast settings. Foreign keys,
explicit transactions, WAL, a busy timeout and full synchronization protect
integrity. Source identifiers remain private; APIs use opaque IDs. Schema version
is recorded with `PRAGMA user_version`; newer unsupported schemas are refused.

Schema version 2 adds `transaction_relations`. Migration from version 1 is
atomic and leaves existing records and import identities intact. Each relation
stores two sorted transaction IDs, a `confirmed` or `dismissed` status, and
timestamps. Foreign keys require both transactions to exist. Reversing the pair
updates the same decision; resetting deletes only that decision. Repeating an
unchanged decision is a no-op. Connections do not merge transactions or change
amounts, classifications, account balances, or forecast calculations.
An application that supports only schema version 1 refuses a version 2 ledger;
rollback requires a compatible application or a matching pre-migration snapshot.

Schema version 3 adds `external_endpoint_refs` and
`transaction_account_memberships`. A durable reference is materialized when an
owner reviews an external account or merchant. A membership records transaction,
side (`from` or `to`), endpoint, decision, and timestamps. A partial unique index
allows one confirmed endpoint per side. Confirming another endpoint dismisses
the earlier confirmed one in the same transaction. Reset clears only the selected
decision. Existing payment-pair decisions are preserved without reinterpretation.

Source endpoints and effective owner assignments are returned separately.
Dismissals and confirmed alternate assignments remove an old source hint from
active account totals while preserving it in review views. An account combined
with the transaction's effective category supplies the purpose grouping; there
is no second purpose-group store. Account review never changes amounts, source
rows, import identities, balance accounts, or forecast classifications.

Balances are dated facts, not sums reconstructed from an unknown opening balance.
Each account has one forecast role: `available`, `reserve` or `excluded`. Unknown
balances are null, distinct from zero. A combined account-derived forecast is
available only when every included account has a known balance for the same date.
Reserve totals cannot be negative. Available accounts may be overdrawn.

Schema version 5 adds `account_profiles`, with account type, institution and
owner metadata override flags. Existing accounts migrate as `other` with their
balances, roles, import identities and edits intact. Investment accounts must use
`excluded`; they cannot supply forecast cash or reserves.

Transaction edits can hold `fromOwnedAccountId` and `toOwnedAccountId`. These
per-payment links preserve source endpoints and cannot replace an imported owned
side. They do not globally claim a platform collection account. Automatic
classification uses the effective owned accounts and their cash roles: available
to available is a transfer; available to reserve/investment is savings; reserve
or investment into available is nonrecurring money in. Explicit kind edits take
priority. Changing a role changes this projection without rewriting source rows.
Mirrored same-date, same-amount entries between the same resolved owned accounts
are paired by occurrence across sources for movement history. Both rows remain.
Different booked dates cannot be reliably matched and stay separate.

Dated values use the existing `balance_snapshots` table. Same-date saves correct
an observation; a new date preserves earlier history. Values never generate
transactions. Profile-only edits never generate observations. Value history
reports the difference beyond recorded movements, not investment performance;
missing data, fees and interest can contribute to the residual. Investment
returns are not forecast. The app does not schedule transfers.

Owner settings and transaction corrections persist in SQLite across browsers and
restarts. The first local launch migrates earlier browser settings when the
database has none. Appearance remains a per-browser preference. API mutations
validate data and reject cross-origin requests. Remote deployment requires the
owner password/session configuration, even inside Tailscale.

## Backups

Use `node scripts/backup.mjs /private/destination.sqlite` inside the container.
It uses SQLite's online backup API, including committed WAL content, and writes
a private consistent snapshot. Do not copy a live database file without its WAL.
The command does not overwrite existing destinations. Backup snapshots contain
the owner's complete financial data and must be encrypted before offsite storage.

Production requires a tested restore and offsite backup destination, or an
explicitly approved recovery exception in private infrastructure documentation.
The public deployment templates are intentionally inactive until those gates,
private authentication, exact image digest, and tailnet device setup are reviewed.
See [deployment](../deploy/README.md).
