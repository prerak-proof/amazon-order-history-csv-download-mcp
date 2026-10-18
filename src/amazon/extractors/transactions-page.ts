/**
 * Transactions page extraction for Amazon.
 * Extracts from: https://www.amazon.{domain}/cpe/yourpayments/transactions
 *
 * This page contains ALL payment transactions across all orders,
 * making it much faster than extracting from individual order pages.
 *
 * Based on AZAD's transaction.ts, transaction0.ts, and transaction1.ts patterns.
 */

import { Page } from "playwright";
import { Transaction } from "../../core/types/transaction";
import { parseMoney, getCurrencySymbol } from "../../core/types/money";
import { parseDate } from "../../core/utils/date";
import { getRegionByCode } from "../regions";

interface BrowserElement {
  textContent: string | null;
  classList: { contains: (className: string) => boolean };
  querySelectorAll: (selector: string) => ArrayLike<BrowserElement>;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => BrowserElement | null;
}

interface BrowserDocument {
  querySelectorAll: (selector: string) => ArrayLike<BrowserElement>;
}

interface BrowserWindow {
  document: BrowserDocument;
}

interface RawApxTransaction {
  dateText: string;
  amountText: string;
  cardInfo: string;
  orderIds: string[];
  vendor: string;
  status: string;
}

const APX_TRANSACTION_SELECTOR =
  ".apx-transactions-line-item-component-container";
const APX_PAGE_TRANSITION_TIMEOUT_MS = 10000;

/**
 * Diagnostics for one transactions-page walk, filled in by
 * extractTransactionsFromPage when the caller passes a diagnostics
 * object in the options. Records where the walk went and exactly why
 * it stopped — deep-history walks previously failed silently (0 rows,
 * no reason), which made page-variant failures undebuggable.
 */
export interface TransactionsWalkDiagnostics {
  pagesVisited: number;
  seekPagesSkipped: number;
  stopReason: string;
  stopDetail: string;
  deepestDate: string | null;
  newestDate: string | null;
  errorWidgetSeen: boolean;
  trace: Array<{
    page: number;
    phase: "seek" | "extract";
    newest: string | null;
    oldest: string | null;
    rows: number;
  }>;
}

export function newWalkDiagnostics(): TransactionsWalkDiagnostics {
  return {
    pagesVisited: 0,
    seekPagesSkipped: 0,
    stopReason: "",
    stopDetail: "",
    deepestDate: null,
    newestDate: null,
    errorWidgetSeen: false,
    trace: [],
  };
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Whether the payments widget is showing its "Something went wrong"
 * error state (observed on some account page variants; the walk then
 * turns pages that never render transactions).
 */
async function pageShowsErrorWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const browserWindow = globalThis as unknown as BrowserWindow;
      const body = browserWindow.document as unknown as {
        body?: { innerText?: string };
      };
      return (body.body?.innerText || "").includes("Something went wrong");
    })
    .catch(() => false);
}

/**
 * Parse an amount from the transactions page, trusting the region's currency.
 * The page always displays amounts in the region's currency, but bare "$"
 * symbols would otherwise be interpreted as USD (e.g. on amazon.com.au).
 */
function parseRegionMoney(formatted: string, currency: string) {
  const money = parseMoney(formatted, currency);
  money.currency = currency;
  money.currencySymbol = getCurrencySymbol(currency);
  return money;
}

/**
 * Get transactions page URL for a region.
 */
export function getTransactionsPageUrl(region: string): string {
  const regionConfig = getRegionByCode(region);
  const domain = regionConfig?.domain || "amazon.com";
  return `https://www.${domain}/cpe/yourpayments/transactions`;
}

/**
 * Extract all transactions from the transactions page.
 * Uses page navigation for APX layouts and scrolling for legacy layouts.
 */
export async function extractTransactionsFromPage(
  page: Page,
  region: string,
  options?: {
    startDate?: Date;
    endDate?: Date;
    maxScrolls?: number;
    onProgress?: (message: string, count: number) => void;
    diagnostics?: TransactionsWalkDiagnostics;
  },
): Promise<Transaction[]> {
  const regionConfig = getRegionByCode(region);
  const currency = regionConfig?.currency || "USD";
  const url = getTransactionsPageUrl(region);

  const { startDate, endDate, maxScrolls = 50, onProgress } = options || {};

  // Navigate to transactions page
  onProgress?.("Loading transactions page...", 0);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for transactions to load (current "apx" structure or legacy selectors)
  await page
    .waitForSelector(
      '.apx-transactions-line-item-component-container, [data-testid="transaction-link"], .transaction-date-container, .transactions-line-item',
      { timeout: 10000 },
    )
    .catch(() => {});

  // Give initial content time to render
  await page.waitForTimeout(1000);

  let allTransactions: Transaction[] = [];
  let pageCount = 0;
  let previousCount = 0;
  let stableCount = 0;
  const diag = options?.diagnostics;
  let stopReason = "page_cap";
  let stopDetail = `hit the ${maxScrolls}-page cap`;

  // The transactions page is paginated (Previous/Next page buttons).
  // Walk pages until there's no enabled Next button, we pass the start date,
  // or we hit the page limit (reuses maxScrolls as a page cap).
  //
  // Seek phase: while a page lies entirely NEWER than the requested end
  // date, only its date headers are read and the page is skipped without
  // extracting or merging transactions. This makes deep history walks
  // (e.g. asking for 2024 while the first page shows 2026) proportional to
  // page turns instead of full extractions of every intervening page.
  while (pageCount < maxScrolls) {
    if (await pageShowsErrorWidget(page)) {
      if (diag) diag.errorWidgetSeen = true;
    }

    if (endDate) {
      const range = await readPageDateRange(page);
      if (range && range.oldest > endDate.getTime()) {
        if (diag) {
          diag.seekPagesSkipped++;
          diag.trace.push({
            page: pageCount + 1,
            phase: "seek",
            newest: isoDay(range.newest),
            oldest: isoDay(range.oldest),
            rows: 0,
          });
          if (!diag.newestDate) diag.newestDate = isoDay(range.newest);
          diag.deepestDate = isoDay(range.oldest);
        }
        const adv = await goToNextPage(page);
        if (!adv.advanced) {
          stopReason = "no_next_page";
          stopDetail = `seek phase: ${adv.reason}`;
          break;
        }
        pageCount++;
        continue;
      }
    }

    // Extract current transactions
    const pageTransactions = await extractVisibleTransactions(page, currency);

    if (pageTransactions.length === 0) {
      // Nothing extracted on this page - no point paginating further
      stopReason = "empty_extraction";
      const sig = await readPageSignature(page).catch(() => null);
      stopDetail =
        `extraction returned 0 rows on page ${pageCount + 1} ` +
        `(signature: date="${sig?.dateText ?? "?"}", rows=${sig?.rowCount ?? "?"}, ` +
        `errorWidget=${diag?.errorWidgetSeen ?? false})`;
      break;
    }

    const pageOldest = Math.min(
      ...pageTransactions.map((t) => t.date.getTime()),
    );
    const pageNewest = Math.max(
      ...pageTransactions.map((t) => t.date.getTime()),
    );

    // Seek fallback: the header-based range read can miss on some page
    // variants; if the extracted page still lies entirely NEWER than
    // the requested window, treat it as a seek page (do not merge, do
    // not feed the stable counter) and keep moving.
    if (endDate && pageOldest > endDate.getTime()) {
      if (diag) {
        diag.seekPagesSkipped++;
        diag.trace.push({
          page: pageCount + 1,
          phase: "seek",
          newest: isoDay(pageNewest),
          oldest: isoDay(pageOldest),
          rows: pageTransactions.length,
        });
        if (!diag.newestDate) diag.newestDate = isoDay(pageNewest);
        diag.deepestDate = isoDay(pageOldest);
      }
      const advSeek = await goToNextPage(page);
      if (!advSeek.advanced) {
        stopReason = "no_next_page";
        stopDetail = `seek phase (extracted): ${advSeek.reason}`;
        break;
      }
      pageCount++;
      continue;
    }

    if (diag) {
      diag.pagesVisited++;
      diag.trace.push({
        page: pageCount + 1,
        phase: "extract",
        newest: isoDay(pageNewest),
        oldest: isoDay(pageOldest),
        rows: pageTransactions.length,
      });
      if (!diag.newestDate) diag.newestDate = isoDay(pageNewest);
      diag.deepestDate = isoDay(pageOldest);
    }

    // Merge with existing (deduplicate)
    allTransactions = mergeTransactions(allTransactions, pageTransactions);

    onProgress?.(
      `Found ${allTransactions.length} transactions...`,
      allTransactions.length,
    );

    // Stop if nothing new turned up for several rounds (guards the legacy
    // infinite-scroll path, which has no reliable "last page" signal)
    if (allTransactions.length === previousCount) {
      stableCount++;
      if (stableCount >= 3) {
        stopReason = "stable_no_new";
        stopDetail = "3 consecutive pages added no new transactions";
        break;
      }
    } else {
      stableCount = 0;
    }
    previousCount = allTransactions.length;

    // Stop once a page reaches back past the start date (transactions are
    // listed newest-first, so no later page can re-enter the window)
    if (startDate && pageOldest < startDate.getTime()) {
      stopReason = "reached_start_date";
      stopDetail = `page oldest ${isoDay(pageOldest)} < start ${isoDay(startDate.getTime())}`;
      break;
    }

    // Move to the next page if there is one
    const adv = await goToNextPage(page);
    if (!adv.advanced) {
      stopReason = "no_next_page";
      stopDetail = `extract phase: ${adv.reason}`;
      break;
    }
    pageCount++;
  }

  if (diag) {
    diag.stopReason = stopReason;
    diag.stopDetail = stopDetail;
    console.error(
      `[transactions-page][diag] stop=${stopReason} (${stopDetail}); ` +
        `pagesVisited=${diag.pagesVisited} seekSkipped=${diag.seekPagesSkipped} ` +
        `deepest=${diag.deepestDate} errorWidget=${diag.errorWidgetSeen}`,
    );
  }

  // Drop rows scraped off Amazon error banners ("There was a problem")
  // rather than real transaction line items
  allTransactions = allTransactions.filter(
    (t) => !/there was a problem/i.test(t.vendor),
  );

  // Filter by date range if specified
  let filteredTransactions = allTransactions;
  if (startDate || endDate) {
    filteredTransactions = allTransactions.filter((t) => {
      if (startDate && t.date < startDate) return false;
      if (endDate && t.date > endDate) return false;
      return true;
    });
  }

  // Sort by date descending (newest first)
  filteredTransactions.sort((a, b) => b.date.getTime() - a.date.getTime());

  onProgress?.(
    `Complete: ${filteredTransactions.length} transactions`,
    filteredTransactions.length,
  );

  return filteredTransactions;
}

/**
 * Extract visible transactions from current page state.
 * Implements multiple strategies based on AZAD's approach.
 */
async function extractVisibleTransactions(
  page: Page,
  currency: string,
): Promise<Transaction[]> {
  // Try the current Amazon structure first (apx-prefixed classes, 2025+)
  let transactions = await extractStrategyApx(page, currency);
  if (transactions.length > 0) {
    return transactions;
  }

  // Try Strategy 0 (legacy transaction-date-container based)
  transactions = await extractStrategy0(page, currency);
  if (transactions.length > 0) {
    return transactions;
  }

  // Try Strategy 1 (component-based parsing)
  transactions = await extractStrategy1(page, currency);
  if (transactions.length > 0) {
    return transactions;
  }

  // Fallback: generic extraction
  return extractGeneric(page, currency);
}

/**
 * Current strategy: extract from the apx-* component structure (2025+).
 *
 * Page layout:
 *   .apx-transaction-date-container            <- "28 June 2026"
 *   .a-section                                 <- sibling holding that date's items
 *     .apx-transactions-line-item-component-container   <- one per transaction
 *       row: payment method ("Visa ****1234") + amount ("-$47.99")
 *       row (optional): status ("Pending")
 *       row: order link  <a href="...orderID=xxx">Order #xxx</a>
 *       row (optional): vendor ("Amazon AU", "Audible Limited (AU)", ...)
 *
 * Walks date containers and line items in document order in a single
 * page.evaluate, tracking the current date as it goes.
 */
async function extractStrategyApx(
  page: Page,
  currency: string,
): Promise<Transaction[]> {
  const rawTransactions: RawApxTransaction[] = await page.evaluate(() => {
    const STATUS_RE = /^(Pending|Completed|In progress|Charged|Refunded)$/i;
    const getOrderIds = (item: BrowserElement): string[] => {
      const orderIds = item.querySelectorAll('a[href*="orderID="]');
      const matchedOrderIds = Array.from(orderIds)
        .map((anchor) => anchor.getAttribute("href") || "")
        .map((href) => href.match(/orderID=([A-Z0-9-]+)/i)?.[1])
        .filter((orderId): orderId is string => Boolean(orderId));

      if (matchedOrderIds.length > 0) return matchedOrderIds;

      return item.textContent?.match(/[A-Z]?\d{2,3}-\d{7}-\d{7}/g) || [];
    };

    const getTransactionFields = (
      item: BrowserElement,
    ): Omit<RawApxTransaction, "dateText" | "orderIds"> => {
      let amountText = "";
      let cardInfo = "";
      let vendor = "";
      let status = "";

      for (const span of Array.from(item.querySelectorAll("span"))) {
        const text = span.textContent?.trim() || "";
        if (!text) continue;

        const isBold = span.classList.contains("a-text-bold");
        const isAmount = isBold && Boolean(span.closest(".a-text-right"));

        if (isAmount && !amountText) {
          amountText = text;
        } else if (isBold && !cardInfo) {
          cardInfo = text;
        } else if (STATUS_RE.test(text) && !status) {
          status = text;
        } else if (!isBold && !text.startsWith("Order #") && !vendor) {
          vendor = text;
        }
      }

      return { amountText, cardInfo, vendor, status };
    };

    const browserWindow = globalThis as unknown as BrowserWindow;
    const nodes = Array.from(
      browserWindow.document.querySelectorAll(
        ".apx-transaction-date-container, .apx-transactions-line-item-component-container",
      ),
    );
    const results: RawApxTransaction[] = [];
    let currentDate = "";

    for (const node of nodes) {
      if (node.classList.contains("apx-transaction-date-container")) {
        currentDate = node.textContent?.trim() || "";
        continue;
      }

      results.push({
        dateText: currentDate,
        orderIds: getOrderIds(node),
        ...getTransactionFields(node),
      });
    }

    return results;
  });

  const transactions: Transaction[] = [];
  for (const raw of rawTransactions) {
    const date = parseDate(raw.dateText);
    if (!date) {
      console.error(
        `[transactions-page] apx: could not parse date "${raw.dateText}"`,
      );
      continue;
    }

    transactions.push({
      date,
      orderIds: [...new Set(raw.orderIds)],
      amount: parseRegionMoney(raw.amountText || "0", currency),
      cardInfo: raw.cardInfo,
      vendor: raw.vendor,
      platformData: {
        source: "transactions-page",
        status: raw.status || undefined,
        isRefund: raw.amountText.trim().startsWith("+"),
      },
    });
  }

  console.error(
    `[transactions-page] apx strategy: extracted ${transactions.length} transactions`,
  );
  return transactions;
}

/**
 * Strategy 0: Extract from transaction-date-container structure.
 * Based on AZAD's transaction0.ts
 */
async function extractStrategy0(
  page: Page,
  currency: string,
): Promise<Transaction[]> {
  const transactions: Transaction[] = [];

  // Find all date containers
  const dateContainers = await page
    .locator(".transaction-date-container")
    .all();

  for (const dateContainer of dateContainers) {
    try {
      const dateText = await dateContainer
        .textContent({ timeout: 300 })
        .catch(() => "");
      if (!dateText) continue;

      const date = parseDate(dateText.trim());
      if (!date) continue;

      // Get the sibling container with transaction items
      const siblingContainer = dateContainer.locator(
        "xpath=following-sibling::*[1]",
      );
      const transactionItems = await siblingContainer
        .locator(".transactions-line-item")
        .all();

      for (const item of transactionItems) {
        const transaction = await extractTransactionItem(item, date, currency);
        if (transaction) {
          transactions.push(transaction);
        }
      }
    } catch {
      continue;
    }
  }

  return transactions;
}

/**
 * Strategy 1: Extract using data-testid attributes and modern selectors.
 * Updated for 2024+ Amazon transactions page structure.
 */
async function extractStrategy1(
  page: Page,
  currency: string,
): Promise<Transaction[]> {
  const transactions: Transaction[] = [];

  // Find transaction links (modern Amazon UI with data-testid)
  const transactionLinks = await page
    .locator('[data-testid="transaction-link"]')
    .all();
  console.error(
    `[transactions-page] Strategy 1: Found ${transactionLinks.length} transaction links`,
  );

  for (const link of transactionLinks) {
    try {
      // Extract date - first span[data-testid="text"] in the transaction
      // Date format: "28 Nov 2025"
      const dateSpans = await link.locator('span[data-testid="text"]').all();
      let dateText = "";
      if (dateSpans.length > 0) {
        dateText =
          (await dateSpans[0].textContent({ timeout: 300 }).catch(() => "")) ||
          "";
      }

      const date = parseDate(dateText.trim());
      if (!date) {
        console.error(
          `[transactions-page] Could not parse date: "${dateText}"`,
        );
        continue;
      }

      // Extract vendor - usually the third span[data-testid="text"] (after date and dot separator)
      let vendor = "";
      if (dateSpans.length >= 3) {
        vendor =
          (await dateSpans[2].textContent({ timeout: 300 }).catch(() => "")) ||
          "";
      }

      // Extract card info from method-details fields
      const cardName =
        (await link
          .locator('[data-testid="method-details-name"]')
          .textContent({ timeout: 300 })
          .catch(() => "")) || "";
      const cardNumber =
        (await link
          .locator('[data-testid="method-details-number"]')
          .textContent({ timeout: 300 })
          .catch(() => "")) || "";
      const cardInfo =
        cardName && cardNumber
          ? `${cardName} ••••${cardNumber}`
          : cardName || "";

      // Extract order IDs - look for text containing "Order #"
      const orderTexts = await link
        .locator('div[data-testid="text"]')
        .allTextContents();
      const orderIds: string[] = [];
      for (const text of orderTexts) {
        // Match both standard format (203-1234567-1234567) and digital (D01-1234567-1234567)
        const matches = text.match(/[D]?\d{3}-\d{7}-\d{7}/g);
        if (matches) {
          orderIds.push(...matches);
        }
      }

      if (orderIds.length === 0) {
        // Try getting order ID from the full link text
        const fullText =
          (await link.textContent({ timeout: 300 }).catch(() => "")) || "";
        const fallbackMatches = fullText.match(/[D]?\d{3}-\d{7}-\d{7}/g);
        if (fallbackMatches) {
          orderIds.push(...fallbackMatches);
        }
      }

      // Extract amount - look for text with currency symbol (bold text)
      const fullText =
        (await link.textContent({ timeout: 300 }).catch(() => "")) || "";
      // Match amounts like "-£47.64", "+£93.59", "£1,399.13"
      const amountMatch = fullText.match(/([+-])?\s*([£$€])\s*([\d,]+\.?\d*)/);
      let amount = parseRegionMoney("0", currency);
      if (amountMatch) {
        const sign = amountMatch[1] === "+" ? "" : "-";
        const amountStr = `${sign}${amountMatch[2]}${amountMatch[3]}`;
        amount = parseRegionMoney(amountStr, currency);
      }

      // Determine if refund based on amount sign or status text
      const isRefund =
        fullText.includes("Refunded") ||
        (amountMatch && amountMatch[1] === "+");

      // Extract status
      const statusMatch = fullText.match(
        /\b(Pending|Charged|Refunded|Completed)\b/i,
      );
      const status = statusMatch ? statusMatch[1] : undefined;

      const transaction: Transaction = {
        date,
        orderIds: [...new Set(orderIds)], // Deduplicate
        amount,
        cardInfo,
        vendor: vendor.trim(),
        platformData: {
          source: "transactions-page",
          status,
          isRefund,
        },
      };

      transactions.push(transaction);
    } catch (e) {
      console.error(`[transactions-page] Error extracting transaction: ${e}`);
      continue;
    }
  }

  console.error(
    `[transactions-page] Strategy 1: Extracted ${transactions.length} transactions`,
  );
  return transactions;
}

/**
 * Generic extraction fallback.
 */
async function extractGeneric(
  page: Page,
  currency: string,
): Promise<Transaction[]> {
  const transactions: Transaction[] = [];

  // Get all text content and try to parse transactions
  const rows = await page.locator('.a-row, [class*="transaction"]').all();

  for (const row of rows) {
    try {
      const text = await row.textContent({ timeout: 200 }).catch(() => "");
      if (!text) continue;

      // Must have an order ID pattern to be a transaction
      if (!text.match(/\d{3}-\d{7}-\d{7}/)) continue;

      const transaction = parseTransactionText(text, currency);
      if (transaction) {
        transactions.push(transaction);
      }
    } catch {
      continue;
    }
  }

  return transactions;
}

/**
 * Extract a single transaction item.
 */
async function extractTransactionItem(
  item: ReturnType<Page["locator"]>,
  date: Date,
  currency: string,
): Promise<Transaction | null> {
  try {
    const itemText = await item.textContent({ timeout: 300 }).catch(() => "");
    if (!itemText) return null;

    // Extract order IDs
    const orderIdMatches = itemText.match(/\d{3}-\d{7}-\d{7}/g) || [];
    const orderIds = [...new Set(orderIdMatches)];

    if (orderIds.length === 0) return null;

    // Extract amount
    const amountMatch =
      itemText.match(/([$£€¥]|USD|GBP|EUR|CAD|AUD)\s*([\d,]+\.?\d*)/i) ||
      itemText.match(/([\d,]+\.?\d*)\s*([$£€¥]|USD|GBP|EUR|CAD|AUD)/i);
    const amount = amountMatch
      ? parseRegionMoney(amountMatch[0], currency)
      : parseRegionMoney("0", currency);

    // Extract card info (e.g., "Visa ****1234" or "ending in 1234")
    const cardMatch =
      itemText.match(
        /(Visa|Mastercard|Amex|American Express|Discover|Debit)[^*]*(\*{3,4}\d{4}|\d{4})/i,
      ) ||
      itemText.match(/ending\s*in\s*(\d{4})/i) ||
      itemText.match(/(\*{3,4}\d{4})/);
    const cardInfo = cardMatch ? cardMatch[0].trim() : "";

    // Extract vendor (text that's not order ID, amount, or card)
    let vendor = itemText
      .replace(/\d{3}-\d{7}-\d{7}/g, "")
      .replace(/([$£€¥]|USD|GBP|EUR|CAD|AUD)\s*[\d,]+\.?\d*/gi, "")
      .replace(
        /(Visa|Mastercard|Amex|American Express|Discover|Debit)[^*]*\*{3,4}\d{4}/gi,
        "",
      )
      .replace(/ending\s*in\s*\d{4}/gi, "")
      .replace(/\*{3,4}\d{4}/g, "")
      .replace(/Pending|Charged|Completed|Refunded/gi, "")
      .trim();

    // Clean up vendor - take first meaningful segment
    vendor = vendor.split(/\s{2,}|\n/)[0]?.trim() || "";

    return {
      date,
      orderIds,
      amount,
      cardInfo,
      vendor,
      platformData: { source: "transactions-page" },
    };
  } catch {
    return null;
  }
}

/**
 * Parse transaction from text content.
 */
function parseTransactionText(
  text: string,
  currency: string,
): Transaction | null {
  // Extract date
  const datePatterns = [
    /(\w+\s+\d{1,2},?\s+\d{4})/, // "January 15, 2024"
    /(\d{1,2}\s+\w+\s+\d{4})/, // "15 January 2024"
    /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/, // "01/15/2024"
  ];

  let date: Date | null = null;
  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      date = parseDate(match[1]);
      if (date) break;
    }
  }

  if (!date) return null;

  // Extract order IDs
  const orderIdMatches = text.match(/\d{3}-\d{7}-\d{7}/g) || [];
  const orderIds = [...new Set(orderIdMatches)];

  if (orderIds.length === 0) return null;

  // Extract amount
  const amountMatch =
    text.match(/([$£€¥])\s*([\d,]+\.?\d*)/) ||
    text.match(/([\d,]+\.?\d*)\s*([$£€¥])/);
  const amount = amountMatch
    ? parseRegionMoney(amountMatch[0], currency)
    : parseRegionMoney("0", currency);

  // Extract card info
  const cardMatch =
    text.match(/(Visa|Mastercard|Amex|Discover)[^*]*(\*{3,4}\d{4})/i) ||
    text.match(/(\*{3,4}\d{4})/);
  const cardInfo = cardMatch ? cardMatch[0].trim() : "";

  // Extract vendor
  let vendor = text
    .replace(/\d{3}-\d{7}-\d{7}/g, "")
    .replace(/([$£€¥])\s*[\d,]+\.?\d*/g, "")
    .replace(/([\d,]+\.?\d*)\s*([$£€¥])/g, "")
    .replace(/(Visa|Mastercard|Amex|Discover)[^*]*\*{3,4}\d{4}/gi, "")
    .replace(/\*{3,4}\d{4}/g, "")
    .replace(/\w+\s+\d{1,2},?\s+\d{4}/g, "")
    .replace(/\d{1,2}\s+\w+\s+\d{4}/g, "")
    .replace(/Pending|Charged|Completed|Refunded/gi, "")
    .trim();

  vendor = vendor.split(/\s{2,}|\n/)[0]?.trim() || "";

  return {
    date,
    orderIds,
    amount,
    cardInfo,
    vendor,
    platformData: { source: "transactions-page" },
  };
}

interface PageSignature {
  dateText: string;
  lastDateText: string;
  firstRow: string;
  lastRow: string;
  rowCount: number;
}

/**
 * Cheap page fingerprint used to detect a completed page transition:
 * the first and last date headers plus the first and last transaction
 * rows. Both ends matter: on the button-paginated variant a turn
 * replaces the whole list (first row changes), while on the
 * accumulating scroll variant the newest rows stay pinned and only
 * the tail grows (row count and last row change).
 */
async function readPageSignature(page: Page): Promise<PageSignature> {
  return page.evaluate((selector: string) => {
    const browserWindow = globalThis as unknown as BrowserWindow;
    const dateEls = browserWindow.document.querySelectorAll(
      ".apx-transaction-date-container",
    );
    const rows = browserWindow.document.querySelectorAll(selector);
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      dateText: dateEls[0]?.textContent?.trim() || "",
      lastDateText: dateEls[dateEls.length - 1]?.textContent?.trim() || "",
      firstRow: first?.textContent?.trim() || "",
      lastRow: last?.textContent?.trim() || "",
      rowCount: rows.length,
    };
  }, APX_TRANSACTION_SELECTOR);
}

function signatureChanged(
  before: PageSignature | null,
  after: PageSignature | null,
): boolean {
  if (!after || after.rowCount === 0) return false;
  if (!before) return true;
  return (
    after.rowCount !== before.rowCount ||
    after.dateText !== before.dateText ||
    after.lastDateText !== before.lastDateText ||
    after.firstRow !== before.firstRow ||
    after.lastRow !== before.lastRow
  );
}

/**
 * Date range covered by the currently rendered page, from its date
 * headers alone (no transaction extraction). Returns null when the page
 * has no APX date headers (legacy layouts) or an unparseable header.
 */
async function readPageDateRange(
  page: Page,
): Promise<{ newest: number; oldest: number } | null> {
  const texts = await page
    .evaluate(() => {
      const browserWindow = globalThis as unknown as BrowserWindow;
      return Array.from(
        browserWindow.document.querySelectorAll(
          ".apx-transaction-date-container",
        ),
      ).map((el) => el.textContent?.trim() || "");
    })
    .catch(() => [] as string[]);

  if (texts.length === 0) return null;

  // Tolerate individual unparseable headers (section labels and other
  // non-date containers share the class on some page variants); one bad
  // header must not disable the seek for the whole walk.
  const times: number[] = [];
  for (const text of texts) {
    const parsed = parseDate(text);
    if (parsed) times.push(parsed.getTime());
  }
  if (times.length === 0) return null;
  return { newest: Math.max(...times), oldest: Math.min(...times) };
}

/**
 * Advance to the next page of transactions.
 * Reports whether navigation happened and, when it did not, why not
 * (no control, vanished button, or clicks that produced no transition).
 *
 * The paginated page uses a form-submit button:
 *   <input name="ppw-widgetEvent:DefaultNextPageNavigationEvent:..." type="submit">
 * (disabled buttons have no such input / carry the disabled attribute).
 * Clicking it swaps the list via XHR without a document navigation.
 *
 * Transition detection polls the page signature from Node instead of a
 * single in-page waitForFunction: rAF-driven polling can stall in
 * backgrounded/headless browser contexts, which previously made slow
 * transitions look like failures and ended deep walks early. A click
 * that produces no change is retried (up to 3 attempts) before giving
 * up, so one swallowed click no longer terminates the walk.
 * Falls back to scrolling for legacy infinite-scroll layouts.
 */
interface NextPageResult {
  advanced: boolean;
  /** Machine-readable reason: advanced | legacy_scroll | click_no_transition | button_vanished | no_next_control */
  reason: string;
}

async function goToNextPage(page: Page): Promise<NextPageResult> {
  const nextButton = page.locator(
    'input[name*="DefaultNextPageNavigationEvent"]:not([disabled])',
  );

  const count = await nextButton.count().catch(() => 0);
  if (count > 0) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readPageSignature(page).catch(
        () => null as PageSignature | null,
      );
      await nextButton
        .first()
        .click({ noWaitAfter: true })
        .catch(() => {});

      const deadline = Date.now() + APX_PAGE_TRANSITION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await page.waitForTimeout(300);
        const after = await readPageSignature(page).catch(
          () => null as PageSignature | null,
        );
        if (signatureChanged(before, after)) {
          return { advanced: true, reason: "advanced" };
        }
      }

      // No visible change: if the button is gone the walk is over,
      // otherwise retry the click (it may have been swallowed).
      const stillThere = await nextButton.count().catch(() => 0);
      if (stillThere === 0) {
        return { advanced: false, reason: "button_vanished" };
      }
    }
    return { advanced: false, reason: "click_no_transition" };
  }

  // "Load more" button variant (seen on some accounts instead of the
  // ppw Next input): clicking it appends the next chunk of transactions.
  const loadMore = page
    .locator('button, [role="button"], a')
    .filter({ hasText: /^\s*load more\s*$/i });
  const loadMoreCount = await loadMore.count().catch(() => 0);
  if (loadMoreCount > 0) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readPageSignature(page).catch(
        () => null as PageSignature | null,
      );
      await loadMore
        .first()
        .click({ timeout: 3000, noWaitAfter: true })
        .catch(() => {});

      const deadline = Date.now() + APX_PAGE_TRANSITION_TIMEOUT_MS;
      let grew = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(300);
        const after = await readPageSignature(page).catch(
          () => null as PageSignature | null,
        );
        if (signatureChanged(before, after)) {
          grew = true;
          break;
        }
      }
      if (grew) {
        return { advanced: true, reason: "load_more" };
      }
    }
    return { advanced: false, reason: "load_more_no_transition" };
  }

  // Legacy infinite-scroll layout: scroll to load more, then WAIT for
  // the list to actually grow. (This branch previously returned success
  // unconditionally after a 500ms pause, so walks on scroll-variant
  // pages "advanced" through unchanged content until the stable guard
  // stopped them far from the target window.)
  const lastTransaction = page
    .locator('[data-testid="transaction-link"], .transactions-line-item')
    .last();

  const exists = await lastTransaction.count().catch(() => 0);
  if (exists > 0) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await readPageSignature(page).catch(
        () => null as PageSignature | null,
      );
      await lastTransaction.scrollIntoViewIfNeeded().catch(() => {});
      // The list lives in its own scrollable container on this variant:
      // scroll every scrollable ancestor of the rows (and the window),
      // then wheel over the list — the widget loads more on those
      // events, not on window scroll alone.
      await page
        .evaluate((selector: string) => {
          const browserWindow = globalThis as unknown as BrowserWindow & {
            scrollTo: (x: number, y: number) => void;
            document: BrowserDocument & { body: { scrollHeight: number } };
          };
          const rows = browserWindow.document.querySelectorAll(selector);
          const first = rows[0] as unknown as
            | { parentElement: unknown }
            | undefined;
          let el = first?.parentElement as {
            scrollHeight: number;
            clientHeight: number;
            scrollTop: number;
            parentElement: unknown;
          } | null;
          while (el) {
            if (el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight;
            }
            el = el.parentElement as typeof el;
          }
          browserWindow.scrollTo(
            0,
            browserWindow.document.body.scrollHeight,
          );
        }, APX_TRANSACTION_SELECTOR)
        .catch(() => {});
      const box = await page
        .locator(APX_TRANSACTION_SELECTOR)
        .first()
        .boundingBox()
        .catch(() => null);
      if (box) {
        await page.mouse
          .move(box.x + box.width / 2, box.y + box.height / 2)
          .catch(() => {});
        await page.mouse.wheel(0, 6000).catch(() => {});
      }

      const deadline = Date.now() + APX_PAGE_TRANSITION_TIMEOUT_MS;
      let grew = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(300);
        const after = await readPageSignature(page).catch(
          () => null as PageSignature | null,
        );
        if (signatureChanged(before, after)) {
          grew = true;
          break;
        }
      }
      if (grew) {
        return { advanced: true, reason: "legacy_scroll" };
      }
    }
    return { advanced: false, reason: "scroll_no_growth" };
  }

  return { advanced: false, reason: "no_next_control" };
}

/**
 * Merge transactions, removing duplicates.
 */
function mergeTransactions(
  existing: Transaction[],
  newTransactions: Transaction[],
): Transaction[] {
  const seen = new Set<string>();
  const merged: Transaction[] = [];

  for (const t of [...existing, ...newTransactions]) {
    // Create unique key from date + orderIds + amount
    const key = `${t.date.toISOString()}-${t.orderIds.sort().join(",")}-${t.amount.amount}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(t);
    }
  }

  return merged;
}
