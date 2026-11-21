#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Generate Tauri updater signing keys.
 *
 * This script generates the keypair used by the Tauri updater to sign release artifacts.
 * Run this once and store the private key securely as a GitHub secret.
 *
 * Usage:
 *   node scripts/generate-keys.mjs [--password <password>]
 *
 * The script will output:
 * - Public key (safe to commit to tauri.conf.json)
 * - Private key (store in TAURI_SIGNING_PRIVATE_KEY GitHub secret)
 * - Private key password (store in TAURI_SIGNING_PRIVATE_KEY_PASSWORD GitHub secret)
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command ${cmd} failed with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

async function main() {
  const passwordArg = process.argv.indexOf("--password");
  const password = passwordArg !== -1 ? process.argv[passwordArg + 1] : "";

  if (!password) {
    console.error("Error: Password is required for signing keys");
    console.error('Usage: node scripts/generate-keys.mjs --password "<your-secure-password>"');
    process.exit(1);
  }

  console.log("Generating Tauri updater signing keys...\n");

  try {
    const keysDir = path.join(__dirname, "..", "src-tauri");

    // Try to use the tauri CLI first
    try {
      console.log("Using Tauri CLI to generate keys...\n");
      await runCommand("npx", ["tauri", "signer", "generate", "-w", keysDir, "-p", password]);

      // Read the generated public key
      const pubKeyPath = path.join(keysDir, "tauri.key.pub");
      if (fs.existsSync(pubKeyPath)) {
        const publicKey = fs.readFileSync(pubKeyPath, "utf8").trim();
        console.log("\n✓ Keys generated successfully!\n");
        console.log("=".repeat(80));
        console.log("PUBLIC KEY (safe to commit to tauri.conf.json):");
        console.log("=".repeat(80));
        console.log(publicKey);
        console.log("\n=".repeat(80));
        console.log("PRIVATE KEY (store in GitHub secret TAURI_SIGNING_PRIVATE_KEY):");
        console.log("=".repeat(80));
        const privateKeyPath = path.join(keysDir, "tauri.key");
        const privateKey = fs.readFileSync(privateKeyPath, "utf8");
        console.log(privateKey);
        console.log("\n=".repeat(80));
        console.log("NEXT STEPS:");
        console.log("=".repeat(80));
        console.log("1. Copy the PUBLIC KEY and update tauri.conf.json:");
        console.log('   "pubkey": "<PUBLIC_KEY_HERE>"');
        console.log("\n2. Set up GitHub Secrets:");
        console.log("   TAURI_SIGNING_PRIVATE_KEY: (paste the full private key content)");
        console.log("   TAURI_SIGNING_PRIVATE_KEY_PASSWORD: " + password);
        console.log("\n3. Keep the private key files safe:");
        console.log(`   - ${privateKeyPath}`);
        console.log(`   - ${pubKeyPath}`);
        console.log("\n4. After setting up secrets, you can delete the local key files.");
        console.log("   WARNING: Do NOT commit these files to git!");
        process.exit(0);
      }
    } catch {
      console.error("Failed to use Tauri CLI, falling back to base64 generation...");
    }

    // Fallback: generate random keys using openssl or crypto
    console.log("Generating keys with OpenSSL...\n");
    throw new Error(
      "Please use the Tauri CLI: npx tauri signer generate --help\nOr install tauri-bundler: npm install --save-dev @tauri-apps/cli @tauri-apps/bundler",
    );
  } catch (error) {
    console.error("Error generating keys:", error.message);
    console.error("\nPlease ensure you have the Tauri CLI installed:");
    console.error("  npm install --save-dev @tauri-apps/cli");
    process.exit(1);
  }
}

main();
