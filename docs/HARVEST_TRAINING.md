# Training a VLM adapter from a harvest export

The Harvest tab produces a labelled frame set: a zip with a `manifest.json` of image-level labels and
the judged frames. The `harvest-tools` container, run by hand, turns that export into training
pairs for a vision-language model, trains a LoRA adapter on `Qwen/Qwen3-VL-2B-Instruct`, publishes it
to the VIS model manager and scores it against the base model. Nothing here starts with the stack:
the service sits behind the `harvest-tools` compose profile and runs one command at a time.

The adapter learns your classes as the VLM's **Detect** mode answers them: the trained request is the
exact request VIS sends for a Detect stream, with your project's class names as the candidate list.
A stream that uses the adapter must therefore use those class names, Detect mode and no custom
prompts, `class_hints` or reasoning level. See [`VLM_GUIDE.md`](VLM_GUIDE.md) for Detect mode, the model manager and
LoRA adapters in general.

## Before you start

- **An export in VIS.** Export the project from the Harvest tab; VIS keeps the package at
  `./vis/harvest/projects/<project id>/export/package.zip`, which the service mounts read-only at
  `/harvest`.
- **The image.** It is built from the `harvest-tools/` directory of the Video Intelligence Service
  source, with the repository root as the build context:
  `docker build -f harvest-tools/Dockerfile -t wowza/wowza-video-intelligence-harvest-tools .`
  Set `HARVEST_TOOLS_IMAGE` in `.env` to use another tag.
- **A free GPU for training.** The service reserves every GPU. The managed VLM engines hold most of
  the card they run on, so stop them while `train-lora` runs. `pairs`,
  `publish` and `eval` need no GPU.
- **The base model as a custom model.** Adapters are trained on the bf16 `Qwen/Qwen3-VL-2B-Instruct`,
  not on the default FP8 model: LoRA on FP8 weights has not been shown to change the pinned vLLM's
  output. Add it as a [custom model](VLM_GUIDE.md#adding-your-own-model-an-overlay-entry-and-a-slot)
  with `enable_lora: true`, `lora_module_prefixes: ["model.language_model.layers."]` and
  `max_lora_rank: 16`, restart VIS so a slot takes it, and add it to the active models.
- **Weights.** The base downloads into `./vis/vlm-models` on first use. On an air-gapped host,
  pre-seed that directory and set `HF_HUB_OFFLINE=1`.

The working directory is `./harvest-tools` next to `docker-compose.yaml`, mounted at `/work`. The
container runs as root, so give the files back to yourself afterwards (`sudo chown -R "$USER" harvest-tools`).

## The flow

```bash
alias ht='docker compose --profile harvest-tools run --rm harvest-tools'

# 1. Pairs: no GPU. Whole sources go to validation until it holds at least 20 % of the frames;
#    a project with a single source keeps its last 20 % by time.
ht pairs --export /harvest/projects/<project id>/export/package.zip --out /work/pairs

# 2. Train: a few hundred samples over three epochs take minutes on a data-centre GPU. Per-epoch adapters,
#    the final adapter and adapter.zip land in /work/train.
ht train-lora --pairs /work/pairs --out /work/train

# 3. Publish: uploads the adapter and declares it in the overlay. Re-running with the same id needs
#    --version-from-catalog, which picks the next -vN: ids are never replaced. The id takes
#    letters, digits, `.`, `_` and `-` per segment: use a slug, not a project name with spaces.
ht publish --adapter /work/train/adapter.zip --vis-url http://video-intelligence-service.docker:5001 \
   --id <project slug>/wear --version-from-catalog
```

`publish` prints what applied and whether the base model is *reload pending*. The first adapter of a
base makes it so, because an engine starts with LoRA support only when the catalog declares an
adapter for it. Run the `POST /vlm/models/<base>/reload` it prints (with your `X-API-Key`), or use
**Reload now** in the Manager, once. Then make the adapter the Default, either under **Stream
Config Defaults → VLM** or with the id `publish` printed (it is the `-vN` one when
`--version-from-catalog` renamed it):

```bash
ht publish --vis-url http://video-intelligence-service.docker:5001 --id <project slug>/wear --activate-only
```

`--activate-only` uploads nothing and writes no overlay: it activates the published adapter and waits
for the result. `publish --activate` does both in one run, but only once the base already serves
LoRA: while the base is reload pending it prints a notice and skips the activation. Only one
adapter serves at a time, as the Default.

```bash
# 4. Evaluate on the validation split, adapter against base.
ht eval --pairs /work/pairs --endpoint http://video-intelligence-service.docker:5001/v1 \
   --model <project slug>/wear --baseline Qwen/Qwen3-VL-2B-Instruct
```

`eval` prints per-class accuracy and a confusion table for both models, and a logprob comparison on
the same request: an adapter whose output is identical to the base's is not being applied. It writes
`eval.json` next to the pairs. `VIS_API_KEY` and `VLLM_API_KEY` are passed through from `.env`; the
managed `/v1` endpoint takes `VLLM_API_KEY` as its bearer.

## Reading the results

- A validation split made of whole source videos measures generalization to footage the adapter has
  not seen. A single source is split by time, which measures only later parts of the same video, so
  a perfect score there says little about other scenes or lighting.
- The negatives are frames a reviewer rejected, close to the decision boundary, capped at the
  number of positives per group. The adapter has not seen random background.
- Retrain whenever the classes change. After a VIS upgrade that changes the Detect prompts,
  re-run `pairs` and `train-lora`: `dataset.json` and `manifest.json` record a digest of the prompts
  an adapter was trained on.
