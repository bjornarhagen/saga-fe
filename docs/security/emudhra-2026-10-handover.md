# eMudhra certificate trust update — 23 October 2026

Saga Fé's existing development container accepted certificates chaining through
the compromised eMudhra intermediates. Updating the host Mac does not update
Node or the certificate bundle inside a previously built Linux image.

## Repository changes

- Both development and production images inherit one base pinned to Node
  24.22.1 and the verified multi-platform image digest.
- The base refreshes Alpine's certificate bundle and requires at least
  `ca-certificates-bundle` version `20261020-r0`.
- `npm run check:tls` checks the Node security version floor and rejects the
  four affected root fingerprints in Node's roots and `/etc/ssl/cert.pem`.
- Container CI checks both targets and the exact image being published. These
  default checks work offline. Live HTTPS checks are available separately.

The Node image digest was checked against Docker Hub's official tag metadata:
`sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53`.
Keep the tag and digest together when applying future Node security updates.

## Handover to developers

1. Merge this security branch into the branch used by your checkout. Preserve
   any unfinished application work; do not reset it to this branch.
2. Build a fresh image from that checkout. Existing containers keep their old
   runtime until they are recreated.
3. Verify the image before replacing the app:

   ```sh
   saga_check_image=$(docker build --pull --no-cache --quiet --target development .)
   docker run --rm "$saga_check_image" npm run check:tls
   docker run --rm "$saga_check_image" npm run check:tls -- --online
   docker run --rm "$saga_check_image" npm test
   docker run --rm "$saga_check_image" npm run build
   ```

   The live check sends no credentials. It requires normal HTTPS to succeed
   and all four eMudhra test connections to fail with certificate errors.
   DNS failures and timeouts fail the check; they do not count as protection.

4. Recreate only the app owned by your checkout/session. For parallel work,
   use `scripts/preview.sh` and its session identity. Do not use the fixed base
   Compose project name to replace another session's service.
5. For the owner-managed local application, preserve its Compose project,
   named ledger volume, database, and private CSV mount. Back up the ledger
   before an operator-approved app replacement. Never use `down -v`.
6. Run `npm run check:tls -- --online` inside the recreated app as well.

No existing application container, ledger, database, private export, or remote
deployment was changed by this branch. Source publication and deployment remain
separate actions. Follow the private ai-devops GitOps approval and backup rules
for a remote deployment.

## Scope and remaining work

This branch covers `bjornarhagen/saga-fe` only. Toolbox/Skolar and the main Saga
runtime in `bjornarhagen/brain` have separate Dockerfiles and need their own
security changes. Local test fixtures and previously built images must be
rebuilt from the corresponding patched source; merely pulling this branch does
not repair them.

The fingerprint check covers the default Node roots and the Alpine PEM bundle.
Applications configured with additional custom CA files need a separate review.
The live test hosts are operated by the incident researchers, so they are not
an always-on CI dependency.

## Validation

- Fresh development image built with `--pull --no-cache`; production image
  built successfully from the same patched base.
- Development and production both passed the offline trust check and all four
  live certificate rejection checks. The normal HTTPS control succeeded.
- Mounting the old public CA bundle into a disposable container correctly
  failed the trust check, identifying the affected AAA root.
- Unit tests: 386 passed, one skipped, zero failed.
- Public-source privacy audit passed for 199 files.
- The existing restricted-runtime, owner-login, ingestion, persistence,
  export/recovery, and account-data boundary checks passed using synthetic data.
- Independent review found no actionable correctness or security issues.
- Validation containers and their synthetic volume were removed by the existing
  check helper. Existing application containers and user data were untouched.

## Primary references

- [Incident disclosure, affected roots, and client tests](https://emudhra.we-have-a-problem.com/)
- [Node 24.22.1 security release](https://github.com/nodejs/node/releases/tag/v24.22.1)
- [Official Node image tag metadata](https://hub.docker.com/v2/repositories/library/node/tags/24.22.1-alpine)
