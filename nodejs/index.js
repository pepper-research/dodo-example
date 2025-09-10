const axios = require("axios").default;
const { ethers, parseUnits, hexlify, isAddress, ZeroAddress } = require("ethers");
const erc20ABI = require("./erc20.json");
const dotenv = require("dotenv");
dotenv.config();

const privateKey = process.env.YOUR_PK;
const apiKey = process.env.YOUR_API_KEY;
const rpcUrl = "https://testnet.dplabs-internal.com/";        // Pharos testnet RPC
const EXPECTED_CHAIN_ID = 688688n;                             // Pharos testnet chain id (bigint for v6)

if (!privateKey || !privateKey.startsWith("0x")) {
  throw new Error("Missing or invalid YOUR_PK in env.");
}
if (!apiKey) {
  throw new Error("Missing YOUR_API_KEY in env.");
}

const rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
const wallet = new ethers.Wallet(privateKey, rpcProvider);

// DODO route-service
const dodoAPI = "https://api.dodoex.io/route-service/developer/getdodoroute";

// Pharos testnet tokens (USDC -> USDT)
const fromTokenAddress = "0x72df0bcd7276f2dfbac900d1ce63c272c4bccced"; // USDC (6)
const toTokenAddress = "0xd4071393f8716661958f766df660033b3d35fd29"; // USDT (6)
const FROM_DECIMALS = 6;
const TO_DECIMALS = 6;

// ---------- helpers ----------
const getErc20 = (addr, signerOrProvider = rpcProvider) =>
  new ethers.Contract(addr, erc20ABI, signerOrProvider);

const ensureAddress = (label, addr) => {
  if (!addr || addr === ZeroAddress || !isAddress(addr)) {
    throw new Error(`Invalid ${label} address: ${addr}`);
  }
  return ethers.getAddress(addr); // checksum
};

const getChainId = async () => (await rpcProvider.getNetwork()).chainId;

const readDecimals = async (addr) => {
  try {
    const c = getErc20(addr);
    const d = await c.decimals();
    return Number(d);
  } catch (e) {
    console.warn(`Could not read decimals for ${addr}; defaulting to ABI-provided values.`);
    return null;
  }
};

const checkAllowance = async (token, owner, spender, want) => {
  const c = getErc20(token);
  const allowance = await c.allowance(owner, spender);
  console.log("allowance:", allowance.toString());
  return BigInt(allowance.toString()) >= BigInt(want);
};

const approveIfNeeded = async (token, owner, spender, amount) => {
  // Robust approve flow for USDT-like tokens that require 0-then-new
  const c = getErc20(token, wallet);
  const ok = await checkAllowance(token, owner, spender, amount);
  if (ok) {
    console.log("✓ Already approved enough.");
    return;
  }
  console.log(`Approving ${spender} to spend ${amount} of ${token}...`);

  try {
    const tx = await c.approve(spender, amount);
    console.log("approve tx sent:", tx.hash);
    await tx.wait();
    console.log("✓ approve confirmed");
  } catch (e) {
    console.warn("Direct approve failed, attempting reset-to-0 then approve…");
    try {
      const tx0 = await c.approve(spender, 0n);
      console.log("approve(0) tx sent:", tx0.hash);
      await tx0.wait();

      const txn = await c.approve(spender, amount);
      console.log("approve(new) tx sent:", txn.hash);
      await txn.wait();
      console.log("✓ approve confirmed after reset");
    } catch (e2) {
      console.error("Approve failed:", e2);
      throw e2;
    }
  }
};

const preflightCall = async (txLike) => {
  // Simulate call before estimateGas to catch SafeERC20 issues early
  try {
    await rpcProvider.call({
      from: txLike.from,
      to: txLike.to,
      data: txLike.data,
      value: txLike.value || 0,
    });
    return { ok: true };
  } catch (e) {
    // many RPCs put reason under e.data or e.error
    console.error("❌ Preflight call reverted:", e?.shortMessage || e?.message || e);
    return { ok: false, error: e };
  }
};

// ---------- main ----------
const testFlight = async () => {
  // Basic sanity
  const me = await wallet.getAddress();
  console.log("wallet:", me);

  const chainId = await getChainId();
  console.log("connected chainId:", chainId);
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain. Expected ${EXPECTED_CHAIN_ID}, got ${chainId}. Check RPC.`);
  }

  ensureAddress("fromToken", fromTokenAddress);
  ensureAddress("toToken", toTokenAddress);

  // Confirm token decimals match what we’re about to use (defensive)
  const onchainFromDecimals = await readDecimals(fromTokenAddress);
  const onchainToDecimals = await readDecimals(toTokenAddress);
  if (onchainFromDecimals !== null && onchainFromDecimals !== FROM_DECIMALS) {
    throw new Error(`FROM_DECIMALS mismatch. Config=${FROM_DECIMALS}, onchain=${onchainFromDecimals}`);
  }
  if (onchainToDecimals !== null && onchainToDecimals !== TO_DECIMALS) {
    throw new Error(`TO_DECIMALS mismatch. Config=${TO_DECIMALS}, onchain=${onchainToDecimals}`);
  }

  // Define amount (1 USDC with 6 decimals)
  const fromAmount = parseUnits("1", FROM_DECIMALS).toString();

  // Check balance up front (avoids SafeERC20 sadness later)
  const fromToken = getErc20(fromTokenAddress);
  const bal = await fromToken.balanceOf(me);
  console.log(`USDC balance: ${bal.toString()}`);
  if (BigInt(bal.toString()) < BigInt(fromAmount)) {
    throw new Error(`Insufficient USDC. Need ${fromAmount}, have ${bal.toString()}.`);
  }

  // Ask DODO for route
  const params = {
    fromTokenAddress,
    fromTokenDecimals: FROM_DECIMALS,
    toTokenAddress,
    toTokenDecimals: TO_DECIMALS,
    fromAmount,
    slippage: 1,               // 1%
    userAddr: me,
    chainId: EXPECTED_CHAIN_ID,
    rpc: rpcUrl,
    apikey: apiKey,
  };

  console.log("Querying DODO route…");
  const response = await axios.get(dodoAPI, { params });
  console.log("route response status:", response.data?.status);
  if (!response.data || response.data.status !== 200) {
    throw new Error(`DODO route-service error: ${JSON.stringify(response.data)}`);
  }

  const routeObj = response.data.data;
  // Defensive validations on route
  ensureAddress("route.to (router)", routeObj.to);
  const spender = routeObj.targetApproveAddr && isAddress(routeObj.targetApproveAddr)
    ? ethers.getAddress(routeObj.targetApproveAddr)
    : ethers.getAddress(routeObj.to); // fallback if API omits approver

  // If ERC20 swap, routeObj.value should be 0 or undefined
  if (routeObj.value && BigInt(routeObj.value) !== 0n) {
    throw new Error(`Unexpected non-zero value for ERC20 swap: ${routeObj.value}`);
  }

  // Approve if needed
  await approveIfNeeded(fromTokenAddress, me, spender, BigInt(fromAmount));

  // Preflight simulate (surfacing SafeERC20 issues before gas est.)
  const pre = await preflightCall({
    from: me,
    to: routeObj.to,
    data: routeObj.data,
    value: routeObj.value || 0,
  });
  if (!pre.ok) {
    throw new Error("Preflight simulation reverted. Check allowance, balances, path liquidity and amounts.");
  }

  // Gas estimate
  let gasLimit;
  try {
    gasLimit = await wallet.estimateGas({
      to: routeObj.to,
      data: routeObj.data,
      value: routeObj.value || 0,
    });
  } catch (e) {
    console.error("estimateGas failed:", e);
    throw e;
  }
  console.log("gasLimit =>", gasLimit.toString());

  const feeData = await rpcProvider.getFeeData();
  console.log("feeData =>", feeData);

  const nonce = await wallet.getNonce();
  console.log("nonce =>", nonce);

  if (typeof routeObj.data !== "string" || !routeObj.data.startsWith("0x")) {
    throw new Error("Invalid route data (expected 0x-prefixed hex string)");
  }
  console.log("route data length:", routeObj.data.length);

  // Build tx with bigint types
  const tx = {
    to: routeObj.to,
    data: routeObj.data,
    value: BigInt(routeObj.value || 0),
    nonce,
    gasLimit: gasLimit,
    ...(feeData.maxFeePerGas && feeData.maxPriorityFeePerGas
      ? {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      }
      : { gasPrice: feeData.gasPrice }),
  };

  // One more light ping (optional): ensure to != token address
  if (ethers.getAddress(tx.to) === ethers.getAddress(fromTokenAddress)) {
    throw new Error("Router address equals token address — routing response looks wrong.");
  }

  // Send tx
  const result = await wallet.sendTransaction(tx);
  console.log("txHash =>", result.hash);
  console.log(`(Pharos explorer) Check your tx: ${result.hash}`);

  const rec = await result.wait();
  console.log("✓ Swap confirmed in block", rec.blockNumber);
};

testFlight()
  .then(() => console.log("Swap Done."))
  .catch((e) => {
    console.error("Swap failed:", e?.shortMessage || e?.message || e);
  });
