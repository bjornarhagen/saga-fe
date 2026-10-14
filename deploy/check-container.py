#!/usr/bin/env python3
"""Exercise the production image without bank exports, secrets, or host state."""

import json
import os
import subprocess
import sys
import tempfile
import time
from html.parser import HTMLParser
import urllib.error
import urllib.parse
import urllib.request


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
        for path in ("/api/transactions", "/api/accounts"):
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
                "transactions": [{"externalId": "fixture-payment", "date": "2026-10-01", "amount": -105, "accountExternalId": "fixture-cash"}],
            }}
            for _ in range(2):
                assert request(base, "/api/ingest", "POST", ingest, cookie)[0] == 200, "synthetic ingestion failed"
            status, body, _ = request(base, "/api/accounts", cookie=cookie)
            assert status == 200, "account read failed"
            account = json.loads(body)["accounts"][0]
            mutation = {"id": account["id"], "balance": 105, "balanceDate": "2026-10-15"}
            assert request(base, "/api/accounts", "PATCH", mutation, cookie)[0] == 200, "balance update failed"
            docker("restart", "--time", "2", container)
            base = wait_healthy(container)
            status, body, _ = request(base, "/api/accounts", cookie=cookie)
            assert status == 200 and json.loads(body)["accounts"][0]["balance"] == 105, "balance did not persist"
            status, body, _ = request(base, "/api/transactions", cookie=cookie)
            assert status == 200 and len(json.loads(body)["transactions"]) == 1, "idempotent ingest did not persist"
            docker("exec", container, "node", "scripts/backup.mjs", "/tmp/fixture-backup.sqlite")
            verify = "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/tmp/fixture-backup.sqlite',{readOnly:true});if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('SELECT count(*) AS n FROM transactions').get().n!==1)process.exit(1);db.close();"
            docker("exec", container, "node", "--input-type=module", "-e", verify)
        print("Restricted runtime, owner login, ingestion, balance persistence and SQLite backup passed with synthetic data.")
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
