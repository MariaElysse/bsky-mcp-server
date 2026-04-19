#!/usr/bin/env node
// Generates a private JWK Set used by the ATProto OAuth client to sign
// DPoP proofs and client assertions. The public half is derived at request
// time and served at /oauth/jwks.json, so only this file needs to exist
// on disk.
//
// Usage:
//   generate-signing-key [<path>] [--force]
//
// Path defaults to SIGNING_KEY_PATH env var, then ./signing-keys.json.

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const positional = args.filter(a => !a.startsWith("--"));
  const outPath = positional[0]
    ?? process.env.SIGNING_KEY_PATH
    ?? path.resolve(process.cwd(), "signing-keys.json");

  try {
    await fs.access(outPath);
    if (!force) {
      console.error(`Refusing to overwrite existing key file: ${outPath}`);
      console.error(`Pass --force if you really mean to replace it. Replacing a live key invalidates all in-flight OAuth sessions.`);
      process.exit(2);
    }
  } catch {
    // path does not exist; good
  }

  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = randomUUID();
  jwk.alg = "ES256";
  // Don't set "use" — newer jose warns that "use" on a private JWK will be
  // rejected in a future release; private keys should advertise "key_ops"
  // instead. We leave key_ops unset too, which is valid per RFC 7517: a JWK
  // without either property is usable for any operation the key type supports.

  const jwks = { keys: [jwk] };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(jwks, null, 2) + "\n", { mode: 0o600 });

  console.log(`Wrote ES256 signing key to ${outPath} (kid=${jwk.kid})`);
  console.log(`Ensure this file is mode 0600 and not world-readable.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
