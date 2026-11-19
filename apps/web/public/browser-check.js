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
  // Keep these standalone messages and the matching rules in sync with packages/core/src/ui-language.ts.
  var messages = {
    en: {
      code: "en",
      script: "latn",
      title: "This browser isn’t supported",
      body: "Update to iOS or iPadOS 16.4 or later,\nor open it in Chrome or Edge 111, Safari 16.4, or Firefox 128 or later."
    },
    ja: {
      code: "ja",
      script: "jpan",
      title: "このブラウザには対応していません",
      body: "iOS／iPadOS 16.4 以降にアップデートするか、\nChrome・Edge 111、Safari 16.4、Firefox 128 以降で開いてください。"
    },
    zh: {
      code: "zh-CN",
      script: "hans",
      title: "不支持此浏览器",
      body: "请更新到 iOS 或 iPadOS 16.4 或更高版本，\n或者用 Chrome 或 Edge 111、Safari 16.4、Firefox 128 或更高版本打开。"
    },
    es: {
      code: "es",
      script: "latn",
      title: "Este navegador no es compatible",
      body: "Actualiza a iOS o iPadOS 16.4 o posterior,\no ábrelo en Chrome o Edge 111, Safari 16.4 o Firefox 128 o posterior."
    },
    pt: {
      code: "pt-BR",
      script: "latn",
      title: "Este navegador não é compatível",
      body: "Atualize para o iOS ou iPadOS 16.4 ou posterior,\nou abra no Chrome ou Edge 111, Safari 16.4 ou Firefox 128 ou posterior."
    }
  };
  // Likely Traditional Chinese regions and their aliases when Intl.Locale is unavailable.
  var hantRegions = /^(?:au|bn|gb|gf|hk|id|mo|pa|pf|ph|pz|sr|th|tw|uk|us|vd|vn|036|096|158|254|258|344|360|446|591|608|704|740|764|826|840)$/;
  var aliases = { eng: "en", jpn: "ja", chi: "zh", zho: "zh", cmn: "zh", spa: "es", por: "pt" };
  var languageAndRegion = /^([a-z]{2,3})(?=-|$)(?:-([a-z]{4})(?=-|$))?(?:-([a-z]{2}|[0-9]{3})(?=-|$))?/;
  var variantsAndExtensions = /^((?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$/;
  function localeParts(tag) {
    if (typeof tag !== "string") return null;
    if (typeof Intl !== "undefined" && typeof Intl.Locale === "function"
        && typeof Intl.Locale.prototype.maximize === "function") {
      try {
        var locale = new Intl.Locale(tag);
        var maximized = locale.maximize();
        return { language: locale.language, script: maximized.script.toLowerCase(), bare: locale.baseName === locale.language };
      } catch (error) { return null; }
    }
    var lowerTag = tag.toLowerCase();
    var parts = languageAndRegion.exec(lowerTag);
    if (!parts) return null;
    var suffix = variantsAndExtensions.exec(lowerTag.slice(parts[0].length));
    if (!suffix) return null;
    var language = aliases[parts[1]] || parts[1];
    var choice = messages[language];
    if (!choice) return null;
    var script = parts[2] || (language === "zh" && hantRegions.test(parts[3]) ? "hant" : choice.script);
    return { language: language, script: script, bare: !parts[2] && !parts[3] && !suffix[1] };
  }
  function messageFor(preferences) {
    var unmatched = {};
    for (var index = 0; index < preferences.length; index++) {
      var locale = localeParts(preferences[index]);
      if (!locale || !Object.prototype.hasOwnProperty.call(messages, locale.language)) continue;
      // A bare fallback for a skipped locale carries the same incompatible writing system.
      if (locale.bare && unmatched[locale.language]) continue;
      var choice = messages[locale.language];
      if (choice.script === locale.script) return choice;
      unmatched[locale.language] = true;
    }
    return messages.en;
  }
  var preferences = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  var message = messageFor(preferences);
  var dark = !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.lang = message.code;
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
