# Musicalizando 🎶

Jogo de festa de adivinhar músicas. Uma tela principal (TV/notebook) toca o som; cada jogador usa o celular como controle.

## Rodar localmente

```bash
npm install
cp .env.example .env.local   # preencha com os dados do Supabase
npm run dev
```

- Tela principal: `http://localhost:3000/tv`
- Celular: `http://<ip-do-notebook>:3000/j` (mesma rede Wi-Fi)

### Testes (sem tocar no Supabase)

```bash
npm run test:db        # roda as migrações e cenários do jogo num Postgres em memória (PGlite)
npm run dev:fake-db    # emula as RPCs do Supabase em http://localhost:54329 (sem Realtime: usa polling)
node scripts/rpc-contract-test.mjs   # com o dev:fake-db rodando: confere api.ts <-> SQL
```

## Banco (projeto Supabase compartilhado)

Tudo usa o prefixo `npl_`. Aplique no SQL Editor, nesta ordem:

1. `supabase/migrations/20261104000001_npl_schema.sql`
2. `supabase/migrations/20261104000002_npl_helpers.sql`
3. `supabase/migrations/20261104000003_npl_rpc.sql`

As tabelas têm RLS ligado e nenhuma policy, ou seja, ninguém lê nem escreve nelas diretamente. Para ler, usa-se `npl_get_state(código)`; para escrever, as RPCs `security definer`, que validam o token. O tempo real usa Realtime Broadcast (`realtime.send`, canal `npl_room_<id>`), então não é preciso mexer na publicação `supabase_realtime`.

## Estrutura

- `src/modes/`: registro de modos de jogo (fase 1: `classic`). Um modo novo define estágios/pontos e um "motor" que toca a rodada na TV.
- `src/lib/deezer.ts`: acesso ao Deezer, só pelo servidor (rotas `/api/deezer/*`).
- `src/lib/audio.ts`: Web Audio (fetch + decode) para cortes precisos.
- `src/hooks/useRoom.ts`: sincronização (Broadcast + presença + polling de segurança).
- `src/components/tv/*` e `src/components/phone/*`: telas.
