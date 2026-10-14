#!/usr/bin/env python3
"""Exercise the production image without bank exports, secrets, or host state."""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from html.parser import HTMLParser
import urllib.error
import urllib.parse
import urllib.request

LEDGER_TABLES = {
    "accounts", "categories", "counterparties", "ingest_sources",
    "account_identifiers", "category_identifiers", "counterparty_identifiers",
    "balance_snapshots", "transactions", "source_transaction_keys",
    "ingest_batches", "ingest_rows", "transaction_edits", "settings",
}


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


HOST = "saga-fe.example-tailnet.ts.net"
ORIGIN = "https://" + HOST


def request(base, path, method="GET", payload=None, cookie=None, origin=ORIGIN, host=HOST):
    headers = {"Host": host}
    if cookie:
        headers["Cookie"] = cookie
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers.update({"Content-Type": "application/json", "Origin": origin})
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers


def wait_healthy(container):
    mappings = json.loads(docker("inspect", container))[0]["NetworkSettings"]["Ports"]["4321/tcp"]
    base = "http://127.0.0.1:" + mappings[0]["HostPort"]
    deadline = time.monotonic() + 45
    while True:
        try:
            status, body, _ = request(base, "/api/health")
            if status == 200:
                assert json.loads(body).get("status") == "ok", "unexpected health response"
                return base
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise AssertionError("production image did not become healthy")
        time.sleep(0.5)


def check_script_assets(base, path, cookie=None):
    class Scripts(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_script = False
            self.has_inline = False
            self.sources = []

        def handle_starttag(self, tag, attrs):
            if tag == "script":
                self.in_script = True
                source = dict(attrs).get("src")
                if source:
                    self.sources.append(source)

        def handle_endtag(self, tag):
            if tag == "script":
                self.in_script = False

        def handle_data(self, data):
            if self.in_script and data.strip():
                self.has_inline = True

    status, html, headers = request(base, path, cookie=cookie)
    assert status == 200 and "text/html" in headers.get("Content-Type", ""), f"page did not render HTML: {path}"
    scripts = Scripts()
    scripts.feed(html.decode())
    assert not scripts.has_inline, f"CSP-incompatible inline script found: {path}"
    assert scripts.sources, f"page has no external JavaScript: {path}"
    for source in scripts.sources:
        parsed = urllib.parse.urlsplit(source)
        assert (not parsed.scheme and not parsed.netloc) or (parsed.scheme == "https" and parsed.netloc == HOST), "script is not self-hosted"
        script_path = urllib.parse.urljoin(path, parsed.path)
        if parsed.query:
            script_path += "?" + parsed.query
        # Before sign-in these must be served as JavaScript, not redirected to
        # a login HTML page with an otherwise misleading 200 status.
        asset_status, _, asset_headers = request(base, script_path)
        assert asset_status == 200 and "javascript" in asset_headers.get("Content-Type", ""), f"script is not public JavaScript: {script_path}"


def check_export_headers(headers, extension):
    assert headers.get("Cache-Control") == "no-store", "export was cacheable"
    assert headers.get("X-Content-Type-Options") == "nosniff", "export omitted nosniff"
    assert re.fullmatch(r'attachment; filename="saga-fe-ledger-\d{4}-\d{2}-\d{2}\.' + extension + r'"', headers.get("Content-Disposition", "")), "export attachment filename is invalid"


def check_exports_clean(container):
    verify = "import {readdir} from 'node:fs/promises';for(let n=0;n<50;n++){if(!(await readdir('/tmp')).some(name=>name.startsWith('saga-fe-export-')))process.exit(0);await new Promise(resolve=>setTimeout(resolve,10));}process.exit(1);"
    docker("exec", container, "node", "--input-type=module", "-e", verify)


def check_exports(base, cookie, container, account_id, transaction_id):
    status, body, headers = request(base, "/api/export?format=json", cookie=cookie)
    assert status == 200 and "application/json" in headers.get("Content-Type", ""), "JSON export failed"
    check_export_headers(headers, "json")
    archive = json.loads(body)
    assert archive.get("format") == "saga-fe-ledger" and archive.get("formatVersion") == 1, "JSON archive is not versioned"
    assert archive.get("databaseSchemaVersion") == 1 and archive.get("amountUnit") == "ore", "JSON archive schema or amount unit is incorrect"
    tables = archive.get("tables", {})
    assert set(tables) == LEDGER_TABLES and all(tables.values()), "JSON archive omitted saved ledger tables or rows"
    assert tables["accounts"][0]["id"] == account_id, "account identity was lost in export"
    assert tables["account_identifiers"][0]["external_id"] == "fixture-cash", "source account identifiers were omitted"
    assert sorted(row["amount"] for row in tables["balance_snapshots"]) == [105, 12345], "balance history was omitted"
    assert tables["transactions"][0]["id"] == transaction_id and tables["transactions"][0]["amount"] == -105, "transaction contents were lost"
    assert len(tables["ingest_batches"]) == 1 and tables["ingest_batches"][0]["row_count"] == 1, "ingestion history was lost"
    assert json.loads(tables["ingest_rows"][0]["raw_json"])["externalId"] == "fixture-payment", "raw ingestion provenance was lost"
    assert json.loads(tables["settings"][0]["value_json"])["horizon"] == 2, "saved settings were omitted"
    assert json.loads(tables["transaction_edits"][0]["value_json"])["excludeForecast"] is True, "transaction edits were omitted"
    check_exports_clean(container)
    status, body, headers = request(base, "/api/export?format=sqlite", method="HEAD", cookie=cookie)
    assert status == 200 and not body, "HEAD export created a response body"
    check_export_headers(headers, "sqlite")
    check_exports_clean(container)
    assert request(base, "/api/export?format=unknown", cookie=cookie)[0] == 400, "unknown export format was accepted"
    status, downloaded, headers = request(base, "/api/export?format=sqlite", cookie=cookie)
    assert status == 200 and headers.get("Content-Type") == "application/vnd.sqlite3", "SQLite export failed"
    check_export_headers(headers, "sqlite")
    assert downloaded.startswith(b"SQLite format 3\0"), "SQLite download was not a database"
    check_exports_clean(container)
    # Downloaded synthetic bytes remain in memory on the host. Only the
    # disposable fixture container writes them, verifies recovery, then deletes.
    verify = """
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const fixture=JSON.parse(readFileSync(0,'utf8'));
const path='/tmp/fixture-downloaded.sqlite';
writeFileSync(path,Buffer.from(fixture.sqlite,'base64'),{flag:'wx',mode:0o600});
const db=new DatabaseSync(path,{readOnly:true});
try {
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Downloaded recovery integrity failed.');
  const actual=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const expected=Object.keys(fixture.archive.tables).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Downloaded recovery schema differs.');
  for(const table of expected){
    if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected fixture table.');
    const rows=db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all();
    if(JSON.stringify(rows)!==JSON.stringify(fixture.archive.tables[table]))throw new Error('Downloaded recovery content differs.');
  }
} finally {db.close();rmSync(path,{force:true});}
"""
    import base64
    fixture = json.dumps({"archive": archive, "sqlite": base64.b64encode(downloaded).decode()}).encode()
    subprocess.run(["docker", "exec", "-i", container, "node", "--input-type=module", "-e", verify], input=fixture, check=True, stdout=subprocess.DEVNULL)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 deploy/check-container.py IMAGE")
    image = sys.argv[1]
    containers = []
    volume = docker("volume", "create")
    runtime_args = (
        "run", "-d", "--read-only", "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
        "-p", "127.0.0.1::4321",
        "-e", "DATABASE_PATH=/data/saga-fe.sqlite",
        "-e", "SAGA_FE_AUTH_REQUIRED=true",
        "-e", "SAGA_FE_ALLOWED_HOSTS=" + HOST,
        "-e", "SAGA_FE_PUBLIC_ORIGIN=" + ORIGIN,
    )
    try:
        missing = docker(*runtime_args, "--tmpfs", "/data:rw,size=64m,uid=1000,gid=1000",
                         "-e", "SAGA_FE_AUTH_FILE=/run/secrets/saga-fe/missing.json", image)
        containers.append(missing)
        base = wait_healthy(missing)
        for path in ("/api/transactions", "/api/accounts", "/api/export?format=json", "/api/export?format=sqlite"):
            status, _, _ = request(base, path)
            assert status in (401, 403, 503), f"unauthenticated request was not denied: {path} ({status})"
        docker("stop", "--time", "1", missing)

        with tempfile.TemporaryDirectory(prefix="saga-fe-container-") as directory:
            # Only synthetic CI credentials are generated here. No owner files
            # or bank data are mounted into either container.
            os.chmod(directory, 0o777)
            password = "synthetic owner password for container checks"
            subprocess.run([
                "docker", "run", "--rm", "-i", "--user", "1000:1000",
                "-v", directory + ":/credentials", image,
                "node", "scripts/setup-auth.mjs", "/credentials/auth.json",
            ], input=password + "\n", text=True, check=True, stdout=subprocess.DEVNULL)
            os.chmod(directory, 0o755)
            container = docker(*runtime_args, "-v", volume + ":/data",
                               "-v", directory + ":/run/secrets/saga-fe:ro",
                               "-e", "SAGA_FE_AUTH_FILE=/run/secrets/saga-fe/auth.json", image)
            containers.append(container)
            base = wait_healthy(container)
            check_script_assets(base, "/login")
            assert request(base, "/api/accounts")[0] == 401, "finance API did not require login"
            for format in ("json", "sqlite"):
                assert request(base, "/api/export?format=" + format)[0] == 401, "export did not require owner login"
            assert request(base, "/api/session", "POST", {"password": "wrong"})[0] == 401, "wrong password accepted"
            status, _, headers = request(base, "/api/session", "POST", {"password": password})
            assert status == 200, "synthetic owner could not sign in"
            session_cookie = headers.get("Set-Cookie", "")
            assert all(flag in session_cookie for flag in ("HttpOnly", "SameSite=Strict", "Secure")), "session cookie is not protected"
            cookie = session_cookie.split(";", 1)[0]
            check_script_assets(base, "/", cookie)
            rejected_host_status = request(base, "/api/accounts", cookie=cookie, host="untrusted.example")[0]
            assert rejected_host_status == 403, f"host allowlist returned {rejected_host_status}, expected 403"
            assert request(base, "/api/accounts", "POST", {"name": "Fixture"}, cookie, origin="https://untrusted.example")[0] == 403, "cross-origin mutation accepted"

            ingest = {"adapter": "canonical-v1", "data": {
                "accounts": [{"externalId": "fixture-cash", "name": "Synthetic account", "balance": 12345, "balanceDate": "2026-10-14"}],
                "categories": [{"externalId": "fixture-food", "name": "Synthetic groceries"}],
                "counterparties": [{"externalId": "fixture-merchant", "name": "Synthetic merchant"}],
                "transactions": [{"externalId": "fixture-payment", "date": "2026-10-01", "amount": -105, "accountExternalId": "fixture-cash", "categoryExternalId": "fixture-food", "counterpartyExternalId": "fixture-merchant"}],
            }}
            for _ in range(2):
                assert request(base, "/api/ingest", "POST", ingest, cookie)[0] == 200, "synthetic ingestion failed"
            status, body, _ = request(base, "/api/accounts", cookie=cookie)
            assert status == 200, "account read failed"
            account = json.loads(body)["accounts"][0]
            mutation = {"id": account["id"], "balance": 105, "balanceDate": "2026-10-15"}
            assert request(base, "/api/accounts", "PATCH", mutation, cookie)[0] == 200, "balance update failed"
            status, body, _ = request(base, "/api/transactions", cookie=cookie)
            assert status == 200, "transaction read failed"
            transaction_id = json.loads(body)["transactions"][0]["id"]
            edits = {"overrides": {transaction_id: {"category": "Synthetic edited category", "kind": "expense", "excludeForecast": True}}}
            assert request(base, "/api/overrides", "PUT", edits, cookie)[0] == 200, "transaction edit save failed"
            settings = {"settings": {"horizon": 2, "lookback": 6, "balanceSource": "accounts", "fields": {"buffer": "1.05"}}}
            assert request(base, "/api/settings", "PUT", settings, cookie)[0] == 200, "settings save failed"
            docker("restart", "--time", "2", container)
            base = wait_healthy(container)
            status, body, _ = request(base, "/api/accounts", cookie=cookie)
            assert status == 200 and json.loads(body)["accounts"][0]["balance"] == 105, "balance did not persist"
            status, body, _ = request(base, "/api/transactions", cookie=cookie)
            assert status == 200 and len(json.loads(body)["transactions"]) == 1, "idempotent ingest did not persist"
            check_exports(base, cookie, container, account["id"], transaction_id)
            docker("exec", container, "node", "scripts/backup.mjs", "/tmp/fixture-backup.sqlite")
            verify = "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/tmp/fixture-backup.sqlite',{readOnly:true});if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('SELECT count(*) AS n FROM transactions').get().n!==1)process.exit(1);db.close();"
            docker("exec", container, "node", "--input-type=module", "-e", verify)
        print("Restricted runtime, owner login, ingestion, saved data persistence, full ledger exports and SQLite recovery passed with synthetic data.")
    except Exception:
        # These isolated containers contain only the synthetic fixtures above.
        for container in containers:
            print(docker("logs", container), file=sys.stderr)
        raise
    finally:
        for container in containers:
            subprocess.run(["docker", "rm", "-f", container], check=False, stdout=subprocess.DEVNULL)
        subprocess.run(["docker", "volume", "rm", volume], check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
