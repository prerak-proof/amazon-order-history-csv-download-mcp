#!/usr/bin/env node

/**
 * Amazon Order History CSV Download MCP Server
 *
 * MCP server for extracting Amazon order history and exporting to CSV.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolRequest,
  ListToolsRequestSchema,
  Tool,
  ProgressNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, BrowserContext, Page } from "playwright";
import { z } from "zod";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import packageMetadata from "../package.json";

import { AmazonPlugin } from "./amazon/adapter";
import { getRegionByCode, getRegionCodes } from "./amazon/regions";
import {
  fetchOrders,
  exportOrdersCSV,
  exportItemsCSV,
  exportShipmentsCSV,
  exportTransactionsCSV,
  exportGiftCardTransactionsCSV,
  getOutputPath,
  estimateExtractionTime,
  GiftCardTransactionCSVData,
  downloadAmazonInvoice,
  isValidAmazonOrderId,
} from "./tools";
import { extractTransactionsFromPage, newWalkDiagnostics, getTransactionsPageUrl } from "./amazon/extractors/transactions-page";
import { extractOrderCardTexts } from "./amazon/extractors/order-list";
import { getInvoiceUrl } from "./amazon/extractors/invoice";
import {
  extractGiftCardData,
  GiftCardData,
} from "./amazon/extractors/gift-card";

// Initialize the Amazon plugin
const amazonPlugin = new AmazonPlugin();

// Browser context instance (lazy initialized)
let browserContext: BrowserContext | null = null;
let page: Page | null = null;
let browserClosing: Promise<void> | null = null;
let browserIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeBrowserRequests = 0;
const browserIdleTimeoutSetting = z.coerce.number().int().min(0).max(2147483647)
  .safeParse(process.env.AMAZON_BROWSER_IDLE_TIMEOUT_MS ?? "300000");
if (!browserIdleTimeoutSetting.success) {
  throw new Error(
    "AMAZON_BROWSER_IDLE_TIMEOUT_MS must be an integer between 0 and 2147483647 (0 disables idle closing)",
  );
}
const browserIdleTimeoutMs = browserIdleTimeoutSetting.data;

function clearBrowserIdleTimer(): void {
  if (browserIdleTimer !== null) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

function scheduleBrowserIdleClose(): void {
  clearBrowserIdleTimer();
  if (
    browserIdleTimeoutMs === 0 || activeBrowserRequests > 0 ||
    !browserContext || browserClosing
  ) return;

  const context = browserContext;
  browserIdleTimer = setTimeout(() => {
    browserIdleTimer = null;
    if (activeBrowserRequests > 0 || browserContext !== context) return;
    // Publish the closing promise before calling close, so new requests wait
    // until Chromium releases the persistent profile before reopening it.
    browserClosing = Promise.resolve()
      .then(() => context.close())
      .then(() => {
        if (browserContext === context) {
          browserContext = null;
          page = null;
        }
        console.error("[browser] Closed Chromium after " + browserIdleTimeoutMs + " ms idle");
      })
      .catch((error) => {
        console.error("[browser] Idle close failed:", error);
      })
      .finally(() => {
        browserClosing = null;
        // Retry later if closing failed and the context is still open.
        scheduleBrowserIdleClose();
      });
  }, browserIdleTimeoutMs);
  browserIdleTimer.unref();
}

// Browser data directory for session persistence.
// Env var AMAZON_ORDERS_BROWSER_DATA_DIR overrides — required for multi-tenant
// deployments (e.g. separate Personal vs Business Amazon accounts running as
// two instances of this MCP, each with its own persistent Chromium profile).
const BROWSER_DATA_DIR =
  process.env.AMAZON_ORDERS_BROWSER_DATA_DIR ??
  join(homedir(), ".amazon-order-history-mcp", "browser-data");

/**
 * Get or create browser context instance.
 */
async function getBrowserContext(): Promise<BrowserContext> {
  if (!browserContext) {
    const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      channel: process.env.AMAZON_BROWSER_CHANNEL ?? "chromium",
      headless:
        (process.env.AMAZON_BROWSER_HEADLESS ?? "true").toLowerCase() ===
        "true",
      viewport: { width: 1280, height: 800 },
    });
    browserContext = context;
    // If the browser dies (crash, user closes the window, killed externally),
    // drop the stale handle so the next tool call relaunches instead of
    // failing forever with "browser has been closed"
    context.on("close", () => {
      if (browserContext === context) {
        browserContext = null;
        page = null;
      }
    });
  }
  return browserContext;
}

/**
 * Get or create page instance.
 */
async function getPage(): Promise<Page> {
  try {
    const context = await getBrowserContext();
    if (!page || page.isClosed()) {
      const pages = context.pages();
      page = pages[0] || (await context.newPage());
    }
    return page;
  } catch (e) {
    // Stale context (browser died without firing 'close') - relaunch once
    console.error(`[browser] Relaunching after error: ${e}`);
    browserContext = null;
    page = null;
    const context = await getBrowserContext();
    page = context.pages()[0] || (await context.newPage());
    return page;
  }
}

/**
 * Validate region parameter and return error response if invalid.
 */
function validateRegion(
  region: string | undefined,
  args: Record<string, unknown> | undefined,
): { content: Array<{ type: string; text: string }>; isError: true } | null {
  if (!region) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "region parameter is required",
              validRegions: getRegionCodes(),
              receivedArgs: args,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  if (!getRegionCodes().includes(region)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: `Invalid region: "${region}"`,
              validRegions: getRegionCodes(),
              receivedArgs: args,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  return null; // Valid region
}

// Define MCP tools
const tools: Tool[] = [
  {
    name: "get_amazon_orders",
    description:
      "Fetch Amazon order history for a specified date range or year. Returns order summaries including: order ID, date, total amount, status, item count, item titles and quantities (product names and purchase quantities shown on the order card), shipping address (7 lines), payment method, and Subscribe & Save frequency. Optionally includes detailed item data (ASIN, name, price, quantity, seller, condition) and shipment tracking. Use for browsing order history or building reports.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: `Amazon region code. Supported: ${getRegionCodes().join(", ")}`,
          enum: getRegionCodes(),
        },
        year: {
          type: "number",
          description:
            "Year to fetch orders from (e.g., 2024). If omitted, uses current year.",
        },
        start_date: {
          type: "string",
          description:
            "Start date in ISO format (YYYY-MM-DD). Overrides year if provided.",
        },
        end_date: {
          type: "string",
          description:
            "End date in ISO format (YYYY-MM-DD). Overrides year if provided.",
        },
        include_items: {
          type: "boolean",
          description:
            "Extract item details (ASIN, name, price, quantity, seller, condition) from each order's invoice page. Adds ~2s per order.",
          default: false,
        },
        include_shipments: {
          type: "boolean",
          description:
            "Extract shipment info (delivery status, tracking link) from each order's detail page. Adds ~2s per order. Note: tracking link URL is captured but not the carrier tracking number - use fetch_tracking_numbers for that.",
          default: false,
        },
        fetch_tracking_numbers: {
          type: "boolean",
          description:
            "Extract actual carrier tracking numbers (e.g., AZ218181365JE) by visiting each shipment's 'Track package' page. Adds ~2s per shipment. Only works when include_shipments is true.",
          default: false,
        },
        max_orders: {
          type: "number",
          description:
            "Maximum number of orders to fetch. Use to limit results for large accounts or avoid timeouts.",
        },
      },
      required: ["region"],
    },
  },
  {
    name: "get_amazon_order_details",
    description:
      "Get comprehensive details for a specific Amazon order by order ID. Returns full order data including: items (ASIN, name, price, quantity, seller, condition), financial breakdown (subtotal, shipping, tax, VAT, promotions, total), shipping address, payment methods, and optionally shipment tracking and transaction history.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: {
          type: "string",
          description:
            "Amazon order ID in format XXX-XXXXXXX-XXXXXXX (e.g., 123-4567890-1234567)",
        },
        region: {
          type: "string",
          description: "Amazon region code where the order was placed",
          enum: getRegionCodes(),
        },
        include_shipments: {
          type: "boolean",
          description:
            "Extract shipment info from order detail page (default: true)",
          default: true,
        },
        fetch_tracking_numbers: {
          type: "boolean",
          description:
            "Extract actual carrier tracking number (e.g., AZ218181365JE) by visiting the 'Track package' page. Adds ~2s per shipment.",
          default: false,
        },
        include_transactions: {
          type: "boolean",
          description: "Include payment transaction details (default: false)",
          default: false,
        },
      },
      required: ["order_id", "region"],
    },
  },
  {
    name: "download_amazon_invoice",
    description:
      "Download a verified Amazon order invoice as an A4 PDF. The requested order ID must match invoice-specific content before a PDF is saved.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: {
          type: "string",
          description:
            "Amazon order ID in format XXX-XXXXXXX-XXXXXXX (e.g., 123-4567890-1234567)",
        },
        region: {
          type: "string",
          description: "Amazon region code where the order was placed",
          enum: getRegionCodes(),
        },
        output_path: {
          type: "string",
          description:
            "Optional absolute destination path. Defaults to ~/Downloads/amazon-{region}-invoice-{order_id}.pdf",
        },
      },
      required: ["order_id", "region"],
    },
  },
  {
    name: "export_amazon_orders_csv",
    description:
      "Export Amazon orders summary to CSV file. Fast extraction from order list page (~0.5s per 10 orders). CSV columns: Order ID, Date, Total, Status, Item Count, Address (7 lines), Subscribe & Save, Platform, Region, Order URL. Defaults to ~/Downloads with auto-generated filename. For large accounts (500+ orders), use max_orders to batch exports and avoid timeouts.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        year: {
          type: "number",
          description: "Year to export (defaults to current year)",
        },
        start_date: {
          type: "string",
          description: "Start date in ISO format (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date in ISO format (YYYY-MM-DD)",
        },
        output_path: {
          type: "string",
          description:
            "Full path to save CSV file. Defaults to ~/Downloads/amazon-{region}-orders-{year}-{date}.csv",
        },
        max_orders: {
          type: "number",
          description:
            "Maximum number of orders to export. Recommended: 100-200 per batch for large accounts.",
        },
      },
      required: ["region"],
    },
  },
  {
    name: "export_amazon_items_csv",
    description:
      "Export detailed Amazon order items to CSV file. Visits each order's invoice page to extract item-level data (~2s/order). CSV columns: Order ID, Date, ASIN, Product Name, Condition, Quantity, Unit Price, Item Total, Seller, Subscribe & Save, Order financials (Subtotal, Shipping, Tax, VAT, Promotion, Total), Status, Address (7 lines), Payment Method, Product URL, Order URL, Region. Ideal for expense tracking, inventory analysis, or accounting exports.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        year: {
          type: "number",
          description: "Year to export (defaults to current year)",
        },
        start_date: {
          type: "string",
          description: "Start date in ISO format (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date in ISO format (YYYY-MM-DD)",
        },
        output_path: {
          type: "string",
          description:
            "Full path to save CSV file. Defaults to ~/Downloads/amazon-{region}-items-{year}-{date}.csv",
        },
        max_orders: {
          type: "number",
          description:
            "Maximum number of orders to process. Recommended: 50-100 per batch due to ~2s/order extraction time.",
        },
      },
      required: ["region"],
    },
  },
  {
    name: "export_amazon_shipments_csv",
    description:
      "Export Amazon shipment tracking data to CSV file. Visits each order's detail page to extract tracking info (~4s/order). CSV columns: Order ID, Date, Shipment ID, Status, Delivered (Yes/No/Unknown), Tracking ID, Tracking URL, Items in Shipment, Item Names, Payment Amount, Refund. Useful for tracking deliveries and reconciling shipments.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        year: {
          type: "number",
          description: "Year to export (defaults to current year)",
        },
        start_date: {
          type: "string",
          description: "Start date in ISO format (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date in ISO format (YYYY-MM-DD)",
        },
        output_path: {
          type: "string",
          description:
            "Full path to save CSV file. Defaults to ~/Downloads/amazon-{region}-shipments-{year}-{date}.csv",
        },
        max_orders: {
          type: "number",
          description:
            "Maximum number of orders to process. Recommended: 25-50 per batch due to ~4s/order extraction time.",
        },
        fetch_tracking_numbers: {
          type: "boolean",
          description:
            "Extract actual carrier tracking numbers (e.g., AZ218181365JE) by visiting each shipment's 'Track package' page. Adds ~2s per shipment.",
          default: false,
        },
      },
      required: ["region"],
    },
  },
  {
    name: "export_amazon_transactions_csv",
    description:
      "Export Amazon payment transactions to CSV file. Extracts transaction data from each order's detail page. CSV columns include: date, order ID, amount, payment method, card info. For faster bulk transaction export, consider get_amazon_transactions which scrapes the dedicated transactions page.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        year: {
          type: "number",
          description: "Year to export (defaults to current year)",
        },
        start_date: {
          type: "string",
          description: "Start date in ISO format (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date in ISO format (YYYY-MM-DD)",
        },
        output_path: {
          type: "string",
          description:
            "Full path to save CSV file. Defaults to ~/Downloads/amazon-{region}-transactions-{year}-{date}.csv",
        },
        max_orders: {
          type: "number",
          description: "Maximum number of orders to process",
        },
      },
      required: ["region"],
    },
  },
  {
    name: "get_amazon_transactions",
    description:
      "Fetch all Amazon payment transactions from the dedicated transactions page. Faster than per-order extraction and supports both paginated and legacy infinite-scroll layouts. Returns: date, order IDs, amount, payment method, card info (last 4 digits), vendor. Useful for reconciling payments, tracking spending, or exporting for accounting.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        start_date: {
          type: "string",
          description: "Start date filter in ISO format (YYYY-MM-DD)",
        },
        end_date: {
          type: "string",
          description: "End date filter in ISO format (YYYY-MM-DD)",
        },
        max_scrolls: {
          type: "number",
          description:
            "Maximum page or scroll advances used to load transactions. Default: 50. Increase for longer history.",
        },
      },
      required: ["region"],
    },
  },
  {
    name: "get_amazon_gift_card_balance",
    description:
      "Get current Amazon gift card balance and transaction history. Returns: current balance, last updated timestamp, and paginated transaction history (date, description, amount, closing balance, type, associated order ID, claim code, serial number). Supports fetching complete history across multiple pages.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        max_pages: {
          type: "number",
          description:
            "Maximum pages of transaction history to fetch. Default: 10. Set to 0 for unlimited.",
          default: 10,
        },
        fetch_all_pages: {
          type: "boolean",
          description:
            "Automatically paginate through all available transaction history. Default: true.",
          default: true,
        },
      },
      required: ["region"],
    },
  },
  {
    name: "export_amazon_gift_cards_csv",
    description:
      "Export Amazon gift card transaction history to CSV file. CSV columns: Date, Description, Amount, Closing Balance, Type (credit/debit), Order ID, Claim Code, Serial Number, Region. Useful for tracking gift card usage and reconciling balances.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        output_path: {
          type: "string",
          description:
            "Full path to save CSV file. Defaults to ~/Downloads/amazon-{region}-gift-cards-{date}.csv",
        },
        max_pages: {
          type: "number",
          description:
            "Maximum pages of transaction history to fetch. Default: 10. Set to 0 for unlimited.",
          default: 10,
        },
      },
      required: ["region"],
    },
  },
  {
    name: "get_amazon_gift_card_transactions",
    description:
      "Get Amazon gift card transaction history with full details. Returns: current balance, transaction count, and detailed transactions (date, description, amount, closing balance, transaction type, order ID, claim code, serial number). Supports pagination for complete history.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        max_pages: {
          type: "number",
          description:
            "Maximum pages of transaction history to fetch. Default: 10. Set to 0 for unlimited.",
          default: 10,
        },
      },
      required: ["region"],
    },
  },
  {
    name: "check_amazon_auth_status",
    description:
      "Check if the browser session is authenticated with Amazon for a specific region. Returns authentication status (authenticated/not authenticated), current URL, and any error messages. Use this to verify login status before running other tools, or to prompt user to log in if session expired.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code to check authentication for",
          enum: getRegionCodes(),
        },
      },
      required: ["region"],
    },
  },
  {
    name: "refresh_code",
    description:
      "Pull the latest MCP code from the configured repo/ref (AMAZON_MCP_REPO and AMAZON_MCP_REF, same as the container entrypoint uses) by running the entrypoint's own build step, then restart onto the new build. Only the configured repo/ref are ever fetched. Returns updated/already_current/error. Use after pushing new commits instead of asking for a container restart. The fetch plus TypeScript build can take a few minutes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "debug_order_cards",
    description:
      "Return the raw text of order cards on the order history page for debugging extraction against live layouts (e.g. finding Subscribe & Save markers). Returns each card's order ID when identifiable plus its full card text, truncated per card. Read-only: loads the order history page but changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        year: {
          type: "number",
          description:
            "Order history year to inspect (e.g., 2026). Defaults to the current year.",
        },
        max_cards: {
          type: "number",
          description:
            "Maximum number of cards to return (1-50). Defaults to 10.",
          default: 10,
        },
      },
      required: ["region"],
    },
  },
  {
    name: "debug_order_details",
    description:
      "Return DOM diagnostics for one order's detail page (and optionally its invoice print page) for debugging extraction against live layouts: selector counts for every shipment/item strategy, a census of data-component attributes, the raw text of each shipments container, and per-element visibility for the invoice page components the invoice download waits on. Read-only: loads the order pages but changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
        order_id: {
          type: "string",
          description: "Amazon order ID in format XXX-XXXXXXX-XXXXXXX",
        },
        include_invoice: {
          type: "boolean",
          description:
            "Also load the invoice print page and report component visibility there. Defaults to true.",
          default: true,
        },
      },
      required: ["region", "order_id"],
    },
  },
  {
    name: "debug_transactions_page",
    description:
      "Return DOM diagnostics for the payments transactions page for debugging the history walk against live layouts: counts of transaction rows and date headers, every ppw/pagination form field (names and disabled state only, never field values), next/previous/load-more controls, the scrollable-ancestor chain of the transaction list, and what follows the last row. Read-only: loads the transactions page but changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
      },
      required: ["region"],
    },
  },
  {
    name: "debug_transactions_source",
    description:
      "Return source-level intel for the payments transactions page for debugging the history walk: the page's script bundle URLs, the Next.js __NEXT_DATA__ bootstrap JSON, the app root's HTML skeleton, the scroll container's metrics and HTML head, and keyword windows from the JS bundles around pagination terms (continueWidget, nextPageKey, onEndReached, fetchMore, cursor). Read-only: loads the transactions page but changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
      },
      required: ["region"],
    },
  },
  {
    name: "debug_transactions_capture",
    description:
      "Capture the transactions app's own pagination network traffic: loads the transactions page with request/response listeners attached, waits for the app to hydrate, then stimulates scrolling (window and every scrollable ancestor of the transaction rows) for ~25s while recording xhr/fetch requests and responses. Returns the captured calls (method, URL, request body, response status and body head) so the next-chunk request can be replayed directly. Read-only apart from the scrolling itself.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Amazon region code",
          enum: getRegionCodes(),
        },
      },
      required: ["region"],
    },
  },
];

// Create server instance
const server = new Server(
  {
    name: "amazon-order-history-csv-download-mcp",
    version: packageMetadata.version,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

/**
 * Send progress notification to client.
 */
async function sendProgress(
  progressToken: string | number | undefined,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  if (!progressToken) return;

  try {
    await server.notification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        total,
        message,
      },
    } as unknown as ProgressNotification);
  } catch (e) {
    // Progress notifications are optional, don't fail on errors
    console.error(`[progress] Failed to send: ${e}`);
  }
}

/**
 * Shared gift card data structure for export.
 */
interface GiftCardExportData {
  balance: {
    amount: number;
    currency: string;
    formatted: string;
  };
  lastUpdated: string;
  region: string;
  transactionCount: number;
  transactions: Array<{
    date: string;
    description: string;
    amount: {
      amount: number;
      currency: string;
      currencySymbol: string;
      formatted: string;
    };
    closingBalance: {
      amount: number;
      currency: string;
      currencySymbol: string;
      formatted: string;
    };
    type: string;
    orderId?: string;
    claimCode?: string;
    serialNumber?: string;
  }>;
}

/**
 * Convert GiftCardData to export format (shared by CSV and JSON exports).
 */
function formatGiftCardDataForExport(
  giftCardData: GiftCardData,
): GiftCardExportData {
  return {
    balance: {
      amount: giftCardData.balance.balance.amount,
      currency: giftCardData.balance.balance.currency,
      formatted: giftCardData.balance.balance.formatted,
    },
    lastUpdated: giftCardData.balance.lastUpdated.toISOString(),
    region: giftCardData.region,
    transactionCount: giftCardData.transactions.length,
    transactions: giftCardData.transactions.map((t) => ({
      date: t.date.toISOString(),
      description: t.description,
      amount: {
        amount: t.amount.amount,
        currency: t.amount.currency,
        currencySymbol: t.amount.currencySymbol,
        formatted: t.amount.formatted,
      },
      closingBalance: {
        amount: t.closingBalance.amount,
        currency: t.closingBalance.currency,
        currencySymbol: t.closingBalance.currencySymbol,
        formatted: t.closingBalance.formatted,
      },
      type: t.type,
      orderId: t.orderId,
      claimCode: t.claimCode,
      serialNumber: t.serialNumber,
    })),
  };
}

/**
 * Convert GiftCardData to CSV export format.
 */
function formatGiftCardDataForCSV(
  giftCardData: GiftCardData,
): GiftCardTransactionCSVData[] {
  return giftCardData.transactions.map((t) => ({
    date: t.date,
    description: t.description,
    amount: t.amount,
    closingBalance: t.closingBalance,
    type: t.type,
    orderId: t.orderId,
    claimCode: t.claimCode,
    serialNumber: t.serialNumber,
    region: giftCardData.region,
  }));
}

async function handleInvoiceDownload(
  args: Record<string, unknown> | undefined,
) {
  const regionParam = args?.region as string | undefined;
  const regionError = validateRegion(regionParam, args);
  if (regionError) return regionError;
  const region = regionParam ?? "";
  const orderId = args?.order_id as string | undefined;
  const requestedOutputPath = args?.output_path as string | undefined;

  if (!orderId || !isValidAmazonOrderId(orderId)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            params: { orderId, region, outputPath: requestedOutputPath },
            error: "order_id must use the XXX-XXXXXXX-XXXXXXX Amazon format",
          }),
        },
      ],
      isError: true,
    };
  }

  const outputPath =
    requestedOutputPath ??
    join(homedir(), "Downloads", `amazon-${region}-invoice-${orderId}.pdf`);
  if (!isAbsolute(outputPath)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            params: { orderId, region, outputPath },
            error: "output_path must be an absolute path",
          }),
        },
      ],
      isError: true,
    };
  }

  const regionConfig = getRegionByCode(region);
  if (!regionConfig) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            params: { orderId, region, outputPath },
            error: `Invalid region: "${region}"`,
          }),
        },
      ],
      isError: true,
    };
  }

  const result = await downloadAmazonInvoice({
    page: await getPage(),
    orderId,
    domain: regionConfig.domain,
    outputPath,
  });
  const response = result.success
    ? {
        status: "success",
        params: { orderId, region, outputPath },
        path: result.filePath,
        bytes: result.bytes,
      }
    : {
        status: "error",
        params: { orderId, region, outputPath },
        error: result.error,
      };

  return {
    content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
    ...(result.success ? {} : { isError: true }),
  };
}

const execFileAsync = promisify(execFile);

/**
 * Pull the latest MCP code and rebuild by delegating to the container
 * entrypoint's --build flow (the same build start.sh runs on every
 * container start), so the build logic lives in exactly one place. Only the
 * repo/ref configured via AMAZON_MCP_REPO and AMAZON_MCP_REF are ever
 * fetched — the tool takes no repository arguments. On success the new build
 * is installed into /app and the process exits so the container restarts
 * onto the new code.
 */
async function refreshCode(): Promise<{
  status: "updated" | "already_current" | "error";
  old_commit?: string | null;
  new_commit?: string;
  detail: string;
}> {
  const startScript = "/opt/amazon-start.sh";
  if (!existsSync(startScript)) {
    return {
      status: "error",
      detail:
        "refresh_code requires the Synology container layout (/opt/amazon-start.sh not found)",
    };
  }

  let currentCommit = "";
  try {
    currentCommit = readFileSync("/app/UPSTREAM_COMMIT", "utf8").trim();
  } catch {
    // No record of the running commit; treat as needing update.
  }

  try {
    await execFileAsync("bash", [startScript, "--build"], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    return {
      status: "error",
      detail: `build failed: ${String(error).slice(0, 500)}`,
    };
  }

  let newCommit = "";
  try {
    newCommit = readFileSync("/app/UPSTREAM_COMMIT", "utf8").trim();
  } catch {
    return { status: "error", detail: "build succeeded but UPSTREAM_COMMIT is missing" };
  }
  if (currentCommit && newCommit === currentCommit) {
    return {
      status: "already_current",
      new_commit: currentCommit,
      detail: "Already running the latest commit",
    };
  }

  // Let the response flush, then exit so the container restarts onto the
  // new build (start.sh re-fetches, which is a no-op, and launches it).
  setTimeout(() => process.exit(0), 2000).unref();

  return {
    status: "updated",
    old_commit: currentCommit || null,
    new_commit: newCommit,
    detail: "New code installed; server is restarting to pick it up",
  };
}

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  activeBrowserRequests += 1;
  clearBrowserIdleTimer();
  try {
    await browserClosing;
    return await handleToolCall(request);
  } finally {
    activeBrowserRequests -= 1;
    scheduleBrowserIdleClose();
  }
});

async function handleToolCall(request: CallToolRequest): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_amazon_orders": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!; // Validated above

        // Get progress token from request meta
        const progressToken = request.params._meta?.progressToken;

        const currentPage = await getPage();
        const result = await fetchOrders(currentPage, amazonPlugin, {
          region,
          year: args?.year as number | undefined,
          startDate: args?.start_date as string | undefined,
          endDate: args?.end_date as string | undefined,
          includeItems: args?.include_items as boolean | undefined,
          includeShipments: args?.include_shipments as boolean | undefined,
          fetchTrackingNumbers: args?.fetch_tracking_numbers as
            | boolean
            | undefined,
          maxOrders: args?.max_orders as number | undefined,
          onProgress: async (message, current, total) => {
            await sendProgress(progressToken, current, total, message);
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  // Echo input parameters for debugging
                  params: {
                    region,
                    year: args?.year,
                    startDate: args?.start_date,
                    endDate: args?.end_date,
                    includeItems: args?.include_items,
                    includeShipments: args?.include_shipments,
                    fetchTrackingNumbers: args?.fetch_tracking_numbers,
                    maxOrders: args?.max_orders,
                  },
                  totalOrders: result.totalFound,
                  orders: result.orders.map((o) => ({
                    id: o.id,
                    date: o.date?.toISOString(),
                    total: o.total,
                    status: o.status?.label || "Unknown",
                    // Use itemCount from order header (extracted from list page) or fall back to items array length
                    itemCount: o.itemCount ?? o.items?.length ?? 0,
                    // Item titles captured from the order list page (no invoice visit needed)
                    itemTitles: o.itemTitles,
                    itemQuantities: o.itemQuantities,
                    // Subscribe & Save frequency captured from the order list page
                    subscribeAndSave: o.subscribeAndSave,
                    // Shipment count from the list page; falls back to fetched shipments
                    shipmentCount: o.shipmentCount ?? o.shipments?.length ?? 0,
                    // Enhanced order header data from list page
                    subtotal: o.subtotal,
                    shipping: o.shipping,
                    tax: o.tax,
                    vat: o.vat,
                    promotion: o.promotion,
                    grandTotal: o.grandTotal,
                    // Shipping address
                    shippingAddress: o.shippingAddress,
                    // Payment method from list page
                    paymentMethod: o.paymentMethod,
                    // Recipient (simple name)
                    recipient:
                      typeof o.recipient === "object"
                        ? o.recipient
                        : { name: o.recipient },
                    // Payments from detail/invoice
                    payments: o.payments,
                    // Include items when extracted
                    items: o.items?.map((i) => ({
                      name: i.name,
                      asin: i.asin,
                      quantity: i.quantity,
                      unitPrice: i.unitPrice,
                      condition: i.condition,
                      seller: i.seller?.name,
                      subscriptionFrequency: i.subscriptionFrequency,
                    })),
                    // Include shipments when extracted
                    shipments: o.shipments?.map((s) => ({
                      shipmentId: s.shipmentId,
                      status: s.status,
                      delivered: s.delivered,
                      trackingId: s.trackingId,
                      carrier: s.carrier,
                      trackingLink: s.trackingLink,
                      itemCount: s.items?.length || 0,
                    })),
                  })),
                  itemCount: result.items.length,
                  shipmentCount: result.shipments.length,
                  errors: result.errors,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "get_amazon_order_details": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const orderId = args?.order_id as string;
        const includeShipments = args?.include_shipments as boolean | undefined;
        const fetchTrackingNumbers = args?.fetch_tracking_numbers as
          | boolean
          | undefined;
        const includeTransactions = args?.include_transactions as
          | boolean
          | undefined;

        // Use the same fetchOrders logic that works for get_amazon_orders
        const result = await fetchOrders(currentPage, amazonPlugin, {
          region,
          orderId, // This triggers single-order mode
          includeItems: true,
          includeShipments: includeShipments ?? true,
          fetchTrackingNumbers: fetchTrackingNumbers ?? false,
          includeTransactions: includeTransactions ?? false,
        });

        const order = result.orders[0];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: result.errors.length > 0 ? "error" : "success",
                  params: {
                    orderId,
                    region,
                    includeShipments,
                    fetchTrackingNumbers,
                    includeTransactions,
                  },
                  order: order
                    ? {
                        id: order.id,
                        date: order.date?.toISOString(),
                        total: order.total,
                        shipping: order.shipping,
                        tax: order.tax,
                        recipient: order.recipient,
                        payments: order.payments,
                        itemCount: order.items?.length || 0,
                        shipmentCount: order.shipments?.length || 0,
                      }
                    : null,
                  items: result.items.map((i) => ({
                    name: i.name,
                    asin: i.asin,
                    quantity: i.quantity,
                    unitPrice: i.unitPrice,
                    condition: i.condition,
                    seller: i.seller?.name,
                    subscriptionFrequency: i.subscriptionFrequency,
                  })),
                  shipments: result.shipments.map((s) => ({
                    shipmentId: s.shipmentId,
                    status: s.status,
                    delivered: s.delivered,
                    trackingId: s.trackingId,
                    carrier: s.carrier,
                    trackingLink: s.trackingLink,
                    itemCount: s.items?.length || 0,
                  })),
                  transactions: result.transactions.map((t) => ({
                    date: t.date.toISOString(),
                    amount: t.amount,
                    vendor: t.vendor,
                    cardInfo: t.cardInfo,
                  })),
                  errors: result.errors,
                  timings: result.timings ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "download_amazon_invoice": {
        return handleInvoiceDownload(args);
      }

      case "export_amazon_orders_csv": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const year = args?.year as number | undefined;
        const startDate = args?.start_date as string | undefined;
        const endDate = args?.end_date as string | undefined;
        const maxOrders = args?.max_orders as number | undefined;
        const outputPath = getOutputPath(
          args?.output_path as string | undefined,
          "orders",
          region,
          { year, startDate, endDate },
        );

        const fetchResult = await fetchOrders(currentPage, amazonPlugin, {
          region,
          year,
          startDate,
          endDate,
          includeItems: false,
          includeShipments: false,
          maxOrders,
        });

        // Calculate time estimate for informational purposes
        const timeEstimate = estimateExtractionTime(fetchResult.orders.length, {
          includeItems: false,
          includeShipments: false,
        });

        const exportResult = await exportOrdersCSV(
          fetchResult.orders,
          outputPath,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: exportResult.success ? "success" : "error",
                  params: {
                    region,
                    year,
                    startDate,
                    endDate,
                    maxOrders,
                    outputPath,
                  },
                  filePath: exportResult.filePath,
                  rowCount: exportResult.rowCount,
                  error: exportResult.error,
                  fetchErrors: fetchResult.errors,
                  // Include timing info for transparency
                  timing: {
                    orderCount: fetchResult.orders.length,
                    estimate: timeEstimate.formattedEstimate,
                    warnings: timeEstimate.warnings,
                    recommendations: timeEstimate.recommendations,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "export_amazon_items_csv": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const year = args?.year as number | undefined;
        const startDate = args?.start_date as string | undefined;
        const endDate = args?.end_date as string | undefined;
        const maxOrders = args?.max_orders as number | undefined;
        const outputPath = getOutputPath(
          args?.output_path as string | undefined,
          "items",
          region,
          { year, startDate, endDate },
        );

        // Pre-estimate time for items extraction (slower due to invoice/detail page visits)
        const preEstimate = estimateExtractionTime(maxOrders || 100, {
          includeItems: true,
          includeShipments: false,
          useInvoice: true,
        });

        // Warn if this might take a while
        if (preEstimate.warnings.length > 0) {
          console.error(
            `[export-items] Time estimate: ${preEstimate.formattedEstimate}`,
          );
          console.error(
            `[export-items] Warnings: ${preEstimate.warnings.join(", ")}`,
          );
        }

        const fetchResult = await fetchOrders(currentPage, amazonPlugin, {
          region,
          year,
          startDate,
          endDate,
          includeItems: true,
          includeShipments: false,
          maxOrders,
        });

        // Calculate actual time estimate based on orders found
        const timeEstimate = estimateExtractionTime(fetchResult.orders.length, {
          includeItems: true,
          includeShipments: false,
          useInvoice: true,
        });

        const exportResult = await exportItemsCSV(
          fetchResult.items,
          outputPath,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: exportResult.success ? "success" : "error",
                  params: {
                    region,
                    year,
                    startDate,
                    endDate,
                    maxOrders,
                    outputPath,
                  },
                  filePath: exportResult.filePath,
                  rowCount: exportResult.rowCount,
                  error: exportResult.error,
                  fetchErrors: fetchResult.errors,
                  timing: {
                    orderCount: fetchResult.orders.length,
                    itemCount: fetchResult.items.length,
                    estimate: timeEstimate.formattedEstimate,
                    warnings: timeEstimate.warnings,
                    recommendations: timeEstimate.recommendations,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "export_amazon_shipments_csv": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const year = args?.year as number | undefined;
        const startDate = args?.start_date as string | undefined;
        const endDate = args?.end_date as string | undefined;
        const maxOrders = args?.max_orders as number | undefined;
        const fetchTrackingNumbers = args?.fetch_tracking_numbers as
          | boolean
          | undefined;
        const outputPath = getOutputPath(
          args?.output_path as string | undefined,
          "shipments",
          region,
          { year, startDate, endDate },
        );

        const fetchResult = await fetchOrders(currentPage, amazonPlugin, {
          region,
          year,
          startDate,
          endDate,
          includeItems: false,
          includeShipments: true,
          fetchTrackingNumbers: fetchTrackingNumbers ?? false,
          maxOrders,
        });

        const timeEstimate = estimateExtractionTime(fetchResult.orders.length, {
          includeItems: false,
          includeShipments: true,
        });

        const exportResult = await exportShipmentsCSV(
          fetchResult.shipments,
          outputPath,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: exportResult.success ? "success" : "error",
                  params: {
                    region,
                    year,
                    startDate,
                    endDate,
                    maxOrders,
                    fetchTrackingNumbers,
                    outputPath,
                  },
                  filePath: exportResult.filePath,
                  rowCount: exportResult.rowCount,
                  error: exportResult.error,
                  fetchErrors: fetchResult.errors,
                  timing: {
                    orderCount: fetchResult.orders.length,
                    shipmentCount: fetchResult.shipments.length,
                    estimate: timeEstimate.formattedEstimate,
                    warnings: timeEstimate.warnings,
                    recommendations: timeEstimate.recommendations,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "export_amazon_transactions_csv": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const year = args?.year as number | undefined;
        const startDate = args?.start_date as string | undefined;
        const endDate = args?.end_date as string | undefined;
        const maxOrders = args?.max_orders as number | undefined;
        const outputPath = getOutputPath(
          args?.output_path as string | undefined,
          "transactions",
          region,
          { year, startDate, endDate },
        );

        const fetchResult = await fetchOrders(currentPage, amazonPlugin, {
          region,
          year,
          startDate,
          endDate,
          includeItems: false,
          includeShipments: false,
          includeTransactions: true,
          maxOrders,
        });

        const timeEstimate = estimateExtractionTime(fetchResult.orders.length, {
          includeItems: false,
          includeShipments: false,
        });

        const exportResult = await exportTransactionsCSV(
          fetchResult.transactions,
          outputPath,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: exportResult.success ? "success" : "error",
                  params: {
                    region,
                    year,
                    startDate,
                    endDate,
                    maxOrders,
                    outputPath,
                  },
                  filePath: exportResult.filePath,
                  rowCount: exportResult.rowCount,
                  error: exportResult.error,
                  fetchErrors: fetchResult.errors,
                  timing: {
                    orderCount: fetchResult.orders.length,
                    transactionCount: fetchResult.transactions.length,
                    estimate: timeEstimate.formattedEstimate,
                    warnings: timeEstimate.warnings,
                    recommendations: timeEstimate.recommendations,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "get_amazon_transactions": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const progressToken = request.params._meta?.progressToken;
        const startDate = args?.start_date as string | undefined;
        const endDate = args?.end_date as string | undefined;
        const maxScrolls = args?.max_scrolls as number | undefined;

        const walkDiagnostics = newWalkDiagnostics();
        const transactions = await extractTransactionsFromPage(
          currentPage,
          region,
          {
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            maxScrolls,
            diagnostics: walkDiagnostics,
            onProgress: async (message, count) => {
              await sendProgress(progressToken, count, 0, message);
            },
          },
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: {
                    region,
                    startDate,
                    endDate,
                    maxScrolls,
                  },
                  transactionCount: transactions.length,
                  transactions: transactions.map((t) => ({
                    date: t.date.toISOString(),
                    orderIds: t.orderIds,
                    amount: t.amount,
                    cardInfo: t.cardInfo,
                    vendor: t.vendor,
                  })),
                  diagnostics: walkDiagnostics,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "get_amazon_gift_card_balance": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const maxPages = (args?.max_pages as number) ?? 10;
        const fetchAllPages = (args?.fetch_all_pages as boolean) ?? true;

        const giftCardData = await extractGiftCardData(currentPage, region, {
          maxPages,
          fetchAllPages,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: {
                    region,
                    maxPages,
                    fetchAllPages,
                  },
                  balance: giftCardData.balance.balance,
                  lastUpdated: giftCardData.balance.lastUpdated.toISOString(),
                  transactionCount: giftCardData.transactions.length,
                  transactions: giftCardData.transactions.map((t) => ({
                    date: t.date.toISOString(),
                    description: t.description,
                    amount: t.amount,
                    closingBalance: t.closingBalance,
                    type: t.type,
                    orderId: t.orderId,
                    claimCode: t.claimCode,
                    serialNumber: t.serialNumber,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "export_amazon_gift_cards_csv": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const outputPath = args?.output_path as string | undefined;
        const maxPages = (args?.max_pages as number) ?? 10;

        // Extract gift card transactions
        const giftCardData = await extractGiftCardData(currentPage, region, {
          maxPages,
          fetchAllPages: true,
        });

        // Convert to CSV format using shared helper
        const csvData = formatGiftCardDataForCSV(giftCardData);

        // Generate output path
        const today = new Date().toISOString().split("T")[0];
        const finalPath = getOutputPath(outputPath, "gift-cards", region, {
          endDate: today,
        });

        // Export to CSV
        const exportResult = await exportGiftCardTransactionsCSV(
          csvData,
          finalPath,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: exportResult.success ? "success" : "error",
                  params: {
                    region,
                    maxPages,
                  },
                  balance: giftCardData.balance.balance,
                  transactionCount: giftCardData.transactions.length,
                  filePath: exportResult.filePath,
                  rowCount: exportResult.rowCount,
                  error: exportResult.error,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "get_amazon_gift_card_transactions": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const maxPages = (args?.max_pages as number) ?? 10;

        // Extract gift card transactions
        const giftCardData = await extractGiftCardData(currentPage, region, {
          maxPages,
          fetchAllPages: true,
        });

        // Convert to export format using shared helper
        const exportData = formatGiftCardDataForExport(giftCardData);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: {
                    region,
                    maxPages,
                  },
                  ...exportData,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "check_amazon_auth_status": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const authStatus = await amazonPlugin.checkAuthStatus(
          currentPage,
          region,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: authStatus.authenticated ? "success" : "error",
                  params: {
                    region,
                  },
                  authenticated: authStatus.authenticated,
                  username: authStatus.username,
                  message: authStatus.message,
                  loginUrl: authStatus.authenticated
                    ? undefined
                    : amazonPlugin.getLoginUrl(region),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "refresh_code": {
        const result = await refreshCode();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          ...(result.status === "error" ? { isError: true } : {}),
        };
      }

      case "debug_order_cards": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;
        const requestedYear =
          (args?.year as number | undefined) ?? new Date().getFullYear();
        const maxCards = Math.min(
          Math.max((args?.max_cards as number | undefined) ?? 10, 1),
          50,
        );

        const currentPage = await getPage();
        const authStatus = await amazonPlugin.checkAuthStatus(
          currentPage,
          region,
        );
        if (!authStatus.authenticated) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    params: { region },
                    error: `Not authenticated: ${authStatus.message}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const listUrl = amazonPlugin.getOrderListUrl(region, {
          year: requestedYear,
        });
        await currentPage.goto(listUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await currentPage
          .waitForSelector('.order-card, [class*="order-card"], .a-box-group', {
            timeout: 3000,
          })
          .catch(() => {});

        const cards = await extractOrderCardTexts(currentPage);
        const maxChars = 4000;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: {
                    region,
                    year: requestedYear,
                    max_cards: maxCards,
                  },
                  cards: cards.slice(0, maxCards).map((c) => ({
                    orderId: c.orderId,
                    text: c.text.slice(0, maxChars),
                    truncated: c.text.length > maxChars,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "debug_order_details": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;
        const orderId = args?.order_id as string;
        const includeInvoice =
          (args?.include_invoice as boolean | undefined) ?? true;

        if (!orderId || !isValidAmazonOrderId(orderId)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    params: { region, order_id: orderId },
                    error: "Invalid Amazon order ID",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const currentPage = await getPage();
        const authStatus = await amazonPlugin.checkAuthStatus(
          currentPage,
          region,
        );
        if (!authStatus.authenticated) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    params: { region, order_id: orderId },
                    error: `Not authenticated: ${authStatus.message}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const detailUrl = amazonPlugin.getOrderDetailUrl(orderId, region);
        await currentPage.goto(detailUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await currentPage
          .waitForSelector(
            '[data-component="orderDetails"], [data-component="shipments"], #od-subtotals, .order-details',
            { timeout: 5000 },
          )
          .catch(() => {});

        // String-form evaluate: this project's tsconfig has no DOM lib, so
        // inline callbacks referencing document/window would not typecheck.
        const detailDiagnostics = await currentPage.evaluate(
          `(() => {
            const count = (sel) => document.querySelectorAll(sel).length;
            const census = {};
            document.querySelectorAll("[data-component]").forEach((el) => {
              const name = el.getAttribute("data-component") || "";
              census[name] = (census[name] || 0) + 1;
            });
            const shipmentTexts = Array.from(
              document.querySelectorAll('[data-component="shipments"]')
            )
              .slice(0, 8)
              .map((el) => (el.innerText || "").slice(0, 1500));
            const mainEl = document.querySelector(
              '[data-component="orderDetails"]'
            );
            return {
              url: window.location.href,
              title: document.title,
              counts: {
                shipmentsComponent: count('[data-component="shipments"]'),
                purchasedItems: count('[data-component="purchasedItems"]'),
                shipmentStatus: count('[data-component="shipmentStatus"]'),
                deliveryStatus: count('[data-component="deliveryStatus"]'),
                chargeSummary: count('[data-component="chargeSummary"]'),
                aBoxShipment: count("div.a-box.shipment"),
                aBoxGroup: count(".a-box-group"),
                fixedLeftGrid: count(".a-fixed-left-grid"),
                fixedLeftGridInner: count("div.fixed-left-grid-inner"),
                itemTitles: count('[data-component="itemTitle"]'),
                orderDetailsProductLinks: count(
                  '#orderDetails a[href*="/product/"], #orderDetails a[href*="/dp/"]'
                ),
              },
              census,
              shipmentTexts,
              mainText: (
                (mainEl && mainEl.innerText) ||
                document.body.innerText ||
                ""
              ).slice(0, 6000),
            };
          })()`,
        );

        let invoiceDiagnostics: unknown = null;
        if (includeInvoice) {
          const domain = getRegionByCode(region)?.domain || "amazon.com";
          const invoiceUrl = getInvoiceUrl(orderId, domain);
          await currentPage
            .goto(invoiceUrl, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            })
            .catch(() => {});
          await currentPage.waitForTimeout(1500);
          invoiceDiagnostics = await currentPage.evaluate(
            `(() => {
              const describe = (sel) =>
                Array.from(document.querySelectorAll(sel)).map((el) => {
                  const rect = el.getBoundingClientRect();
                  const cs = window.getComputedStyle(el);
                  return {
                    tag: el.tagName,
                    className: String(el.className || "").slice(0, 80),
                    clientRects: el.getClientRects().length,
                    rect: {
                      width: Math.round(rect.width),
                      height: Math.round(rect.height),
                    },
                    display: cs.display,
                    visibility: cs.visibility,
                    textStart: (el.innerText || "").slice(0, 150),
                  };
                });
              return {
                url: window.location.href,
                title: document.title,
                purchasedItems: describe('[data-component="purchasedItems"]'),
                chargeSummary: describe('[data-component="chargeSummary"]'),
                bodyTextStart: (document.body.innerText || "").slice(0, 2000),
              };
            })()`,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: { region, order_id: orderId, includeInvoice },
                  detail: detailDiagnostics,
                  invoice: invoiceDiagnostics,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "debug_transactions_page": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const authStatus = await amazonPlugin.checkAuthStatus(
          currentPage,
          region,
        );
        if (!authStatus.authenticated) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    params: { region },
                    error: `Not authenticated: ${authStatus.message}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        await currentPage.goto(getTransactionsPageUrl(region), {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await currentPage
          .waitForSelector(
            ".apx-transactions-line-item-component-container",
            { timeout: 20000 },
          )
          .catch(() => {});
        await currentPage.waitForTimeout(2000);

        // String-form evaluate: this project's tsconfig has no DOM lib, so
        // inline callbacks referencing document/window would not typecheck.
        const pageDiagnostics = (await currentPage.evaluate(
          `(() => {
            const visible = (el) =>
              Boolean(el.offsetParent || (el.getClientRects && el.getClientRects().length));
            const rows = document.querySelectorAll(
              ".apx-transactions-line-item-component-container"
            );
            const dateHeaders = Array.from(
              document.querySelectorAll(".apx-transaction-date-container")
            ).map((el) => (el.textContent || "").trim());

            const ppwInputs = Array.from(document.querySelectorAll("input"))
              .filter((el) => /ppw|Page/i.test(el.getAttribute("name") || ""))
              .map((el) => ({
                name: (el.getAttribute("name") || "").slice(0, 140),
                type: el.getAttribute("type") || "",
                disabled: Boolean(el.disabled),
                visible: visible(el),
                valueLength: (el.getAttribute("value") || "").length,
              }));

            const forms = Array.from(document.querySelectorAll("form")).map(
              (form) => ({
                action: (form.getAttribute("action") || "").slice(0, 120),
                method: form.getAttribute("method") || "",
                fields: Array.from(form.querySelectorAll("input, select, textarea")).map(
                  (el) => (el.getAttribute("name") || "").slice(0, 140)
                ),
              })
            );
            const ppwForms = forms.filter((f) =>
              f.fields.some((n) => /ppw/i.test(n))
            );

            const navControls = Array.from(
              document.querySelectorAll(
                'button, a, input[type="submit"], input[type="button"], [role="button"]'
              )
            )
              .map((el) => ({
                tag: el.tagName,
                text: ((el.textContent || el.getAttribute("value") || "") + "")
                  .replace(/\\s+/g, " ")
                  .trim()
                  .slice(0, 60),
                name: (el.getAttribute("name") || "").slice(0, 140),
                disabled: Boolean(el.disabled),
                visible: visible(el),
              }))
              .filter(
                (c) =>
                  /next|previous|load more|show more|see more|older/i.test(c.text) ||
                  /NextPage|PreviousPage/i.test(c.name)
              );

            const scrollChain = [];
            let node = rows[0];
            for (let i = 0; node && i < 9; i++) {
              const style = window.getComputedStyle(node);
              scrollChain.push({
                tag: node.tagName,
                cls: (node.getAttribute("class") || "").slice(0, 70),
                scrollHeight: node.scrollHeight,
                clientHeight: node.clientHeight,
                overflowY: style.overflowY,
              });
              node = node.parentElement;
            }

            const lastRow = rows[rows.length - 1];
            const tailSiblings = [];
            if (lastRow && lastRow.parentElement) {
              const siblings = Array.from(lastRow.parentElement.children);
              const idx = siblings.indexOf(lastRow);
              for (const sib of siblings.slice(idx + 1, idx + 7)) {
                tailSiblings.push({
                  tag: sib.tagName,
                  cls: (sib.getAttribute("class") || "").slice(0, 70),
                  text: ((sib.textContent || "") + "")
                    .replace(/\\s+/g, " ")
                    .trim()
                    .slice(0, 80),
                });
              }
            }

            let widgetFormHtml = "";
            const widgetForm = Array.from(document.querySelectorAll("form")).find(
              (form) =>
                Array.from(form.querySelectorAll("input")).some((el) =>
                  /ppw-widgetEvent/i.test(el.getAttribute("name") || "")
                )
            );
            if (widgetForm) {
              widgetFormHtml = widgetForm.outerHTML
                .replace(/value="[^"]*"/g, 'value="[redacted]"')
                .slice(0, 2500);
            }

            let loadMoreDetail = null;
            const loadMoreEl = Array.from(
              document.querySelectorAll('button, [role="button"], a')
            ).find((el) =>
              /^\\s*load more\\s*$/i.test(el.textContent || "")
            );
            if (loadMoreEl) {
              const rect = loadMoreEl.getBoundingClientRect();
              const style = window.getComputedStyle(loadMoreEl);
              const chain = [];
              let n = loadMoreEl;
              for (let i = 0; n && i < 6; i++) {
                chain.push({
                  tag: n.tagName,
                  cls: (n.getAttribute("class") || "").slice(0, 60),
                });
                n = n.parentElement;
              }
              loadMoreDetail = {
                tag: loadMoreEl.tagName,
                html: loadMoreEl.outerHTML
                  .replace(/value="[^"]*"/g, 'value="[redacted]"')
                  .slice(0, 500),
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
                display: style.display,
                visibility: style.visibility,
                disabled: Boolean(loadMoreEl.disabled),
                chain,
              };
            }

            return {
              url: window.location.href,
              title: document.title,
              apxRowCount: rows.length,
              dateHeaderCount: dateHeaders.length,
              firstDateHeader: dateHeaders[0] || "",
              lastDateHeader: dateHeaders[dateHeaders.length - 1] || "",
              ppwInputs,
              ppwForms,
              formCount: forms.length,
              navControls,
              scrollChain,
              tailSiblings,
              widgetFormHtml,
              loadMoreDetail,
              bodyTextStart: (document.body.innerText || "").slice(0, 600),
            };
          })()`,
        )) as { apxRowCount: number };

        // Idle-growth probe: does the list load more rows by itself,
        // given undisturbed time? (Read-only: no clicks, no scrolling.)
        const rowsBeforeIdle = pageDiagnostics.apxRowCount;
        await currentPage.waitForTimeout(15000);
        const rowsAfterIdle = await currentPage
          .evaluate(
            `document.querySelectorAll(".apx-transactions-line-item-component-container").length`,
          )
          .catch(() => -1);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: { region },
                  page: pageDiagnostics,
                  idleGrowth: { rowsBeforeIdle, rowsAfterIdle },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "debug_transactions_source": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const authStatus = await amazonPlugin.checkAuthStatus(
          currentPage,
          region,
        );
        if (!authStatus.authenticated) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    params: { region },
                    error: `Not authenticated: ${authStatus.message}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        await currentPage.goto(getTransactionsPageUrl(region), {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await currentPage.waitForTimeout(2500);

        // String-form evaluate: no DOM lib in this project's tsconfig.
        const sourceIntel = (await currentPage.evaluate(
          `(async () => {
            const scripts = Array.from(
              document.querySelectorAll("script[src]")
            ).map((s) => s.getAttribute("src") || "");
            const nextDataEl = document.querySelector("#__NEXT_DATA__");
            const nextData = nextDataEl
              ? (nextDataEl.textContent || "").slice(0, 20000)
              : null;
            const root =
              document.querySelector("#__next") || document.body;
            const rootHtml = root
              ? root.outerHTML
                  .replace(/value="[^"]*"/g, 'value="[redacted]"')
                  .slice(0, 20000)
              : "";
            const container = document.querySelector(
              "#__next > div:nth-child(1) > div > div.css-g5y9jx.r-13awgt0 > div > div"
            );
            const containerInfo = container
              ? {
                  scrollHeight: container.scrollHeight,
                  clientHeight: container.clientHeight,
                  scrollTop: container.scrollTop,
                  childCount: container.children.length,
                  html: container.outerHTML
                    .replace(/value="[^"]*"/g, 'value="[redacted]"')
                    .slice(0, 1500),
                }
              : null;
            const rowsNow = document.querySelectorAll(
              ".apx-transactions-line-item-component-container"
            ).length;

            const keywords = [
              "continueWidget",
              "nextPageKey",
              "onEndReached",
              "fetchMore",
              "NextPageNavigation",
              "cursor",
            ];
            const findings = [];
            const bundleSrcs = scripts
              .filter((s) => /transactions|_next|chunk|main/i.test(s))
              .slice(0, 3);
            for (const src of bundleSrcs) {
              try {
                const text = await fetch(src, {
                  credentials: "include",
                }).then((r) => r.text());
                for (const kw of keywords) {
                  let idx = text.indexOf(kw);
                  let hits = 0;
                  while (idx >= 0 && hits < 2) {
                    findings.push({
                      src: src.split("/").pop(),
                      keyword: kw,
                      window: text.slice(
                        Math.max(0, idx - 220),
                        idx + 320
                      ),
                    });
                    idx = text.indexOf(kw, idx + kw.length);
                    hits++;
                  }
                }
                if (!findings.some((f) => f.src === src.split("/").pop())) {
                  findings.push({
                    src: src.split("/").pop(),
                    keyword: "(none)",
                    window:
                      "bundle fetched, " +
                      text.length +
                      " chars, no keywords hit",
                  });
                }
              } catch (e) {
                findings.push({
                  src: src.split("/").pop(),
                  keyword: "(fetch failed)",
                  window: String(e),
                });
              }
            }

            return {
              url: window.location.href,
              title: document.title,
              scriptCount: scripts.length,
              scripts: scripts.slice(0, 40),
              nextData,
              rootHtml,
              containerInfo,
              rowsNow,
              findings: findings.slice(0, 40),
            };
          })()`,
        )) as Record<string, unknown>;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: { region },
                  source: sourceIntel,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "debug_transactions_capture": {
        const regionParam = args?.region as string | undefined;
        const regionError = validateRegion(regionParam, args);
        if (regionError) return regionError;
        const region = regionParam!;

        const currentPage = await getPage();
        const authStatus = await amazonPlugin.checkAuthStatus(
          currentPage,
          region,
        );
        if (!authStatus.authenticated) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    params: { region },
                    error: `Not authenticated: ${authStatus.message}`,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        // Record xhr/fetch traffic. Bodies are redacted for JWT-shaped
        // tokens: the SHAPE of the app's next-chunk request is the
        // goal; live tokens stay in the page, where a replay reads
        // them fresh at drive time.
        const redact = (text: string | null): string | null =>
          text === null
            ? null
            : text
                .replace(
                  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
                  "[jwt-redacted]",
                )
                .replace(
                  /"(token|metricsToken|slateToken)"\s*:\s*"[^"]*"/g,
                  '"$1":"[redacted]"',
                );
        interface CapturedRequest {
          method: string;
          url: string;
          resourceType: string;
          postData: string | null;
          headers?: Record<string, string>;
        }
        interface CapturedResponse {
          url: string;
          status: number;
          bodyHead: string | null;
        }
        const capturedRequests: CapturedRequest[] = [];
        const capturedResponses: CapturedResponse[] = [];
        const responseReads: Array<Promise<void>> = [];
        let capturing = true;

        currentPage.on("request", (req) => {
          if (!capturing) return;
          const type = req.resourceType();
          if (type !== "xhr" && type !== "fetch") return;
          if (capturedRequests.length >= 40) return;
          // For the get-transactions call, also record header names and
          // (redacted, truncated) values: the API rejected a cookie-only
          // replay with 401, so the auth header it expects must be
          // identified. Cookie header is dropped entirely.
          let headers: Record<string, string> | undefined;
          if (req.url().includes("get-transactions")) {
            headers = {};
            for (const [name, value] of Object.entries(req.headers())) {
              if (name.toLowerCase() === "cookie") continue;
              const redacted = redact(value) ?? value;
              headers[name] =
                redacted.length > 40
                  ? `${redacted.slice(0, 24)}…[${redacted.length} chars]`
                  : redacted;
            }
          }
          capturedRequests.push({
            method: req.method(),
            url: req.url(),
            resourceType: type,
            postData: redact(req.postData())?.slice(0, 4000) ?? null,
            headers,
          });
        });
        currentPage.on("response", (res) => {
          if (!capturing) return;
          const type = res.request().resourceType();
          if (type !== "xhr" && type !== "fetch") return;
          responseReads.push(
            res
              .text()
              .then((body) => {
                if (capturedResponses.length < 40) {
                  capturedResponses.push({
                    url: res.url(),
                    status: res.status(),
                    bodyHead: redact(body)?.slice(0, 3500) ?? null,
                  });
                }
              })
              .catch(() => {}),
          );
        });

        await currentPage.goto(getTransactionsPageUrl(region), {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await currentPage
          .waitForSelector('[data-testid="transaction-link"]', {
            timeout: 15000,
          })
          .catch(() => {});
        await currentPage.waitForTimeout(1000);

        // Stimulate pagination the way the hydrated app expects: push
        // every scrollable ancestor of the rows (and the window) to
        // its bottom, repeatedly, so newly appended content keeps the
        // end within reach of the next trigger.
        const stimulator = (await currentPage.evaluate(
          `(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const rowSel = '[data-testid="transaction-link"]';
            const rowsCount = () => document.querySelectorAll(rowSel).length;
            const before = rowsCount();
            const scrollers = [];
            const seen = new Set();
            let el = document.querySelector(rowSel);
            while (el && scrollers.length < 8) {
              if (el.scrollHeight > el.clientHeight + 5 && !seen.has(el)) {
                seen.add(el);
                scrollers.push(el);
              }
              el = el.parentElement;
            }
            if (document.scrollingElement && !seen.has(document.scrollingElement)) {
              scrollers.push(document.scrollingElement);
            }
            const info = scrollers.map((s) => ({
              tag: s.tagName,
              cls: (s.getAttribute("class") || "").slice(0, 60),
              sh: s.scrollHeight,
              ch: s.clientHeight,
              oy: window.getComputedStyle(s).overflowY,
            }));
            for (let round = 0; round < 40; round++) {
              for (const s of scrollers) {
                s.scrollTop = s.scrollHeight;
              }
              window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
              await sleep(600);
            }
            return { rowsBefore: before, rowsAfter: rowsCount(), scrollers: info };
          })()`,
        )) as Record<string, unknown>;

        await currentPage.waitForTimeout(3000);
        await Promise.race([
          Promise.allSettled(responseReads),
          currentPage.waitForTimeout(5000),
        ]);
        capturing = false;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  params: { region },
                  stimulator,
                  requests: capturedRequests,
                  responses: capturedResponses,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Unknown tool: ${name}`,
              }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: String(error),
          }),
        },
      ],
      isError: true,
    };
  }
}

// Cleanup on exit
process.on("SIGINT", async () => {
  if (browserContext) {
    await browserContext.close();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (browserContext) {
    await browserContext.close();
  }
  process.exit(0);
});

// Main entry point
async function main(): Promise<void> {
  const transportMode = (
    process.env.MCP_TRANSPORT ?? "streamable-http"
  ).toLowerCase();

  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      "Amazon Order History CSV Download MCP server running over stdio",
    );
    return;
  }

  if (transportMode !== "streamable-http" && transportMode !== "http") {
    throw new Error(
      `Unsupported MCP_TRANSPORT="${transportMode}". Use streamable-http or stdio.`,
    );
  }

  const host = process.env.MCP_HOST ?? "0.0.0.0";
  const port = Number.parseInt(process.env.MCP_PORT ?? "8000", 10);
  const mcpPathRaw = process.env.MCP_PATH ?? "/mcp";
  const mcpPath = mcpPathRaw.startsWith("/") ? mcpPathRaw : `/${mcpPathRaw}`;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_PORT: ${process.env.MCP_PORT}`);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });
  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    if (requestUrl.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (requestUrl.pathname !== mcpPath) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "not_found",
          mcp_endpoint: mcpPath,
        }),
      );
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[mcp-http] request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            error: "mcp_transport_error",
            message: String(error),
          }),
        );
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(
      `Amazon Order History MCP listening at http://${host}:${port}${mcpPath}`,
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
