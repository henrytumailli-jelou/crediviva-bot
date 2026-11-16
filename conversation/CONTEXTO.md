# Crediviva Enterprise — contexto de traspaso

Documento para continuar el proyecto sin haber estado en las sesiones de trabajo. Resume qué hay
construido, por qué se decidió así, qué está pendiente y cómo diagnosticar problemas. Las personas se
nombran por iniciales.

Última actualización: 2026-11-16.

---

## 1. Qué es

Bot de WhatsApp de **Crediviva** (fintech panameña de "compra ahora, paga después") construido en Jelou
Brain. Cubre dos frentes:

- **Atención al cliente** (clientes existentes): autenticación y envío de documentos del crédito
  (estado de cuenta, carta de saldo, carta de cancelación, comprobante de último pago).
- **Onboarding** (clientes nuevos, SOW "Crediviva v2.1"): consentimientos → registro / inicio de sesión
  con correo → validación del celular → verificación de identidad (KYC) → ingreso mensual →
  solicitud de crédito → resultado.

| Dato | Valor |
|---|---|
| Company Jelou | 14842 (Crediviva Enterprise) |
| Proyecto (brain) | `01M5G1071BFYCBZ3GZM3R9A35A` |
| Organización | `01M5G106G6M3JC4N8PBHARAEGN` |
| Perfil del CLI | `dev-crediviva-enterprise` |
| Canal | WhatsApp sandbox (Gupshup), bot `cb5b7e75-b0c4-45a9-90f8-237919f429c9`, rama `master` |
| Ambiente de Crediviva | **staging** (lo define la tool "Configuración de Ambiente") |

Es una copia del bot original de la company 5527 (carpeta `Implementaciones/Crediviva/crediviva`).
Los cambios **no se propagan** entre ambas companies: ids y hosts son distintos.

---

## 2. Estructura del repo

```
jelou.yml            vínculo del directorio con el proyecto (brain + organización)
jelou.lock           hashes de workflows y tools (lo mantiene el CLI)
workflows/           un JSON por workflow (draft)
tools/               un JSON por tool (contrato + grafo)
functions/
  crediviva-onboarding/   función del onboarding (index.ts) + webviews (dist/)
  crediviva-validacion/   función de la autenticación de atención al cliente
  crediviva-documentos/   función de documentos de atención al cliente
sites/crediviva-validacion/  webview de la autenticación de atención al cliente
conversation/        este documento
```

No están en el repo (ver `.gitignore`): `.jelou/` (estado local del CLI), los `.env` de las funciones y
`.documents/` (SOW, OpenAPI y Postman de Crediviva: pedírselos a H. T. o a Crediviva).

Workflows locales que **no deben subirse** con `jelou push`: `crediviva.whatsapp.json` y
`verificacion-telefonica.whatsapp.json` (no están en el lockfile). Hacer push siempre con
`--workflow <id>`.

---

## 3. Workflows (skill id / workflow id)

| Workflow | skill | wf | Notas |
|---|---|---|---|
| **Inicio** (por defecto) | 54360 | 74693 | Menú con botones no bloqueantes: Mi primer crédito → Registro · Ya soy cliente → Menú de documentos · Soy comercio → Atención humana. El texto libre lo interpreta el AI router. |
| Registro de cliente | 53335 | 73469 | Gate de consentimiento → asistente IA que envía el webview de registro → "Recoger sesión" / "Guardar sesión" → Verificación. Contiene el **atajo de pruebas** (ver §8). |
| Consentimientos | 53334 | 73468 | Webview de tratamiento de datos, T&C y APC. Se guarda en Datum. |
| Verificación de identidad | 53530 | 73700 | IA pide consentimiento biométrico → el flujo inicia KYC, envía el enlace de Jumio y **consulta el resultado cada 2 min** (hasta 5 veces) con un nodo Pausa. |
| Evaluación crediticia | 53531 | 73701 | IA pide ingreso → si sale aprobado envía el **webview de solicitud de crédito** → recoge la decisión final. |
| Reinicio de prueba | 54526 | 74915 | Comando de QA *"reiniciar prueba"* (solo staging). |
| Menú de documentos | 53052 | 73057 | Atención al cliente. |
| Autenticación de cliente | 53043 | 73048 | Atención al cliente (webview del site `crediviva-validacion`). |
| Estado de cuenta / Carta de saldo / Carta de cancelación / Comprobante de último pago | 53051 / 53045 / 53044 / 53049 | 73056 / 73050 / 73049 / 73054 | Cada uno con asistente IA; salidas a otro documento, asesor, finalizar o `nuevo_credito` → Registro. |
| Atención humana | 53042 | 73047 | CONNECT a asesor (hoy casi nunca hay asesores conectados). |
| Despedida, Cierre por inactividad, Configuración de ambiente | 53046, 53048, 53050 | — | Internos, ocultos al router. |

## 4. Tools (id, versión publicada que usan los workflows)

| Tool | id | Uso |
|---|---|---|
| Crediviva Configuracion de Ambiente | 8992 | Ambiente (staging/production) y país. |
| Crediviva Iniciar Registro | 8993 (1.0.1) | Enlace del webview de registro. |
| Crediviva Estado Registro | 8994 (1.0.3) | Recoge (una sola vez) el resultado que dejaron los webviews en Datum, incluida la sesión de Crediviva y la decisión del crédito. |
| Crediviva Iniciar KYC / Resultado KYC | 8998 / 8999 (1.0.0) | `start-kyc*` / `save-*-verification`. |
| Crediviva Registrar Ingreso | 9000 (1.0.0) | `enter-monthly-income`. |
| Crediviva Iniciar Solicitud | 9072 (1.0.0) | Enlace del webview de solicitud de crédito. |
| Crediviva Reinicio de Prueba | 9104 (1.0.0) | Reinicio de consentimientos (staging). |
| Crediviva Login de Prueba | 9109 (1.0.0) | Atajo de pruebas (§8). |
| Validar/Reenviar/Verificar Código Correo | 8989–8991 | Respaldo, sin uso. |
| Tools de atención al cliente | 8932–8939 | Documentos y validación de teléfono de atención. |

## 5. Función `crediviva-onboarding`

URL `https://crediviva-onboarding.fn.jelou.ai`. Sirve **tres webviews** (`dist/`, se elige por
`data.tipo` del enlace) y las rutas que llaman el bot y las páginas.

- **Consentimientos** (`consentimientos.js`).
- **Registro** (`registro.js`): correo → (nuevo) código + contraseña → `create-client` · (existente)
  contraseña → `auth/login` · luego **celular** (`validate-phone-client` → `verify-phone-otp`, reenvío
  por SMS/WhatsApp/llamada) cuando la cuenta es nueva o el login dice que falta el teléfono.
- **Solicitud de crédito** (`solicitud.js`): monto → comercios → dirección (provincia/distrito/
  corregimiento) → estudios → situación laboral → formulario laboral con documento → referencias →
  PEP. El paso PEP devuelve la **decisión final** (APPROVED / REJECTED / PENDING).

Puntos importantes del código:

- **La sesión de Crediviva (`authKey`) nunca va en claro al navegador.** En los enlaces viaja cifrada
  (AES-GCM con llave derivada del secreto `REGISTRO_STATE_KEY`, ligada al userId).
- **Los webviews no pueden escribir la memoria del bot** (la plataforma no resuelve al usuario sin el
  bot). Por eso la función deja el resultado en Datum (`sesiones_pendientes`, cifrado, vence a los
  15 min) y el bot lo recoge con la tool Estado Registro, que lo consume.
- **Tiempos:** la función corta a los **60 s**; cada llamada a Crediviva espera **50 s** si viene de un
  webview y **20 s** si viene de una tool (las tools cortan a los 20–30 s). El log de cada llamada
  registra tamaño enviado y duración.
- **Celular:** la API de onboarding lo exige como `+507` + 8 dígitos pegados (ej. `+50766727688`). La API
  de atención usa solo los 8 dígitos: son servicios distintos.
- **PEP:** según la OpenAPI 0.9.0, `form-pep` es multipart con `isPEP` "true"/"false"; si es PEP van ~30
  campos y dos documentos. El formulario los arma desde una tabla en `solicitud.js` (con condicionales).
  El catálogo es `GET /api/options/pep` (antes `pep-time`).

Secretos de la función (no legibles por CLI; cargarlos en la consola de Jelou): `DATUM_APIKEY_CREDIVIVA`,
`CREDIVIVA_ONBOARDING_BASE_URL_STAGING`, `CREDIVIVA_API_KEY_STAGING`, `JELOU_FUNCTIONS_API_KEY`,
`CREDIVIVA_WHATSAPP_NUMBER` (hoy el número sandbox; cambiar al número real) y `REGISTRO_STATE_KEY`.
Las tools llaman a la función con `{{$secret.JELOU_FN_INVOKE_KEY}}`.

Deploy: `cd functions/crediviva-onboarding && jelou functions deploy --no-confirm`. No requiere publicar
el proyecto.

## 6. Datos en Datum (`crediviva-onboarding-v1ghey`)

- `consentimientos`: constancia legal de la autorización (no se borra ni se edita; el reinicio de pruebas
  agrega una fila nueva).
- `registros`: bitácora de registro / inicio de sesión (sin claves).
- `sesiones_pendientes`: puente webview → bot (clave cifrada, vence en 15 min, se consume al leerla).
  La llave de Datum de la función **no puede borrar** (DELETE → 403): por eso se consume con PATCH.

## 7. Memoria del bot (claves principales)

`cv_consentimiento`, `cv_sesionCrediviva` (authKey, 30 min), `cv_pasoCrediviva` (paso pendiente que
devuelve el login, para retomar), `cv_kycAprobado` (1 h), `cv_evaluacion` (decisión final),
`cv_solMensaje`. La lista completa está en el nodo "Vaciar memoria" de *Reinicio de prueba*: **si un
flujo agrega una clave nueva, agregarla ahí**.

Trampa vista en vivo: borrar y escribir **la misma clave en el mismo nodo CODE** deja la clave vacía
para el nodo siguiente. Escribir si hay valor, borrar solo si no.

## 8. Cosas de prueba que hay que quitar antes de producción

1. **Atajo de pruebas** en *Registro de cliente*: condición "¿Número de prueba?" (un número de H. T.,
   solo staging) → pregunta correo y contraseña en el chat → tool *Login de Prueba* → va directo al
   formulario de solicitud (`cv_pruebaSolicitud`, leída en *Evaluación* → "Revisar sesión").
   Quitar: la condición y sus nodos en Registro, la línea de `cv_pruebaSolicitud` en Evaluación y
   `NUMEROS_PRUEBA` / la ruta `pruebaLogin` en la función. La contraseña de prueba quedó escrita en el
   chat y en logs de ejecución: usar solo cuentas de staging.
2. **Reinicio de prueba** (*"reiniciar prueba"*): solo funciona en staging, puede quedarse.
3. Un nodo HTTP suelto en Registro de cliente (no se ejecuta; genera 3 avisos de validación).

## 9. Estado y pendientes (al 2026-11-16)

Funciona de punta a punta en staging (con la lentitud de Crediviva): menú, consentimientos, registro y
login, celular (corregido a `+507`), KYC con consulta automática, ingreso, y la solicitud de crédito
aceptó monto, comercios, dirección, estudios y situación laboral.

Pendiente:

- **Publicar** el último cambio de Evaluación (corrección de `cv_eval`) si no se publicó.
- **Documento laboral:** `form-independent` no respondió en 50 s con un PDF. Probar con una foto y
  revisar el log (tamaño y duración). Si persiste, reportar a Crediviva.
- **PEP completo:** sin probar en vivo. Dos condiciones se deducen por texto del catálogo
  ("familiar"/"asociado", "finalizado").
- **Situación laboral → formulario:** se deduce por nombre; confirmar con Crediviva la relación.
- **Valores del `step` del login:** confirmar con Crediviva para el "retomar donde se quedó".
- **Flujo 7 del SOW (token/enlace de la App para aprobados):** no hay API todavía.
- **Producción:** URL base y API key de producción, número real de WhatsApp
  (`CREDIVIVA_WHATSAPP_NUMBER`), quitar §8.
- **Pedidos a Crediviva** (correo del 13-nov a V. D.): fecha de fin de sus pruebas, confirmación de
  IPs en lista blanca, estabilidad de staging (timeouts en `validate-email-client`, `auth/login`,
  `start-kyc`, `save-jumio-verification`, `enter-monthly-income`, `validate-phone-client`,
  `form-independent`), cuenta de prueba en el paso `credit-application`.

Personas: H. T. (desarrollo, de vacaciones la semana del 16-nov) · P. A. (a cargo durante las
vacaciones) · V. D. (Product Manager, Crediviva) · E. (QA, Crediviva) · A. J. (cuenta, Jelou).

## 10. Cómo diagnosticar

```bash
# Estado del draft vs servidor (siempre antes de editar/push)
jelou status --check-remote
# Conversaciones del sandbox y línea de tiempo de un usuario
jelou logs conversations list --bot-id cb5b7e75-b0c4-45a9-90f8-237919f429c9 --from 1d
jelou logs chat --bot-id cb5b7e75-b0c4-45a9-90f8-237919f429c9 --user-id <telefono> --from 2h
# Nodos de una ejecución
jelou logs execution <executionId> --failed-only
# Llamadas de la función a Crediviva (código, detalle, tamaño y duración)
cd functions/crediviva-onboarding && jelou functions logs --history --since <ISO>
# Probar una tool contra el draft
jelou test tool crediviva-iniciar-registro --arg ambiente=staging --arg userId=qa
```

Reglas aprendidas:

- Hacer `jelou pull` antes de editar: **Studio y el servidor regeneran ids de nodos**. Después de cada
  push de un workflow con botones, volver a hacer pull y comprobar que `payload.targetId` de cada
  opción coincide con el destino de su arista.
- `jelou pull` acepta un solo `--workflow` por llamada; `jelou push` acepta varios.
- No usar `jelou workflow validate --fix` en Consentimientos ni en Registro (reescribe condiciones y
  quita la entrada del webview del asistente).
- Al editar código desde la terminal, cuidar las barras invertidas de las expresiones regulares
  (`\d`, `\D`): ya se perdieron una vez y rompieron la verificación del código del celular.
- Los timeouts sin código de error casi siempre son del staging de Crediviva, no del bot: el log de la
  función lo muestra con la duración.
