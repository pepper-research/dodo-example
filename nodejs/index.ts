import axios from 'axios';
import { API_CONFIG } from './config/api';
import { pollIntentStep } from './utils/intentPolling';
import {
  hashChainBatches,
  getAuthorizationHash as sdkGetAuthorizationHash,
  getRecentBlock as sdkGetRecentBlock,
  submitTransaction,
} from '../spiceflow/dist/index.js';
import {
  Address,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  zeroAddress,
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import erc20ABI from "./erc20.json";
import dotenv from "dotenv";
dotenv.config();

const privateKey = process.env.YOUR_PK;
const apiKey = process.env.YOUR_API_KEY;
// const rpcUrl = "https://testnet.dplabs-internal.com/";        // Pharos testnet RPC
const rpcUrl = "https://pharos-fork.spicenet.io/"
const txApiUrl = API_CONFIG.TX_API_URL;


// --------- helpers ---------
type Call = { to: Address; value: bigint; data: `0x${string}` };
type Authorization = {
  address: `0x${string}`;
  chainId: number;
  nonce: number;
  r: `0x${string}`;
  s: `0x${string}`;
  yParity: number;
};

const EXPECTED_CHAIN_ID = 688688n;                             // Pharos testnet chain id (bigint for v6)

if (!privateKey || !privateKey.startsWith("0x")) {
  throw new Error("Missing or invalid YOUR_PK in env.");
}
if (!apiKey) {
  throw new Error("Missing YOUR_API_KEY in env.");
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
const chainConfig = { id: Number(688688) } as any; // minimal chain object
const publicClient = createPublicClient({ chain: chainConfig, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain: chainConfig, transport: http(rpcUrl), account });

// DODO route-service
const dodoAPI = "https://api.dodoex.io/route-service/developer/getdodoroute";

// Pharos testnet tokens (USDC -> USDT)
const fromTokenAddress = "0x72df0bcd7276f2dfbac900d1ce63c272c4bccced"; // USDC (6)
const toTokenAddress = "0xd4071393f8716661958f766df660033b3d35fd29"; // USDT (6)
const FROM_DECIMALS = 6;
const TO_DECIMALS = 6;

// ---------- helpers ----------

const ensureAddress = (label: string, addr: string) => {
  if (!addr || addr === zeroAddress || !isAddress(addr)) {
    throw new Error(`Invalid ${label} address: ${addr}`);
  }
  return getAddress(addr);
};

const getChainId = async () => await publicClient.getChainId();

const readDecimals = async (addr: Address) => {
  try {
    const d = await publicClient.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' });
    return Number(d);
  } catch (e) {
    console.warn(`Could not read decimals for ${addr}; defaulting to ABI-provided values.`);
    return null;
  }
};

const checkAllowance = async (token: Address, owner: Address, spender: Address, want: bigint) => {
  const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
  console.log("allowance:", allowance.toString());
  return BigInt(allowance.toString()) >= BigInt(want);
};

// Note: on-chain approve flow removed here; approval is encoded into calls[] when using intents

const preflightCall = async (txLike: { from: Address; to: Address; data: `0x${string}`; value?: bigint }) => {
  try {
    await publicClient.call({ to: txLike.to, data: txLike.data, value: txLike.value ?? 0n, account });
    return { ok: true };
  } catch (e: any) {
    console.error("❌ Preflight call reverted:", e?.shortMessage || e?.message || e);
    return { ok: false, error: e };
  }
};

// authorization digest handled by viem signAuthorization

// ---------- main ----------
const testFlight = async () => {
  // Basic sanity
  const me = account.address as Address;
  console.log("wallet:", me);

  const chainId = await getChainId();
  console.log("connected chainId:", chainId);
  if (BigInt(chainId) !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain. Expected ${EXPECTED_CHAIN_ID}, got ${chainId}. Check RPC.`);
  }

  ensureAddress("fromToken", fromTokenAddress);
  ensureAddress("toToken", toTokenAddress);

  // Confirm token decimals match what we’re about to use (defensive)
  const onchainFromDecimals = await readDecimals(fromTokenAddress as Address);
  const onchainToDecimals = await readDecimals(toTokenAddress as Address);
  if (onchainFromDecimals !== null && onchainFromDecimals !== FROM_DECIMALS) {
    throw new Error(`FROM_DECIMALS mismatch. Config=${FROM_DECIMALS}, onchain=${onchainFromDecimals}`);
  }
  if (onchainToDecimals !== null && onchainToDecimals !== TO_DECIMALS) {
    throw new Error(`TO_DECIMALS mismatch. Config=${TO_DECIMALS}, onchain=${onchainToDecimals}`);
  }

  // Define amount (1 USDC with 6 decimals)
  const fromAmount = parseUnits("1", FROM_DECIMALS);

  // Check balance up front (avoids SafeERC20 sadness later)
  const bal = await publicClient.readContract({ address: fromTokenAddress as Address, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  console.log(`USDC balance: ${bal.toString()}`);
  if (bal < fromAmount) throw new Error(`Insufficient USDC. Need ${fromAmount}, have ${bal}.`);


  // Log native token balance before querying DODO route
  const nativeBal = await publicClient.getBalance({ address: me });
  console.log(`native balance: ${nativeBal.toString()} wei (~${formatEther(nativeBal)})`);

  // Ask DODO for route
  const params = {
    fromTokenAddress,
    fromTokenDecimals: FROM_DECIMALS,
    toTokenAddress,
    toTokenDecimals: TO_DECIMALS,
    fromAmount,
    slippage: 10,               // 1%
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
  console.log("route response:", routeObj);
  // Defensive validations on route
  ensureAddress("route.to (router)", routeObj.to);
  const spender = routeObj.targetApproveAddr && isAddress(routeObj.targetApproveAddr)
    ? getAddress(routeObj.targetApproveAddr)
    : getAddress(routeObj.to); // fallback if API omits approver

  // If ERC20 swap, routeObj.value should be 0 or undefined
  if (routeObj.value && BigInt(routeObj.value) !== 0n) {
    throw new Error(`Unexpected non-zero value for ERC20 swap: ${routeObj.value}`);
  }

  const calls: Call[] = [];

  // optional approve step (ERC20 path)
  if (fromTokenAddress && fromAmount && FROM_DECIMALS != null) {
    const tokenAmount = fromAmount;
    calls.push({
      to: fromTokenAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender ?? routeObj.to, tokenAmount],
      }),
    });
  }

  // swap execution from your API
  calls.push({
    to: routeObj.to,
    value: BigInt(routeObj.value ?? '0'),
    data: routeObj.data,
  });

  // const recentBlock = await sdkGetRecentBlock(publicClient as any);
  const recentBlock = 23437163n; // update to recent when running later

  // chain batches + digest
  const chainBatches = hashChainBatches([{ chainId: Number(chainId), calls, recentBlock }]);
  const digest = sdkGetAuthorizationHash(chainBatches as any);

  const acctNonce = await publicClient.getTransactionCount({ address: me, blockTag: 'pending' });
  const nonces = [acctNonce, acctNonce + 1];


  const delegateContractAddress = ensureAddress("delegate", process.env.DELEGATE_CONTRACT as string) as `0x${string}`;

  const signedAuths = await Promise.all(
    nonces.map(n =>
      walletClient.signAuthorization({
        account,
        chainId: Number(chainId),
        contractAddress: delegateContractAddress,
        nonce: Number(n),
      })
    )
  );




  const authorization: Authorization[] = signedAuths.map(a => ({
    address: a.address as `0x${string}`,
    chainId: Number(a.chainId),
    nonce: Number(a.nonce),
    r: a.r as `0x${string}`,
    s: a.s as `0x${string}`,
    yParity: Number((a as any).yParity ?? (a as any).v % 2n),
  }));

  const signature = await walletClient.signMessage({ account, message: { raw: digest } });

  const tokenAddress = (fromTokenAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
  const tokenAmount = fromTokenAddress && fromAmount && FROM_DECIMALS != null ? fromAmount : 0n;

  // log curl command before sending
  console.log(`curl -X POST ${txApiUrl}/transaction/submit -H "Content-Type: application/json" -d '${JSON.stringify({
    tokenAddress,
    tokenAmount,
    address: me,
    authorization,
    intentAuthorization: { signature, chainBatches },
  }, (k, v) => typeof v === 'bigint' ? v.toString() : v)}'`);

  const res = await submitTransaction(txApiUrl, {
    tokenAddress,
    tokenAmount,
    address: me,
    authorization,
    intentAuthorization: { signature, chainBatches },
  })

  console.log("intent submitted:", res);

  // Poll step 0 until terminal status
  const { intentId } = res;
  const { start, stop } = pollIntentStep(intentId, {
    stepId: 0,
    intervalMs: 4000,
    timeoutMs: 120_000,
    onUpdate: (s) => {
      console.log('intent step status update:', s);
    }
  });
  try {
    const final = await start();
    if (final.data.status === 'success') {
      console.log('Step 0 succeeded, tx:', final.data.transactionHash);
    } else {
      console.warn('Step 0 failed/reverted, tx:', final.data.transactionHash);
    }
  } catch (e) {
    console.error('Polling error', e);
  } finally {
    stop();
  }

  // // Approve if needed
  // await approveIfNeeded(fromTokenAddress, me, spender, BigInt(fromAmount));

  // // Preflight simulate (surfacing SafeERC20 issues before gas est.)
  // const pre = await preflightCall({
  //   from: me,
  //   to: routeObj.to,
  //   data: routeObj.data,
  //   value: routeObj.value || 0,
  // });
  // if (!pre.ok) {
  //   throw new Error("Preflight simulation reverted. Check allowance, balances, path liquidity and amounts.");
  // }

  // // Gas estimate
  // let gasLimit;
  // try {
  //   gasLimit = await wallet.estimateGas({
  //     to: routeObj.to,
  //     data: routeObj.data,
  //     value: routeObj.value || 0,
  //   });
  // } catch (e) {
  //   console.error("estimateGas failed:", e);
  //   throw e;
  // }
  // console.log("gasLimit =>", gasLimit.toString());

  // const feeData = await rpcProvider.getFeeData();
  // console.log("feeData =>", feeData);

  // const nonce = await wallet.getNonce();
  // console.log("nonce =>", nonce);

  // if (typeof routeObj.data !== "string" || !routeObj.data.startsWith("0x")) {
  //   throw new Error("Invalid route data (expected 0x-prefixed hex string)");
  // }
  // console.log("route data length:", routeObj.data.length);

  // // Build tx with bigint types
  // const tx = {
  //   to: routeObj.to,
  //   data: routeObj.data,
  //   value: BigInt(routeObj.value || 0),
  //   nonce,
  //   gasLimit: gasLimit,
  //   ...(feeData.maxFeePerGas && feeData.maxPriorityFeePerGas
  //     ? {
  //       maxFeePerGas: feeData.maxFeePerGas,
  //       maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  //     }
  //     : { gasPrice: feeData.gasPrice }),
  // };

  // // One more light ping (optional): ensure to != token address
  // if (ethers.getAddress(tx.to) === ethers.getAddress(fromTokenAddress)) {
  //   throw new Error("Router address equals token address — routing response looks wrong.");
  // }

  // // Send tx
  // const result = await wallet.sendTransaction(tx);
  // console.log("txHash =>", result.hash);
  // console.log(`(Pharos explorer) Check your tx: ${result.hash}`);

  // const rec = await result.wait();
  // console.log("✓ Swap confirmed in block", rec.blockNumber);
};

testFlight()
  .then(() => console.log("Swap Done."))
  .catch((e) => {
    console.error("Swap failed:", e?.shortMessage || e?.message || e);
  });
