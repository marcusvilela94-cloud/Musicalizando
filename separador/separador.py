"""
Separador de instrumentos do Musicalizando (roda no PC, fora do site).

Fica olhando a fila no Supabase (npl_stems_queue). Para cada pedido:
  1. busca o link atualizado da prévia no Deezer e baixa o MP3;
  2. separa com o Demucs (modelo htdemucs_6s) e guarda só bateria, baixo,
     guitarra e voz (piano e "other" são descartados), em MP3 mono ~64 kbps;
  3. mede o volume (RMS) de cada faixa e marca as quase silenciosas;
  4. envia as faixas para o Storage (bucket npl_stems) e grava o cache;
  5. se o cache passar do limite, apaga as músicas usadas há mais tempo.
A cada 30 s grava um "sinal de vida" (o jogo mostra se o separador está ligado).

Tudo passa por RPCs do banco (npl_stems_claim/done/fail/heartbeat/evict) e pela
API do Storage. Outro separador (ex.: um Hugging Face Space) pode fazer o mesmo
sem mudar nada no jogo.

A chave service_role fica SÓ no separador/.env (fora do Git).
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
import uuid
from pathlib import Path

VERSION = "1.0"
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
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CACHE_LIMITE_MB", "INTERVALO_FILA_SEGUNDOS",
              "LIMIAR_SILENCIO_DB", "MP3_KBPS", *env):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


ENV = load_env()
URL = ENV.get("SUPABASE_URL", "").rstrip("/")
KEY = ENV.get("SUPABASE_SERVICE_ROLE_KEY", "")
LIMIT_MB = float(ENV.get("CACHE_LIMITE_MB", "200"))
POLL_S = float(ENV.get("INTERVALO_FILA_SEGUNDOS", "5"))
SILENCE_DB = float(ENV.get("LIMIAR_SILENCIO_DB", "-16"))  # abaixo da mistura: "sem conteúdo"
FLOOR_DB = -50.0  # abaixo disso é silêncio em qualquer música
BITRATE = int(ENV.get("MP3_KBPS", "64"))
BUCKET = "npl_stems"

if not URL or not KEY or "COLE" in KEY:
    log("❌ Falta configurar o separador/.env (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY).")
    if (HERE / ".env").exists():
        log("   Abra o separador/.env e cole a chave service_role (Supabase > Project Settings > API Keys).")
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


def headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    h = {"apikey": KEY}
    # chave antiga (JWT "eyJ…") vai também no Authorization; a nova (sb_secret_…) só no apikey
    if KEY.startswith("eyJ"):
        h["Authorization"] = f"Bearer {KEY}"
    if extra:
        h.update(extra)
    return h


def rpc(name: str, args: dict | None = None):
    r = requests.post(
        f"{URL}/rest/v1/rpc/{name}",
        headers=headers({"Content-Type": "application/json"}),
        data=json.dumps(args or {}),
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"RPC {name}: {r.status_code} {r.text[:300]}")
    return r.json() if r.text else None


def upload(path: str, data: bytes) -> None:
    r = requests.post(
        f"{URL}/storage/v1/object/{BUCKET}/{path}",
        headers=headers({"Content-Type": "audio/mpeg", "x-upsert": "true", "cache-control": "31536000"}),
        data=data,
        timeout=60,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Storage (envio de {path}): {r.status_code} {r.text[:300]}")


def remove(paths: list[str]) -> None:
    if not paths:
        return
    r = requests.delete(
        f"{URL}/storage/v1/object/{BUCKET}",
        headers=headers({"Content-Type": "application/json"}),
        data=json.dumps({"prefixes": paths}),
        timeout=60,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Storage (apagar): {r.status_code} {r.text[:300]}")


# ---------------------------------------------------------------------
# Sinal de vida (thread separada: continua mesmo durante uma separação longa)
# ---------------------------------------------------------------------
STATE = {"status": "iniciando", "current": None, "done": 0, "errors": 0, "since": time.time()}


def heartbeat_loop() -> None:
    while True:
        try:
            rpc("npl_stems_heartbeat", {"p_info": {
                "version": VERSION, "model": "htdemucs_6s", "status": STATE["status"],
                "current": STATE["current"], "done": STATE["done"], "errors": STATE["errors"],
            }})
        except Exception as e:  # sem internet etc.: tenta de novo daqui a pouco
            log(f"⚠️  Sinal de vida falhou: {e}")
        time.sleep(30)


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
    r = requests.get(f"https://api.deezer.com/track/{deezer_id}", timeout=20)
    r.raise_for_status()
    info = r.json()
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

    key = str(uuid.uuid4())
    paths, levels, audible, total = {}, {}, {}, 0
    for name in STEMS:
        mono = stems[name].mean(0).numpy()
        db = rms_db(mono)
        levels[name] = round(db, 1)
        audible[name] = db > max(FLOOR_DB, mix_db + SILENCE_DB)
        data = to_mp3(mono, model.samplerate)
        path = f"{key}/{name}.mp3"
        upload(path, data)
        paths[name] = path
        total += len(data)

    rpc("npl_stems_done", {
        "p_deezer_id": deezer_id, "p_key": key, "p_paths": paths, "p_bytes": total,
        "p_audible": audible, "p_levels": {**levels, "mix": round(mix_db, 1)},
    })
    empty = [NAMES[n] for n in STEMS if not audible[n]]
    log(f"✅ Pronto em {time.time() - t0:.0f}s (separação {t_sep:.0f}s, {total / 1024:.0f} KB)"
        + (f" — sem conteúdo: {', '.join(empty)}" if empty else ""))
    log("   níveis (dB): " + ", ".join(f"{NAMES[n]} {levels[n]}" for n in STEMS) + f" | mistura {mix_db:.1f}")

    # limite do cache: apaga as usadas há mais tempo
    gone = rpc("npl_stems_evict", {"p_limit_bytes": int(LIMIT_MB * 1024 * 1024)}) or []
    if gone:
        files = [p for g in gone for p in (g.get("paths") or {}).values()]
        try:
            remove(files)
        except Exception as e:
            log(f"⚠️  Não consegui apagar arquivos antigos do Storage: {e}")
        log(f"🧹 Cache acima de {LIMIT_MB:.0f} MB: apaguei {len(gone)} música(s) usadas há mais tempo.")


def main() -> None:
    log(f"🎛️  Separador do Musicalizando v{VERSION} — {URL}")
    try:
        st = rpc("npl_stems_status", {"p_ids": []})
        cache = st.get("cache") or {}
        log(f"🔗 Conectado. Cache: {cache.get('songs', 0)} música(s), {int(cache.get('bytes', 0)) / 1048576:.1f} MB "
            f"(limite {LIMIT_MB:.0f} MB).")
    except Exception as e:
        log(f"❌ Não consegui falar com o Supabase: {e}")
        log("   Confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no separador/.env.")
        sys.exit(1)

    threading.Thread(target=heartbeat_loop, daemon=True).start()
    model = load_model()
    STATE["status"] = "aguardando"
    log(f"👀 Olhando a fila a cada {POLL_S:.0f}s. Deixe esta janela aberta (Ctrl+C para sair).")

    idle_logged: str | bool = False
    while True:
        try:
            job = rpc("npl_stems_claim")
        except Exception as e:
            log(f"⚠️  Fila indisponível: {e}")
            time.sleep(max(POLL_S, 10))
            continue
        if not job:
            # a pausa fica no banco (botão "Pausar fila" no jogo): o claim não entrega nada
            paused = False
            try:
                paused = bool(((rpc("npl_stems_status", {"p_ids": []}) or {}).get("global") or {}).get("paused"))
            except Exception:
                pass
            if idle_logged != ("pausada" if paused else "vazia"):
                log("⏸️  Fila pausada no jogo. Esperando continuar…" if paused else "💤 Fila vazia. Esperando pedidos…")
                idle_logged = "pausada" if paused else "vazia"
            STATE["status"], STATE["current"] = ("pausado" if paused else "aguardando"), None
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
                rpc("npl_stems_fail", {"p_deezer_id": int(job["deezer_id"]), "p_error": msg})
            except Exception as e2:
                log(f"⚠️  Não consegui marcar o erro na fila: {e2}")
        finally:
            STATE["current"] = None


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("👋 Separador desligado.")
