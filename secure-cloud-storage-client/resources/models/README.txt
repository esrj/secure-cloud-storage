Smart-classify model (the only one, since 2026-10):

  Gemma 4 E4B-it (GGUF Q4_K_M, Apache 2.0)  ->  gemma-4-E4B-it-Q4_K_M.gguf

  Source: https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF
          (resolve/main/gemma-4-E4B-it-Q4_K_M.gguf, ~4.98 GB)
  Needs:  node-llama-cpp >= 3.19.0 (Gemma 4 architecture support).

Text-only classification: the mmproj-*.gguf (vision) and mtp-*.gguf files
from that repo are NOT needed. The former Qwen3.5-4B / 9B tiers were
removed. Only gemma-4-E4B-it-Q4_K_M.gguf is copied into the packaged app
(see electron-builder.yml -> extraResources); any other .gguf left in this
folder is ignored by the build and can be deleted.

Windows installers never contain the model (NSIS caps one installer at about
2 GB): electron-builder.win.cjs drops it, and the installed app downloads or
imports it into %LOCALAPPDATA%\client-side\models the first time smart
classify is switched on. The pinned revision, size and SHA-256 are in
src/main/services/classifierModelManifest.js.
