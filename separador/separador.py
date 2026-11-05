"""
Separador de instrumentos do Musicalizando (roda no PC ou num Hugging Face Space).

Pede trabalho ao jogo (rotas /api/separador/*, com o SEPARADOR_TOKEN). Para cada pedido:
  1. busca o link atualizado da prévia no Deezer e baixa o MP3;
  2. separa com o Demucs (modelo htdemucs_6s) e guarda só bateria, baixo,
     guitarra e voz (piano e "other" são descartados), em MP3 mono ~64 kbps;
  3. mede o volume (RMS) de cada faixa e marca as quase silenciosas;
  4. envia as 4 faixas para o jogo, que grava no Storage e no cache (e apaga
     as usadas há mais tempo se o cache passar do limite).
A cada 30 s manda um "sinal de vida" com o nome do separador (SEPARADOR_NOME):
o jogo mostra quais estão ligados e a fila se divide entre eles.

Nenhuma chave do Supabase fica aqui: só a URL do jogo e o SEPARADOR_TOKEN.
"""
from __future__ import annotations

import io
import json
import math
import os
import sys
import threading
import time
import traceback
from pathlib import Path

VERSION = "2.0"
HERE = Path(__file__).resolve().parent
STEMS = ["drums", "bass", "guitar", "vocals"]  # o que o jogo usa (piano e other são descartados)
NAMES = {"drums": "bateria", "bass": "baixo", "guitar": "guitarra", "vocals": "voz"}

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------
# Configuração (separador/.env)
# ---------------------------------------------------------------------
def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    f = HERE / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    # variáveis de ambiente valem mais que o arquivo (ex.: num servidor, sem .env)
    for k in ("JOGO_URL", "SEPARADOR_TOKEN", "SEPARADOR_NOME", "CACHE_LIMITE_MB", "INTERVALO_FILA_SEGUNDOS",
              "LIMIAR_SILENCIO_DB", "MP3_KBPS", "PORT", "SAIR_OCIOSO_MIN", "MAX_MINUTOS", *env):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


ENV = load_env()
URL = ENV.get("JOGO_URL", "").rstrip("/")
TOKEN = ENV.get("SEPARADOR_TOKEN", "")
NAME = (ENV.get("SEPARADOR_NOME") or f"PC-{os.environ.get('USERNAME') or os.environ.get('USER') or 'casa'}")[:40]
LIMIT_MB = float(ENV.get("CACHE_LIMITE_MB", "200"))
POLL_S = float(ENV.get("INTERVALO_FILA_SEGUNDOS", "5"))
SILENCE_DB = float(ENV.get("LIMIAR_SILENCIO_DB", "-16"))  # abaixo da mistura: "sem conteúdo"
FLOOR_DB = -50.0  # abaixo disso é silêncio em qualquer música
BITRATE = int(ENV.get("MP3_KBPS", "64"))
PORT = int(ENV.get("PORT", "0") or 0)  # > 0: responde em HTTP (o Hugging Face Space precisa)
# Na nuvem (GitHub Actions): sai sozinho depois de N min com a fila vazia / depois de N min ligado
IDLE_EXIT_MIN = float(ENV.get("SAIR_OCIOSO_MIN", "0") or 0)
MAX_MIN = float(ENV.get("MAX_MINUTOS", "0") or 0)

if not URL or not TOKEN or "COLE" in TOKEN:
    log("❌ Falta configurar o separador/.env (JOGO_URL e SEPARADOR_TOKEN).")
    if (HERE / ".env").exists():
        log("   Abra o separador/.env e preencha JOGO_URL (endereço do jogo) e SEPARADOR_TOKEN.")
    else:
        log("   Copie separador/.env.example para separador/.env e preencha.")
    sys.exit(1)

# Usa os certificados do Windows (antivírus que inspeciona HTTPS assina as conexões
# com um certificado próprio, que o Windows conhece e o Python sozinho não)
try:
    import truststore

    truststore.inject_into_ssl()
except Exception:
    pass

import requests  # noqa: E402  (depois de conferir o .env, para a mensagem sair mesmo sem as dependências)


def api(action: str, payload: dict | None = None, files: dict | None = None, data: dict | None = None):
    """Chama uma rota do jogo (/api/separador/<action>) com o token do separador."""
    h = {"Authorization": f"Bearer {TOKEN}"}
    if files is not None:
        r = requests.post(f"{URL}/api/separador/{action}", headers=h, data=data or {}, files=files, timeout=90)
    else:
        r = requests.post(f"{URL}/api/separador/{action}", headers=h, json=payload or {}, timeout=30)
    if r.status_code >= 400:
        try:
            msg = r.json().get("error") or r.text[:300]
        except Exception:
            msg = r.text[:300]
        raise RuntimeError(f"{action}: {r.status_code} {msg}")
    return r.json() if r.text else None


# ---------------------------------------------------------------------
# Sinal de vida (thread separada: continua mesmo durante uma separação longa)
# ---------------------------------------------------------------------
STATE = {"status": "iniciando", "current": None, "done": 0, "errors": 0, "since": time.time(),
         "paused": False, "full": False}


def heartbeat_loop() -> None:
    while True:
        try:
            send_heartbeat()
        except Exception as e:  # sem internet etc.: tenta de novo daqui a pouco
            log(f"⚠️  Sinal de vida falhou: {e}")
        time.sleep(30)


def send_heartbeat() -> None:
    r = api("heartbeat", {"worker": NAME, "info": {
        "version": VERSION, "model": "htdemucs_6s", "status": STATE["status"],
        "current": STATE["current"], "done": STATE["done"], "errors": STATE["errors"],
        "limit_mb": LIMIT_MB,
    }}) or {}
    STATE["paused"], STATE["full"] = bool(r.get("paused")), bool(r.get("full"))


def status_server() -> None:
    """Página simples de estado (o Hugging Face Space precisa de um servidor HTTP na porta)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = json.dumps({"separador": NAME, "version": VERSION, "status": STATE["status"],
                               "current": STATE["current"], "done": STATE["done"], "errors": STATE["errors"],
                               "up_seconds": int(time.time() - STATE["since"])}, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()


# ---------------------------------------------------------------------
# Áudio
# ---------------------------------------------------------------------
def load_model():
    import torch
    from demucs.pretrained import get_model

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    log("⏳ Carregando o modelo htdemucs_6s (na 1ª vez baixa ~55 MB)…")
    model = get_model("htdemucs_6s")
    model.eval()
    log(f"✅ Modelo pronto. Faixas do modelo: {', '.join(model.sources)}")
    return model


def fetch_preview(deezer_id: int) -> tuple[bytes, str]:
    info: dict = {}
    try:
        r = requests.get(f"https://api.deezer.com/track/{deezer_id}", timeout=20)
        r.raise_for_status()
        info = r.json()
    except Exception:
        info = {}
    if info.get("error") or not info.get("preview"):
        # o Deezer às vezes recusa servidores na nuvem: o jogo busca o link
        try:
            g = requests.get(f"{URL}/api/deezer/track/{deezer_id}", timeout=20).json()
            if g.get("preview"):
                info = {"preview": g["preview"], "title": g.get("title"), "artist": {"name": g.get("artist")}}
        except Exception:
            pass
    if info.get("error"):
        raise RuntimeError(f"Deezer: {info['error'].get('message', 'erro')}")
    preview = info.get("preview")
    if not preview:
        raise RuntimeError("Faixa sem prévia no Deezer")
    label = f"{info.get('title', '?')} — {(info.get('artist') or {}).get('name', '?')}"
    a = requests.get(preview, timeout=30)
    a.raise_for_status()
    return a.content, label


def decode(mp3: bytes, samplerate: int):
    """MP3 -> tensor (2, amostras) na taxa do modelo."""
    import numpy as np
    import soundfile as sf
    import torch

    try:
        data, sr = sf.read(io.BytesIO(mp3), dtype="float32", always_2d=True)  # (amostras, canais)
    except Exception:
        # algumas versões do libsndfile só leem MP3 de arquivo
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            f.write(mp3)
            tmp = f.name
        try:
            data, sr = sf.read(tmp, dtype="float32", always_2d=True)
        finally:
            os.unlink(tmp)
    wav = torch.from_numpy(np.ascontiguousarray(data.T))
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    elif wav.shape[0] > 2:
        wav = wav[:2]
    if sr != samplerate:
        import julius

        wav = julius.resample_frac(wav, sr, samplerate)
    return wav


def separate(model, wav):
    """Devolve {nome: tensor (2, amostras)} para as 4 faixas que o jogo usa."""
    import torch
    from demucs.apply import apply_model

    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((wav - mean) / std)[None], device="cpu", shifts=1, split=True,
                          overlap=0.25, progress=False)[0]
    out = out * std + mean
    return {name: out[model.sources.index(name)] for name in STEMS}


def rms_db(x) -> float:
    import numpy as np

    v = float(np.sqrt(np.mean(np.square(x), dtype=np.float64)))
    return 20 * math.log10(v + 1e-9)


def to_mp3(mono, samplerate: int) -> bytes:
    import lameenc
    import numpy as np

    pcm = (np.clip(mono, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    enc = lameenc.Encoder()
    enc.set_bit_rate(BITRATE)
    enc.set_in_sample_rate(samplerate)
    enc.set_channels(1)
    enc.set_quality(2)
    return bytes(enc.encode(pcm) + enc.flush())


# ---------------------------------------------------------------------
# Um pedido
# ---------------------------------------------------------------------
def process(model, job: dict) -> None:
    deezer_id = int(job["deezer_id"])
    t0 = time.time()
    mp3, label = fetch_preview(deezer_id)
    STATE["current"] = label
    log(f"🎵 {label} (Deezer {deezer_id}) — separando…")

    wav = decode(mp3, model.samplerate)
    mix_db = rms_db(wav.mean(0).numpy())
    stems = separate(model, wav)
    t_sep = time.time() - t0

    files, levels, audible, total = {}, {}, {}, 0
    for name in STEMS:
        mono = stems[name].mean(0).numpy()
        db = rms_db(mono)
        levels[name] = round(db, 1)
        audible[name] = bool(db > max(FLOOR_DB, mix_db + SILENCE_DB))
        data = to_mp3(mono, model.samplerate)
        files[name] = (f"{name}.mp3", data, "audio/mpeg")
        total += len(data)

    # o jogo grava no Storage e no cache (e apaga as usadas há mais tempo se passar do limite)
    res = api("done", files=files, data={
        "worker": NAME, "deezer_id": str(deezer_id), "limit_mb": str(LIMIT_MB),
        "audible": json.dumps(audible), "levels": json.dumps({**levels, "mix": round(mix_db, 1)}),
    }) or {}
    if not res.get("ok"):
        why = {"duplicate": "outro separador terminou antes", "blocked": "bloqueada na biblioteca"}.get(res.get("reason"), res.get("reason"))
        log(f"↩️  Descartada ({why}).")
        return
    empty = [NAMES[n] for n in STEMS if not audible[n]]
    log(f"✅ Pronto em {time.time() - t0:.0f}s (separação {t_sep:.0f}s, {total / 1024:.0f} KB)"
        + (f" — sem conteúdo: {', '.join(empty)}" if empty else ""))
    log("   níveis (dB): " + ", ".join(f"{NAMES[n]} {levels[n]}" for n in STEMS) + f" | mistura {mix_db:.1f}")

    if res.get("evicted"):
        log(f"🧹 Cache acima do limite: saíram {res['evicted']} música(s) usadas há mais tempo.")


def main() -> None:
    log(f"🎛️  Separador do Musicalizando v{VERSION} — {NAME} — {URL}")
    if PORT:
        threading.Thread(target=status_server, daemon=True).start()
        log(f"🌐 Página de estado na porta {PORT}.")
    while True:
        try:
            send_heartbeat()
            log("🔗 Conectado ao jogo.")
            break
        except Exception as e:
            log(f"❌ Não consegui falar com o jogo: {e}")
            if not PORT:  # no PC: avisa e sai; no Space: tenta de novo
                log("   Confira JOGO_URL e SEPARADOR_TOKEN no separador/.env.")
                sys.exit(1)
            time.sleep(30)

    threading.Thread(target=heartbeat_loop, daemon=True).start()
    model = load_model()
    STATE["status"] = "aguardando"
    log(f"👀 Olhando a fila a cada {POLL_S:.0f}s. Deixe esta janela aberta (Ctrl+C para sair).")

    idle_logged: str | bool = False
    idle_since = time.time()
    while True:
        if MAX_MIN and time.time() - STATE["since"] > MAX_MIN * 60:
            log(f"⏹️  {MAX_MIN:.0f} min ligado: saindo (o jogo liga outro se ainda houver pedidos).")
            return
        try:
            job = (api("claim", {"worker": NAME}) or {}).get("job")
        except Exception as e:
            log(f"⚠️  Fila indisponível: {e}")
            time.sleep(max(POLL_S, 10))
            continue
        if not job:
            # a pausa fica no banco (botão "Pausar fila" no jogo): o claim não entrega nada
            paused, full = STATE["paused"], STATE["full"]
            why = "pausada" if paused else "cheia" if full else "vazia"
            if idle_logged != why:
                log({"pausada": "⏸️  Fila pausada no jogo. Esperando continuar…",
                     "cheia": "📌 Biblioteca cheia de músicas fixadas. Libere espaço em /biblioteca…",
                     "vazia": "💤 Fila vazia. Esperando pedidos…"}[why])
                idle_logged = why
            STATE["status"], STATE["current"] = ("pausado" if paused else "aguardando"), None
            if IDLE_EXIT_MIN and time.time() - idle_since > IDLE_EXIT_MIN * 60:
                log(f"👋 {IDLE_EXIT_MIN:.0f} min sem pedidos: desligando.")
                return
            time.sleep(POLL_S)
            continue
        idle_logged: str | bool = False
        STATE["status"] = "processando"
        try:
            process(model, job)
            STATE["done"] += 1
        except Exception as e:
            STATE["errors"] += 1
            msg = str(e) or e.__class__.__name__
            log(f"❌ Erro na faixa {job.get('deezer_id')}: {msg}")
            if os.environ.get("SEPARADOR_DEBUG"):
                traceback.print_exc()
            try:
                api("fail", {"worker": NAME, "deezer_id": int(job["deezer_id"]), "error": msg})
            except Exception as e2:
                log(f"⚠️  Não consegui marcar o erro na fila: {e2}")
        finally:
            STATE["current"] = None
            idle_since = time.time()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("👋 Separador desligado.")
