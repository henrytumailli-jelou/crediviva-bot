(function () {
  "use strict";
  // Un mismo sitio sirve tres webviews; el enlace firmado dice cuál abrir (data.tipo).
  function cargar(src) {
    var s = document.createElement("script");
    s.src = src;
    document.body.appendChild(s);
  }
  fetch("/__jelou/me", { credentials: "same-origin" })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (me) {
      var tipo = me && me.data && me.data.tipo;
      cargar(tipo === "registro" ? "registro.js" : tipo === "solicitud" ? "solicitud.js" : "consentimientos.js");
    });
})();
