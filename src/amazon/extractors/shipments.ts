/**
 * Shipment extraction from Amazon order pages.
 * Extracts tracking information, delivery status, and shipment items.
 */

import { Locator, Page } from "playwright";
import {
  Shipment,
  DeliveryStatus,
  ShipmentTransaction,
} from "../../core/types/shipment";
import { Item } from "../../core/types/item";
import { OrderHeader } from "../../core/types/order";
import { parseMoney } from "../../core/types/money";
import {
  getTextByXPath,
  getAttributeByXPath,
  firstMatchingStrategy,
} from "../../core/utils/extraction";
import { getRegionByCode } from "../regions";
import { extractItems, extractItemsFromContainer } from "./items";

/**
 * Parse delivery status from text.
 */
function parseDeliveryStatus(text: string): DeliveryStatus {
  const lowerText = text.toLowerCase();

  if (
    lowerText.includes("delivered") ||
    lowerText.includes("entregado") ||
    lowerText.includes("livré")
  ) {
    return DeliveryStatus.YES;
  }

  if (
    lowerText.includes("shipping") ||
    lowerText.includes("in transit") ||
    lowerText.includes("out for delivery") ||
    lowerText.includes("arriving") ||
    lowerText.includes("expected") ||
    lowerText.includes("on the way")
  ) {
    return DeliveryStatus.NO;
  }

  return DeliveryStatus.UNKNOWN;
}

/**
 * Extract tracking link from shipment element using XPath.
 * AZAD patterns for tracking URLs:
 * - /progress-tracker/
 * - /ship-track
 * - trackingId parameter
 */
export async function extractTrackingFromElement(
  page: Page,
  shipmentElement: string,
): Promise<{ trackingLink: string; trackingId: string }> {
  // Try multiple selectors for tracking link
  const trackingSelectors = [
    `${shipmentElement}//a[contains(@href, "track")]`,
    `${shipmentElement}//a[contains(text(), "Track")]`,
    `${shipmentElement}//a[contains(@href, "ship-track")]`,
    `${shipmentElement}//a[contains(@class, "track")]`,
  ];

  for (const selector of trackingSelectors) {
    const href = await getAttributeByXPath(page, selector, "href", "");
    if (href) {
      // Extract tracking ID from URL or text
      const trackingMatch =
        href.match(/trackingId=([^&]+)/i) ||
        href.match(/tracking[_-]?id=([^&]+)/i);
      const trackingId = trackingMatch ? trackingMatch[1] : "";

      return { trackingLink: href, trackingId };
    }
  }

  return { trackingLink: "", trackingId: "" };
}

/**
 * Strategy A (AZAD): Traditional shipment boxes with class "shipment"
 * XPath: //div[contains(@class, "a-box shipment")]
 * Then filter to elements where class list includes "shipment" exactly
 */
async function extractShipmentsStrategyA(
  page: Page,
  header: OrderHeader,
  items: Item[],
): Promise<Shipment[] | null> {
  // AZAD's exact selector - a-box with shipment class
  const candidates = await page
    .locator(
      'xpath=//div[contains(@class, "a-box") and contains(@class, "shipment")]',
    )
    .all();

  // Filter to only those with "shipment" as an exact class (not just containing "shipment" in another class name)
  const shipmentBoxes: typeof candidates = [];
  for (const candidate of candidates) {
    const classAttr = await candidate.getAttribute("class").catch(() => "");
    if (classAttr) {
      const classes = classAttr.split(" ");
      if (classes.includes("shipment")) {
        shipmentBoxes.push(candidate);
      }
    }
  }

  if (shipmentBoxes.length === 0) return null;

  const regionConfig = getRegionByCode(header.region);
  const currency = regionConfig?.currency || "USD";
  const shipments: Shipment[] = [];

  for (let i = 0; i < shipmentBoxes.length; i++) {
    const box = shipmentBoxes[i];

    try {
      // Get delivery status - check class for shipment-is-delivered or text content
      const classAttr = await box.getAttribute("class").catch(() => "");
      let delivered = DeliveryStatus.UNKNOWN;

      if (classAttr?.includes("shipment-is-delivered")) {
        delivered = DeliveryStatus.YES;
      } else {
        // Check text content for delivery indicators
        const text = await box.textContent().catch(() => "");
        delivered = parseDeliveryStatus(text || "");
      }

      // Get status text from AZAD XPath. Bounded timeouts: a missing
      // sub-element must fail fast, not burn the 30s default timeout.
      const statusText =
        (await box
          .locator(
            'xpath=.//div[contains(@class, "shipment-info-container")]//div[@class="a-row"]/span',
          )
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => "")) ||
        (await box
          .locator('[data-component="shipmentStatus"]')
          .first()
          .textContent({ timeout: 1000 })
          .catch(() => ""));

      // Get tracking link using AZAD's XPaths
      let trackingLink =
        (await box
          .locator('a[href*="/progress-tracker/"]')
          .first()
          .getAttribute("href", { timeout: 1000 })
          .catch(() => "")) ||
        (await box
          .locator('a[href*="/ship-track"]')
          .first()
          .getAttribute("href", { timeout: 1000 })
          .catch(() => ""));

      // Normalize tracking link
      if (trackingLink && !trackingLink.startsWith("http")) {
        trackingLink = `https://www.${getRegionByCode(header.region)?.domain}${trackingLink}`;
      }

      // Extract shipment ID from tracking link
      let shipmentId = `${header.orderId}-shipment-${i + 1}`;
      if (trackingLink) {
        const shipmentMatch = trackingLink.match(/shipmentId=([^&]+)/);
        if (shipmentMatch) shipmentId = shipmentMatch[1];
      }

      // Get tracking ID (would need to fetch tracking page for full ID)
      const trackingIdMatch = trackingLink?.match(/trackingId=([^&]+)/);
      const trackingId = trackingIdMatch ? trackingIdMatch[1] : "";

      // Get items in this shipment (for now, associate all items with first shipment)
      const shipmentItems = i === 0 ? items : [];

      // Try to extract transaction info using AZAD's pattern
      let transaction: ShipmentTransaction | undefined;
      const transactionText = await box
        .locator(
          'xpath=.//span[normalize-space(text())="Transactions"]/../../div[contains(@class, "expander")]//div[contains(@class, "a-row")]',
        )
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => "");
      if (transactionText) {
        // Parse "December 17, 2023 - Visa ending in 8489: $41.49" format
        const amountMatch = transactionText.match(/[$£€]\s*[\d,]+\.?\d*/);
        if (amountMatch) {
          transaction = {
            paymentAmount: parseMoney(amountMatch[0], currency),
            infoString: transactionText
              .replace(/[$£€]\s*[\d,]+\.?\d*/, "")
              .trim(),
          };
        }
      }

      // Check for refund using AZAD's XPath
      let refund;
      const refundText = await box
        .locator(
          'xpath=.//span[contains(text(), "Refund for this return")]/../../../../..//span',
        )
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => "");
      if (refundText) {
        refund = parseMoney(refundText, currency);
        if (refund.amount === 0) refund = undefined;
      }

      shipments.push({
        shipmentId,
        orderHeader: header,
        items: shipmentItems,
        delivered,
        status: statusText?.trim() || "Unknown",
        trackingLink: trackingLink || "",
        trackingId,
        transaction,
        refund,
        platformData: {},
      });
    } catch {
      continue;
    }
  }

  return shipments.length > 0 ? shipments : null;
}

/**
 * Result from ship-track page extraction.
 */
export interface ShipTrackPageData {
  trackingId: string;
  carrier: string;
}

/**
 * Extract tracking info from a ship-track page.
 * Gets both tracking number and carrier name.
 *
 * Tracking number patterns:
 * - Amazon Logistics: AZ + 9 digits + 2-letter suffix (e.g., AZ218181365JE)
 * - Amazon Logistics: TBA followed by digits (e.g., TBA123456789)
 * - Royal Mail: 2-letter prefix + 9 digits + 2-letter suffix (e.g., AA123456789GB)
 * - Hermes/Evri: 16-digit number
 * - DPD: Various alphanumeric formats
 *
 * Carrier patterns (UK examples):
 * - "Delivery By JERSEY_POST"
 * - "Delivery By Whistl Group"
 * - "Shipped with Royal Mail"
 */
export async function extractTrackingInfoFromPage(
  page: Page,
): Promise<ShipTrackPageData> {
  const result: ShipTrackPageData = { trackingId: "", carrier: "" };

  try {
    // Extract tracking number
    const trackingSelectors = [
      // Progress tracker page selectors
      ".pt-delivery-card-trackingId",
      '[data-test-id="tracking-number"]',
      ".carrierRelatedInfo-trackingId-text",
      // Ship-track page selectors
      ".a-row.pt-carrier-tracking-id",
      ".ship-track-grid-content .a-text-bold",
      // Generic patterns
      '[class*="tracking"] .a-text-bold',
      '[class*="tracking-id"]',
      '[class*="trackingId"]',
    ];

    for (const selector of trackingSelectors) {
      const el = page.locator(selector).first();
      const count = await el.count().catch(() => 0);
      if (count > 0) {
        const text = await el.textContent({ timeout: 500 }).catch(() => "");
        if (text) {
          const cleaned = text.trim();
          const trackingNumber = validateTrackingNumber(cleaned);
          if (trackingNumber) {
            result.trackingId = trackingNumber;
            break;
          }
        }
      }
    }

    // Fallback: search page text for carrier patterns
    const pageText = await page.textContent("body").catch(() => "");
    if (pageText) {
      // Look for tracking ID if not found yet
      if (!result.trackingId) {
        const trackingMatch = pageText.match(
          /Tracking\s*ID:?\s*([A-Z0-9]{10,20})/i,
        );
        if (trackingMatch) {
          const trackingNumber = validateTrackingNumber(trackingMatch[1]);
          if (trackingNumber) result.trackingId = trackingNumber;
        }
      }

      // Look for carrier patterns - be very specific to avoid false matches
      // UK patterns: "Delivery By JERSEY_POST", "Delivery By Whistl Group", "Delivery By Royal Mail"
      // The carrier name should be relatively short (not a product name)
      if (!result.carrier) {
        // Pattern 1: "Delivery By CARRIER_NAME" (uppercase with underscores)
        const deliveryByMatch = pageText.match(
          /Delivery\s+By\s+([A-Z][A-Z0-9_]{2,30})\b/,
        );
        if (deliveryByMatch) {
          result.carrier = deliveryByMatch[1].trim();
        }
      }

      if (!result.carrier) {
        // Pattern 2: "Delivery By Carrier Name" (title case, max 3 words)
        const deliveryByTitleMatch = pageText.match(
          /Delivery\s+By\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/,
        );
        if (deliveryByTitleMatch) {
          const carrier = deliveryByTitleMatch[1].trim();
          // Validate it's not a product name (too long or contains certain words)
          if (
            carrier.length <= 30 &&
            !carrier.includes("Amazon") &&
            !carrier.includes("Fujitsu")
          ) {
            result.carrier = carrier;
          }
        }
      }

      if (!result.carrier) {
        // Pattern 3: "Shipped with CARRIER" or "Carrier: CARRIER"
        const shippedMatch = pageText.match(
          /(?:Shipped\s+with|Carrier:?)\s+([A-Z][A-Za-z0-9_\s]{2,25}?)(?:\.|,|\n|$)/i,
        );
        if (shippedMatch) {
          const carrier = shippedMatch[1].trim();
          if (carrier.length <= 25) {
            result.carrier = carrier;
          }
        }
      }
    }

    return result;
  } catch {
    return result;
  }
}

/**
 * Extract carrier tracking number from a ship-track page (legacy function).
 * @deprecated Use extractTrackingInfoFromPage instead
 */
export async function extractTrackingNumberFromPage(
  page: Page,
): Promise<string> {
  const info = await extractTrackingInfoFromPage(page);
  return info.trackingId;
}

/**
 * Validate and return a tracking number if it matches known patterns.
 */
function validateTrackingNumber(text: string): string | null {
  const cleaned = text.trim().toUpperCase();

  // Amazon Logistics: AZ + 9 digits + 2 letters (e.g., AZ218181365JE)
  if (/^AZ\d{9}[A-Z]{2}$/.test(cleaned)) return cleaned;

  // Amazon Logistics: TBA + digits (e.g., TBA123456789)
  if (/^TBA\d+$/.test(cleaned)) return cleaned;

  // Royal Mail: 2 letters + 9 digits + 2 letters (e.g., AA123456789GB)
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(cleaned)) return cleaned;

  // Hermes/Evri: 16 digits
  if (/^\d{16}$/.test(cleaned)) return cleaned;

  // DPD UK: 14 digits or alphanumeric
  if (/^\d{14}$/.test(cleaned)) return cleaned;

  // Generic alphanumeric 10-20 chars (covers DPD, UPS, FedEx, etc.)
  if (/^[A-Z0-9]{10,20}$/.test(cleaned)) return cleaned;

  // Generic long number (10+ digits)
  if (/^\d{10,}$/.test(cleaned)) return cleaned;

  return null;
}

/**
 * Strategy B (AZAD): 2024+ layout with data-component attributes
 * This is the primary strategy for modern Amazon pages.
 *
 * Structure from HTML (verified live 2026-10-17):
 * - [data-component="shipments"] - the order's shipments container. There is
 *   exactly ONE per order and it holds EVERY shipment group of the order
 *   (an order with 3 shipments showed shipments=1 but shipmentsLeftGrid=3,
 *   shipmentStatus=3, purchasedItems=3). Treating the container itself as
 *   one shipment collapses all groups into a single bogus shipment.
 *   - one shipment group per [data-component="shipmentStatus"]:
 *     - [data-component="shipmentsLeftGrid"] wraps the status
 *     - [data-component="shipmentStatus"] - delivery status text
 *     - [data-component="shipmentConnections"] - tracking buttons
 *       - a[href*="ship-track"] - "Track package" button with tracking URL
 *     - [data-component="purchasedItems"] - items in this shipment
 *
 * Groups are located by marking, for each shipmentStatus, the highest
 * ancestor below the shipments container that still contains only that one
 * status (the group root), then processing each marked root with locators.
 */
const SHIPMENT_GROUP_ATTRIBUTE = "data-mcp-shipment-group";

async function markShipmentGroups(container: Locator): Promise<void> {
  // For each shipmentStatus, its group root is the highest ancestor that
  // still contains only that one status (ancestors spanning several groups
  // contain 2+ statuses and are excluded by the count predicate). Marking
  // is idempotent, so statuses sharing a root collapse to one group.
  const statuses = await container
    .locator('[data-component="shipmentStatus"]')
    .all();
  for (const status of statuses) {
    const root = status
      .locator(
        'xpath=ancestor::*[count(.//*[@data-component="shipmentStatus"])=1][last()]',
      )
      .first();
    if ((await root.count().catch(() => 0)) > 0) {
      await root
        .evaluate((el, attr) => el.setAttribute(attr, ""), SHIPMENT_GROUP_ATTRIBUTE)
        .catch(() => {});
    }
  }
}

async function extractShipmentsStrategyB(
  page: Page,
  header: OrderHeader,
  items: Item[],
  timings?: Record<string, number>,
): Promise<Shipment[] | null> {
  const regionConfig = getRegionByCode(header.region);
  const currency = regionConfig?.currency || "USD";

  const tContainers = Date.now();
  const containers = await page.locator('[data-component="shipments"]').all();

  const groupRoots: Locator[] = [];
  let markingMs = 0;
  if (containers.length > 0) {
    for (const container of containers) {
      const tMark = Date.now();
      await markShipmentGroups(container);
      markingMs += Date.now() - tMark;
      const marked = await container
        .locator(`[${SHIPMENT_GROUP_ATTRIBUTE}]`)
        .all();
      if (marked.length > 0) {
        groupRoots.push(...marked);
      } else {
        // No status markers found: treat the whole container as one group.
        groupRoots.push(container);
      }
    }
  } else {
    // Fallback: legacy XPath for group-shaped boxes (AZAD).
    const boxes = await page
      .locator(
        'xpath=//div[div[@data-component="shipmentsLeftGrid"]/div[div[@data-component="shipmentStatus"]]]',
      )
      .all();
    groupRoots.push(...boxes);
  }

  if (timings) {
    timings.b_containersMs = Date.now() - tContainers - markingMs;
    timings.b_markingMs = markingMs;
    timings.b_groupCount = groupRoots.length;
  }

  if (groupRoots.length === 0) return null;

  const shipments: Shipment[] = [];

  const tGroupLoop = Date.now();
  for (let i = 0; i < groupRoots.length; i++) {
    const group = groupRoots[i];

    try {
      // Status from this group's shipmentStatus component
      const statusEl = group
        .locator('[data-component="shipmentStatus"]')
        .first();
      let statusText = "";
      if ((await statusEl.count().catch(() => 0)) > 0) {
        const statusMsgEl = statusEl
          .locator(".od-status-message, h4, .a-text-bold")
          .first();
        statusText =
          (await statusMsgEl
            .textContent({ timeout: 1000 })
            .catch(() => "")) || "";
        if (!statusText) {
          statusText =
            (await statusEl.textContent({ timeout: 1000 }).catch(() => "")) ||
            "";
        }
      }
      statusText = statusText.replace(/\s+/g, " ").trim();

      const groupText =
        (await group.textContent({ timeout: 1000 }).catch(() => "")) || "";
      const delivered = parseDeliveryStatus(statusText || groupText);

      // Tracking link scoped to this group
      let trackingLink = "";
      const trackBtn = group
        .locator(
          '[data-component="shipmentConnections"] a[href*="ship-track"], a[href*="ship-track"]',
        )
        .first();
      if ((await trackBtn.count().catch(() => 0)) > 0) {
        trackingLink =
          (await trackBtn
            .getAttribute("href", { timeout: 1000 })
            .catch(() => "")) || "";
      }
      if (!trackingLink) {
        // No anchor tracking link in this group is common (the track
        // button is often JS-driven). This read MUST stay bounded: on an
        // empty locator an unbounded getAttribute waits the full 30s
        // default timeout — per group.
        trackingLink =
          (await group
            .locator('a[href*="/progress-tracker/"]')
            .first()
            .getAttribute("href", { timeout: 1000 })
            .catch(() => "")) || "";
      }
      if (trackingLink && !trackingLink.startsWith("http")) {
        trackingLink = `https://www.${getRegionByCode(header.region)?.domain}${trackingLink}`;
      }

      let shipmentId = `${header.orderId}-shipment-${i + 1}`;
      if (trackingLink) {
        const shipmentMatch = trackingLink.match(/shipmentId=([^&]+)/);
        if (shipmentMatch) shipmentId = shipmentMatch[1];
      }
      const trackingIdMatch = trackingLink?.match(/trackingId=([^&]+)/);
      const trackingId = trackingIdMatch ? trackingIdMatch[1] : "";

      // Items belonging to this group, from its own purchasedItems blocks
      const purchasedContainers = await group
        .locator('[data-component="purchasedItems"]')
        .all();
      let groupItems: Item[] = [];
      for (const purchased of purchasedContainers) {
        groupItems.push(
          ...(await extractItemsFromContainer(purchased, header, currency)),
        );
      }
      if (groupItems.length === 0 && groupRoots.length === 1) {
        groupItems = items;
      }

      shipments.push({
        shipmentId,
        orderHeader: header,
        items: groupItems,
        delivered,
        status: statusText || "Unknown",
        trackingLink: trackingLink || "",
        trackingId,
        platformData: { itemCount: purchasedContainers.length },
      });
    } catch {
      continue;
    }
  }
  if (timings) timings.b_groupLoopMs = Date.now() - tGroupLoop;

  if (shipments.length === 0) return null;

  // Grouping produced no items at all although the order has items: the
  // group detection misfired on an unexpected layout. Fall back to a
  // single shipment carrying all items rather than losing them.
  const totalGroupItems = shipments.reduce((n, s) => n + s.items.length, 0);
  if (totalGroupItems === 0 && items.length > 0) {
    return [
      {
        shipmentId: `${header.orderId}-shipment-1`,
        orderHeader: header,
        items,
        delivered: shipments[0].delivered,
        status: shipments[0].status,
        trackingLink: shipments[0].trackingLink,
        trackingId: shipments[0].trackingId,
        platformData: {},
      },
    ];
  }

  return shipments;
}

/**
 * Strategy 1: Tracking package sections
 */
async function extractShipmentsStrategy1(
  page: Page,
  header: OrderHeader,
  items: Item[],
): Promise<Shipment[] | null> {
  const trackingSections = await page
    .locator('[id*="tracking"], [class*="tracking-package"]')
    .all();
  if (trackingSections.length === 0) return null;

  const shipments: Shipment[] = [];

  for (let i = 0; i < trackingSections.length; i++) {
    const section = trackingSections[i];

    try {
      const statusText = await section.textContent().catch(() => "");
      const delivered = parseDeliveryStatus(statusText || "");

      // Look for tracking link
      const trackingLink =
        (await section
          .locator('a[href*="track"]')
          .first()
          .getAttribute("href", { timeout: 1000 })
          .catch(() => "")) || "";
      const trackingIdMatch = trackingLink.match(/trackingId=([^&]+)/i);
      const trackingId = trackingIdMatch ? trackingIdMatch[1] : "";

      shipments.push({
        shipmentId: `${header.orderId}-tracking-${i + 1}`,
        orderHeader: header,
        items: i === 0 ? items : [],
        delivered,
        status: statusText?.slice(0, 100).trim() || "Unknown",
        trackingLink,
        trackingId,
        platformData: {},
      });
    } catch {
      continue;
    }
  }

  return shipments.length > 0 ? shipments : null;
}

/**
 * Strategy 2: Delivery status sections (2024+ layout)
 */
async function extractShipmentsStrategy2(
  page: Page,
  header: OrderHeader,
  items: Item[],
): Promise<Shipment[] | null> {
  const deliverySections = await page
    .locator('[data-component="deliveryStatus"], .delivery-box')
    .all();
  if (deliverySections.length === 0) return null;

  const shipments: Shipment[] = [];

  for (let i = 0; i < deliverySections.length; i++) {
    const section = deliverySections[i];

    try {
      // Get primary status message
      const statusText = await section
        .locator('.a-color-success, .a-color-state, [class*="status"]')
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => "");
      const delivered = parseDeliveryStatus(statusText || "");

      // Get tracking info
      const trackingLink =
        (await section
          .locator('a[href*="track"]')
          .first()
          .getAttribute("href", { timeout: 1000 })
          .catch(() => "")) || "";
      let trackingId = "";

      // Try to get tracking number from visible text
      const trackingNumText = await section
        .locator(':text-matches("\\\\d{10,}")')
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => "");
      if (trackingNumText) {
        const match = trackingNumText.match(/\d{10,}/);
        if (match) trackingId = match[0];
      }

      shipments.push({
        shipmentId: `${header.orderId}-delivery-${i + 1}`,
        orderHeader: header,
        items: i === 0 ? items : [],
        delivered,
        status: statusText?.trim() || "Unknown",
        trackingLink,
        trackingId,
        platformData: {},
      });
    } catch {
      continue;
    }
  }

  return shipments.length > 0 ? shipments : null;
}

/**
 * Strategy 3: Single shipment fallback (create from order details)
 */
async function extractShipmentsStrategy3(
  page: Page,
  header: OrderHeader,
  items: Item[],
): Promise<Shipment[] | null> {
  // Look for any delivery message on the page
  const deliveryText = await getTextByXPath(
    page,
    '//*[contains(text(), "Delivered") or contains(text(), "Arriving") or contains(text(), "Shipped")]',
    "",
  );

  if (!deliveryText && items.length === 0) return null;

  const delivered = parseDeliveryStatus(deliveryText);

  // Try to find any tracking link on the page
  const trackingLink = await getAttributeByXPath(
    page,
    '//a[contains(@href, "track") or contains(text(), "Track")]',
    "href",
    "",
  );

  return [
    {
      shipmentId: `${header.orderId}-shipment-1`,
      orderHeader: header,
      items,
      delivered,
      status: deliveryText.slice(0, 100).trim() || "Unknown",
      trackingLink,
      trackingId: "",
      platformData: {},
    },
  ];
}

/**
 * Options for shipment extraction.
 */
export interface ExtractShipmentsOptions {
  /** Visit ship-track pages to get actual carrier tracking numbers (slower but complete) */
  fetchTrackingNumbers?: boolean;
  /**
   * Items already extracted for this order by the caller. When provided,
   * the extractor does not run its own item extraction pass (callers such
   * as fetchOrders have usually just extracted the same items from the
   * invoice or detail page, and re-extracting them doubles the work).
   */
  items?: Item[];
  /**
   * Optional out-param: filled with the duration (ms) of each shipment
   * strategy attempted, keyed by strategy name. Strategies after the
   * first successful one do not run and get no entry.
   */
  strategyTimings?: Record<string, number>;
}

/**
 * Extract shipments from an order detail page.
 */
export async function extractShipments(
  page: Page,
  header: OrderHeader,
  options: ExtractShipmentsOptions = {},
): Promise<Shipment[]> {
  const { fetchTrackingNumbers = false } = options;

  // Use caller-provided items when available; extract only as a fallback.
  let items = options.items;
  if (!items) {
    const tItems = Date.now();
    items = await extractItems(page, header);
    const ms = Date.now() - tItems;
    if (options.strategyTimings) options.strategyTimings.itemsMs = ms;
    console.error(`[shipments][timing] itemsExtraction: ${ms}ms`);
  }

  // Try each extraction strategy (AZAD order: A, B, then fallbacks),
  // timing each attempt so slow stages are visible in the server log.
  const timed = async (
    name: string,
    fn: () => Promise<Shipment[] | null>,
  ): Promise<Shipment[] | null> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - start;
      if (options.strategyTimings) options.strategyTimings[name] = ms;
      console.error(`[shipments][timing] ${name}: ${ms}ms`);
    }
  };
  const shipments = await firstMatchingStrategy<Shipment[]>(
    [
      () => timed("strategyA", () => extractShipmentsStrategyA(page, header, items)), // AZAD's a-box.shipment
      () => timed("strategyB", () => extractShipmentsStrategyB(page, header, items, options.strategyTimings)), // AZAD's data-component 2024+
      () => timed("strategy2", () => extractShipmentsStrategy2(page, header, items)), // Delivery status sections
      () => timed("strategy1", () => extractShipmentsStrategy1(page, header, items)), // Tracking sections
      () => timed("strategy3", () => extractShipmentsStrategy3(page, header, items)), // Fallback single shipment
    ],
    [],
  );

  // If requested, visit each ship-track page to get tracking numbers and carrier info
  if (fetchTrackingNumbers) {
    const detailUrl = page.url(); // Save current URL to return to

    for (const shipment of shipments) {
      // Skip if no tracking link, but still visit if we need carrier info
      if (!shipment.trackingLink) continue;
      // Skip if we already have both tracking ID and carrier
      if (shipment.trackingId && shipment.carrier) continue;

      try {
        // Navigate to ship-track page
        await page.goto(shipment.trackingLink, {
          waitUntil: "domcontentloaded",
          timeout: 10000,
        });

        // Wait for tracking info to load
        await page
          .waitForSelector(
            '.carrierRelatedInfo, [class*="tracking"], .pt-delivery-card',
            {
              timeout: 3000,
            },
          )
          .catch(() => {});

        // Extract tracking number and carrier from page
        const trackingInfo = await extractTrackingInfoFromPage(page);
        if (trackingInfo.trackingId && !shipment.trackingId) {
          shipment.trackingId = trackingInfo.trackingId;
        }
        if (trackingInfo.carrier && !shipment.carrier) {
          shipment.carrier = trackingInfo.carrier;
        }
      } catch {
        // Continue if tracking page fails
      }
    }

    // Return to detail page
    if (detailUrl && !page.url().includes("order-details")) {
      await page
        .goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 10000 })
        .catch(() => {});
    }
  }

  return shipments;
}

/**
 * Check if an order has been fully delivered.
 */
export function isFullyDelivered(shipments: Shipment[]): boolean {
  if (shipments.length === 0) return false;
  return shipments.every((s) => s.delivered === DeliveryStatus.YES);
}

/**
 * Get combined tracking IDs for an order.
 */
export function getTrackingIds(shipments: Shipment[]): string[] {
  return shipments.map((s) => s.trackingId).filter((id) => id.length > 0);
}
