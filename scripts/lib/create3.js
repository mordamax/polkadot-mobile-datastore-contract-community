// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Parity Technologies (UK) Ltd.

// Deterministic deploys through the shared Solady CREATE3 factory, the one the dotNS contracts and
// paritytech/attestation-protocol deploy through.
//
// A CREATE3 address depends only on the factory address and the salt; the deployer and the bytecode
// play no part. So the contract lands on the same address on every network that has the factory,
// comes back on that address after a chain wipe, and any funded account can put it there. A salt
// can be used once: a rerun finds code at the address and adopts it, so a partial run is safe to
// repeat.
//
// The factory runs on revive's EVM backend and accepts EVM (solc) init code only; PolkaVM (resolc)
// init code reverts with DeploymentFailed().
const { Interface, getCreate2Address, getCreateAddress, keccak256, toUtf8Bytes } = require("ethers");
const { errorText, signAndWait, withMargin } = require("./revive-api");

/** Keeps these salts apart from the dotNS, Browse and attestation-protocol ones on the same factory. */
const SALT_NAMESPACE = "account-data-store.create3.v1";

/** Init code of the Solady CREATE3 proxy: the factory CREATE2s it from the salt, it then CREATEs the contract. */
const PROXY_INIT_CODE_HASH = keccak256("0x67363d3d37363d34f03d5260086018f3");

const FACTORY_ABI = new Interface(["function deploy(bytes32 salt, bytes initCode) payable returns (address)"]);

/** pallet-revive ReturnFlags bit set when the callee reverted. */
const REVERT_FLAG = 1;

/** @typedef {{ refTime: bigint, proofSize: bigint }} WeightV2 */
/** @typedef {{ weightRequired: WeightV2, storageDeposit: bigint }} FactoryDeployEstimate */
/** @typedef {"deployed" | "adopted" | "dry-run"} Create3Status */
/** @typedef {{ address: string, status: Create3Status, estimate: FactoryDeployEstimate | null }} Create3Result */

/**
 * `create3Salt("AccountDataStore", "1.0.0")` hashes `account-data-store.create3.v1:AccountDataStore:1.0.0`.
 * @param {string} name
 * @param {string} version
 * @returns {{ salt: string, preimage: string }}
 */
function create3Salt(name, version) {
  const preimage = `${SALT_NAMESPACE}:${name}:${version}`;
  return { salt: keccak256(toUtf8Bytes(preimage)), preimage };
}

/**
 * The address a salt resolves to, derived without touching the network.
 * @param {string} salt 0x-prefixed bytes32
 * @param {string} factory 0x-prefixed H160
 * @returns {string} checksummed H160
 */
function predictCreate3(salt, factory) {
  const proxy = getCreate2Address(factory, salt, PROXY_INIT_CODE_HASH);
  return getCreateAddress({ from: proxy, nonce: 1 });
}

/**
 * True when `address` holds contract code.
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {string} address
 * @returns {Promise<boolean>}
 */
async function hasCode(api, address) {
  // polkadot.js hands back the SCALE-encoded Vec<u8> wrapped once more in Bytes (an empty account
  // reads as 0x00, its length prefix), so decode the inner Vec<u8> before measuring it.
  const wrapped = await api.call.reviveApi.code(address);
  const code = api.createType("Bytes", wrapped.toU8a(true));
  return code.length > 0;
}

/**
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {string} factory
 * @returns {Promise<void>}
 */
async function assertFactoryDeployed(api, factory) {
  if (await hasCode(api, factory)) return;
  throw new Error(`No CREATE3 factory at ${factory}; expected the Solady CREATE3 factory deployed from the dotns repository`);
}

/**
 * Throws when a `ReviveApi.call` dry-run failed or reverted.
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {any} dryRun the decoded ContractResult<ExecReturnValue>
 * @returns {void}
 */
function assertDryRunSucceeded(api, dryRun) {
  if (dryRun.result.isErr) throw new Error(`factory.deploy dry-run failed with ${errorText(api, dryRun.result.asErr)}`);
  const { flags, data } = dryRun.result.asOk;
  const reverted = (flags.bits.toNumber() & REVERT_FLAG) !== 0;
  if (!reverted) return;
  throw new Error(
    `factory.deploy dry-run reverted with ${data.toHex()}; 0x30116425 is DeploymentFailed(): ` +
      "the init code reverted, is not EVM bytecode, or the deployer cannot pay the storage deposit",
  );
}

/**
 * Dry-runs `factory.deploy` from `origin` and returns the weight and storage deposit it needs.
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {string} origin SS58 address of the signer
 * @param {string} factory
 * @param {string} callData ABI-encoded `deploy(salt, initCode)`
 * @returns {Promise<FactoryDeployEstimate>}
 */
async function estimateFactoryDeploy(api, origin, factory, callData) {
  const dryRun = await api.call.reviveApi.call(origin, factory, 0, null, null, callData);
  assertDryRunSucceeded(api, dryRun);
  const { refTime, proofSize } = dryRun.weightRequired;
  const weightRequired = { refTime: refTime.toBigInt(), proofSize: proofSize.toBigInt() };
  const storageDeposit = dryRun.storageDeposit.isCharge ? dryRun.storageDeposit.asCharge.toBigInt() : 0n;
  return { weightRequired, storageDeposit };
}

/**
 * Submits `tx` and resolves with its dispatch error text, or null when it succeeded. The caller judges
 * the deploy by the code at the predicted address: a factory call can report ContractReverted for
 * a deploy that landed.
 * @param {import("@polkadot/api").ApiPromise} api
 * @param {import("@polkadot/api/types").SubmittableExtrinsic<"promise">} tx
 * @param {import("@polkadot/keyring/types").KeyringPair} signer
 * @returns {Promise<string | null>}
 */
async function submitCollectingError(api, tx, signer) {
  try {
    await signAndWait(api, tx, signer);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Deploys `initCode` (EVM creation bytecode plus ABI-encoded constructor arguments) at its CREATE3
 * address, or adopts the contract already there. `dryRun` stops after the estimate.
 * @param {{ api: import("@polkadot/api").ApiPromise, signer: import("@polkadot/keyring/types").KeyringPair,
 *   factory: string, salt: string, initCode: string, dryRun: boolean, marginPercent: bigint }} options
 * @returns {Promise<Create3Result>}
 */
async function deployCreate3({ api, signer, factory, salt, initCode, dryRun, marginPercent }) {
  const address = predictCreate3(salt, factory);
  await assertFactoryDeployed(api, factory);
  if (await hasCode(api, address)) return { address, status: "adopted", estimate: null };

  const callData = FACTORY_ABI.encodeFunctionData("deploy", [salt, initCode]);
  const estimate = await estimateFactoryDeploy(api, signer.address, factory, callData);
  if (dryRun) return { address, status: "dry-run", estimate };

  const weightLimit = {
    refTime: withMargin(estimate.weightRequired.refTime, marginPercent),
    proofSize: withMargin(estimate.weightRequired.proofSize, marginPercent),
  };
  const depositLimit = withMargin(estimate.storageDeposit, marginPercent);
  const tx = api.tx.revive.call(factory, 0, weightLimit, depositLimit, callData);
  const dispatchError = await submitCollectingError(api, tx, signer);
  if (await hasCode(api, address)) return { address, status: "deployed", estimate };
  throw new Error(`No code at ${address} after factory.deploy; dispatch error: ${dispatchError ?? "none"}`);
}

module.exports = { create3Salt, deployCreate3, predictCreate3 };
