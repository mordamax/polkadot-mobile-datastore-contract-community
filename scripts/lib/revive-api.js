// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Substrate-side plumbing shared by the deploy scripts: an ApiPromise that can sign on individuality
// runtimes, dispatch-error decoding, and submit-and-wait.
const { ApiPromise, WsProvider } = require("@polkadot/api");

// Individuality runtimes add these extensions. Encoding them as None / false (a single 0x00 byte)
// is what a plain signed transaction sends. Chains without them ignore these definitions.
const INDIVIDUALITY_EXTENSIONS = {
  AsScarcity: { extrinsic: { asScarcity: "Option<u8>" }, payload: {} },
  AsPgas: { extrinsic: { asPgas: "Option<u8>" }, payload: {} },
  AsDotnsGateway: { extrinsic: { asDotnsGateway: "Option<u8>" }, payload: {} },
  RestrictOrigins: { extrinsic: { restrictOrigins: "bool" }, payload: {} },
  AuthorizeCall: { extrinsic: {}, payload: {} },
  UnitTransactionExtension: { extrinsic: {}, payload: {} },
  EthSetOrigin: { extrinsic: {}, payload: {} },
};

/**
 * `section.name` for a module or token DispatchError, its string form otherwise.
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {import("@polkadot/types/interfaces").DispatchError} error
 * @returns {string}
 */
function errorText(api, error) {
  if (error.isModule) {
    const { section, name } = api.registry.findMetaError(error.asModule);
    return `${section}.${name}`;
  }
  if (error.isToken) return `Token.${error.asToken.type}`;
  return error.toString();
}

/**
 * Signs and submits `tx`; resolves at inclusion, rejects with the decoded dispatch error.
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {import("@polkadot/api/types").SubmittableExtrinsic<"promise">} tx
 * @param {import("@polkadot/keyring/types").KeyringPair} signer
 * @returns {Promise<{ events: import("@polkadot/types/interfaces").EventRecord[], txHash: import("@polkadot/types/interfaces").Hash, blockHash: import("@polkadot/types/interfaces").Hash }>}
 */
function signAndWait(api, tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, events, dispatchError, txHash }) => {
      if (!status.isInBlock && !status.isFinalized) return;
      if (dispatchError) reject(new Error(errorText(api, dispatchError)));
      else resolve({ events, txHash, blockHash: status.isInBlock ? status.asInBlock : status.asFinalized });
    }).catch(reject);
  });
}

/**
 * `value` plus `marginPercent` percent of it.
 * @param {bigint} value
 * @param {bigint} marginPercent
 * @returns {bigint}
 */
function withMargin(value, marginPercent) {
  return value + (value * marginPercent) / 100n;
}

// Metadata v16 lists extensions per extension version and polkadot.js signs with all of them, but a
// v4 signed transaction carries only version 0's. The Polkadot Hub fork keeps the individuality
// extensions in version 1 only, so signing with the merged list is undecodable there.
/** @param {import("@polkadot/api").ApiPromise} api */
function useV4TransactionExtensions(api) {
  const { extrinsic } = api.runtimeMetadata.asLatest;
  const version0 = [...(extrinsic.transactionExtensionsByVersion?.entries() ?? [])].find(([version]) => version.toNumber() === 0);
  if (!version0) return;
  const names = extrinsic.transactionExtensions.map((extension) => extension.identifier.toString());
  api.registry.setSignedExtensions(version0[1].map((index) => names[index.toNumber()]), INDIVIDUALITY_EXTENSIONS);
}

/**
 * Connects to `endpoint` with the individuality extensions registered for signing.
 * @param {string} endpoint
 * @returns {Promise<import("@polkadot/api").ApiPromise>}
 */
async function connectRevive(endpoint) {
  const api = await ApiPromise.create({
    provider: new WsProvider(endpoint),
    signedExtensions: INDIVIDUALITY_EXTENSIONS,
    noInitWarn: true,
  });
  useV4TransactionExtensions(api);
  return api;
}

module.exports = { connectRevive, errorText, signAndWait, withMargin };
