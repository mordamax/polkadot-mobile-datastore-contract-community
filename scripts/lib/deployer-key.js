// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Resolves the sr25519 deployer secret URI from the environment, for the scripts that sign with a
// real (non-dev) key.
//
// Env:
//   DEPLOYER_MNEMONIC   BIP-39 passphrase; checked before anything is derived.
//   DEPLOYER_DERIVATION optional derivation appended to it, e.g. //deploy
//   DEPLOYER_SURI       fallback when DEPLOYER_MNEMONIC is unset: any sr25519 secret URI.
const { cryptoWaitReady, mnemonicValidate } = require("@polkadot/util-crypto");

/**
 * The mnemonic with runs of whitespace collapsed, so a pasted multi-line secret still validates.
 * @returns {string}
 */
function normalizedMnemonic() {
  const words = (process.env.DEPLOYER_MNEMONIC || "").trim().split(/\s+/).filter(Boolean);
  return words.join(" ");
}

/**
 * Secret URI of the deployer: DEPLOYER_MNEMONIC (+ DEPLOYER_DERIVATION), else DEPLOYER_SURI.
 * @returns {Promise<string>}
 */
async function deployerSuri() {
  const mnemonic = normalizedMnemonic();
  if (mnemonic) {
    await cryptoWaitReady();
    // A mistyped word still derives a key, just someone else's; refuse instead of deploying from it.
    const wordCount = mnemonic.split(" ").length;
    if (!mnemonicValidate(mnemonic)) throw new Error(`DEPLOYER_MNEMONIC (${wordCount} words) is not a valid BIP-39 passphrase; expected 12 or 24 words from the English wordlist with a valid checksum`);
    return mnemonic + (process.env.DEPLOYER_DERIVATION || "");
  }
  if (process.env.DEPLOYER_SURI) return process.env.DEPLOYER_SURI;
  throw new Error("Neither DEPLOYER_MNEMONIC nor DEPLOYER_SURI is set; put DEPLOYER_MNEMONIC in .env (see .env.example)");
}

module.exports = { deployerSuri };
