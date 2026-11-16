(function () {
  "use strict";

  // Webview "Crear cuenta": correo -> código -> contraseña. Cada paso lo valida la función de
  // onboarding contra Crediviva; la contraseña nunca se guarda en el estado de la sesión.
  var CORREO_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
  var REGLAS = {
    largo: function (v) { return v.length >= 8; },
    mayus: function (v) { return /[A-Z]/.test(v); },
    minus: function (v) { return /[a-z]/.test(v); },
    numero: function (v) { return /\d/.test(v); },
    especial: function (v) { return /[^A-Za-z0-9]/.test(v); }
  };
  var VOLVER_WA_MS = 1500;
  var sesion = null; // { wa }
  // ak = sesión de Crediviva cifrada por la función (solo para validar el celular); resultado = cómo vuelve al chat.
  var estado = { correo: "", v: "", ak: "", resultado: "", tel: "" };
  var cerrado = false;
  var timerReenvio = null;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function mostrar(id) {
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("is-active", v.id === id); });
    var foot = $(".foot");
    foot.hidden = id === "v-fin" || id === "v-cargando";
    var primerCampo = $("#" + id + " input");
    if (primerCampo) setTimeout(function () { primerCampo.focus(); }, 50);
    guardar(id.replace("v-r-", ""));
    window.scrollTo(0, 0);
  }

  function guardar(paso) {
    fetch("/__jelou/state", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: paso, state: { correo: estado.correo, v: estado.v, ak: estado.ak, resultado: estado.resultado, tel: estado.tel } })
    }).catch(function () {});
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

  function enmascarar(correo) {
    var p = correo.split("@");
    return p.length === 2 ? p[0].slice(0, 2) + "*****@" + p[1] : correo;
  }

  var TECNICO = "Tuvimos un problema técnico. Intenta de nuevo en unos minutos.";

  function llamar(ruta, cuerpo) {
    return fetch(ruta, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) return { estado: "expirado" };
        if (!r.ok && !j.estado) return { estado: "error" };
        return j;
      });
    }).catch(function () {
      return { estado: "red" };
    });
  }

  function errorGeneral(form, res) {
    if (res.estado === "expirado") return fin("warn", "Tu sesión expiró", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para recibir un enlace nuevo.");
    alerta(form, res.estado === "red" ? "No pudimos conectarnos. Revisa tu conexión e intenta de nuevo." : TECNICO);
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

  // Sale del webview sin crear la cuenta; la función lo registra y reanuda el chat.
  function cerrarSin(estadoFinal, titulo, texto) {
    if (cerrado) return;
    llamar("/registro-cerrar", estadoFinal === "cancelado" || !estado.correo ? { estado: estadoFinal } : { estado: estadoFinal, email: estado.correo })
      .then(function (res) {
        if (res.estado === estadoFinal) return fin("warn", titulo, texto);
        fin("err", "No pudimos volver al chat", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para intentarlo de nuevo.");
      });
  }

  // ---- Paso 1: correo
  $("#f-correo").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var inp = $("#r-correo");
    var correo = String(inp.value || "").trim().toLowerCase();
    inp.value = correo;
    if (!CORREO_RE.test(correo)) {
      inp.setAttribute("aria-invalid", "true");
      return alerta(form, "Revisa tu correo, por ejemplo: nombre@gmail.com");
    }
    inp.setAttribute("aria-invalid", "false");
    alerta(form, "");
    ocupado(form, true);
    llamar("/registro-correo", { email: correo }).then(function (res) {
      ocupado(form, false);
      if (res.estado === "enviado" || res.estado === "espera") {
        estado.correo = correo;
        estado.v = "";
        irACodigo(res.estado === "enviado" ? "Te enviamos un código de verificación." : "Ya te enviamos un código hace un momento. Revisa tu correo.", res.segundos);
        return;
      }
      if (res.estado === "registrado") {
        estado.correo = correo;
        return irALogin();
      }
      if (res.estado === "app") {
        estado.correo = correo;
        return cerrarSin("app", "Continúa en la App", "Tienes un proceso a tu nombre que debes continuar desde la App de Crediviva.");
      }
      if (res.estado === "invalido") return alerta(form, "Crediviva no pudo validar ese correo. Revísalo e intenta con otro.");
      errorGeneral(form, res);
    });
  });

  // ---- Correo ya registrado: inicio de sesión
  var intentosLogin = 0;
  function irALogin() {
    $("[data-correo]").textContent = estado.correo;
    $("#r-login-clave").value = "";
    alerta($("#f-login"), "");
    mostrar("v-r-login");
  }

  $("#f-login").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var inp = $("#r-login-clave");
    if (!inp.value) return alerta(form, "Ingresa tu contraseña.");
    alerta(form, "");
    ocupado(form, true);
    llamar("/registro-login", { email: estado.correo, password: inp.value }).then(function (res) {
      ocupado(form, false);
      if (res.estado === "telefono") { inp.value = ""; return irATelefono(res); }
      if (res.estado === "sesion_iniciada" || res.estado === "completado") {
        inp.value = "";
        var vuelve = res.reanudado === false
          ? "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para continuar."
          : "Te llevamos de vuelta a WhatsApp para continuar.";
        return fin("ok", "Iniciaste sesión", vuelve);
      }
      if (res.estado === "credenciales_invalidas") {
        inp.value = "";
        intentosLogin += 1;
        return alerta(form, intentosLogin >= 3
          ? "La contraseña no coincide. Si no la recuerdas, recupérala desde la App de Crediviva."
          : "La contraseña no coincide. Revísala e intenta de nuevo.");
      }
      if (res.estado === "espera") return alerta(form, "Hiciste varios intentos. Espera un momento antes de volver a intentar.");
      if (res.estado === "app") return cerrarSin("app", "Continúa en la App", "Tienes un proceso a tu nombre que debes continuar desde la App de Crediviva.");
      errorGeneral(form, res);
    });
  });

  $("#b-otro-correo").addEventListener("click", function () {
    $("#r-correo").value = "";
    mostrar("v-r-correo");
  });

  // ---- Paso 2: código
  function iniciarCuentaRegresiva(seg) {
    var b = $("#b-reenviar");
    clearInterval(timerReenvio);
    var restante = Math.max(1, Number(seg) || 45);
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

  function irACodigo(aviso, segundos) {
    $("[data-correo-mask]").textContent = enmascarar(estado.correo);
    $("#r-codigo").value = "";
    mostrar("v-r-codigo");
    alerta($("#f-codigo"), aviso || "", "info");
    iniciarCuentaRegresiva(segundos);
  }

  $("#f-codigo").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var inp = $("#r-codigo");
    var codigo = String(inp.value || "").replace(/\D/g, "");
    inp.value = codigo;
    if (!/^\d{4,6}$/.test(codigo)) {
      inp.setAttribute("aria-invalid", "true");
      return alerta(form, "El código tiene solo números (entre 4 y 6 dígitos).");
    }
    inp.setAttribute("aria-invalid", "false");
    alerta(form, "");
    ocupado(form, true);
    llamar("/registro-verificar", { email: estado.correo, codigo: codigo }).then(function (res) {
      ocupado(form, false);
      if (res.estado === "verificado" && res.v) {
        estado.v = res.v;
        clearInterval(timerReenvio);
        return mostrar("v-r-clave");
      }
      inp.value = "";
      if (res.estado === "incorrecto") return alerta(form, "El código es incorrecto. Revísalo e intenta de nuevo.");
      if (res.estado === "expirado") return alerta(form, "El código expiró. Toca \"Reenviar código\" para recibir uno nuevo.");
      errorGeneral(form, res);
    });
  });

  $("#b-reenviar").addEventListener("click", function () {
    var form = $("#f-codigo");
    $("#b-reenviar").disabled = true;
    llamar("/registro-reenviar", { email: estado.correo }).then(function (res) {
      if (res.estado === "enviado") {
        alerta(form, "Te enviamos un nuevo código.", "info");
        return iniciarCuentaRegresiva(res.segundos);
      }
      if (res.estado === "espera") {
        alerta(form, "Espera un momento antes de pedir otro código.", "info");
        return iniciarCuentaRegresiva(res.segundos);
      }
      $("#b-reenviar").disabled = false;
      errorGeneral(form, res);
    });
  });

  $("#b-cambiar-correo").addEventListener("click", function () {
    clearInterval(timerReenvio);
    estado.v = "";
    mostrar("v-r-correo");
  });

  // ---- Paso 3: contraseña
  function revisarClave() {
    var v = $("#r-clave").value;
    var v2 = $("#r-clave2").value;
    var todas = true;
    Object.keys(REGLAS).forEach(function (k) {
      var ok = REGLAS[k](v);
      var li = $("[data-regla=" + k + "]");
      li.classList.toggle("ok", ok);
      li.classList.toggle("falta", !ok && v.length > 0);
      if (!ok) todas = false;
    });
    $("#f-clave button[type=submit]").disabled = !(todas && v2.length > 0);
    return todas;
  }
  $("#r-clave").addEventListener("input", revisarClave);
  $("#r-clave2").addEventListener("input", revisarClave);

  document.querySelectorAll("[data-ver]").forEach(function (b) {
    b.addEventListener("click", function () {
      var inp = document.getElementById(b.getAttribute("data-ver"));
      var ver = inp.type === "password";
      inp.type = ver ? "text" : "password";
      b.setAttribute("aria-pressed", ver ? "true" : "false");
    });
  });

  $("#f-clave").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    var clave = $("#r-clave").value;
    if (!revisarClave()) return alerta(form, "Tu contraseña aún no cumple todos los requisitos.");
    if (clave !== $("#r-clave2").value) {
      $("#r-clave2").setAttribute("aria-invalid", "true");
      return alerta(form, "Las contraseñas no coinciden.");
    }
    $("#r-clave2").setAttribute("aria-invalid", "false");
    alerta(form, "");
    ocupado(form, true);
    llamar("/registro-crear", { email: estado.correo, password: clave, v: estado.v }).then(function (res) {
      ocupado(form, false);
      if (res.estado === "telefono") {
        $("#r-clave").value = "";
        $("#r-clave2").value = "";
        return irATelefono(res);
      }
      if (res.estado === "cuenta_creada") {
        $("#r-clave").value = "";
        $("#r-clave2").value = "";
        return fin("ok", "Tu cuenta ha sido creada con éxito", res.reanudado === false
          ? "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para continuar con tu solicitud."
          : "Te llevamos de vuelta a WhatsApp para continuar con tu solicitud.");
      }
      if (res.estado === "contrasena_invalida") {
        return alerta(form, "A tu contraseña le falta: " + (res.faltantes || []).join(", ") + ".");
      }
      if (res.estado === "sin_verificar") {
        estado.v = "";
        mostrar("v-r-codigo");
        return alerta($("#f-codigo"), "Por seguridad, verifica tu correo otra vez.", "info");
      }
      if (res.estado === "registrado") {
        $("#r-clave").value = "";
        $("#r-clave2").value = "";
        return irALogin();
      }
      errorGeneral(form, res);
    });
  });

  // ---- Celular (validación de teléfono del onboarding)
  var metodoTel = "sms";
  var timerTel = null;

  function irATelefono(res) {
    estado.ak = res.ak || estado.ak;
    estado.resultado = res.resultado || estado.resultado;
    if (res.sugerido && !estado.tel) estado.tel = String(res.sugerido);
    $("#r-tel").value = estado.tel;
    mostrar("v-r-tel");
  }

  function telLegible(v) {
    var d = String(v || "").replace(/\D/g, "");
    return d.length === 8 ? d.slice(0, 4) + " " + d.slice(4) : "+" + d;
  }

  function esperaTel(seg) {
    var botones = $tel();
    botones.forEach(function (b) { b.disabled = true; });
    clearInterval(timerTel);
    var resta = seg || 45;
    $("#t-espera").textContent = "Puedes pedir otro código en " + resta + " s";
    timerTel = setInterval(function () {
      resta -= 1;
      if (resta <= 0) {
        clearInterval(timerTel);
        $("#t-espera").textContent = "";
        botones.forEach(function (b) { b.disabled = false; });
        return;
      }
      $("#t-espera").textContent = "Puedes pedir otro código en " + resta + " s";
    }, 1000);
  }
  function $tel() { return Array.prototype.slice.call(document.querySelectorAll("[data-tel-reenviar]")); }

  function irACodigoTel(aviso, seg) {
    $("[data-tel]").textContent = telLegible(estado.tel);
    $("#r-tel-codigo").value = "";
    mostrar("v-r-tel-codigo");
    alerta($("#f-tel-codigo"), aviso || "", "info");
    esperaTel(seg);
  }

  // Vuelve al chat con el resultado del registro o del login.
  function volverTrasTelefono(res) {
    var nueva = estado.resultado === "cuenta_creada";
    var vuelve = res.reanudado === false
      ? "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para continuar."
      : "Te llevamos de vuelta a WhatsApp para continuar con tu solicitud.";
    fin("ok", nueva ? "Tu cuenta ha sido creada con éxito" : "Validamos tu celular", vuelve);
  }

  function errorTel(form, res) {
    if (res.estado === "registrado") return alerta(form, "Ese número ya está registrado en otra cuenta de Crediviva. Usa otro número.");
    if (res.estado === "invalido") return alerta(form, "Ese número no es válido. Escribe tus 8 dígitos, por ejemplo 6123 4567.");
    if (res.estado === "espera") return alerta(form, "Hiciste varios intentos. Espera un momento antes de pedir otro código.");
    if (res.estado === "sin_sesion") return cerrarSin("cancelado", "Tu sesión expiró", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para iniciar sesión otra vez.");
    errorGeneral(form, res);
  }

  $("#f-tel").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var d = String($("#r-tel").value || "").replace(/\D/g, "");
    if (d.length === 11 && d.indexOf("507") === 0) d = d.slice(3);
    if (d.length !== 8) {
      $("#r-tel").setAttribute("aria-invalid", "true");
      return alerta(form, "Escribe tus 8 dígitos, por ejemplo 6123 4567.");
    }
    $("#r-tel").setAttribute("aria-invalid", "false");
    estado.tel = d;
    metodoTel = "sms";
    alerta(form, "");
    ocupado(form, true);
    llamar("/registro-telefono", { ak: estado.ak, telefono: d, resultado: estado.resultado }).then(function (res) {
      if (res.estado === "enviado") { ocupado(form, false); return irACodigoTel("Te enviamos un código por SMS."); }
      if (res.estado === "cuenta_creada" || res.estado === "sesion_iniciada") return volverTrasTelefono(res);
      ocupado(form, false);
      errorTel(form, res);
    });
  });

  $("#f-tel-codigo").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var codigo = String($("#r-tel-codigo").value || "").replace(/\D/g, "");
    if (!/^\d{4,6}$/.test(codigo)) return alerta(form, "Escribe el código que te enviamos.");
    alerta(form, "");
    ocupado(form, true);
    llamar("/registro-telefono-verificar", { ak: estado.ak, telefono: estado.tel, metodo: metodoTel, codigo: codigo, resultado: estado.resultado }).then(function (res) {
      if (res.estado === "cuenta_creada" || res.estado === "sesion_iniciada") return volverTrasTelefono(res);
      ocupado(form, false);
      if (res.estado === "incorrecto") { $("#r-tel-codigo").value = ""; return alerta(form, "El código no coincide o ya venció. Revísalo o pide uno nuevo."); }
      errorTel(form, res);
    });
  });

  $tel().forEach(function (b) {
    b.addEventListener("click", function () {
      var form = $("#f-tel-codigo");
      var metodo = b.getAttribute("data-tel-reenviar");
      b.disabled = true;
      llamar("/registro-telefono-reenviar", { ak: estado.ak, telefono: estado.tel, metodo: metodo }).then(function (res) {
        if (res.estado === "enviado") {
          metodoTel = metodo;
          var via = metodo === "whatsapp" ? "por WhatsApp" : metodo === "call" ? "con una llamada" : "por SMS";
          return irACodigoTel("Te enviamos un nuevo código " + via + ".");
        }
        if (res.estado === "espera") return esperaTel(res.segundos);
        b.disabled = false;
        errorTel(form, res);
      });
    });
  });

  $("#b-cambiar-tel").addEventListener("click", function () {
    clearInterval(timerTel);
    $("#r-tel").value = estado.tel;
    mostrar("v-r-tel");
  });

  $("[data-cancelar]").addEventListener("click", function () {
    cerrarSin("cancelado", "Proceso cancelado", "Puedes volver a WhatsApp y escribir \"Continuar mi solicitud\" cuando quieras.");
  });

  // ---- Arranque: la sesión la firma la plataforma (cookie). Se retoma el paso guardado.
  fetch("/__jelou/me", { credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (me) {
      var d = (me && me.data) || {};
      if (d.tipo !== "registro") throw new Error("tipo");
      sesion = { wa: String(d.wa || "").replace(/\D/g, "") };
      var st = (me && me.state) || {};
      estado.correo = typeof st.correo === "string" ? st.correo : "";
      estado.v = typeof st.v === "string" ? st.v : "";
      estado.ak = typeof st.ak === "string" ? st.ak : "";
      estado.resultado = typeof st.resultado === "string" ? st.resultado : "";
      estado.tel = typeof st.tel === "string" ? st.tel : "";
      $("[data-pie]").textContent = "🔒 Tus datos viajan cifrados y solo se usan para tu solicitud en Crediviva.";
      $("[data-cancelar]").hidden = false;
      if ((me.step === "tel" || me.step === "tel-codigo") && estado.ak && estado.resultado) {
        return me.step === "tel-codigo" && estado.tel ? irACodigoTel("", 1) : irATelefono({});
      }
      if (me.step === "clave" && estado.correo && estado.v) return mostrar("v-r-clave");
      if (me.step === "codigo" && estado.correo) return irACodigo("", 1);
      if (me.step === "login" && estado.correo) return irALogin();
      $("#r-correo").value = estado.correo;
      mostrar("v-r-correo");
    })
    .catch(function () {
      fin("warn", "Este enlace ya no es válido", "Vuelve a WhatsApp y escribe \"Continuar mi solicitud\" para recibir uno nuevo.");
    });
})();
