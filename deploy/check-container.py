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


def private_json(base, path, cookie, expected_status=200):
    status, body, headers = request(base, path, cookie=cookie)
    assert status == expected_status, "private activity API returned an unexpected status"
    assert headers.get("Cache-Control") == "no-store", "private activity response was cacheable"
    assert headers.get("X-Content-Type-Options") == "nosniff", "private activity response omitted nosniff"
    assert "application/json" in headers.get("Content-Type", ""), "private activity API did not return JSON"
    return json.loads(body)


def check_activity(base, cookie):
    # A separate source preserves the existing export/recovery fixture above.
    # These provider identifiers, labels and source references are synthetic.
    identifiers = ("fixture-activity-cash", "fixture-activity-reserve", "fixture-activity-shop", "fixture-activity-employer")
    columns = ("Dato", "Beløp", "Originalt Beløp", "Original Valuta", "Til konto", "Til kontonummer", "Fra konto", "Fra kontonummer", "Type", "Tekst", "KID", "Hovedkategori", "Underkategori")

    def row(amount="-1.05", from_name="Synthetic activity cash", from_id=identifiers[0], to_name="", to_id=identifiers[2], kind="Betaling", description="Synthetic activity payment", category="Synthetic food"):
        return ";".join(("2026-01-01", amount, amount, "NOK", to_name, to_id, from_name, from_id, kind, description, "fixture-activity-reference", category, ""))

    content = "\n".join((";".join(columns), row(), row(),
        row(amount="0.55", from_name="", from_id=identifiers[2], to_name="Synthetic activity cash", to_id=identifiers[0], description="Synthetic activity refund"),
        row(amount="1000.00", from_name="", from_id=identifiers[3], to_name="Synthetic activity cash", to_id=identifiers[0], kind="Inntekt", description="Synthetic activity salary", category="Income"),
        row(amount="-50.00", to_name="Synthetic activity reserve", to_id=identifiers[1], kind="Overføring", description="Synthetic debit leg"),
        row(amount="50.00", to_name="Synthetic activity reserve", to_id=identifiers[1], kind="Overføring", description="Synthetic credit leg")))
    ingest = {"adapter": "norwegian-bank-csv", "sourceKey": "container-activity", "filename": "synthetic-activity.csv", "content": content}
    for _ in range(2):
        assert request(base, "/api/ingest", "POST", ingest, cookie)[0] == 200, "synthetic activity ingestion failed"

    directory = private_json(base, "/api/endpoints", cookie)["endpoints"]
    cash = next(endpoint for endpoint in directory if endpoint["name"] == "Synthetic activity cash")
    reserve = next(endpoint for endpoint in directory if endpoint["name"] == "Synthetic activity reserve")
    accounts = private_json(base, "/api/accounts", cookie)["accounts"]
    assert len(accounts) == 3 and cash["owned"] and reserve["owned"], "external endpoint appeared as an owned balance account"
    assert all(endpoint["id"] not in identifiers for endpoint in directory), "directory returned raw identifiers as navigation IDs"
    normal = json.dumps(directory) + json.dumps(private_json(base, "/api/transactions", cookie))
    assert all(identifier not in normal for identifier in identifiers), "normal activity lists exposed raw provider identifiers"
    assert cash["summary"] == {"incoming": 100055, "outgoing": 5210, "net": 94845, "payments": 5, "transactionRows": 6, "internalPayments": 1, "firstDate": "2026-01-01", "lastDate": "2026-01-01"}, "mirrored activity was counted incorrectly"
    assert reserve["summary"]["incoming"] == 5000 and reserve["summary"]["payments"] == 1 and reserve["summary"]["transactionRows"] == 2, "recipient internal transfer was double-counted"

    cash_path = "/api/endpoints/" + urllib.parse.quote(cash["id"], safe="")
    activity = private_json(base, cash_path, cookie)
    assert activity["coverage"]["allHistory"] is True, "endpoint activity omitted complete-history coverage"
    assert len(activity["transactions"]) == 6 and len({transaction["id"] for transaction in activity["transactions"]}) == 6, "activity dropped or duplicated original rows"
    transfer = next(flow for flow in activity["flows"] if flow["internal"])
    assert transfer["pairedRows"] and transfer["pairing"] == "matched-bank-export-legs" and transfer["amount"] == 5000 and len(transfer["transactionIds"]) == 2, "bank transfer legs were not paired conservatively"
    assert sum(bool(transaction["pairedRows"]) for transaction in activity["transactions"]) == 2, "original paired transfer rows were lost"
    payment = next(transaction for transaction in activity["transactions"] if transaction["amount"] == -105)
    detail_path = "/api/transactions/" + urllib.parse.quote(payment["id"], safe="")
    detail = private_json(base, detail_path, cookie)
    assert detail["from"]["id"] == cash["id"] and detail["from"]["owned"] and not detail["to"]["owned"], "transaction sender or receiver identity was incorrect"
    assert detail["transaction"]["fromEndpointId"] == detail["from"]["id"] and detail["transaction"]["toEndpointId"] == detail["to"]["id"], "transaction links were not opaque endpoint identities"
    assert any(identifier["value"] == identifiers[0] for identifier in detail["from"]["identifiers"]), "authorized sender detail omitted its source identifier"
    assert any(identifier["value"] == identifiers[2] for identifier in detail["to"]["identifiers"]), "authorized receiver detail omitted its source identifier"
    assert detail["sourceFields"]["KID"] == "fixture-activity-reference" and detail["sourceFields"]["Original Valuta"] == "NOK" and detail["sourceFields"]["Originalt Beløp"] == "-1.05", "transaction source fields were incomplete"
    assert len(detail["provenance"]) == 1 and detail["provenance"][0]["adapter"] == "norwegian-bank-csv" and isinstance(detail["provenance"][0]["rowNumber"], int), "transaction source provenance was lost"
    override = {"id": payment["id"], "override": {"category": "Synthetic detail correction", "kind": "saving", "excludeForecast": True}}
    assert request(base, "/api/overrides", "PATCH", override, cookie)[0] == 200, "detail correction failed"
    edited = private_json(base, detail_path, cookie)
    assert edited["transaction"]["kind"] == "saving" and edited["transaction"]["excludeForecast"] is True and edited["original"]["kind"] == "expense" and edited["override"]["category"] == "Synthetic detail correction", "detail confused edited and original classifications"

    receiver_path = "/api/endpoints/" + urllib.parse.quote(detail["to"]["id"], safe="")
    receiver = private_json(base, receiver_path, cookie)
    assert receiver["summary"]["incoming"] == 210 and receiver["summary"]["outgoing"] == 55 and receiver["summary"]["payments"] == 3, "external sender/receiver direction was incorrect"
    party_path = "/api/counterparties/" + urllib.parse.quote(detail["to"]["counterpartyId"], safe="")
    party = private_json(base, party_path, cookie)
    assert party["summary"] == receiver["summary"] and len(party["transactions"]) == 3, "counterparty activity did not follow related endpoints"
    for path in (cash_path, detail_path, receiver_path, party_path):
        assert all(identifier not in path for identifier in identifiers), "navigation URL contains a provider identifier"
        denied_status, denied_body, _ = request(base, path)
        assert denied_status == 401 and set(json.loads(denied_body)) == {"error"}, "detail API disclosed private activity without owner login"
    for prefix in ("/api/endpoints/", "/api/transactions/", "/api/counterparties/"):
        assert set(private_json(base, prefix + "missing-opaque-fixture", cookie, 404)) == {"error"}, "unknown detail returned private data"
    assert set(private_json(base, "/api/endpoints/" + identifiers[0], cookie, 404)) == {"error"}, "raw provider identifier was accepted as a detail route"

    for balance, date in ((20345, "2026-02-01"), (None, "2026-02-02")):
        assert request(base, "/api/accounts", "PATCH", {"id": cash["accountId"], "balance": balance, "balanceDate": date}, cookie)[0] == 200, "synthetic activity balance update failed"
    saved = private_json(base, cash_path, cookie)["endpoint"]
    assert saved["balance"] is None and saved["balanceDate"] == "2026-02-02" and saved["balanceHistory"] == [{"date": "2026-02-02", "amount": None}, {"date": "2026-02-01", "amount": 20345}], "endpoint detail confused unknown balance with zero or lost history"


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
        for path in ("/api/transactions", "/api/accounts", "/api/endpoints", "/api/endpoints/missing-opaque-fixture", "/api/transactions/missing-opaque-fixture", "/api/counterparties/missing-opaque-fixture", "/api/export?format=json", "/api/export?format=sqlite"):
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
            for path in ("/api/endpoints", "/api/endpoints/missing-opaque-fixture", "/api/transactions/missing-opaque-fixture", "/api/counterparties/missing-opaque-fixture"):
                assert request(base, path)[0] == 401, "activity API did not require owner login"
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
            check_activity(base, cookie)
        print("Restricted runtime, owner login, ingestion, persistence, exports, SQLite recovery and payment/account detail APIs passed with synthetic data.")
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
