---
title: Musicalizando Separador
emoji: 🥁
colorFrom: purple
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

Separador de instrumentos do Musicalizando (Demucs `htdemucs_6s`, só CPU).

Pega pedidos da fila do jogo pelas rotas `/api/separador/*` com o nome
`HuggingFace` e devolve 4 faixas (voz, bateria, guitarra, baixo) em MP3 mono
~64 kbps. Variáveis secretas: `JOGO_URL` e `SEPARADOR_TOKEN`.

A página do Space mostra só o estado em JSON.
