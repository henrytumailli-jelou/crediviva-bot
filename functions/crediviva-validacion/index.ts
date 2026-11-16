import { app, define, z } from "@jelou/functions";

// Backend del webview de validación de identidad (Atención al cliente).
//
// - `iniciar` y `resultado` los llama el bot (tools publicadas) con la API key de invocación.
// - `autenticar`, `otpSolicitar` y `otpVerificar` son públicos: los llama la página del webview.
//
// El estado de la validación (teléfono, ambiente, intentos, sessionToken) viaja como un sello
// cifrado con AES-GCM (`n`) que solo esta función puede abrir. El navegador lo guarda y lo
// reenvía, pero no puede leerlo ni alterarlo; cada respuesta devuelve un sello nuevo.

const AMBIENTES = ["staging", "production"] as const;
type Ambiente = (typeof AMBIENTES)[number];

const MAX_INTENTOS = 3; // por vía (datos personales / código OTP)
const ESTADO_TTL_MS = 40 * 60 * 1000; // vida del sello (mayor que la del enlace)
const OTP_COOLDOWN_MS = 60 * 1000; // la API exige 60 s entre reenvíos
const SESION_TTL_S = 25 * 60; // sessionToken dura ~30 min; dejamos margen
const LINK_TTL_S = 30 * 60; // vigencia del enlace del webview
const SITE_SLUG_DEFAULT = "crediviva-validacion";
const API_PUBLICA_DEFAULT = "https://crediviva-validacion-2838e0.fn.jelou.ai";

type Estado = {
  phone: string;
  countryCode: string;
  authType: 1 | 2;
  ambiente: Ambiente;
  userId: string;
  intentosDatos: number;
  intentosOtp: number;
  cedula?: string;
  otpEnviadoEn?: number;
  sessionToken?: string;
  bloqueado?: boolean;
  creadoEn: number;
};

// deno-lint-ignore no-explicit-any
type Ctx = any;

function env(ctx: Ctx, name: string): string | undefined {
  return ctx.env.get(name) ?? ctx.env.get(`COMPANY_${name}`);
}

function credenciales(ctx: Ctx, ambiente: Ambiente) {
  const sufijo = ambiente.toUpperCase();
  const baseUrl = env(ctx, `CREDIVIVA_BASE_URL_${sufijo}`);
  const apiKey = env(ctx, `CREDIVIVA_API_KEY_${sufijo}`);
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
    throw new Error(`CREDIVIVA_BASE_URL_${sufijo} no está configurado`);
  }
  if (!apiKey) throw new Error(`CREDIVIVA_API_KEY_${sufijo} no está configurado`);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

// ---------------------------------------------------------------- Sello cifrado del estado
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function deB64url(t: string): Uint8Array {
  const pad = t.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((t.length + 3) % 4);
  const s = atob(pad);
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

let llaveCache: { secreto: string; llave: CryptoKey } | null = null;
async function llave(ctx: Ctx): Promise<CryptoKey> {
  const secreto = env(ctx, "CREDIVIVA_STATE_KEY");
  if (!secreto || secreto.length < 32) throw new Error("CREDIVIVA_STATE_KEY no está configurado");
  if (llaveCache?.secreto === secreto) return llaveCache.llave;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secreto));
  const k = await crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
  llaveCache = { secreto, llave: k };
  return k;
}

async function sellar(ctx: Ctx, estado: Estado): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = new TextEncoder().encode(JSON.stringify(estado));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await llave(ctx), datos));
  const out = new Uint8Array(iv.length + cifrado.length);
  out.set(iv);
  out.set(cifrado, iv.length);
  return b64url(out);
}

async function abrir(ctx: Ctx, sello: string): Promise<Estado | null> {
  try {
    const bytes = deB64url(sello);
    const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await llave(ctx), bytes.slice(12));
    const estado = JSON.parse(new TextDecoder().decode(plano)) as Estado;
    if (!estado.creadoEn || Date.now() - estado.creadoEn > ESTADO_TTL_MS) return null;
    return estado;
  } catch (e) {
    if (String(e).includes("CREDIVIVA_STATE_KEY")) throw e;
    return null;
  }
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
  headers.set("X-API-Key", apiKey);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`${baseUrl}/v1/whatsapp-customer-api/customer-auth${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await leerJson(res);
  ctx.log(`crediviva ${init.method ?? "GET"} ${path.split("?")[0]} -> ${res.status}`);
  return { status: res.status, ok: res.ok, data };
}

// Crediviva espera la cédula con puntos y país: 8-123-1456 -> 8.123.1456.PA
function cedulaApi(cedula: string, countryCode: string): string {
  const c = cedula.trim().toUpperCase();
  if (/^[A-Z0-9]+(-[A-Z0-9]+){2}$/.test(c)) return `${c.replaceAll("-", ".")}.${countryCode}`;
  return c;
}

function mensajeApi(data: Record<string, unknown>): string {
  const m = data.message ?? (data.error as Record<string, unknown> | undefined)?.message;
  return typeof m === "string" ? m : "";
}

// Genera el enlace firmado del webview (POST /functions/webview/links, autenticado con X-Api-Key).
async function mintLink(
  ctx: Ctx,
  key: string,
  slug: string,
  userId: string,
  botId: string | undefined,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch("https://gateway.jelou.ai/functions/webview/links", {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ site: slug, user_id: userId, ...(botId ? { bot_id: botId } : {}), data, ttl: LINK_TTL_S }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await leerJson(res);
  const cuerpo = (j.data && typeof j.data === "object" ? j.data : j) as Record<string, unknown>;
  if (res.ok && typeof cuerpo.url === "string") return cuerpo;
  throw new Error(`No se pudo generar el enlace del webview: ${res.status} ${JSON.stringify(j).slice(0, 500)}`);
}

// ---------------------------------------------------------------- Respuestas a la página
const selloSchema = z.string().min(40).max(8000).describe("Estado sellado de la validación");

type Resultado = {
  status: "ok" | "invalid" | "blocked" | "expired" | "sent" | "cooldown" | "error";
  message: string;
  n?: string; // sello actualizado: la página debe usarlo en la siguiente llamada
  attemptsLeft?: number;
  retryInSeconds?: number;
};

const EXPIRADO: Resultado = { status: "expired", message: "Tu sesión de validación expiró. Vuelve a WhatsApp para iniciar de nuevo." };
const BLOQUEADO = "Superaste el número de intentos permitidos. Un asesor te ayudará por WhatsApp.";
const TECNICO = "Tuvimos un problema técnico. Intenta de nuevo en unos minutos.";

async function cargar(ctx: Ctx, sello: string): Promise<{ estado: Estado | null; corte: Resultado | null }> {
  const estado = await abrir(ctx, sello);
  if (!estado) return { estado: null, corte: EXPIRADO };
  if (estado.bloqueado) return { estado, corte: { status: "blocked", message: BLOQUEADO, n: sello } };
  if (estado.sessionToken) return { estado, corte: { status: "ok", message: "Tu identidad ya fue validada.", n: sello } };
  return { estado, corte: null };
}

const publico = { public: true, methods: ["POST"], mcp: false };

export default app({
  config: {
    timeout: 25_000,
    // Solo el sitio del webview puede llamar las rutas públicas desde el navegador.
    cors: {
      origin: ["https://crediviva-validacion-5bec80.fn.jelou.ai"],
      methods: ["POST", "OPTIONS"],
      headers: ["Content-Type"],
    },
  },
  tools: {
    // Lo llama el bot antes de abrir el webview: sella el contexto confiable y genera el enlace.
    iniciar: define({
      description: "Crea una sesión de validación de identidad y devuelve el enlace del webview",
      input: z.object({
        userId: z.string().min(1).describe("Id del usuario en Jelou ($user.id)"),
        botId: z.string().optional().describe("Id del bot ($bot.id)"),
        phone: z.string().regex(/^\d{7,15}$/).describe("Teléfono sin prefijo, ej. \"61234567\""),
        countryCode: z.string().length(2).default("PA"),
        authType: z.coerce.number().int().min(1).max(2).describe("1 = cédula + fecha; 2 = código al correo"),
        ambiente: z.enum(AMBIENTES),
      }),
      config: { methods: ["POST"], mcp: false },
      handler: async (input, ctx) => {
        credenciales(ctx, input.ambiente); // falla temprano si el ambiente no está configurado
        const n = await sellar(ctx, {
          phone: input.phone,
          countryCode: input.countryCode.toUpperCase(),
          authType: input.authType as 1 | 2,
          ambiente: input.ambiente,
          userId: input.userId,
          intentosDatos: 0,
          intentosOtp: 0,
          creadoEn: Date.now(),
        });

        const mintKey = env(ctx, "JELOU_FUNCTIONS_API_KEY");
        if (!mintKey) throw new Error("JELOU_FUNCTIONS_API_KEY no está configurado");
        const siteSlug = env(ctx, "CREDIVIVA_WEBVIEW_SITE") ?? SITE_SLUG_DEFAULT;
        const api = env(ctx, "CREDIVIVA_VALIDACION_API") ?? API_PUBLICA_DEFAULT;
        // Número de WhatsApp del bot (solo dígitos): la página vuelve al chat por wa.me al terminar.
        const wa = (env(ctx, "CREDIVIVA_WHATSAPP_NUMBER") ?? "").replace(/\D/g, "");
        const link = await mintLink(ctx, mintKey, siteSlug, input.userId, input.botId, {
          n,
          authType: input.authType,
          phoneMasked: "****" + input.phone.slice(-4),
          api,
          ...(wa ? { wa } : {}),
        });
        const url = link.url as string | undefined;
        if (!url) throw new Error("La respuesta del enlace del webview no trae url");
        return { ok: true, status: "created", url, ttlSeconds: LINK_TTL_S };
      },
    }),

    // Vía 1: cédula + fecha de nacimiento (teléfono registrado).
    autenticar: define({
      description: "Valida cédula y fecha de nacimiento del cliente",
      input: z.object({
        n: selloSchema,
        cedula: z.string().trim().min(3).max(20),
        birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
      }),
      config: publico,
      handler: async (input, ctx): Promise<Resultado> => {
        const { estado, corte } = await cargar(ctx, input.n);
        if (corte || !estado) return corte!;
        if (estado.intentosDatos >= MAX_INTENTOS) {
          return { status: "invalid", message: "Ya no puedes intentar con estos datos. Valida con un código a tu correo.", attemptsLeft: 0, n: input.n };
        }

        const cedula = cedulaApi(input.cedula, estado.countryCode);
        const q = new URLSearchParams({
          countryCode: estado.countryCode,
          phone: estado.phone,
          cedula,
          birthdate: input.birthdate,
        });
        const r = await crediviva(ctx, estado.ambiente, `/authenticate?${q}`);
        ctx.log(`autenticar: http ${r.status} authenticated=${r.data.authenticated === true}`);
        const token = r.data.sessionToken;
        if (r.ok && r.data.authenticated === true && typeof token === "string" && token) {
          estado.sessionToken = token;
          estado.cedula = cedula;
          return { status: "ok", message: "¡Identidad validada!", n: await sellar(ctx, estado) };
        }
        if (r.status >= 500 || r.status === 0) return { status: "error", message: TECNICO, n: input.n };

        estado.intentosDatos += 1;
        const restantes = MAX_INTENTOS - estado.intentosDatos;
        return {
          status: "invalid",
          message: restantes > 0 ? "Los datos no coinciden con nuestros registros." : "Los datos no coinciden. Puedes validar con un código enviado a tu correo.",
          attemptsLeft: restantes,
          n: await sellar(ctx, estado),
        };
      },
    }),

    // Vía 2: envío (o reenvío) del código al correo registrado.
    otpSolicitar: define({
      description: "Envía o reenvía el código OTP al correo registrado del cliente",
      input: z.object({
        n: selloSchema,
        cedula: z.string().trim().min(3).max(20).optional(),
        reenviar: z.boolean().default(false),
      }),
      config: publico,
      handler: async (input, ctx): Promise<Resultado> => {
        const { estado, corte } = await cargar(ctx, input.n);
        if (corte || !estado) return corte!;

        const cedula = input.cedula ? cedulaApi(input.cedula, estado.countryCode) : estado.cedula;
        if (!cedula) return { status: "invalid", message: "Ingresa tu número de identidad.", n: input.n };

        const desde = estado.otpEnviadoEn ? Date.now() - estado.otpEnviadoEn : Infinity;
        if (desde < OTP_COOLDOWN_MS) {
          return { status: "cooldown", message: "Espera un momento antes de pedir otro código.", retryInSeconds: Math.ceil((OTP_COOLDOWN_MS - desde) / 1000), n: input.n };
        }

        const reenviar = input.reenviar && !!estado.otpEnviadoEn && cedula === estado.cedula;
        const r = await crediviva(ctx, estado.ambiente, reenviar ? "/otp/resend" : "/otp/request", {
          method: "POST",
          body: JSON.stringify({ cedula }),
        });
        if (r.ok) {
          estado.cedula = cedula;
          estado.otpEnviadoEn = Date.now();
          return {
            status: "sent",
            message: "Te enviamos un código de 4 dígitos a tu correo registrado.",
            retryInSeconds: OTP_COOLDOWN_MS / 1000,
            n: await sellar(ctx, estado),
          };
        }
        if (r.status === 429) return { status: "cooldown", message: "Espera un momento antes de pedir otro código.", retryInSeconds: 60, n: input.n };
        if (r.status >= 500) return { status: "error", message: TECNICO, n: input.n };
        return { status: "invalid", message: mensajeApi(r.data) || "No pudimos enviar el código. Revisa tu número de identidad.", n: input.n };
      },
    }),

    // Vía 2: verificación del código y obtención de la sesión con el tempToken.
    otpVerificar: define({
      description: "Verifica el código OTP y completa la autenticación del cliente",
      input: z.object({
        n: selloSchema,
        otp: z.string().regex(/^\d{4,6}$/),
      }),
      config: publico,
      handler: async (input, ctx): Promise<Resultado> => {
        const { estado, corte } = await cargar(ctx, input.n);
        if (corte || !estado) return corte!;
        if (!estado.cedula || !estado.otpEnviadoEn) return { status: "invalid", message: "Primero solicita el código.", n: input.n };

        const v = await crediviva(ctx, estado.ambiente, "/otp/verify", {
          method: "POST",
          body: JSON.stringify({ cedula: estado.cedula, otp: input.otp }),
        });
        const temp = v.data.tempToken;
        if (v.ok && v.data.otpValid === true && typeof temp === "string" && temp) {
          const a = await crediviva(ctx, estado.ambiente, `/authenticate?${new URLSearchParams({ tempToken: temp })}`);
          const token = a.data.sessionToken;
          if (a.ok && a.data.authenticated === true && typeof token === "string" && token) {
            estado.sessionToken = token;
            return { status: "ok", message: "¡Identidad validada!", n: await sellar(ctx, estado) };
          }
          return { status: "error", message: TECNICO, n: input.n };
        }
        if (v.status >= 500) return { status: "error", message: TECNICO, n: input.n };

        estado.intentosOtp += 1;
        const restantes = MAX_INTENTOS - estado.intentosOtp;
        if (restantes <= 0) {
          estado.bloqueado = true;
          return { status: "blocked", message: BLOQUEADO, attemptsLeft: 0, n: await sellar(ctx, estado) };
        }
        return { status: "invalid", message: "El código es incorrecto o expiró.", attemptsLeft: restantes, n: await sellar(ctx, estado) };
      },
    }),

    // Lo llama el bot al volver del webview con el sello que la página devolvió al completar.
    // Solo esta función puede abrirlo, así que un callback falsificado no autentica a nadie.
    resultado: define({
      description: "Abre el sello devuelto por el webview y entrega el resultado de la validación",
      input: z.object({ n: z.string().max(8000).default("") }),
      config: { methods: ["POST"], mcp: false },
      handler: async (input, ctx) => {
        const estado = input.n ? await abrir(ctx, input.n) : null;
        if (!estado) return { authenticated: false, reason: input.n ? "expired" : "incomplete" };
        if (estado.sessionToken) {
          return { authenticated: true, reason: "ok", sessionToken: estado.sessionToken, expiresInSeconds: SESION_TTL_S };
        }
        if (estado.bloqueado) return { authenticated: false, reason: "blocked" };
        return { authenticated: false, reason: "incomplete" };
      },
    }),
  },
});
