/*!
 * QR download link parser for gamers520.com.
 * Links are resolved locally from the QR generator URL or image pixels.
 * Dynamic and lazy-loaded content is handled through DOM observation.
 */

(function () {
  "use strict";

  if (window.__qrLinkifyInjected__) return;
  window.__qrLinkifyInjected__ = true;

  /** Tracks the source key last processed for each image. */
  const processedSources = new WeakMap();

  /** Keeps one result panel per download card: { panel, owner, signature, hiddenPwdBox }. */
  const panelsByContainer = new WeakMap();

  /** Pending copy-feedback reset timers, so rapid clicks don't clear each other early. */
  const copyFeedbackTimers = new WeakMap();

  const UI_TEXT = Object.freeze({
    open: "打开",
    copyCode: "复制提取码",
    copied: "已复制",
    copyFailed: "复制失败，请手动复制",
    openLink: "打开下载链接",
  });

  const PROVIDERS = Object.freeze([
    ["pan.baidu.com", "百度网盘", "baidu.svg"],
    ["pan.quark.cn", "夸克网盘", "kuake.svg"],
    ["pan.xunlei.com", "迅雷云盘", "xunlei.svg"],
    ["gofile.io", "GOFILE", "qr.svg"],
    ["aliyundrive.com", "阿里云盘", "ali.svg"],
    ["115.com", "115 网盘", "115.svg"],
    ["123pan.com", "123 云盘", "123.svg"],
    ["cloud.189.cn", "天翼云盘", "tianyi.svg"],
    ["lanzou", "蓝奏云", "lanzou.svg"],
  ]);

  const MAX_DECODE_SIDE_PX = 640;
  const COPY_FEEDBACK_DURATION_MS = 1800;
  const IDLE_PROCESSING_TIMEOUT_MS = 500;
  const MAX_QR_ANCESTOR_DEPTH = 4;

  const PANEL_CLASS = "qrto-link-panel";
  const PANEL_SELECTOR = `.${PANEL_CLASS}`;
  const CARD_SELECTOR = ".bdp-card, [class*='download-card'], [class*='qr-card'], td, li";
  const QR_BOX_SELECTOR = ".bdp-qrcode-box, [class*='qrcode-box'], [class*='qr-box']";
  const ORIGINAL_PWD_SELECTOR = ".bdp-pwd-box";
  const QR_CANDIDATE_SELECTOR = [
    "img[src*='qr' i]",
    "img[data-src*='qr' i]",
    "img[alt*='二维码']",
    "img[alt*='扫码']",
    "img[alt*='qrcode' i]",
    "img[alt*='qr code' i]",
    "[class*='qr' i] img",
  ].join(",");

  // ASCII-only so that adjacent Chinese text ("…/s/abc提取码:1234") is not swallowed into the URL.
  const URL_IN_TEXT_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/g;
  const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]]+$/;
  const PWD_PATTERNS = Object.freeze([
    /提取码\s*[:：]?\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/,
    /\bpwd\s*[:=]\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/i,
  ]);
  const VALID_PWD_PATTERN = /^[A-Za-z0-9]{4,8}$/;
  const CLOUD_DRIVE_HREF_PATTERN = /pan\.|gofile|quark|xunlei|drive|cloud|disk|123pan|lanzou/i;
  const PWD_PARAM_HOST_PATTERN = /pan\.(baidu|quark|xunlei)\./i;

  const pendingImages = new Set();
  let processingScheduled = false;

  /** Returns the distinct, non-empty sources an image may point to (lazy loaders keep the real one in data-src). */
  function getImageSources(img) {
    const sources = [img.currentSrc, img.getAttribute("src"), img.getAttribute("data-src")]
      .map((source) => (source || "").trim())
      .filter(Boolean);
    return Array.from(new Set(sources));
  }

  function getSourceKey(img) {
    return getImageSources(img).join("\n");
  }

  function isInsideOwnPanel(node) {
    return node instanceof Element && node.closest(PANEL_SELECTOR) !== null;
  }

  /** Determines whether an image is likely to contain a QR code. */
  function looksLikeQr(img) {
    if (isInsideOwnPanel(img)) return false;

    const src = getImageSources(img).join(" ");
    const alt = img.getAttribute("alt") || "";
    if (/qr(code|server)?/i.test(src)) return true;
    if (/二维码|扫码|perp/i.test(alt)) return true;
    let el = img.parentElement;
    for (let i = 0; el && i < MAX_QR_ANCESTOR_DEPTH; i++) {
      const cls = el.className;
      if (typeof cls === "string" && /qr/i.test(cls)) return true;
      el = el.parentElement;
    }
    return false;
  }

  function extractUrls(text) {
    const matches = text.match(URL_IN_TEXT_PATTERN) || [];
    return matches.map((url) => url.replace(TRAILING_PUNCTUATION_PATTERN, ""));
  }

  function extractPwd(text) {
    for (const pattern of PWD_PATTERNS) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  /** Reads the data parameter of a QR generator URL (e.g. api.qrserver.com/...?data=...). */
  function extractQrServerData(sources) {
    for (const source of sources) {
      try {
        const data = new URL(source, location.href).searchParams.get("data");
        if (data) return data;
      } catch {
        // Not a parsable URL (e.g. a malformed data-src); try the next source.
      }
    }
    return null;
  }

  function getCard(img) {
    return img.closest(CARD_SELECTOR) || img.parentElement;
  }

  /** Collects card text while skipping our own panel, so a previous result can't feed back into parsing. */
  function getScopeText(scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        isInsideOwnPanel(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const parts = [];
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
    return parts.join(" ");
  }

  /** Finds download metadata without leaking into neighbouring cards. */
  function extractFromDomContext(img) {
    const text = [
      img.getAttribute("alt") || "",
      img.getAttribute("title") || "",
    ];
    const scope = getCard(img);
    if (scope) text.push(getScopeText(scope));
    const fullText = text.join(" ");

    const urls = [];
    if (scope) {
      scope.querySelectorAll("a[href]").forEach((anchor) => {
        if (isInsideOwnPanel(anchor)) return;
        const href = anchor.href;
        if (/^https?:/.test(href) && CLOUD_DRIVE_HREF_PATTERN.test(href)) urls.push(href);
      });
    }
    urls.push(...extractUrls(fullText));

    return { urls, pwd: extractPwd(fullText) };
  }

  function decodeLoadedImage(image) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight || typeof window.jsQR !== "function") return null;

    const scale = Math.min(1, MAX_DECODE_SIDE_PX / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));

    try {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert",
      });
      return code ? code.data : null;
    } catch {
      // Tainted canvas (server without CORS headers) or decoder failure.
      return null;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * Decodes QR pixels locally with jsQR.
   * Requested in CORS mode only: a non-CORS cross-origin image would taint the canvas and
   * getImageData would throw anyway, so a retry without CORS only costs an extra request.
   */
  function decodeImage(img) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:image/gif")) return Promise.resolve(null);

    return new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.onload = () => resolve(decodeLoadedImage(image));
      image.onerror = () => resolve(null);
      image.src = src;
    });
  }

  /** Validates the URL, then appends the extraction code for drives that accept ?pwd=. */
  function normalizeUrl(rawUrl, pwd) {
    let url;
    try {
      url = new URL(rawUrl.replace(TRAILING_PUNCTUATION_PATTERN, ""));
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    if (pwd && PWD_PARAM_HOST_PATTERN.test(url.hostname) && !url.searchParams.has("pwd")) {
      url.searchParams.set("pwd", pwd);
    }
    return url;
  }

  function dedupeUrls(urls) {
    const seen = new Set();
    return urls.filter((url) => {
      const key = url.origin + url.pathname;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function findPwdInUrls(urls) {
    for (const url of urls) {
      const pwd = url.searchParams.get("pwd");
      if (pwd && VALID_PWD_PATTERN.test(pwd)) return pwd;
    }
    return null;
  }

  /** Resolves and renders the links for one QR image. */
  async function enhanceImage(img) {
    const sourceKey = getSourceKey(img);
    if (!sourceKey || processedSources.get(img) === sourceKey) return;
    processedSources.set(img, sourceKey);

    const sources = getImageSources(img);
    const ctx = extractFromDomContext(img);

    // Fastest and most reliable: the generator URL already carries the QR content.
    let qrContent = extractQrServerData(sources);
    if (!qrContent) qrContent = await decodeImage(img);

    // A newer source arrived while decoding; its own run will render the result.
    if (processedSources.get(img) !== sourceKey || !img.isConnected) return;

    // QR content may be a bare URL or text like "链接: https://… 提取码: abcd".
    let rawUrls = qrContent ? extractUrls(qrContent) : [];
    // Context links are only used as a fallback within the same download card.
    if (!rawUrls.length) rawUrls = ctx.urls;

    const explicitPwd =
      (qrContent && extractPwd(qrContent)) || ctx.pwd || extractPwd(sources.join(" "));

    const urls = dedupeUrls(
      rawUrls.map((url) => normalizeUrl(url, explicitPwd)).filter(Boolean)
    );
    const pwd = explicitPwd || findPwdInUrls(urls);

    renderResult(img, urls.map((url) => url.href), pwd);
  }

  function getProvider(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const provider = PROVIDERS.find(([domain]) => hostname.includes(domain));
      return {
        name: provider ? provider[1] : "",
        icon: provider ? provider[2] : "qr.svg",
      };
    } catch {
      return { name: "", icon: "qr.svg" };
    }
  }

  function createProviderIcon(iconName) {
    const icon = document.createElement("img");
    icon.src = chrome.runtime.getURL(`icons/${iconName}`);
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    icon.className = "qrto-action-icon";
    return icon;
  }

  function createLinkAction(url) {
    const provider = getProvider(url);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "bdp-btn qrto-link-action";
    a.appendChild(createProviderIcon(provider.icon));
    a.append(provider.name ? `${UI_TEXT.open}${provider.name}` : UI_TEXT.openLink);
    return a;
  }

  function createCopyButton(pwd) {
    const button = document.createElement("button");
    button.className = "qrto-copy-button";
    button.type = "button";
    button.dataset.qrtoCopyCode = pwd;
    button.setAttribute("aria-label", `${UI_TEXT.copyCode} ${pwd}`);

    const label = document.createElement("span");
    label.textContent = UI_TEXT.copyCode;
    const code = document.createElement("strong");
    code.textContent = pwd;
    const status = document.createElement("span");
    status.className = "qrto-copy-status";
    status.setAttribute("aria-live", "polite");

    button.append(label, code, status);
    return button;
  }

  function createPanel(urls, pwd) {
    const panel = document.createElement("div");
    panel.className = PANEL_CLASS;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", UI_TEXT.openLink);

    const list = document.createElement("div");
    list.className = "qrto-link-list";
    urls.forEach((url) => list.appendChild(createLinkAction(url)));
    panel.appendChild(list);

    if (pwd) panel.appendChild(createCopyButton(pwd));
    return panel;
  }

  function removePanel(card) {
    const record = panelsByContainer.get(card);
    if (!record) return;
    record.panel.remove();
    if (record.hiddenPwdBox) record.hiddenPwdBox.classList.remove("qrto-original-pwd-hidden");
    panelsByContainer.delete(card);
  }

  /** Renders a compact result as a sibling of the QR box, or clears a stale one owned by this image. */
  function renderResult(img, urls, pwd) {
    const card = getCard(img);
    if (!card) return;

    const existing = panelsByContainer.get(card);
    if (!urls.length) {
      if (existing && existing.owner === img) removePanel(card);
      return;
    }

    // Lazy loaders swap src after data-src was already resolved; avoid a visible re-render.
    const signature = JSON.stringify([urls, pwd]);
    if (existing && existing.signature === signature && existing.panel.isConnected) {
      existing.owner = img;
      return;
    }
    removePanel(card);

    const panel = createPanel(urls, pwd);
    const hiddenPwdBox = pwd ? card.querySelector(ORIGINAL_PWD_SELECTOR) : null;
    if (hiddenPwdBox) hiddenPwdBox.classList.add("qrto-original-pwd-hidden");

    const qrBox = img.closest(QR_BOX_SELECTOR);
    if (qrBox && qrBox.parentElement === card) {
      qrBox.insertAdjacentElement("afterend", panel);
    } else {
      img.insertAdjacentElement("afterend", panel);
    }

    panelsByContainer.set(card, { panel, owner: img, signature, hiddenPwdBox });
  }

  function processPendingImages() {
    processingScheduled = false;
    const images = Array.from(pendingImages);
    pendingImages.clear();

    images.forEach((img) => {
      if (!img.isConnected || !looksLikeQr(img)) return;
      if (processedSources.get(img) === getSourceKey(img)) return;
      enhanceImage(img).catch(() => {
        // Allow a later src change or mutation to retry this image.
        processedSources.delete(img);
      });
    });
  }

  function scheduleProcessing() {
    if (processingScheduled) return;
    processingScheduled = true;

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(processPendingImages, { timeout: IDLE_PROCESSING_TIMEOUT_MS });
      return;
    }
    window.setTimeout(processPendingImages, 0);
  }

  function enqueueImage(img) {
    pendingImages.add(img);
    scheduleProcessing();
  }

  function collectImages(node) {
    if (!(node instanceof Element) || isInsideOwnPanel(node)) return;
    if (node.tagName === "IMG") enqueueImage(node);
    node.querySelectorAll(QR_CANDIDATE_SELECTOR).forEach(enqueueImage);
  }

  function scanInitialImages() {
    document.querySelectorAll(QR_CANDIDATE_SELECTOR).forEach(enqueueImage);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanInitialImages, { once: true });
  } else {
    scanInitialImages();
  }

  // Only inspect new or source-updated images instead of rescanning the document.
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        if (mutation.target.tagName === "IMG") enqueueImage(mutation.target);
        return;
      }
      mutation.addedNodes.forEach(collectImages);
    });
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-src"],
  });

  document.addEventListener("lazybeforeunveil", (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement) enqueueImage(img);
  });

  function showCopyFeedback(button, message, stateClass) {
    const status = button.querySelector(".qrto-copy-status");
    if (!status) return;

    window.clearTimeout(copyFeedbackTimers.get(button));
    button.classList.remove("is-copied", "is-failed");
    status.textContent = message;
    button.classList.add(stateClass);

    copyFeedbackTimers.set(
      button,
      window.setTimeout(() => {
        status.textContent = "";
        button.classList.remove(stateClass);
        copyFeedbackTimers.delete(button);
      }, COPY_FEEDBACK_DURATION_MS)
    );
  }

  /** Selects the code text so the user can copy it manually when the Clipboard API is unavailable. */
  function selectCodeText(button) {
    const code = button.querySelector("strong");
    const selection = window.getSelection();
    if (!code || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copyButton = target.closest("[data-qrto-copy-code]");
    if (!(copyButton instanceof HTMLButtonElement)) return;

    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(copyButton.dataset.qrtoCopyCode || "");
      showCopyFeedback(copyButton, UI_TEXT.copied, "is-copied");
    } catch {
      selectCodeText(copyButton);
      showCopyFeedback(copyButton, UI_TEXT.copyFailed, "is-failed");
    }
  });
})();
