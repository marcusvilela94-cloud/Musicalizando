# Separador de instrumentos (modo "Instrumentos")

Programa que separa as prévias do Deezer em bateria, baixo, guitarra e voz
(Demucs, modelo `htdemucs_6s`, só CPU). Pode rodar **no PC** e/ou **na nuvem**
(GitHub Actions), ao mesmo tempo: a fila se divide entre eles. O site nunca separa nada: só coloca pedidos na fila e lê o cache.

O separador **não tem chave do Supabase**: fala só com o jogo, pelas rotas
`/api/separador/*`, com o `SEPARADOR_TOKEN` (o mesmo que está na Vercel).

## Instalar no PC (uma vez)
1. Instale o **Python** (3.12 ou mais novo; testado com 3.15): `winget install -e --id Python.Python.3.12`
   (ou pelo python.org, marcando "Add python.exe to PATH").
2. Dê dois cliques em **`instalar-separador.bat`** (baixa PyTorch CPU + Demucs, ~1 GB no total).
3. Abra **`separador/.env`** e preencha `JOGO_URL`, `SEPARADOR_TOKEN` e `SEPARADOR_NOME`
   (ex.: `PC-Marcus`, é o nome que aparece no jogo). Esse arquivo **não vai para o Git**.

## Usar
Dê dois cliques em **`iniciar-separador.bat`** e deixe a janela aberta.
- Na 1ª vez ele baixa o modelo (~55 MB).
- A cada 5 s ele pede o próximo pedido ao jogo; a cada 30 s manda o "sinal de vida"
  (a configuração do jogo mostra quais separadores estão ligados).
- Cada música leva ~40 s neste PC (CPU, medido).
- Dois separadores nunca pegam a mesma música. Se um parar no meio (sem sinal de vida
  por 3 min), o outro retoma; se os dois chegarem a terminar, só o primeiro vale.
- "Pausar fila" / "Limpar fila" (configuração do jogo, Instrumentos) valem para todos:
  pausado, ele termina a música atual e não pega outra até "Continuar fila".
- Cache limitado a 200 MB (`CACHE_LIMITE_MB`; o limite definido na página /biblioteca vale mais):
  passou disso, o jogo apaga as usadas há mais tempo — menos as fixadas. Se as fixadas ocuparem
  o limite inteiro, os separadores param de preparar até liberar espaço.
- Faixa com volume abaixo de mistura − 16 dB (`LIMIAR_SILENCIO_DB`) é marcada "sem conteúdo"
  (ex.: guitarra em funk) e o jogo pula essa camada. Os níveis medidos aparecem no terminal.

## Separador na nuvem (GitHub Actions)
O workflow `.github/workflows/separador.yml` roda este mesmo `separador.py` numa
máquina do GitHub, com o nome `Nuvem`. Quando ninguém está ligado e alguém pede
para preparar (ou a partida precisa em segundo plano), o jogo dispara o workflow
(`GH_DISPATCH_TOKEN` na Vercel: token fine-grained só com "Actions: read and write"
neste repositório). Ele liga em ~35 s, separa (~15–20 s por música) e desliga
sozinho depois de 5 min sem pedidos. Segredos do repositório: `JOGO_URL` e
`SEPARADOR_TOKEN`. O progresso aparece em GitHub → Actions → "Separador (nuvem)".

(Alternativa paga: Hugging Face Space, pasta `space/` + `node scripts/hf-space.mjs`,
com `HF_SPACE` na Vercel. Spaces Docker no CPU grátis exigem a assinatura PRO.)
