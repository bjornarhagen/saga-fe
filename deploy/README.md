# Saga Fé deployment

These files are a staging template, not evidence of a deployed service. Both
workloads start at zero replicas. Production settings and encrypted credentials
belong in the operator's **private** infrastructure repository.

## Deployment contract

| Setting | Production value |
| --- | --- |
| Image | `ghcr.io/bjornarhagen/saga-fe@sha256:<verified digest>` |
| Runtime | Node 24, uid/gid 1000, port 4321 |
| Database | `DATABASE_PATH=/data/saga-fe.sqlite` |
| Persistent storage | Entire `/data` directory; SQLite database, WAL and shared-memory files |
| Readiness/liveness | `GET /api/health`; returns service status only |
| Owner login | `SAGA_FE_AUTH_REQUIRED=true` and `SAGA_FE_AUTH_FILE=/run/secrets/saga-fe/auth.json` |
| HTTPS origin | `SAGA_FE_PUBLIC_ORIGIN=https://saga-fe.example-tailnet.ts.net` |
| Host allowlist | `SAGA_FE_ALLOWED_HOSTS=saga-fe.example-tailnet.ts.net` |
| App replicas | One, `Recreate` updates |
| Access | Tailscale Serve HTTPS; no public Ingress, NodePort, LoadBalancer or Funnel |

The CSV is an ingestion source. Production does not mount it and does not set
`TRANSACTIONS_FILE`. Upload it through the authenticated application or migrate
the existing SQLite database. Source code, image layers, CI logs and Git never
contain the owner's transactions, balances, imports or authentication files.

The app runs with a read-only root filesystem, writable `/data` and bounded
`/tmp`. Its Service is ClusterIP only. The application NetworkPolicy admits its
dedicated Tailscale proxy and denies application egress. The proxy has a separate
namespace so its narrow Kubernetes Secret permissions cannot read the owner's
login credentials.

## Prerequisites

1. Read the infrastructure repository's instructions, inventory, architecture,
   application-delivery policy and Tailscale runbook.
2. Verify cluster capacity and the existing `local-path-retain` StorageClass.
   It must use `Retain`. A 1 GiB claim is a starting request, not an enforced
   local-path disk quota. Storage is node-local and provides no host failover.
3. Confirm MagicDNS and HTTPS certificates are enabled. Reserve an available
   `saga-fe` device name; use the actual issued hostname in the private overlay.
4. Prepare a tagged, non-ephemeral Tailscale enrollment key privately. Use an
   existing authorized tag or separately review a dedicated owner-only access
   tag. Verify tailnet policy permits the owner's devices. Tailnet membership
   alone does not replace the application's password.
5. Prepare application credentials using `scripts/setup-auth.mjs`. It reads a
   password from stdin and writes the scrypt hash and session secret to its
   private output file. Encrypt the Kubernetes Secret with the infrastructure
   repository's SOPS configuration. Never place the plaintext file here.
6. Establish encrypted, application-consistent recovery and test a restore.
   A retained PVC or a server snapshot does not protect against every data-loss
   event. If offsite backup is deliberately deferred, record an explicit
   operator-approved exception in the private deployment review.

## Image publication

`.github/workflows/container-checks.yml` builds, runs privacy checks and tests,
and exercises the production image using Docker on a fresh GitHub-hosted runner.
Pull requests have read-only credentials. After checks pass on `main`, a separate
job publishes an image tagged `sha-<source revision>` with the workflow's
short-lived GHCR token. It holds no cluster or private infrastructure credential.

Review the published package's visibility. A public source repository does not
automatically make its first GHCR package public. Once public, anonymous cluster
pulls need no registry Secret. Pin the published digest in the private GitOps
declarations. Publication does not promote an image or deploy this application.

## Prepare the private GitOps change

1. Copy `kubernetes/app` to `apps/production/saga-fe` and
   `kubernetes/tailscale` to `apps/production/saga-fe-access` in an isolated
   infrastructure worktree.
2. Add the application credential Secret `saga-fe-auth` in namespace `saga-fe`,
   with key `auth.json`. Add enrollment Secret `tailscale-saga-fe-auth` in
   namespace `saga-fe-access`, with key `authkey`. Commit only SOPS-encrypted
   files and reference them from their Kustomizations.
3. Replace the placeholder image with its verified digest. Replace the example
   hostname/origin with the actual tailnet hostname. The `/api/health` probe
   intentionally needs no login and works with a Kubernetes Pod IP.
4. Set private workload placement according to the existing stateful-workload
   convention. Keep the database directory on a single retaining volume.
5. Keep replicas at zero while reviewing recovery, secrets and migration. Add
   the two directories to the private production overlay. Run its complete
   manifest, Pod Security, secret-scan and infrastructure checks.
6. Present the exact infrastructure diff and request final deployment approval
   under that repository's instructions. Publishing reconciled production
   declarations to its release branch is the deployment operation.

The namespace and PVC disable Flux pruning. The Tailscale state is held in
`tailscale-saga-fe-state`, managed by the proxy. The app uses no Kubernetes
ServiceAccount token. No source CSV or database is committed to GitOps.

## Migration and activation

1. Export a fresh online snapshot from the local application using
   `node scripts/backup.mjs <private output path>` in Docker. Preserve the
   original database/export until verification is complete.
2. Verify the snapshot with SQLite `PRAGMA integrity_check` in a disposable
   container. Record counts and schema version privately without printing
   transaction text, account names or balances to CI or the public repository.
3. Activate the retaining PVC using an approved restricted migration Job.
   Transfer the snapshot through authenticated operator access while the web
   deployment is stopped. Refuse to overwrite any existing database. Place it
   at `/data/saga-fe.sqlite`, owned by uid/gid 1000; never restore a live WAL by
   copying the files independently.
4. After the approved activation, set both Deployments to one replica. If
   tailnet lock is enabled, sign the new node key from an existing trusted
   signing device. A Running pod is not proof that the node has connectivity.
5. Confirm Flux readiness, app readiness, actual image digest and storage
   ownership. Test the HTTPS URL from an authorized Tailscale device.
6. Sign in, check imported counts and account balances, change a synthetic
   setting, restart only this workload within the approved rollout and verify
   persistence. Confirm original local data remains available for recovery.

For a new empty database, skip snapshot migration and use the authenticated
import UI. Keep the original bank export private and read-only.

## Verification

- The issued HTTPS certificate validates without disabling TLS verification.
- The root requires owner login and finance APIs deny requests without a session.
- Imports and balance edits require the configured request origin and login.
- A missing auth file or invalid production host fails closed.
- Tailscale reports Serve as tailnet-only; Funnel is absent.
- An independent off-tailnet client cannot connect to the finance service.
- No public ingress route or public DNS alias points to its backend.
- App pods satisfy restricted Pod Security, have no API token, and cannot make
  external network requests.
- Database writes survive app restarts and the online backup restores correctly.
- Unrelated cluster workloads remain healthy.

Record the exact infrastructure revision, image digest, verification date and
backup/restore evidence in the private inventory. Health probes alone do not
verify authentication, Tailscale connectivity or personal-data correctness.

## Backup and recovery

`scripts/backup.mjs` uses SQLite's online backup API. It reads `DATABASE_PATH`
and writes a consistent snapshot to a private destination. Do not copy a live
database without its WAL, and do not treat a copy on the same disk as offsite
recovery.

For scheduled offsite recovery, use the private platform's native database
snapshot plus restic pattern: create the consistent snapshot in bounded scratch
storage, send it to a separately encrypted restic repository using scoped
credentials, monitor freshness and failure, and test restoration into a
disposable database. Suggested initial recovery targets are a six-hour RPO and
one-hour RTO; measure them during the restore drill before accepting them.
Backup endpoints, credentials, retention policy and scheduling belong in the
private infrastructure repository. Do not reuse infrastructure-state bucket
credentials. Backup deletion/pruning requires its own operator approval.

## Rollback

For a code regression, review and restore the previous verified image digest
through an approved GitOps change. Keep PVCs, credentials and Tailscale identity.
Check schema compatibility before an image rollback; never restore a database
or remove a volume as an automatic reaction to an image failure.

For recovery, stop writes through an approved replica change, preserve the
current database, restore into an empty private location, verify integrity and
application behavior, and only then activate it. Volume deletion, replacement,
backup pruning and Tailscale state deletion are destructive operations that
need separate approval.
