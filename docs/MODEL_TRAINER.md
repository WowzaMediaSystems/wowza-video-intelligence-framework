# Training a VLM adapter from a Model Trainer export

The Model Trainer tab produces a labelled frame set: a zip with a `manifest.json` of image-level labels and
the judged frames. The `model-trainer` service turns that export into training pairs for a
vision-language model, trains a LoRA adapter on `Qwen/Qwen3-VL-2B-Instruct`, publishes it to the VIS
model manager and scores it against the base model. You drive it from the project's **Train** tab in
the Manager, or from the command line on a host without one. The service is behind the `model-trainer`
compose profile: nothing here starts with the stack, and it runs one job at a time.

The adapter learns your classes as the VLM's **Detect** mode answers them: the trained request is the
exact request VIS sends for a Detect stream, with your project's class names as the candidate list.
A stream that uses the adapter must therefore use those class names, Detect mode and no custom
prompts, `class_hints` or reasoning level. See [`VLM_GUIDE.md`](VLM_GUIDE.md) for Detect mode, the model manager and
LoRA adapters in general.

## Before you start

- **An export in VIS.** Export the project from the Model Trainer tab; VIS keeps the package at
  `./vis/model_trainer/projects/<project id>/export/package.zip`, which the service mounts read-only at
  `/model_trainer`.
- **The image.** It is built from the `model_trainer/` directory of the Video Intelligence Service
  source, with the repository root as the build context:
  `docker build -f model_trainer/Dockerfile -t wowza/wowza-video-intelligence-model-trainer .`
  Set `MODEL_TRAINER_IMAGE` in `.env` to use another tag.
- **A key.** The service authenticates callers the way VIS does: they send `VIS_API_KEY` as
  `X-API-Key`, and with `SECURE_MODE` unset or `true` the service refuses to start without a key. Only
  `SECURE_MODE=false` runs it keyless. It listens on the compose network (port 5002) and a job names a
  model to load, so keep the key set unless the host is internal-only. `VLLM_API_KEY` is passed through
  for the evaluation.
- **A free GPU for training.** Training takes the free memory of the card, and the managed VLM engines
  hold most of it. Free it through the Model Manager's active set (Stream Config Defaults -> VLM): remove
  the engine the Train form names, then add it back when the job ends. `pairs`, `publish` and `eval`
  need no GPU, and the idle service holds no GPU memory.
- **The base model as a custom model.** Adapters are trained on the bf16 `Qwen/Qwen3-VL-2B-Instruct`,
  not on the default FP8 model: LoRA on FP8 weights has not been shown to change the pinned vLLM's
  output. Add it as a [custom model](VLM_GUIDE.md#adding-your-own-model-an-overlay-entry-and-a-slot)
  with `enable_lora: true`, `lora_module_prefixes: ["model.language_model.layers."]` and
  `max_lora_rank: 16`, restart VIS so a slot takes it, and add it to the active models.
- **Weights.** The base downloads into `./vis/vlm-models` on first use. On an air-gapped host,
  pre-seed that directory and set `HF_HUB_OFFLINE=1`.

The service keeps its jobs under `./model_trainer` next to `docker-compose.yaml`, mounted at `/work`.
The container runs as root, so give the files back to yourself afterwards (`sudo chown -R "$USER" model_trainer`).

## Training from the Manager

1. **Start the service.** It is not part of `docker compose up`:

   ```bash
   docker compose --profile model-trainer up -d model-trainer
   ```

   A bare `docker compose down` leaves it running; stop it with
   `docker compose --profile model-trainer down`.
2. **Open the project's Train tab** (Model Trainer -> the project -> Train). If the service does not answer, or
   rejects the Engine's key, the tab says so, shows the URL it tried and the start command above.
3. **Read the form.** It shows the export it will train on (when it was made and its size; with none, a
   link to the Export tab, and Train stays disabled), the adapter name with the project's slug as
   prefix, the base (the LoRA-capable models of the catalog, the 2B preselected), the epochs, the rank,
   whether to publish, and whether to make the adapter the Default after publishing. A details section
   holds the other knobs. It also shows the GPU: free memory against what the base needs, and which
   engines hold the rest. When the card does not fit, Train is disabled and the line links to
   Stream Config Defaults -> VLM, where the Model Manager's active set is; when VLM streams share the card it says how many will slow down while training runs.
   Train is also disabled while another job runs, naming its project.
4. **Press Train.** The job card shows the stages (`pairs`, `train`, `publish`, `activate`, `eval`, with
   the reason of any that was skipped), the epoch and step, the evaluation loss per epoch and the
   tail of the log. The tab polls every few seconds; nothing is lost if you close it. **Cancel**
   stops a running job, and a cancelled publish removes the adapter it had already uploaded.
5. **When the job is done**, the card offers the steps in order. They are production changes and need
   an admin; readers see everything but the buttons.
   - **Reload base** when the card says it is pending: the first adapter of a base makes VIS restart
     that engine with LoRA support. It is disabled while any job is training.
   - **Make Default** serves the adapter. It asks for confirmation and names the current Default,
     because production moves to this base and adapter. Only one adapter serves at a time.
   - **Evaluate** scores the adapter against the base on the validation split. It is available once
     the adapter is the Default and ready, and shows accuracy per class, the confusion table and the
     logprob comparison (an adapter whose output equals the base's is not being applied).
   If a publish or an activation failed, the card shows the stage, the code and the message, and
   **Publish again** retries from that stage without training again.
6. **Delete** removes a finished job and its files.

Jobs are directories under `./model_trainer/jobs/<job id>/` (`job.json`, the log, the pairs and the
trained adapter). When a job ends, and when the service starts, finished jobs beyond the newest
`MODEL_TRAINER_MAX_JOBS` (default 10) or older than `MODEL_TRAINER_JOB_TTL_SECONDS` (default 30 days)
are removed, oldest first. The job that produced VIS's current Default adapter is kept. A job is
sized in gigabytes, so mind the disk. A job running when the service restarts becomes `failed`
(`service_restarted`); nothing resumes.

**Where the Engine looks.** Stream Config Defaults -> Model Trainer has one field, the training service URL,
default `http://model-trainer.docker:5002`: the compose service needs no change. It is a default-config
setting only; streams and stream groups cannot override it. The Engine sends its own service key as
`X-API-Key`.

**Two Engines on one VIS** share the jobs of a project, because project ids are VIS's: either Engine
sees a project's jobs and may cancel them. A job started from another Engine appears in the Train tab
labelled with that Engine's host name.

## From the command line

Hosts without a Manager run the same stages by hand, one command at a time. The commands use the same
image and the same `./model_trainer` directory as the service. `docker compose run` starts a separate
container, so do not run `train-lora` while a job of the service is training on the same card.

```bash
alias ht='docker compose --profile model-trainer run --rm model-trainer'

# 1. Pairs: no GPU. Whole sources go to validation until it holds at least 20 % of the frames;
#    a project with a single source keeps its last 20 % by time.
ht pairs --export /model_trainer/projects/<project id>/export/package.zip --out /work/pairs

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
