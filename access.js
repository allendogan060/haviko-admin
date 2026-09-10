(() => {
  "use strict";

  const AUTHORIZATION_URL = "https://autorisieren.haviko.de/";
  const ACCESS_COOKIE = "haviko_preview_access";
  const hasAccess = document.cookie
    .split(";")
    .map((value) => value.trim())
    .some((value) => value === `${ACCESS_COOKIE}=granted`);

  if (hasAccess || window.location.hostname === "localhost") return;

  const next = encodeURIComponent(window.location.href);
  window.location.replace(`${AUTHORIZATION_URL}?next=${next}`);
})();
