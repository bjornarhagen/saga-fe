# Complete ledger exports

Open **Data & method → Export your complete ledger**. Both downloads include
all saved financial state. The browser waits for pending saves before requesting
an export. If a save fails, the download still contains the saved database and
the page reports that unsaved changes are absent. Unsubmitted form fields are
not saved automatically.

| Download | Use |
| --- | --- |
| JSON archive | Readable, versioned data for inspection and other tools. |
| SQLite backup | A self-contained database snapshot for exact recovery. |

These are private, unencrypted files. They include source account identifiers,
payment descriptions and original parsed import rows. Keep them outside public
repositories and shared folders. Sign-in credentials and sessions are not in the
ledger database. Appearance preferences belong to the current browser and are
also excluded.

The existing **Transactions → Export CSV** button exports the filtered view.
Use the complete ledger downloads to retain account history, settings, edits
and ingestion records.

## JSON archive version 1

`GET /api/export?format=json` returns an attachment named
`saga-fe-ledger-YYYY-MM-DD.json`. Its top-level fields are:

- `format`: `saga-fe-ledger`
- `formatVersion`: `1`
- `exportedAt`: UTC timestamp
- `databaseSchemaVersion`: SQLite schema version
- `currency`: `NOK`
- `amountUnit`: `ore` (integer øre for monetary database columns)
- `tables`: complete rows from every ledger table

The tables preserve their database column names and values. IDs, null balances,
override flags, timestamps, source keys and relationships are retained. Monetary
database columns use integer øre; forecast input strings inside saved settings
retain their original NOK input format. `raw_json` and `value_json` remain JSON
strings, so parse those fields separately when using the archive in another tool.

| Tables | Saved data |
| --- | --- |
| `accounts`, `account_profiles`, `balance_snapshots` | Names, types, institutions, roles, owner overrides and every recorded value date, including unknown balances. |
| `categories`, `counterparties` | Category hierarchy and sender/receiver names. |
| `account_identifiers`, `category_identifiers`, `counterparty_identifiers` | Provider identifiers and links to ledger entities. |
| `transactions`, `transaction_edits` | Source transactions and separate owner corrections. |
| `transaction_relations` | Confirmed or dismissed transaction pairs, with creation and update timestamps. |
| `external_endpoint_refs`, `transaction_account_memberships` | Saved external account/merchant references and independent sender/receiver membership decisions. |
| `ingest_sources`, `ingest_batches`, `ingest_rows`, `source_transaction_keys` | Source identities, complete batch history, parsed row provenance and deduplication keys. |
| `settings` | Forecast inputs, assumptions and other saved ledger settings. |

All tables are read in one database transaction. Concurrent writes cannot mix
different committed states within one archive. The export refuses an unknown
table set instead of silently leaving out newly added data.

Database schema version 2 adds saved connection decisions. The JSON archive
format remains version 1; `databaseSchemaVersion` and the table set identify
the stored schema. A connection decision links two opaque transaction IDs and
never merges their financial records.

Database schema version 3 adds independent account membership decisions and
their durable external references. Earlier payment-pair decisions are retained
unchanged. Source observations, category corrections and account confirmations
remain distinct data in the archive.

This full archive is separate from the `canonical-v1` ingest format. It cannot
be uploaded through the import picker to restore the database. Use the SQLite
backup for recovery. Original upload file bytes are not stored by ingestion;
the archive retains the parsed source rows that the database actually saved.

## SQLite recovery snapshot

`GET /api/export?format=sqlite` uses SQLite's online backup API. It includes
committed WAL content and the complete database schema, tables and indexes in
one `.sqlite` file. It is safe to download while the app is running. Do not copy
only the main file of a live database as a substitute.

The server creates a unique private temporary directory, limits concurrent
snapshot downloads, and removes temporary files after completion, cancellation
or failure. The database is never added to the source tree or an image. Recovery
snapshots may retain deleted content in unused database pages; treat the entire
file as private.

The web download buffers data in the browser. Very large databases also require
enough server scratch space for a snapshot. For those, use the Docker backup
command with a new private destination on suitable storage:

```sh
docker compose exec -T app node scripts/backup.mjs /var/lib/saga-fe/ledger-backup.sqlite
```

Verify `PRAGMA integrity_check` and `PRAGMA foreign_key_check` before recovery.
Stop application writes, retain the original ledger, and restore into an empty
private location owned by the runtime user. Never overwrite a running database
or copy a live WAL independently. Production recovery and encrypted offsite
backups remain subject to the private deployment runbook.

Both endpoints use the existing owner authentication boundary and attachment,
`no-store` and `nosniff` response headers. They expose no environment values,
authentication configuration, session data or server filesystem paths.

Schema version 5 also preserves account type/institution profiles. Per-payment
owned-account links live in `transaction_edits`; dated valuations remain in
`balance_snapshots`. Both are included in JSON and SQLite archives.
