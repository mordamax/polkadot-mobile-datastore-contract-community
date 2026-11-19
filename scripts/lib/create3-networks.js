// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Networks the CREATE3 deploy targets, keyed by the ids paritytech/autodeployer dispatches with.
// Keyed by id rather than genesis hash: a testnet wipe changes the genesis hash, while the factory
// comes back on the same address.

/** The Solady CREATE3 factory deployed from the dotns repository; same address on every network. */
const CREATE3_FACTORY = "0x8533c79E058c5a6489CAFeCA86dc600E029D75f5";

/** @typedef {{ wsUrl: string, factory: string }} Create3Network */

/** @type {Record<string, Create3Network>} */
const CREATE3_NETWORKS = {
  "paseo-next-v2": { wsUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io", factory: CREATE3_FACTORY },
  preview: { wsUrl: "wss://previewnet.substrate.dev/asset-hub", factory: CREATE3_FACTORY },
};

/**
 * @param {string} networkId
 * @returns {Create3Network}
 */
function create3Network(networkId) {
  const network = CREATE3_NETWORKS[networkId];
  if (network) return network;
  const known = Object.keys(CREATE3_NETWORKS).join(" | ");
  throw new Error(`Unknown NETWORK ${JSON.stringify(networkId)}; expected one of ${known}`);
}

module.exports = { create3Network };
