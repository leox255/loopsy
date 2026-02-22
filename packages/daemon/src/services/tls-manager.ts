import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import { CONFIG_DIR, TLS_DIR, TLS_CERT_FILE, TLS_KEY_FILE } from '@loopsy/protocol';
import type { TlsConfig, PeerCertInfo } from '@loopsy/protocol';

// ASN.1 DER encoding helpers for building a self-signed X.509 certificate
// Node.js doesn't have a built-in cert generation API, so we use the low-level
// crypto primitives with a minimal ASN.1 builder.

export interface TlsFiles {
  cert: string;   // PEM certificate
  key: string;    // PEM private key
  fingerprint: string; // SHA-256 fingerprint of the cert (hex)
}

export class TlsManager {
  private dataDir: string;
  private tlsDir: string;
  private certPath: string;
  private keyPath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(homedir(), CONFIG_DIR);
    this.tlsDir = join(this.dataDir, TLS_DIR);
    this.certPath = join(this.tlsDir, TLS_CERT_FILE);
    this.keyPath = join(this.tlsDir, TLS_KEY_FILE);
  }

  /** Check if TLS cert/key already exist */
  hasCerts(): boolean {
    return existsSync(this.certPath) && existsSync(this.keyPath);
  }

  /** Generate a self-signed EC certificate if none exists */
  async ensureCerts(hostname: string): Promise<TlsFiles> {
    if (this.hasCerts()) {
      return this.loadCerts();
    }
    return this.generateCerts(hostname);
  }

  /** Generate a new self-signed certificate */
  async generateCerts(hostname: string): Promise<TlsFiles> {
    await mkdir(this.tlsDir, { recursive: true });

    // Generate EC keypair (P-256)
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Use Node's built-in X509 cert generation (available since Node 20)
    // We'll use a child process with openssl as a fallback-free approach:
    // Actually, Node doesn't have cert generation built-in. We'll generate
    // a self-signed cert using the `selfsigned` approach via raw crypto.
    //
    // For simplicity, we'll shell out to openssl or use the node:crypto
    // createSelfSignedCert if available. Since Node 22+ doesn't have this,
    // we'll create a minimal self-signed cert with raw ASN.1.

    const cert = await this.createSelfSignedCert(hostname, publicKey, privateKey);

    await writeFile(this.keyPath, privateKey, { mode: 0o600 });
    await writeFile(this.certPath, cert);

    const fingerprint = this.computeFingerprint(cert);
    return { cert, key: privateKey, fingerprint };
  }

  /** Load existing cert/key files */
  async loadCerts(): Promise<TlsFiles> {
    const cert = await readFile(this.certPath, 'utf-8');
    const key = await readFile(this.keyPath, 'utf-8');
    const fingerprint = this.computeFingerprint(cert);
    return { cert, key, fingerprint };
  }

  /** Compute SHA-256 fingerprint of a PEM certificate */
  computeFingerprint(certPem: string): string {
    // Extract DER from PEM
    const b64 = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');
    const der = Buffer.from(b64, 'base64');
    return createHash('sha256').update(der).digest('hex');
  }

  /** Get cert info for display */
  getCertInfo(certPem: string): PeerCertInfo {
    const x509 = new X509Certificate(certPem);
    return {
      fingerprint: this.computeFingerprint(certPem),
      hostname: x509.subject.split('CN=')[1]?.split('\n')[0] || 'unknown',
      validFrom: x509.validFrom,
      validTo: x509.validTo,
    };
  }

  /** Get Fastify HTTPS options */
  async getHttpsOptions(): Promise<{ key: string; cert: string } | null> {
    if (!this.hasCerts()) return null;
    const { cert, key } = await this.loadCerts();
    return { key, cert };
  }

  /** Create a self-signed certificate using openssl CLI (widely available) */
  private async createSelfSignedCert(hostname: string, _publicKey: string, privateKey: string): Promise<string> {
    // Use Node's child_process to call openssl for cert generation
    // This is the most portable approach that avoids native dependencies
    const { execSync } = await import('node:child_process');
    const { writeFileSync, readFileSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmpKey = join(tmpdir(), `loopsy-key-${Date.now()}.pem`);
    const tmpCert = join(tmpdir(), `loopsy-cert-${Date.now()}.pem`);

    try {
      writeFileSync(tmpKey, privateKey, { mode: 0o600 });

      execSync(
        `openssl req -new -x509 -key "${tmpKey}" -out "${tmpCert}" ` +
        `-days 3650 -subj "/CN=${hostname}/O=Loopsy" ` +
        `-addext "subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1"`,
        { stdio: 'pipe' },
      );

      return readFileSync(tmpCert, 'utf-8');
    } finally {
      try { unlinkSync(tmpKey); } catch {}
      try { unlinkSync(tmpCert); } catch {}
    }
  }
}
