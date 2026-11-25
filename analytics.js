// GoatCounter: page views and the main user actions as events. Loaded in <head> by both pages, before GoatCounter's
// count.js (at the end of <body>) and before main.js, which calls window.track.
//
// Event names are "kontenery:<category>-<what>", lowercase kebab-case, from a fixed set: ids from site.json, document file
// names, view and map names. Never anything a visitor typed.
(() => {
  // Settings count.js reads when it loads. The map switch reloads the page with the camera in ?state=, a different JSON
  // each time: left in, every switch would count as a page of its own. ?map= stays.
  window.goatcounter = Object.assign(window.goatcounter || {}, {
    path: (path) => {
      try {
        const url = new URL(path, location.href);
        url.searchParams.delete("state");
        return url.pathname + url.search;
      } catch {
        return path;
      }
    },
  });

  const local = ["localhost", "127.0.0.1"].includes(location.hostname) || location.protocol === "file:";

  // Safe whatever GoatCounter's state: blocked, not loaded yet, or on the local server (where count.js counts nothing
  // and says so in the console). Events from before count.js has loaded, such as the page's entry or a failure early in
  // loading, wait for it, a few at most; if it never loads, they're dropped. On the local server each event is also
  // logged in the console, to check them without sending anything.
  const waiting = [];
  const send = (vars) => {
    try {
      window.goatcounter.count(vars);
    } catch {
      // Analytics must never break the page.
    }
  };
  const ready = () => typeof window.goatcounter?.count === "function";
  const flush = () => {
    if (ready()) waiting.splice(0).forEach(send);
  };
  window.track = (name, title) => {
    try {
      const event = `kontenery:${name}`;
      if (local) console.debug("[track]", event, title ?? "");
      const vars = { path: event, title: title ?? event, event: true };
      if (ready()) send(vars);
      else if (waiting.length < 10) waiting.push(vars);
    } catch {
      // As above.
    }
  };
  // count.js is async, at the end of <body>: by the time the page is parsed it may have loaded, or not yet.
  document.addEventListener("DOMContentLoaded", () => {
    flush();
    document.querySelector("script[data-goatcounter]")?.addEventListener("load", flush);
  });

  // Links to documents, on either page, by the file's name: "doc-open-8-wz-ppd-2026", or "doc-download-…" for a
  // "Pobierz" link. "docs-list" is index.html's link to dokumenty.html. One listener for every link, so it counts each
  // click once; a middle click (auxclick) opens a tab too.
  const onLink = (event) => {
    if (event.type === "auxclick" && event.button !== 1) return;
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    const doc = href.match(/(?:^|\/)docs\/([^/?#]+)\.pdf$/i);
    if (doc) {
      const slug = doc[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      window.track(`doc-${link.hasAttribute("download") ? "download" : "open"}-${slug}`);
    } else if (/(?:^|\/)dokumenty\.html(?:#.*)?$/.test(href)) {
      window.track("docs-list");
    } else if (/^https?:/i.test(href) && new URL(href, location.href).origin !== location.origin) {
      window.track("external-link", new URL(href).hostname);
    }
  };
  document.addEventListener("click", onLink, true);
  document.addEventListener("auxclick", onLink, true);
})();
