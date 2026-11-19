// Tells a browser older than the screen supports why it stays blank. The screen's module cannot even be parsed
// there (regular expression lookbehind), and its styles need color-mix() and @property, so nothing else can explain.
// Kept in old syntax and outside the bundle, it runs before the module, and only writes into an empty root.
(function () {
  function supported() {
    try { new RegExp("(?<=a)b"); } catch (error) { return false; } // Safari 16.4
    return !!(window.CSS && CSS.supports && CSS.supports("color", "color-mix(in srgb, red, blue)")) // Chrome and Edge 111
      && typeof window.CSSPropertyRule === "function"; // Safari 16.4, Firefox 128
  }
  if (supported()) return;
  var root = document.getElementById("root");
  if (!root || root.firstChild) return;
  // The bundle's translations cannot load here, so the message keeps its own, keyed by the browser's language.
  var messages = {
    en: {
      title: "This browser isn’t supported",
      body: "Update to iOS or iPadOS 16.4 or later,\nor open it in Chrome or Edge 111, Safari 16.4, or Firefox 128 or later."
    },
    ja: {
      title: "このブラウザには対応していません",
      body: "iOS／iPadOS 16.4 以降にアップデートするか、\nChrome・Edge 111、Safari 16.4、Firefox 128 以降で開いてください。"
    }
  };
  var lang = (navigator.language || "").toLowerCase().split("-")[0];
  if (!messages.hasOwnProperty(lang)) lang = "en";
  var message = messages[lang];
  var dark = !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.lang = lang;
  // Covers the page, so whatever part of the screen's own styles this browser applied cannot hide it.
  var page = document.createElement("div");
  page.setAttribute("role", "alert");
  page.style.cssText = "position:fixed;inset:0;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;"
    + "padding:24px;text-align:center;-webkit-font-smoothing:antialiased;"
    + "font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue','Hiragino Sans',sans-serif;"
    + (dark ? "background:#000;color:#f5f5f7" : "background:#fff;color:#1d1d1f");
  var box = document.createElement("div");
  box.style.maxWidth = "560px";
  var heading = document.createElement("h1");
  heading.style.cssText = "margin:0 0 12px;font-size:28px;font-weight:600;line-height:1.2;letter-spacing:-0.01em";
  heading.textContent = message.title;
  var text = document.createElement("p");
  text.style.cssText = "margin:0;font-size:17px;line-height:1.5;white-space:pre-line;color:" + (dark ? "#a1a1a6" : "#6e6e73");
  text.textContent = message.body;
  box.appendChild(heading);
  box.appendChild(text);
  page.appendChild(box);
  root.appendChild(page);
})();
