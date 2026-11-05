# Separador de instrumentos (modo "Instrumentos")

Programa que roda **no PC** e separa as prévias do Deezer em bateria, baixo,
guitarra e voz (Demucs, modelo `htdemucs_6s`, só CPU). O site nunca separa nada:
ele só coloca pedidos na fila (`npl_stems_queue`) e lê o resultado do cache
(`npl_stems_cache` + bucket `npl_stems`).

## Instalar (uma vez)
1. Instale o **Python 3.12**: `winget install -e --id Python.Python.3.12`
   (ou pelo python.org, marcando "Add python.exe to PATH").
2. Dê dois cliques em **`instalar-separador.bat`** (baixa PyTorch CPU + Demucs, ~1 GB no total).
3. Abra **`separador/.env`** e cole a chave `SUPABASE_SERVICE_ROLE_KEY`
   (Supabase > Project Settings > API Keys > service_role / secret key).
   Esse arquivo **não vai para o Git** e a chave **nunca** deve ir para a Vercel.

## Usar
Dê dois cliques em **`iniciar-separador.bat`** e deixe a janela aberta.
- Na 1ª vez ele baixa o modelo (~55 MB).
- A cada 5 s ele olha a fila; a cada 30 s grava o "sinal de vida" (a configuração
  do jogo mostra "Separador ligado/desligado").
- Cada música leva ~30–90 s neste PC (CPU).
- Cache limitado a 200 MB (`CACHE_LIMITE_MB`): passou disso, apaga as usadas há mais tempo.
- Faixa com volume abaixo de mistura − 24 dB (`LIMIAR_SILENCIO_DB`) é marcada "sem conteúdo"
  (ex.: guitarra em funk) e o jogo pula essa camada. Os níveis medidos aparecem no terminal.

## Trocar o separador depois
Qualquer outro programa (ex.: um Hugging Face Space) pode substituir este: basta
usar as mesmas RPCs com a service_role — `npl_stems_claim` (pega o próximo pedido),
`npl_stems_done` / `npl_stems_fail`, `npl_stems_heartbeat` e `npl_stems_evict` —
e enviar os MP3 para `npl_stems/<key>/<drums|bass|guitar|vocals>.mp3`. O jogo não muda.
