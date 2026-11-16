import { app, define, z } from "@jelou/functions";

// Backend del onboarding de Crediviva por WhatsApp.
//
// - Consentimientos (Flujo 3): la función sirve la página del webview (dist/) y guarda la decisión
//   en Datum. `consentimientoIniciar` y `consentimientoEstado` los llama el bot con la API key de
//   invocación; `consentimientoGuardar` lo llama la página con la cookie de sesión del webview, así
//   que la identidad del usuario sale del enlace firmado, nunca del cuerpo de la petición.
// - Registro de correo (Flujo 1): `correoValidar`, `correoReenviar` y `correoVerificar` envuelven las
//   APIs de registro de Crediviva y devuelven un `estado` estable para que el flujo enrute.
//
// Los secretos de compañía llegan como COMPANY_<NOMBRE>; los de la función, sin prefijo.

const AMBIENTES = ["staging", "production"] as const;
type Ambiente = (typeof AMBIENTES)[number];

const FUNCTION_SLUG = "crediviva-onboarding";
const LINK_TTL_S = 30 * 60; // vigencia del enlace del webview
const DATUM_HOST_DEFAULT = "https://crediviva-onboarding-v1ghey.jelou.cloud";
const CONSENTIMIENTOS = "consentimientos";
const REGISTROS = "registros";
const SESIONES = "sesiones_pendientes";

// deno-lint-ignore no-explicit-any
type Ctx = any;

function env(ctx: Ctx, name: string): string | undefined {
  return ctx.env.get(name) ?? ctx.env.get(`COMPANY_${name}`);
}

function credenciales(ctx: Ctx, ambiente: Ambiente) {
  const sufijo = ambiente.toUpperCase();
  const baseUrl = env(ctx, `CREDIVIVA_ONBOARDING_BASE_URL_${sufijo}`);
  const apiKey = env(ctx, `CREDIVIVA_API_KEY_${sufijo}`);
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
    throw new Error(`CREDIVIVA_ONBOARDING_BASE_URL_${sufijo} no está configurado`);
  }
  if (!apiKey) throw new Error(`CREDIVIVA_API_KEY_${sufijo} no está configurado`);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

// ---------------------------------------------------------------- HTTP
async function leerJson(res: Response): Promise<Record<string, unknown>> {
  const texto = await res.text();
  try {
    const data = JSON.parse(texto);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function crediviva(ctx: Ctx, ambiente: Ambiente, path: string, init: RequestInit = {}) {
  const { baseUrl, apiKey } = credenciales(ctx, ambiente);
  const headers = new Headers(init.headers);
  headers.set("x-api-key", apiKey);
  headers.set("x-environment", ambiente);
  headers.set("Accept", "application/json");
  // FormData (documento laboral) lleva su propio Content-Type con el boundary.
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  let res: Response;
  const inicio = Date.now();
  // Tamaño del cuerpo enviado (los documentos van en multipart): ayuda a separar lentitud de archivo pesado.
  const peso = init.body instanceof FormData
    ? [...init.body.values()].reduce((t, v) => t + (v instanceof Blob ? v.size : String(v).length), 0)
    : typeof init.body === "string" ? init.body.length : 0;
  const kb = peso ? ` ${Math.round(peso / 1024)} KB` : "";
  try {
    // Formularios web (sesión): la página espera sin límite y la función corta a los 60 s, así que se
    // espera hasta 50 s. Rutas del bot: las tools cortan a los 20-30 s, así que se mantienen 20 s.
    const espera = ctx.session?.id ? 50_000 : 20_000;
    res = await fetch(`${baseUrl}/api${path}`, { ...init, headers, signal: AbortSignal.timeout(espera) });
  } catch (e) {
    ctx.log(`crediviva ${init.method ?? "GET"} ${path}${kb} -> sin respuesta en ${Date.now() - inicio} ms (${String(e).slice(0, 120)})`);
    return { status: 0, ok: false, data: {} as Record<string, unknown> };
  }
  const data = await leerJson(res);
  // En errores se agrega el detalle de Crediviva (sin dígitos: puede citar teléfonos o documentos).
  const detalle = res.ok ? "" : mensajeApi(data).replace(/\d{4,}/g, "****").slice(0, 160);
  ctx.log(`crediviva ${init.method ?? "GET"} ${path}${kb} -> ${res.status} en ${Date.now() - inicio} ms ${String(data.message ?? "")}${detalle ? " | " + detalle : ""}`);
  return { status: res.status, ok: res.ok, data };
}

// La API responde { success, statusCode, message, error: { message } }; `message` trae el código de negocio.
function codigoApi(data: Record<string, unknown>): string {
  return typeof data.message === "string" ? data.message : "";
}

function mensajeApi(data: Record<string, unknown>): string {
  const m = (data.error as Record<string, unknown> | undefined)?.message;
  if (typeof m === "string") return m;
  if (Array.isArray(m)) return m.filter((x) => typeof x === "string").join(". ");
  return "";
}

// "Debe esperar 30 segundos para solicitar un nuevo OTP." -> 30
function segundosEspera(data: Record<string, unknown>): number {
  const n = Number(/(\d+)\s*segundo/i.exec(mensajeApi(data))?.[1]);
  return Number.isFinite(n) && n > 0 ? n : 45;
}

// ---------------------------------------------------------------- Datum
function datum(ctx: Ctx, coleccion: string = CONSENTIMIENTOS) {
  const key = env(ctx, "DATUM_APIKEY_CREDIVIVA");
  if (!key) throw new Error("DATUM_APIKEY_CREDIVIVA no está configurado");
  const host = (env(ctx, "CREDIVIVA_DATUM_HOST") ?? DATUM_HOST_DEFAULT).replace(/\/+$/, "");
  const base = `${host}/api/collections/${coleccion}/records`;
  const headers = { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" };
  return {
    async ultimo(userId: string, telefono: string): Promise<Record<string, unknown> | null> {
      const lit = (v: string) => `'${v.replaceAll("\\", "").replaceAll("'", "")}'`;
      const filtro = telefono ? `(user_id=${lit(userId)} || telefono=${lit(telefono)})` : `user_id=${lit(userId)}`;
      const q = new URLSearchParams({ filter: filtro, sort: "-created", perPage: "1", page: "1" });
      const res = await fetch(`${base}?${q}`, { headers, signal: AbortSignal.timeout(10_000) });
      const data = await leerJson(res);
      if (!res.ok) throw new Error(`Datum respondió ${res.status} al consultar ${coleccion}`);
      const items = Array.isArray(data.items) ? data.items : [];
      return (items[0] as Record<string, unknown>) ?? null;
    },
    async crear(registro: Record<string, unknown>): Promise<Record<string, unknown>> {
      const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(registro), signal: AbortSignal.timeout(10_000) });
      const data = await leerJson(res);
      if (!res.ok) throw new Error(`Datum respondió ${res.status} al guardar en ${coleccion}`);
      return data;
    },
    async actualizar(id: string, cambios: Record<string, unknown>): Promise<void> {
      const res = await fetch(`${base}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(cambios),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Datum respondió ${res.status} al actualizar ${coleccion}`);
    },
  };
}

function estadoConsentimiento(r: Record<string, unknown> | null): "aceptado" | "rechazado" | "sin_registro" {
  if (!r) return "sin_registro";
  return r.aceptado === true && r.estado === "aceptado" ? "aceptado" : "rechazado";
}

// Meta entrega el número con o sin prefijo; se guarda solo en dígitos, con código de país.
function telefonoDigitos(raw: string | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^00/, "");
  if (d.length === 8) return "507" + d;
  return d.length >= 7 && d.length <= 15 ? d : "";
}

// ---------------------------------------------------------------- Webview
async function mintLink(ctx: Ctx, userId: string, botId: string | undefined, data: Record<string, unknown>) {
  const key = env(ctx, "JELOU_FUNCTIONS_API_KEY");
  if (!key) throw new Error("JELOU_FUNCTIONS_API_KEY no está configurado");
  const res = await fetch("https://gateway.jelou.ai/functions/webview/links", {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ function: FUNCTION_SLUG, user_id: userId, ...(botId ? { bot_id: botId } : {}), data, ttl: LINK_TTL_S }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await leerJson(res);
  const cuerpo = (j.data && typeof j.data === "object" ? j.data : j) as Record<string, unknown>;
  if (res.ok && typeof cuerpo.url === "string") return cuerpo.url;
  throw new Error(`No se pudo generar el enlace del webview: ${res.status} ${JSON.stringify(j).slice(0, 500)}`);
}

type Documentos = { tratamientoDatos: string; terminos: string; consultaApc: string };

async function documentos(ctx: Ctx, ambiente: Ambiente): Promise<Documentos | null> {
  const r = await crediviva(ctx, ambiente, "/register/terms-and-conditions");
  const d = (r.data.data ?? {}) as Record<string, unknown>;
  const url = (v: unknown) => (typeof v === "string" && /^https:\/\//.test(v) ? v : "");
  const docs = { tratamientoDatos: url(d.dataProcessingUrl), terminos: url(d.termsAndConditionsUrl), consultaApc: url(d.disclaimerApcUrl) };
  return r.ok && docs.tratamientoDatos && docs.terminos && docs.consultaApc ? docs : null;
}

// ---------------------------------------------------------------- Registro (Flujo 1 + Flujo 4)
// Mismas reglas que muestra la página; se revalidan aquí porque el navegador no es de fiar.
function faltantesContrasena(pw: string): string[] {
  const falta: string[] = [];
  if (pw.length < 8) falta.push("mínimo 8 caracteres");
  if (!/[A-Z]/.test(pw)) falta.push("una mayúscula");
  if (!/[a-z]/.test(pw)) falta.push("una minúscula");
  if (!/\d/.test(pw)) falta.push("un número");
  if (!/[^A-Za-z0-9]/.test(pw)) falta.push("un carácter especial");
  return falta;
}

// Prueba de que el correo pasó el OTP en ESTA sesión del webview: el estado de la sesión lo puede
// escribir el navegador (/__jelou/state), así que no sirve para eso; esta firma solo la emite la función.
const VERIFICADO_TTL_MS = 30 * 60 * 1000;

async function firma(ctx: Ctx, texto: string): Promise<string> {
  const secreto = env(ctx, "REGISTRO_STATE_KEY");
  if (!secreto || secreto.length < 32) throw new Error("REGISTRO_STATE_KEY no está configurado");
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(texto)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function emitirVerificado(ctx: Ctx, email: string): Promise<string> {
  const exp = Date.now() + VERIFICADO_TTL_MS;
  return `${exp}.${await firma(ctx, `${ctx.session?.id}|${email}|${exp}`)}`;
}

async function verificadoValido(ctx: Ctx, email: string, token: string): Promise<boolean> {
  const [exp, mac] = token.split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return mac === await firma(ctx, `${ctx.session?.id}|${email}|${exp}`);
}

function datosSesion(ctx: Ctx) {
  const s = (ctx.session?.data ?? {}) as Record<string, unknown>;
  const ambiente: Ambiente = AMBIENTES.includes(s.ambiente as Ambiente) ? (s.ambiente as Ambiente) : "staging";
  const userId = String(s.userId ?? ctx.user?.id ?? "");
  if (!userId) throw new Error("La sesión del webview no trae el usuario");
  return { userId, telefono: String(s.telefono ?? ""), ambiente };
}

// ---------------------------------------------------------------- Resultado del registro
// Desde las rutas del webview la memoria del usuario no está disponible (la plataforma no resuelve al
// usuario sin el bot), así que el resultado se entrega al bot por Datum:
//   sesiones_pendientes = { user_id, estado, paso, decision, origen, ambiente, clave, expira }
// `clave` es el authKey cifrado (AES-GCM, llave derivada de REGISTRO_STATE_KEY) y el registro vive
// SESION_PENDIENTE_TTL_MS. Al volver al chat el bot llama a `registroEstado`, que lo lee, lo consume y
// le devuelve el authKey para que el workflow lo guarde en $memory.cv_sesionCrediviva.
// En Datum (registros) queda además la bitácora de usuarios, sin clave.
const SESION_PENDIENTE_TTL_MS = 15 * 60 * 1000;

type Resultado = "cuenta_creada" | "sesion_iniciada" | "completado" | "app" | "cancelado" | "sin_sesion";

// Mensaje de error apto para el log: sin el authKey aunque el error lo arrastre.
function errorSeguro(e: unknown, secreto?: string): string {
  let m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (secreto) m = m.split(secreto).join("***");
  return m.slice(0, 200);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const desdeB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function llaveSesion(ctx: Ctx): Promise<CryptoKey> {
  const secreto = env(ctx, "REGISTRO_STATE_KEY");
  if (!secreto || secreto.length < 32) throw new Error("REGISTRO_STATE_KEY no está configurado");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sesion-pendiente|${secreto}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// El userId va como dato asociado: un registro copiado a otro usuario no se descifra.
async function cifrar(ctx: Ctx, texto: string, userId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ad = new TextEncoder().encode(userId);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, await llaveSesion(ctx), new TextEncoder().encode(texto)));
  return `${b64(iv)}.${b64(ct)}`;
}

async function descifrar(ctx: Ctx, sobre: string, userId: string): Promise<string> {
  const [iv, ct] = sobre.split(".");
  const ad = new TextEncoder().encode(userId);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: desdeB64(iv), additionalData: ad }, await llaveSesion(ctx), desdeB64(ct));
  return new TextDecoder().decode(pt);
}

type ParaBot = {
  userId: string; ambiente: Ambiente; estado: Resultado;
  authKey?: string; origen?: "registro" | "login" | "solicitud"; paso?: string; decision?: string;
  mensaje?: string; monto?: number;
};

async function registrarResultado(ctx: Ctx, r: ParaBot & { telefono: string; correo: string }) {
  await dejarParaBot(ctx, r);
  // Bitácora: un ya registrado que inicia sesión queda como "registrado".
  const estadoDatum = r.estado === "cuenta_creada" ? "cuenta_creada" : r.estado === "app" || r.estado === "cancelado" ? r.estado : "registrado";
  try {
    await datum(ctx, REGISTROS).crear({
      user_id: r.userId,
      telefono: r.telefono,
      correo: r.correo,
      estado: estadoDatum,
      fecha: new Date().toISOString(),
      ambiente: r.ambiente,
      canal: "whatsapp",
    });
  } catch (e) {
    ctx.log(`registrarResultado: no se pudo guardar la bitácora (${String(e).slice(0, 160)})`);
  }
}

async function dejarParaBot(ctx: Ctx, r: ParaBot) {
  // El authKey nunca se imprime: ni el valor ni su longitud.
  try {
    await datum(ctx, SESIONES).crear({
      user_id: r.userId,
      ambiente: r.ambiente,
      estado: r.estado,
      paso: r.paso ?? "",
      decision: r.decision ?? "",
      origen: r.origen ?? "",
      mensaje: r.mensaje ?? "",
      monto: r.monto ?? 0,
      clave: r.authKey ? await cifrar(ctx, r.authKey, r.userId) : "",
      expira: new Date(Date.now() + SESION_PENDIENTE_TTL_MS).toISOString(),
    });
  } catch (e) {
    ctx.log(`dejarParaBot: no se pudo dejar el resultado para el bot (${errorSeguro(e, r.authKey)})`);
  }
}

// Registro de usuarios: el correo queda junto al consentimiento aceptado.
async function asociarCorreo(ctx: Ctx, userId: string, telefono: string, correo: string) {
  try {
    const d = datum(ctx);
    const previo = await d.ultimo(userId, telefono);
    if (estadoConsentimiento(previo) === "aceptado" && typeof previo?.id === "string") {
      await d.actualizar(previo.id, { correo });
    }
  } catch (e) {
    ctx.log(`no se pudo asociar el correo al consentimiento (${String(e).slice(0, 160)})`);
  }
}

// ---------------------------------------------------------------- KYC y evaluación
// El authKey llega desde $memory.cv_sesionCrediviva (lo guarda el workflow con registroEstado). Nunca se imprime.
const authKeySchema = z.string().min(10).max(4096);
const INGRESO_MINIMO = 100; // SOW: monto mínimo $100

// Traduce las respuestas de KYC de Crediviva a un estado estable para el flujo.
function estadoKyc(r: { status: number; data: Record<string, unknown> }): Record<string, unknown> {
  const msg = mensajeApi(r.data).toLowerCase();
  const err = (r.data.error ?? {}) as Record<string, unknown>;
  const alternativa = err.canUseAlternativeKyc === true || r.data.canUseAlternativeKyc === true;
  switch (r.status) {
    case 401: return { estado: "sin_sesion" };
    case 403: return { estado: "app" };
    case 409:
      if (msg.includes("completado")) return { estado: "completado" };
      return { estado: "bloqueado", alternativa };
    case 410: return { estado: "reintentar" };
    case 411: return { estado: "procesada" };
    case 412: return { estado: "cliente_existente" };
    case 413: return { estado: "sin_verificacion" };
    case 503: return { estado: "no_lista" };
    case 400: return { estado: "sesion_invalida" };
    default: return { estado: "error", status: r.status };
  }
}

// Reanuda el chat. Si el flujo ya no espera (venció la espera o el enlace se abrió de nuevo), la
// decisión igual quedó en Datum: el bot la lee al volver, así que no se trata como error.
async function completarSesion(ctx: Ctx, data: Record<string, unknown>): Promise<boolean> {
  try {
    await ctx.session!.complete(data);
    return true;
  } catch (e) {
    ctx.log(`session.complete falló (${String(e).slice(0, 160)}); el resultado ya está en Datum`);
    return false;
  }
}

const bot = { methods: ["POST"], mcp: false };
// Documento adjunto que la página manda en base64 (formulario laboral y PEP).
const archivoSchema = z.object({
  nombre: z.string().min(1).max(120),
  tipo: z.enum(["image/png", "image/jpeg", "application/pdf"]),
  base64: z.string().min(10).max(7_000_000),
});
// Campos del formulario PEP que acepta form-pep (OpenAPI 0.9.0); el resto se descarta.
const PEP_CAMPOS = new Set(["pepCode", "loanStatus", "jurisdiction", "relationshipType", "relatedPepLink", "relatedPepName",
  "publicOfficePosition", "publicOfficeInstitution", "publicOfficeHierarchy", "publicOfficePeriod", "hasPreviousPublicOffices",
  "previousPublicOfficesDetail", "officeStatusStatus", "officeStatusTimeSinceEnded", "hasInvestigations", "incomeMainSource",
  "incomeApproximateAmount", "incomeFrequency", "wealthOrigin", "wealthExplanation", "otherIncomeType", "otherIncomeExplanation",
  "otherIncomeEconomicActivity", "otherIncomeCompanySeniority", "otherIncomePartnersNames", "hasPreviousFinancialInstitution",
  "debankingWasRejectedOrClosed", "debankingReason", "hasHighRiskJurisdictionLinks"]);
const PEP_ARCHIVOS = new Set(["wealthSupportDocument", "otherIncomeSupportDocument"]);
// Números autorizados para el atajo de pruebas (pruebaLogin). Solo aplica en staging.
const NUMEROS_PRUEBA = new Set(["593984181411"]);
// Teléfono del onboarding (se usan al definir las rutas, por eso van antes de app()).
const telefonoSchema = z.string().trim().min(7).max(20);
const metodoSchema = z.enum(["sms", "whatsapp", "call"]).default("sms");
const sesion = { auth: "session", methods: ["POST"] } as const;
const email = z.string().trim().toLowerCase().email().max(254);

export default app({
  config: {
    timeout: 60_000,
    static: { dir: "./dist", spa: false },
  },
  tools: {
    // Lo llama el bot: si el usuario ya aceptó los tres documentos no se le vuelve a pedir nada;
    // si no, devuelve el enlace del webview con los documentos vigentes de Crediviva.
    consentimientoIniciar: define({
      description: "Revisa el consentimiento del usuario y, si falta, crea el enlace del webview de consentimientos",
      input: z.object({
        userId: z.string().min(1).describe("Id del usuario en Jelou ($user.id)"),
        botId: z.string().optional().describe("Id del bot ($bot.id)"),
        phone: z.string().max(32).optional().describe("Teléfono del usuario ($user.phone), si se conoce"),
        ambiente: z.enum(AMBIENTES),
      }),
      config: bot,
      handler: async (input, ctx) => {
        const telefono = telefonoDigitos(input.phone);
        const previo = await datum(ctx).ultimo(input.userId, telefono);
        if (estadoConsentimiento(previo) === "aceptado") return { estado: "aceptado" };

        const docs = await documentos(ctx, input.ambiente);
        if (!docs) return { estado: "error", message: "No se pudieron obtener los documentos de consentimiento." };

        const wa = (env(ctx, "CREDIVIVA_WHATSAPP_NUMBER") ?? "").replace(/\D/g, "");
        const url = await mintLink(ctx, input.userId, input.botId, {
          userId: input.userId,
          telefono,
          ambiente: input.ambiente,
          docs,
          ...(wa ? { wa } : {}),
        });
        return { estado: "pendiente", url, ttlSeconds: LINK_TTL_S };
      },
    }),

    // Lo llama la página al terminar. Los datos del usuario y las URLs mostradas vienen del enlace
    // firmado (ctx.session.data); del navegador solo se toman las tres decisiones.
    consentimientoGuardar: define({
      description: "Guarda en Datum la decisión del usuario sobre los tres documentos y cierra el webview",
      input: z.object({
        tratamientoDatos: z.boolean(),
        terminos: z.boolean(),
        consultaApc: z.boolean(),
      }),
      config: sesion,
      handler: async (input, ctx, request) => {
        const s = (ctx.session?.data ?? {}) as Record<string, unknown>;
        const docs = (s.docs ?? {}) as Partial<Documentos>;
        const userId = String(s.userId ?? ctx.user?.id ?? "");
        if (!userId) throw new Error("La sesión del webview no trae el usuario");
        const aceptado = input.tratamientoDatos && input.terminos && input.consultaApc;
        const estado = aceptado ? "aceptado" : "rechazado";
        await datum(ctx).crear({
          user_id: userId,
          telefono: String(s.telefono ?? ""),
          tratamiento_datos: input.tratamientoDatos,
          terminos: input.terminos,
          consulta_apc: input.consultaApc,
          aceptado,
          estado,
          fecha_decision: new Date().toISOString(),
          url_tratamiento_datos: docs.tratamientoDatos ?? "",
          url_terminos: docs.terminos ?? "",
          url_apc: docs.consultaApc ?? "",
          ambiente: AMBIENTES.includes(s.ambiente as Ambiente) ? s.ambiente : "staging",
          canal: "whatsapp",
          user_agent: (request.headers.get("user-agent") ?? "").slice(0, 300),
        });
        const reanudado = await completarSesion(ctx, { estado });
        return { ok: true, estado, reanudado };
      },
    }),

    // Comando "reiniciar prueba" (solo staging): el consentimiento vuelve a pedirse. No se borra ni se
    // edita la firma anterior (es la constancia legal): se agrega un registro de reinicio, que pasa a ser
    // el último y no está aceptado.
    pruebaReiniciar: define({
      description: "Reinicia los consentimientos de un número de prueba (solo ambiente staging)",
      input: z.object({
        userId: z.string().min(1),
        phone: z.string().max(32).optional(),
        ambiente: z.enum(AMBIENTES),
      }),
      config: bot,
      handler: async (input, ctx) => {
        if (input.ambiente !== "staging") return { estado: "no_permitido" };
        await datum(ctx).crear({
          user_id: input.userId,
          telefono: telefonoDigitos(input.phone),
          tratamiento_datos: false,
          terminos: false,
          consulta_apc: false,
          aceptado: false,
          estado: "rechazado",
          fecha_decision: new Date().toISOString(),
          ambiente: "staging",
          canal: "reinicio-prueba",
        });
        return { estado: "reiniciado" };
      },
    }),

    // Atajo de pruebas (solo staging y solo NUMEROS_PRUEBA): login directo con correo y contraseña
    // capturados en el chat, sin formulario, para llegar a la evaluación sin celular ni KYC.
    pruebaLogin: define({
      description: "Login de prueba en Crediviva para números autorizados (solo staging)",
      input: z.object({
        userId: z.string().min(1),
        email,
        password: z.string().min(1).max(128),
        ambiente: z.enum(AMBIENTES),
      }),
      config: bot,
      handler: async (input, ctx) => {
        if (input.ambiente !== "staging" || !NUMEROS_PRUEBA.has(input.userId.replace(/\D/g, ""))) return { estado: "no_permitido" };
        const r = await crediviva(ctx, input.ambiente, "/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: input.email, password: input.password }),
        });
        const d = ((r.data.data && typeof r.data.data === "object" ? r.data.data : r.data) ?? {}) as Record<string, unknown>;
        if (!r.ok && r.status >= 400 && r.status < 500) return { estado: "credenciales_invalidas" };
        if (!r.ok || typeof d.authKey !== "string" || !d.authKey) return { estado: "error" };
        const decision = (d.decision ?? null) as Record<string, unknown> | null;
        return {
          estado: d.completed === true || !!decision?.status ? "completado" : "sesion_iniciada",
          authKey: d.authKey,
          paso: typeof d.step === "string" ? d.step : "",
          decision: typeof decision?.status === "string" ? decision.status : "",
        };
      },
    }),

    // Lo llama el bot al volver del webview. La verdad está en Datum, no en el callback de la página.
    consentimientoEstado: define({
      description: "Devuelve el último consentimiento registrado del usuario",
      input: z.object({
        userId: z.string().min(1),
        phone: z.string().max(32).optional(),
      }),
      config: bot,
      handler: async (input, ctx) => {
        return { estado: estadoConsentimiento(await datum(ctx).ultimo(input.userId, telefonoDigitos(input.phone))) };
      },
    }),

    // Flujo 1: valida el correo en Crediviva; si es nuevo, Crediviva envía el código OTP.
    correoValidar: define({
      description: "Valida el correo del usuario en Crediviva y envía el código OTP si es nuevo",
      input: z.object({ email, ambiente: z.enum(AMBIENTES) }),
      config: bot,
      handler: async (input, ctx) => {
        const r = await crediviva(ctx, input.ambiente, "/register/validate-email-client", {
          method: "POST",
          body: JSON.stringify({ email: input.email }),
        });
        if (r.ok) return { estado: "enviado" };
        if (r.status === 400) return { estado: "invalido" };
        if (r.status === 403) return { estado: "app", motivo: codigoApi(r.data) };
        if (r.status === 409) return { estado: "registrado" };
        if (r.status === 429) return { estado: "espera", segundos: segundosEspera(r.data) };
        return { estado: "error", status: r.status };
      },
    }),

    correoReenviar: define({
      description: "Reenvía el código OTP al correo del usuario",
      input: z.object({ email, ambiente: z.enum(AMBIENTES) }),
      config: bot,
      handler: async (input, ctx) => {
        const r = await crediviva(ctx, input.ambiente, "/register/send-email-otp", {
          method: "POST",
          body: JSON.stringify({ email: input.email }),
        });
        if (r.ok) return { estado: "enviado" };
        if (r.status === 429) return { estado: "espera", segundos: segundosEspera(r.data) };
        if (r.status === 400) return { estado: "invalido" };
        return { estado: "error", status: r.status };
      },
    }),

    correoVerificar: define({
      description: "Verifica el código OTP del correo y lo asocia al consentimiento del usuario",
      input: z.object({
        email,
        codigo: z.string().regex(/^\d{4,6}$/),
        ambiente: z.enum(AMBIENTES),
        userId: z.string().optional(),
        phone: z.string().max(32).optional(),
      }),
      config: bot,
      handler: async (input, ctx) => {
        const r = await crediviva(ctx, input.ambiente, "/register/verify-email-otp", {
          method: "POST",
          body: JSON.stringify({ email: input.email, code: input.codigo }),
        });
        if (r.ok) {
          // Registro de usuarios en Datum: el correo verificado queda junto al consentimiento.
          if (input.userId) {
            try {
              const d = datum(ctx);
              const previo = await d.ultimo(input.userId, telefonoDigitos(input.phone));
              if (estadoConsentimiento(previo) === "aceptado" && typeof previo?.id === "string") {
                await d.actualizar(previo.id, { correo: input.email });
              }
            } catch (e) {
              ctx.log(`correoVerificar: no se pudo asociar el correo en Datum (${String(e).slice(0, 160)})`);
            }
          }
          return { estado: "verificado" };
        }
        const codigo = codigoApi(r.data);
        if (codigo === "OTP_EXPIRED") return { estado: "expirado" };
        if (r.status === 400) return { estado: "incorrecto" };
        return { estado: "error", status: r.status };
      },
    }),

    // ---- Webview "Crear cuenta": correo -> (nuevo) código + contraseña -> create-client
    //                                     -> (ya registrado) contraseña -> login

    // Lo llama el bot. Si hay una sesión vigente ni se llama: el workflow la revisa en memoria.
    registroIniciar: define({
      description: "Crea el enlace del webview de registro (crear cuenta o iniciar sesión)",
      input: z.object({
        userId: z.string().min(1).describe("Id del usuario en Jelou ($user.id)"),
        botId: z.string().optional().describe("Id del bot ($bot.id)"),
        phone: z.string().max(32).optional().describe("Teléfono del usuario ($user.phone), si se conoce"),
        ambiente: z.enum(AMBIENTES),
      }),
      config: bot,
      handler: async (input, ctx) => {
        const telefono = telefonoDigitos(input.phone);
        const wa = (env(ctx, "CREDIVIVA_WHATSAPP_NUMBER") ?? "").replace(/\D/g, "");
        const url = await mintLink(ctx, input.userId, input.botId, {
          tipo: "registro",
          userId: input.userId,
          telefono,
          ambiente: input.ambiente,
          ...(wa ? { wa } : {}),
        });
        return { estado: "pendiente", url, ttlSeconds: LINK_TTL_S };
      },
    }),

    registroCorreo: define({
      description: "Valida el correo en Crediviva y envía el código de verificación",
      input: z.object({ email }),
      config: sesion,
      handler: async (input, ctx) => {
        const { ambiente } = datosSesion(ctx);
        const r = await crediviva(ctx, ambiente, "/register/validate-email-client", {
          method: "POST",
          body: JSON.stringify({ email: input.email }),
        });
        if (r.ok) return { estado: "enviado" };
        if (r.status === 400) return { estado: "invalido" };
        if (r.status === 403) return { estado: "app" };
        if (r.status === 409) return { estado: "registrado" };
        if (r.status === 429) return { estado: "espera", segundos: segundosEspera(r.data) };
        return { estado: "error" };
      },
    }),

    registroReenviar: define({
      description: "Reenvía el código de verificación al correo",
      input: z.object({ email }),
      config: sesion,
      handler: async (input, ctx) => {
        const { ambiente } = datosSesion(ctx);
        const r = await crediviva(ctx, ambiente, "/register/send-email-otp", {
          method: "POST",
          body: JSON.stringify({ email: input.email }),
        });
        if (r.ok) return { estado: "enviado" };
        if (r.status === 429) return { estado: "espera", segundos: segundosEspera(r.data) };
        return { estado: "error" };
      },
    }),

    registroVerificar: define({
      description: "Verifica el código del correo y entrega la prueba firmada para crear la cuenta",
      input: z.object({ email, codigo: z.string().regex(/^\d{4,6}$/) }),
      config: sesion,
      handler: async (input, ctx) => {
        const { ambiente } = datosSesion(ctx);
        const r = await crediviva(ctx, ambiente, "/register/verify-email-otp", {
          method: "POST",
          body: JSON.stringify({ email: input.email, code: input.codigo }),
        });
        if (r.ok) return { estado: "verificado", v: await emitirVerificado(ctx, input.email) };
        if (codigoApi(r.data) === "OTP_EXPIRED") return { estado: "expirado" };
        if (r.status === 400) return { estado: "incorrecto" };
        return { estado: "error" };
      },
    }),

    // Correo nuevo: crea la cuenta en Crediviva y deja la sesión (authKey) para que el bot la recoja.
    registroCrear: define({
      description: "Crea la cuenta del cliente en Crediviva con el correo verificado y su contraseña",
      input: z.object({ email, password: z.string().min(1).max(128), v: z.string().min(10).max(200) }),
      config: sesion,
      handler: async (input, ctx) => {
        const { userId, telefono, ambiente } = datosSesion(ctx);
        if (!(await verificadoValido(ctx, input.email, input.v))) {
          return { estado: "sin_verificar", message: "Vuelve a verificar tu correo para continuar." };
        }
        const falta = faltantesContrasena(input.password);
        if (falta.length) return { estado: "contrasena_invalida", faltantes: falta };

        const r = await crediviva(ctx, ambiente, "/register/create-client", {
          method: "POST",
          body: JSON.stringify({ email: input.email, password: input.password }),
        });
        const authKey = ((r.data.data ?? {}) as Record<string, unknown>).authKey;
        if (r.status === 409) return { estado: "registrado" };
        if (!r.ok || typeof authKey !== "string" || !authKey) return { estado: "error" };

        await registrarResultado(ctx, { userId, telefono, ambiente, correo: input.email, authKey, origen: "registro", estado: "cuenta_creada" });
        await asociarCorreo(ctx, userId, telefono, input.email);
        // Cuenta nueva: en Crediviva el siguiente paso es validar el teléfono, antes del KYC.
        return { estado: "telefono", resultado: "cuenta_creada", ak: await cifrar(ctx, authKey, userId), sugerido: telefonoLocal(telefono) };
      },
    }),

    // Correo ya registrado: inicia sesión con su contraseña y retoma el onboarding donde quedó.
    registroLogin: define({
      description: "Inicia sesión en Crediviva con el correo ya registrado y su contraseña",
      input: z.object({ email, password: z.string().min(1).max(128) }),
      config: sesion,
      handler: async (input, ctx) => {
        const { userId, telefono, ambiente } = datosSesion(ctx);
        const r = await crediviva(ctx, ambiente, "/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: input.email, password: input.password }),
        });
        // El login responde el cuerpo plano; se acepta también el sobre { data } por si cambia.
        const d = ((r.data.data && typeof r.data.data === "object" ? r.data.data : r.data) ?? {}) as Record<string, unknown>;
        const authKey = d.authKey;
        if (r.status === 403) return { estado: "app" };
        if (r.status === 429) return { estado: "espera", segundos: segundosEspera(r.data) };
        if (!r.ok && r.status >= 400 && r.status < 500) return { estado: "credenciales_invalidas" };
        if (!r.ok || typeof authKey !== "string" || !authKey) return { estado: "error" };

        const decision = (d.decision ?? null) as Record<string, unknown> | null;
        const completado = d.completed === true || !!decision?.status;
        const estado = completado ? "completado" : "sesion_iniciada";
        await registrarResultado(ctx, {
          userId, telefono, ambiente, correo: input.email, authKey, origen: "login", estado,
          paso: typeof d.step === "string" ? d.step : "", decision: typeof decision?.status === "string" ? decision.status : "",
        });
        await asociarCorreo(ctx, userId, telefono, input.email);
        if (!completado && /phone/i.test(String(d.step ?? ""))) {
          return { estado: "telefono", resultado: estado, ak: await cifrar(ctx, authKey, userId), sugerido: telefonoLocal(telefono) };
        }
        const reanudado = await completarSesion(ctx, { estado });
        return { estado, reanudado };
      },
    }),

    // Lo llama el bot al volver del webview: entrega (una sola vez) cómo terminó y, si inició sesión o
    // creó la cuenta, el authKey para que el workflow lo guarde en su memoria. Sin resultado: "pendiente".
    registroEstado: define({
      description: "Entrega al bot el resultado del webview de registro y la sesión de Crediviva, y lo borra",
      input: z.object({
        userId: z.string().min(1).describe("Id del usuario en Jelou ($user.id)"),
        phone: z.string().max(32).optional(),
      }),
      config: bot,
      handler: async (input, ctx) => {
        const d = datum(ctx, SESIONES);
        const r = await d.ultimo(input.userId, "");
        if (!r || typeof r.id !== "string") return { estado: "pendiente" };
        if (Date.parse(String(r.expira ?? "")) < Date.now()) return { estado: "pendiente" };
        // La llave de Datum no puede borrar: se consume dejándolo sin clave y vencido.
        await d.actualizar(r.id, { clave: "", expira: new Date(Date.now() - 1000).toISOString() });

        const estado = String(r.estado ?? "");
        let authKey = "";
        if (r.clave) {
          try {
            authKey = await descifrar(ctx, String(r.clave), input.userId);
          } catch (e) {
            ctx.log(`registroEstado: no se pudo descifrar la sesión (${errorSeguro(e)})`);
            return { estado: "error" };
          }
        }
        // Sin sesión no se puede seguir con KYC ni evaluación: el bot lo trata como no terminado.
        if ((estado === "cuenta_creada" || estado === "sesion_iniciada") && !authKey) return { estado: "pendiente" };
        return {
          estado,
          paso: String(r.paso ?? ""),
          decision: String(r.decision ?? ""),
          origen: String(r.origen ?? ""),
          ambiente: String(r.ambiente ?? ""),
          mensaje: String(r.mensaje ?? ""),
          monto: Number(r.monto) || 0,
          ...(authKey ? { authKey } : {}),
        };
      },
    }),

    // ---- Validación del teléfono del onboarding (APIs de registro, distintas a las de atención al cliente).
    // El authKey vuelve de la página cifrado y ligado al usuario de la sesión.

    // Envía el primer código (Crediviva lo manda al validar el número).
    registroTelefono: define({
      description: "Valida el celular del cliente en Crediviva y le envía el código",
      input: z.object({ ak: z.string().min(20).max(4096), telefono: telefonoSchema, resultado: z.enum(["cuenta_creada", "sesion_iniciada"]) }),
      config: sesion,
      handler: async (input, ctx) => {
        const r = await pasoTelefono(ctx, input.ak, "/register/validate-phone-client", { phoneNumber: telefonoApi(input.telefono) });
        if (r.ok) return { estado: "enviado" };
        const e = estadoTelefono(r);
        // Ya validado en Crediviva: no hay código que pedir, se reanuda el chat.
        if (e.estado === "hecho") return { estado: input.resultado, reanudado: await terminarTelefono(ctx, input.ak, input.resultado) };
        return e;
      },
    }),

    registroTelefonoReenviar: define({
      description: "Reenvía el código al celular por SMS, WhatsApp o llamada",
      input: z.object({ ak: z.string().min(20).max(4096), telefono: telefonoSchema, metodo: metodoSchema }),
      config: sesion,
      handler: async (input, ctx) => {
        const r = await pasoTelefono(ctx, input.ak, "/register/send-phone-otp", { method: input.metodo, phoneNumber: telefonoApi(input.telefono) });
        if (r.ok) return { estado: "enviado" };
        return estadoTelefono(r);
      },
    }),

    // Verificado (o ya hecho en Crediviva): se reanuda el chat con el resultado del registro o del login.
    registroTelefonoVerificar: define({
      description: "Verifica el código del celular y continúa el onboarding",
      input: z.object({
        ak: z.string().min(20).max(4096), telefono: telefonoSchema, metodo: metodoSchema,
        codigo: z.string().regex(/^\d{4,6}$/), resultado: z.enum(["cuenta_creada", "sesion_iniciada"]),
      }),
      config: sesion,
      handler: async (input, ctx) => {
        const r = await pasoTelefono(ctx, input.ak, "/register/verify-phone-otp", {
          phoneNumber: telefonoApi(input.telefono), code: input.codigo, method: input.metodo,
        });
        if (!r.ok && r.status !== 409) {
          if (r.status === 400) return { estado: "incorrecto" };
          return estadoTelefono(r);
        }
        return { estado: input.resultado, reanudado: await terminarTelefono(ctx, input.ak, input.resultado) };
      },
    }),

    // Salidas sin sesión (debe ir a la App, canceló): se registran para que el bot sepa a dónde llevarlo.
    registroCerrar: define({
      description: "Cierra el webview de registro sin crear la cuenta ni iniciar sesión",
      input: z.object({ estado: z.enum(["app", "cancelado"]), email: email.optional() }),
      config: sesion,
      handler: async (input, ctx) => {
        const { userId, telefono, ambiente } = datosSesion(ctx);
        await registrarResultado(ctx, { userId, telefono, ambiente, correo: input.email ?? "", estado: input.estado });
        const reanudado = await completarSesion(ctx, { estado: input.estado });
        return { estado: input.estado, reanudado };
      },
    }),

    // ---- Flujo 5: verificación de identidad (KYC). El proveedor (Jumio o Veriff) lo define Crediviva;
    // su página es externa, así que el resultado se consulta cuando el cliente avisa que terminó.

    kycIniciar: define({
      description: "Inicia la verificación de identidad en Crediviva y devuelve el enlace del proveedor (Jumio o Veriff)",
      input: z.object({
        authKey: authKeySchema,
        ambiente: z.enum(AMBIENTES),
        proveedor: z.enum(["", "JUMIO", "VERIFF"]).default(""),
        reintento: z.coerce.boolean().default(false),
      }),
      config: bot,
      handler: async (input, ctx) => {
        const ruta = input.proveedor === "JUMIO" ? "/register/start-kyc-jumio"
          : input.proveedor === "VERIFF" ? "/register/start-kyc-veriff" : "/register/start-kyc";
        const r = await crediviva(ctx, input.ambiente, ruta, {
          method: "POST",
          headers: { "x-auth-key": input.authKey },
          body: JSON.stringify(input.proveedor ? { retry: input.reintento } : {}),
        });
        const d = (r.data.data ?? {}) as Record<string, unknown>;
        if (r.ok && typeof d.url === "string" && d.url) {
          const provider = typeof d.provider === "string" ? d.provider : (input.proveedor || "");
          return { estado: "enlace", url: d.url, proveedor: provider };
        }
        return { ...estadoKyc(r) };
      },
    }),

    kycResultado: define({
      description: "Consulta en Crediviva el resultado de la verificación de identidad que el cliente completó",
      input: z.object({
        authKey: authKeySchema,
        ambiente: z.enum(AMBIENTES),
        proveedor: z.enum(["JUMIO", "VERIFF"]),
      }),
      config: { ...bot, timeout: 28_000 },
      handler: async (input, ctx) => {
        const ruta = input.proveedor === "JUMIO" ? "/register/save-jumio-verification" : "/register/save-veriff-verification";
        // El proveedor tarda unos segundos en entregar el resultado: 503 = "vuelve a llamar".
        let r = await crediviva(ctx, input.ambiente, ruta, { method: "POST", headers: { "x-auth-key": input.authKey } });
        for (let i = 0; i < 2 && r.status === 503; i++) {
          await new Promise((ok) => setTimeout(ok, 4_000));
          r = await crediviva(ctx, input.ambiente, ruta, { method: "POST", headers: { "x-auth-key": input.authKey } });
        }
        if (r.ok) return { estado: "aprobado" };
        return { ...estadoKyc(r) };
      },
    }),

    // ---- Flujo 6: evaluación crediticia por ingreso mensual.
    ingresoRegistrar: define({
      description: "Registra el ingreso mensual del cliente en Crediviva y devuelve el resultado de la evaluación",
      input: z.object({
        authKey: authKeySchema,
        ambiente: z.enum(AMBIENTES),
        monto: z.coerce.number().positive().max(1_000_000),
      }),
      config: bot,
      handler: async (input, ctx) => {
        if (input.monto < INGRESO_MINIMO) return { estado: "monto_minimo", minimo: INGRESO_MINIMO };
        const r = await crediviva(ctx, input.ambiente, "/register/enter-monthly-income", {
          method: "POST",
          headers: { "x-auth-key": input.authKey },
          body: JSON.stringify({ amount: Math.round(input.monto * 100) / 100 }),
        });
        const d = (r.data.data ?? {}) as Record<string, unknown>;
        if (r.ok && ["approved", "manualAnalysis", "rejected"].includes(String(d.status))) {
          return { estado: String(d.status), message: typeof d.message === "string" ? d.message : "" };
        }
        if (r.status === 401) return { estado: "sin_sesion" };
        if (r.status === 409) return { estado: "completado" };
        if (r.status === 400) return { estado: "invalido", message: mensajeApi(r.data) };
        return { estado: "error", status: r.status };
      },
    }),

    // ---- Solicitud de crédito (después del ingreso aprobado): un webview con todos los datos.

    // Lo llama el bot. El authKey viaja cifrado en el enlace: la página nunca lo ve en claro.
    solicitudIniciar: define({
      description: "Crea el enlace del webview de solicitud de crédito (monto, comercios, dirección, datos laborales, referencias y PEP)",
      input: z.object({
        userId: z.string().min(1).describe("Id del usuario en Jelou ($user.id)"),
        botId: z.string().optional().describe("Id del bot ($bot.id)"),
        authKey: authKeySchema,
        ambiente: z.enum(AMBIENTES),
        paso: z.string().max(120).optional().describe("Paso pendiente que devolvió el login de Crediviva"),
      }),
      config: bot,
      handler: async (input, ctx) => {
        const wa = (env(ctx, "CREDIVIVA_WHATSAPP_NUMBER") ?? "").replace(/\D/g, "");
        const url = await mintLink(ctx, input.userId, input.botId, {
          tipo: "solicitud",
          userId: input.userId,
          ambiente: input.ambiente,
          ak: await cifrar(ctx, input.authKey, input.userId),
          paso: pasoSolicitud(input.paso),
          ...(wa ? { wa } : {}),
        });
        return { estado: "pendiente", url, ttlSeconds: LINK_TTL_S };
      },
    }),

    solicitudOpciones: define({
      description: "Catálogos de Crediviva para el formulario de solicitud",
      input: z.object({}),
      config: sesion,
      handler: async (_input, ctx) => {
        const { ambiente, authKey } = await datosSolicitud(ctx);
        // "pep" (antes "pep-time" en la OpenAPI 0.8.2): tiempos en el cargo de la persona PEP.
        const nombres = ["merchants", "provinces", "studies", "employment-situations", "industries", "seniority", "relationships", "occupations", "pep"];
        const r = await Promise.all(nombres.map((n) => crediviva(ctx, ambiente, `/options/${n}`, { headers: { "x-auth-key": authKey } })));
        if (r.some((x) => !x.ok)) return { estado: "error" };
        const v = (i: number) => (r[i].data.data ?? r[i].data) as unknown;
        const lista = (i: number) => (Array.isArray(v(i)) ? v(i) : []);
        const rel = (v(6) ?? {}) as Record<string, unknown>;
        return {
          estado: "ok",
          comercios: lista(0), provincias: lista(1), estudios: lista(2), situaciones: lista(3), industrias: lista(4),
          antiguedades: lista(5), parentescos1: Array.isArray(rel.listOne) ? rel.listOne : [], parentescos2: Array.isArray(rel.listTwo) ? rel.listTwo : [],
          ocupaciones: lista(7), pep: (v(8) && typeof v(8) === "object" && !Array.isArray(v(8)) ? v(8) : {}),
        };
      },
    }),

    solicitudMonto: define({
      description: "Monto de crédito solicitado",
      input: z.object({ amount: z.coerce.number().positive().max(1_000_000) }),
      config: sesion,
      handler: (input, ctx) => pasoJson(ctx, "/credit-application/enter-credit-requested", { amount: Math.round(input.amount * 100) / 100 }),
    }),

    solicitudComercios: define({
      description: "Comercios favoritos del catálogo",
      input: z.object({ favoriteCommerces: z.array(z.string().min(1).max(120)).min(1).max(50) }),
      config: sesion,
      handler: (input, ctx) => pasoJson(ctx, "/credit-application/select-merchants-favorite", input),
    }),

    solicitudDireccion: define({
      description: "Dirección de residencia",
      input: z.object({
        province: z.string().min(1).max(120), district: z.string().min(1).max(120), corregimiento: z.string().min(1).max(120),
        addressHome: z.string().trim().min(1).max(200), addressStreet: z.string().trim().min(1).max(200), addressHouse: z.string().trim().min(1).max(60),
      }),
      config: sesion,
      handler: (input, ctx) => pasoJson(ctx, "/credit-application/enter-direction", input),
    }),

    solicitudEstudio: define({
      description: "Nivel de estudio",
      input: z.object({ levelStudy: z.string().min(1).max(120) }),
      config: sesion,
      handler: (input, ctx) => pasoJson(ctx, "/credit-application/enter-study-level", input),
    }),

    solicitudSituacion: define({
      description: "Situación laboral (define el formulario laboral)",
      input: z.object({ currentWork: z.string().min(1).max(120) }),
      config: sesion,
      handler: (input, ctx) => pasoJson(ctx, "/credit-application/enter-situation-job", input),
    }),

    // El documento llega en base64 y se reenvía a Crediviva como multipart.
    solicitudLaboral: define({
      description: "Formulario laboral según la situación, con el documento de trabajo",
      input: z.object({
        formulario: z.enum(["gobierno", "privada", "independiente", "jubilado"]),
        occupation: z.string().max(200).optional(),
        economicActivity: z.string().max(200).optional(),
        seniority: z.string().max(120).optional(),
        archivo: archivoSchema,
      }),
      config: sesion,
      handler: async (input, ctx) => {
        const bytes = desdeB64(input.archivo.base64);
        if (bytes.length > 5 * 1024 * 1024) return { estado: "invalido", message: "El documento supera los 5 MB." };
        const form = new FormData();
        if (input.formulario === "gobierno") {
          if (!input.occupation) return { estado: "invalido", message: "Elige tu ocupación." };
          form.set("occupation", input.occupation);
        }
        if (input.formulario === "privada") {
          if (!input.economicActivity || !input.seniority) return { estado: "invalido", message: "Completa la actividad económica y la antigüedad." };
          form.set("economicActivity", input.economicActivity);
          form.set("seniority", input.seniority);
        }
        form.set("file", new Blob([bytes], { type: input.archivo.tipo }), input.archivo.nombre);
        const ruta = { gobierno: "form-government-structure", privada: "form-private-company", independiente: "form-independent", jubilado: "form-retired-or-pensioned" }[input.formulario];
        return pasoCrediviva(ctx, `/credit-application/${ruta}`, form);
      },
    }),

    solicitudReferencias: define({
      description: "Dos referencias personales",
      input: z.object({
        nameRef1: z.string().trim().min(2).max(120), numberRef1: z.string().regex(/^\+\d{8,15}$/), references1: z.string().min(1).max(60),
        nameRef2: z.string().trim().min(2).max(120), numberRef2: z.string().regex(/^\+\d{8,15}$/), references2: z.string().min(1).max(60),
      }),
      config: sesion,
      handler: (input, ctx) => pasoJson(ctx, "/credit-application/enter-references", input),
    }),

    // Último paso: Crediviva devuelve la decisión del crédito. Se deja para el bot y se reanuda el chat.
    // OpenAPI 0.9.0: multipart, isPEP como texto. Si es PEP van los campos del formulario PEP y sus
    // documentos (patrimonio y, si aplica, otros ingresos); Crediviva valida obligatorios y catálogos.
    solicitudPep: define({
      description: "Información PEP; devuelve la decisión final del crédito",
      input: z.object({
        isPEP: z.boolean(),
        campos: z.record(z.string(), z.string().trim().max(1000)).default({}),
        archivos: z.record(z.string(), archivoSchema).default({}),
      }),
      config: sesion,
      handler: async (input, ctx) => {
        const form = new FormData();
        form.set("isPEP", input.isPEP ? "true" : "false");
        if (input.isPEP) {
          for (const [k, v] of Object.entries(input.campos)) if (PEP_CAMPOS.has(k) && v) form.set(k, v);
          form.set("dataUpdatedAt", new Date().toISOString().slice(0, 10));
          for (const [k, a] of Object.entries(input.archivos)) {
            if (!PEP_ARCHIVOS.has(k)) continue;
            const bytes = desdeB64(a.base64);
            if (bytes.length > 5 * 1024 * 1024) return { estado: "invalido", message: "Cada documento debe pesar máximo 5 MB." };
            form.set(k, new Blob([bytes], { type: a.tipo }), a.nombre);
          }
        }
        const { userId, ambiente, authKey } = await datosSolicitud(ctx);
        const r = await crediviva(ctx, ambiente, "/credit-application/form-pep", {
          method: "POST",
          headers: { "x-auth-key": authKey },
          body: form,
        });
        if (r.status === 401) return { estado: "sin_sesion" };
        if (r.status === 400) return { estado: "invalido", message: mensajeApi(r.data) || "Revisa los datos e intenta de nuevo." };
        if (!r.ok && r.status !== 409) return { estado: "error" };
        const dec = (((r.data.data ?? {}) as Record<string, unknown>).decision ?? {}) as Record<string, unknown>;
        const decision = r.ok ? String(dec.status ?? "") : "";
        await dejarParaBot(ctx, {
          userId, ambiente, estado: "completado", origen: "solicitud", decision,
          mensaje: typeof dec.message === "string" ? dec.message : "", monto: Number(dec.amount) || 0,
        });
        const reanudado = await completarSesion(ctx, { estado: "completado", decision });
        return { estado: "completado", decision, reanudado };
      },
    }),

    solicitudCerrar: define({
      description: "Cierra el webview de solicitud sin terminarla",
      input: z.object({ estado: z.enum(["cancelado", "sin_sesion"]) }),
      config: sesion,
      handler: async (input, ctx) => {
        const { userId, ambiente } = await datosSolicitud(ctx);
        await dejarParaBot(ctx, { userId, ambiente, estado: input.estado, origen: "solicitud" });
        const reanudado = await completarSesion(ctx, { estado: input.estado });
        return { estado: input.estado, reanudado };
      },
    }),
  },
});

// ---------------------------------------------------------------- Solicitud de crédito: auxiliares
// Pasos en el orden de Crediviva; el login devuelve el pendiente como "credit-application/<endpoint>".
const PASOS_SOLICITUD = ["enter-credit-requested", "select-merchants-favorite", "enter-direction", "enter-study-level",
  "enter-situation-job", "form", "enter-references", "form-pep"];

function pasoSolicitud(paso?: string): string {
  const p = String(paso ?? "").toLowerCase();
  if (p.includes("form-pep")) return "form-pep";
  if (/form-(government|private|independent|retired)/.test(p)) return "form";
  return PASOS_SOLICITUD.find((x) => p.endsWith(x)) ?? "";
}

async function datosSolicitud(ctx: Ctx) {
  const s = (ctx.session?.data ?? {}) as Record<string, unknown>;
  const { userId, ambiente } = datosSesion(ctx);
  const authKey = await descifrar(ctx, String(s.ak ?? ""), userId);
  return { userId, ambiente, authKey };
}

// Un paso de la solicitud: "ok" avanza, "hecho" (409) también avanza, el resto lo muestra la página.
async function pasoCrediviva(ctx: Ctx, ruta: string, body: string | FormData) {
  const { ambiente, authKey } = await datosSolicitud(ctx);
  const r = await crediviva(ctx, ambiente, ruta, { method: "POST", headers: { "x-auth-key": authKey }, body });
  if (r.ok) return { estado: "ok" };
  if (r.status === 409) return { estado: "hecho" };
  if (r.status === 401) return { estado: "sin_sesion" };
  if (r.status === 400) return { estado: "invalido", message: mensajeApi(r.data) || "Revisa los datos e intenta de nuevo." };
  return { estado: "error" };
}

function pasoJson(ctx: Ctx, ruta: string, cuerpo: unknown) {
  return pasoCrediviva(ctx, ruta, JSON.stringify(cuerpo));
}

// ---------------------------------------------------------------- Teléfono del onboarding: auxiliares

// La API de onboarding pide el celular pegado, con +507 y 8 dígitos (ej. +50765550106). La de
// atención al cliente usa solo los 8 dígitos: son servicios distintos.
function telefonoApi(v: string): string {
  const d = v.replace(/\D/g, "");
  return "+507" + (d.length === 11 && d.startsWith("507") ? d.slice(3) : d);
}

// Solo se sugiere el número de WhatsApp si es de Panamá (Crediviva no acepta otros países).
function telefonoLocal(telefono: string): string {
  return telefono.startsWith("507") && telefono.length === 11 ? telefono.slice(3) : "";
}

// Celular validado: la sesión que se dejó al crear la cuenta o iniciar sesión vence a los 15 min y
// este paso puede tardar más (pasó: 22 min). Se deja de nuevo, recién vencible, antes de volver al chat.
async function terminarTelefono(ctx: Ctx, ak: string, resultado: "cuenta_creada" | "sesion_iniciada") {
  const { userId, ambiente } = datosSesion(ctx);
  const authKey = await descifrar(ctx, ak, userId);
  await dejarParaBot(ctx, { userId, ambiente, estado: resultado, authKey, origen: resultado === "cuenta_creada" ? "registro" : "login" });
  return completarSesion(ctx, { estado: resultado });
}

async function pasoTelefono(ctx: Ctx, ak: string, ruta: string, cuerpo: Record<string, unknown>) {
  const { userId, ambiente } = datosSesion(ctx);
  const authKey = await descifrar(ctx, ak, userId);
  return crediviva(ctx, ambiente, ruta, { method: "POST", headers: { "x-auth-key": authKey }, body: JSON.stringify(cuerpo) });
}

function estadoTelefono(r: { status: number; data: Record<string, unknown> }) {
  const msg = mensajeApi(r.data);
  if (r.status === 409) return /registrad/i.test(msg) ? { estado: "registrado" } : { estado: "hecho" };
  if (r.status === 400) return { estado: "invalido" };
  if (r.status === 429) return { estado: "espera", segundos: segundosEspera(r.data) };
  if (r.status === 401) return { estado: "sin_sesion" };
  return { estado: "error" };
}
