(function () {
  "use strict";

  // Cédula panameña: prefijo de 1-2 dígitos (o PE, E, N, y AV/PI tras el número) - tomo - asiento.
  // El prefijo no se limita a las provincias 1-13: Crediviva acepta otros (ej. 40-847-1320) y decide.
  // La función la convierte a 8.123.1456.PA para Crediviva.
  var CEDULA_RE = /^(?:PE|E|N|\d{1,2}(?:AV|PI)?)-\d{1,4}-\d{1,6}$/;
  var ERROR_CEDULA = "Revisa tu número de identidad. Sepáralo con espacios, por ejemplo 8 123 1456.";
  var VOLVER_WA_MS = 1500;
  var sesion = null; // { n, authType, phoneMasked, api, wa }
  var cerrado = false;
  var timerReenvio = null;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function mostrar(id) {
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("is-active", v.id === id); });
    var foot = $(".foot");
    foot.hidden = id === "v-fin" || id === "v-cargando";
    var primerCampo = $("#" + id + " input");
    if (primerCampo) setTimeout(function () { primerCampo.focus(); }, 50);
    guardarPaso(id.replace("v-", ""));
  }

  function alerta(form, texto, tipo) {
    var a = $(".alert", form);
    if (!texto) { a.hidden = true; a.textContent = ""; return; }
    a.className = "alert" + (tipo === "info" ? " info" : "");
    a.textContent = texto;
    a.hidden = false;
  }

  function ocupado(form, si) {
    var b = $("button[type=submit]", form);
    b.disabled = si;
    if (si) { b.dataset.txt = b.textContent; b.textContent = "Procesando…"; }
    else if (b.dataset.txt) { b.textContent = b.dataset.txt; }
  }

  // El usuario separa con espacio (o punto/guion) y se muestran guiones: "10 123 4567" -> 10-123-4567.
  // Como mucho tres tramos; los separadores de más se descartan.
  function normalizarCedula(v) {
    var s = String(v || "").toUpperCase().replace(/[\s.\-–—_]+/g, "-").replace(/[^A-Z0-9-]/g, "").replace(/^-/, "");
    var partes = s.split("-");
    if (partes.length > 3) s = partes.slice(0, 3).join("-") + partes.slice(3).join("");
    return s;
  }

  document.querySelectorAll("[data-mascara]").forEach(function (inp) {
    inp.addEventListener("input", function () {
      var antes = inp.value;
      var pos = inp.selectionStart;
      var despues = normalizarCedula(antes);
      if (despues !== antes) {
        inp.value = despues;
        // Mantiene el cursor donde estaba cuando el cambio no alteró la longitud (espacio -> guion).
        if (pos != null && despues.length === antes.length) inp.setSelectionRange(pos, pos);
      }
      inp.setAttribute("aria-invalid", "false");
    });
  });

  function guardarPaso(paso) {
    if (!sesion) return;
    fetch("/__jelou/state", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: paso, state: { n: sesion.n } })
    }).catch(function () {});
  }

  // El servidor devuelve un sello nuevo en cada respuesta; se conserva para la siguiente llamada.
  function actualizarSello(res) {
    if (res && typeof res.n === "string" && res.n) {
      sesion.n = res.n;
      fetch("/__jelou/state", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: { n: sesion.n } })
      }).catch(function () {});
    }
    return res;
  }

  function llamar(ruta, cuerpo) {
    cuerpo.n = sesion.n;
    return fetch(sesion.api + ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok && !j.status) return { status: "error", message: "Tuvimos un problema técnico. Intenta de nuevo en unos minutos." };
        return actualizarSello(j);
      });
    }).catch(function () {
      return { status: "error", message: "No pudimos conectarnos. Revisa tu conexión e intenta de nuevo." };
    });
  }

  // Cierra el webview y reanuda el flujo en WhatsApp. El bot confirma el resultado en el servidor.
  // Resuelve { ok, codigo } — codigo es el error de la plataforma (link_expired, flow_not_waiting…).
  var CODIGOS = ["link_expired", "link_already_completed", "link_execution_mismatch", "link_too_many_opens",
    "link_not_opened", "link_has_no_execution", "flow_not_waiting", "callback_failed", "no_session"];
  function completar(status, intento) {
    if (cerrado) return Promise.resolve({ ok: true });
    return fetch("/__jelou/complete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, data: { n: sesion ? sesion.n : "", status: status } })
    }).then(function (r) {
      return r.text().then(function (t) {
        var codigo = "";
        for (var i = 0; i < CODIGOS.length; i++) if (t.indexOf(CODIGOS[i]) !== -1) { codigo = CODIGOS[i]; break; }
        if (r.ok || codigo === "link_already_completed") { cerrado = true; return { ok: true }; }
        if (codigo === "callback_failed" && !intento) return completar(status, 1);
        return { ok: false, codigo: codigo || "http_" + r.status };
      });
    }).catch(function () {
      if (!intento) return completar(status, 1);
      return { ok: false, codigo: "red" };
    });
  }

  // Cierra y muestra el resultado; si el chat no pudo reanudarse, lo dice en vez de fingir éxito.
  function cerrar(status, tipo, titulo, texto) {
    return completar(status).then(function (r) {
      if (r.ok) return fin(tipo, titulo, texto);
      if (r.codigo === "link_expired" || r.codigo === "no_session") {
        return fin("warn", "El enlace venció", "Vuelve a WhatsApp y escribe \"documentos\" para recibir un enlace nuevo.");
      }
      fin("err", "No pudimos volver al chat", "Vuelve a WhatsApp y escribe \"documentos\" para intentarlo de nuevo. (" + r.codigo + ")");
    });
  }

  function fin(tipo, titulo, texto) {
    var icono = $("[data-icono]");
    icono.className = "icon " + tipo;
    icono.textContent = tipo === "ok" ? "✓" : tipo === "warn" ? "!" : "×";
    $("[data-titulo]").textContent = titulo;
    $("[data-texto]").textContent = texto;
    var volver = $("[data-volver-wa]");
    var wa = sesion && sesion.wa ? "https://wa.me/" + sesion.wa : "";
    volver.hidden = !wa;
    if (wa) volver.href = wa;
    mostrar("v-fin");
    // Tras validar, regresa solo al chat (el navegador no se puede cerrar desde la página).
    if (wa && tipo === "ok") setTimeout(function () { window.location.href = wa; }, VOLVER_WA_MS);
  }

  function manejarCorte(res) {
    if (res.status === "ok") {
      cerrar("ok", "ok", "¡Identidad validada!", "Te llevamos de vuelta a WhatsApp para recibir tus documentos.");
      return true;
    }
    if (res.status === "blocked") {
      cerrar("blocked", "err", "Superaste los intentos", "Por seguridad bloqueamos la validación por 30 minutos. Un asesor te ayudará por WhatsApp.");
      return true;
    }
    if (res.status === "expired") {
      cerrar("expired", "warn", "La sesión expiró", "Vuelve a WhatsApp y escribe \"documentos\" para empezar de nuevo.");
      return true;
    }
    return false;
  }

  // ---- Vía 1: cédula + fecha
  $("#f-datos").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var ced = $("#d-cedula"), fecha = $("#d-fecha");
    var cedula = normalizarCedula(ced.value);
    ced.value = cedula;
    ced.setAttribute("aria-invalid", "false");
    fecha.setAttribute("aria-invalid", "false");
    if (!CEDULA_RE.test(cedula)) {
      ced.setAttribute("aria-invalid", "true");
      return alerta(form, ERROR_CEDULA);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha.value)) {
      fecha.setAttribute("aria-invalid", "true");
      return alerta(form, "Selecciona tu fecha de nacimiento.");
    }
    alerta(form, "");
    ocupado(form, true);
    llamar("/autenticar", { cedula: cedula, birthdate: fecha.value }).then(function (res) {
      // Si la validación terminó, el botón sigue en "Procesando…" hasta mostrar la pantalla final:
      // cerrar() aún reanuda el chat y eso tarda un momento.
      if (manejarCorte(res)) return;
      ocupado(form, false);
      if (res.status === "invalid" && res.attemptsLeft === 0) {
        $("#o-cedula").value = cedula;
        mostrar("v-otp-cedula");
        return alerta($("#f-otp-cedula"), "No pudimos validarte con esos datos. Te enviaremos un código a tu correo.", "info");
      }
      var extra = typeof res.attemptsLeft === "number" ? " Te quedan " + res.attemptsLeft + " intento(s)." : "";
      alerta(form, (res.message || "No pudimos validar tus datos.") + extra);
    });
  });

  $("[data-ir-otp]").addEventListener("click", function () {
    var c = normalizarCedula($("#d-cedula").value);
    if (CEDULA_RE.test(c)) $("#o-cedula").value = c;
    mostrar("v-otp-cedula");
  });

  // ---- Vía 2: código al correo
  function iniciarCuentaRegresiva(seg) {
    var b = $("#b-reenviar");
    clearInterval(timerReenvio);
    var restante = Math.max(1, seg || 60);
    b.disabled = true;
    b.textContent = "Reenviar código en " + restante + " s";
    timerReenvio = setInterval(function () {
      restante -= 1;
      if (restante <= 0) {
        clearInterval(timerReenvio);
        b.disabled = false;
        b.textContent = "Reenviar código";
      } else {
        b.textContent = "Reenviar código en " + restante + " s";
      }
    }, 1000);
  }

  $("#f-otp-cedula").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var ced = $("#o-cedula");
    var cedula = normalizarCedula(ced.value);
    ced.value = cedula;
    if (!CEDULA_RE.test(cedula)) {
      ced.setAttribute("aria-invalid", "true");
      return alerta(form, ERROR_CEDULA);
    }
    ced.setAttribute("aria-invalid", "false");
    alerta(form, "");
    ocupado(form, true);
    llamar("/otp-solicitar", { cedula: cedula, reenviar: false }).then(function (res) {
      // Si la validación terminó, el botón sigue en "Procesando…" hasta mostrar la pantalla final:
      // cerrar() aún reanuda el chat y eso tarda un momento.
      if (manejarCorte(res)) return;
      ocupado(form, false);
      if (res.status === "sent" || res.status === "cooldown") {
        mostrar("v-otp-codigo");
        alerta($("#f-otp-codigo"), res.status === "sent" ? res.message : "Ya te enviamos un código hace un momento. Revisa tu correo.", "info");
        return iniciarCuentaRegresiva(res.retryInSeconds);
      }
      alerta(form, res.message || "No pudimos enviar el código.");
    });
  });

  $("#f-otp-codigo").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var inp = $("#o-codigo");
    var otp = String(inp.value || "").replace(/\D/g, "");
    inp.value = otp;
    if (!/^\d{4,6}$/.test(otp)) {
      inp.setAttribute("aria-invalid", "true");
      return alerta(form, "El código tiene 4 dígitos.");
    }
    inp.setAttribute("aria-invalid", "false");
    alerta(form, "");
    ocupado(form, true);
    llamar("/otp-verificar", { otp: otp }).then(function (res) {
      // Si la validación terminó, el botón sigue en "Procesando…" hasta mostrar la pantalla final:
      // cerrar() aún reanuda el chat y eso tarda un momento.
      if (manejarCorte(res)) return;
      ocupado(form, false);
      inp.value = "";
      var extra = typeof res.attemptsLeft === "number" ? " Te quedan " + res.attemptsLeft + " intento(s)." : "";
      alerta(form, (res.message || "No pudimos verificar el código.") + extra);
    });
  });

  $("#b-reenviar").addEventListener("click", function () {
    var form = $("#f-otp-codigo");
    var b = $("#b-reenviar");
    b.disabled = true;
    llamar("/otp-solicitar", { reenviar: true }).then(function (res) {
      if (manejarCorte(res)) return;
      if (res.status === "sent") {
        alerta(form, "Te enviamos un nuevo código.", "info");
        return iniciarCuentaRegresiva(res.retryInSeconds);
      }
      if (res.status === "cooldown") return iniciarCuentaRegresiva(res.retryInSeconds);
      b.disabled = false;
      alerta(form, res.message || "No pudimos reenviar el código.");
    });
  });

  $("[data-cambiar-cedula]").addEventListener("click", function () {
    clearInterval(timerReenvio);
    mostrar("v-otp-cedula");
  });

  $("[data-cancelar]").addEventListener("click", function () {
    cerrar("cancelled", "warn", "Validación cancelada", "Puedes volver a WhatsApp cuando quieras.");
  });

  // ---- Arranque: la sesión la firma la plataforma (cookie) y trae los datos del bot.
  var hoy = new Date();
  $("#d-fecha").max = new Date(hoy.getFullYear() - 18, hoy.getMonth(), hoy.getDate()).toISOString().slice(0, 10);
  $("#d-fecha").min = "1900-01-01";

  fetch("/__jelou/me", { credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (me) {
      var d = (me && me.data) || {};
      if (!d.n || !d.api) throw new Error("datos");
      var guardado = me && me.state && typeof me.state.n === "string" ? me.state.n : "";
      sesion = { n: guardado || d.n, authType: Number(d.authType), phoneMasked: d.phoneMasked || "", api: String(d.api).replace(/\/+$/, ""), wa: String(d.wa || "").replace(/\D/g, "") };
      document.querySelectorAll("[data-phone]").forEach(function (el) { el.textContent = sesion.phoneMasked; });
      if (me.step === "otp-codigo") return mostrar("v-otp-codigo");
      mostrar(sesion.authType === 1 ? "v-datos" : "v-otp-cedula");
    })
    .catch(function () {
      fin("warn", "Este enlace ya no es válido", "Vuelve a WhatsApp y escribe \"documentos\" para recibir uno nuevo.");
    });
})();
