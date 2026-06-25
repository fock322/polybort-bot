// ─── Polymarket CLOB Client v2 ────────────────────────────────
// Live trading client for Polymarket BTC 15-min Up/Down markets
//
// Authentication flow:
//   L1: Private key → EIP-712 sign ClobAuth → API credentials
//   L2: API key + HMAC-SHA256 → trading endpoints
//
// Order signing:
//   EIP-712 typed data → signed order → POST /order
//   BUY:  makerAmount = price × size (USDC), takerAmount = size (shares)
//   SELL: makerAmount = size (shares),       takerAmount = price × size (USDC)
//
// neg_risk markets (BTC 15-min):
//   Use NEG_RISK_EXCHANGE_V2 as verifyingContract in EIP-712 domain
//
// Dependencies: viem (EIP-712 signing), crypto (HMAC-SHA256)
// Chain: Polygon (137)

import { createWalletClient, http, type WalletClient, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { createHmac, randomBytes } from "crypto";

// ─── Constants ────────────────────────────────────────────
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

// EIP-712 Domain for ClobAuth (L1 authentication)
const CLOB_AUTH_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: CHAIN_ID,
} as const;

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

// EIP-712 Domain for Order signing
// CTF Exchange V2 (normal markets)
const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B" as `0x${string}`;
// Neg Risk Exchange V2 (BTC 15-min and other binary combo markets)
const NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59" as `0x${string}`;

function getOrderDomain(negRisk: boolean) {
  return {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: CHAIN_ID,
    verifyingContract: negRisk ? NEG_RISK_EXCHANGE_V2 : CTF_EXCHANGE_V2,
  } as const;
}

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

// ─── Types ────────────────────────────────────────────────
export interface ApiCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export interface ClobOrder {
  tokenID: string;
  price: number;       // 0.01–0.99 tick-rounded
  size: number;        // number of shares
  side: "BUY" | "SELL";
  negRisk?: boolean;   // true for BTC 15-min markets
  feeRateBps?: number;
  expiration?: number; // unix timestamp, 0 = GTC
}

export interface SignedOrder {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: number;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  signatureType: number;
  signature: string;
}

export interface OrderResult {
  orderID: string;
  status: string;
  error?: string;
}

export interface BalanceInfo {
  balance: number;
  allowance: number;
  symbol: string;
}

export interface ClobTrade {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
  match_time: number;
  fee_rate_bps: string;
}

export interface ClobOpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  remaining_size: string;
  price: string;
  status: string;
}

export interface ClobClientConfig {
  privateKey: `0x${string}`;
  funderAddress?: `0x${string}`;    // Deposit wallet address (for POLY_1271)
  signatureType?: 0 | 1 | 2 | 3;   // Default: 0 (EOA)
  clobHost?: string;
}

// ─── CLOB Client ──────────────────────────────────────────
// BUG FIX (2026-06-25): используем official @polymarket/clob-client-v2 (не v1!).
// V1 выдаёт "invalid order version" — устарел. V2 работает с текущим CLOB API.
import { ClobClient as OfficialClobClient } from "@polymarket/clob-client-v2";

export class ClobClient {
  private account: LocalAccount;
  private walletClient: WalletClient;
  private signerAddress: `0x${string}`;
  private funderAddress: `0x${string}`;
  private signatureType: 0 | 1 | 2 | 3;
  private host: string;
  private creds: ApiCredentials | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _lastError: string | null = null;
  private official: any = null;  // Official @polymarket/clob-client instance

  constructor(config: ClobClientConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.walletClient = createWalletClient({
      account: this.account,
      transport: http(),
      chain: polygon,
    });
    this.signerAddress = this.account.address;
    this.funderAddress = config.funderAddress ?? this.account.address;
    this.signatureType = config.signatureType ?? 0;
    this.host = config.clobHost ?? CLOB_HOST;
  }

  // ─── Connection Status ────────────────────────────────
  get connected(): boolean { return this._connected; }
  get lastError(): string | null { return this._lastError; }
  get address(): string { return this.signerAddress; }

  // ─── L1 Authentication ────────────────────────────────
  private async signL1Auth(
    timestamp: string,
    nonce: bigint = 0n,
    message: string = "This message attests that I control the given wallet"
  ): Promise<string> {
    const signature = await this.walletClient.signTypedData({
      account: this.account,
      domain: CLOB_AUTH_DOMAIN,
      types: CLOB_AUTH_TYPES,
      primaryType: "ClobAuth",
      message: {
        address: this.signerAddress,
        timestamp,
        nonce,
        message,
      },
    });
    return signature;
  }

  private l1Headers(sig: string, timestamp: string, nonce: string = "0"): Record<string, string> {
    return {
      "POLY_ADDRESS": this.signerAddress,
      "POLY_SIGNATURE": sig,
      "POLY_TIMESTAMP": timestamp,
      "POLY_NONCE": nonce,
    };
  }

  // ─── L2 Authentication ────────────────────────────────
  private l2Headers(method: string, requestPath: string, body?: string): Record<string, string> {
    if (!this.creds) throw new Error("API credentials not initialized. Call init() first.");

    const timestamp = Math.floor(Date.now() / 1000).toString();
    // HMAC message = timestamp + method + requestPath [+ body]
    let message = timestamp + method + requestPath;
    if (body && body.length > 0) message += body;

    // Decode base64 secret (URL-safe → standard)
    const secretBuf = Buffer.from(
      this.creds.secret.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    );

    // BUG FIX (2026-06-25): Polymarket expects base64url signature, not hex!
    // Official client: buildPolyHmacSignature returns base64url.
    const sigBytes = createHmac("sha256", secretBuf).update(message).digest();
    // Convert to base64, then to base64url (+ → -, / → _, keep =)
    const sigBase64 = sigBytes.toString("base64");
    const sigBase64Url = sigBase64.replace(/\+/g, "-").replace(/\//g, "_");

    return {
      "POLY_ADDRESS": this.signerAddress,
      "POLY_SIGNATURE": sigBase64Url,
      "POLY_TIMESTAMP": timestamp,
      "POLY_API_KEY": (this.creds as any).key ?? this.creds.apiKey,  // field is "key" in CLOB response
      "POLY_PASSPHRASE": this.creds.passphrase,
    };
  }

  // ─── Initialize: Derive API Credentials ───────────────
  async init(): Promise<void> {
    try {
      // BUG FIX (2026-06-25): clob-client-v2 использует options object constructor
      this.official = new OfficialClobClient({
        host: this.host,
        chain: 137,
        signer: this.walletClient,
        signatureType: this.signatureType,
        funderAddress: this.funderAddress,
      });

      const derived = await this.official.deriveApiKey();
      this.official.creds = derived;

      const apiKey = derived.key ?? derived.apiKey ?? "";
      const secret = derived.secret ?? "";
      const passphrase = derived.passphrase ?? "";

      this.creds = { apiKey, secret, passphrase };
      (this.creds as any).key = apiKey;

      this._connected = true;
      this._lastError = null;
      console.log(`[CLOB] Authenticated: ${this.signerAddress.slice(0, 10)}... (apiKey: ${apiKey.substring(0, 8)}...)`);
    } catch (err) {
      this._connected = false;
      this._lastError = String(err);
      console.error("[CLOB] Init failed:", err);
      throw err;
    }
  }

  // ─── Heartbeat ────────────────────────────────────────
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    // Send heartbeat every 15 seconds to keep API key alive
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.sendHeartbeat();
      } catch (err) {
        console.error("[CLOB] Heartbeat failed:", err);
      }
    }, 15000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    // BUG FIX (2026-06-25): delegate to official client (correct L2 auth)
    if (this.official) {
      await this.official.postHeartbeat();
      return;
    }
    // Fallback to our implementation (legacy)
    const headers = {
      ...this.l2Headers("POST", "/v1/heartbeats"),
      "Content-Type": "application/json",
    };

    const res = await fetch(`${this.host}/v1/heartbeats`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Heartbeat failed: ${res.status}`);
    }
  }

  // ─── Order Signing ────────────────────────────────────
  // CRITICAL: Amounts differ for BUY vs SELL:
  //   BUY:  makerAmount = price × size (USDC we provide), takerAmount = size (shares we receive)
  //   SELL: makerAmount = size (shares we provide),       takerAmount = price × size (USDC we receive)
  //
  // All amounts are in 6-decimal units (1 USDC = 1_000_000, 1 share = 1_000_000)
  private async signOrder(order: ClobOrder): Promise<SignedOrder> {
    const saltBigInt = BigInt("0x" + randomBytes(32).toString("hex"));
    const timestampBigInt = BigInt(Math.floor(Date.now() / 1000));

    const sideNum = order.side === "BUY" ? 0 : 1;
    const feeRateBps = (order.feeRateBps ?? 0).toString();
    const expiration = (order.expiration ?? 0).toString();

    // ── CRITICAL FIX: Different amounts for BUY vs SELL ──
    let makerAmount: bigint;
    let takerAmount: bigint;

    if (order.side === "BUY") {
      // BUY: we provide USDC (makerAmount), receive shares (takerAmount)
      makerAmount = BigInt(Math.round(order.price * order.size * 1_000_000));
      takerAmount = BigInt(Math.round(order.size * 1_000_000));
    } else {
      // SELL: we provide shares (makerAmount), receive USDC (takerAmount)
      makerAmount = BigInt(Math.round(order.size * 1_000_000));
      takerAmount = BigInt(Math.round(order.price * order.size * 1_000_000));
    }

    // Determine verifying contract based on neg_risk
    const negRisk = order.negRisk ?? false;
    const domain = getOrderDomain(negRisk);

    const orderMessage = {
      salt: saltBigInt,
      maker: this.funderAddress,
      signer: this.signerAddress,
      tokenId: BigInt(order.tokenID),
      makerAmount,
      takerAmount,
      side: sideNum,
      signatureType: this.signatureType as number,
      timestamp: timestampBigInt,
      metadata: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
      builder: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    };

    // Sign with EIP-712
    const signature = await this.walletClient.signTypedData({
      account: this.account,
      domain,
      types: ORDER_TYPES,
      primaryType: "Order",
      message: orderMessage,
    });

    return {
      salt: saltBigInt.toString(),
      maker: this.funderAddress,
      signer: this.signerAddress,
      taker: "0x0000000000000000000000000000000000000000",
      tokenId: BigInt(order.tokenID).toString(),
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      side: sideNum,
      expiration,
      nonce: "0",
      feeRateBps,
      signatureType: this.signatureType,
      signature,
    };
  }

  // ─── Submit Order ─────────────────────────────────────
  async submitOrder(
    order: ClobOrder,
    orderType: "GTC" | "GTD" | "FOK" = "GTC",
    postOnly = false
  ): Promise<OrderResult> {
    try {
      if (!this._connected) {
        return { orderID: "", status: "error", error: "CLOB not connected" };
      }

      // BUG FIX (2026-06-25): delegate to official clob-client-v2
      // V1 generated "invalid order version" — V2 works correctly
      if (this.official) {
        const result = await this.official.createAndPostOrder({
          tokenID: order.tokenID,
          price: order.price,
          size: order.size,
          side: order.side,
          feeRateBps: order.feeRateBps ?? 0,
        }, orderType);

        if (result.success === false || result.errorMsg) {
          const errMsg = result.errorMsg || JSON.stringify(result);
          console.error(`[CLOB] Order rejected: ${errMsg}`);
          return { orderID: "", status: "rejected", error: errMsg };
        }

        const orderID = result.orderID ?? "";
        const status = result.status ?? "live";
        console.log(
          `[CLOB] Order ${order.side} ${order.size}@${order.price} ` +
          `tokenId=${order.tokenID.slice(0, 12)}... → ${orderID.slice(0, 12)}... ` +
          `status=${status}`
        );
        return { orderID, status };
      }

      // Fallback: legacy signOrder + fetch (should not reach here)
      const signedOrder = await this.signOrder(order);
      const body = JSON.stringify({
        order: signedOrder,
        owner: this.signerAddress,
        orderType,
        postOnly,
      });

      const headers = {
        ...this.l2Headers("POST", "/order", body),
        "Content-Type": "application/json",
      };

      const res = await fetch(`${this.host}/order`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data.message ?? data.error ?? JSON.stringify(data);
        console.error(`[CLOB] Order rejected (${res.status}): ${errMsg}`);
        return { orderID: "", status: "rejected", error: errMsg };
      }

      const orderID = data.orderID ?? data.id ?? "";
      const status = data.status ?? "submitted";
      return { orderID, status };
    } catch (err) {
      return { orderID: "", status: "error", error: String(err) };
    }
  }

  // ─── Cancel Order ─────────────────────────────────────
  // Correct endpoint: DELETE /order/{orderID}
  async cancelOrder(orderID: string): Promise<boolean> {
    try {
      if (!this._connected) return false;

      const requestPath = `/order/${orderID}`;
      const headers = {
        ...this.l2Headers("DELETE", requestPath),
        "Content-Type": "application/json",
      };

      const res = await fetch(`${this.host}${requestPath}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        console.warn(`[CLOB] Cancel failed (${res.status}) for order ${orderID.slice(0, 12)}...`);
      }
      return res.ok;
    } catch (err) {
      console.error("[CLOB] Cancel error:", err);
      return false;
    }
  }

  // ─── Cancel All Orders ────────────────────────────────
  async cancelAllOrders(): Promise<boolean> {
    try {
      if (!this._connected) return false;

      const headers = {
        ...this.l2Headers("DELETE", "/cancel-all"),
        "Content-Type": "application/json",
      };

      const res = await fetch(`${this.host}/cancel-all`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        console.log("[CLOB] All orders cancelled");
      }
      return res.ok;
    } catch (err) {
      console.error("[CLOB] Cancel-all error:", err);
      return false;
    }
  }

  // ─── Cancel Orders by Market ──────────────────────────
  async cancelMarketOrders(conditionId: string): Promise<boolean> {
    try {
      if (!this._connected) return false;

      const body = JSON.stringify({ condition_id: conditionId });
      const headers = {
        ...this.l2Headers("DELETE", "/cancel-market-orders", body),
        "Content-Type": "application/json",
      };

      const res = await fetch(`${this.host}/cancel-market-orders`, {
        method: "DELETE",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      return res.ok;
    } catch {
      return false;
    }
  }

  // ─── Get Open Orders ──────────────────────────────────
  async getOpenOrders(): Promise<ClobOpenOrder[]> {
    try {
      if (!this._connected) return [];

      const headers = {
        ...this.l2Headers("GET", "/data/orders"),
      };

      const res = await fetch(`${this.host}/data/orders`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  // ─── Get Trades (Fill History) ────────────────────────
  async getTrades(): Promise<ClobTrade[]> {
    try {
      if (!this._connected) return [];

      const headers = {
        ...this.l2Headers("GET", "/data/trades"),
      };

      const res = await fetch(`${this.host}/data/trades`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  // ─── Get Balance ──────────────────────────────────────
  async getBalance(): Promise<BalanceInfo> {
    try {
      if (!this._connected || !this.official) return { balance: 0, allowance: 0, symbol: "USDC" };

      // BUG FIX (2026-06-25): delegate to official client (correct L2 auth)
      const result = await this.official.getBalanceAllowance({ asset_type: "COLLATERAL" });
      const balance = parseFloat(result.balance ?? "0") / 1e6;  // USDC has 6 decimals
      const allowances = result.allowances ?? {};
      // Take max allowance across exchanges
      const maxAllowance = Math.max(...Object.values(allowances).map((v: any) => parseFloat(v ?? "0") / 1e6));
      return {
        balance,
        allowance: maxAllowance,
        symbol: "USDC",
      };
    } catch {
      return { balance: 0, allowance: 0, symbol: "USDC" };
    }
  }

  // ─── Get Server Time ──────────────────────────────────
  async getServerTime(): Promise<number> {
    try {
      const res = await fetch(`${this.host}/time`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      return data.timestamp ?? 0;
    } catch {
      return 0;
    }
  }

  // ─── Re-authenticate ──────────────────────────────────
  async reauth(): Promise<boolean> {
    try {
      this._connected = false;
      this.creds = null;
      await this.init();
      return this._connected;
    } catch {
      return false;
    }
  }

  // ─── Disconnect ───────────────────────────────────────
  disconnect(): void {
    this.stopHeartbeat();
    this._connected = false;
    this.creds = null;
    console.log("[CLOB] Disconnected");
  }
}

// ─── Singleton ────────────────────────────────────────────
let clientInstance: ClobClient | null = null;

export function getClobClient(): ClobClient | null {
  return clientInstance;
}

export function initClobClient(config: ClobClientConfig): ClobClient {
  clientInstance = new ClobClient(config);
  return clientInstance;
}

export function destroyClobClient(): void {
  if (clientInstance) {
    clientInstance.disconnect();
    clientInstance = null;
  }
}
