# Ingest contract

The ledger database owns financial state. A file, bank connector, or metadata
feed is an ingest source, not the dashboard's storage format.

`POST /api/ingest` accepts one adapter envelope. Imports are atomic: invalid
references or values roll back the complete batch. `GET /api/ingest` lists
available adapters and recent batch results. Remote calls require owner login,
same-origin JSON requests, and the configured private host.

## Norwegian bank CSV

```json
{
  "adapter": "norwegian-bank-csv",
  "sourceKey": "primary-bank",
  "filename": "export.csv",
  "content": "the original CSV text"
}
```

The adapter reads the Norwegian bank columns and emits accounts, categories,
counterparties, and transactions. Amounts use the booked NOK value. Original
identifiers and source rows remain in the private database. They never enter
source files or container layers.

Repeated identical rows are retained using occurrence counts. Reimporting the
same or overlapping export does not add existing rows again. Renaming the file,
reordering rows or columns, adding a BOM, or changing line endings does not create
additional transactions. Mutable account names and category labels do not form
transaction identity. Duplicate column names are rejected as ambiguous.

The version 1 identity uses the source date, booked amount text, original amount
and currency, sender and receiver identifiers, transaction type, description,
and KID. Keep the bank's original values in those fields. Changing their text,
including reformatting decimal separators or account identifiers in a spreadsheet,
can create a new identity. Existing version 1 fingerprints are retained so that
upgrading the application does not duplicate previously imported records.

Exports lack a unique bank transaction ID. The occurrence count preserves the
greatest observed number of indistinguishable payments within one export. A
smaller export does not delete earlier payments. If two different real payments
appear as one identical row in separate files, the adapter cannot prove that
they are separate events. A correction to an identity field likewise cannot be
safely linked to its previous CSV row automatically.

## Canonical JSON, version 1

All monetary values below are **integer øre**. This is an invented example:

```json
{
  "adapter": "canonical-v1",
  "sourceKey": "example-provider",
  "data": {
    "accounts": [
      {
        "externalId": "example-cash",
        "name": "Example cash account",
        "currency": "NOK",
        "role": "available",
        "balance": 100000,
        "balanceDate": "2026-01-01"
      }
    ],
    "categories": [{ "externalId": "example-food", "name": "Food" }],
    "counterparties": [{ "externalId": "example-shop", "name": "Example shop" }],
    "transactions": [
      {
        "externalId": "example-payment",
        "date": "2026-01-01",
        "amount": -12500,
        "currency": "NOK",
        "description": "Example payment",
        "kind": "expense",
        "accountExternalId": "example-cash",
        "categoryExternalId": "example-food",
        "counterpartyExternalId": "example-shop"
      }
    ]
  }
}
```

The JSON file picker accepts either this envelope or its `data` object.
Any of the four entity arrays can be omitted; metadata-only imports are valid.
Every supplied array must contain unique `externalId` values for that entity
type. Duplicate IDs, including IDs that differ only in surrounding whitespace,
are rejected. A balance requires an explicit `balanceDate`, including a null
balance: ingestion never invents an observation date from the import time.
Transactions use a stable provider `externalId`; a corrected record updates
that transaction while retaining its lineage and owner edits. Use a stable
`sourceKey` for a feed, independent of filenames. Deduplication is scoped to
adapter/source; unrelated feeds are never silently merged by similar amounts.

Accounts, categories and counterparties can include an existing opaque `id`
from `GET /api/metadata` to link the same entity across different feeds. Category
`parentExternalId` creates a hierarchy; unknown references and cycles are rejected.
Manual account names, roles and same-date balance corrections take precedence
over subsequent source metadata. Explicit mapping of transactions across
unrelated providers remains future work.

The canonical transaction can additionally carry `regularIncome`, `review`,
`microSaving`, `type`, `subcategoryExternalId`, `fromAccountExternalId`, and
`toAccountExternalId`. These optional fields preserve engine meaning without
coupling the database to a bank-specific export. Only NOK is currently accepted;
foreign currencies require an explicit valuation model before aggregation.

## Retry and correction behavior

Use one stable, nonempty `sourceKey` per feed; omission uses `default`. Filename
changes do not change the source. Deduplication is scoped to both adapter and
source key. Importing the same payments through a different source key or
adapter can create separate transactions; metadata links do not merge payments.

An already recorded identical payload is a no-op, including after restart or
when retried concurrently. Retrying an earlier identical canonical payload does
not undo a later correction. Changed row or JSON key order can produce a new
import-history batch, but known transaction identities are still updated rather
than inserted. A new batch retains its source-row lineage.

Previously unseen canonical corrections are applied in import order. The API
does not infer which provider revision is newer; repackaging an older correction
as a different batch can apply its older values again. Use the provider's stable
transaction IDs and send its current state. Owner transaction edits remain
separate and are preserved. Manual account names, roles and same-date balances
also remain protected from source updates.

There is no automatic transaction deletion when an import omits records. A failed
batch leaves no accounts, transactions, source records or partial import history
behind. Full ledger exports and database snapshots are separate archival formats;
`canonical-v1` is an ingest contract, not a complete database backup format.

## Adding an adapter

1. Parse and validate source data in `src/server/adapters.js`.
2. Produce canonical entities, stable source identity, transaction fingerprints,
   occurrence numbers, and source row provenance.
3. Register a versioned adapter ID.
4. Test overlapping imports, metadata corrections, rollback, and repeated rows
   using invented fixtures.

Do not put real exports, bank identifiers, screenshots, database dumps or
credentials in fixtures, issues, pull requests or CI artifacts.
