# Model Trainer service

The Model Trainer turns example images and footage into a labelled frame set, the frame set into
boxes and a versioned dataset, and the dataset into a trained model: an RF-DETR object detector, or
a LoRA adapter for the vision-language model. It is one `model-trainer` service with one HTTP API,
one API key of its own and one volume, and it runs in two modes.

| | With Video Intelligence Framework | Standalone |
|---|---|---|
| Compose file | `docker-compose.yaml` (the service starts with the stack) | `docker-compose.standalone.yaml` (the service alone) |
| Input | A file from the On-Demand library, or a window of a running stream | A video file you upload |
| Pages | The **Model Trainer** tab of the Manager | The same pages, served by the service at `http://<host>:8090` |
| Sign-in | The Manager's | `MODEL_TRAINER_API_KEY`, once per browser session |
| Video Intelligence Service | Required (it scores frames and proxies the API) | Optional: needed only to publish trained models and for the VLM grounding backend |
| Live streams | Yes | No: video files only |

Both modes share the same image, the same project store layout, the same pages and the same
stages: project, classes and examples, run, review, export, boxes, dataset version, training,
publish.

## Before you start

- **The image.** It is built from the `model_trainer/` directory of the Video Intelligence Service
  source, with the repository root as the build context:
  `docker build -f model_trainer/Dockerfile -t wowza/wowza-video-intelligence-model-trainer .`
  Set `MODEL_TRAINER_IMAGE` to use another tag.
- **A key.** `MODEL_TRAINER_API_KEY` is the service's own key, never the Video Intelligence
  Service's. Callers send it as `X-API-Key`. With `SECURE_MODE` unset or `true` the service refuses
  to start without one; only `SECURE_MODE=false` runs it keyless, which suits an internal-only host. The main
  `docker-compose.yaml` refuses to run while `MODEL_TRAINER_API_KEY` is empty, so a keyless host
  sets it to a placeholder as well. Use a long random value.
- **A GPU.** Decoding a video needs none. The encoders, the box backends and training use the card
  when there is one; the idle service holds no GPU memory, and the encoders unload after a minute
  of idleness. The main `docker-compose.yaml` reserves the card for the service; the standalone
  compose runs on the CPU unless `docker-compose.standalone.gpu.yaml` is added (see [Standalone](#standalone)).
- **Disk.** Projects, kept frames, dataset versions, checkpoints and training jobs live under
  `./model_trainer` next to the compose file, which can reach tens of gigabytes. The container runs
  as root, so give the files back to yourself afterwards (`sudo chown -R "$USER" model_trainer`).
  Back up `./model_trainer` to keep your projects.

## With Video Intelligence Framework

### How the pieces fit

```
Manager UI -> Engine --frames (WebSocket)--> VIS --HTTP--> model-trainer service
                |                              |                (GPU, one volume)
                +------- REST relays ----------+ proxy
```

- **The service** owns everything the Model Trainer keeps: projects, example images, encoders and
  banks, runs, scoring and frame selection, the kept frames, review marks, labels, the export
  package, boxes, dataset versions and the embedding cache, plus the training jobs. It has one HTTP
  API and one API key of its own (`MODEL_TRAINER_API_KEY`).
- **The Engine** owns the run lifecycle: it opens a run when a VOD job or a live window starts,
  feeds frames to VIS as it always has, and closes the run when the job or window ends. It keeps no
  Model Trainer files; the Manager's pages reach the service through the Engine's REST routes, which
  relay to VIS.
- **VIS** forwards each frame batch to the service for scoring and answers the Engine with the
  same scores as before. It proxies `/model_trainer` and `/training` to the service, and requires
  its own API key on them even when VIS itself runs without one. A trained detector is published
  into VIS's `models/` directory through `POST /models/import` (see
  [`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md#configuration-reference)).

It is one deployment: the Engine, VIS and the service are upgraded together. The service is not
optional; without it no Model Trainer run can start.

### Using it

1. Set `MODEL_TRAINER_API_KEY` in `.env` and start the stack. The service starts with it
   (`docker compose ps model-trainer`).
2. Open the **Model Trainer** tab of the Manager pages. A project takes example images per class and
   an encoder (CLIP for classes that are different kinds of shot, DINOv2 for a detail or a state
   within the same framing).
3. Score a file from the On-Demand library, or a window of up to 4 hours on a running stream, against
   the project, and confirm or reject the frames it queues. A live window replaces the stream's
   detector while it lasts and returns the stream to its stored configuration when it ends.
4. Export the confirmed frames, then continue with
   [Boxes and dataset versions](#boxes-and-dataset-versions) and the training sections below.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MODEL_TRAINER_API_KEY` | none | The service's key. Required: `docker compose` refuses to run without it. VIS gets the same value and sends it as `X-API-Key`; the Engine and the Manager never see it |
| `MODEL_TRAINER_IMAGE` | `wowza/wowza-video-intelligence-model-trainer:latest` | Image tag |
| `MODEL_TRAINER_MAX_UPLOAD_MB` | `512` | Cap per upload body: an example image or a judged frame during a bank rebuild |
| `MODEL_TRAINER_MAX_JOBS`, `MODEL_TRAINER_JOB_TTL_SECONDS` | `10`, `2592000` | Retention of finished training jobs |
| `MODEL_TRAINER_DATASET_KEEP` | `5` | Dataset versions kept per project |
| `MODEL_TRAINER_MAX_IMPORT_MB` | `256` | Largest COCO or CVAT file the review step imports |
| `MODEL_TRAINER_VLM_URL` | VIS's managed `/v1` | Endpoint of the VLM grounding backend |
| `MODEL_TRAINER_VRAM_MIB_<BASE>` | see [Troubleshooting](#troubleshooting) | Free GPU memory a training job demands |
| `MODEL_TRAINER_MAX_CHECKPOINT_MB` (on VIS) | `2048` | Largest detector checkpoint VIS accepts from the service |

The VIS side of the connection (`MODEL_TRAINER_URL` and friends) is in
[`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md#configuration-reference). The compose file mounts
`./model_trainer` at `/model_trainer` (the project store in `projects/`, training jobs in `jobs/`)
and `./model_trainer/models` at `/models`, where the service downloads and verifies its checkpoints (`ViT-B-16.pt` for CLIP and
`dinov2-base.safetensors` for DINOv2; the RF-DETR bases are fetched the same way when training one).

**Two Engines on one VIS** share the projects, runs and jobs of the service: either Engine sees a
project's jobs and may cancel them. A run or job started from another Engine appears in the Manager
labelled with that Engine's host name. Run one VIS and one service per Engine when that matters.

### Timeouts

Each hop waits at least as long as the one behind it, so the inner timeout reports first.

| Hop | Connect | Read |
|---|---|---|
| Engine to VIS relay (projects, items, marks) | 5 s | 30 s |
| Engine to VIS relay (operations: the Engine receives `202` and polls) | 5 s | 30 s |
| VIS proxy to the service | 5 s | 600 s |
| VIS scoring call to the service | 5 s | 30 s |

A scoring call is kept below the Engine's 120 s response timeout for a frame batch. Long work (an
export, a bank rebuild, a box job, a training job) is an operation or a job: the request answers
`202` and the Manager polls it, so no single request waits for the work. Uploads and downloads
stream through the proxy; the service caps their size.

## Standalone

The service runs on its own, without Wowza Streaming Engine, the Engine, VIS or the Manager. It
decodes the video files you upload, serves the Manager's Model Trainer pages itself and exposes the
same API. **Video files only:** there are no live streams, no stream windows and no On-Demand
library.

### Start it

```bash
cp .env.standalone.example .env.standalone
# edit .env.standalone: set MODEL_TRAINER_API_KEY to a long random value
docker compose -f docker-compose.standalone.yaml --env-file .env.standalone up -d
```

That runs on a host without a GPU: the encoders run on the CPU and the box backends and training are
unavailable. On a host with the NVIDIA container runtime, add the GPU file to give the service the card;
the box backends and training need it:

```bash
docker compose -f docker-compose.standalone.yaml -f docker-compose.standalone.gpu.yaml \
  --env-file .env.standalone up -d
```

The page is at `http://<host>:8090`. Sign in with `MODEL_TRAINER_API_KEY`: the service exchanges it
for a short browser session (`MODEL_TRAINER_SESSION_TTL_SECONDS`, 8 hours by default) so the key
itself never sits in the browser. Changing the key ends every session. Everything is kept under
`./model_trainer` next to the compose file.

| Variable | Default | Purpose |
|---|---|---|
| `MODEL_TRAINER_API_KEY` | none | Required: sign-in secret and `X-API-Key` of the API |
| `MODEL_TRAINER_PORT` | `8090` | Host port of the page and the API |
| `VIS_URL`, `VIS_API_KEY`, `VLLM_API_KEY` | empty | Optional Video Intelligence Service; see below |
| `MODEL_TRAINER_MAX_VIDEO_MB` | `4096` | Largest uploaded video |
| `MODEL_TRAINER_SESSION_TTL_SECONDS` | `28800` | Life of the browser session |
| `MODEL_TRAINER_DATASET_KEEP` | `5` | Dataset versions kept per project |
| `MODEL_TRAINER_MAX_IMPORT_MB` | `256` | Largest COCO or CVAT file imported |
| `MODEL_TRAINER_MAX_UPLOAD_MB` | `512` | Largest example image |
| `MODEL_TRAINER_MAX_JOBS`, `MODEL_TRAINER_JOB_TTL_SECONDS` | `10`, `2592000` | Retention of finished training jobs |
| `MODEL_TRAINER_VRAM_MIB_<BASE>` | see [Troubleshooting](#troubleshooting) | Free GPU memory a training job demands |
| `HF_HUB_OFFLINE` | unset | Set `1` on an air-gapped host after pre-seeding the volumes |

**Without `VIS_URL`** everything works except two things: a trained model cannot be published
(the job's publish stage is skipped with the reason `no_vis`, and the trained file stays in the
project for you to copy by hand), and the VLM grounding backend of the boxes step is off. Set
`VIS_URL` to a reachable Video Intelligence Service, with `VIS_API_KEY` if it requires one, to turn
them on; the same service also needs `MODEL_TRAINER_API_KEY` set to this service's key (see
[`VIS_DEPLOYMENT.md`](VIS_DEPLOYMENT.md#configuration-reference)) so it accepts the published
models.

### From a video to a dataset

1. **Create a project.** Name it and pick the encoder (CLIP or DINOv2). Add a group for each kind
   of thing you want to find and the classes in it, with at least two example images each. Rebuild
   the bank so the examples take effect.
2. **Upload a video.** In the Run view, use the upload control of the source picker. The file is
   streamed to the project, identified by its content (the same file twice is one source) and
   checked by `ffprobe`; anything that is not video is refused.
3. **Run.** Choose the analysis rate (frames per second), the decode height and the selection
   settings, and start. The service decodes the file, scores every frame against the bank and keeps
   the closest ones per minute. You can cancel; a failed or paused run (for instance after a
   restart) resumes where it stopped.
4. **Review.** Confirm or reject the queued frames. Confirmed frames can be added back into the bank
   with a rebuild, which sharpens the next run.
5. **Export.** The package is a zip with a `manifest.json` of image-level labels per group (the
   positives and a `<group>_none` negative for each judged frame) and the judged frames themselves.
6. Continue with [Boxes and dataset versions](#boxes-and-dataset-versions).

The pages are the Manager's own, served over the service's copy of the Manager's REST surface, so
every screen behaves as described for the Manager above. The tabs that belong to a running stack
(live streams, stream configuration) are not there.

### TLS in front

The service speaks plain HTTP. Before the key or the session cookie crosses a network you do not
control, put a reverse proxy that terminates TLS in front of it and publish only the proxy. The
proxy must forward `X-Forwarded-Proto: https` (the session cookie is then marked `Secure`), must not
buffer request bodies, and must allow request bodies above `MODEL_TRAINER_MAX_VIDEO_MB`. With nginx:

```nginx
server {
    listen 443 ssl;
    server_name trainer.example.com;
    ssl_certificate     /etc/ssl/trainer.crt;
    ssl_certificate_key /etc/ssl/trainer.key;

    client_max_body_size 5g;          # above MODEL_TRAINER_MAX_VIDEO_MB
    proxy_request_buffering off;      # stream uploads straight to the service
    proxy_read_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

When the proxy is on the same host, change the compose `ports` entry to `127.0.0.1:8090:5002` so
the plain port is not reachable from outside.

## Boxes and dataset versions

A detector needs bounding boxes, and the exported frame set has none. The **Boxes** step proposes
boxes on the frames you kept, you review them, and the reviewed boxes become a numbered dataset
version that trains a detector. It is a sub-tab of a project in both modes.

### Getting boxes

Three automatic backends, plus a manual round trip. They are proposals: nothing reaches a dataset
until you accept it.

| Backend | How it finds objects | Choose it when | Watch out for |
|---|---|---|---|
| **Grounding DINO** | Reads a text description: the group's noun | The object is easy to name ("horse", "helmet") and there are many frames; no extra setup, fastest to try | It finds what the word means in general: unusual or domain-specific things can be missed or confused, and it can invent boxes on empty frames. Default threshold 0.35 |
| **OWLv2** | Looks for things that resemble one example: the tight crop of the class's example image | The object is hard to describe in words but you have a clean example; works per class | Only as good as the example crop (a loose or unrepresentative crop gives loose or missed boxes). Default threshold 0.2 |
| **VLM grounding** | Asks the vision-language model served by a Video Intelligence Service to point at the objects | You want the model's understanding of the scene, or the others disagree | Needs `VIS_URL` and a VLM engine; slowest; positives only, ordered by how often the model agrees with itself. Small objects in big frames need tiles |

All three run over **tiles** when the frames are large: a frame is cut into overlapping pieces
near the model's working resolution, each piece is searched, and the boxes are mapped back and
merged across the borders. Use tiles for small objects in high-resolution frames; leave them off
otherwise, since each tile costs a model call.

The first use of a backend downloads its weights into the models volume, verified against a pinned
checksum.

**Manual round trip.** Export a CVAT task (a zip of the frames and their annotation file) from the
Boxes tab, correct or draw the boxes in CVAT, and import the result: either the raw COCO JSON or
the CVAT zip. Imported boxes are matched to the project's frames by source and frame number, then
by file name; a file with boxes that match no frame is refused whole with the list of the
offenders, so nothing is silently dropped. Manual boxes are the ground truth to compare an
automatic backend against.

### Reviewing

The queue shows each frame with its boxes drawn on it and the backend that proposed them. **Accept**
or **reject** per frame. Only reviewed boxes enter a dataset.

### Dataset versions

**Create a version** from the reviewed boxes. The service splits the frames into train, validation
and test by source video (a video is never on both sides of a split, so the test numbers measure
footage the model has not seen) and writes a COCO dataset with a manifest. Versions are numbered
and immutable; the newest `MODEL_TRAINER_DATASET_KEEP` per project are kept (5 by default) and
older ones are deleted when a new one is made. Download a version as a zip to train elsewhere.

## Training a detector

The RF-DETR lane fine-tunes a detector on a dataset version and publishes it into a Video
Intelligence Service. It is the project's **Train** tab with the lane set to **Detector**; a job is
one dataset version and one variant.

1. **Choose the dataset version and the variant** (`nano`, `small`, `medium` or `large`: larger is
   more accurate and slower). Epochs and the training resolution have per-variant defaults. Training takes the free memory of the card, and the job refuses to
   start (`gpu_busy`) when the card holds less than the variant needs; one job runs at a time.
2. **Train.** The job runs the stages `prepare`, `train`, `check`, `eval` and `publish`, with the
   epoch, the loss and a log tail on the card, and **Cancel** to stop it. `prepare` downloads the
   pretrained base for the variant (verified by checksum) and names the output
   `<project>-<variant>-v<N>.pth`, `N` rising with each model of that variant.
3. **Checks.** The trained file is rewritten into the layout VIS loads and verified before it is
   kept: its metadata, variant, pretrained-weights reference, class names (they must equal the
   project's classes, in order), class count, resolution and the alignment of the class rows. A
   model that fails a check is not kept and the card lists which checks failed.
4. **Evaluation.** The model is scored on the test split: precision and recall at IoU 0.5 per class
   and per object size, plus recall at IoU 0.25 for the smallest objects. A class passes when its
   recall at 0.5 on the smallest size bucket reaches `min_recall` (0.5 by default; `min_precision`
   defaults to 0). A model that does not pass is kept, the job still finishes, and the card says
   why. It is not published unless you publish it explicitly.
5. **Publish.** An evaluated model is sent to VIS (`POST /models/import`) and appears in the
   Manager's model picker without a restart, under its file name. VIS runs its own checks on the
   upload; its refusal ends the stage with the list of failed checks. A model with the same name is
   never replaced unless you ask for it, and a model a stream is using is never replaced while that
   stream runs. **Publish again** retries a failed publish without training again. Publishing
   needs a reachable VIS (`VIS_URL`, standalone) and the matching keys.

**Tiling.** The result carries the tiling settings to put in the stream's configuration. The
recommendation cuts the dataset's typical frame into tiles about the training resolution: a frame
close to that size needs no tiling, a larger one gets a fixed grid. Copy the shown `tiling_mode`
and the seven `tiling_properties` into the stream's detector settings (the Manager's form takes the
same values); a detector trained on tiles and run on whole frames sees the objects at the wrong
scale and misses them.

## Training a VLM adapter

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

### Before you train an adapter

- **An export.** Export the project from the Model Trainer tab; the service keeps the package at
  `./model_trainer/projects/<project id>/export/package.zip`.
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

### Training from the Manager

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

### From the command line

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

### Reading the results

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
VIS's volume (`./vis/model_trainer`) and the judgements, confirmed frames and runs on the Engine's
(`./wse/model_trainer`). The service keeps all of it in its own volume (`./model_trainer`), so an
existing deployment moves its projects once, as part of the same upgrade that brings the Engine,
VIS and the service up together. Stop the Engine's runs first: both steps assume nothing is writing.
Keep the old volumes until you have checked the result; they are the only copy of the judgements.

1. **Move VIS's project store** (`project.json`, `bank/`, `examples/`, `export/`) as a directory
   into the service's projects directory. The embedding caches stay where they are and are rebuilt
   on demand:

   ```bash
   mkdir -p model_trainer/projects
   mv ./vis/model_trainer/projects/<project-id> ./model_trainer/projects/<project-id>
   ```

   A project may instead be created in the service by hand; the import refuses a project the
   service does not hold.

2. **Import the Engine's runs and judgements** into it, with the service's own command, run from the
   compose directory with the Engine's directory mounted read-only:

   ```bash
   docker compose run --rm -v "$PWD/wse/model_trainer:/engine-store:ro" model-trainer \
       import-engine-store /engine-store --project <project-id> --owner <engine hostname> [--dry-run]
   ```

   Each Engine run (`run.json`, `items.jsonl`, `scores.csv`, `frames/`, `thumbs/`) becomes a
   `finished` run owned by `--owner`, with its run id, kind, source, stream, split key, parameters,
   counters and timestamps kept; the Engine's `labels.json` rows and `confirmed/` frames are merged
   in. The import is idempotent by run id and by `(source, frame id)`: a run or judged frame the
   service already holds is left as it is, so a second import reports zero. `--dry-run` reports
   what would change and writes nothing. A refusal (a missing project, an unreadable `run.json`,
   `items.jsonl` or `labels.json`) prints `error: ...`, writes nothing and exits 1.

Repeat both steps for each project. Starting a standalone service from an existing project
directory needs only step 1 and no import.

## Troubleshooting

| Symptom | Cause and action |
|---|---|
| The Train tab or the Model Trainer tab says the service does not answer (with VIF) | VIS cannot reach it. `docker compose ps model-trainer` and `docker compose logs model-trainer`; check `MODEL_TRAINER_URL` on VIS and that `MODEL_TRAINER_API_KEY` is the same on both. A rejected key is reported separately from an unreachable service |
| The service exits at start saying `MODEL_TRAINER_API_KEY is not set` | Set it in `.env` (or `.env.standalone`), or `SECURE_MODE=false` on an internal-only host |
| The standalone page asks to sign in again | The session ended (`MODEL_TRAINER_SESSION_TTL_SECONDS`), or the key was changed. Sign in with the current key |
| An upload is refused with 413 | The video exceeds `MODEL_TRAINER_MAX_VIDEO_MB`, or a proxy in front caps the body (`client_max_body_size` in nginx) |
| An upload is refused with 507 | Not enough free disk under `./model_trainer` |
| A video is refused as unreadable | `ffprobe` found no video stream. Re-encode it to a common format such as H.264 MP4 and upload again |
| A training job fails `gpu_busy` | The card does not have the memory the job needs. With VIF, free it through the Model Manager's active set (the form names the engine); standalone, stop whatever else uses the card. A card that really has enough but reports less can be told so with `MODEL_TRAINER_VRAM_MIB_<BASE>`, in MiB, for example `MODEL_TRAINER_VRAM_MIB_QWEN_QWEN3_VL_2B_INSTRUCT` (default 16000; 24000 for any other base) or `MODEL_TRAINER_VRAM_MIB_RFDETR_MEDIUM` (defaults: nano 6000, small 8000, medium 11000, large 16000) |
| A job fails `service_restarted` | The service restarted while it ran; nothing resumes. Start it again |
| A box job or a VLM grounding run fails | The VLM backend needs `VIS_URL` and a VLM engine that answers. Check `MODEL_TRAINER_VLM_URL` and `VLLM_API_KEY` |
| An imported COCO or CVAT file is refused | The refusal lists the boxes that match no frame, or the file exceeds `MODEL_TRAINER_MAX_IMPORT_MB` |
| Publish is refused by VIS with a list of checks (`vis_checks_failed`) | VIS re-checked the file and the list names each failed check: for example the class names differ from the project's, or the variant in the file name does not match the file. Retrain from a dataset version whose classes are the ones you mean, and keep the generated file name |
| Publish fails `vis_rejected_key` | VIS does not accept the key. Set `MODEL_TRAINER_API_KEY` on VIS to this service's key, or give the service `VIS_API_KEY` |
| Publish fails `vis_model_conflict` | A model with that name exists, or a stream is running it. Stop the stream, or publish with replace |
| Publish fails `vis_model_too_large` | The file exceeds `MODEL_TRAINER_MAX_CHECKPOINT_MB` on VIS |
| Publish is skipped with `no_vis` | The service has no `VIS_URL`. Set it, or copy the file from `./model_trainer/projects/<project id>/detector/` into your VIS's `models/` directory and restart that VIS |
| The Train tab cannot publish an adapter | See [Training a VLM adapter](#training-a-vlm-adapter): it needs a reachable VIS with the managed VLM engines |
