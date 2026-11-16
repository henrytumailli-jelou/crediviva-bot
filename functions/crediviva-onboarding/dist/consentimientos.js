(function () {
  "use strict";

  // Orden de presentación: el tratamiento de datos va primero, antes que cualquier otro documento.
  var DOCUMENTOS = [
    {
      clave: "tratamientoDatos",
      titulo: "Tratamiento de datos personales",
      intro: "Para atender tu solicitud necesitamos tu autorización para tratar tus datos personales.",
      check: "Autorizo a Crediviva el tratamiento de mis datos personales según el aviso de privacidad."
    },
    {
      clave: "terminos",
      titulo: "Términos y condiciones",
      intro: "Estas son las condiciones de uso de los servicios de Crediviva.",
      check: "He leído y acepto los Términos y Condiciones de Crediviva."
    },
    {
      clave: "consultaApc",
      titulo: "Consulta de historial crediticio (APC)",
      intro: "Para evaluar tu crédito necesitamos consultar tu historial en la APC.",
      check: "Autorizo a Crediviva a consultar mi historial crediticio en la APC."
    }
  ];
  var VOLVER_WA_MS = 1500;
  var sesion = null; // { docs, wa }
  var paso = 0;
  var decisiones = {};
  var enviando = false;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function mostrar(id) {
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("is-active", v.id === id); });
    window.scrollTo(0, 0);
  }

  function alerta(texto) {
    var a = $("#f-doc .alert");
    a.hidden = !texto;
    a.textContent = texto || "";
  }

  function guardarProgreso() {
    fetch("/__jelou/state", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "doc-" + paso, state: { paso: paso, decisiones: decisiones } })
    }).catch(function () {});
  }

  function esPdf(url) { return /\.pdf($|[?#])/i.test(url); }

  function pintarDocumento() {
    var d = DOCUMENTOS[paso];
    var url = sesion.docs[d.clave];
    document.querySelectorAll(".pasos span").forEach(function (s, i) { s.classList.toggle("on", i <= paso); });
    $("[data-etapa]").textContent = "Paso " + (paso + 1) + " de " + DOCUMENTOS.length;
    $("[data-titulo-doc]").textContent = d.titulo;
    $("[data-intro]").textContent = d.intro;
    $("[data-check]").textContent = d.check;

    var cont = $("[data-doc]");
    cont.textContent = "";
    if (esPdf(url)) {
      var aviso = document.createElement("div");
      aviso.className = "doc-pdf";
      aviso.textContent = "📄 Toca el enlace para leer el documento completo.";
      cont.appendChild(aviso);
    } else {
      var marco = document.createElement("iframe");
      marco.src = url;
      marco.title = d.titulo;
      marco.loading = "lazy";
      marco.referrerPolicy = "no-referrer";
      cont.appendChild(marco);
    }
    var abrir = document.createElement("a");
    abrir.className = "doc-abrir";
    abrir.href = url;
    abrir.target = "_blank";
    abrir.rel = "noopener noreferrer";
    abrir.textContent = "Abrir documento en pantalla completa ↗";
    cont.appendChild(abrir);

    $("#c-acepto").checked = false;
    $("#b-aceptar").disabled = true;
    $("[data-confirmar]").hidden = true;
    $("#b-rechazar").hidden = false;
    alerta("");
    mostrar("v-doc");
    guardarProgreso();
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
    $(".foot").hidden = true;
    mostrar("v-fin");
    if (wa) setTimeout(function () { window.location.href = wa; }, VOLVER_WA_MS);
  }

  // La función guarda la decisión en Datum y reanuda el flujo en WhatsApp.
  function enviar() {
    if (enviando) return;
    enviando = true;
    var cuerpo = {};
    DOCUMENTOS.forEach(function (d) { cuerpo[d.clave] = decisiones[d.clave] === true; });
    $("#b-aceptar").disabled = true;
    $("#b-confirmar-rechazo").disabled = true;
    fetch("/consentimiento-guardar", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) throw new Error(String(r.status));
        if (j.estado === "aceptado") {
          return fin("ok", "¡Gracias!", j.reanudado === false
            ? "Registramos tu autorización. Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para continuar."
            : "Registramos tu autorización. Te llevamos de vuelta a WhatsApp para continuar.");
        }
        fin("warn", "Decisión registrada", "Sin tu autorización no podemos continuar con la solicitud. Puedes volver a WhatsApp cuando quieras.");
      });
    }).catch(function () {
      enviando = false;
      $("#b-confirmar-rechazo").disabled = false;
      $("#b-aceptar").disabled = !$("#c-acepto").checked;
      alerta("No pudimos registrar tu decisión. Revisa tu conexión e intenta de nuevo.");
    });
  }

  $("#c-acepto").addEventListener("change", function () {
    $("#b-aceptar").disabled = !this.checked || enviando;
    alerta("");
  });

  $("#f-doc").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!$("#c-acepto").checked) return alerta("Marca la casilla para aceptar el documento.");
    decisiones[DOCUMENTOS[paso].clave] = true;
    if (paso < DOCUMENTOS.length - 1) {
      paso += 1;
      return pintarDocumento();
    }
    enviar();
  });

  $("#b-rechazar").addEventListener("click", function () {
    $("[data-confirmar]").hidden = false;
    this.hidden = true;
  });

  $("#b-volver").addEventListener("click", function () {
    $("[data-confirmar]").hidden = true;
    $("#b-rechazar").hidden = false;
  });

  // Rechazar cualquiera de los tres cierra el proceso: los documentos no revisados quedan sin aceptar.
  $("#b-confirmar-rechazo").addEventListener("click", function () {
    decisiones[DOCUMENTOS[paso].clave] = false;
    enviar();
  });

  // ---- Arranque: la sesión la firma la plataforma (cookie) y trae los documentos vigentes.
  fetch("/__jelou/me", { credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (me) {
      var d = (me && me.data) || {};
      var docs = d.docs || {};
      if (!docs.tratamientoDatos || !docs.terminos || !docs.consultaApc) throw new Error("datos");
      sesion = { docs: docs, wa: String(d.wa || "").replace(/\D/g, "") };
      var st = (me && me.state) || {};
      if (st.decisiones && typeof st.decisiones === "object") decisiones = st.decisiones;
      var p = Number(st.paso);
      paso = p >= 0 && p < DOCUMENTOS.length ? p : 0;
      pintarDocumento();
    })
    .catch(function () {
      fin("warn", "Este enlace ya no es válido", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para recibir uno nuevo.");
    });
})();
