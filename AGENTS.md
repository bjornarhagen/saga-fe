# Saga Fé

Local personal budget and cash-flow dashboard. Astro with vanilla client
JavaScript, using the shared Saga / bjornarhagen visual language.

## Development

Run installs, builds, tests, and the application in Docker. Do not use a host
Node/Bun toolchain. From this folder:

```sh
docker compose up -d --build --wait
docker compose exec -T app npm test
docker compose exec -T app npm run build
```

Use `docker compose logs app` for runtime diagnostics. Default local URL:
`http://127.0.0.1:5187`. Do not stop or change other projects' containers.

## Data and behavior

- Keep `transactions.csv` and `.budget-data/` out of Git and Docker images.
- The CSV is an ingest source mounted read-only for local bootstrap. Do not overwrite it or print personal
  transaction details into logs, fixtures, or documentation.
- Calculation amounts stay integer øre. Preserve the distinction between
  internal transfers, spending, regular income, and external savings.
- Keep existing browser balances and transaction edits working during changes.
- Source and image may be public. Financial data, databases, credentials,
  account identifiers, screenshots and personal import files must stay private.
- Remote deployment is Tailscale-only with owner authentication. Follow the
  ai-devops GitOps approval, backup, and validation rules before deployment.
- Ingest adapters normalize source transactions and metadata into the database;
  dashboard views must not treat uploaded CSVs as their own database.

## Design

- Theme source: the owner's `brain/src/styles/themes/bjornarhagen.css` and
  `brain/docs/UI-WORKSPACE.md`; local ports live in `src/styles/`.
- Charcoal / ivory surfaces, amber / crimson accents, square hairline frames.
- Pirata One for brand/display headings, JetBrains Mono for UI and figures,
  IBM Plex Sans for body text. Fonts are self-hosted with licenses.
- Components and charts consume semantic tokens. Keep dense data views quiet;
  use decorative Saga linework sparingly.
- Preserve light/dark readability, keyboard focus, and narrow-screen layouts.
