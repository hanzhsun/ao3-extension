// ==UserScript==
// @name          blocker-patch
// @version       0.1
// @description   Highlighted tags, including ratings, use the highlight color instead of a work border.
// @match         *://archiveofourown.org/
// @match         *://archiveofourown.org/tags/*
// @match         *://archiveofourown.org/works*
// @match         *://archiveofourown.org/works?*
// @match         *://archiveofourown.org/users/*
// @match         *://archiveofourown.org/collections/*
// @match         *://archiveofourown.org/bookmarks*
// @match         *://archiveofourown.org/series/*
// @grant         none
// @run-at        document-start
// ==/UserScript==

(function () {
    "use strict";

    if (typeof Document === "undefined") return;

    function compilePattern(pattern) {
        const parts = pattern.split("*").map((part) => {
            const normalized = part.toLowerCase();
            const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
            if (!escaped) return escaped;
            const prefix = /^[a-z0-9]/.test(escaped) ? "(?<![a-z0-9])" : "";
            const suffix = /[a-z0-9]$/.test(escaped) ? "(?![a-z0-9])" : "";
            return prefix + escaped + suffix;
        });
        const regexPattern = parts.join(".*");
        return {
            originalText: pattern,
            text: pattern.replace(/\*/g, "").toLowerCase(),
            regex: new RegExp(regexPattern, "i"),
            exactRegex: new RegExp("^" + regexPattern + "$", "i"),
            hasWildcard: true,
        };
    }

    // Loaded after Advanced Blocker and with higher specificity, so the work's
    // left bar and border stay off and the matched tag takes the highlight color.
    const HIGHLIGHT_CSS = `
  html body .ao3-blocker-highlight::before {
    content: none !important;
    display: none !important;
    box-shadow: none !important;
    background: none !important;
    border: 0 !important;
  }
  html body .reading .ao3-blocker-highlight h4.viewed {
    border-left: 0 !important;
  }
  html body a.tag.ao3-blocker-matched-tag,
  html body span.tag.ao3-blocker-matched-tag,
  html body a.tag.ao3-blocker-matched-tag:visited,
  html body a.tag.ao3-blocker-matched-tag:hover,
  html body a.tag.ao3-blocker-matched-tag:focus {
    background-color: var(--ao3-blocker-highlight-color, #eb6f92) !important;
    color: #fff !important;
  }
  html body span.rating.ao3-blocker-matched-rating {
    background-color: var(--ao3-blocker-highlight-color, #eb6f92) !important;
  }
`;

    function installHighlightStyle() {
        const root = document.head || document.documentElement;
        if (!root) return;
        let style = document.getElementById("blocker-patch-highlight");
        if (!style) {
            style = document.createElement("style");
            style.id = "blocker-patch-highlight";
        }
        style.textContent = HIGHLIGHT_CSS + buildEarlyHighlightCSS();
        root.appendChild(style);
        document.documentElement.style.setProperty("--ao3-blocker-highlight-color", highlightColor());
    }

    function cssString(value) {
        return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    function tagHrefSelectors(name) {
        const slashEncoded = name.replace(/\//g, "*s*");
        const params = new Set([
            slashEncoded,
            slashEncoded.replace(/ /g, "%20"),
            encodeURIComponent(slashEncoded),
        ]);
        const selectors = [];
        params.forEach((param) => {
            const base = `/tags/${cssString(param)}`;
            selectors.push(`html body a.tag[href="${base}"]`);
            selectors.push(`html body a.tag[href="${base}/"]`);
            selectors.push(`html body a.tag[href^="${base}/"]`);
            selectors.push(`html body a.tag[href^="${base}?"]`);
        });
        return selectors;
    }

    const RATING_CLASS = {
        explicit: "rating-explicit",
        mature: "rating-mature",
        "teen and up audiences": "rating-teen",
        "general audiences": "rating-general-audience",
        "not rated": "rating-notrated",
    };

    // These rules exist before the tags are parsed, so the first paint is already the chosen color.
    function buildEarlyHighlightCSS() {
        const color = cssString(highlightColor());
        const tagSelectors = [];
        const ratingSelectors = [];
        loadHighlightEntries().forEach((entry) => {
            if (entry.type !== "simple" || entry.pattern.hasWildcard) return;
            const name = entry.pattern.originalText || entry.pattern.text;
            tagHrefSelectors(name).forEach((selector) => tagSelectors.push(selector));
            const title = cssString(name);
            ratingSelectors.push(`html body span.rating[title="${title}"]`);
            const ratingClass = RATING_CLASS[name.toLowerCase()];
            if (ratingClass) ratingSelectors.push(`html body span.${ratingClass}`);
        });
        let css = "";
        if (tagSelectors.length) {
            css += `${tagSelectors.join(",")}{background-color:${color} !important;color:#fff !important;}`;
        }
        if (ratingSelectors.length) {
            css += `${ratingSelectors.join(",")}{background-color:${color} !important;}`;
        }
        return css;
    }

    const STORAGE_KEY = "ao3_advanced_blocker_config";
    const HIGHLIGHT_ROOTS = "#main, li.blurb, dl.work.meta.group, .preface";
    const HIGHLIGHT_TAGS = "a.tag, span.tag";

    function splitEntries(raw) {
        const entries = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < raw.length; i++) {
            if (raw[i] === "{") depth++;
            if (raw[i] === "}") depth--;
            if (raw[i] === "," && depth === 0) {
                entries.push(raw.slice(start, i));
                start = i + 1;
            }
        }
        entries.push(raw.slice(start));
        return entries.map((entry) => entry.trim()).filter(Boolean);
    }

    function compileHighlightPattern(pattern) {
        if (pattern.includes("*")) return compilePattern(pattern);
        return { originalText: pattern, text: pattern.toLowerCase(), hasWildcard: false };
    }

    // Listing pages keep a tag when the highlight text occurs anywhere in it.
    // Work pages must use that same check. Exact equality misses tags whose
    // text is longer, or whose skin appends a symbol.
    function highlightMatches(text, pattern) {
        const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
        if (!normalized) return false;
        if (pattern.hasWildcard) return pattern.regex.test(normalized);
        const name = pattern.text;
        return Boolean(name) && normalized.includes(name);
    }

    function tagNameFromHref(el) {
        const href = el.getAttribute("href") || "";
        if (!href) return "";
        try {
            const parts = new URL(href, location.origin).pathname.split("/").filter(Boolean);
            const index = parts.indexOf("tags");
            if (index === -1 || !parts[index + 1]) return "";
            return decodeURIComponent(parts[index + 1]).replace(/\*s\*/g, "/");
        } catch (e) {
            return "";
        }
    }

    function conditionMatches(rawCondition, tags) {
        const exact = (name) => tags.some((tag) => tag.toLowerCase() === name.toLowerCase());
        if (rawCondition.includes("||")) {
            return rawCondition.split("||").some((part) => exact(part.trim()));
        }
        if (rawCondition.includes(",")) {
            return rawCondition.split(",").every((part) => exact(part.trim()));
        }
        return exact(rawCondition.trim());
    }

    function parseHighlightEntry(entry) {
        const conditional = entry.match(/^(.+?)\s+(with|unless):\{(.+)\}$/i);
        if (conditional) {
            return {
                type: "conditional",
                block: compileHighlightPattern(conditional[1].trim()),
                operator: conditional[2].toLowerCase(),
                condition: conditional[3].trim(),
            };
        }
        return { type: "simple", pattern: compileHighlightPattern(entry) };
    }

    function loadStoredConfig() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
        } catch (e) {
            return {};
        }
    }

    function loadHighlightEntries() {
        return splitEntries(String(loadStoredConfig().tagHighlights || "")).map(parseHighlightEntry);
    }

    function elementLabels(el) {
        const labels = [];
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const title = (el.getAttribute("title") || "").trim();
        const fromHref = tagNameFromHref(el);
        if (text) labels.push(text);
        if (title && title !== text) labels.push(title);
        if (fromHref) labels.push(fromHref);
        return labels;
    }

    function entryMatches(labels, entry, allLabels) {
        const hit = (pattern) => labels.some((label) => highlightMatches(label, pattern));
        if (entry.type === "simple") return hit(entry.pattern);
        if (!hit(entry.block)) return false;
        const ok = conditionMatches(entry.condition, allLabels);
        return entry.operator === "with" ? ok : !ok;
    }

    function highlightColor() {
        const stored = String(loadStoredConfig().highlightColor || "").trim();
        if (stored) return stored;
        const fromPage = getComputedStyle(document.documentElement)
            .getPropertyValue("--ao3-blocker-highlight-color")
            .trim();
        return fromPage || "#eb6f92";
    }

    function clearPaint(el) {
        el.classList.remove("ao3-blocker-matched-tag", "ao3-blocker-matched-rating");
        [
            "background",
            "background-color",
            "background-image",
            "color",
            "border-color",
            "box-shadow",
            "outline",
        ].forEach((prop) => el.style.removeProperty(prop));
    }

    // Text tags keep their pill shape. Rating circles only change fill, so the E stays.
    function paintTextTag(el) {
        el.classList.add("ao3-blocker-matched-tag");
        el.style.setProperty("background-color", highlightColor(), "important");
        el.style.setProperty("color", "#fff", "important");
    }

    function paintRatingIcon(el) {
        el.classList.add("ao3-blocker-matched-rating");
        el.style.setProperty("background-color", highlightColor(), "important");
    }

    function stripWorkCardHighlight(node) {
        if (!node) return;
        const root = node.nodeType === 1 ? node : node.documentElement ? node : null;
        if (!root) return;
        if (root.classList && root.classList.contains("ao3-blocker-highlight")) {
            root.classList.remove("ao3-blocker-highlight");
        }
        if (root.querySelectorAll) {
            root.querySelectorAll(".ao3-blocker-highlight").forEach((el) => {
                el.classList.remove("ao3-blocker-highlight");
            });
        }
    }

    function isZeroRadius(value) {
        if (!value) return true;
        return value
            .trim()
            .split(/[/\s]+/)
            .every((part) => part === "0px" || part === "0%");
    }

    function usableRadius(el, pseudo) {
        if (!el) return "";
        const value = getComputedStyle(el, pseudo || null).borderRadius;
        return isZeroRadius(value) ? "" : value;
    }

    // The work-page meta card is rounded, but a same-sized layer behind it
    // (the card's ::before, or a tight wrapper) stays square and shows at the corners.
    function fixWorkMetaCorners() {
        const card = document.querySelector("dl.work.meta.group");
        if (!card) return;
        const cardBox = card.getBoundingClientRect();
        if (cardBox.width < 40 || cardBox.height < 40) return;

        let host = card;
        let node = card;
        while (
            node.parentElement &&
            node.parentElement !== document.body &&
            node.parentElement !== document.documentElement
        ) {
            const parent = node.parentElement;
            const box = parent.getBoundingClientRect();
            const wider = box.width - cardBox.width;
            const taller = box.height - cardBox.height;
            const shiftX = cardBox.left - box.left;
            const shiftY = cardBox.top - box.top;
            if (
                wider < -2 ||
                wider > 32 ||
                taller < -2 ||
                taller > 32 ||
                shiftX < -2 ||
                shiftX > 32 ||
                shiftY < -2 ||
                shiftY > 32
            ) {
                break;
            }
            host = parent;
            node = parent;
        }

        const radius =
            usableRadius(card) ||
            usableRadius(host) ||
            usableRadius(card, "::before") ||
            usableRadius(card, "::after") ||
            usableRadius(host, "::before") ||
            usableRadius(host, "::after");
        if (!radius) return;

        card.classList.add("blocker-patch-round");
        if (host !== card) host.classList.add("blocker-patch-round");
        [card, host].forEach((el) => {
            el.style.setProperty("border-radius", radius, "important");
            el.style.setProperty("overflow", "hidden", "important");
            el.style.setProperty("isolation", "isolate", "important");
        });

        let style = document.getElementById("blocker-patch-corners");
        if (!style) {
            style = document.createElement("style");
            style.id = "blocker-patch-corners";
            (document.head || document.documentElement).appendChild(style);
        }
        const css =
            `html body #main .blocker-patch-round::before,html body #main .blocker-patch-round::after{` +
            `border-radius:${radius} !important;clip-path:inset(0 round ${radius}) !important}`;
        if (style.textContent !== css) style.textContent = css;
    }

    function applyHighlight() {
        installHighlightStyle();
        fixWorkMetaCorners();
        stripWorkCardHighlight(document);
        document.querySelectorAll("li.ao3-blocker-matched-tag").forEach(clearPaint);
        const entries = loadHighlightEntries();
        if (!entries.length) return;

        document
            .querySelectorAll("ul.required-tags span.rating, li.rating span.rating")
            .forEach((el) => {
                const labels = elementLabels(el);
                if (!labels.length) return;
                if (entries.some((entry) => entryMatches(labels, entry, labels))) paintRatingIcon(el);
            });

        const roots = document.querySelectorAll(HIGHLIGHT_ROOTS);
        const scope = roots.length ? roots : [document.body];
        scope.forEach((root) => {
            const elements = Array.from(root.querySelectorAll(HIGHLIGHT_TAGS)).filter(
                (el) => !el.closest("ul.required-tags") && !el.matches("span.rating"),
            );
            const allLabels = elements.flatMap(elementLabels);
            elements.forEach((el) => {
                const labels = elementLabels(el);
                if (!labels.length) return;
                if (entries.some((entry) => entryMatches(labels, entry, allLabels))) paintTextTag(el);
            });
        });
    }

    function paintElementNow(el) {
        if (!el || el.nodeType !== 1) return;
        const entries = loadHighlightEntries();
        if (!entries.length) return;
        if (el.matches("span.rating")) {
            const labels = elementLabels(el);
            if (labels.length && entries.some((entry) => entryMatches(labels, entry, labels))) {
                paintRatingIcon(el);
            }
            return;
        }
        if (!el.matches("a.tag, span.tag") || el.closest("ul.required-tags")) return;
        const labels = elementLabels(el);
        if (labels.length && entries.some((entry) => entryMatches(labels, entry, labels))) {
            paintTextTag(el);
        }
    }

    function paintAddedNode(node) {
        if (!node || node.nodeType !== 1) return;
        stripWorkCardHighlight(node);
        if (
            node.matches &&
            (node.matches("dl.work.meta.group") ||
                (node.querySelector && node.querySelector("dl.work.meta.group")))
        ) {
            fixWorkMetaCorners();
        }
        paintElementNow(node);
        if (node.querySelectorAll) node.querySelectorAll("a.tag, span.tag, span.rating").forEach(paintElementNow);
    }

    function keepHighlightStyleLast() {
        const style = document.getElementById("blocker-patch-highlight");
        const head = document.head;
        if (!style || !head || head.lastElementChild === style) return;
        head.appendChild(style);
    }

    installHighlightStyle();
    if (document.documentElement) {
        const earlyObserver = new MutationObserver((mutations) => {
            keepHighlightStyleLast();
            mutations.forEach((mutation) => {
                if (mutation.type === "attributes") {
                    stripWorkCardHighlight(mutation.target);
                    return;
                }
                mutation.addedNodes.forEach(paintAddedNode);
            });
        });
        earlyObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
        });
    }

    function watchForTags() {
        const root = document.getElementById("main") || document.body;
        if (!root || root.dataset.blockerPatchWatch) return;
        root.dataset.blockerPatchWatch = "1";
        let scheduled = false;
        const observer = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => {
                scheduled = false;
                applyHighlight();
            }, 50);
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    installHighlightStyle();
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            applyHighlight();
            watchForTags();
        });
    } else {
        applyHighlight();
        watchForTags();
    }
    window.addEventListener("load", applyHighlight);

    const originalQuerySelectorAll = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function (selectors) {
        if (selectors === "li.blurb") {
            installHighlightStyle();
            setTimeout(applyHighlight, 0);
        }
        return originalQuerySelectorAll.apply(this, arguments);
    };
})();
