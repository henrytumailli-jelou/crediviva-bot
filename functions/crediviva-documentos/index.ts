import { app, define, z } from "@jelou/functions";

// Solución temporal: el almacenamiento de Crediviva (S3) sirve los PDF como
// application/octet-stream y WhatsApp los muestra como "BIN". Esta función entrega el mismo
// archivo con content-type application/pdf.
//
// - `enlace` (protegida, la llama la tool "Crediviva Enviar Documento"): recibe el enlace
//   firmado de Crediviva y devuelve un enlace propio cuyo token va cifrado (AES-GCM).
// - `pdf` (pública, la consume WhatsApp): abre el token, verifica que el archivo sea del
//   almacenamiento de Crediviva y lo entrega como PDF. No es un proxy abierto: solo acepta
//   tokens emitidos por `enlace` y solo hosts de Crediviva.
//
// Se puede eliminar cuando Crediviva guarde los PDF con ContentType application/pdf.

const VIGENCIA_MS = 45 * 60 * 1000; // el enlace de Crediviva vence en ~30 min
const API_PUBLICA_DEFAULT = "https://crediviva-documentos-c0d1ad.fn.jelou.ai";
// cvv-client-documents-staging.s3.amazonaws.com, cvv-client-documents.s3.us-east-1.amazonaws.com, …
const HOST_PERMITIDO = /^cvv-client-documents(-[a-z0-9]+)?\.s3([.-][a-z0-9-]+)?\.amazonaws\.com$/;

// deno-lint-ignore no-explicit-any
type Ctx = any;
type Sello = { u: string; f: string; exp: number };

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function deB64url(t: string): Uint8Array {
  const pad = t.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((t.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

let llaveCache: { secreto: string; llave: CryptoKey } | null = null;
async function llave(ctx: Ctx): Promise<CryptoKey> {
  const secreto = ctx.env.get("DOCS_LINK_KEY");
  if (!secreto || secreto.length < 32) throw new Error("DOCS_LINK_KEY no está configurado");
  if (llaveCache?.secreto === secreto) return llaveCache.llave;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secreto));
  const k = await crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
  llaveCache = { secreto, llave: k };
  return k;
}

async function sellar(ctx: Ctx, sello: Sello): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = new TextEncoder().encode(JSON.stringify(sello));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await llave(ctx), datos));
  const out = new Uint8Array(iv.length + cifrado.length);
  out.set(iv);
  out.set(cifrado, iv.length);
  return b64url(out);
}

async function abrir(ctx: Ctx, token: string): Promise<Sello | null> {
  try {
    const bytes = deB64url(token);
    const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await llave(ctx), bytes.slice(12));
    const s = JSON.parse(new TextDecoder().decode(plano)) as Sello;
    return s.exp > Date.now() ? s : null;
  } catch (e) {
    if (String(e).includes("DOCS_LINK_KEY")) throw e;
    return null;
  }
}

function hostPermitido(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOST_PERMITIDO.test(u.host);
  } catch {
    return false;
  }
}

function nombreSeguro(nombre: string): string {
  let n = nombre.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Documento - Crediviva.pdf";
  if (!/\.pdf$/i.test(n)) n += ".pdf";
  return n;
}

export default app({
  config: { timeout: 25_000 },
  tools: {
    enlace: define({
      description: "Convierte el enlace firmado de un PDF de Crediviva en un enlace que lo entrega como application/pdf",
      input: z.object({
        url: z.string().url().describe("downloadUrl devuelto por Crediviva"),
        filename: z.string().max(120).default("Documento - Crediviva.pdf"),
      }),
      config: { methods: ["POST"], mcp: false, context: false },
      handler: async (input, ctx) => {
        if (!hostPermitido(input.url)) {
          return { ok: false, reason: "host_no_permitido", url: input.url };
        }
        const filename = nombreSeguro(input.filename);
        const token = await sellar(ctx, { u: input.url, f: filename, exp: Date.now() + VIGENCIA_MS });
        const base = (ctx.env.get("DOCS_API_PUBLICA") ?? API_PUBLICA_DEFAULT).replace(/\/+$/, "");
        return { ok: true, url: `${base}/pdf/${token}`, filename };
      },
    }),

    pdf: define({
      description: "Entrega un PDF de Crediviva con content-type application/pdf (enlace emitido por 'enlace')",
      input: z.object({}).passthrough(),
      config: { path: "/pdf/:token", methods: ["GET", "HEAD"], public: true, mcp: false, context: false },
      handler: async (_input, ctx, request) => {
        const sello = await abrir(ctx, String(ctx.params.token ?? ""));
        if (!sello || !hostPermitido(sello.u)) {
          return new Response("Enlace no válido o vencido", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        const origen = await fetch(sello.u, { signal: AbortSignal.timeout(20_000) });
        if (!origen.ok || !origen.body) {
          ctx.log(`pdf origen -> ${origen.status}`);
          return new Response("Documento no disponible", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        const headers = new Headers({
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${sello.f.replace(/[^\x20-\x7E]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(sello.f)}`,
          "cache-control": "private, max-age=600",
        });
        const largo = origen.headers.get("content-length");
        if (largo) headers.set("content-length", largo);
        if (request.method === "HEAD") return new Response(null, { status: 200, headers });
        return new Response(origen.body, { status: 200, headers });
      },
    }),
  },
});
