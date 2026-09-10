# Web Credential Exposure Crawler (Paper Artifact)

This repository contains the crawler used in the paper [*Keys on Doormats: Exposed API Credentials on the Web*](https://arxiv.org/abs/2603.12498). It crawls websites with Puppeteer in Docker, stores request/response data in SQLite, and exports results to JSON.

## What it does

- Reads target websites from `leaky-sites.csv` (`page` column).
- Splits websites across multiple Docker containers (`run_parallel_crawlers.sh`).
- Visits each site in a headed Chrome session.
- Captures request and response metadata/content.
- Stores data per site in SQLite files under `output/<date>/DB/`.
- Logs crawl failures under `output/<date>/logs/`.
- Retries failed or missing sites with `rerun_failures.sh`.
- Converts DB files to JSON with `db_to_json.js`.

## Project files

- `crawler.js`: main crawler process.
- `run_parallel_crawlers.sh`: build image, shard websites, start containers.
- `rerun_failures.sh`: detect failed/missing sites and rerun them.
- `db_to_json.js`: export SQLite to JSON and combine logs.
- `utils/helpers.js`: SQLite helpers and retry-on-lock logic.
- `Dockerfile`: runtime image (Chrome + Node + VNC).

## Requirements

- Docker
- Bash
- Python 3 (used inside shell scripts)
- A CSV file named `leaky-sites.csv` in the repository root with a `page` column

## Quick start

```bash
./run_parallel_crawlers.sh start
```

Useful commands:

```bash
./run_parallel_crawlers.sh status
./run_parallel_crawlers.sh logs
./run_parallel_crawlers.sh stop
./run_parallel_crawlers.sh cleanup
```

Default parallelism is `TOTAL_CONTAINERS=20` (edit the variable in `run_parallel_crawlers.sh` if needed).

## Output layout

- `output/<MM-DD-YYYY>/DB/*.db`: one SQLite DB per site.
- `output/<MM-DD-YYYY>/logs/*.log`: per-container failure logs.

SQLite tables created by the crawler:

- `requests`
- `responses`

## Retry failed runs

```bash
./rerun_failures.sh
```

The script checks the latest `output/<date>/` directory, reads failure logs, compares against completed DB files, and starts new containers for websites that still need processing.

## Export DB to JSON

```bash
node db_to_json.js <MM-DD-YYYY>
```

Current script paths are hardcoded:

- Source base: `/home/XXXX-4/crawler/output`
- Destination base: `/mnt/web-secrets/XXXX-4/output`

If your environment is different, update these paths in `db_to_json.js`.

## Notes

- `crawler.js` expects websites via `--websites`; it does not read CSV directly.
- The Docker scripts pass `--websites` to each container.
- Chrome runs in headed mode inside Xvfb/VNC.

## Citing this work

If you use this crawler or build on our findings, feel free to [cite our work](https://arxiv.org/abs/2603.12498):

```bibtex
@inproceedings{demir2026keys,
	author    = {Demir, Nurullah and Vekaria, Yash and Smaragdakis, Georgios and Durumeric, Zakir},
	title     = {Keys on Doormats: Exposed API Credentials on the Web},
	booktitle = {ACM SIGSAC Conference on Computer and Communications Security},
	year      = {2026},
	doi       = {10.1145/3830454.3846651}
}
```
