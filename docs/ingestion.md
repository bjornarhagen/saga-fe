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
same or overlapping export does not add existing rows again. Mutable account
names and category labels do not form transaction identity. Exports lack a
unique bank transaction ID, so indistinguishable real payments are inherently
ambiguous; the occurrence count preserves the greatest observed multiplicity.

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

## Adding an adapter

1. Parse and validate source data in `src/server/adapters.js`.
2. Produce canonical entities, stable source identity, transaction fingerprints,
   occurrence numbers, and source row provenance.
3. Register a versioned adapter ID.
4. Test overlapping imports, metadata corrections, rollback, and repeated rows
   using invented fixtures.

Do not put real exports, bank identifiers, screenshots, database dumps or
credentials in fixtures, issues, pull requests or CI artifacts.
