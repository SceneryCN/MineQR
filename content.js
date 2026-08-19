/*!
 * QR download link parser for gamers520.com.
 * Links are resolved locally from the QR generator URL or image pixels.
 * Dynamic and lazy-loaded content is handled through DOM observation.
 */

(function () {
  "use strict";

  if (window.__qrLinkifyInjected__) return;
  window.__qrLinkifyInjected__ = true;

  /** Tracks the last source processed for each image. */
  const processedSources = new WeakMap();

  /** Keeps one result panel per download card. */
  const panelsByContainer = new WeakMap();

  const UI_TEXT = Object.freeze({
    open: "打开",
    copyCode: "复制提取码",
    copied: "已复制",
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
  const QR_CANDIDATE_SELECTOR = [
    "img[src*='qr' i]",
    "img[data-src*='qr' i]",
    "img[alt*='二维码']",
    "img[alt*='扫码']",
    "img[alt*='qrcode' i]",
    "img[alt*='qr code' i]",
    "[class*='qr' i] img",
  ].join(",");
  const pendingImages = new Set();
  let processingScheduled = false;

  /** Determines whether an image is likely to contain a QR code. */
  function looksLikeQr(img) {
    if (img.classList.contains("qrto-action-icon")) return false;

    const src = (img.getAttribute("src") || "") + (img.getAttribute("data-src") || "");
    const alt = img.getAttribute("alt") || "";
    if (/qr(code|server)?/i.test(src)) return true;
    if (/二维码|扫码|perp/i.test(alt)) return true;
    let el = img.parentElement;
    for (let i = 0; el && i < 4; i++) {
      const cls = el.className || "";
      if (typeof cls === "string" && /qr/i.test(cls)) return true;
      el = el.parentElement;
    }
    return false;
  }

  /** Extracts a URL from the data parameter of a QR generator source. */
  function extractFromQrServerSrc(src) {
    try {
      const m = src.match(/[?&]data=([^&]+)/);
      if (!m) return null;
      const decoded = decodeURIComponent(m[1]);
      const urls = [];
      const m2 = decoded.match(/https?:\/\/[^\s"']+/);
      if (m2) urls.push(m2[0]);
      return urls.length ? urls : null;
    } catch (e) {
      return null;
    }
  }

  /** Finds download metadata without leaking into neighbouring cards. */
  function extractFromDomContext(img, includeUrls) {
    const results = { urls: [], pwd: null };
    const alt = img.getAttribute("alt") || "";
    const title = img.getAttribute("title") || "";
    let text = alt + " " + title;

    const pwdMatch =
      text.match(/提取码[:：]?\s*([A-Za-z0-9]{4,8})/) ||
      text.match(/pwd[:=]\s*([A-Za-z0-9]{4,8})/i);
    if (pwdMatch) results.pwd = pwdMatch[1];

    const scope =
      img.closest(".bdp-card, [class*='download-card'], [class*='qr-card'], td, li") ||
      img.parentElement;
    if (!scope) return results;

    text += " " + (scope.textContent || "").trim();
    const p1 = text.match(/提取码[:：]?\s*([A-Za-z0-9]{4,8})/);
    const p2 = text.match(/pwd[:=]\s*([A-Za-z0-9]{4,8})/i);
    if (p1 || p2) results.pwd = (p1 || p2)[1];

    if (includeUrls) {
      scope.querySelectorAll("a[href]").forEach((anchor) => {
        const href = anchor.href;
        if (
          /^https?:/.test(href) &&
          /pan\.|gofile|quark|xunlei|drive|cloud|disk|123pan|lanzou/i.test(href) &&
          !results.urls.includes(href)
        ) {
          results.urls.push(href);
        }
      });

      const textUrls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
      textUrls.forEach((url) => {
        const cleanUrl = url.replace(/[.。,，]$/, "");
        if (!results.urls.includes(cleanUrl)) results.urls.push(cleanUrl);
      });
    }

    return results;
  }

  function decodeLoadedImage(image) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight || typeof window.jsQR !== "function") return null;

    const scale = Math.min(
      1,
      MAX_DECODE_SIDE_PX / Math.max(sourceWidth, sourceHeight)
    );
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
    } catch (error) {
      return null;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /** Decodes QR pixels locally with jsQR. */
  function decodeImage(img) {
    return new Promise((resolve) => {
      try {
        const src = img.currentSrc || img.src;
        if (!src) return resolve(null);

        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(decodeLoadedImage(image));
        image.onerror = () => {
          // Retry without CORS mode for same-origin or browser-cached images.
          if (image.crossOrigin !== undefined) {
            const img2 = new Image();
            img2.onload = () => resolve(decodeLoadedImage(img2));
            img2.onerror = () => resolve(null);
            img2.src = src;
          } else {
            resolve(null);
          }
        };
        image.src = src;
      } catch (e) {
        resolve(null);
      }
    }).catch(() => null);
  }

  /** Normalizes the resolved URL and appends a supported extraction code. */
  function normalizeUrl(url, pwd) {
    if (!url) return null;
    let u = url;
    u = u.replace(/[.。,，;；)\]]+$/, "");
    if (u.includes("?")) return u;
    if (pwd && /pan\.(baidu|quark|xunlei)/i.test(u)) {
      return u + "?pwd=" + encodeURIComponent(pwd);
    }
    return u;
  }

  /** Resolves and renders the links for one QR image. */
  async function enhanceImage(img) {
    const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    if (!src) return;
    if (processedSources.get(img) === src) return;
    processedSources.set(img, src);

    let urls = extractFromQrServerSrc(src);

    const ctx = extractFromDomContext(img, !urls || !urls.length);

    if (!urls || !urls.length) {
      const decoded = await decodeImage(img);
      if (decoded && /^https?:\/\//i.test(decoded)) {
        urls = [decoded];
      } else if (decoded) {
        urls = null;
      }
    }

    // Context links are only used as a fallback within the same download card.
    if ((!urls || !urls.length) && ctx.urls.length) {
      urls = ctx.urls;
    }

    const pwd = ctx.pwd || (src.match(/pwd[=:]([A-Za-z0-9]+)/i) || [null, null])[1];

    const finalUrls = (urls || [])
      .map((u) => normalizeUrl(u, pwd))
      .filter(Boolean);

    const seen = new Set();
    const unique = finalUrls.filter((url) => {
      try {
        const parsedUrl = new URL(url);
        const key = parsedUrl.origin + parsedUrl.pathname;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      } catch (error) {
        return false;
      }
    });

    if (processedSources.get(img) !== src) return;

    if (unique.length) {
      injectLinkPanel(img, unique, pwd);
    }
  }

  function getProvider(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const provider = PROVIDERS.find(([domain]) => hostname.includes(domain));
      return {
        name: provider ? provider[1] : "",
        icon: provider ? provider[2] : "qr.svg",
      };
    } catch (error) {
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

  /** Renders a compact result as a sibling of the QR box. */
  function injectLinkPanel(img, urls, pwd) {
    const card =
      img.closest(".bdp-card, [class*='download-card'], [class*='qr-card'], td, li") ||
      img.parentElement;
    if (!card) return;

    const panel = document.createElement("div");
    panel.className = "qrto-link-panel";
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", UI_TEXT.openLink);

    const list = document.createElement("div");
    list.className = "qrto-link-list";

    urls.forEach((url) => {
      const a = document.createElement("a");
      const provider = getProvider(url);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "bdp-btn qrto-link-action";
      a.appendChild(createProviderIcon(provider.icon));
      a.append(
        document.createTextNode(
          provider.name ? `${UI_TEXT.open}${provider.name}` : UI_TEXT.openLink
        )
      );
      list.appendChild(a);
    });

    panel.appendChild(list);

    if (pwd) {
      const originalPassword = card.querySelector(".bdp-pwd-box");
      if (originalPassword) originalPassword.classList.add("qrto-original-pwd-hidden");

      const copyButton = document.createElement("button");
      copyButton.className = "qrto-copy-button";
      copyButton.type = "button";
      copyButton.dataset.qrtoCopyCode = pwd;
      copyButton.setAttribute("aria-label", `${UI_TEXT.copyCode} ${pwd}`);
      copyButton.innerHTML =
        `<span>${UI_TEXT.copyCode}</span><strong>${pwd}</strong><span class="qrto-copy-status" aria-live="polite"></span>`;
      panel.appendChild(copyButton);
    }

    const existingPanel = panelsByContainer.get(card);
    if (existingPanel) existingPanel.remove();
    panelsByContainer.set(card, panel);

    const qrBox = img.closest(".bdp-qrcode-box, [class*='qrcode-box'], [class*='qr-box']");
    if (qrBox && qrBox.parentElement === card) {
      qrBox.insertAdjacentElement("afterend", panel);
    } else {
      img.insertAdjacentElement("afterend", panel);
    }
  }

  function processPendingImages() {
    processingScheduled = false;
    const images = Array.from(pendingImages);
    pendingImages.clear();

    images.forEach((img) => {
      if (!img.isConnected || !looksLikeQr(img)) return;
      const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
      if (processedSources.get(img) !== src) enhanceImage(img);
    });
  }

  function scheduleProcessing() {
    if (processingScheduled) return;
    processingScheduled = true;

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(processPendingImages, {
        timeout: IDLE_PROCESSING_TIMEOUT_MS,
      });
      return;
    }

    window.setTimeout(processPendingImages, 0);
  }

  function enqueueImage(img) {
    pendingImages.add(img);
    scheduleProcessing();
  }

  function collectImages(node) {
    if (!(node instanceof Element)) return;
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
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-src"],
  });

  document.addEventListener("lazybeforeunveil", (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG") enqueueImage(img);
  });

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const copyButton = target.closest("[data-qrto-copy-code]");
    if (!copyButton) return;

    try {
      await navigator.clipboard.writeText(copyButton.dataset.qrtoCopyCode);
      const status = copyButton.querySelector(".qrto-copy-status");
      if (!status) return;
      status.textContent = UI_TEXT.copied;
      copyButton.classList.add("is-copied");
      window.setTimeout(() => {
        status.textContent = "";
        copyButton.classList.remove("is-copied");
      }, COPY_FEEDBACK_DURATION_MS);
    } catch (error) {
      return;
    }
  });
})();