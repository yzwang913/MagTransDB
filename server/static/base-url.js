(() => {
  function normalizeBaseUrl(value) {
    const text = String(value || "").trim();
    if (!text || text === "/") return "";
    return `/${text.replace(/^\/+|\/+$/g, "")}`;
  }

  function inferBaseUrl() {
    const script = document.currentScript;
    if (!script || !script.src) return "";
    try {
      const pathname = new URL(script.src, window.location.href).pathname;
      const marker = "/static/base-url.js";
      const markerIndex = pathname.lastIndexOf(marker);
      return markerIndex >= 0 ? pathname.slice(0, markerIndex) : "";
    } catch {
      return "";
    }
  }

  const baseUrl = normalizeBaseUrl(window.APP_BASE_URL || inferBaseUrl());
  window.APP_BASE_URL = baseUrl;
  window.appUrl = (path) => {
    const value = String(path || "");
    if (!value || value.startsWith("#")) return value;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^(?:data|blob):/i.test(value)) {
      return value;
    }
    const normalizedPath = `/${value.replace(/^\/+/, "")}`;
    if (baseUrl && (normalizedPath === baseUrl || normalizedPath.startsWith(`${baseUrl}/`))) {
      return normalizedPath;
    }
    return `${baseUrl}${normalizedPath}`;
  };
})();
