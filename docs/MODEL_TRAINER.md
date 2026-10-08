# Model Trainer service

The Model Trainer turns example images and footage into a labelled frame set, and the labelled
frame set into a VLM adapter. It is one resident `model-trainer` service in the compose stack,
started with the rest of it.

## How the pieces fit

```
Manager UI -> Engine --frames (WebSocket)--> VIS --HTTP--> model-trainer service
                |                              |                (GPU, one volume)
                +------- REST relays ----------+ proxy
```

- **The service** owns everything the Model Trainer keeps: projects, example images, encoders and
  banks, runs, scoring and frame selection, the kept frames, review marks, labels, the export
  package and the embedding cache, plus the training jobs. It has one HTTP API and one API key of
  its own (`MODEL_TRAINER_API_KEY`).
- **The Engine** owns the run lifecycle: it opens a run when a VOD job or a live window starts,
  feeds frames to VIS as it always has, and closes the run when the job or window ends. It keeps no
  Model Trainer files; the Manager's pages reach the service through the Engine's REST routes, which
  relay to VIS.
- **VIS** forwards each frame batch to the service for scoring and answers the Engine with the
  same scores as before. It proxies `/model_trainer` and `/training` to the service, and requires
  its own API key on them even when VIS itself runs without one.

It is one deployment: the Engine, VIS and the service are upgraded together. The service is not
optional; without it no Model Trainer run can start.

## Timeouts

Each hop waits at least as long as the one behind it, so the inner timeout reports first.

| Hop | Connect | Read |
|---|---|---|
| Engine to VIS relay (projects, items, marks) | 5 s | 30 s |
| Engine to VIS relay (operations: the Engine receives `202` and polls) | 5 s | 30 s |
| VIS proxy to the service | 5 s | 600 s |
| VIS scoring call to the service | 5 s | 30 s |

A scoring call is kept below the Engine's 120 s response timeout for a frame batch. Long work (an
export, a bank rebuild) is an operation: the request answers `202` and the Manager polls it, so
no single request waits for the work. Uploads and downloads stream through the proxy; the service
caps their size with `MODEL_TRAINER_MAX_UPLOAD_MB`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MODEL_TRAINER_API_KEY` | none | The service's key. Required: with `SECURE_MODE` unset or `true` the service refuses to start without one. VIS gets the same value and sends it as `X-API-Key`; the Engine and the Manager never see it |
| `MODEL_TRAINER_IMAGE` | `wowza/wowza-video-intelligence-model-trainer:latest` | Image tag; see [Before you start](#before-you-start) |
| `MODEL_TRAINER_MAX_UPLOAD_MB` | `512` | Cap per upload body: an example image, a judged frame during a bank rebuild or a video source |
| `MODEL_TRAINER_MAX_JOBS`, `MODEL_TRAINER_JOB_TTL_SECONDS` | `10`, `2592000` | Retention of finished training jobs |

The VIS side of the connection (`MODEL_TRAINER_URL` and friends) is in
[`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md#configuration-reference). The compose file mounts
`./model_trainer` at `/model_trainer` (the project store in `projects/`, training jobs in `jobs/`)
and `./model_trainer/models` at `/models`, where the service downloads and verifies its encoder
checkpoints. Back up `./model_trainer` to keep your projects.

## Training a VLM adapter from a Model Trainer export

The Model Trainer tab produces a labelled frame set: a zip with a `manifest.json` of image-level labels and
the judged frames. The service turns that export into training pairs for a
vision-language model, trains a LoRA adapter on `Qwen/Qwen3-VL-2B-Instruct`, publishes it to the VIS
model manager and scores it against the base model. You drive it from the project's **Train** tab in
the Manager, or from the command line on a host without one. Training runs one job at a time.

The adapter learns your classes as the VLM's **Detect** mode answers them: the trained request is the
exact request VIS sends for a Detect stream, with your project's class names as the candidate list.
A stream that uses the adapter must therefore use those class names, Detect mode and no custom
prompts, `class_hints` or reasoning level. See [`VLM_GUIDE.md`](VLM_GUIDE.md) for Detect mode, the model manager and
LoRA adapters in general.

## Before you start

- **An export.** Export the project from the Model Trainer tab; the service keeps the package at
  `./model_trainer/projects/<project id>/export/package.zip`.
- **The image.** It is built from the `model_trainer/` directory of the Video Intelligence Service
  source, with the repository root as the build context:
  `docker build -f model_trainer/Dockerfile -t wowza/wowza-video-intelligence-model-trainer .`
  Set `MODEL_TRAINER_IMAGE` in `.env` to use another tag.
- **A key.** Set `MODEL_TRAINER_API_KEY` in `.env`. Callers send it as `X-API-Key`, and with
  `SECURE_MODE` unset or `true` the service refuses to start without one. Only `SECURE_MODE=false`
  runs it keyless. It listens on the compose network (port 5002) and a job names a model to load,
  so keep the key set unless the host is internal-only. The service also calls VIS with
  `VIS_API_KEY` to publish adapters, and `VLLM_API_KEY` is passed through for the evaluation.
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

The service keeps its jobs under `./model_trainer/jobs` next to `docker-compose.yaml`, mounted at
`/model_trainer/jobs`. The container runs as root, so give the files back to yourself afterwards
(`sudo chown -R "$USER" model_trainer`).

## Training from the Manager

1. **Check the service is up.** It starts with the stack (`docker compose ps model-trainer`).
2. **Open the project's Train tab** (Model Trainer -> the project -> Train). If the service does not answer, or
   rejects the key, the tab says so and points at the service's logs.
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

**Where the Engine looks.** Nowhere: the Engine has no setting for the service. Its Train tab calls
VIS's `/training` proxy with the VIS key, and VIS adds the service's key. When VIS cannot reach the
service, the tab says so.

**Two Engines on one VIS** share the projects, runs and jobs of the service: either Engine
sees a project's jobs and may cancel them. A run or job started from another Engine appears in the
Manager labelled with that Engine's host name. Run one VIS and one service per Engine when that matters.

## From the command line

Hosts without a Manager run the same stages by hand, one command at a time. The commands use the same
image and the same `./model_trainer` directory as the service. `docker compose run` starts a separate
container, so do not run `train-lora` while a job of the service is training on the same card.

```bash
alias mt='docker compose run --rm model-trainer'

# 1. Pairs: no GPU. Whole sources go to validation until it holds at least 20 % of the frames;
#    a project with a single source keeps its last 20 % by time.
mt pairs --export /model_trainer/projects/<project id>/export/package.zip --out /model_trainer/jobs/cli/pairs

# 2. Train: a few hundred samples over three epochs take minutes on a data-centre GPU. Per-epoch adapters,
#    the final adapter and adapter.zip land in /model_trainer/jobs/cli/train.
mt train-lora --pairs /model_trainer/jobs/cli/pairs --out /model_trainer/jobs/cli/train

# 3. Publish: uploads the adapter and declares it in the overlay. Re-running with the same id needs
#    --version-from-catalog, which picks the next -vN: ids are never replaced. The id takes
#    letters, digits, `.`, `_` and `-` per segment: use a slug, not a project name with spaces.
mt publish --adapter /model_trainer/jobs/cli/train/adapter.zip --vis-url http://video-intelligence-service.docker:5001 \
   --id <project slug>/wear --version-from-catalog
```

`publish` prints what applied and whether the base model is *reload pending*. The first adapter of a
base makes it so, because an engine starts with LoRA support only when the catalog declares an
adapter for it. Run the `POST /vlm/models/<base>/reload` it prints (with your `X-API-Key`), or use
**Reload now** in the Manager, once. Then make the adapter the Default, either under **Stream
Config Defaults → VLM** or with the id `publish` printed (it is the `-vN` one when
`--version-from-catalog` renamed it):

```bash
mt publish --vis-url http://video-intelligence-service.docker:5001 --id <project slug>/wear --activate-only
```

`--activate-only` uploads nothing and writes no overlay: it activates the published adapter and waits
for the result. `publish --activate` does both in one run, but only once the base already serves
LoRA: while the base is reload pending it prints a notice and skips the activation. Only one
adapter serves at a time, as the Default.

```bash
# 4. Evaluate on the validation split, adapter against base.
mt eval --pairs /model_trainer/jobs/cli/pairs --endpoint http://video-intelligence-service.docker:5001/v1 \
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

## Migrating from a previous deployment

Earlier releases split a project's data across two volumes: the examples, banks and exports on
VIS's volume (`./vis/model_trainer`) and the judgements, confirmed frames and runs on the
Engine's (`./wse/model_trainer`). The service keeps all of it in its own volume, so an
existing deployment moves its projects once, as part of the same upgrade that brings the Engine,
VIS and the service up together.

The `model-trainer import-engine-store` command, which arrives with the migration release, does
the move:

```bash
model-trainer import-engine-store <engine model_trainer dir> --project <id> --owner <engine>
```

For each run in the Engine's store it imports `run.json` (the run becomes `finished`, owned by
the importing Engine), `items.jsonl`, `scores.csv`, `frames/` and `thumbs/`, and the project's
`labels.json` and `confirmed/`. It is idempotent by run id and by `(source, frame id)`, so a
partial import can be repeated. Move VIS's project store as a directory into
`./model_trainer/projects`; the embedding caches stay valid. Until the command ships, keep the old
volumes untouched: they are the only copy of the judgements.

## Standalone mode (coming)

A later release runs the service on its own, without the Engine or VIS, on uploaded video files.
It will have its own compose file and guide.
