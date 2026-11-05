# Separador do Musicalizando num Hugging Face Space (Docker, CPU basic grátis).
# O mesmo separador.py do PC; as variáveis secretas do Space dão JOGO_URL e SEPARADOR_TOKEN.
FROM python:3.11-slim

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    TORCH_HOME=/home/user/.cache/torch \
    PORT=7860 \
    SEPARADOR_NOME=HuggingFace
WORKDIR /home/user/app

# PyTorch só CPU (bem menor que o padrão)
RUN pip install --no-cache-dir --user torch --index-url https://download.pytorch.org/whl/cpu
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt && \
    pip install --no-cache-dir --user --no-deps "demucs>=4.0.1"

# baixa o modelo na construção: acordar fica mais rápido
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"

COPY --chown=user separador.py .
EXPOSE 7860
CMD ["python", "separador.py"]
