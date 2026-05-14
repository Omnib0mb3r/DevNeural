# Credits and Attributions

DevNeural stands on third-party work. The list below is meant to be honest about what came from elsewhere and to credit the original authors. None of these projects endorse DevNeural; we just use or were influenced by them.

## Code dependencies

### whisper.cpp by ggerganov
- Repo: https://github.com/ggerganov/whisper.cpp
- License: MIT
- How we use it: ASR engine for voice mode and meeting capture. DevNeural ships installation steps that download the official `whisper-bin-x64.zip` from upstream releases and call its `main.exe` for offline transcription.
- Where: `docs/install/AUDIO-VIDEO.md`; runtime invoked from the daemon's voice pipeline.

### BurntToast by Windos
- Repo: https://github.com/Windos/BurntToast
- License: MIT
- How we use it: Windows native toast notifications for reminders and Lex attention pushes when the web-push fallback is unavailable.
- Where: `07-daemon/src/dashboard/toast-fallback.ts` shells out to PowerShell with `Import-Module BurntToast` and `New-BurntToastNotification`.

## Design influence

### "LLM Wiki" pattern by Andrej Karpathy
- Gist: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- How it influenced us: Early DevNeural design read Karpathy's "LLM Wiki" sketch as a reference for treating notes as a substrate the model writes to and reads back. The current architecture diverges (brainstorms are the substrate here, not wiki pages), but the seed idea about a persistent, model-touchable knowledge layer came from that gist.
- Where the influence is documented: `voice-review.md`.

## Standard libraries

DevNeural also depends on the usual ecosystem packages from npm (React, Next.js, Fastify, vitest, etc.) and the Node.js standard library. Their licenses are recorded in their respective `package.json` and `package-lock.json` entries; we do not duplicate them here.

## License

DevNeural's own code is licensed under the terms in `LICENSE` at the repo root (if absent, see the project owner). The dependencies above retain their original licenses, and any redistributed binaries (such as whisper.cpp model files or `main.exe`) are governed by upstream terms.
