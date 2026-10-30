# AGENTS.md — @michelangelo-land/sdk

SDK TypeScript ufficiale, pubblicato su npm, zero dipendenze a runtime.
Il punto di contatto con l'API è il contratto OpenAPI: `GET /v1/openapi.json`,
vendorizzato in `openapi/openapi.json`.

## Com'è fatto
- `src/config.ts`, `src/types.ts`, `src/client.ts` seguono il contratto; `src/auth.ts` e
  `src/pkce.ts` fanno OAuth 2.1 + PKCE con token in memoria e persistenza opt-in via
  adapter (`src/storage.ts`). `src/node-loopback.ts` è solo per Node: mai nei bundle app.
- `dist/` è generato: non si modifica a mano.
- `test/` gira con `tsx --test`; `examples/` hanno script eseguibili.

## Comandi
```bash
npm run type-check    # tsc --noEmit
npm run test          # tsx --test test/*.test.ts
npm run contract      # SDK vs file vendorizzato vs documento live
npm run contract -- --offline   # solo file vendorizzato, senza rete
npm run sync:openapi  # riscarica openapi/openapi.json
npm run build         # dist/ (parte anche in prepublishOnly)
```

## Regole
- Una modifica all'API arriva qui: prima il contratto in `api/openapi/v1.yaml`, poi
  `npm run sync:openapi`, poi tipi e client, poi `npm run contract` verde.
- Mai modificare `dist/` né `openapi/openapi.json` a mano.
- Pubblicazione solo dopo che l'API è live: bump di versione e tag, poi publish.
- Nessuna dipendenza runtime nuova senza chiedere in chat.
- Il client secret OAuth resta lato server: nell'SDK non entra mai.
