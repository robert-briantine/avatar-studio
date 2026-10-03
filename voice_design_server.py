#!/usr/bin/env python3
import base64
import io
import math
import os
import re
import threading
from typing import List, Optional

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from qwen_tts import Qwen3TTSModel

DESIGN_MODEL_ID = os.environ.get("VOICE_DESIGN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
BASE_MODEL_ID = os.environ.get("VOICE_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8880"))
ATTN = os.environ.get("TTS_ATTN", "sdpa")
DEVICE = os.environ.get("TTS_DEVICE", "cuda:0")

app = FastAPI(title="DGX Spark Qwen3-TTS VoiceDesign + VoiceClone")
_design_model: Optional[Qwen3TTSModel] = None
_base_model: Optional[Qwen3TTSModel] = None
_load_error: Optional[str] = None
_lock = threading.Lock()
_clone_prompt_cache = {}


class SpeechRequest(BaseModel):
    input: str
    language: str = "French"
    instructions: Optional[str] = None
    instruct: Optional[str] = None
    response_format: str = "wav"
    seed: Optional[int] = None
    max_new_tokens: Optional[int] = None


class CloneRequest(BaseModel):
    input: str
    language: str = "French"
    ref_audio: str
    ref_text: str
    reference_key: str
    response_format: str = "wav"
    seed: Optional[int] = None
    max_new_tokens: Optional[int] = None
    retry_profile: int = 0



class BatchSpeechRequest(BaseModel):
    input: List[str]
    language: str = "French"
    instructions: Optional[str] = None
    instruct: Optional[str] = None
    seed: Optional[int] = None
    max_new_tokens: Optional[int] = None


class BatchCloneRequest(BaseModel):
    input: List[str]
    language: str = "French"
    ref_audio: str
    ref_text: str = ""
    reference_key: str
    seed: Optional[int] = None
    max_new_tokens: Optional[int] = None


def _wav_bytes(wav, sample_rate: int) -> bytes:
    arr = np.asarray(wav, dtype=np.float32)
    out = io.BytesIO()
    sf.write(out, arr, sample_rate, format="WAV", subtype="PCM_16")
    return out.getvalue()


def _batch_response(wavs, sample_rate: int, task: str, model: str) -> JSONResponse:
    encoded = [base64.b64encode(_wav_bytes(w, sample_rate)).decode("ascii") for w in wavs]
    return JSONResponse({
        "task": task,
        "model": model,
        "sample_rate": sample_rate,
        "format": "wav",
        "audio": encoded,
    })



def _max_new_tokens_for_text(text: str, requested: Optional[int] = None) -> int:
    """
    Dynamic safety budget for Qwen3-TTS.

    The model uses a low-rate audio-token stream. If EOS is missed, a fixed
    max_new_tokens=4096 produces about 5m28 of output. Scale the budget to the
    actual text instead, while staying very generous.
    """
    normalized = (text or "").strip()
    words = max(1, len(re.findall(r"\S+", normalized)))
    punctuation = len(re.findall(r"[,.!?;:…]", normalized))

    estimated_seconds = max(2.0, words / 2.1 + punctuation * 0.12)
    safe_seconds = max(28.0, estimated_seconds * 3.2 + 10.0)
    automatic = max(384, min(4096, int(math.ceil(safe_seconds * 12.5))))

    if requested is None:
        return automatic

    try:
        wanted = int(requested)
    except Exception:
        return automatic
    return max(384, min(automatic, wanted, 4096))



def _clone_sampling_profile(profile: int):
    """
    Distinct clone-generation profiles.

    v5.36 used top_k=1 for every retry, making seed changes nearly irrelevant.
    Keep the same x-vector speaker identity, but vary the sampling trajectory so
    an EOS failure is not repeated deterministically.
    """
    profiles = [
        # Stable but not greedy.
        dict(
            temperature=0.35, top_p=0.80, top_k=30, repetition_penalty=1.08,
            subtalker_temperature=0.35, subtalker_top_p=0.80, subtalker_top_k=30,
        ),
        # Balanced retry.
        dict(
            temperature=0.55, top_p=0.90, top_k=50, repetition_penalty=1.12,
            subtalker_temperature=0.55, subtalker_top_p=0.90, subtalker_top_k=50,
        ),
        # Close to the official sampling defaults, with a little more anti-repeat.
        dict(
            temperature=0.90, top_p=1.00, top_k=50, repetition_penalty=1.15,
            subtalker_temperature=0.90, subtalker_top_p=1.00, subtalker_top_k=50,
        ),
        # Strong anti-loop fallback.
        dict(
            temperature=0.70, top_p=0.95, top_k=80, repetition_penalty=1.25,
            subtalker_temperature=0.70, subtalker_top_p=0.95, subtalker_top_k=80,
        ),
    ]
    return profiles[max(0, min(int(profile), len(profiles) - 1))]


def _seed(value: Optional[int]) -> None:
    if value is None:
        return
    seed = int(value)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def _wav_response(wav, sample_rate: int, task: str, model: str) -> Response:
    return Response(
        content=_wav_bytes(wav, sample_rate),
        media_type="audio/wav",
        headers={"X-Qwen-Task": task, "X-Qwen-Model": model},
    )



def _free_cuda() -> None:
    if torch.cuda.is_available():
        try:
            torch.cuda.synchronize()
        except Exception:
            pass
        torch.cuda.empty_cache()


def _unload_design() -> None:
    global _design_model
    if _design_model is not None:
        print("Déchargement VoiceDesign de la mémoire...")
        _design_model = None
        _free_cuda()


def _unload_base() -> None:
    global _base_model, _clone_prompt_cache
    if _base_model is not None:
        print("Déchargement VoiceClone Base de la mémoire...")
        _base_model = None
        _clone_prompt_cache = {}
        _free_cuda()


def _ensure_design():
    global _design_model, _load_error
    if _design_model is not None:
        return _design_model

    _unload_base()
    dtype = torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32
    print("Chargement lazy VoiceDesign:", DESIGN_MODEL_ID)
    try:
        _design_model = Qwen3TTSModel.from_pretrained(
            DESIGN_MODEL_ID,
            device_map=DEVICE,
            dtype=dtype,
            attn_implementation=ATTN,
        )
        _load_error = None
        print("VoiceDesign prêt.")
        return _design_model
    except Exception as exc:
        _load_error = f"{type(exc).__name__}: {exc}"
        print("ERREUR chargement VoiceDesign:", _load_error)
        _design_model = None
        _free_cuda()
        raise


def _ensure_base():
    global _base_model, _load_error
    if _base_model is not None:
        return _base_model

    _unload_design()
    dtype = torch.bfloat16 if DEVICE.startswith("cuda") else torch.float32
    print("Chargement lazy VoiceClone Base:", BASE_MODEL_ID)
    try:
        _base_model = Qwen3TTSModel.from_pretrained(
            BASE_MODEL_ID,
            device_map=DEVICE,
            dtype=dtype,
            attn_implementation=ATTN,
        )
        _load_error = None
        print("VoiceClone Base prêt.")
        return _base_model
    except Exception as exc:
        _load_error = f"{type(exc).__name__}: {exc}"
        print("ERREUR chargement VoiceClone Base:", _load_error)
        _base_model = None
        _free_cuda()
        raise


@app.on_event("startup")
def startup() -> None:
    # Do NOT eagerly load both 1.7B models.
    # On DGX Spark, ComfyUI + Qwen-Image may already occupy a large amount of
    # unified memory. The TTS model is loaded only when its endpoint is called.
    print("Serveur TTS direct-v11 démarré en mode mémoire basse.")
    print("Aucun modèle TTS chargé au démarrage.")


@app.get("/health")
def health():
    gpu_available = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if gpu_available else None
    vram_total = None
    vram_used = None
    if gpu_available:
        props = torch.cuda.get_device_properties(0)
        vram_total = f"{props.total_memory / (1024**3):.2f} GB"
        try:
            free, total = torch.cuda.mem_get_info(0)
            vram_used = f"{(total - free) / (1024**3):.2f} GB"
        except Exception:
            pass

    active_model = (
        "voice_design" if _design_model is not None
        else "voice_clone_base" if _base_model is not None
        else "none"
    )

    return {
        "status": "healthy",
        "backend": {
            "name": "direct-voice-design-clone-lazy",
            "model_id": DESIGN_MODEL_ID,
            "base_model_id": BASE_MODEL_ID,
            "ready": True,
            "clone_ready": True,
            "lazy_loading": True,
            "active_model": active_model,
            "clone_cache_size": len(_clone_prompt_cache),
            "error": _load_error,
        },
        "device": {
            "type": DEVICE,
            "gpu_available": gpu_available,
            "gpu_name": gpu_name,
            "vram_total": vram_total,
            "vram_used": vram_used,
        },
        "version": "direct-v15-diverse-retry-profiles",
    }


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest):
    try:
        model = _ensure_design()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"VoiceDesign load failed: {type(exc).__name__}: {exc}")
    text = request.input.strip()
    prompt = (request.instructions or request.instruct or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="input is empty")
    if not prompt:
        raise HTTPException(status_code=400, detail="VoiceDesign instructions are empty")
    if request.response_format.lower() != "wav":
        raise HTTPException(status_code=400, detail="Only WAV is supported")
    try:
        with _lock:
            _seed(request.seed)
            token_budget = _max_new_tokens_for_text(text, request.max_new_tokens)
            print(f"VoiceDesign: {len(text.split())} mots, budget={token_budget} tokens")
            wavs, sample_rate = model.generate_voice_design(
                text=text,
                language=request.language or "French",
                instruct=prompt,
                non_streaming_mode=True,
                max_new_tokens=token_budget,
                do_sample=True,
                temperature=0.9,
                top_p=1.0,
                top_k=50,
                repetition_penalty=1.05,
                subtalker_dosample=True,
                subtalker_temperature=0.9,
                subtalker_top_p=1.0,
                subtalker_top_k=50,
            )
        if not wavs:
            raise RuntimeError("Qwen3-TTS returned no waveform")
        return _wav_response(wavs[0], sample_rate, "VoiceDesign", DESIGN_MODEL_ID)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": "voice_design_error", "message": f"{type(exc).__name__}: {exc}"})


@app.post("/v1/audio/clone")
def clone(request: CloneRequest):
    try:
        model = _ensure_base()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"VoiceClone Base load failed: {type(exc).__name__}: {exc}")
    text = request.input.strip()
    ref_audio = request.ref_audio.strip()
    ref_text = request.ref_text.strip()
    key = request.reference_key.strip()
    if not text:
        raise HTTPException(status_code=400, detail="input is empty")
    if not ref_audio or not os.path.isfile(ref_audio):
        raise HTTPException(status_code=400, detail=f"reference audio not found: {ref_audio}")
    # En mode timbre verrouillé (x-vector), ref_text n'est pas nécessaire.
    if request.response_format.lower() != "wav":
        raise HTTPException(status_code=400, detail="Only WAV is supported")
    try:
        with _lock:
            prompt_items = _clone_prompt_cache.get(key)
            if prompt_items is None:
                print("Création du prompt de clonage:", key)
                prompt_items = model.create_voice_clone_prompt(
                    ref_audio=ref_audio,
                    ref_text=None,
                    x_vector_only_mode=True,
                )
                _clone_prompt_cache[key] = prompt_items
            _seed(request.seed)
            token_budget = _max_new_tokens_for_text(text, request.max_new_tokens)
            sampling = _clone_sampling_profile(request.retry_profile)
            print(
                f"VoiceClone: {len(text.split())} mots, budget={token_budget} tokens, "
                f"profile={request.retry_profile}, temp={sampling['temperature']}, "
                f"top_k={sampling['top_k']}, rep={sampling['repetition_penalty']}"
            )
            wavs, sample_rate = model.generate_voice_clone(
                text=text,
                language=request.language or "French",
                voice_clone_prompt=prompt_items,
                non_streaming_mode=True,
                max_new_tokens=token_budget,
                do_sample=True,
                temperature=sampling["temperature"],
                top_p=sampling["top_p"],
                top_k=sampling["top_k"],
                repetition_penalty=sampling["repetition_penalty"],
                subtalker_dosample=True,
                subtalker_temperature=sampling["subtalker_temperature"],
                subtalker_top_p=sampling["subtalker_top_p"],
                subtalker_top_k=sampling["subtalker_top_k"],
            )
        if not wavs:
            raise RuntimeError("Qwen3-TTS Base returned no waveform")
        return _wav_response(wavs[0], sample_rate, "VoiceClone", BASE_MODEL_ID)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": "voice_clone_error", "message": f"{type(exc).__name__}: {exc}"})



@app.post("/v1/audio/speech-batch")
def speech_batch(request: BatchSpeechRequest):
    try:
        model = _ensure_design()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"VoiceDesign load failed: {type(exc).__name__}: {exc}")

    texts = [str(x).strip() for x in request.input]
    prompt = (request.instructions or request.instruct or "").strip()

    if not texts or any(not x for x in texts):
        raise HTTPException(status_code=400, detail="batch input contains an empty text")
    if not prompt:
        raise HTTPException(status_code=400, detail="VoiceDesign instructions are empty")

    try:
        all_wavs = []
        sample_rate = None

        # IMPORTANT: do NOT pass the whole list to Qwen at once.
        # That can create a large parallel batch and make the DGX TTS process
        # disappear under memory pressure. We keep one HTTP batch request, but
        # execute one exact text at a time with the same seed and same model.
        with _lock:
            for index, text in enumerate(texts):
                token_budget = _max_new_tokens_for_text(text, request.max_new_tokens)
                print(f"VoiceDesign batch séquentiel {index + 1}/{len(texts)} — {len(text.split())} mots — budget={token_budget}")
                _seed(request.seed)
                wavs, sr = model.generate_voice_design(
                    text=text,
                    language=request.language or "French",
                    instruct=prompt,
                    non_streaming_mode=True,
                    max_new_tokens=token_budget,
                    do_sample=True,
                    temperature=0.30,
                    top_p=0.60,
                    top_k=20,
                    repetition_penalty=1.05,
                    subtalker_dosample=True,
                    subtalker_temperature=0.30,
                    subtalker_top_p=0.60,
                    subtalker_top_k=20,
                )
                if not wavs:
                    raise RuntimeError(f"Qwen3-TTS returned no waveform for item {index + 1}")
                all_wavs.append(wavs[0])
                sample_rate = sr
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

        return _batch_response(all_wavs, int(sample_rate), "VoiceDesignSequentialBatch", DESIGN_MODEL_ID)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "voice_design_sequential_batch_error",
                "message": f"{type(exc).__name__}: {exc}",
                "hint": "See /tmp/qwen3-tts-dgx.log"
            }
        )


@app.post("/v1/audio/clone-batch")
def clone_batch(request: BatchCloneRequest):
    try:
        model = _ensure_base()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"VoiceClone Base load failed: {type(exc).__name__}: {exc}")

    texts = [str(x).strip() for x in request.input]
    ref_audio = request.ref_audio.strip()
    key = request.reference_key.strip()

    if not texts or any(not x for x in texts):
        raise HTTPException(status_code=400, detail="batch input contains an empty text")
    if not ref_audio or not os.path.isfile(ref_audio):
        raise HTTPException(status_code=400, detail=f"reference audio not found: {ref_audio}")

    try:
        all_wavs = []
        sample_rate = None

        with _lock:
            prompt_items = _clone_prompt_cache.get(key)
            if prompt_items is None:
                print("Création du prompt de clonage batch:", key)
                prompt_items = model.create_voice_clone_prompt(
                    ref_audio=ref_audio,
                    ref_text=None,
                    x_vector_only_mode=True,
                )
                _clone_prompt_cache[key] = prompt_items

            # Exact sequence mapping, but sequential inference to cap peak
            # memory. The same cached x-vector and the same seed are reused for
            # every utterance to stabilize speaker identity.
            for index, text in enumerate(texts):
                token_budget = _max_new_tokens_for_text(text, request.max_new_tokens)
                print(f"VoiceClone batch séquentiel {index + 1}/{len(texts)} — {len(text.split())} mots — budget={token_budget}")
                _seed(request.seed)
                wavs, sr = model.generate_voice_clone(
                    text=text,
                    language=request.language or "French",
                    voice_clone_prompt=prompt_items,
                    non_streaming_mode=True,
                    max_new_tokens=token_budget,
                    do_sample=True,
                    temperature=0.55,
                    top_p=0.90,
                    top_k=50,
                    repetition_penalty=1.12,
                    subtalker_dosample=True,
                    subtalker_temperature=0.55,
                    subtalker_top_p=0.90,
                    subtalker_top_k=50,
                )
                if not wavs:
                    raise RuntimeError(f"Qwen3-TTS returned no waveform for item {index + 1}")
                all_wavs.append(wavs[0])
                sample_rate = sr
                print(f"VoiceClone batch terminé {index + 1}/{len(texts)}")
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

        print(f"VoiceClone batch complet: {len(all_wavs)}/{len(texts)}")
        return _batch_response(all_wavs, int(sample_rate), "VoiceCloneSequentialBatch", BASE_MODEL_ID)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "voice_clone_sequential_batch_error",
                "message": f"{type(exc).__name__}: {exc}",
                "hint": "See /tmp/qwen3-tts-dgx.log"
            }
        )

@app.post("/v1/models/release")
def release_models():
    with _lock:
        _unload_design()
        _unload_base()
    return {"ok": True, "active_model": "none", "version": "direct-v11"}



@app.post("/v1/process/terminate")
def terminate_process():
    # This endpoint intentionally does NOT take _lock.
    # It must remain able to terminate a stuck PyTorch generation running in
    # another FastAPI worker thread.
    print("Arrêt dur TTS demandé. Fin immédiate du processus.")
    import sys
    sys.stdout.flush()
    sys.stderr.flush()

    def _exit_now():
        import time
        time.sleep(0.10)
        os._exit(0)

    threading.Thread(target=_exit_now, daemon=True).start()
    return {"ok": True, "message": "TTS process terminating"}



if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, workers=1)
