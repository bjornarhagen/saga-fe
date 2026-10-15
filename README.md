# Saga Fé

A personal ledger for spending, account balances, and future cash flow. Built
with Astro, vanilla JavaScript, and SQLite. Development, tests, and the application
run in Docker; no host Node or npm installation is needed.

## Start locally

For a built application with an empty ledger:

```sh
docker compose -f compose.yaml -f compose.production.yaml up -d --build --wait
```

1. Open [Saga Fé](http://127.0.0.1:5187).
2. Open **Data & method** and import a Norwegian bank CSV or canonical JSON file.
3. Open **Accounts** to check account names, assign forecast roles, and enter
   dated balances. Add accounts that are missing from the import.
4. Open **Look ahead** to use those balances or enter a combined starting balance
   manually, then adjust the forecast assumptions.

The built local runtime does not require or mount a CSV. Its default address is
bound to loopback. Set `SAGA_FE_PORT` to use another local port. Compose must
support the `!override` syntax used by `compose.production.yaml`.

SQLite is stored in the `saga-fe-data` named volume, shared by the development
and built local runtimes. Transactions, imports, account balances, forecast
settings, and transaction edits survive app restarts and browser changes.
`docker compose down` stops this project's service and keeps the named volume.
Removing that volume removes the ledger.

## Development and checks

The development service mounts source files read-only and runs Astro with live
updates. It also requires a private `transactions.csv` in this folder:

```sh
docker compose up -d --build --wait
docker compose exec -T app npm test
docker compose exec -T app npm run build
docker compose exec -T app npm run check:privacy -- --source
docker compose logs -f app
```

The CSV is a read-only runtime mount. It bootstraps transactions only when the
database is empty. Replacing the file does not refresh an existing ledger; use
the import UI for subsequent exports.

To run tests without a bank export or an existing application container:

```sh
docker build --target development -t saga-fe:development .
docker run --rm saga-fe:development npm test
```

The production image uses Astro's standalone Node adapter and Node 24. Both
runtime targets run as an unprivileged user. Private exports and databases are
excluded from source control and image build contexts.

## Dashboard and appearance

- **Overview:** period totals, monthly cash flow, spending categories, and major
  payments. Select a category or payment to inspect its transactions.
- **Look ahead:** adjustable forecasts for the next one, two, or three months,
  with regular income, spending, external savings, a cash buffer, and one-offs.
- **Transactions:** search, filter, sort, correct classifications, and exclude
  historical one-offs from forecast averages. Open any payment to see its sender,
  receiver, exact amount, source fields, saved corrections, and import history.
  Export filtered results as CSV.
- **Accounts:** imported and manually added accounts, editable names, forecast
  roles, and dated balance snapshots. The sender/receiver directory also includes
  external accounts and counterparties, with complete incoming/outgoing history.
- **Data & method:** persistent imports, batch history, source statistics, and
  calculation rules. Download the complete ledger as JSON or a SQLite recovery
  snapshot, including all balance dates, edits, settings and ingest records.

Appearance has separate theme and mode controls. **Bjørnarhagen** provides the
Saga charcoal, ivory, amber, and crimson palette; **Girlypop** uses blush, plum,
pink, and gold; **Matrix** uses a phosphor-green terminal palette. Every theme
supports **Light**, **Dark**, and **System** mode. Appearance stays per browser.
Charts and components use shared semantic tokens, and fonts are self-hosted.

Payment and account details have reloadable links with opaque ledger IDs.
Account activity covers all saved dates, independently of the Overview period.
External sender/receiver identities stay separate from your balance accounts.
Source labels are shown as supplied; missing names use masked identifiers and
missing identities remain unknown. Account details show full source identifiers
only inside the private application.

**Related payments** use saved party/route identities or a meaningful normalized
description. Reasons appear beside every suggestion. **Possible duplicates**
also require the same booking date, signed amount and currency, plus a matching
route or description without a known route conflict. A shared owned account or
amount alone is insufficient. These suggestions do not merge, remove or edit
payments. They can miss duplicates whose dates or amounts differ.

For each connected pair, choose **Confirm connection** or **Dismiss connection**.
The decision is saved in the ledger and applies when viewing either transaction.
The status filter shows suggestions, confirmed connections, or dismissed
connections. Dismissed pairs leave the default view and remain available for
review. **Reset to suggestion** clears the decision. Confirmed connections stay
visible even if later source corrections stop the automatic match. Confirmation
does not assert a duplicate or change either transaction, and decisions apply
to the selected pair only; they do not automatically group other payments.
Repeated imports keep these decisions. Both complete export formats include them.

**Account confirmation** is a separate decision for each transaction's sender
or receiver. Confirm, dismiss or reset it from either transaction details or
the account history. You can assign a different existing external account or
merchant; the imported source observation remains available. Each side has at
most one confirmed recipient, and changing it dismisses the previous choice.
Owned balance-account sides cannot be reassigned to an external recipient.

An external account plus the existing category provides a purpose group, such
as one merchant's food versus electronics payments. Account details include
category totals and confirmation filters. Source suggestions are included in
the default view; choose **Confirmed only** for reviewed account memberships.
Dismissed and superseded source hints remain available for review. Search and
direction filter the history; totals follow the confirmation and category filters.

Source evidence has an explicit type. A bank account field containing merchant
text is a **merchant hint**, not a verified bank account. Recorded numeric bank
identifiers and declared provider account IDs are stronger source evidence,
but do not become owner confirmations automatically. Existing payment-pair
confirmations remain separate and are never converted into account approvals.

Account movement totals infer matching debit/credit legs of internal bank
transfers and count each pair once. Both original entries remain inspectable,
with the pair marked in the history. Without provider transaction IDs this
pairing is inferred from source, date, amount, direction and occurrence counts.
Movement totals describe imported history, not a current balance. The table
shows direction relative to the selected account and preserves the signed
ledger amount when it differs.

## Balances and forecasts

A transaction history does not establish an opening or current balance. Unknown
balances remain blank; zero is a real balance. Each account has one forecast role:

| Role | Forecast use |
| --- | --- |
| Available | Spendable starting cash, including any overdraft. |
| Reserve | A separate savings reserve that may cover a projected shortfall. |
| Excluded | Retained in the ledger but omitted from starting forecast balances. |

**Use balances for forecast** requires a known balance for every included
account, all dated the same day. The combined reserve cannot be negative.
Account-derived starting fields follow the saved snapshots. Manual starting
balances remain available for a separate scenario. Cash and reserves must not
overlap, and entering a snapshot does not generate a transaction.

The default baseline uses three completed calendar months before the latest
transaction month. It excludes an incomplete initial month and the current
transaction month. Choose another lookback or enter monthly assumptions.
Regular income uses salary rows; refunds and other incoming money do not become
recurring salary automatically.

Internal transfers are excluded from consolidated income and spending. Outgoing
rows tagged `Sparing` or `Mikrospar til …` are savings and reduce available cash.
In a transaction's review dialog, link an external sender or receiver to an
account you own and choose Automatic classification. Available-to-available
movements are transfers; contributions from available cash into reserves or
investments are savings outflows. Withdrawals into available cash are money in,
not recurring salary. Saved explicit classifications take priority. Changing a
linked account's role updates automatic cash-boundary classification without
rewriting source rows. A link applies only to that payment, not every payment
to a platform's shared collection account.

Monthly cash change = regular income − spending − external savings − spending
change. The one-off expense applies in month one. Dates follow monthly
anniversaries of the balance date, clamped to month end. All calculation amounts
use integer øre.

Accounts also have a bank/platform and a type: everyday bank, savings,
investment, credit, or other. You can track any owned account manually without
an export. Investment accounts stay outside available cash and savings reserves.
Their recorded values include holdings and uninvested platform cash in one NOK
total; the app does not price individual holdings or predict investment returns.

Use **Record value** to save a dated observation. A new date adds history;
saving the same date corrects that observation. Account settings save separately
and never create a value observation or payment. Value history compares changes
with recorded net movements after the previous date through the current date.
“Other change” is the residual: it may include gains/losses, fees, interest or
missing transactions, and is not a calculated investment return. Unknown values
break the comparison. Charts connect known observations, not daily valuations.
Latest-value subtotals can contain different dates; forecast starting balances
still require aligned dates for included cash and reserve accounts.

Reserve needs are cumulative at each checkpoint; do not sum them across months.
The reserve is shown separately and is not automatically withdrawn or increased
by planned savings. Forecasts hold monthly assumptions constant and do not model
paydays, bill dates, interest, taxes, investment returns, or daily liquidity.
Review large historical payments before relying on an average.

## Data ingestion and private storage

Files are ingest sources; SQLite owns the ledger. The current adapters are:

| Adapter | Input |
| --- | --- |
| `norwegian-bank-csv` | Norwegian bank exports, including transactions, accounts, categories, and sender/receiver metadata. |
| `canonical-v1` | JSON with transactions, accounts, categories, and counterparties; metadata-only updates are supported. |

Imports validate references and amounts, then commit the complete batch or roll
it back. Reimporting the same or overlapping CSV does not add existing payments
again. Identical legitimate rows are retained with occurrence counts. Changes
to account labels or category metadata do not create another payment. Canonical
transactions use stable provider IDs for corrections. Sources remain separate
unless metadata explicitly links an existing entity.

See [the ingest contract](docs/ingestion.md) for JSON examples, source identity,
and adapter extension points, and [storage and recovery](docs/storage.md) for
the database design. `DATABASE_PATH` selects the SQLite file. Local Compose uses
`/var/lib/saga-fe/saga-fe.sqlite`; the standalone container defaults to
`/data/saga-fe.sqlite`. `TRANSACTIONS_FILE` enables optional initial CSV bootstrap.

Earlier browser balances and transaction edits are migrated when the database
has no saved forecast settings. The database then remains authoritative.
**Reset forecast settings & transaction edits** leaves transactions, import
history, and account snapshots in place.

Provider identifiers and raw source rows stay in the private database. APIs use
opaque entity IDs. Descriptions retain the source text and can themselves contain
sensitive information. Keep exports, database files, backups, credentials, and
screenshots with financial data out of public Git, issues, and CI artifacts.
The app uses no external fonts, analytics, AI calls, or live bank connections.

## Backups and remote deployment

For downloads through the dashboard, see [complete ledger exports](docs/exports.md).
Full archives are separate from the canonical JSON ingest format.

Create a consistent online snapshot inside Docker, using a new destination:

```sh
docker compose exec -T app node scripts/backup.mjs /var/lib/saga-fe/backup.sqlite
```

The backup command includes committed SQLite WAL data and refuses to overwrite
an existing destination. A snapshot on the same volume is only a local copy;
production recovery requires encrypted offsite storage and a tested restore.

Remote access requires owner authentication, an explicit allowed host and HTTPS
origin, and a private authentication file. The Tailscale deployment uses Serve
HTTPS with no public ingress or Funnel. Local loopback access is available
without a password by default.

The public Kubernetes templates remain inactive at zero replicas. Activation
requires private credentials, a verified image digest, tailnet setup, and the
backup/restore gate or an explicitly approved recovery exception. Publishing
source or an image does not activate the service. Follow the
[deployment guide](deploy/README.md) for the private infrastructure change,
owner login configuration, migration, verification, and recovery steps.

## Source layout

`src/pages/` contains the page and API routes. `src/server/` owns SQLite,
validation, and ingest adapters; `src/auth/` owns owner sessions.
`src/components/dashboard/` contains the dashboard views, while `src/scripts/`
handles browser interactions. `src/lib/engine.js` contains transaction and
forecast calculations. Theme definitions live in `src/styles/themes/`, with a
shared registry in `src/scripts/themes.js`. Self-hosted fonts and licenses live
in `public/`.

Tests use invented fixtures for database persistence, import identity, metadata
updates, atomic rollback, concurrent imports, exact amounts, account snapshots,
owner sessions, themes, and forecast calculations. A private local export is
optional for the separate reconciliation check and is never used as a fixture.
