# Crediviva Enterprise — bot de WhatsApp (Jelou)

Onboarding de crédito y atención al cliente de Crediviva sobre Jelou Brain (company 14842).

- `workflows/`, `tools/`: definición del bot (se sincroniza con `jelou pull` / `jelou push`).
- `functions/`: funciones de Jelou (onboarding, validación, documentos) y sus webviews.
- `sites/`: webview de autenticación de atención al cliente.
- **`conversation/CONTEXTO.md`: contexto completo para continuar el proyecto** (arquitectura, ids,
  decisiones, pendientes y cómo diagnosticar).

Los secretos no están en el repo: viven en los secretos de la organización y de cada función en Jelou.
