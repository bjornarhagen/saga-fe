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

## Parallel work and cleanup

- Protect the application on port 5187 and its ledger volume. Its running source
  can belong to another checkout; inspect Compose labels and mounts before
  changing existing resources. Do not assume the primary checkout owns it.
- Use `scripts/preview.sh up` for parallel work, then `scripts/preview.sh exec
  npm test` or `scripts/preview.sh exec npm run build`. The helper gives each
  checkout a separate Compose project and random loopback port. An optional
  `SAGA_FE_PREVIEW_PORT` cannot use 5187. Do not use plain `docker compose up`
  from a worktree: the base file's fixed project name can replace the main app.
- Previews use an empty, temporary ledger and no private CSV or persistent
  volume. Use invented data only. Data resets when the container is recreated.
- Run `scripts/preview.sh down` as soon as the preview is no longer needed, and
  always after the work is tested, pushed, and merged. It removes only that
  checkout's preview containers, network, and local image. For source checks
  alone, prefer the Docker `--rm` workflow in README.md.
- Remove disposable `node_modules/`, `.astro/`, and `dist/` promptly from
  completed, inactive worktrees. Keep clean completed worktrees for seven days
  after merge or last use, whichever is later, then archive them through the
  owning chat and Codex's managed-worktree tool. Check pushed/merged status
  directly; squash merges can make Git ancestry checks insufficient.
- Do not delete active or dirty worktrees. Preserve ignored private files before
  archival: Codex's Git recovery snapshot does not include them. Keep ledger
  volumes and backups unless their deletion is explicitly authorized. Do not
  use global Docker container, network, volume, image, or builder pruning.

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
