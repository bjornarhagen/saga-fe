import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { rootCertificates } from 'node:tls';

// Public root fingerprints from https://emudhra.we-have-a-problem.com/roots.json.
const blockedRoots = new Set([
  '7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D',
  'F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5',
  'D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4',
  '86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B',
]);

const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) {
  throw new Error(`The container requires Node 24.22.1 or newer on the 24.x branch; found ${process.versions.node}`);
}

const systemRoots = readFileSync('/etc/ssl/cert.pem', 'utf8')
  .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);

for (const [name, certificates] of [['Node', rootCertificates], ['OS', systemRoots]]) {
  if (!certificates?.length) throw new Error(`${name} certificate store is empty`);
  for (const pem of certificates) {
    const certificate = new X509Certificate(pem);
    const fingerprint = certificate.fingerprint256.replaceAll(':', '');
    if (blockedRoots.has(fingerprint)) {
      throw new Error(`${name} still trusts a root affected by eMudhra: ${certificate.subject}`);
    }
  }
  console.log(`${name} trust store: ${certificates.length} certificates; affected roots absent`);
}
console.log(`Node ${process.versions.node}: security version floor passed`);

// Live checks are opt-in: ordinary CI does not depend on a third-party test host.
if (process.argv.includes('--online')) {
  const certificateErrors = new Set([
    'CERT_REVOKED',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]);
  const badHosts = [
    'dv-g3b-emudhra.we-have-a-problem.com',
    'dv-g3b-aaa-emudhra.we-have-a-problem.com',
    'dv-g3b-noct-emudhra.we-have-a-problem.com',
    'dv-g3b-aaa-noct-emudhra.we-have-a-problem.com',
  ];

  const connect = host => new Promise((resolve, reject) => {
    const request = https.get(`https://${host}/`, { agent: false, timeout: 15_000 }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('timeout', () => request.destroy(new Error(`HTTPS test timed out: ${host}`)));
    request.on('error', reject);
  });

  const status = await connect('example.com');
  if (status !== 200) throw new Error(`Normal HTTPS control returned ${status}`);
  console.log('Normal HTTPS control passed');

  for (const host of badHosts) {
    let failure;
    try {
      await connect(host);
    } catch (error) {
      failure = error;
    }
    if (!failure || !certificateErrors.has(failure.code)) {
      throw new Error(`${host}: expected certificate rejection, received ${failure?.code ?? 'a successful connection'}`);
    }
    console.log(`${host}: rejected (${failure.code})`);
  }
}
