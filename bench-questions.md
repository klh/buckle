# bench-questions.md — what we ask of each class (buckle)

Executable source of truth is code (probes in `bin/onboard.ts --verify`,
gate benches in test/); this file pins the question/probe text so results
stay comparable. Sample-size law (beri.net, 2026-10-02): 33 questions →
±15pts, ~130 → ±7, ~530 → ±4; repeats kill model noise, not
question-sampling noise; below ~300 datapoints the normal approximation
underestimates. Suites labelled _smoke_ are exactly that.

## Wire pings (connectivity smoke)

One ping per wire, run by `bin/onboard.ts --verify`; a wire is "serving"
only when the answer is non-empty and the model id is the pinned one.

- **openai chat**: POST `<base>/chat/completions` — "Say READY", max_tokens 5, temperature 0 → expect 200 + non-empty content.
- **anthropic**: POST `<base>/v1/messages` — same body shape claude CLI sends; expect non-empty text block.
- **responses wire**: POST `<base>/responses` — codex-style input; expect non-empty output_text.
- **github_copilot via engine**: chat/completions with `model="github_copilot/<model>"` through :4100 → expect non-empty (W219.1 acceptance).

## Decision-model protocol (Jev / kev / hosted decision APIs)

Standing protocol from the beri.net full evaluation (2026-10-02):

1. Shadow eval on OUR labelled dispatch log before any production routing —
   decomposition plus fitted weights, not zero-shot alone.
2. Pin the version (`jev-1.13.0`, never `-latest`); re-run on any version bump.
3. Report calibration (ECE), not just accuracy; choice/score fields are
   overconfident out of distribution; every forced choice gets a
   "none of these" option.
4. Wrong criteria text scores below random (16.7% on a 4-way choice) — the
   question text is the program; diff it like code.
5. State is data, not treated as hostile — user-authored text inside the
   state (task hints) needs an injection check in front.
