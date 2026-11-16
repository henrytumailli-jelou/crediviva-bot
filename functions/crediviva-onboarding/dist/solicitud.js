(function () {
  "use strict";

  // Webview "Solicitud de crédito": monto -> comercios -> dirección -> estudios -> situación laboral
  // -> formulario laboral con documento -> referencias -> PEP. Cada paso lo guarda la función en
  // Crediviva; un 409 ("paso ya completado") avanza al siguiente. PEP devuelve la decisión y reanuda el chat.
  var PASOS = [
    { id: "enter-credit-requested", vista: "v-s-monto" },
    { id: "select-merchants-favorite", vista: "v-s-comercios" },
    { id: "enter-direction", vista: "v-s-direccion" },
    { id: "enter-study-level", vista: "v-s-estudio" },
    { id: "enter-situation-job", vista: "v-s-situacion" },
    { id: "form", vista: "v-s-laboral" },
    { id: "enter-references", vista: "v-s-referencias" },
    { id: "form-pep", vista: "v-s-pep" }
  ];
  var MAX_ARCHIVO = 5 * 1024 * 1024;
  var VOLVER_WA_MS = 1500;
  var TECNICO = "Tuvimos un problema técnico. Intenta de nuevo en unos minutos.";
  var sesion = null; // { wa }
  var op = null; // catálogos de Crediviva
  var actual = 0;
  var formulario = ""; // gobierno | privada | independiente | jubilado ("" = sin formulario laboral)
  var cerrado = false;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function mostrar(id) {
    $$(".view").forEach(function (v) { v.classList.toggle("is-active", v.id === id); });
    $(".foot").hidden = id === "v-fin" || id === "v-cargando";
    window.scrollTo(0, 0);
  }

  function irA(i) {
    // Sin formulario laboral para esta situación: se salta ese paso.
    if (PASOS[i] && PASOS[i].id === "form" && !formulario) i++;
    actual = i;
    var paso = PASOS[i];
    var total = PASOS.length - (formulario ? 0 : 1);
    var n = PASOS.slice(0, i + 1).filter(function (p) { return p.id !== "form" || formulario; }).length;
    var vista = $("#" + paso.vista);
    $("[data-etapa-s]", vista).textContent = "Tu solicitud · Paso " + n + " de " + total;
    $("[data-pasos]", vista).innerHTML = Array.apply(null, Array(total)).map(function (_, k) { return "<span" + (k < n ? " class=\"on\"" : "") + "></span>"; }).join("");
    if (paso.id === "form") prepararLaboral();
    mostrar(paso.vista);
    fetch("/__jelou/state", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: paso.id, state: { formulario: formulario } })
    }).catch(function () {});
  }

  function siguiente() { irA(actual + 1); }

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

  function llamar(ruta, cuerpo) {
    return fetch(ruta, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) return { estado: "expirado" };
        if (!r.ok && !j.estado) return { estado: "error" };
        return j;
      });
    }).catch(function () { return { estado: "red" }; });
  }

  function fin(tipo, titulo, texto) {
    cerrado = true;
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
    if (wa) setTimeout(function () { window.location.href = wa; }, VOLVER_WA_MS);
  }

  // Sale sin terminar (canceló o venció la sesión de Crediviva); la función lo registra y reanuda el chat.
  function cerrarSin(estadoFinal, titulo, texto) {
    if (cerrado) return;
    llamar("/solicitud-cerrar", { estado: estadoFinal }).then(function (res) {
      if (res.estado === estadoFinal) return fin("warn", titulo, texto);
      fin("err", "No pudimos volver al chat", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para intentarlo de nuevo.");
    });
  }

  // Respuesta de un paso: avanza con "ok" o "hecho"; el resto se muestra en el formulario.
  function resultado(form, res) {
    ocupado(form, false);
    if (res.estado === "ok" || res.estado === "hecho") return siguiente();
    if (res.estado === "sin_sesion") {
      return cerrarSin("sin_sesion", "Tu sesión expiró", "Vuelve a WhatsApp: te pediremos iniciar sesión otra vez para continuar tu solicitud.");
    }
    if (res.estado === "expirado") return fin("warn", "Este enlace venció", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para recibir uno nuevo.");
    if (res.estado === "invalido") return alerta(form, res.message || "Revisa los datos e intenta de nuevo.");
    alerta(form, res.estado === "red" ? "No pudimos conectarnos. Revisa tu conexión e intenta de nuevo." : TECNICO);
  }

  function enviar(form, ruta, cuerpo) {
    alerta(form, "");
    ocupado(form, true);
    llamar(ruta, cuerpo).then(function (res) { resultado(form, res); });
  }

  function opciones(select, lista, placeholder) {
    select.innerHTML = "<option value=\"\">" + placeholder + "</option>" + (lista || []).map(function (o) {
      var nombre = String(o.name || o.id || "");
      return "<option value=\"" + nombre.replace(/"/g, "&quot;") + "\">" + nombre.replace(/</g, "&lt;") + "</option>";
    }).join("");
  }

  function requerido(form, campos) {
    var falta = null;
    campos.forEach(function (c) {
      var vacio = !String(c.value || "").trim();
      c.setAttribute("aria-invalid", vacio ? "true" : "false");
      if (vacio && !falta) falta = c;
    });
    if (falta) { alerta(form, "Completa los campos marcados."); falta.focus(); return false; }
    return true;
  }

  // ---- 1. Monto
  $("#f-s-monto").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var v = Number(String($("#s-monto").value).replace(/[$,\s]/g, ""));
    if (!(v > 0)) { $("#s-monto").setAttribute("aria-invalid", "true"); return alerta(form, "Escribe el monto en dólares, por ejemplo 500."); }
    $("#s-monto").setAttribute("aria-invalid", "false");
    enviar(form, "/solicitud-monto", { amount: v });
  });

  // ---- 2. Comercios
  function pintarComercios() {
    $("#s-lista-comercios").innerHTML = (op.comercios || []).map(function (c) {
      var nombre = String(c.name || c.id || "");
      return "<label><input type=\"checkbox\" value=\"" + nombre.replace(/"/g, "&quot;") + "\"> " + nombre.replace(/</g, "&lt;") + "</label>";
    }).join("");
  }
  function contarComercios() {
    var n = $$("#s-lista-comercios input:checked").length;
    $("#s-elegidos").textContent = n ? n + (n === 1 ? " comercio elegido" : " comercios elegidos") : "";
  }
  $("#s-lista-comercios").addEventListener("change", contarComercios);
  $("#s-buscar").addEventListener("input", function () {
    var q = this.value.trim().toLowerCase();
    $$("#s-lista-comercios label").forEach(function (l) { l.hidden = q && l.textContent.toLowerCase().indexOf(q) === -1; });
  });
  $("#f-s-comercios").addEventListener("submit", function (e) {
    e.preventDefault();
    var elegidos = $$("#s-lista-comercios input:checked").map(function (i) { return i.value; });
    if (!elegidos.length) return alerta(e.target, "Elige al menos un comercio.");
    enviar(e.target, "/solicitud-comercios", { favoriteCommerces: elegidos });
  });

  // ---- 3. Dirección (provincia -> distrito -> corregimiento)
  function buscar(lista, nombre) { return (lista || []).filter(function (x) { return String(x.name || x.id) === nombre; })[0]; }
  $("#s-provincia").addEventListener("change", function () {
    var p = buscar(op.provincias, this.value);
    opciones($("#s-distrito"), p ? p.distritos : [], "Elige un distrito");
    $("#s-distrito").disabled = !p;
    opciones($("#s-corregimiento"), [], "Elige un corregimiento");
    $("#s-corregimiento").disabled = true;
  });
  $("#s-distrito").addEventListener("change", function () {
    var p = buscar(op.provincias, $("#s-provincia").value);
    var d = p && buscar(p.distritos, this.value);
    opciones($("#s-corregimiento"), d ? d.corregimientos : [], "Elige un corregimiento");
    $("#s-corregimiento").disabled = !d;
  });
  $("#f-s-direccion").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var campos = ["#s-provincia", "#s-distrito", "#s-corregimiento", "#s-casa-ref", "#s-calle", "#s-casa"].map(function (s) { return $(s); });
    if (!requerido(form, campos)) return;
    enviar(form, "/solicitud-direccion", {
      province: campos[0].value, district: campos[1].value, corregimiento: campos[2].value,
      addressHome: campos[3].value.trim(), addressStreet: campos[4].value.trim(), addressHouse: campos[5].value.trim()
    });
  });

  // ---- 4. Estudios
  $("#f-s-estudio").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!requerido(e.target, [$("#s-estudio")])) return;
    enviar(e.target, "/solicitud-estudio", { levelStudy: $("#s-estudio").value });
  });

  // ---- 5. Situación laboral: define qué formulario laboral pide Crediviva.
  function formularioDe(situacion) {
    var s = String(situacion || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/jubilad|pensionad/.test(s)) return "jubilado";
    if (/independiente|cuenta propia|negocio propio|emprendedor/.test(s)) return "independiente";
    if (/gobierno|gubernamental|public|estado|estatal/.test(s)) return "gobierno";
    if (/privad|empresa|asalariad|empleado/.test(s)) return "privada";
    return "";
  }
  $("#f-s-situacion").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!requerido(e.target, [$("#s-situacion")])) return;
    formulario = formularioDe($("#s-situacion").value);
    enviar(e.target, "/solicitud-situacion", { currentWork: $("#s-situacion").value });
  });

  // ---- 6. Formulario laboral con documento
  var INTRO = {
    gobierno: "Trabajas en una entidad de gobierno. Elige la institución y adjunta tu carta de trabajo o talonario.",
    privada: "Trabajas en una empresa privada. Cuéntanos a qué se dedica y adjunta tu carta de trabajo o talonario.",
    independiente: "Trabajas de forma independiente. Adjunta un documento que respalde tus ingresos (por ejemplo, tu declaración de renta o aviso de operación).",
    jubilado: "Eres jubilado o pensionado. Adjunta tu comprobante de pensión."
  };
  function prepararLaboral() {
    $("[data-laboral-intro]").textContent = INTRO[formulario] || "";
    $("[data-campo=gobierno]").hidden = formulario !== "gobierno";
    $("[data-campo=privada]").hidden = formulario !== "privada";
  }
  // Las fotos se reducen antes de enviarlas: un documento legible pesa mucho menos que la foto original.
  function leerArchivo(file) {
    return new Promise(function (ok, mal) {
      if (file.type === "application/pdf") {
        var r = new FileReader();
        r.onload = function () { ok({ nombre: file.name, tipo: file.type, base64: String(r.result).split(",")[1] }); };
        r.onerror = mal;
        return r.readAsDataURL(file);
      }
      var img = new Image();
      img.onload = function () {
        var escala = Math.min(1, 1600 / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.round(img.width * escala);
        c.height = Math.round(img.height * escala);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        ok({ nombre: file.name.replace(/\.\w+$/, "") + ".jpg", tipo: "image/jpeg", base64: c.toDataURL("image/jpeg", 0.85).split(",")[1] });
      };
      img.onerror = mal;
      img.src = URL.createObjectURL(file);
    });
  }
  $("#f-s-laboral").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var campos = formulario === "gobierno" ? [$("#s-ocupacion")] : formulario === "privada" ? [$("#s-actividad"), $("#s-antiguedad")] : [];
    if (!requerido(form, campos)) return;
    var file = $("#s-archivo").files[0];
    if (!file) return alerta(form, "Adjunta tu documento de trabajo.");
    if (!/^(image\/(png|jpeg)|application\/pdf)$/.test(file.type)) return alerta(form, "El documento debe ser una foto (PNG o JPG) o un PDF.");
    if (file.size > MAX_ARCHIVO && file.type === "application/pdf") return alerta(form, "El PDF supera los 5 MB. Intenta con una foto del documento.");
    alerta(form, "");
    ocupado(form, true);
    leerArchivo(file).then(function (archivo) {
      var cuerpo = { formulario: formulario, archivo: archivo };
      if (formulario === "gobierno") cuerpo.occupation = $("#s-ocupacion").value;
      if (formulario === "privada") { cuerpo.economicActivity = $("#s-actividad").value; cuerpo.seniority = $("#s-antiguedad").value; }
      return llamar("/solicitud-laboral", cuerpo);
    }, function () {
      return { estado: "invalido", message: "No pudimos leer el documento. Intenta con otro archivo." };
    }).then(function (res) { resultado(form, res); });
  });

  // ---- 7. Referencias: el celular se envía con código de país (Panamá si escribe solo 8 dígitos).
  function celular(v) {
    var d = String(v || "").replace(/[^\d+]/g, "");
    if (/^\+\d{8,15}$/.test(d)) return d;
    d = d.replace(/\D/g, "");
    return d.length === 8 ? "+507" + d : d.length >= 10 ? "+" + d : "";
  }
  $("#f-s-referencias").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var ids = ["#s-ref1-nombre", "#s-ref1-tel", "#s-ref1-rel", "#s-ref2-nombre", "#s-ref2-tel", "#s-ref2-rel"];
    var c = ids.map(function (s) { return $(s); });
    if (!requerido(form, c)) return;
    var t1 = celular(c[1].value), t2 = celular(c[4].value);
    if (!t1 || !t2) {
      [[c[1], t1], [c[4], t2]].forEach(function (p) { p[0].setAttribute("aria-invalid", p[1] ? "false" : "true"); });
      return alerta(form, "Revisa los celulares: escribe 8 dígitos, por ejemplo 6123 4567.");
    }
    if (t1 === t2) return alerta(form, "Las dos referencias deben tener celulares distintos.");
    enviar(form, "/solicitud-referencias", {
      nameRef1: c[0].value.trim(), numberRef1: t1, references1: c[2].value,
      nameRef2: c[3].value.trim(), numberRef2: t2, references2: c[5].value
    });
  });

  // ---- 8. PEP: último paso, devuelve la decisión y reanuda el chat.
  // Si es PEP, Crediviva pide el formulario completo (OpenAPI 0.9.0). Las listas vienen del catálogo
  // /options/pep; los campos condicionales solo se muestran (y se envían) cuando aplican.
  function esFamiliar(v) { return /familiar|asociad/i.test(v.relationshipType || ""); }
  function otrosIngresos(v) { return !!v.otherIncomeType && !/^no$/i.test(v.otherIncomeType.trim()); }
  var PEP = [
    { t: "titulo", l: "Tu relación con el cargo público" },
    { k: "relationshipType", t: "lista", l: "¿El cargo es tuyo o de un familiar o asociado cercano?" },
    { k: "relatedPepLink", t: "lista", l: "Vínculo con la persona PEP", si: esFamiliar },
    { k: "relatedPepName", t: "texto", l: "Nombre completo de la persona PEP", si: esFamiliar },
    { t: "titulo", l: "Cargo público" },
    { k: "publicOfficePosition", t: "texto", l: "Cargo público" },
    { k: "publicOfficeInstitution", t: "texto", l: "Institución" },
    { k: "publicOfficeHierarchy", t: "texto", l: "Jerarquía del cargo" },
    { k: "publicOfficePeriod", t: "lista", l: "Período del cargo" },
    { k: "officeStatusStatus", t: "lista", l: "Estatus del cargo" },
    { k: "officeStatusTimeSinceEnded", t: "texto", l: "Tiempo desde que finalizó el cargo", si: function (v) { return /finaliz/i.test(v.officeStatusStatus || ""); } },
    { k: "hasPreviousPublicOffices", t: "sino", l: "¿Ha ocupado otros cargos públicos?" },
    { k: "previousPublicOfficesDetail", t: "texto", l: "Detalle de los cargos públicos anteriores", si: function (v) { return v.hasPreviousPublicOffices === "true"; } },
    { k: "hasInvestigations", t: "sino", l: "¿Existen investigaciones o sanciones en su contra?" },
    { k: "jurisdiction", t: "lista", l: "Jurisdicción" },
    { k: "loanStatus", t: "lista", l: "Estatus de préstamo" },
    { t: "titulo", l: "Ingresos y patrimonio" },
    { k: "incomeMainSource", t: "lista", l: "Fuente principal de ingresos" },
    { k: "incomeApproximateAmount", t: "monto", l: "Monto aproximado de ingresos (USD)" },
    { k: "incomeFrequency", t: "lista", l: "Frecuencia de esos ingresos" },
    { k: "wealthOrigin", t: "lista", l: "Origen del patrimonio" },
    { k: "wealthExplanation", t: "texto", l: "Explica brevemente el origen de tu patrimonio" },
    { k: "wealthSupportDocument", t: "archivo", l: "Documento de soporte del patrimonio" },
    { k: "otherIncomeType", t: "lista", l: "Otras fuentes de ingreso" },
    { k: "otherIncomeExplanation", t: "texto", l: "Explica esos otros ingresos", si: otrosIngresos },
    { k: "otherIncomeEconomicActivity", t: "texto", l: "Actividad económica de esos ingresos", si: otrosIngresos },
    { k: "otherIncomeCompanySeniority", t: "lista", l: "Antigüedad en esa empresa o actividad", si: otrosIngresos },
    { k: "otherIncomePartnersNames", t: "texto", l: "Nombre de los socios (si no tienes, escribe \"Ninguno\")", si: otrosIngresos },
    { k: "otherIncomeSupportDocument", t: "archivo", l: "Documento de soporte de otros ingresos", si: otrosIngresos },
    { t: "titulo", l: "Historial financiero" },
    { k: "hasPreviousFinancialInstitution", t: "sino", l: "¿Has sido cliente de otra entidad financiera?" },
    { k: "debankingWasRejectedOrClosed", t: "sino", l: "¿Alguna entidad te cerró una cuenta o rechazó tu vinculación?" },
    { k: "debankingReason", t: "texto", l: "Motivo, si lo conoces (opcional)", opcional: true, si: function (v) { return v.debankingWasRejectedOrClosed === "true"; } },
    { k: "hasHighRiskJurisdictionLinks", t: "sino", l: "¿Tienes vínculos con jurisdicciones de alto riesgo?" }
  ];

  function esc(v) { return String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }

  function pintarPep() {
    var listas = (op && op.pep) || {};
    $("#s-pep-campos").innerHTML = PEP.map(function (c) {
      if (c.t === "titulo") return "<p class=\"subtitulo\">" + esc(c.l) + "</p>";
      var id = "pep-" + c.k;
      var campo;
      if (c.t === "lista") {
        campo = "<select id=\"" + id + "\" data-pep=\"" + c.k + "\"><option value=\"\">Elige una opción</option>" +
          (listas[c.k] || []).map(function (o) { var n = esc(o.name || o.id); return "<option value=\"" + n + "\">" + n + "</option>"; }).join("") + "</select>";
      } else if (c.t === "sino") {
        campo = "<select id=\"" + id + "\" data-pep=\"" + c.k + "\"><option value=\"\">Elige una opción</option><option value=\"true\">Sí</option><option value=\"false\">No</option></select>";
      } else if (c.t === "archivo") {
        campo = "<input id=\"" + id + "\" type=\"file\" accept=\"image/png,image/jpeg,application/pdf\" data-pep=\"" + c.k + "\"><p class=\"hint\">Foto o PDF, máximo 5 MB.</p>";
      } else if (c.t === "monto") {
        campo = "<input id=\"" + id + "\" type=\"text\" inputmode=\"decimal\" maxlength=\"14\" autocomplete=\"off\" data-pep=\"" + c.k + "\">";
      } else {
        campo = "<input id=\"" + id + "\" type=\"text\" maxlength=\"500\" autocomplete=\"off\" data-pep=\"" + c.k + "\">";
      }
      return "<div data-pep-fila=\"" + c.k + "\"><label for=\"" + id + "\">" + esc(c.l) + "</label>" + campo + "</div>";
    }).join("");
    visibilidadPep();
  }

  function valoresPep() {
    var v = {};
    $$("[data-pep]").forEach(function (el) { if (el.type !== "file") v[el.getAttribute("data-pep")] = String(el.value || "").trim(); });
    return v;
  }

  function visibilidadPep() {
    var v = valoresPep();
    PEP.forEach(function (c) {
      if (!c.k) return;
      $("[data-pep-fila=" + c.k + "]").hidden = !!c.si && !c.si(v);
    });
  }

  $("#s-pep-campos").addEventListener("change", visibilidadPep);
  $$("input[name=s-pep]").forEach(function (r) {
    r.addEventListener("change", function () { $("[data-campo=pep]").hidden = this.value !== "si"; });
  });

  $("#f-s-pep").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var elegido = $("input[name=s-pep]:checked");
    if (!elegido) return alerta(form, "Elige una opción.");
    if (elegido.value !== "si") return enviarPep(form, { isPEP: false });

    // Solo cuentan los campos visibles; todos son obligatorios salvo los marcados como opcionales.
    var v = valoresPep();
    var visibles = PEP.filter(function (c) { return c.k && !(c.si && !c.si(v)); });
    var faltan = visibles.filter(function (c) {
      if (c.opcional) return false;
      var el = $("#pep-" + c.k);
      return c.t === "archivo" ? !el.files[0] : !String(el.value || "").trim();
    });
    visibles.forEach(function (c) { $("#pep-" + c.k).setAttribute("aria-invalid", faltan.indexOf(c) >= 0 ? "true" : "false"); });
    if (faltan.length) { alerta(form, "Completa los campos marcados."); return $("#pep-" + faltan[0].k).focus(); }
    var monto = Number(String(v.incomeApproximateAmount || "").replace(/[$,\s]/g, ""));
    if (!(monto > 0)) { $("#pep-incomeApproximateAmount").setAttribute("aria-invalid", "true"); return alerta(form, "Escribe el monto aproximado en dólares, por ejemplo 2500."); }

    var campos = {};
    visibles.forEach(function (c) { if (c.t !== "archivo" && v[c.k]) campos[c.k] = c.t === "monto" ? String(Math.round(monto * 100) / 100) : v[c.k]; });
    var docs = visibles.filter(function (c) { return c.t === "archivo"; });
    for (var i = 0; i < docs.length; i++) {
      var f = $("#pep-" + docs[i].k).files[0];
      if (!/^(image\/(png|jpeg)|application\/pdf)$/.test(f.type)) return alerta(form, "Los documentos deben ser foto (PNG o JPG) o PDF.");
      if (f.type === "application/pdf" && f.size > MAX_ARCHIVO) return alerta(form, "Un PDF supera los 5 MB. Intenta con una foto del documento.");
    }
    alerta(form, "");
    ocupado(form, true);
    Promise.all(docs.map(function (c) { return leerArchivo($("#pep-" + c.k).files[0]); })).then(function (leidos) {
      var archivos = {};
      docs.forEach(function (c, j) { archivos[c.k] = leidos[j]; });
      ocupado(form, false);
      enviarPep(form, { isPEP: true, campos: campos, archivos: archivos });
    }, function () {
      ocupado(form, false);
      alerta(form, "No pudimos leer uno de los documentos. Intenta con otro archivo.");
    });
  });

  function enviarPep(form, cuerpo) {
    alerta(form, "");
    ocupado(form, true);
    llamar("/solicitud-pep", cuerpo).then(function (res) {
      if (res.estado === "completado") {
        return fin("ok", "¡Enviamos tu solicitud!", "Te llevamos de vuelta a WhatsApp para darte el resultado.");
      }
      resultado(form, res);
    });
  }

  $("[data-cancelar]").addEventListener("click", function () {
    cerrarSin("cancelado", "Solicitud pausada", "Puedes volver a WhatsApp y escribir \"Continuar mi solicitud\" cuando quieras: retomamos donde lo dejaste.");
  });

  // ---- Arranque: sesión firmada por la plataforma; se retoma el paso guardado o el pendiente en Crediviva.
  fetch("/__jelou/me", { credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (me) {
      var d = (me && me.data) || {};
      if (d.tipo !== "solicitud") throw new Error("tipo");
      sesion = { wa: String(d.wa || "").replace(/\D/g, "") };
      var st = (me && me.state) || {};
      formulario = typeof st.formulario === "string" ? st.formulario : "";
      $("[data-pie]").textContent = "🔒 Tus datos viajan cifrados y solo se usan para tu solicitud en Crediviva.";
      $(".foot [data-cancelar]").textContent = "Salir y continuar después";
      $(".foot [data-cancelar]").hidden = false;
      return llamar("/solicitud-opciones").then(function (res) {
        if (res.estado === "expirado") throw new Error("expirado");
        if (res.estado !== "ok") {
          return fin("err", "No pudimos cargar el formulario", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para intentarlo de nuevo.");
        }
        op = res;
        pintarComercios();
        opciones($("#s-provincia"), op.provincias, "Elige una provincia");
        opciones($("#s-distrito"), [], "Elige un distrito");
        opciones($("#s-corregimiento"), [], "Elige un corregimiento");
        opciones($("#s-estudio"), op.estudios, "Elige una opción");
        opciones($("#s-situacion"), op.situaciones, "Elige una opción");
        opciones($("#s-ocupacion"), op.ocupaciones, "Elige una opción");
        opciones($("#s-actividad"), op.industrias, "Elige una opción");
        opciones($("#s-antiguedad"), op.antiguedades, "Elige una opción");
        opciones($("#s-ref1-rel"), op.parentescos1, "Elige una opción");
        opciones($("#s-ref2-rel"), op.parentescos2, "Elige una opción");
        pintarPep();
        // Paso guardado en esta sesión del webview; si no, el pendiente que devolvió el login de Crediviva.
        var paso = typeof me.step === "string" && me.step ? me.step : String(d.paso || "");
        var i = PASOS.map(function (p) { return p.id; }).indexOf(paso);
        // El formulario laboral depende de la situación: si no se conoce, se vuelve a pedir (Crediviva
        // responde "ya completado" a la situación y el formulario sigue con la elegida).
        if (paso === "form" && !formulario) i = 4;
        irA(i >= 0 ? i : 0);
      });
    })
    .catch(function () {
      fin("warn", "Este enlace ya no es válido", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para recibir uno nuevo.");
    });
})();
